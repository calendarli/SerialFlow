import { BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'node:path'
import {
  validMeasurement,
  validMeasurementCommand,
  type PlotMeasurement
} from '@common/plot-measurement'

export function registerPlotMeasurementWindow(getMain: () => BrowserWindow | null): void {
  let window: BrowserWindow | null = null
  let snapshot: PlotMeasurement | null = null
  const close = (): void => {
    const current = window
    window = null
    snapshot = null
    current?.destroy()
  }
  ipcMain.handle('plotMeasurement:sync', async (event, value: unknown) => {
    const main = getMain()
    if (!main || event.sender !== main.webContents) throw new Error('请从主窗口更新测量')
    if (value === null) {
      close()
      return
    }
    if (!validMeasurement(value)) throw new Error('无效的测量数据')
    snapshot = value
    if (window) {
      window.webContents.send('plotMeasurement:state', snapshot)
      return
    }
    const current = new BrowserWindow({
      width: 1000,
      height: 400,
      minWidth: 680,
      minHeight: 260,
      title: '区间测量 · SerialFlow',
      frame: true,
      alwaysOnTop: false,
      show: false,
      autoHideMenuBar: true,
      webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true }
    })
    window = current
    main.once('closed', close)
    current.on('closed', () => {
      main.removeListener('closed', close)
      if (window !== current) return
      window = null
      snapshot = null
      if (!main.isDestroyed()) main.webContents.send('plotMeasurement:command', { type: 'end' })
    })
    current.once('ready-to-show', () => current.show())
    current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    try {
      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        const url = new URL(process.env['ELECTRON_RENDERER_URL'])
        url.searchParams.set('plotMeasurement', 'true')
        await current.loadURL(url.toString())
      } else
        await current.loadFile(join(__dirname, '../renderer/index.html'), {
          query: { plotMeasurement: 'true' }
        })
    } catch (error) {
      if (window !== current) return
      close()
      throw error
    }
  })
  ipcMain.handle('plotMeasurement:get', (event) => {
    if (event.sender !== window?.webContents) throw new Error('测量窗口不可用')
    return snapshot
  })
  ipcMain.handle('plotMeasurement:command', (event, command: unknown) => {
    if (event.sender !== window?.webContents || !validMeasurementCommand(command))
      throw new Error('无效的测量操作')
    if (command.type === 'move' && (!snapshot || command.index > snapshot.total))
      throw new Error('采样点超出范围')
    getMain()?.webContents.send('plotMeasurement:command', command)
  })
}
