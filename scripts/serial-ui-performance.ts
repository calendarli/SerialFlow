// Run after a production build with bun run test:ui:serial. No real port is opened.
import { app, BrowserWindow } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import assert from 'node:assert/strict'
import NodeModule, { createRequire } from 'node:module'
import { checkModbusPresets } from './modbus-presets-ui'
import { checkSerialCommandDrag } from './serial-command-drag-ui'

const root = process.cwd()
const moduleRequire = createRequire(path.join(root, 'package.json'))
const Module = NodeModule as unknown as { _load: (name: string, ...args: unknown[]) => unknown }
const load = Module._load
Module._load = function (name, ...args) {
  if (name === 'serialport')
    return {
      SerialPort: class {
        static async list() {
          return [{ path: 'COM991', manufacturer: 'Simulated UI benchmark' }]
        }
      }
    }
  return load.call(this, name, ...args)
}
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('in-process-gpu')
const profile = fs.mkdtempSync(path.join(root, '.tmp', 'ui-smoke', 'firmware-qa-serial-'))
app.setPath('appData', profile)
app.setPath('userData', profile)
app.getAppPath = () => root
BrowserWindow.prototype.show = function () {
  /* Isolated benchmark window. */
}
const errors: string[] = []
app.on('web-contents-created', (_event, contents) => {
  contents.setBackgroundThrottling(false)
  contents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message)
  })
})
moduleRequire(path.join(root, 'out/main/index.js'))
async function until(fn: () => unknown | Promise<unknown>, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('UI condition timed out')
}
const deadline = setTimeout(() => {
  console.error('Serial UI benchmark timed out')
  app.exit(1)
}, 60000)
app.whenReady().then(async () => {
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    await until(() => BrowserWindow.getAllWindows().length)
    const window = BrowserWindow.getAllWindows()[0]
    window.setOpacity(0)
    window.setSkipTaskbar(true)
    window.showInactive()
    const run = (source: string) => window.webContents.executeJavaScript(source)
    await until(() => run('Boolean(document.querySelector(".send-mode-tabs"))'))
    await run(
      `Array.from(document.querySelectorAll('.send-mode-tabs button')).find(b => b.textContent === '固件烧录').click()`
    )
    await run(
      `window.__lags = []; window.__tasks = []; window.__observer = new PerformanceObserver(list => window.__tasks.push(...list.getEntries().map(e => e.duration))); window.__observer.observe({entryTypes:['longtask']}); window.__tick = performance.now(); window.__timer = setInterval(() => { const now = performance.now(); window.__lags.push(Math.max(0, now-window.__tick-10)); window.__tick=now }, 10)`
    )
    const bytes = new Uint8Array(Buffer.from('2,22,551'))
    let sent = 0
    console.log('READY')
    const start = Date.now()
    timer = setInterval(() => {
      const due = Math.min(100, Math.floor((Date.now() - start) / 10) * 10 - sent)
      if (due <= 0) return
      sent += due
      window.webContents.send('serial:data', {
        path: 'COM991',
        chunks: Array.from({ length: due }, () => bytes)
      })
    }, 10)
    const latencies: number[] = []
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const before = Date.now()
      await run(
        `new Promise(resolve => { const s = document.querySelector('[aria-label="芯片系列"]'); s.value = '${i % 2 ? 'stm32' : 'esp32'}'; s.dispatchEvent(new Event('change', {bubbles:true})); setTimeout(() => resolve(s.value), 0); })`
      )
      latencies.push(Date.now() - before)
    }
    clearInterval(timer)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const metrics = await run(
      `(() => { clearInterval(window.__timer); window.__observer.disconnect(); const lag=window.__lags.sort((a,b)=>a-b); return {lagP95:lag[Math.floor(lag.length*.95)],lagMax:Math.max(...lag),longTasks:window.__tasks.length,longTaskMs:window.__tasks.reduce((a,b)=>a+b,0),lastId:Math.max(...Array.from(document.querySelectorAll('[data-interaction-id]')).map(e=>Number(e.dataset.interactionId))),footer:document.querySelector('footer')?.textContent} })()`
    )
    console.log(JSON.stringify({ sent, latencies, ...metrics }))
    assert.equal(metrics.lastId, sent, 'Display must catch up to the last received frame')
    assert.equal(
      Number(/RX ([\d,]+) 次/.exec(metrics.footer)?.[1].replaceAll(',', '')),
      sent,
      'Every received frame must be counted'
    )
    assert(errors.length === 0, errors.join('\n'))
    await run(`localStorage.setItem('serialflow.dataWindow.program-qa', JSON.stringify({
      name: '压力换算测试', port: 'COM991', template: 'AA 02 {数据:4} BB', fieldFormats: {}, programming: true
    })); window.api.openDataWindow('program-qa')`)
    const dataWindow = BrowserWindow.getAllWindows().find((item) => item !== window)!
    const dataRun = (source: string) => dataWindow.webContents.executeJavaScript(source)
    await until(() => dataRun('Boolean(document.querySelector("[aria-label=数据换算程序]"))'))
    const editorStyle = await dataRun(`(() => {
      const input = document.querySelector('[aria-label=数据换算程序]');
      const pre = document.querySelector('.program-code-editor pre');
      const a = getComputedStyle(input), b = getComputedStyle(pre);
      return { color: a.webkitTextFillColor, font: a.font, preFont: b.font, padding: a.padding, prePadding: b.padding, resize: a.resize };
    })()`)
    assert.equal(
      editorStyle.color,
      'rgba(0, 0, 0, 0)',
      'Editor input must not duplicate highlighted text'
    )
    assert.equal(editorStyle.font, editorStyle.preFont)
    assert.equal(editorStyle.padding, editorStyle.prePadding)
    assert.equal(editorStyle.resize, 'none')
    await dataRun(
      `Array.from(document.querySelectorAll('[aria-label="数据处理模式"] button')).find(b => b.textContent === '普通模式').click()`
    )
    assert.equal(
      await dataRun('Boolean(document.querySelector("[aria-label=数据换算程序]"))'),
      false
    )
    await dataRun(
      `Array.from(document.querySelectorAll('[aria-label="数据处理模式"] button')).find(b => b.textContent === '编程模式').click()`
    )
    const sendAD = (ad: number) =>
      dataWindow.webContents.send('serial:data', {
        path: 'COM991',
        chunks: [new Uint8Array([0xaa, 2, 0, 0, ad >> 8, ad & 255, 0xbb])]
      })
    sendAD(3000)
    await until(() => dataRun('document.body.textContent.includes("250.00 gf")'))
    dataWindow.setSize(820, 900)
    await dataRun(
      `document.querySelector('.program-code-editor').style.height = '180px'; document.querySelector('.data-processing-mode').scrollIntoView()`
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    await dataRun(
      `document.querySelector('[aria-label=数据换算程序]').scrollTop = 25; document.querySelector('[aria-label=数据换算程序]').dispatchEvent(new Event('scroll'))`
    )
    const scrollAlignment = await dataRun(`(() => {
      const input = document.querySelector('[aria-label=数据换算程序]');
      const viewport = document.querySelector('.program-code-editor pre');
      const transform = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
      return { actual: transform.m42, expected: -input.scrollTop };
    })()`)
    assert.equal(scrollAlignment.actual, scrollAlignment.expected)
    assert(scrollAlignment.expected < 0, 'Editor must actually scroll for alignment coverage')
    fs.writeFileSync(
      path.join(root, '.tmp/ui-smoke/data-window-program.png'),
      (await dataWindow.webContents.capturePage()).toPNG()
    )
    await dataRun(
      `Array.from(document.querySelectorAll('button')).find(b => b.textContent === '保存并应用').click()`
    )
    dataWindow.webContents.reload()
    await until(() => dataRun('Boolean(document.querySelector("[aria-label=数据换算程序]"))'))
    sendAD(5000)
    await until(() => dataRun('document.body.textContent.includes("500.00 gf")'))
    await dataRun(`(() => {
      const input = document.querySelector('[aria-label=数据换算程序]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'function process() { while (true) {} }');
      input.dispatchEvent(new Event('input', {bubbles:true}));
    })()`)
    await dataRun(
      `Array.from(document.querySelectorAll('button')).find(b => b.textContent === '保存并应用').click()`
    )
    sendAD(3000)
    await until(() => dataRun('document.body.textContent.includes("换算失败")'))
    dataWindow.webContents.send('serial:status', { path: 'COM991', open: false })
    await until(() => dataRun('document.body.textContent.includes("等待匹配数据")'))
    console.log('Data window: AD to gf, saved configuration, script timeout and disconnect passed')
    dataWindow.destroy()
    await checkSerialCommandDrag(window)
    await checkModbusPresets(window)
    assert(errors.length === 0, errors.join('\n'))
    fs.writeFileSync(
      path.join(root, '.tmp/ui-smoke/modbus-presets.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    clearTimeout(deadline)
    app.exit(0)
  } catch (error) {
    if (timer) clearInterval(timer)
    console.error(error)
    app.exit(1)
  }
})
