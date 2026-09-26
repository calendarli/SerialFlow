import assert from 'node:assert/strict'
import type { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function checkDataWindowPlot(main: BrowserWindow, data: BrowserWindow): Promise<void> {
  const run = (source: string): Promise<unknown> => data.webContents.executeJavaScript(source)
  const mainRun = (source: string): Promise<unknown> => main.webContents.executeJavaScript(source)
  const until = async (check: () => Promise<unknown>): Promise<void> => {
    const deadline = Date.now() + 8000
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('Data window plot UI timed out')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  const select = '[aria-label="曲线数值格式"]'
  const save = () =>
    run(
      "Array.from(document.querySelectorAll('button')).find(b => b.textContent === '保存并应用').click()"
    )
  const edit = () => run("document.querySelector('.data-window-heading button').click()")
  await mainRun(
    'window.__plotSamples = []; window.__offPlot = window.api.onDataWindowPlot(item => window.__plotSamples.push(item)); undefined'
  )
  try {
    await run(`localStorage.setItem('serialflow.dataWindow.program-qa', JSON.stringify({
      name: '进制测试', port: 'COM991', template: 'AA {值:2} BB',
      fieldFormats: {值:{signed:true,decimals:2}}, plotEnabled: true
    }))`)
    data.webContents.reload()
    await until(() => run(`Boolean(document.querySelector('${select}'))`))
    assert.equal(await run(`document.querySelector('${select}').value`), 'dec')
    const send = async (value: number): Promise<void> => {
      await mainRun('window.__plotSamples = []')
      data.webContents.send('serial:data', {
        path: 'COM991',
        chunks: [new Uint8Array([0xaa, 0xff, 0x85, 0xbb])]
      })
      await until(() => mainRun('window.__plotSamples.length > 0'))
      assert.equal(await mainRun('window.__plotSamples.at(-1).values.值'), value)
    }
    await send(-1.23)
    await run(
      `(() => { const select = document.querySelector('${select}'); select.value = 'hex'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`
    )
    await save()
    await send(-123)
    data.webContents.reload()
    await until(() => run(`Boolean(document.querySelector('${select}'))`))
    assert.equal(await run(`document.querySelector('${select}').value`), 'hex')
    await send(-123)
    await run(`document.querySelector('${select}').scrollIntoView({block:'center'})`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    writeFileSync(
      join(process.cwd(), '.tmp/ui-smoke/data-window-plot.png'),
      (await data.webContents.capturePage()).toPNG()
    )
    await run(
      `(() => { const select = document.querySelector('${select}'); select.value = 'dec'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`
    )
    await save()
    await send(-1.23)
    await edit()
    await run("document.querySelector('.data-window-plot-toggle input').click()")
    await save()
    await mainRun('window.__plotSamples = []')
    data.webContents.send('serial:data', {
      path: 'COM991',
      chunks: [new Uint8Array([0xaa, 0xff, 0x85, 0xbb])]
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(await mainRun('window.__plotSamples.length'), 0)
    await run(`(() => {
      const key = 'serialflow.dataWindow.program-qa';
      const config = JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify({...config, plotEnabled:true, plotFormat:'hex', programming:true, program:'function process(data) { return [{name:"值",value:data.值 * 2}] }'}));
    })()`)
    data.webContents.reload()
    await until(() => run(`Boolean(document.querySelector('${select}'))`))
    assert.equal(await run(`document.querySelector('${select}').disabled`), true)
    await send(-2.46)
    console.log(
      'Data window plot: DEC default, HEX signed integers, persisted selection, disabling and program outputs passed'
    )
  } finally {
    await mainRun('window.__offPlot(); delete window.__offPlot; delete window.__plotSamples')
  }
}
