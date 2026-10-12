import { ipcMain, type BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendCrc } from '../src/renderer/src/serial-utils'

export async function checkModbusTables(window: BrowserWindow): Promise<void> {
  const run = (source: string): Promise<unknown> => window.webContents.executeJavaScript(source)
  const until = async (source: string): Promise<void> => {
    const deadline = Date.now() + 8000
    while (!(await run(source))) {
      if (Date.now() > deadline) throw new Error(`Multi-table UI timeout: ${source}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const click = async (scope: string, label: string): Promise<void> => {
    await run(
      `Array.from(document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`
    )
  }
  const input = async (label: string, value: string): Promise<void> => {
    await run(
      `(() => { const input = document.querySelector('[aria-label="${label}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`
    )
  }
  const menu = async (category: string, label: string): Promise<void> => {
    await click('.modbus-menubar', category)
    await click('.modbus-menu-popover', label)
  }
  const select = async (index: number): Promise<void> => {
    await run(`document.querySelectorAll('[aria-label=寄存器表] [role=tab]')[${index}].click()`)
  }
  const context = async (selector: string): Promise<void> => {
    await run(
      `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 850, clientY: 450 }))`
    )
  }
  const cell = (address: number): string => `.modbus-value[data-address="${address}"]`
  const value = (address: number): string =>
    `document.querySelector(${JSON.stringify(cell(address))})?.textContent.trim()`
  const apply = async (start: string, count: string): Promise<void> => {
    await input('起始地址', start)
    await input('寄存器数量', count)
    await click('.modbus-range', '应用范围')
  }
  const add = async (name: string, start: string, count: string): Promise<void> => {
    await click('.modbus-table-actions', '新增表')
    await input('表名称', name)
    await input('新表起始地址', start)
    await input('新表寄存器数量', count)
    await click('[aria-label=寄存器表设置]', '保存表')
  }
  const sent: number[][] = []
  const memory = new Map([
    [259, 11],
    [260, 12],
    [768, 77],
    [769, 78],
    [770, 79]
  ])
  let holdAddress: number | null = null
  let release: (() => void) | undefined
  const releaseHeld = (): void => {
    const response = release
    assert.ok(response)
    release = undefined
    response()
  }
  let inFlight = false
  let failAddress: number | null = null
  ipcMain.removeHandler('serial:write')
  ipcMain.handle('serial:write', (_event, port: string, base64: string) => {
    assert.equal(inFlight, false, 'RTU table requests must not overlap')
    inFlight = true
    const request = new Uint8Array(Buffer.from(base64, 'base64'))
    sent.push([...request])
    const address = (request[2] << 8) | request[3]
    const count = (request[4] << 8) | request[5]
    if (request[1] === 6) memory.set(address, count)
    const words = Array.from({ length: count }, (_, offset) => memory.get(address + offset) || 0)
    const body =
      request[1] === 3
        ? address === failAddress
          ? Uint8Array.from([request[0], 0x83, 2])
          : Uint8Array.from([
              request[0],
              3,
              count * 2,
              ...words.flatMap((word) => [word >> 8, word & 255])
            ])
        : request.slice(0, 6)
    const response = (): void => {
      inFlight = false
      window.webContents.send('serial:data', { path: port, chunks: [appendCrc(body, 'modbus')] })
    }
    if (address === holdAddress) release = response
    else setTimeout(response, 10)
  })
  window.webContents.send('serial:status', { path: 'COM991', open: true })
  await until("document.querySelector('.modbus-title').textContent.includes('COM991')")
  await apply('0x103', '2')
  await click('.modbus-table-actions', '重命名表')
  await input('表名称', '控制')
  await click('[aria-label=寄存器表设置]', '保存表')
  await add('状态', '0x300', '3')
  assert.equal(await run("document.querySelectorAll('[aria-label=寄存器表] [role=tab]').length"), 2)
  assert.equal(await run("document.querySelector('[aria-label=起始地址]').value"), '768')
  assert.equal(await run(value(768)), '--')

  // A late response belongs to the original table, even after changing tabs.
  holdAddress = 768
  await menu('操作', '读取一次')
  await until(
    "document.querySelector('.modbus-status').textContent.includes('Waiting for response')"
  )
  await select(0)
  assert.equal(await run(value(259)), '--')
  holdAddress = null
  releaseHeld()
  await until("document.querySelector('.modbus-status').textContent.includes('Connected')")
  assert.equal(await run(value(259)), '--')
  await select(1)
  assert.equal(await run(value(768)), '77')
  assert.deepEqual(sent[0].slice(2, 6), [3, 0, 0, 3])

  sent.length = 0
  await menu('操作', '读取所有表')
  await until("document.querySelector('.modbus-status').textContent.includes('Connected')")
  assert.deepEqual(
    sent.map((request) => request.slice(2, 6)),
    [
      [1, 3, 0, 2],
      [3, 0, 0, 3]
    ]
  )
  await select(0)
  assert.equal(await run(value(259)), '11')
  await select(1)
  await context(cell(768))
  await click('[aria-label=寄存器操作]', '新增寄存器')
  await run(
    "(() => { const input = document.querySelector('.modbus-dialog input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '状态字'); input.dispatchEvent(new Event('input', { bubbles: true })); })()"
  )
  await click('.modbus-dialog', '保存')
  await context(cell(768))
  await run("document.querySelector('.modbus-submenu-root > button').click()")
  await click('.modbus-register-submenu', '使用当前值…')
  assert.equal(await run("document.querySelector('[aria-label=指令地址]').value"), '0x300')
  assert.equal(await run("document.querySelector('[aria-label=指令数据]').value"), '77')
  await input('指令数据', '99')
  const beforeSave = sent.length
  await click('[aria-label=快捷指令编辑]', '保存指令')
  assert.equal(sent.length, beforeSave)
  await select(0)
  await run('document.querySelector(\'[aria-label="写入 状态字"]\').click()')
  await until("document.querySelector('.modbus-status').textContent.includes('写入完成 1/1')")
  assert.equal(await run(value(259)), '11')
  await select(1)
  assert.equal(await run(value(768)), '99')
  await apply('0x310', '2')
  await select(0)
  assert.equal(await run(value(259)), '11', 'Changing another table must preserve this table data')
  assert.equal(await run("document.querySelector('[aria-label=寄存器数量]').value"), '2')
  await select(1)
  await apply('0x300', '3')
  await menu('操作', '读取所有表')
  await until("document.querySelector('.modbus-status').textContent.includes('Connected')")

  await run("document.querySelector('#modbus-tab-config').click()")
  await context('.modbus-config-list-pane')
  await click('.modbus-presets-config', '保存配置')
  assert.deepEqual(
    await run(
      "JSON.parse(localStorage.getItem('serialflow.modbus.presets.v1')).at(-1).groups.map(group => [group.name, group.commands.map(command => command.address)])"
    ),
    [
      ['控制', ['259', '260']],
      ['状态', ['768', '769', '770']]
    ]
  )

  const exported: Array<Record<string, unknown>> = []
  ipcMain.removeHandler('modbus:saveMap')
  ipcMain.handle('modbus:saveMap', (_event, config: Record<string, unknown>) => {
    exported.push(config)
    return 'multiple-tables.json'
  })
  await menu('配置', '导出配置…')
  await until("document.querySelector('.modbus-status').textContent.includes('exported')")
  assert.equal(exported[0].version, 2)
  assert.equal((exported[0].tables as unknown[]).length, 2)
  await menu('配置', '导出当前表…')
  assert.equal(exported[1].version, 1)
  assert.equal(exported[1].startAddress, 768)

  // One table failing must not stop other table reads or hide the failed table's error.
  failAddress = 259
  sent.length = 0
  await menu('操作', '读取所有表')
  await until(
    "document.querySelector('.modbus-status').textContent.includes('控制：Modbus exception')"
  )
  assert.equal(sent.length, 2)
  await select(0)
  assert.equal(
    await run(
      "document.querySelector('.modbus-range [role=alert]').textContent.includes('exception')"
    ),
    true
  )
  failAddress = null
  await menu('操作', '读取所有表')
  await until("document.querySelector('.modbus-status').textContent.includes('Connected')")

  // Polling visits every table in order, and switching tabs does not restart it.
  holdAddress = 259
  release = undefined
  sent.length = 0
  await menu('操作', '开始轮询')
  await until(
    "document.querySelector('.modbus-status').textContent.includes('Waiting for response')"
  )
  await select(1)
  holdAddress = null
  releaseHeld()
  await until("document.querySelector('.modbus-status').textContent.includes('Connected')")
  await menu('操作', '停止轮询')
  assert.deepEqual(
    sent.map((request) => request.slice(2, 6)),
    [
      [1, 3, 0, 2],
      [3, 0, 0, 3]
    ]
  )
  holdAddress = 259
  release = undefined
  await menu('操作', '开始轮询')
  await until(
    "document.querySelector('.modbus-status').textContent.includes('Waiting for response')"
  )
  const beforeStop = sent.length
  await menu('操作', '停止轮询')
  holdAddress = null
  releaseHeld()
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(sent.length, beforeStop, 'Stop must prevent remaining table requests')

  await click('.modbus-table-actions', '删除表')
  await click('[aria-label=寄存器表设置]', '删除表')
  assert.equal(await run("document.querySelectorAll('[aria-label=寄存器表] [role=tab]').length"), 1)
  assert.equal(await run(value(259)), '11')
  assert.equal(
    await run(
      "Array.from(document.querySelectorAll('.modbus-table-actions button')).find(b => b.textContent === '删除表').disabled"
    ),
    true
  )
  let imported = JSON.stringify(exported[0])
  ipcMain.removeHandler('modbus:openMap')
  ipcMain.handle('modbus:openMap', () => ({
    name: 'multiple.json',
    base64: Buffer.from(imported).toString('base64')
  }))
  await menu('配置', '导入配置…')
  await until("document.querySelectorAll('[aria-label=寄存器表] [role=tab]').length === 2")
  assert.equal(
    await run(
      "document.querySelector('[aria-label=寄存器表] [aria-selected=true] strong').textContent"
    ),
    '状态'
  )
  assert.equal(await run(value(768)), '--')
  const beforeInvalid = await run("localStorage.getItem('serialflow.modbus.workspace.v2')")
  imported = JSON.stringify({ ...exported[0], tables: [] })
  await menu('配置', '导入配置…')
  await until("document.querySelector('.modbus-status').textContent.includes('不')")
  assert.equal(await run("localStorage.getItem('serialflow.modbus.workspace.v2')"), beforeInvalid)
  // Old single-table imports replace only the selected table.
  imported = JSON.stringify({
    format: 'serialflow-modbus-map',
    version: 1,
    startAddress: 768,
    registerCount: 3,
    registers: [{ address: 768, alias: '旧单表导入', format: 'uint16' }]
  })
  await menu('配置', '导入配置…')
  await until("document.querySelector('.modbus-register-table').textContent.includes('旧单表导入')")
  assert.equal(await run("document.querySelectorAll('[aria-label=寄存器表] [role=tab]').length"), 2)
  await select(0)
  assert.equal(await run("document.querySelector('[aria-label=起始地址]').value"), '259')
  await add('重叠视图', '0x103', '1')
  await menu('操作', '读取一次')
  await until(`${value(259)} === '11'`)
  holdAddress = 259
  release = undefined
  await run(
    `document.querySelector(${JSON.stringify(cell(259))}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
  )
  await run(
    "(() => { const input = document.querySelector('.modbus-dialog input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '55'); input.dispatchEvent(new Event('input', { bubbles: true })); })()"
  )
  await click('.modbus-dialog', '发送')
  await until("document.querySelector('.modbus-status').textContent.includes('Waiting for write')")
  await select(0)
  await run(
    `document.querySelector(${JSON.stringify(cell(259))}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
  )
  holdAddress = null
  releaseHeld()
  await until(`${value(259)} === '55'`)
  assert.equal(
    await run("document.querySelector('.modbus-dialog input')?.value"),
    '11',
    'A different table write confirmation must not close the new dialog'
  )
  await click('.modbus-dialog', '取消')
  assert.equal(await run(value(259)), '55')
  await select(1)
  await menu('操作', '读取所有表')
  await until("document.querySelector('.modbus-status').textContent.includes('Connected')")
  writeFileSync(
    join(process.cwd(), '.tmp/ui-smoke/modbus-multiple-tables.png'),
    (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()
  )
  window.webContents.reload()
  await until('Boolean(document.querySelector(\'[aria-label="Modbus RTU"]\'))')
  await run('document.querySelector(\'[aria-label="Modbus RTU"]\').click()')
  await until("document.querySelectorAll('[aria-label=寄存器表] [role=tab]').length === 3")
  assert.equal(
    await run(
      "document.querySelector('[aria-label=寄存器表] [aria-selected=true] strong').textContent"
    ),
    '状态'
  )
  assert.equal(await run(value(768)), '--')

  // Upgrade the actual legacy storage key, retaining its contents for older versions.
  const legacy = JSON.stringify({
    version: 1,
    mapName: 'legacy-storage.json',
    startAddress: 259,
    registerCount: 2,
    definitions: { 259: { alias: '升级数据', format: 'uint16', words: 1 } }
  })
  await run(
    `localStorage.removeItem('serialflow.modbus.workspace.v2'); localStorage.setItem('serialflow.modbus.workspace.v1', ${JSON.stringify(legacy)})`
  )
  window.webContents.reload()
  await until('Boolean(document.querySelector(\'[aria-label="Modbus RTU"]\'))')
  await run('document.querySelector(\'[aria-label="Modbus RTU"]\').click()')
  await until("document.querySelector('.modbus-register-table')?.textContent.includes('升级数据')")
  assert.equal(await run("document.querySelector('[aria-label=起始地址]').value"), '259')
  assert.equal(await run("localStorage.getItem('serialflow.modbus.workspace.v1')"), legacy)
  assert.equal(
    await run("JSON.parse(localStorage.getItem('serialflow.modbus.workspace.v2')).tables.length"),
    1
  )
  console.log(
    'Modbus tables: independent ranges, pending replies, sequential polling, stop, errors, writes, snapshots, exports, deletion and legacy migration passed'
  )
}
