import assert from 'node:assert/strict'
import type { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function checkReceiveFraming(window: BrowserWindow): Promise<void> {
  const run = (source: string): Promise<unknown> => window.webContents.executeJavaScript(source)
  const until = async (source: string): Promise<void> => {
    const deadline = Date.now() + 8000
    while (!(await run(source))) {
      if (Date.now() > deadline) throw new Error(`Receive framing timeout: ${source}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  const setValue = async (selector: string, value: string, input = false): Promise<void> => {
    await run(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(${input ? 'HTMLInputElement' : 'HTMLSelectElement'}.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('${input ? 'input' : 'change'}', {bubbles: true}));
    })()`)
  }
  await run(`(() => {
    const configs = JSON.parse(localStorage.getItem('serialflow.serialConfigs'));
    const first = {...configs[0], id: 1, name: '分帧测试 A', path: 'COM991'};
    first.framing = {...first.framing, mode: 'raw'};
    localStorage.setItem('serialflow.serialConfigs', JSON.stringify([first, {...first, id: 2, name: '分帧测试 B', path: 'COM992'}]));
  })()`)
  window.webContents.reload()
  await until('Boolean(document.querySelector(".receiver .receive-framing"))')
  assert.equal(await run('document.querySelector(".receive-framing").open'), false)
  assert.equal(
    await run('document.querySelectorAll(".serial-profile .serial-framing-settings").length'),
    0
  )
  await run('document.querySelector(".receive-framing summary").click()')
  const mode = '.receive-framing .serial-framing-settings select'
  const input = '.receive-framing .serial-framing-settings input'
  for (const [value, expectedInputs] of [
    ['delimiter', 1],
    ['fixed', 2],
    ['header-footer', 2],
    ['idle', 1],
    ['raw', 0]
  ] as const) {
    await setValue(mode, value)
    await until(`document.querySelectorAll('${input}').length === ${expectedInputs}`)
    await until(
      `JSON.parse(localStorage.getItem('serialflow.serialConfigs')).every(c => c.framing.mode === '${value}')`
    )
    assert.equal(await run('document.querySelectorAll("[aria-label=接收分帧串口]").length'), 0)
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    writeFileSync(
      join(process.cwd(), `.tmp/ui-smoke/receive-framing-${value}.png`),
      (await window.webContents.capturePage()).toPNG()
    )
  }
  await setValue(mode, 'fixed')
  await until(`Boolean(document.querySelector('${input}'))`)
  await setValue('[aria-label="分帧测试 A每帧字节数"]', '8', true)
  await setValue('[aria-label="分帧测试 B每帧字节数"]', '12', true)
  await until(
    "JSON.parse(localStorage.getItem('serialflow.serialConfigs'))[1].framing.fixedLength === 12"
  )
  await setValue(mode, 'idle')
  await until(`Boolean(document.querySelector('${input}'))`)
  await setValue(input, '33', true)
  await until(
    "document.querySelector('.receive-framing summary').textContent.includes('空闲 33 ms')"
  )
  await until(
    "JSON.parse(localStorage.getItem('serialflow.serialConfigs')).every(c => c.framing.idleTimeout === 33)"
  )
  await run('document.querySelector("[title=添加串口配置]").click()')
  await until("JSON.parse(localStorage.getItem('serialflow.serialConfigs')).length === 3")
  assert.equal(
    await run(
      "JSON.parse(localStorage.getItem('serialflow.serialConfigs')).every(c => c.framing.mode === 'idle' && c.framing.idleTimeout === 33)"
    ),
    true
  )
  window.webContents.reload()
  await until('Boolean(document.querySelector(".receive-framing"))')
  await run('document.querySelector(".receive-framing summary").click()')
  assert.equal(await run(`document.querySelector('${mode}').value`), 'idle')
  assert.equal(await run(`document.querySelector('${input}').value`), '33')
  await setValue(mode, 'fixed')
  await until(`document.querySelectorAll('${input}').length === 3`)
  assert.deepEqual(
    await run(`Array.from(document.querySelectorAll('${input}')).map(el => el.value)`),
    ['8', '12', '8']
  )
  await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  assert.equal(
    await run(`(() => {
      const receiver = document.querySelector('.receiver').getBoundingClientRect();
      const framing = document.querySelector('.receive-framing').getBoundingClientRect();
      return framing.bottom <= receiver.bottom && framing.height <= receiver.height * 0.46;
    })()`),
    true,
    'Expanded framing must fit the receive area and leave room for received data'
  )
  writeFileSync(
    join(process.cwd(), '.tmp/ui-smoke/receive-framing.png'),
    (await window.webContents.capturePage()).toPNG()
  )
  await run('document.querySelector(".receive-framing summary").click()')
  assert.equal(await run('document.querySelector(".receive-framing").open'), false)
  console.log(
    'Receive framing: global modes, independent lengths, new ports, reload and disclosure passed'
  )
}
