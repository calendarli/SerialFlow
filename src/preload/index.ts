import { contextBridge, ipcRenderer } from 'electron'
import type { PlotMeasurement, PlotMeasurementCommand } from '@common/plot-measurement'
import type { FirmwareFamily, FirmwareRequest, FirmwareState } from '@common/firmware'
import type { UpdateState } from '@common/update'
import type { SerialPortInfo } from '@common/serial-port'

// Sandboxed preload scripts can only load Electron's built-in modules.
// Keep the renderer-facing compatibility surface deliberately small.
const electron = {
  process: {
    versions: {
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? ''
    }
  }
}

const api = {
  syncPlotMeasurement: (value: PlotMeasurement | null): Promise<void> =>
    ipcRenderer.invoke('plotMeasurement:sync', value),
  getPlotMeasurement: (): Promise<PlotMeasurement | null> =>
    ipcRenderer.invoke('plotMeasurement:get'),
  commandPlotMeasurement: (command: PlotMeasurementCommand): Promise<void> =>
    ipcRenderer.invoke('plotMeasurement:command', command),
  onPlotMeasurement: (callback: (value: PlotMeasurement) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: PlotMeasurement): void =>
      callback(value)
    ipcRenderer.on('plotMeasurement:state', listener)
    return () => ipcRenderer.removeListener('plotMeasurement:state', listener)
  },
  onPlotMeasurementCommand: (callback: (command: PlotMeasurementCommand) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: PlotMeasurementCommand): void =>
      callback(command)
    ipcRenderer.on('plotMeasurement:command', listener)
    return () => ipcRenderer.removeListener('plotMeasurement:command', listener)
  },
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke('update:getState'),
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke('update:check'),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke('update:download'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  onUpdateState: (callback: (state: UpdateState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: UpdateState): void =>
      callback(state)
    ipcRenderer.on('update:state', listener)
    return () => ipcRenderer.removeListener('update:state', listener)
  },
  getFirmwareState: () => ipcRenderer.invoke('firmware:state'),
  getFirmwareTool: (family: FirmwareFamily, path: string) =>
    ipcRenderer.invoke('firmware:tool', family, path),
  listFirmwareProbes: (path: string) => ipcRenderer.invoke('firmware:probes', path),
  chooseFirmwareTool: (family: FirmwareFamily) => ipcRenderer.invoke('firmware:chooseTool', family),
  chooseFirmwareFiles: (family: FirmwareFamily, transport: FirmwareRequest['transport']) =>
    ipcRenderer.invoke('firmware:chooseFiles', family, transport),
  startFirmware: (request: FirmwareRequest, operation: 'detect' | 'flash') =>
    ipcRenderer.invoke('firmware:start', request, operation),
  cancelFirmware: (id: string) => ipcRenderer.invoke('firmware:cancel', id),
  saveFirmwareLog: () => ipcRenderer.invoke('firmware:saveLog'),
  onFirmwareProgress: (callback: (state: FirmwareState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: FirmwareState): void =>
      callback(state)
    ipcRenderer.on('firmware:progress', listener)
    return () => ipcRenderer.removeListener('firmware:progress', listener)
  },
  openDataWindow: (id: string): Promise<void> => ipcRenderer.invoke('dataWindow:open', id),
  closeDataWindow: (id: string): Promise<void> => ipcRenderer.invoke('dataWindow:close', id),
  publishDataWindowPlot: (value: {
    id: string
    name: string
    values: Record<string, number>
    timestamp: number
  }): Promise<void> => ipcRenderer.invoke('dataWindow:plot', value),
  onDataWindowPlot: (
    callback: (value: {
      id: string
      name: string
      values: Record<string, number>
      timestamp: number
    }) => void
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      value: { id: string; name: string; values: Record<string, number>; timestamp: number }
    ): void => callback(value)
    ipcRenderer.on('dataWindow:plot', listener)
    return () => ipcRenderer.removeListener('dataWindow:plot', listener)
  },
  getOpenedPortPaths: (): Promise<string[]> => ipcRenderer.invoke('serial:openedPaths'),
  getAlwaysOnTop: (): Promise<boolean> => ipcRenderer.invoke('window:getAlwaysOnTop'),
  setAlwaysOnTop: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('window:setAlwaysOnTop', enabled),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  saveProject: (project: unknown) => ipcRenderer.invoke('project:save', project),
  openProject: () => ipcRenderer.invoke('project:open'),
  saveConfig: (kind: 'quick-commands' | 'auto-replies', config: unknown) =>
    ipcRenderer.invoke('config:save', kind, config),
  openConfig: (kind: 'quick-commands' | 'auto-replies') => ipcRenderer.invoke('config:open', kind),
  openModbusMap: () => ipcRenderer.invoke('modbus:openMap'),
  saveModbusMap: (config: unknown) => ipcRenderer.invoke('modbus:saveMap', config),
  listPorts: () => ipcRenderer.invoke('serial:list'),
  onPortsChanged: (callback: (ports: SerialPortInfo[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, ports: SerialPortInfo[]): void =>
      callback(ports)
    ipcRenderer.on('serial:portsChanged', listener)
    return () => ipcRenderer.removeListener('serial:portsChanged', listener)
  },
  getVirtualPortStatus: () => ipcRenderer.invoke('virtualPorts:status'),
  createVirtualPortPair: (first: string, second: string) =>
    ipcRenderer.invoke('virtualPorts:create', first, second),
  removeVirtualPortPair: (first: string, second: string) =>
    ipcRenderer.invoke('virtualPorts:remove', first, second),
  openVirtualPortManager: () => ipcRenderer.invoke('virtualPorts:openManager'),
  installVirtualPortCertificate: () => ipcRenderer.invoke('virtualPorts:installCertificate'),
  openVirtualPortDownload: () => ipcRenderer.invoke('virtualPorts:openDownload'),
  selectTransferFile: () => ipcRenderer.invoke('fileTransfer:selectFile'),
  selectTransferDirectory: () => ipcRenderer.invoke('fileTransfer:selectDirectory'),
  setFileReceiver: (port: string, directory?: string) =>
    ipcRenderer.invoke('fileTransfer:setReceiver', port, directory),
  startFileTransfer: (
    port: string,
    filePath: string,
    chunkSize: number,
    protocol: 'serialflow' | 'raw',
    chunkDelay?: number
  ) => ipcRenderer.invoke('fileTransfer:send', port, filePath, chunkSize, protocol, chunkDelay),
  cancelFileTransfer: (taskId: string) => ipcRenderer.invoke('fileTransfer:cancel', taskId),
  openPort: (options: unknown) => ipcRenderer.invoke('serial:open', options),
  closePort: (path: string) => ipcRenderer.invoke('serial:close', path),
  write: (path: string, base64: string) => ipcRenderer.invoke('serial:write', path, base64),
  onData: (callback: (data: { path: string; chunks: Uint8Array[] }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { path: string; chunks: Uint8Array[] }
    ): void => callback(data)
    ipcRenderer.on('serial:data', listener)
    return () => ipcRenderer.removeListener('serial:data', listener)
  },
  onStatus: (callback: (status: { open: boolean; path: string }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      status: { open: boolean; path: string }
    ): void => callback(status)
    ipcRenderer.on('serial:status', listener)
    return () => ipcRenderer.removeListener('serial:status', listener)
  },
  onError: (callback: (error: { path: string; message: string }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      error: { path: string; message: string }
    ): void => callback(error)
    ipcRenderer.on('serial:error', listener)
    return () => ipcRenderer.removeListener('serial:error', listener)
  },
  onFileTransferProgress: (callback: (progress: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: unknown): void =>
      callback(progress)
    ipcRenderer.on('fileTransfer:progress', listener)
    return () => ipcRenderer.removeListener('fileTransfer:progress', listener)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electron)
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-ignore injected global
  window.electron = electron
  // @ts-ignore injected global
  window.api = api
}
