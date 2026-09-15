import { writeSerialData } from './serial-write'
import { registerPlotMeasurementWindow } from './plot-measurement-window'
import { app, shell, BrowserWindow, dialog, ipcMain } from 'electron'
import { execFile } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { readFile, stat, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { SerialPort } from 'serialport'
import icon from '../../resources/icon-v3.png?asset'
import { FileTransferManager } from './file-transfer'
import { FirmwareManager } from './firmware/manager'
import type { FirmwareFamily, FirmwareRequest } from '@common/firmware'
import { autoUpdater } from 'electron-updater'
import { UpdateManager } from './update-manager'
import { SerialPortMonitor } from './serial-port-monitor'
import { createSerialPortLister } from './serial-port-list'
import { decodeConfigText } from '../common/config-text'

const serialPortMonitor = new SerialPortMonitor(
  createSerialPortLister(() => SerialPort.list()),
  (ports) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send('serial:portsChanged', ports)
    }
  }
)

// Retain existing settings when upgrading installations created under the old package name.
app.setName('SerialFlow')
const serialFlowUserData = join(app.getPath('appData'), 'SerialFlow')
const legacyUserData = join(app.getPath('appData'), 'serialportdebug')
const userDataPath =
  !existsSync(serialFlowUserData) && existsSync(legacyUserData)
    ? legacyUserData
    : serialFlowUserData
mkdirSync(userDataPath, { recursive: true })
app.setPath('userData', userDataPath)

type PortOptions = {
  path: string
  baudRate: number
  dataBits: 5 | 6 | 7 | 8
  stopBits: 1 | 1.5 | 2
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space'
}

function validatePortOptions(options: PortOptions): void {
  if (!options || typeof options !== 'object') throw new Error('串口配置无效，请重新选择参数')
  if (!options.path?.trim()) throw new Error('串口名称不能为空')
  if (!Number.isInteger(options.baudRate) || options.baudRate <= 0)
    throw new Error('波特率必须是正整数')
  if (![5, 6, 7, 8].includes(options.dataBits)) throw new Error('数据位只能选择 5、6、7 或 8')
  if (![1, 1.5, 2].includes(options.stopBits)) throw new Error('停止位只能选择 1、1.5 或 2')
  if (!['none', 'even', 'odd', 'mark', 'space'].includes(options.parity))
    throw new Error('校验位参数无效')
  if (options.stopBits === 1.5 && options.dataBits !== 5) {
    throw new Error('Windows 仅允许 5 数据位搭配 1.5 停止位，请改为 1 停止位')
  }
  if (options.stopBits === 2 && options.dataBits === 5) {
    throw new Error('Windows 的 5 数据位不能搭配 2 停止位，请使用 1.5 停止位')
  }
}

function explainOpenError(error: unknown, options: PortOptions): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (/SetCommState|parameter is incorrect|参数错误/i.test(message)) {
    return new Error(
      `驱动拒绝串口参数：${options.path}，${options.baudRate} baud，${options.dataBits}${options.parity === 'none' ? 'N' : options.parity[0].toUpperCase()}${options.stopBits}。` +
        '请先尝试 115200/8/N/1；若可打开，说明当前 USB 转串口芯片或驱动不支持所选波特率。'
    )
  }
  if (/access denied|permission denied|resource busy|busy/i.test(message)) {
    return new Error(
      `无法打开 ${options.path}：端口正被其他程序占用。请关闭其他串口工具、烧录软件或旧的应用进程后重试`
    )
  }
  if (/file not found|cannot find|no such file|not found/i.test(message)) {
    return new Error(`找不到串口 ${options.path}：设备可能已拔出或端口号已变化，请刷新端口列表`)
  }
  if (/not functioning|i\/o error|input\/output|device.*error/i.test(message)) {
    return new Error(`无法使用 ${options.path}：设备或驱动工作异常，请重新插拔设备并检查驱动`)
  }
  return new Error(`打开 ${options.path} 失败：${message.replace(/^Error:\s*/i, '')}`)
}

function explainRuntimeError(
  error: unknown,
  action: '读取端口列表' | '关闭串口' | '发送数据' | '串口通信',
  path?: string
): Error {
  const message = (error instanceof Error ? error.message : String(error)).replace(
    /^Error:\s*/i,
    ''
  )
  if (/port is not open|not open|串口未打开/i.test(message))
    return new Error('串口未打开或已经断开，请重新打开串口')
  if (/access denied|permission denied|resource busy|busy/i.test(message))
    return new Error(`${action}失败：串口被其他程序占用或当前账户没有访问权限`)
  if (/file not found|cannot find|no such file|not found/i.test(message))
    return new Error(`${path ? `串口 ${path}` : '串口设备'} 不存在，请刷新端口列表并检查设备连接`)
  if (/disconnected|device.*removed|not functioning|i\/o error|input\/output/i.test(message))
    return new Error(`${path ? `串口 ${path}` : '串口设备'} 已断开或驱动异常，请重新插拔设备`)
  if (/timeout|timed out/i.test(message))
    return new Error(`${action}超时，请检查设备连接、波特率和流控状态`)
  return new Error(`${action}失败：${message}`)
}

const openPorts = new Map<string, SerialPort>()
const virtualSerialPorts = new WeakSet<SerialPort>()
let mainWindow: BrowserWindow | null = null
const dataWindows = new Map<string, BrowserWindow>()
const writeQueues = new Map<string, Promise<void>>()
const receiveBatches = new Map<
  string,
  { chunks: Uint8Array[]; bytes: number; timer?: NodeJS.Timeout }
>()
let portOperationQueue: Promise<void> = Promise.resolve()
let fileTransferManager: FileTransferManager | null = null
let firmwareManager: FirmwareManager | null = null
const firmwarePorts = new Set<string>()
let quitting = false
let quitReady = false

function assertPortAvailable(path: string): void {
  if (quitting) throw new Error('程序正在关闭，请等待当前操作完成')
  if (firmwarePorts.has(path.toUpperCase()))
    throw new Error(`串口 ${path} 正被固件烧录独占，请等待任务结束`)
}

function virtualSerialRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'virtual-serial')
    : join(app.getAppPath(), 'resources', 'virtual-serial', `win-${process.arch}`)
}

function virtualSerialPaths(): { manager: string; inf: string } {
  const root = virtualSerialRoot()
  return {
    manager: join(root, 'SerialFlowVirtualSerialManager.exe'),
    inf: join(root, 'virtualserial2um.inf')
  }
}

function virtualSerialCertificatePath(): string {
  return join(virtualSerialRoot(), 'SerialFlowVirtualSerial.cer')
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 30000 },
      (error, stdout, stderr) => {
        if (!error) return resolve(String(stdout).trim())
        reject(new Error(String(stderr || stdout || error.message).trim()))
      }
    )
  )
}

async function isVirtualSerialCertificateInstalled(certificatePath: string): Promise<boolean> {
  if (!existsSync(certificatePath)) return false
  const script = `$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(${quotePowerShell(certificatePath)}); $root = Test-Path ('Cert:\\LocalMachine\\Root\\' + $certificate.Thumbprint); $publisher = Test-Path ('Cert:\\LocalMachine\\TrustedPublisher\\' + $certificate.Thumbprint); Write-Output ($root -and $publisher)`
  return (await runPowerShell(script)).trim().toLowerCase() === 'true'
}

function installVirtualSerialCertificate(certificatePath: string): Promise<string> {
  const innerScript = `$ErrorActionPreference = 'Stop'; Import-Certificate -FilePath ${quotePowerShell(certificatePath)} -CertStoreLocation 'Cert:\\LocalMachine\\Root' | Out-Null; Import-Certificate -FilePath ${quotePowerShell(certificatePath)} -CertStoreLocation 'Cert:\\LocalMachine\\TrustedPublisher' | Out-Null`
  const encoded = Buffer.from(innerScript, 'utf16le').toString('base64')
  const outerScript = `$process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -Verb RunAs -WindowStyle Hidden -Wait -PassThru; Write-Output $process.ExitCode`
  return runPowerShell(outerScript).then((output) => {
    if (Number(output) !== 0) throw new Error(`证书安装失败，安装程序退出码：${output}`)
    return 'SerialFlow 测试签名证书已安装'
  })
}

async function getVirtualPortAvailability(): Promise<{
  occupiedPorts: string[]
  availablePorts: string[]
}> {
  const occupiedPorts = (await SerialPort.list())
    .map((item) => item.path.trim().toUpperCase())
    .filter((path) => /^COM(?:[1-9]|[1-9]\d|[1-9]\d{2})$/.test(path))
    .filter((path, index, ports) => ports.indexOf(path) === index)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const occupied = new Set(occupiedPorts)
  const availablePorts = Array.from({ length: 999 }, (_, index) => `COM${index + 1}`).filter(
    (path) => !occupied.has(path)
  )
  return { occupiedPorts, availablePorts }
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function runTool(path: string, args: string[]): Promise<string> {
  const argumentList = args.map(quotePowerShell).join(',')
  const command = `$process = Start-Process -FilePath ${quotePowerShell(path)} -ArgumentList @(${argumentList}) -Verb RunAs -WindowStyle Hidden -Wait -PassThru; Write-Output $process.ExitCode`
  return new Promise((resolve, reject) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 120000 },
      (error, stdout, stderr) => {
        const exitCode = Number(String(stdout).trim())
        if (!error && (exitCode === 0 || exitCode === 1)) {
          resolve(exitCode === 1 ? '操作完成，需要重启系统后完全生效' : '操作成功')
          return
        }
        if (error) {
          const detail = String(stderr || stdout || error.message).trim()
          reject(
            new Error(
              /cancel|canceled|取消|1223/i.test(detail)
                ? '已取消管理员授权，未更改虚拟串口配置'
                : `SerialFlow 虚拟串口操作失败：${detail}`
            )
          )
          return
        }
        reject(new Error(`SerialFlow 虚拟串口操作失败，管理程序退出码：${exitCode}`))
      }
    )
  )
}

function enqueuePortOperation<T>(operation: () => Promise<T>): Promise<T> {
  const task = portOperationQueue.catch(() => undefined).then(operation)
  portOperationQueue = task.then(
    () => undefined,
    () => undefined
  )
  return task
}

function emit(channel: string, value: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value)
  if (channel === 'serial:data' || channel === 'serial:status') {
    for (const window of dataWindows.values()) {
      if (!window.isDestroyed()) window.webContents.send(channel, value)
    }
  }
}

function flushReceiveBatch(path: string): void {
  const batch = receiveBatches.get(path)
  if (!batch) return
  if (batch.timer) clearTimeout(batch.timer)
  receiveBatches.delete(path)
  if (batch.chunks.length) emit('serial:data', { path, chunks: batch.chunks })
}

function queueReceivedData(path: string, chunk: Buffer): void {
  if (fileTransferManager?.handleIncoming(path, chunk)) return
  const batch = receiveBatches.get(path) || { chunks: [], bytes: 0 }
  batch.chunks.push(new Uint8Array(chunk))
  batch.bytes += chunk.length
  receiveBatches.set(path, batch)
  if (batch.bytes >= 64 * 1024) flushReceiveBatch(path)
  else if (!batch.timer) batch.timer = setTimeout(() => flushReceiveBatch(path), 4)
}

async function closePort(path: string): Promise<void> {
  const active = openPorts.get(path)
  openPorts.delete(path)
  writeQueues.delete(path)
  flushReceiveBatch(path)
  if (active?.isOpen) {
    try {
      await new Promise<void>((resolve, reject) =>
        active.close((error) => (error ? reject(error) : resolve()))
      )
    } catch (error) {
      if (active.isOpen) openPorts.set(path, active)
      throw explainRuntimeError(error, '关闭串口', active.path)
    }
  }
  emit('serial:status', { path, open: false })
}

async function closeAllPorts(): Promise<void> {
  await Promise.allSettled([...openPorts.keys()].map(closePort))
}

async function writeRawPort(path: string, data: Buffer): Promise<void> {
  assertPortAvailable(path)
  const active = openPorts.get(path)
  if (!active?.isOpen) throw new Error(`串口 ${path} 未打开`)
  await new Promise<void>((resolve, reject) =>
    active.write(data, (error) => (error ? reject(error) : resolve()))
  )
}

async function openManagedPort(options: PortOptions): Promise<boolean> {
  validatePortOptions(options)
  assertPortAvailable(options.path)
  await closePort(options.path)
  const listedPort = (await SerialPort.list().catch(() => [])).find(
    (port) => port.path === options.path
  )
  let next: SerialPort
  try {
    next = new SerialPort({ ...options, autoOpen: false })
    await new Promise<void>((resolve, reject) =>
      next.open((error) => (error ? reject(error) : resolve()))
    )
  } catch (error) {
    throw explainOpenError(error, options)
  }
  if (listedPort?.manufacturer === 'SerialFlow') virtualSerialPorts.add(next)
  openPorts.set(options.path, next)
  next.on('data', (chunk: Buffer) => {
    queueReceivedData(options.path, chunk)
  })
  next.on('error', (error) =>
    emit('serial:error', {
      path: options.path,
      message: explainRuntimeError(error, '串口通信', next.path).message
    })
  )
  next.on('close', () => {
    const unexpected = openPorts.get(options.path) === next
    if (unexpected) {
      openPorts.delete(options.path)
      writeQueues.delete(options.path)
      emit('serial:error', {
        path: options.path,
        message: `串口 ${next.path} 连接意外中断，请检查 USB 连接、供电和驱动状态`
      })
    }
    emit('serial:status', { path: options.path, open: false })
  })
  emit('serial:status', { open: true, path: options.path })
  return true
}

function registerSerialHandlers(): void {
  registerPlotMeasurementWindow(() => mainWindow)
  firmwareManager = new FirmwareManager({
    resources: app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'),
    temp: app.getPath('temp'),
    emit: (state) => emit('firmware:progress', state),
    acquire: (request) =>
      enqueuePortOperation(async () => {
        if (request.transport !== 'uart') return async () => {}
        const path = request.port
        assertPortAvailable(path)
        if (fileTransferManager?.isPortBusy(path))
          throw new Error('目标串口正在传输或接收文件，请先停止文件传输')
        firmwarePorts.add(path.toUpperCase())
        const port = openPorts.get(path)
        const saved: PortOptions | undefined = port
          ? {
              path,
              baudRate: port.baudRate,
              dataBits: port.settings.dataBits ?? 8,
              stopBits: port.settings.stopBits ?? 1,
              parity: port.settings.parity ?? 'none'
            }
          : undefined
        try {
          await closePort(path)
        } catch (error) {
          firmwarePorts.delete(path.toUpperCase())
          throw error
        }
        return () =>
          enqueuePortOperation(async () => {
            firmwarePorts.delete(path.toUpperCase())
            if (saved && request.restorePort && !quitting) await openManagedPort(saved)
          })
      })
  })
  ipcMain.handle('firmware:state', () => firmwareManager!.snapshot())
  ipcMain.handle('firmware:tool', (_event, family: FirmwareFamily, path: string) =>
    firmwareManager!.toolInfo(family, path)
  )
  ipcMain.handle('firmware:probes', (_event, path: string) => firmwareManager!.probes(path))
  ipcMain.handle('firmware:chooseTool', async (_event, family: FirmwareFamily) => {
    if (!['stm32', 'esp32'].includes(family)) throw new Error('无效芯片系列')
    const result = await dialog.showOpenDialog({
      title: family === 'stm32' ? '选择 STM32_Programmer_CLI' : '选择 esptool 5.x',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: '烧录工具', extensions: ['exe'] }] : []
    })
    return result.canceled ? null : firmwareManager!.resolveTool(family, result.filePaths[0])
  })
  ipcMain.handle('firmware:chooseFiles', async (_event, family: FirmwareFamily) => {
    if (!['stm32', 'esp32'].includes(family)) throw new Error('无效芯片系列')
    const result = await dialog.showOpenDialog({
      title: '选择烧录固件',
      properties: family === 'esp32' ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: '固件', extensions: family === 'stm32' ? ['hex', 'bin'] : ['bin'] }]
    })
    if (result.canceled) return []
    return Promise.all(
      result.filePaths.map(async (path) => ({
        path,
        name: basename(path),
        size: (await stat(path)).size,
        address: family === 'stm32' ? '0x08000000' : ''
      }))
    )
  })
  ipcMain.handle(
    'firmware:start',
    async (_event, request: FirmwareRequest, operation: 'detect' | 'flash') => {
      if (operation === 'flash' && request?.eraseAll) {
        const result = await dialog.showMessageBox({
          type: 'warning',
          title: '确认整片擦除',
          message: '整片擦除将删除目标芯片上的固件和保存的数据。',
          detail: `目标：${request.family} / ${request.transport === 'swd' ? request.probe : request.port}。此操作无法撤销。`,
          buttons: ['取消', '整片擦除并烧录'],
          defaultId: 0,
          cancelId: 0
        })
        if (result.response !== 1) return null
      }
      return firmwareManager!.start(request, operation)
    }
  )
  ipcMain.handle('firmware:cancel', (_event, id: string) => firmwareManager!.cancel(id))
  ipcMain.handle('firmware:saveLog', async () => {
    const state = firmwareManager!.snapshot()
    if (!state) throw new Error('暂无烧录日志')
    const result = await dialog.showSaveDialog({
      defaultPath: `firmware-${state.id}.txt`,
      filters: [{ name: '日志', extensions: ['txt'] }]
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(
      result.filePath,
      `${state.phase}\n${new Date(state.startedAt).toISOString()}\n${state.logs.join('\n')}\n`,
      'utf8'
    )
    return result.filePath
  })
  fileTransferManager = new FileTransferManager(writeRawPort, (progress) =>
    emit('fileTransfer:progress', progress)
  )
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch
  }))
  ipcMain.handle('dataWindow:open', async (event, id: unknown) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('请从主窗口打开数据窗口')
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id))
      throw new Error('无效的数据窗口编号')
    const existing = dataWindows.get(id)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return
    }
    const window = new BrowserWindow({
      width: 520,
      height: 580,
      minWidth: 360,
      minHeight: 260,
      title: 'SerialFlow 数据窗口',
      icon,
      alwaysOnTop: true,
      show: false,
      autoHideMenuBar: true,
      webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true }
    })
    dataWindows.set(id, window)
    window.on('closed', () => dataWindows.delete(id))
    window.once('ready-to-show', () => window.show())
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    try {
      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        const url = new URL(process.env['ELECTRON_RENDERER_URL'])
        url.searchParams.set('dataWindow', id)
        await window.loadURL(url.toString())
      } else
        await window.loadFile(join(__dirname, '../renderer/index.html'), {
          query: { dataWindow: id }
        })
    } catch (error) {
      if (!window.isDestroyed()) window.destroy()
      throw error
    }
  })
  ipcMain.handle('dataWindow:close', (event, id: unknown) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('请从主窗口管理数据窗口')
    if (typeof id === 'string') dataWindows.get(id)?.close()
  })
  ipcMain.handle('serial:openedPaths', () => [...openPorts.keys()])
  ipcMain.handle('window:getAlwaysOnTop', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.isDestroyed()) throw new Error('窗口不可用')
    return window.isAlwaysOnTop()
  })
  ipcMain.handle('window:setAlwaysOnTop', (event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('无效的置顶状态')
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.isDestroyed()) throw new Error('窗口不可用')
    window.setAlwaysOnTop(enabled)
    return window.isAlwaysOnTop()
  })
  ipcMain.handle('serial:list', async () => {
    try {
      return await serialPortMonitor.refresh()
    } catch (error) {
      throw explainRuntimeError(error, '读取端口列表')
    }
  })
  ipcMain.handle('virtualPorts:status', async () => {
    const paths = virtualSerialPaths()
    const certificatePath = virtualSerialCertificatePath()
    const endpoints = (await SerialPort.list())
      .filter((item) => item.manufacturer === 'SerialFlow')
      .map((item) => item.path)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    const { occupiedPorts, availablePorts } = await getVirtualPortAvailability()
    const pairs: string[] = []
    for (let index = 0; index < endpoints.length; index += 2)
      pairs.push(`${endpoints[index]} ↔ ${endpoints[index + 1] || '等待对端'}`)
    return {
      installed: endpoints.length > 0 || (existsSync(paths.manager) && existsSync(paths.inf)),
      pairs,
      occupiedPorts,
      availablePorts,
      commandPath: paths.manager,
      certificateAvailable: existsSync(certificatePath),
      certificateInstalled: await isVirtualSerialCertificateInstalled(certificatePath),
      message: endpoints.length ? `SerialFlow 驱动已启动，共 ${endpoints.length} 个端点` : undefined
    }
  })
  ipcMain.handle('virtualPorts:installCertificate', async () => {
    const certificatePath = virtualSerialCertificatePath()
    if (!existsSync(certificatePath)) throw new Error('未找到 SerialFlow 测试签名证书')
    try {
      return await installVirtualSerialCertificate(certificatePath)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        /cancel|canceled|取消|1223/i.test(detail)
          ? '已取消管理员授权，证书未安装'
          : `安装 SerialFlow 测试签名证书失败：${detail}`
      )
    }
  })
  ipcMain.handle('virtualPorts:create', async (_event, first: string, second: string) => {
    const paths = virtualSerialPaths()
    if (!existsSync(paths.manager) || !existsSync(paths.inf))
      throw new Error('SerialFlow 虚拟串口驱动包不完整')
    const portA = first.trim().toUpperCase()
    const portB = second.trim().toUpperCase()
    if (
      !/^COM(?:[1-9]|[1-9]\d|[1-9]\d{2})$/.test(portA) ||
      !/^COM(?:[1-9]|[1-9]\d|[1-9]\d{2})$/.test(portB)
    )
      throw new Error('端口名称必须是 COM1–COM999')
    if (portA === portB) throw new Error('串口对的两个端口不能相同')
    const { occupiedPorts } = await getVirtualPortAvailability()
    const before = new Set(occupiedPorts)
    if (before.has(portA) || before.has(portB)) throw new Error('所选 COM 端口已被系统占用')
    const output = await runTool(paths.manager, ['create-pair', paths.inf, portA, portB])
    const created = (await SerialPort.list())
      .filter((item) => item.manufacturer === 'SerialFlow' && !before.has(item.path))
      .map((item) => item.path)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    return { first: created[0] || portA, second: created[1] || portB, output }
  })
  ipcMain.handle('virtualPorts:remove', async (_event, first: string, second: string) => {
    const { manager } = virtualSerialPaths()
    if (!existsSync(manager)) throw new Error('未检测到 SerialFlow 管理程序')
    for (const port of [first, second]) if (openPorts.has(port)) await closePort(port)
    return runTool(manager, ['remove-pair', first, second])
  })
  ipcMain.handle('virtualPorts:openManager', async () => {
    const { manager } = virtualSerialPaths()
    if (!existsSync(manager)) throw new Error('未检测到 SerialFlow 管理程序')
    shell.showItemInFolder(manager)
  })
  ipcMain.handle('virtualPorts:openDownload', () => Promise.resolve())
  ipcMain.handle('fileTransfer:selectFile', async () => {
    if (!mainWindow) throw new Error('应用窗口尚未就绪')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要通过串口发送的文件',
      properties: ['openFile']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const filePath = result.filePaths[0]
    const info = await stat(filePath)
    return { path: filePath, name: filePath.split(/[\\/]/).at(-1) || '未命名文件', size: info.size }
  })
  ipcMain.handle('fileTransfer:selectDirectory', async () => {
    if (!mainWindow) throw new Error('应用窗口尚未就绪')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择串口接收文件的保存目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0] || null
  })
  ipcMain.handle('fileTransfer:setReceiver', async (_event, port: string, directory?: string) => {
    await enqueuePortOperation(async () => {
      assertPortAvailable(port)
      await fileTransferManager!.setReceiver(port, directory)
    })
  })
  ipcMain.handle(
    'fileTransfer:send',
    (
      _event,
      port: string,
      filePath: string,
      chunkSize: number,
      protocol: 'serialflow' | 'raw',
      chunkDelay?: number
    ) =>
      enqueuePortOperation(async () => {
        assertPortAvailable(port)
        return fileTransferManager!.sendFile(port, filePath, chunkSize, protocol, chunkDelay)
      })
  )
  ipcMain.handle('fileTransfer:cancel', (_event, taskId: string) =>
    fileTransferManager!.cancel(taskId)
  )
  ipcMain.handle('project:save', async (_event, project: unknown) => {
    if (!mainWindow) throw new Error('应用窗口尚未就绪')
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出 SerialFlow 工程',
      defaultPath: 'SerialFlow-project.serialflow',
      filters: [{ name: 'SerialFlow 工程', extensions: ['serialflow'] }]
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, JSON.stringify(project, null, 2), 'utf8')
    return result.filePath
  })
  ipcMain.handle('project:open', async () => {
    if (!mainWindow) throw new Error('应用窗口尚未就绪')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入 SerialFlow 工程',
      properties: ['openFile'],
      filters: [{ name: 'SerialFlow 工程', extensions: ['serialflow', 'json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return { path: result.filePaths[0], content: await readFile(result.filePaths[0], 'utf8') }
  })
  const configDialogOptions = (kind: unknown): { title: string; defaultPath: string } => {
    if (kind === 'quick-commands')
      return {
        title: '快捷指令',
        defaultPath: 'SerialFlow-quick-commands.json'
      }
    if (kind === 'auto-replies')
      return {
        title: '自动回复规则',
        defaultPath: 'SerialFlow-auto-reply-rules.json'
      }
    throw new Error('不支持的配置类型')
  }
  ipcMain.handle('config:save', async (_event, kind: unknown, config: unknown) => {
    if (!mainWindow) throw new Error('应用窗口尚未就绪')
    const options = configDialogOptions(kind)
    const result = await dialog.showSaveDialog(mainWindow, {
      title: `导出${options.title}`,
      defaultPath: options.defaultPath,
      filters: [{ name: `SerialFlow ${options.title}`, extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, JSON.stringify(config, null, 2), 'utf8')
    return result.filePath
  })
  ipcMain.handle('config:open', async (_event, kind: unknown) => {
    if (!mainWindow) throw new Error('应用窗口尚未就绪')
    const options = configDialogOptions(kind)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: `导入${options.title}`,
      properties: ['openFile'],
      filters:
        kind === 'quick-commands'
          ? [
              { name: '快捷指令（SerialFlow / SSCOM / VOFA+）', extensions: ['json', 'ini'] },
              { name: 'SSCOM 配置', extensions: ['ini'] },
              { name: 'SerialFlow / VOFA+ 命令组', extensions: ['json'] }
            ]
          : [{ name: `SerialFlow ${options.title}`, extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    return {
      path,
      content: decodeConfigText(
        await readFile(path),
        kind === 'quick-commands' && /\.ini$/i.test(path)
      )
    }
  })
  ipcMain.handle('modbus:openMap', async () => {
    if (!mainWindow) throw new Error('应用窗口尚未就绪')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入 Modbus Poll 寄存器映射',
      properties: ['openFile'],
      filters: [
        { name: 'Modbus 配置', extensions: ['mbp', 'json'] },
        { name: 'Modbus Poll 配置', extensions: ['mbp'] },
        { name: 'SerialFlow Modbus 配置', extensions: ['json'] }
      ]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const content = await readFile(result.filePaths[0])
    return {
      path: result.filePaths[0],
      name: result.filePaths[0].split(/[\\/]/).at(-1) || 'Modbus map.mbp',
      base64: content.toString('base64')
    }
  })
  ipcMain.handle('modbus:saveMap', async (_event, config: unknown) => {
    if (!mainWindow) throw new Error('应用窗口尚未就绪')
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出 Modbus RTU 配置',
      defaultPath: 'modbus-register-map.json',
      filters: [{ name: 'SerialFlow Modbus 配置', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, JSON.stringify(config, null, 2), 'utf8')
    return result.filePath
  })
  ipcMain.handle('serial:open', async (_event, options: PortOptions) =>
    enqueuePortOperation(() => openManagedPort(options))
  )
  ipcMain.handle('serial:close', async (_event, path: string) =>
    enqueuePortOperation(() => {
      assertPortAvailable(path)
      return closePort(path)
    })
  )
  ipcMain.handle('serial:write', async (_event, path: string, base64: string) => {
    if (!path) throw new Error('请选择发送串口')
    assertPortAvailable(path)
    const originalPort = openPorts.get(path)
    if (typeof base64 !== 'string' || !base64) throw new Error('发送内容不能为空')
    const data = Buffer.from(base64, 'base64')
    if (!data.length) throw new Error('发送内容不能为空')
    const previous = writeQueues.get(path) || Promise.resolve()
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        assertPortAvailable(path)
        const active = openPorts.get(path)
        if (active !== originalPort) throw new Error('串口连接已变化，已取消旧的发送任务')
        if (!active?.isOpen) throw new Error('串口未打开')
        try {
          await writeSerialData(active, data, virtualSerialPorts.has(active))
        } catch (error) {
          throw explainRuntimeError(error, '发送数据', active.path)
        }
      })
    writeQueues.set(
      path,
      task.catch(() => undefined)
    )
    await task
    return data.length
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 650,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true }
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
    for (const window of dataWindows.values()) window.destroy()
    dataWindows.clear()
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url)
      const isProgrammingManual = target.pathname.endsWith('/programming-manual/index.html')
      const isHelpManual = target.pathname.endsWith('/help/index.html')
      const isLocalManual =
        (isProgrammingManual || isHelpManual) &&
        (target.protocol === 'file:' ||
          (is.dev &&
            Boolean(process.env['ELECTRON_RENDERER_URL']) &&
            target.origin === new URL(process.env['ELECTRON_RENDERER_URL']!).origin))
      if (isLocalManual)
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 980,
            height: 760,
            minWidth: 720,
            minHeight: 520,
            autoHideMenuBar: true,
            title: isHelpManual ? 'SerialFlow 使用帮助' : 'SerialFlow 编程参数手册',
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
          }
        }
      if (target.protocol === 'https:' || target.protocol === 'http:') void shell.openExternal(url)
    } catch {
      /* Ignore invalid or unsafe external URLs. */
    }
    return { action: 'deny' }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL'])
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('io.github.calendarli.serialflow.desktop')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  registerSerialHandlers()
  createWindow()
  serialPortMonitor.start()
  const updates = new UpdateManager(
    autoUpdater,
    (state) => {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('update:state', state)
    },
    async () => {
      if (!mainWindow || mainWindow.isDestroyed() || quitting) return false
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '安装更新',
        message: '程序将关闭并安装更新，是否继续？',
        detail: '串口连接、数据传输和固件烧录任务将停止。请先保存需要的数据。',
        buttons: ['取消', '关闭并安装'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      return response === 1 && !quitting
    },
    async () => {
      quitting = true
      try {
        await firmwareManager?.shutdown()
        await closeAllPorts()
      } finally {
        // The ordinary quit handler remains responsible for final shutdown.
        quitting = false
      }
    },
    !app.isPackaged
      ? '开发模式不检查更新，请在安装后的正式版本中使用。'
      : !(
            (process.platform === 'win32' && process.arch === 'x64') ||
            (process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch))
          )
        ? '当前平台暂未提供自动更新安装包。'
        : undefined
  )
  ipcMain.handle('update:getState', () => updates.getState())
  ipcMain.handle('update:check', () => updates.check())
  ipcMain.handle('update:download', () => updates.download())
  ipcMain.handle('update:install', () => updates.install())
  void updates.checkOnStartup()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', (event) => {
  serialPortMonitor.stop()
  if (quitReady) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  void (async () => {
    await firmwareManager?.shutdown()
    await closeAllPorts()
    quitReady = true
    app.quit()
  })()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
