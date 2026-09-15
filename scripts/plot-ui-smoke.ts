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
    const layout = () =>
      run(`(() => {
      const plot = document.querySelector('.plot-panel').getBoundingClientRect();
      const stack = document.querySelector('.interaction-stack').getBoundingClientRect();
      const receiver = document.querySelector('.interaction-stack > .receiver').getBoundingClientRect();
      return {height:plot.height, available:stack.height, receive:receiver.height}
    })()`)
    window.setSize(1400, 1300)
    await until(async () => (await layout()).available > 950, 'tall plot container')
    const centered = async () => {
      const size = await layout()
      return Math.abs(size.height - size.available / 2) < 2
    }
    await until(centered, 'fresh configuration defaults to 50 percent')
    const divider = await run(`(() => {
      const r=document.querySelector('.plot-panel-resizer').getBoundingClientRect();
      return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+2)}
    })()`)
    window.webContents.sendInputEvent({ type: 'mouseMove', ...divider })
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      ...divider,
      button: 'left',
      clickCount: 1
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    window.webContents.sendInputEvent({ type: 'mouseMove', x: divider.x, y: 850 })
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      x: divider.x,
      y: 850,
      button: 'left',
      clickCount: 1
    })
    await until(async () => (await layout()).height > 520, 'plot can grow beyond 520 pixels')
    assert((await layout()).receive >= 169)
    window.setSize(1400, 800)
    await until(async () => {
      const size = await layout()
      return size.available < 650 && size.height <= size.available - 169 && size.receive >= 169
    }, 'plot shrinks with available space')
    window.setSize(1400, 1000)
    await run(
      `document.querySelector('.plot-panel-resizer').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`
    )
    await until(centered, 'double click resets divider to 50 percent')
    assert.equal(await run(`localStorage.getItem('serialflow.plotPanelHeight')`), null)
    const beforeResize = (await layout()).available
    window.setSize(1400, 1300)
    await until(async () => (await layout()).available > beforeResize + 50, 'resize after reset')
    await until(centered, 'default divider stays centered after window resize')
    window.setSize(1400, 1000)
    const send = (texts: string[]) =>
      window.webContents.send('serial:data', {
        path: 'COM991',
        chunks: texts.map((text) => new Uint8Array(Buffer.from(text)))
      })
    const measurementWindow = () =>
      BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('plotMeasurement=true')
      )
    const measureRun = async (source: string) => {
      await until(() => measurementWindow(), 'native measurement window')
      const child = measurementWindow()!
      await until(
        () =>
          child.webContents.executeJavaScript(
            'Boolean(document.querySelector(".plot-measurements"))'
          ),
        'measurement data mounted'
      )
      return child.webContents.executeJavaScript(source)
    }
    const click = async (text: string, selector = '.plot-panel button') => {
      if (text === '暂停接收' || text === '继续接收') {
        await measureRun(
          `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='${text}').click()`
        )
        await until(
          () =>
            measureRun(
              `document.querySelector('.measurement-resume').textContent === '${text === '暂停接收' ? '继续接收' : '暂停接收'}'`
            ),
          'receive button state synchronized'
        )
        return
      }
      return run(
        `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(b=>b.textContent===${JSON.stringify(text)}).click()`
      )
    }
    const input = async (label: string, value: number) => {
      await measureRun(
        `(() => { const input=document.querySelector('[aria-label="${label}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'${value}'); input.dispatchEvent(new Event('input',{bubbles:true})) })()`
      )
      await until(
        () => measureRun(`document.querySelector('[aria-label="${label}"]').value === '${value}'`),
        'cursor edit synchronized'
      )
    }
    const row = () =>
      measureRun(
        `Array.from(document.querySelector('.plot-measurements tr[data-channel="AD"]').children).map(e=>e.textContent)`
      )
    send(['AD=10', 'AD=20', 'AD=30', 'AD=40', 'AD=50'])
    await until(
      () => run('document.querySelector(".plot-heading").textContent.includes("5 个采样点")'),
      'five samples'
    )
    await click('双游标')
    await measureRun('true')
    assert(
      await run(`!document.querySelector('.plot-heading').textContent.includes('已冻结')`),
      'opening measurement keeps the plot live'
    )
    assert.deepEqual(
      measurementWindow()!.getSize(),
      [680, 656],
      'measurement window uses the compact tall default size'
    )
    assert.equal(await run('Boolean(document.querySelector(".plot-measurements"))'), false)
    assert.equal(measurementWindow()!.isAlwaysOnTop(), false)
    await measureRun(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='启用置顶').click()`
    )
    await until(() => measurementWindow()!.isAlwaysOnTop(), 'native always-on-top enabled')
    await until(
      () =>
        measureRun(
          `Boolean(Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='取消置顶'))`
        ),
      'pin button updated'
    )
    await measureRun(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='取消置顶').click()`
    )
    await until(() => !measurementWindow()!.isAlwaysOnTop(), 'native always-on-top disabled')
    await input('游标 A 采样点', 1)
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await new Promise((resolve) => setTimeout(resolve, 80))
    await input('游标 B 采样点', 5)
    const labelSizes = () =>
      run(`Array.from(document.querySelectorAll('.plot-cursor-label')).map(label => {
      const r = label.getBoundingClientRect(); return {width:r.width,height:r.height}
    })`)
    const originalLabels = await labelSizes()
    assert.equal(originalLabels.length, 2)
    const handle = await run(
      `(() => { const r=document.querySelector('.plot-panel-resizer').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+2)} })()`
    )
    window.webContents.sendInputEvent({ type: 'mouseMove', ...handle })
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      ...handle,
      button: 'left',
      clickCount: 1
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    window.webContents.sendInputEvent({ type: 'mouseMove', x: handle.x, y: 100 })
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      x: handle.x,
      y: 100,
      button: 'left',
      clickCount: 1
    })
    await until(async () => (await layout()).height <= 161, 'minimum plot height')
    assert.deepEqual(
      await labelSizes(),
      originalLabels,
      'cursor label dimensions must not scale with plot height'
    )
    fs.writeFileSync(
      path.join(root, '.tmp/ui-smoke/plot-short-labels.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    await run(
      `document.querySelector('.plot-panel-resizer').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`
    )
    await until(centered, 'restore plot after label test')
    const dragRange = async (offset: number) => {
      const position = await run(`(() => {
        const r=document.querySelector('.plot-measurement-selection rect').getBoundingClientRect();
        const svg=document.querySelector('[aria-label="实时数据曲线"]').getBoundingClientRect();
        const x=r.x+r.width/2;
        return {x:Math.round(x),y:Math.round(r.y+r.height/2),target:Math.round(Math.max(svg.x+svg.width*.028,Math.min(svg.x+svg.width*.91,x+${offset}*svg.width*.882/4)))}
      })()`)
      window.webContents.sendInputEvent({ type: 'mouseMove', x: position.x, y: position.y })
      window.webContents.sendInputEvent({
        type: 'mouseDown',
        x: position.x,
        y: position.y,
        button: 'left',
        clickCount: 1
      })
      window.webContents.sendInputEvent({ type: 'mouseMove', x: position.target, y: position.y })
      window.webContents.sendInputEvent({
        type: 'mouseUp',
        x: position.target,
        y: position.y,
        button: 'left',
        clickCount: 1
      })
    }
    const cursorPair = () =>
      measureRun(
        `['A','B'].map(c=>Number(document.querySelector('[aria-label="游标 '+c+' 采样点"]').value)).join(',')`
      )
    await input('游标 A 采样点', 1)
    await input('游标 B 采样点', 3)
    await dragRange(1)
    await until(async () => (await cursorPair()) === '2,4', 'range drag moves both cursors')
    assert.deepEqual(await row(), ['AD', '20', '40', '20', '3', '20', '40', '30', '20'])
    await dragRange(10)
    await until(
      async () => (await cursorPair()) === '3,5',
      'range stops at last sample without shrinking'
    )
    await input('游标 A 采样点', 4)
    await input('游标 B 采样点', 2)
    await dragRange(-10)
    await until(async () => (await cursorPair()) === '3,1', 'reversed range stops at first sample')
    await run(
      `document.querySelector('.plot-measurement-selection rect').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`
    )
    await until(
      async () => (await cursorPair()) === '5,3',
      'keyboard translation preserves reversed order'
    )
    await input('游标 A 采样点', 1)
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
      () => measureRun(`document.querySelector('[aria-label="游标 A 采样点"]').value === '3'`),
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
    await until(async () => (await row())[2] === '50', 'keyboard edit synchronized')
    await click('暂停接收')
    assert(
      await run(
        `Array.from(document.querySelectorAll('.receiver button')).some(b=>b.textContent.includes('暂停接收') && b.getAttribute('aria-pressed')==='true')`
      ),
      'main receive pause state synchronized'
    )
    send(['AD=999'])
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert(
      !(await run(`document.querySelector('.receiver').textContent.includes('AD=999')`)),
      'paused frames are excluded from receive display'
    )
    assert(measurementWindow(), 'pausing keeps the measurement window open')
    await click('继续接收')
    send(['AD=60'])
    await until(
      async () => (await row())[2] === '60',
      'measurement statistics follow arriving data'
    )
    assert.equal(await cursorPair(), '5,6', 'live cursors advance together with the waveform')
    await input('游标 A 采样点', 1)
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await new Promise((resolve) => setTimeout(resolve, 80))
    fs.writeFileSync(
      path.join(root, '.tmp/ui-smoke/plot-cursors.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    measurementWindow()!.showInactive()
    await measureRun(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    )
    fs.writeFileSync(
      path.join(root, '.tmp/ui-smoke/plot-measurement-window.png'),
      (await measurementWindow()!.webContents.capturePage()).toPNG()
    )
    measurementWindow()!.close()
    await until(() => !measurementWindow(), 'measurement window closes')
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
      await measureRun(
        `Array.from(document.querySelector('.plot-measurements tr[data-channel="计算·压力 (gf)"]').children).map(e=>e.textContent)`
      ),
      ['计算·压力 (gf)', '20', '60', '40', '3', '20', '60', '40', '40']
    )
    measurementWindow()!.close()
    await until(() => !measurementWindow(), 'native close button closes measurement')
    await until(() => run('!document.querySelector(".cursor-a")'), 'native close ends measurement')
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
    const rollingValue = () =>
      measureRun(
        `document.querySelector('.plot-measurements tbody tr td:nth-child(3)').textContent`
      )
    const beforeRolling = await rollingValue()
    const beforePair = await cursorPair()
    send(Array.from({ length: 10 }, () => '9999,9999,9999,9999,9999,9999,9999,9999'))
    await until(
      async () => (await rollingValue()) !== beforeRolling,
      'statistics update after ring buffer rollover'
    )
    assert.equal(
      await cursorPair(),
      beforePair,
      'cursor interval stays fixed relative to a full rolling buffer'
    )
    await click('暂停接收')
    const pausedValue = await rollingValue()
    send(['8888,8888,8888,8888,8888,8888,8888,8888'])
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(
      await rollingValue(),
      pausedValue,
      'receive pause holds live measurement statistics'
    )
    await run(
      `Array.from(document.querySelectorAll('.receiver button')).find(b=>b.textContent.includes('暂停接收')).click()`
    )
    await until(
      () => measureRun(`document.querySelector('.measurement-resume').textContent === '暂停接收'`),
      'main window resume synchronizes back to measurement'
    )
    const measurementView = measurementWindow()!
    measurementView.showInactive()
    measurementView.setSize(1000, 540)
    await until(() => measureRun('window.innerHeight > 470'), 'expanded measurement layout')
    await measureRun(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    )
    fs.writeFileSync(
      path.join(root, '.tmp/ui-smoke/plot-measurement-styled.png'),
      (await measurementView.webContents.capturePage()).toPNG()
    )
    measurementView.setSize(680, 420)
    await until(() => measureRun('window.innerWidth < 700'), 'narrow measurement layout')
    assert(
      await measureRun('document.documentElement.scrollWidth <= window.innerWidth'),
      'measurement window must fit narrow widths'
    )
    assert(
      await measureRun(
        `Array.from(document.querySelectorAll('.measurement-actions button, .measurement-summary input')).every(el => {const r=el.getBoundingClientRect();return r.width>0 && r.left>=0 && r.right<=window.innerWidth})`
      ),
      'measurement controls remain visible'
    )
    await measureRun(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    )
    fs.writeFileSync(
      path.join(root, '.tmp/ui-smoke/plot-measurement-narrow.png'),
      (await measurementView.webContents.capturePage()).toPNG()
    )
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
