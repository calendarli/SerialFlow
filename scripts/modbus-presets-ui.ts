import { ipcMain, type BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendCrc } from '../src/renderer/src/serial-utils'

export async function checkModbusPresets(window: BrowserWindow): Promise<void> {
  const run = (source: string): Promise<unknown> => window.webContents.executeJavaScript(source)
  const until = async (source: string): Promise<void> => {
    const deadline = Date.now() + 8000
    while (!(await run(source))) {
      if (Date.now() > deadline) throw new Error(`Modbus UI timeout: ${source}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  const scope =
    "(document.querySelector('.modbus-config-manager') || document.querySelector('.modbus-presets-shortcuts'))"
  const click = async (text: string): Promise<void> => {
    await run(
      `Array.from(${scope}.querySelectorAll('button')).find(b => b.textContent === ${JSON.stringify(text)}).click()`
    )
  }
  const input = async (label: string, value: string): Promise<void> => {
    await run(
      `(() => { const input = ${scope}.querySelector('[aria-label="${label}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`
    )
  }
  const context = async (selector: string): Promise<void> => {
    await run(
      `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 140, clientY: 240 }))`
    )
  }
  await run(`document.querySelector('[aria-label="Modbus RTU"]').click()`)
  await until(`Boolean(document.querySelector('.modbus-presets'))`)
  const handle = '[aria-label="调整快捷指令栏宽度"]'
  await run(
    `document.querySelector('${handle}').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))`
  )
  await until(`document.querySelector('${handle}').getAttribute('aria-valuenow') === '220'`)
  await run(
    `document.querySelector('${handle}').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))`
  )
  await until(
    `document.querySelector('${handle}').getAttribute('aria-valuenow') === document.querySelector('${handle}').getAttribute('aria-valuemax')`
  )
  await run(
    `document.querySelector('${handle}').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
  )
  await until(`document.querySelector('${handle}').getAttribute('aria-valuenow') === '310'`)
  const grip = (await run(
    `(() => { const rect = document.querySelector('${handle}').getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + 80) }; })()`
  )) as { x: number; y: number }
  window.webContents.sendInputEvent({ type: 'mouseDown', ...grip, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseMove', x: grip.x + 100, y: grip.y })
  await until(`document.querySelector('${handle}').getAttribute('aria-valuenow') === '410'`)
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    x: grip.x + 100,
    y: grip.y,
    button: 'left',
    clickCount: 1
  })
  window.webContents.sendInputEvent({ type: 'mouseMove', x: grip.x + 150, y: grip.y })
  assert.equal(
    await run(`document.querySelector('.modbus-presets-shortcuts').getBoundingClientRect().width`),
    410
  )
  assert.equal(
    await run(`(() => {
    const sidebar = document.querySelector('.modbus-presets').getBoundingClientRect();
    const toolbar = document.querySelector('.modbus-toolbar').getBoundingClientRect();
    return sidebar.right <= toolbar.left && Math.abs(sidebar.top - toolbar.top) < 2;
  })()`),
    true,
    'Quick commands must occupy a separate left column'
  )
  await context('.modbus-presets-shortcuts')
  await click('添加指令')
  await input('指令名称', '空白处指令')
  await click('保存指令')
  assert.equal(
    await run("document.querySelector('.modbus-command-group header strong').textContent"),
    '未分组'
  )
  await context('.modbus-presets-shortcuts .modbus-command-group')
  await click('删除分组')
  await context('.modbus-presets-shortcuts')
  await click('添加分组')
  await input('分组名称', '状态控制')
  assert.equal(
    await run(`(() => {
    const buttons = [...document.querySelectorAll('[aria-label="分组编辑"] footer button')];
    return buttons.every(button => getComputedStyle(button).whiteSpace === 'nowrap' && button.getBoundingClientRect().width >= 72) && Math.abs(buttons[0].getBoundingClientRect().top - buttons[1].getBoundingClientRect().top) < 2;
  })()`),
    true,
    'Dialog actions must not shrink or wrap'
  )
  await new Promise((resolve) => setTimeout(resolve, 150))
  writeFileSync(
    join(process.cwd(), '.tmp/ui-smoke/modbus-group-dialog.png'),
    (await window.webContents.capturePage()).toPNG()
  )
  await click('保存分组')
  await context('.modbus-presets-shortcuts .modbus-command-group')
  await click('重命名分组')
  await input('分组名称', '运动控制')
  await click('保存分组')
  await context('.modbus-presets-shortcuts .modbus-command-group')
  await click('添加指令')
  await input('指令名称', '使能')
  await input('指令地址', '10')
  await input('指令数据', '1')
  await click('保存指令')
  await context('.modbus-command-trigger')
  await click('编辑指令')
  await input('指令数据', '2')
  await click('保存指令')
  await context('.modbus-presets-shortcuts .modbus-command-group')
  await click('添加指令')
  await input('指令名称', '临时指令')
  await click('保存指令')
  await context('.modbus-presets-shortcuts .modbus-command-row:last-child')
  await click('删除指令')
  assert.equal(await run("document.querySelectorAll('.modbus-command-trigger').length"), 1)
  await run(
    "Array.from(document.querySelectorAll('.modbus-menubar button')).find(b => b.textContent === '配置管理器').click()"
  )
  await context('.modbus-config-list-pane')
  await click('新增配置')
  await input('配置名称', '电机 A')
  assert.equal(
    await run(`(() => {
    const list = document.querySelector('.modbus-config-list-pane').getBoundingClientRect();
    const detail = document.querySelector('.modbus-presets-config .modbus-preset-detail').getBoundingClientRect();
    return list.right <= detail.left && Math.abs(list.top - detail.top) < 2;
  })()`),
    true,
    'Configuration list and editor must be side by side'
  )
  assert.equal(
    await run(
      `Array.from(document.querySelectorAll('.modbus-presets-config button')).some(b => b.textContent === '添加分组' || b.textContent === '新增配置')`
    ),
    false,
    'Management actions belong in the context menu'
  )
  await click('添加写入项')
  await input('指令名称', '启动')
  await input('指令地址', '0x100')
  await input('指令数据', '42')
  await click('保存指令')
  await until(`${scope}.querySelectorAll('.modbus-command-row').length === 1`)
  await click('添加写入项')
  await input('指令名称', '转速')
  await input('指令地址', '257')
  await input('指令数据', '123')
  await click('保存指令')
  await until(`${scope}.querySelectorAll('.modbus-command-row').length === 2`)
  await run(
    `(() => { const rows = ${scope}.querySelectorAll('.modbus-command-row'); const dataTransfer = new DataTransfer(); rows[1].querySelector('[draggable]').dispatchEvent(new DragEvent('dragstart', {bubbles:true, dataTransfer})); })()`
  )
  await run(
    `${scope}.querySelector('.modbus-command-row').dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:new DataTransfer()}))`
  )
  assert.equal(
    await run(`${scope}.querySelector('.modbus-command-row strong').textContent`),
    '转速'
  )
  await context('.modbus-config-list-pane')
  await click('新增配置')
  await input('配置名称', '临时配置')
  await context('[aria-label="设备配置列表"] tbody tr:last-child')
  await click('删除配置')
  assert.equal(
    await run(`document.querySelectorAll('[aria-label="设备配置列表"] tbody tr').length`),
    1
  )
  await context('[aria-label="设备配置列表"] tbody tr:first-child')
  await click('复制配置')
  assert.equal(
    await run(`document.querySelectorAll('[aria-label="设备配置列表"] tbody tr').length`),
    2
  )
  await click('电机 A')
  assert.equal(await run(`document.querySelector('[aria-label="配置名称"]').value`), '电机 A')
  await click('电机 A 副本')
  assert.equal(await run(`document.querySelector('[aria-label="配置名称"]').value`), '电机 A 副本')
  window.webContents.reload()
  await until(`Boolean(document.querySelector('[aria-label="Modbus RTU"]'))`)
  await run(`document.querySelector('[aria-label="Modbus RTU"]').click()`)
  await until("document.querySelectorAll('.modbus-command-trigger').length === 1")
  assert.equal(
    await run(`document.querySelector('.modbus-presets-shortcuts').getBoundingClientRect().width`),
    410,
    'Dragged width must survive reload'
  )
  await run(
    "Array.from(document.querySelectorAll('.modbus-menubar button')).find(b => b.textContent === '配置管理器').click()"
  )
  await until(`${scope}.querySelectorAll('.modbus-command-row').length === 2`)
  assert.equal(
    await run(`document.querySelectorAll('[aria-label="设备配置列表"] tbody tr').length`),
    2
  )
  const sent: number[][] = []
  ipcMain.removeHandler('serial:write')
  ipcMain.handle('serial:write', (_event, port: string, base64: string) => {
    const request = new Uint8Array(Buffer.from(base64, 'base64'))
    sent.push([...request])
    setTimeout(
      () =>
        window.webContents.send('serial:data', {
          path: port,
          chunks: [appendCrc(request.slice(0, 6), 'modbus')]
        }),
      30
    )
  })
  window.webContents.send('serial:status', { path: 'COM991', open: true })
  await until(
    `!Array.from(document.querySelectorAll('.modbus-presets button')).find(b => b.textContent.startsWith('应用并写入')).disabled`
  )
  await click('应用并写入配置（2）')
  await until(`document.querySelector('.modbus-status').textContent.includes('写入完成 2/2')`)
  assert.deepEqual(
    sent.map((frame) => (frame[2] << 8) | frame[3]),
    [257, 256]
  )
  await new Promise((resolve) => setTimeout(resolve, 150))
  writeFileSync(
    join(process.cwd(), '.tmp/ui-smoke/modbus-config-manager.png'),
    (await window.webContents.capturePage()).toPNG()
  )
  await run(`document.querySelector('[aria-label="关闭配置管理器"]').click()`)
  await until("!document.querySelector('.modbus-command-trigger').disabled")
  await click('使能')
  await until("document.querySelector('.modbus-status').textContent.includes('写入完成 1/1')")
  assert.deepEqual(
    sent.map((frame) => (frame[2] << 8) | frame[3]),
    [257, 256, 10]
  )
  assert.equal(sent[2][5], 2, 'Quick command edits must be saved independently of device presets')
  window.webContents.send('serial:status', { path: 'COM991', open: false })
  await until(`document.querySelector('.modbus-command-trigger').disabled`)
  await context('.modbus-command-trigger')
  await new Promise((resolve) => setTimeout(resolve, 150))
  writeFileSync(
    join(process.cwd(), '.tmp/ui-smoke/modbus-shortcut-menu.png'),
    (await window.webContents.capturePage()).toPNG()
  )
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await until(`!document.querySelector('.modbus-shortcut-menu')`)
  await new Promise((resolve) => setTimeout(resolve, 150))
  console.log(
    'Modbus presets: edit, reorder, copy, reload, acknowledged batch writes and disconnected controls passed'
  )
}
