// Production Electron test with simulated serial frames; no hardware is opened.
import { app, BrowserWindow } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import assert from 'node:assert/strict'
import NodeModule, { createRequire } from 'node:module'

const root = process.cwd()
const moduleRequire = createRequire(path.join(root, 'package.json'))
const Module = NodeModule as unknown as { _load: (name: string, ...args: unknown[]) => unknown }
const load = Module._load
Module._load = function (name, ...args) {
  if (name === 'serialport')
    return {
      SerialPort: class {
        static async list() {
          return [{ path: 'COM991', manufacturer: 'Plot QA' }]
        }
      }
    }
  return load.call(this, name, ...args)
}
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('in-process-gpu')
const profile = fs.mkdtempSync(path.join(root, '.tmp', 'ui-smoke', 'plot-qa-'))
app.setPath('appData', profile)
app.setPath('userData', profile)
app.getAppPath = () => root
BrowserWindow.prototype.show = function () {
  /* Keep isolated QA hidden. */
}
const errors: string[] = []
app.on('web-contents-created', (_event, contents) => {
  contents.setBackgroundThrottling(false)
  contents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message)
  })
})
moduleRequire(path.join(root, 'out/main/index.js'))
async function until(fn: () => unknown | Promise<unknown>, description: string, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`UI condition timed out: ${description}`)
}
const deadline = setTimeout(() => app.exit(1), 85000)
app.whenReady().then(async () => {
  try {
    await until(() => BrowserWindow.getAllWindows().length, 'main window')
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(1400, 1000)
    window.setOpacity(0)
    window.setSkipTaskbar(true)
    window.showInactive()
    const run = (source: string) => window.webContents.executeJavaScript(source)
    await until(() => run('Boolean(document.querySelector(".plot-panel"))'), 'plot mounted')
    await run(`localStorage.setItem('serialflow.serialConfigs', JSON.stringify([{id:1,name:'QA',path:'COM991',baudRate:115200,dataBits:8,stopBits:1,parity:'none',plotEnabled:true,framing:{mode:'raw'}}]));
      localStorage.setItem('serialflow.plotPointLimit','100000'); localStorage.setItem('serialflow.plotXWindowPoints','100000'); localStorage.setItem('serialflow.plotCollapsed','false'); localStorage.setItem('serialflow.interactionCacheEntries','10')`)
    const reloaded = new Promise<void>((resolve) =>
      window.webContents.once('did-finish-load', () => resolve())
    )
    window.webContents.reload()
    await reloaded
    await until(
      () => run('Boolean(document.querySelector(".plot-panel:not(.collapsed)"))'),
      'configured plot'
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    await run(
      `(() => { const input=document.querySelector('.serial-plot-setting input'); if (!input.checked) input.click() })()`
    )
    await until(
      () => run(`JSON.parse(localStorage.getItem('serialflow.serialConfigs'))[0].plotEnabled`),
      'plot enabled through UI'
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    const send = (texts: string[]) =>
      window.webContents.send('serial:data', {
        path: 'COM991',
        chunks: texts.map((text) => new Uint8Array(Buffer.from(text)))
      })
    const click = (text: string, selector = '.plot-panel button') =>
      run(
        `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(b=>b.textContent===${JSON.stringify(text)}).click()`
      )
    const input = (label: string, value: number) =>
      run(
        `(() => { const input=document.querySelector('[aria-label="${label}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'${value}'); input.dispatchEvent(new Event('input',{bubbles:true})) })()`
      )
    const row = () =>
      run(
        `Array.from(document.querySelector('.plot-measurements tr[data-channel="AD"]').children).map(e=>e.textContent)`
      )
    send(['AD=10', 'AD=20', 'AD=30', 'AD=40', 'AD=50'])
    await until(
      () => run('document.querySelector(".plot-heading").textContent.includes("5 个采样点")'),
      'five samples'
    )
    await click('双游标')
    await input('游标 A 采样点', 1)
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await new Promise((resolve) => setTimeout(resolve, 80))
    await input('游标 B 采样点', 5)
    assert.deepEqual(await row(), ['AD', '10', '50', '40', '5', '10', '50', '30', '40'])
    await click('设置')
    await click('时间', '[aria-label="曲线 X 轴模式"] button')
    assert(
      await run(
        `Array.from(document.querySelectorAll('.plot-html-x-label')).every(label=>label.textContent.includes(':'))`
      )
    )
    await click('点序号', '[aria-label="曲线 X 轴模式"] button')
    await click('设置')
    const drag = await run(
      `(() => {const handle=document.querySelector('.cursor-a rect').getBoundingClientRect();const svg=document.querySelector('[aria-label="实时数据曲线"]').getBoundingClientRect();return {x:Math.round(handle.x+handle.width/2),y:Math.round(handle.y+handle.height/2),target:Math.round(svg.x+(28+882*.5)/1000*svg.width)}})()`
    )
    window.webContents.sendInputEvent({ type: 'mouseMove', x: drag.x, y: drag.y })
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      x: drag.x,
      y: drag.y,
      button: 'left',
      clickCount: 1
    })
    window.webContents.sendInputEvent({ type: 'mouseMove', x: drag.target, y: drag.y })
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      x: drag.target,
      y: drag.y,
      button: 'left',
      clickCount: 1
    })
    await until(
      () => run(`document.querySelector('[aria-label="游标 A 采样点"]').value === '3'`),
      'cursor pointer drag'
    )
    await input('游标 A 采样点', 4)
    await input('游标 B 采样点', 2)
    assert.deepEqual(await row(), ['AD', '40', '20', '-20', '3', '20', '40', '30', '20'])
    await input('游标 B 采样点', 4)
    assert.deepEqual(await row(), ['AD', '40', '40', '0', '1', '40', '40', '40', '0'])
    await run(
      `document.querySelector('[aria-label="测量游标 B"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`
    )
    assert.equal((await row())[2], '50')
    send(['AD=60'])
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal((await row())[2], '50', 'Measurement must remain frozen while live data arrives')
    await input('游标 A 采样点', 1)
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await new Promise((resolve) => setTimeout(resolve, 80))
    fs.writeFileSync(
      path.join(root, '.tmp/ui-smoke/plot-cursors.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    await click('结束测量并继续')
    await until(
      () => run('document.querySelector(".plot-heading").textContent.includes("6 个采样点")'),
      'resume sees new sample'
    )
    await run(`document.querySelector('[aria-label="清空交互记录"]').click()`)
    assert(
      await run('document.querySelector(".plot-heading").textContent.includes("6 个采样点")'),
      'Clearing the text log must not clear plots'
    )

    await run(`document.querySelector('[aria-label="清空曲线"]').click()`)
    await click('设置')
    await click('计算通道', '.plot-options-popover button')
    await click('编程模式', '.plot-program-editor button')
    await run(
      `(() => { const input=document.querySelector('[aria-label="曲线计算程序"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'function process(data) { return [{name:"压力",value:data.AD * 2,unit:"gf"}] }'); input.dispatchEvent(new Event('input',{bubbles:true})) })()`
    )
    await click('保存并应用', '.plot-program-editor button')
    await until(() => run('!document.querySelector(".plot-program-editor")'), 'program applied')
    send(['AD=10', 'AD=20', 'AD=30'])
    await until(
      () => run('document.querySelector(".plot-legend").textContent.includes("计算·压力 (gf)")'),
      'calculated channel'
    )
    await click('双游标')
    await input('游标 A 采样点', 1)
    await input('游标 B 采样点', 3)
    assert.deepEqual(
      await run(
        `Array.from(document.querySelector('.plot-measurements tr[data-channel="计算·压力 (gf)"]').children).map(e=>e.textContent)`
      ),
      ['计算·压力 (gf)', '20', '60', '40', '3', '20', '60', '40', '40']
    )
    await click('结束测量并继续')
    await click('设置')
    await click('计算通道', '.plot-options-popover button')
    await click('普通模式', '.plot-program-editor button')
    await click('保存并应用', '.plot-program-editor button')
    await until(() => run('!document.querySelector(".plot-program-editor")'), 'raw mode applied')

    await run(
      `window.__lags=[]; window.__tick=performance.now(); window.__timer=setInterval(()=>{const now=performance.now(); window.__lags.push(Math.max(0,now-window.__tick-16));window.__tick=now},16)`
    )
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Profiler.enable')
    await window.webContents.debugger.sendCommand('Profiler.start')
    const started = Date.now()
    for (let batch = 0; batch < 100; batch++) {
      send(
        Array.from({ length: 1000 }, (_, i) =>
          Array.from({ length: 8 }, (_, channel) =>
            String((batch * 1000 + i + channel) % 1000)
          ).join(',')
        )
      )
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    await until(
      () => run('document.querySelector(".plot-heading").textContent.includes("100,000 个采样点")'),
      '100k samples retained',
      30000
    )
    const latencies: number[] = []
    await click('双游标')
    for (let i = 0; i < 10; i++) {
      const start = Date.now()
      await input('游标 A 采样点', 1 + i * 1000)
      latencies.push(Date.now() - start)
    }
    const metrics = await run(
      `(() => {clearInterval(window.__timer); const lags=window.__lags.sort((a,b)=>a-b); return {lagSamples:lags.length,lagP50:lags[Math.floor(lags.length*.5)],lagP95:lags[Math.floor(lags.length*.95)],lagMax:Math.max(...lags),header:document.querySelector('.plot-heading').textContent} })()`
    )
    const profile = await window.webContents.debugger.sendCommand('Profiler.stop')
    fs.writeFileSync(
      path.join(root, '.tmp/ui-smoke/plot.cpuprofile'),
      JSON.stringify(profile.profile)
    )
    window.webContents.debugger.detach()
    console.log(
      JSON.stringify({
        samples: 100000,
        channels: 8,
        elapsedMs: Date.now() - started,
        cursorRoundTripMs: latencies,
        ...metrics
      })
    )
    assert(errors.length === 0, errors.join('\n'))
    fs.writeFileSync(
      path.join(root, '.tmp/ui-smoke/plot-performance.json'),
      JSON.stringify(
        { samples: 100000, channels: 8, cursorRoundTripMs: latencies, ...metrics },
        null,
        2
      )
    )
    console.log(
      'Plot UI: cursor statistics, reversed/coincident cursors, keyboard, freeze/resume, independent history, calculated channels and 100k × 8 channels passed'
    )
    clearTimeout(deadline)
    app.exit(0)
  } catch (error) {
    const window = BrowserWindow.getAllWindows()[0]
    if (window) {
      console.error(
        await window.webContents.executeJavaScript(
          '({header:document.querySelector(".plot-heading")?.textContent,footer:document.querySelector("footer")?.textContent,config:localStorage.getItem("serialflow.serialConfigs")})'
        )
      )
      fs.writeFileSync(
        path.join(root, '.tmp/ui-smoke/plot-failure.png'),
        (await window.webContents.capturePage()).toPNG()
      )
    }
    console.error(errors)
    console.error(error)
    app.exit(1)
  }
})
