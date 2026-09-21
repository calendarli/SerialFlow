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
  const scope = "document.querySelector('.modbus-sidebar-panel:not([hidden])')"
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
  await run(
    `localStorage.setItem('serialflow.modbus.sidebarWidth', '220'); document.querySelector('[aria-label="Modbus RTU"]').click()`
  )
  await until(`Boolean(document.querySelector('.modbus-presets'))`)
  assert.equal(
    await run(
      "Boolean(document.querySelector('.modbus-menubar button')?.textContent.includes('配置管理器'))"
    ),
    false
  )
  await run(
    "document.querySelector('[aria-label=\"Modbus 二级导航\"]').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true}))"
  )
  assert.equal(
    await run("document.querySelector('#modbus-tab-config').getAttribute('aria-selected')"),
    'true'
  )
  assert.equal(await run("document.querySelector('#modbus-panel-shortcuts').hidden"), true)
  assert.equal(await run("Boolean(document.querySelector('[role=dialog]'))"), false)
  await run(
    "document.querySelector('[aria-label=\"Modbus 二级导航\"]').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowLeft',bubbles:true}))"
  )
  const handle = '[aria-label="调整快捷指令栏宽度"]'
  assert.equal(
    await run(`document.querySelector('.modbus-sidebar').getBoundingClientRect().width`),
    330,
    'Previously saved narrow widths must be raised to the shared tab minimum'
  )
  await run(
    `document.querySelector('${handle}').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))`
  )
  await until(`document.querySelector('${handle}').getAttribute('aria-valuenow') === '330'`)
  await run(
    `document.querySelector('${handle}').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))`
  )
  await until(
    `document.querySelector('${handle}').getAttribute('aria-valuenow') === document.querySelector('${handle}').getAttribute('aria-valuemax')`
  )
  await run(
    `document.querySelector('${handle}').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
  )
  await until(`document.querySelector('${handle}').getAttribute('aria-valuenow') === '330'`)
  const grip = (await run(
    `(() => { const rect = document.querySelector('${handle}').getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + 80) }; })()`
  )) as { x: number; y: number }
  window.webContents.sendInputEvent({ type: 'mouseDown', ...grip, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseMove', x: grip.x + 100, y: grip.y })
  await until(`document.querySelector('${handle}').getAttribute('aria-valuenow') === '430'`)
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    x: grip.x + 100,
    y: grip.y,
    button: 'left',
    clickCount: 1
  })
  window.webContents.sendInputEvent({ type: 'mouseMove', x: grip.x + 150, y: grip.y })
  assert.equal(
    await run(`document.querySelector('.modbus-sidebar').getBoundingClientRect().width`),
    430
  )
  assert.equal(
    await run(`(() => {
    const sidebar = document.querySelector('.modbus-sidebar').getBoundingClientRect();
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
  const openManager = async (): Promise<void> => {
    await run("document.querySelector('#modbus-tab-config').click()")
  }
  await openManager()
  await context('.modbus-config-list-pane')
  assert.equal(
    await run(
      "Array.from(document.querySelectorAll('[role=menu] button')).some(b => ['新增配置', '编辑配置', '复制配置'].includes(b.textContent))"
    ),
    false
  )
  await click('保存配置')
  assert.equal(
    await run("document.querySelectorAll('[aria-label=设备配置列表] tbody tr').length"),
    0
  )
  assert.equal(
    await run(
      "document.querySelector('.modbus-presets-config').textContent.includes('暂无有效寄存器数据')"
    ),
    true
  )
  assert.equal(await run("Boolean(document.querySelector('[aria-label=配置编辑]'))"), false)
  await run("document.querySelector('#modbus-tab-shortcuts').click()")
  const originalWords = Array.from({ length: 50 }, () => 0)
  originalWords[0] = 42
  originalWords[1] = 0x5678
  originalWords[2] = 0x1234
  originalWords[3] = 0
  originalWords[4] = 0x3fc0
  const sent: number[][] = []
  ipcMain.removeHandler('serial:write')
  ipcMain.handle('serial:write', (_event, port: string, base64: string) => {
    const request = new Uint8Array(Buffer.from(base64, 'base64'))
    sent.push([...request])
    const body =
      request[1] === 3
        ? new Uint8Array([
            request[0],
            3,
            100,
            ...originalWords.flatMap((word) => [word >> 8, word & 255])
          ])
        : request.slice(0, 6)
    setTimeout(
      () =>
        window.webContents.send('serial:data', { path: port, chunks: [appendCrc(body, 'modbus')] }),
      10
    )
  })
  window.webContents.send('serial:status', { path: 'COM991', open: true })
  await until("document.querySelector('.modbus-title').textContent.includes('COM991')")
  await run(
    "document.querySelector('.modbus-value').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))"
  )
  await run(
    `(() => { const input = document.querySelector('.modbus-dialog input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '42'); input.dispatchEvent(new Event('input', {bubbles:true})); })()`
  )
  await run(
    "Array.from(document.querySelectorAll('.modbus-dialog button')).find(b => b.textContent === '发送').click()"
  )
  await until("document.querySelector('.modbus-status').textContent.includes('written')")
  await openManager()
  await context('.modbus-config-list-pane')
  await click('保存配置')
  assert.deepEqual(
    await run(
      "JSON.parse(localStorage.getItem('serialflow.modbus.presets.v1'))[0].groups[0].commands.map(c => [c.address, c.value])"
    ),
    [['0', '42']],
    'Confirmed manual writes must be captured without filling unread registers'
  )
  await context('[aria-label=设备配置列表] tbody tr:first-child')
  await click('删除配置')
  await run("document.querySelector('#modbus-tab-shortcuts').click()")
  await run(
    "Array.from(document.querySelectorAll('.modbus-menubar button')).find(b => b.textContent === '操作').click()"
  )
  await run(
    "Array.from(document.querySelectorAll('.modbus-menu-popover button')).find(b => b.textContent === '读取一次').click()"
  )
  await until("document.querySelector('.modbus-status').textContent.includes('Connected')")
  await openManager()
  await context('.modbus-config-list-pane')
  await click('保存配置')
  await until("document.querySelectorAll('[aria-label=设备配置列表] tbody tr').length === 1")
  const saved = (await run(
    "JSON.parse(localStorage.getItem('serialflow.modbus.presets.v1'))[0]"
  )) as {
    name: string
    slave: number
    wordOrder: string
    groups: Array<{ commands: Array<{ address: string; value: string; format: string }> }>
  }
  assert.equal(saved.slave, 1)
  assert.equal(saved.wordOrder, 'cdab')
  assert.deepEqual(
    saved.groups[0].commands
      .slice(0, 3)
      .map(({ address, value, format }) => ({ address, value, format })),
    [
      { address: '0', value: '42', format: 'hex16' },
      { address: '1', value: '305419896', format: 'int32' },
      { address: '3', value: '1.5', format: 'float32' }
    ]
  )
  await context('.modbus-config-list-pane')
  await click('保存配置')
  await until("document.querySelectorAll('[aria-label=设备配置列表] tbody tr').length === 2")
  await run("document.querySelector('#modbus-tab-shortcuts').click()")
  assert.equal(
    await run(
      "document.querySelectorAll('#modbus-panel-shortcuts .modbus-command-trigger').length"
    ),
    1
  )
  await openManager()
  assert.equal(
    await run(
      "document.querySelector('[aria-label=设备配置列表] tbody tr:last-child').classList.contains('selected')"
    ),
    true,
    'Switching tabs must retain the selected configuration'
  )
  await run("document.querySelector('#modbus-tab-shortcuts').click()")
  await run("document.querySelector('.modbus-group-toggle').click()")
  assert.equal(
    await run("document.querySelector('.modbus-group-toggle').getAttribute('aria-expanded')"),
    'false'
  )
  assert.equal(await run("document.querySelectorAll('.modbus-command-trigger').length"), 0)
  await openManager()
  await run("document.querySelector('[aria-label=收起侧栏]').click()")
  assert.equal(
    await run("getComputedStyle(document.querySelector('.modbus-sidebar')).display"),
    'none'
  )
  await run("document.querySelector('[aria-label=展开侧栏]').click()")
  assert.equal(
    await run("document.querySelector('#modbus-tab-config').getAttribute('aria-selected')"),
    'true'
  )
  assert.equal(
    await run("document.querySelector('.modbus-sidebar').getBoundingClientRect().width"),
    430
  )
  await run("document.querySelector('#modbus-tab-shortcuts').click()")
  assert.equal(
    await run("document.querySelector('.modbus-group-toggle').getAttribute('aria-expanded')"),
    'false'
  )
  await run("document.querySelector('.modbus-group-toggle').click()")
  assert.equal(await run("document.querySelectorAll('.modbus-command-trigger').length"), 1)
  await openManager()
  await context('[aria-label=设备配置列表] tbody tr:last-child')
  await click('删除配置')
  assert.equal(
    await run("document.querySelectorAll('[aria-label=设备配置列表] tbody tr').length"),
    1
  )
  await context('.modbus-config-list-pane')
  await click('保存配置')
  for (const cell of [
    'td:nth-child(1)',
    'td:nth-child(2)',
    'td:nth-child(3)',
    'td:nth-child(4)',
    ''
  ]) {
    await run(
      `document.querySelector('[aria-label=设备配置列表] tbody tr:first-child ${cell}').click()`
    )
    assert.equal(
      await run(
        "document.querySelector('[aria-label=设备配置列表] tr.selected button').textContent"
      ),
      saved.name
    )
    await run("document.querySelector('[aria-label=设备配置列表] tbody tr:last-child').click()")
  }
  await context('.modbus-value')
  await run(
    "Array.from(document.querySelectorAll('.modbus-context-menu button')).find(b => b.textContent.includes('编辑')).click()"
  )
  await run(`(() => {
    const input = document.querySelector('.modbus-dialog input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '手动编辑持久化');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await run("document.querySelector('.modbus-dialog button[type=submit]').click()")
  await until(
    "JSON.parse(localStorage.getItem('serialflow.modbus.workspace.v1')).definitions[0].alias === '手动编辑持久化'"
  )
  window.webContents.reload()
  await until('Boolean(document.querySelector(\'[aria-label="Modbus RTU"]\'))')
  await run('document.querySelector(\'[aria-label="Modbus RTU"]\').click()')
  await until("document.querySelectorAll('.modbus-command-trigger').length === 1")
  assert.equal(
    await run(
      "document.querySelector('.modbus-register-table').textContent.includes('手动编辑持久化')"
    ),
    true
  )
  assert.equal(await run("document.querySelector('.modbus-value').textContent.trim()"), '--')
  assert.equal(
    await run("document.querySelector('.modbus-sidebar').getBoundingClientRect().width"),
    430
  )
  await openManager()
  await until("document.querySelectorAll('[aria-label=设备配置列表] tbody tr').length === 2")
  window.webContents.send('serial:status', { path: 'COM991', open: true })
  await until(
    "!Array.from(document.querySelectorAll('.modbus-presets-config button')).find(b => b.textContent.startsWith('应用并写入')).disabled"
  )
  sent.length = 0
  const count = saved.groups[0].commands.length
  await click(`应用并写入配置（${count}）`)
  await until(
    `document.querySelector('.modbus-status').textContent.includes('写入完成 ${count}/${count}')`
  )
  const restored: number[] = []
  for (const request of sent) {
    const address = (request[2] << 8) | request[3]
    if (request[1] === 6) restored[address] = (request[4] << 8) | request[5]
    else {
      restored[address] = (request[7] << 8) | request[8]
      restored[address + 1] = (request[9] << 8) | request[10]
    }
  }
  assert.deepEqual(
    restored,
    originalWords,
    'Saved homepage values must restore the exact original registers'
  )
  await new Promise((resolve) => setTimeout(resolve, 150))
  writeFileSync(
    join(process.cwd(), '.tmp/ui-smoke/modbus-config-manager.png'),
    (await window.webContents.capturePage()).toPNG()
  )
  await run("document.querySelector('#modbus-tab-shortcuts').click()")
  await until("!document.querySelector('.modbus-command-trigger').disabled")
  const sentBeforeNameClick = sent.length
  await run("document.querySelector('.modbus-command-name').click()")
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(sent.length, sentBeforeNameClick, 'Clicking the name must not write registers')
  await click('写入')
  await until("document.querySelector('.modbus-status').textContent.includes('写入完成 1/1')")
  assert.equal(sent.at(-1)![3], 10)
  assert.equal(sent.at(-1)![5], 2)
  window.webContents.send('serial:status', { path: 'COM991', open: false })
  await until("document.querySelector('.modbus-command-trigger').disabled")
  await context('.modbus-command-trigger')
  await new Promise((resolve) => setTimeout(resolve, 150))
  writeFileSync(
    join(process.cwd(), '.tmp/ui-smoke/modbus-shortcut-menu.png'),
    (await window.webContents.capturePage()).toPNG()
  )
  await run("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
  await until("!document.querySelector('.modbus-shortcut-menu')")
  ipcMain.removeHandler('modbus:openMap')
  ipcMain.handle('modbus:openMap', () => ({
    name: 'persisted-import.json',
    base64: Buffer.from(
      JSON.stringify({
        format: 'serialflow-modbus-map',
        version: 1,
        slave: 7,
        wordOrder: 'abcd',
        scanRate: 250,
        registers: [{ address: 12, alias: '外部导入持久化', format: 'uint32' }]
      })
    ).toString('base64')
  }))
  await run(
    "Array.from(document.querySelectorAll('.modbus-menubar button')).find(b => b.textContent === '配置').click()"
  )
  await run(
    "Array.from(document.querySelectorAll('.modbus-menu-popover button')).find(b => b.textContent.includes('导入')).click()"
  )
  await until(
    "document.querySelector('.modbus-register-table').textContent.includes('外部导入持久化')"
  )
  await until(
    "JSON.parse(localStorage.getItem('serialflow.modbus.workspace.v1')).mapName === 'persisted-import.json'"
  )
  window.webContents.reload()
  await until('Boolean(document.querySelector(\'[aria-label="Modbus RTU"]\'))')
  await run('document.querySelector(\'[aria-label="Modbus RTU"]\').click()')
  await until(
    "document.querySelector('.modbus-register-table')?.textContent.includes('外部导入持久化')"
  )
  const workspace = (await run(
    "JSON.parse(localStorage.getItem('serialflow.modbus.workspace.v1'))"
  )) as {
    definitions: unknown
    values?: unknown[]
  }
  assert.deepEqual(workspace.definitions, {
    12: { alias: '外部导入持久化', format: 'uint32', words: 2 }
  })
  assert.equal(workspace.values, undefined, 'Live values must not be persisted')
  await new Promise((resolve) => setTimeout(resolve, 150))
  console.log(
    'Modbus: homepage capture, exact register restoration, list selection, persistence and quick controls passed'
  )
}
