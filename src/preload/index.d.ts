import type { SerialPortInfo } from '@common/serial-port'
import type { PlotMeasurement, PlotMeasurementCommand } from '@common/plot-measurement'
import type { UpdateState } from '@common/update'
import type {
  FirmwareFamily,
  FirmwareFile,
  FirmwareListenState,
  FirmwareRequest,
  FirmwareState,
  FirmwareTool
} from '@common/firmware'

type SerialOptions = {
  path: string
  baudRate: number
  dataBits: 5 | 6 | 7 | 8
  stopBits: 1 | 1.5 | 2
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space'
}
type FileTransferProgress = {
  taskId: string
  direction: 'send' | 'receive'
  port: string
  fileName: string
  filePath?: string
  totalBytes: number
  transferredBytes: number
  state:
    'preparing' | 'waiting' | 'transferring' | 'verifying' | 'completed' | 'error' | 'cancelled'
  message: string
  retries: number
  startedAt: number
  bytesPerSecond: number
  protocol: 'serialflow' | 'raw'
}

declare global {
  interface Window {
    electron: {
      process: {
        versions: {
          electron: string
          chrome: string
          node: string
        }
      }
    }
    api: {
      syncPlotMeasurement(value: PlotMeasurement | null): Promise<void>
      getPlotMeasurement(): Promise<PlotMeasurement | null>
      commandPlotMeasurement(command: PlotMeasurementCommand): Promise<void>
      onPlotMeasurement(callback: (value: PlotMeasurement) => void): () => void
      onPlotMeasurementCommand(callback: (command: PlotMeasurementCommand) => void): () => void
      getUpdateState(): Promise<UpdateState>
      checkForUpdates(): Promise<void>
      downloadUpdate(): Promise<void>
      installUpdate(): Promise<void>
      onUpdateState(callback: (state: UpdateState) => void): () => void
      getFirmwareState(): Promise<FirmwareState | null>
      getFirmwareListenState(): Promise<FirmwareListenState | null>
      startFirmwareListen(request: FirmwareRequest): Promise<void>
      stopFirmwareListen(): Promise<void>
      onFirmwareListen(callback: (state: FirmwareListenState | null) => void): () => void
      getFirmwareTool(family: FirmwareFamily, path: string): Promise<FirmwareTool>
      listFirmwareProbes(path: string): Promise<string[]>
      chooseFirmwareTool(family: FirmwareFamily): Promise<string | null>
      chooseFirmwareFiles(
        family: FirmwareFamily,
        transport: FirmwareRequest['transport']
      ): Promise<FirmwareFile[]>
      startFirmware(request: FirmwareRequest, operation: 'detect' | 'flash'): Promise<string | null>
      cancelFirmware(id: string): Promise<void>
      saveFirmwareLog(): Promise<string | null>
      onFirmwareProgress(callback: (state: FirmwareState) => void): () => void
      openDataWindow(id: string): Promise<void>
      closeDataWindow(id: string): Promise<void>
      publishDataWindowPlot(value: {
        id: string
        name: string
        values: Record<string, number>
        timestamp: number
      }): Promise<void>
      onDataWindowPlot(
        callback: (value: {
          id: string
          name: string
          values: Record<string, number>
          timestamp: number
        }) => void
      ): () => void
      getOpenedPortPaths(): Promise<string[]>
      getAlwaysOnTop(): Promise<boolean>
      setAlwaysOnTop(enabled: boolean): Promise<boolean>
      getAppInfo(): Promise<{ version: string; platform: string; arch: string }>
      saveProject(project: unknown): Promise<string | null>
      openProject(): Promise<{ path: string; content: string } | null>
      saveConfig(kind: 'quick-commands' | 'auto-replies', config: unknown): Promise<string | null>
      openConfig(
        kind: 'quick-commands' | 'auto-replies'
      ): Promise<{ path: string; content: string } | null>
      openModbusMap(): Promise<{ path: string; name: string; base64: string } | null>
      saveModbusMap(config: unknown): Promise<string | null>
      listPorts(): Promise<SerialPortInfo[]>
      onPortsChanged(callback: (ports: SerialPortInfo[]) => void): () => void
      getVirtualPortStatus(): Promise<{
        installed: boolean
        pairs: string[]
        occupiedPorts: string[]
        availablePorts: string[]
        commandPath?: string
        certificateAvailable: boolean
        certificateInstalled: boolean
        message?: string
      }>
      createVirtualPortPair(
        first: string,
        second: string
      ): Promise<{ first: string; second: string; output: string }>
      removeVirtualPortPair(first: string, second: string): Promise<string>
      openVirtualPortManager(): Promise<void>
      installVirtualPortCertificate(): Promise<string>
      openVirtualPortDownload(): Promise<void>
      selectTransferFile(): Promise<{ path: string; name: string; size: number } | null>
      selectTransferDirectory(): Promise<string | null>
      setFileReceiver(port: string, directory?: string): Promise<void>
      startFileTransfer(
        port: string,
        filePath: string,
        chunkSize: number,
        protocol: 'serialflow' | 'raw',
        chunkDelay?: number
      ): Promise<string>
      cancelFileTransfer(taskId: string): Promise<void>
      openPort(options: SerialOptions): Promise<boolean>
      closePort(path: string): Promise<void>
      write(path: string, base64: string): Promise<number>
      onData(callback: (data: { path: string; chunks: Uint8Array[] }) => void): () => void
      onStatus(callback: (status: { open: boolean; path: string }) => void): () => void
      onError(callback: (error: { path: string; message: string }) => void): () => void
      onFileTransferProgress(callback: (progress: FileTransferProgress) => void): () => void
    }
  }
}

export {}
