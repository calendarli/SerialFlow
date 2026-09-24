// Run with bun run test:ui after bun run build. Uses simulated hardware.
import { app, BrowserWindow, dialog } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import NodeModule, { createRequire } from 'node:module'
import * as realChildProcess from 'node:child_process'
process.on('uncaughtException', (error) => {
  console.error(error)
  app.exit(1)
})
const require = createRequire(path.join(process.cwd(), 'package.json'))
// Only this isolated Electron process intercepts CommonJS native dependencies.
const Module = NodeModule as unknown as { _load: (name: string, ...args: unknown[]) => unknown }
const load = Module._load
let finishFirmware: (() => void) | undefined
const openedOptions: SerialOptions[] = []
type SerialOptions = { path: string; baudRate: number }
class FakeSerialPort extends EventEmitter {
  static ymodemMode = false
  static autoHandshake = true
  static latestYmodem: FakeSerialPort | null = null
  path: string
  settings: SerialOptions
  baudRate: number
  isOpen: boolean
  writes: Buffer[] = []
  private ymodemPhase: 'header' | 'data' | 'final' = 'header'
  private ymodem: boolean
  static async list() {
    return [{ path: 'COM991', manufacturer: 'Test fixture (no hardware)' }]
  }
  constructor(options: SerialOptions) {
    super()
    this.path = options.path
    this.settings = options
    this.baudRate = options.baudRate
    this.isOpen = false
    this.ymodem = FakeSerialPort.ymodemMode
    if (this.ymodem) FakeSerialPort.latestYmodem = this
    openedOptions.push(options)
  }
  open(callback: (error: Error | null) => void) {
    this.isOpen = true
    setImmediate(() => {
      callback(null)
      if (this.ymodem && FakeSerialPort.autoHandshake)
        setTimeout(() => this.emit('data', Buffer.from([0x43])), 0)
    })
  }
  close(callback: (error: Error | null) => void) {
    this.isOpen = false
    setImmediate(() => {
      this.emit('close')
      callback(null)
    })
  }
  write(data: Buffer, callback: (error: Error | null) => void) {
    this.writes.push(Buffer.from(data))
    setImmediate(() => {
      callback(null)
      if (!this.ymodem) return
      if (data[0] === 0x43) return
      let response: number[]
      if (data[0] === 0x04) {
        this.ymodemPhase = 'final'
        response = [0x06, 0x43]
      } else if (this.ymodemPhase === 'header') {
        this.ymodemPhase = 'data'
        response = [0x06, 0x43]
      } else response = [0x06]
      this.emit('data', Buffer.from(response))
    })
  }
  drain(callback: (error: Error | null) => void) {
    setImmediate(() => callback(null))
  }
}
Module._load = function (name, ...args) {
  if (name === 'serialport') return { SerialPort: FakeSerialPort }
  if (name === 'child_process')
    return {
      ...realChildProcess,
      spawn(exe, argv, options) {
        if (!argv.includes('write-flash')) return realChildProcess.spawn(exe, argv, options)
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: (): boolean => true
        })
        child.kill = () => child.emit('close', null)
        finishFirmware = () => {
          child.stdout.write('Writing at 0x1000 (100 %)\nHash of data verified.\n')
          child.emit('close', 0)
        }
        return child
      }
    }
  return load.call(this, name, ...args)
}
const root = process.cwd()
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('in-process-gpu')
const profile = fs.mkdtempSync(path.join(root, '.tmp', 'ui-smoke', 'firmware-qa-'))
app.setPath('appData', profile)
app.setPath('userData', profile)
app.getAppPath = () => root
BrowserWindow.prototype.show = function () {
  /* Keep test windows hidden. */
}
const fixture = path.join(profile, 'application.bin')
fs.writeFileSync(fixture, Buffer.from([1, 2, 3, 4]))
const firmwareDialogPaths: Array<string | undefined> = []
dialog.showOpenDialog = async (...args) => {
  const options = args.at(-1) as { title?: string; defaultPath?: string }
  if (options.title === '选择烧录固件') firmwareDialogPaths.push(options.defaultPath)
  return { canceled: false, filePaths: [fixture] }
}
const errors: string[] = []
app.on('web-contents-created', (_event, contents) => {
  contents.setBackgroundThrottling(false)
  contents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message)
  })
})
require(path.join(root, 'out/main/index.js'))
async function until(fn: () => unknown | Promise<unknown>, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('UI condition timed out')
}
const deadline = setTimeout(() => {
  console.error('Electron QA timed out')
  app.exit(1)
}, 60000)
app.whenReady().then(async () => {
  try {
    await until(() => BrowserWindow.getAllWindows().length)
    const window = BrowserWindow.getAllWindows()[0]
    const run = async (source: string) => {
      try {
        return await window.webContents.executeJavaScript(source)
      } catch (error) {
        throw new Error(`Firmware UI script failed: ${source}`, { cause: error })
      }
    }
    await until(() => run('Boolean(document.querySelector(".send-mode-tabs"))'))
    await run(
      `Array.from(document.querySelectorAll('.send-mode-tabs button')).find(b => b.textContent === '固件烧录').click()`
    )
    assert(await run(`!document.querySelector('.firmware-host').hidden`))
    assert(await run(`document.querySelector('[aria-label="芯片系列"]').value === 'stm32'`))
    await run(
      `(() => { const s = document.querySelector('[aria-label="烧录方式"]'); s.value = 'ymodem'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`
    )
    assert(await run(`document.querySelector('[aria-label="烧录方式"]').value === 'ymodem'`))
    assert(
      await run(
        `!Array.from(document.querySelectorAll('.firmware-panel button')).some(b => b.textContent === '检测芯片')`
      )
    )
    assert(await run(`!document.querySelector('.firmware-tool-path')`))
    await run(
      `Array.from(document.querySelectorAll('.firmware-panel button')).find(b => b.textContent === '选择固件').click()`
    )
    await until(() => run(`document.querySelectorAll('.firmware-file').length === 1`))
    assert(await run(`!document.querySelector('[aria-label$="写入地址"]')`))
    assert.equal(firmwareDialogPaths[0], undefined)
    await run(
      `(() => { const s = document.querySelector('[aria-label="芯片系列"]'); s.value = 'esp32'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`
    )
    await until(() =>
      run(`Boolean(document.querySelector('.firmware-tool-ok')?.textContent.includes('5.3.1'))`)
    )
    await run(
      `Array.from(document.querySelectorAll('.firmware-panel button')).find(b => b.textContent === '添加 BIN').click()`
    )
    await until(() => run(`document.querySelectorAll('.firmware-file').length === 1`))
    assert.equal(firmwareDialogPaths[1], path.dirname(fixture))
    assert(
      await run(
        `Array.from(document.querySelectorAll('.firmware-panel button')).find(b => b.textContent === '开始烧录').disabled`
      )
    )
    await run(
      `Array.from(document.querySelectorAll('.send-mode-tabs button')).find(b => b.textContent === '发送消息').click()`
    )
    assert(await run(`document.querySelector('.firmware-host').hidden`))
    await run(
      `Array.from(document.querySelectorAll('.send-mode-tabs button')).find(b => b.textContent === '固件烧录').click()`
    )
    assert.equal(await run(`document.querySelectorAll('.firmware-file').length`), 1)
    await run(
      `Array.from(document.querySelectorAll('.firmware-panel button')).find(b => b.textContent.includes('高级设置')).click()`
    )
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const layout = await run(
      `(() => { const panel = document.querySelector('.firmware-panel').getBoundingClientRect(); const footer = document.querySelector('.firmware-footer').getBoundingClientRect(); return { panel: panel.toJSON(), footer: footer.toJSON(), overflow: document.documentElement.scrollWidth > innerWidth }; })()`
    )
    assert(!layout.overflow, 'page must not overflow horizontally')
    assert(layout.footer.bottom <= layout.panel.bottom + 1, 'actions must remain in the panel')
    assert(layout.footer.height > 25)
    fs.writeFileSync(
      path.join(root, '.tmp', 'ui-smoke', 'firmware-ui.png'),
      (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG()
    )
    window.setContentSize(980, 650)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    fs.writeFileSync(
      path.join(root, '.tmp', 'ui-smoke', 'firmware-ui-compact.png'),
      (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG()
    )
    assert(await run(`document.documentElement.scrollWidth <= innerWidth`))
    const serialOptions = {
      path: 'COM991',
      baudRate: 57600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none'
    }
    await run(`window.api.openPort(${JSON.stringify(serialOptions)})`)
    const request = {
      family: 'esp32',
      transport: 'uart',
      port: 'COM991',
      probe: '',
      chip: 'auto',
      baudRate: 115200,
      files: [{ path: fixture, name: 'application.bin', size: 4, address: '0x1000' }],
      verify: true,
      reset: true,
      restorePort: true,
      listenForC: false,
      eraseAll: false,
      manualBoot: false,
      connectMode: 'NORMAL',
      toolPath: ''
    }
    await run(`window.api.startFirmware(${JSON.stringify(request)}, 'flash')`)
    await until(() => Boolean(finishFirmware))
    await until(() =>
      run(`Boolean(document.querySelector('.firmware-progress-track.is-indeterminate'))`)
    )
    assert.deepEqual(await run(`window.api.getOpenedPortPaths()`), [])
    const deniedOpen = await run(
      `window.api.openPort(${JSON.stringify(serialOptions)}).then(() => '', e => e.message)`
    )
    assert.match(deniedOpen, /独占/)
    assert.match(
      await run(`window.api.write('COM991', 'AQ==').then(() => '', e => e.message)`),
      /独占/
    )
    finishFirmware!()
    await until(() => run(`window.api.getFirmwareState().then(s => !s.busy)`))
    assert.equal(await run(`window.api.getFirmwareState().then(s => s.outcome)`), 'success')
    assert.deepEqual(await run(`window.api.getOpenedPortPaths()`), ['COM991'])
    await until(() =>
      run(
        `document.querySelector('.firmware-status-success .firmware-progress-fill')?.style.width === '100%'`
      )
    )
    assert.equal(openedOptions.at(-1)!.baudRate, 57600, 'original serial settings must be restored')
    await run(`window.api.closePort('COM991')`)
    await run(
      `(() => { const s = document.querySelector('[aria-label="芯片系列"]'); s.value = 'stm32'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`
    )
    await run(
      `(() => { const s = document.querySelector('[aria-label="烧录方式"]'); s.value = 'ymodem'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`
    )
    await until(() =>
      run(`Boolean(document.querySelector('[aria-label="烧录串口"] option[value="COM991"]'))`)
    )
    await run(
      `(() => { const s = document.querySelector('[aria-label="烧录串口"]'); s.value = 'COM991'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`
    )
    await run(
      `Array.from(document.querySelectorAll('.firmware-panel button')).find(b => b.textContent === '选择固件').click()`
    )
    await until(() => run(`document.querySelectorAll('.firmware-file').length === 1`))
    await run(
      `Array.from(document.querySelectorAll('.firmware-options label')).find(l => l.textContent.includes('结束后恢复原串口连接')).querySelector('input').click()`
    )
    FakeSerialPort.ymodemMode = true
    FakeSerialPort.autoHandshake = false
    await run(`window.api.openPort(${JSON.stringify(serialOptions)})`)
    await run(
      `Array.from(document.querySelectorAll('.firmware-options label')).find(l => l.textContent.includes('监听 C 选口握手')).querySelector('input').click()`
    )
    await until(() =>
      run(`window.api.getFirmwareListenState().then(s => s?.status === 'listening')`)
    )
    assert(
      await run(
        `Array.from(document.querySelectorAll('.firmware-panel button')).find(b => b.textContent === '开始烧录').disabled`
      )
    )
    FakeSerialPort.latestYmodem!.emit('data', Buffer.from([0x43]))
    await until(() => run(`window.api.getFirmwareListenState().then(s => s?.status === 'ready')`))
    assert.deepEqual(FakeSerialPort.latestYmodem!.writes[0], Buffer.from([0x43]))
    assert(
      await run(
        `document.querySelector('.firmware-status-title')?.textContent.includes('已收到并回复 0x43')`
      )
    )
    assert.deepEqual(await run(`window.api.getOpenedPortPaths()`), [])
    window.setContentSize(1280, 750)
    await run(`document.querySelector('.firmware-options').scrollIntoView({ block: 'center' })`)
    await new Promise((resolve) => setTimeout(resolve, 500))
    fs.writeFileSync(
      path.join(root, '.tmp', 'ui-smoke', 'firmware-listen-ready.png'),
      (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG()
    )
    await until(() =>
      run(
        `!Array.from(document.querySelectorAll('.firmware-panel button')).find(b => b.textContent === '开始烧录').disabled`
      )
    )
    await run(
      `Array.from(document.querySelectorAll('.firmware-panel button')).find(b => b.textContent === '开始烧录').click()`
    )
    await until(() => run(`window.api.getFirmwareState().then(s => s?.operation === 'flash')`))
    await until(() => run(`window.api.getFirmwareState().then(s => !s.busy)`))
    assert.equal(await run(`window.api.getFirmwareState().then(s => s.outcome)`), 'success')
    assert.deepEqual(await run(`window.api.getOpenedPortPaths()`), ['COM991'])
    await until(() =>
      run(`document.querySelector('.firmware-status-meta')?.textContent.includes('4 B / 4 B')`)
    )
    assert(
      await run(
        `document.querySelector('.firmware-status-success .firmware-progress-fill')?.style.width === '100%'`
      )
    )
    await until(() =>
      run(
        `(() => { const track = document.querySelector('.firmware-progress-track'); const fill = track?.querySelector('.firmware-progress-fill'); return track && fill && !track.classList.contains('is-indeterminate') && fill.getBoundingClientRect().width >= track.getBoundingClientRect().width * 0.99; })()`
      )
    )
    window.setContentSize(1280, 750)
    await new Promise((resolve) => setTimeout(resolve, 500))
    fs.writeFileSync(
      path.join(root, '.tmp', 'ui-smoke', 'firmware-ymodem-complete.png'),
      (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG()
    )
    await run(`window.api.closePort('COM991')`)
    FakeSerialPort.ymodemMode = false
    for (const page of ['help', 'programming-manual']) {
      await run(`(() => { window.open(new URL('${page}/index.html', location.href).href); })()`)
      await until(() =>
        BrowserWindow.getAllWindows().some((candidate) =>
          candidate.webContents.getURL().includes(`/${page}/index.html`)
        )
      )
      const manual = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes(`/${page}/index.html`)
      )!
      const evaluate = (source: string): Promise<unknown> =>
        manual.webContents.executeJavaScript(source)
      await until(() => evaluate('Boolean(document.querySelector("h1"))'))
      if (page === 'help') {
        await evaluate(
          `(() => { const input = document.querySelector('#search'); input.value = 'zz-no-result'; input.dispatchEvent(new Event('input')); })()`
        )
        assert.equal(await evaluate('document.querySelectorAll("article:not([hidden])").length'), 0)
        await evaluate(`document.querySelector('#clear').click()`)
        assert(
          Number(await evaluate('document.querySelectorAll("article:not([hidden])").length')) > 0
        )
        assert.equal(
          await evaluate(
            `new URL(document.querySelector('.manual-link').href).pathname.endsWith('/programming-manual/index.html')`
          ),
          true
        )
      } else {
        assert.equal(
          await evaluate(`document.querySelector('pre code').textContent.includes('\\n')`),
          true
        )
      }
      manual.destroy()
    }
    assert.equal(errors.length, 0, errors.join('\n'))
    console.log(
      'PASS: real Electron preload, STM32 Ymodem firmware UI/transfer, simulated serial exclusion/restoration, and both React manuals.'
    )
    clearTimeout(deadline)
    app.quit()
  } catch (error) {
    console.error(error)
    clearTimeout(deadline)
    app.exit(1)
  }
})
