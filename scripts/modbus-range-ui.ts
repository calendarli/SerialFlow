import { ipcMain, type BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendCrc } from '../src/renderer/src/serial-utils'

// Runs in the isolated serial UI suite with simulated Modbus hardware.
export async function checkModbusRange(window: BrowserWindow): Promise<void> {
  const run = (source: string): Promise<unknown> => window.webContents.executeJavaScript(source)
  const until = async (source: string): Promise<void> => {
    const deadline = Date.now() + 8000
    while (!(await run(source))) {
      if (Date.now() > deadline) throw new Error(`Modbus range UI timeout: ${source}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  const click = async (scope: string, text: string): Promise<void> => {
    await run(
      `Array.from(document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`
    )
  }
  const input = async (selector: string, value: string): Promise<void> => {
    await run(
      `(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`
    )
  }
  const context = async (selector: string): Promise<void> => {
    await run(
      `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: innerWidth - 10, clientY: innerHeight - 10 }))`
    )
  }
  const menu = async (root: string, action: string): Promise<void> => {
    await click('.modbus-menubar', root)
    await click('.modbus-menu-popover', action)
  }
  const apply = async (start: string, count: string): Promise<void> => {
    await input('[aria-label="起始地址"]', start)
    await input('[aria-label="寄存器数量"]', count)
    await click('.modbus-range', '应用范围')
  }
  const cell = (address: number): string => `.modbus-value[data-address="${address}"]`
  const text = (selector: string): string =>
    `document.querySelector(${JSON.stringify(selector)}).textContent.trim()`
  const sent: number[][] = []
  const registers = new Map([
    [259, 100],
    [260, 2],
    [261, 3]
  ])
  let holdResponse = false
  let releaseResponse: (() => void) | undefined
  ipcMain.removeHandler('serial:write')
  ipcMain.handle('serial:write', (_event, port: string, base64: string) => {
    const request = new Uint8Array(Buffer.from(base64, 'base64'))
    sent.push([...request])
    const address = (request[2] << 8) | request[3]
    const count = (request[4] << 8) | request[5]
    if (request[1] === 6) registers.set(address, count)
    if (request[1] === 16)
      for (let offset = 0; offset < count; offset++)
        registers.set(address + offset, (request[7 + offset * 2] << 8) | request[8 + offset * 2])
    const body =
      request[1] === 3
        ? Uint8Array.from([
            request[0],
            3,
            count * 2,
            ...Array.from(
              { length: count },
              (_, offset) => registers.get(address + offset) || 0
            ).flatMap((value) => [value >> 8, value & 255])
          ])
        : request.slice(0, 6)
    const respond = (): void =>
      window.webContents.send('serial:data', { path: port, chunks: [appendCrc(body, 'modbus')] })
    if (holdResponse) releaseResponse = respond
    else setTimeout(respond, 10)
  })
  window.webContents.send('serial:status', { path: 'COM991', open: true })
  await until("document.querySelector('.modbus-title').textContent.includes('COM991')")
  await apply('0x103', '3')
  assert.equal(await run("document.querySelectorAll('.modbus-value').length"), 3)
  assert.equal(
    await run("document.querySelector('.modbus-register-table thead strong').textContent.trim()"),
    '00259'
  )
  await menu('操作', '读取一次')
  await until(`${text(cell(259))} === '100'`)
  assert.deepEqual(sent.at(-1)!.slice(0, 6), [1, 3, 1, 3, 0, 3])
  await run(
    `document.querySelector(${JSON.stringify(cell(259))}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
  )
  await input('.modbus-dialog input', '321')
  await click('.modbus-dialog', '发送')
  await until(`${text(cell(259))} === '321'`)
  assert.deepEqual(sent.at(-1)!.slice(0, 6), [1, 6, 1, 3, 1, 65])

  const beforeCreation = sent.length
  await context('.modbus-register-table thead strong')
  await run("document.querySelector('.modbus-submenu-root > button').click()")
  await until("Boolean(document.querySelector('.modbus-register-submenu'))")
  assert.equal(
    await run(
      `(() => { const r = document.querySelector('.modbus-register-submenu').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`
    ),
    true
  )
  writeFileSync(
    join(process.cwd(), '.tmp/ui-smoke/modbus-register-submenu.png'),
    (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()
  )
  await click('.modbus-register-submenu', '使用当前值…')
  await until("Boolean(document.querySelector('[aria-label=快捷指令编辑]'))")
  assert.equal(await run("document.querySelector('[aria-label=指令地址]').value"), '0x103')
  assert.equal(await run("document.querySelector('[aria-label=指令数据]').value"), '321')
  await input('[aria-label=指令名称]', '高地址快捷指令')
  await run(
    `(() => { const select = document.querySelector('[aria-label=指令分组]'); select.value = Array.from(select.options).find(o => o.textContent === '运动控制').value; select.dispatchEvent(new Event('change', { bubbles: true })); })()`
  )
  await click('[aria-label=快捷指令编辑]', '保存指令')
  assert.equal(sent.length, beforeCreation, 'Creating a shortcut must not send a device write')
  assert.equal(
    await run(
      "JSON.parse(localStorage.getItem('serialflow.modbus.shortcuts.v1'))[0].groups.find(g => g.name === '运动控制').commands.some(c => c.address === '0x103' && c.value === '321')"
    ),
    true
  )

  await context(cell(261))
  await run("document.querySelector('.modbus-submenu-root > button').click()")
  await click('.modbus-register-submenu', '自定义数值…')
  await until("Boolean(document.querySelector('[aria-label=快捷指令编辑]'))")
  assert.equal(await run("document.querySelector('[aria-label=指令地址]').value"), '0x105')
  assert.equal(await run("document.querySelector('[aria-label=指令数据]').value"), '')
  await click('[aria-label=快捷指令编辑]', '取消')

  // A definition at an absolute address governs both words, including the trailing cell.
  await context(cell(259))
  await click('[aria-label=寄存器操作]', '新增寄存器')
  await input('.modbus-dialog input', '高地址位置')
  await run(
    "(() => { const select = document.querySelector('.modbus-dialog select'); select.value = 'uint32'; select.dispatchEvent(new Event('change', { bubbles: true })); })()"
  )
  await click('.modbus-dialog', '保存')
  await run(
    `document.querySelector(${JSON.stringify(cell(259))}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
  )
  await input('.modbus-dialog input', '305419896')
  await click('.modbus-dialog', '发送')
  await until(`${text(cell(259))} === '305419896'`)
  assert.deepEqual(sent.at(-1)!.slice(0, -2), [1, 16, 1, 3, 0, 2, 4, 0x56, 0x78, 0x12, 0x34])
  await context(cell(260))
  assert.equal(await run("document.querySelector('.modbus-submenu-root > button').disabled"), true)
  await run("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
  await context(cell(259))
  await run("document.querySelector('.modbus-submenu-root > button').click()")
  await click('.modbus-register-submenu', '使用当前值…')
  assert.equal(await run("document.querySelector('[aria-label=指令数据类型]').value"), 'uint32')
  assert.equal(await run("document.querySelector('[aria-label=指令数据]').value"), '305419896')
  await click('[aria-label=快捷指令编辑]', '取消')

  // Capture and replay use absolute addresses for nonzero windows.
  await run("document.querySelector('#modbus-tab-config').click()")
  await context('.modbus-config-list-pane')
  await click('.modbus-presets-config', '保存配置')
  assert.deepEqual(
    await run(
      "JSON.parse(localStorage.getItem('serialflow.modbus.presets.v1')).at(-1).groups[0].commands.map(c => c.address)"
    ),
    ['259', '261']
  )
  await click('.modbus-presets-config', '应用并写入配置（2）')
  await until("document.querySelector('.modbus-status').textContent.includes('写入完成 2/2')")
  assert.deepEqual(sent.at(-1)!.slice(2, 4), [1, 5])

  let exported: unknown
  ipcMain.removeHandler('modbus:saveMap')
  ipcMain.handle('modbus:saveMap', (_event, config: unknown) => {
    exported = config
    return 'custom-range.json'
  })
  await menu('配置', '导出配置…')
  await until("document.querySelector('.modbus-title').textContent.includes('custom-range.json')")
  assert.equal((exported as { startAddress: number }).startAddress, 259)
  assert.equal((exported as { registerCount: number }).registerCount, 3)
  await apply('259', '1')
  assert.equal(await run(text(cell(259))), '--', 'Range changes clear live values')
  await run(
    `document.querySelector(${JSON.stringify(cell(259))}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
  )
  assert.equal(
    await run("Boolean(document.querySelector('.modbus-dialog'))"),
    false,
    'A partial 32-bit register must not be written'
  )
  await apply('65535', '2')
  assert.equal(
    await run("document.querySelector('.modbus-range [role=alert]').textContent.includes('65535')"),
    true
  )
  assert.equal(await run("document.querySelector('.modbus-value').dataset.address"), '259')
  await apply('0xFFFF', '1')
  await menu('操作', '读取一次')
  await until(`${text(cell(65535))} === '0'`)
  assert.deepEqual(sent.at(-1)!.slice(2, 6), [255, 255, 0, 1])
  await apply('259', '11')
  assert.equal(await run("document.querySelectorAll('.modbus-value').length"), 11)
  assert.equal(
    await run('document.querySelectorAll(\'.modbus-value[data-address="270"]\').length'),
    0
  )
  await apply('0', '125')
  await menu('操作', '读取一次')
  await until(`${text(cell(0))} === '0'`)
  assert.deepEqual(sent.at(-1)!.slice(2, 6), [0, 0, 0, 125])
  holdResponse = true
  await menu('操作', '读取一次')
  await until(
    "document.querySelector('.modbus-status').textContent.includes('Waiting for response')"
  )
  await apply('0x103', '3')
  assert.equal(
    await run("document.querySelector('.modbus-range [role=alert]').textContent.includes('等待')"),
    true
  )
  assert.equal(await run("document.querySelector('.modbus-value').dataset.address"), '0')
  holdResponse = false
  assert.ok(releaseResponse)
  releaseResponse()
  await until("document.querySelector('.modbus-status').textContent.includes('Connected')")

  let importData = {
    name: 'custom-range.json',
    base64: Buffer.from(JSON.stringify(exported)).toString('base64')
  }
  ipcMain.removeHandler('modbus:openMap')
  ipcMain.handle('modbus:openMap', () => importData)
  await menu('配置', '导入配置…')
  await until("document.querySelectorAll('.modbus-value').length === 3")
  assert.equal(await run("document.querySelector('.modbus-value').dataset.address"), '259')
  assert.equal(
    await run(
      "document.querySelector('.modbus-register-table').textContent.includes('高地址位置')"
    ),
    true
  )
  assert.equal(await run(text(cell(259))), '--')
  await menu('操作', '读取一次')
  await until(`${text(cell(259))} === '305419896'`)
  writeFileSync(
    join(process.cwd(), '.tmp/ui-smoke/modbus-custom-range.png'),
    (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()
  )
  window.webContents.reload()
  await until('Boolean(document.querySelector(\'[aria-label="Modbus RTU"]\'))')
  await run('document.querySelector(\'[aria-label="Modbus RTU"]\').click()')
  await until("Boolean(document.querySelector('.modbus-range'))")
  assert.equal(await run("document.querySelector('[aria-label=起始地址]').value"), '259')
  assert.equal(await run("document.querySelector('[aria-label=寄存器数量]').value"), '3')
  assert.equal(await run(text(cell(259))), '--')

  importData = {
    name: 'legacy.json',
    base64: Buffer.from(
      JSON.stringify({
        format: 'serialflow-modbus-map',
        version: 1,
        registers: [{ address: 12, alias: '旧格式兼容', format: 'uint16' }]
      })
    ).toString('base64')
  }
  await menu('配置', '导入配置…')
  await until("document.querySelectorAll('.modbus-value').length === 50")
  assert.equal(await run("document.querySelector('[aria-label=起始地址]').value"), '0')
  assert.equal(
    await run(
      "document.querySelector('.modbus-register-table').textContent.includes('旧格式兼容')"
    ),
    true
  )
  const beforeInvalid = await run("localStorage.getItem('serialflow.modbus.workspace.v2')")
  importData = {
    name: 'invalid.json',
    base64: Buffer.from(
      JSON.stringify({
        format: 'serialflow-modbus-map',
        version: 1,
        startAddress: 65535,
        registerCount: 2,
        registers: []
      })
    ).toString('base64')
  }
  await menu('配置', '导入配置…')
  await until("document.querySelector('.modbus-status').textContent.includes('65535')")
  assert.equal(await run("localStorage.getItem('serialflow.modbus.workspace.v2')"), beforeInvalid)
  await apply('0x103', '3')
  importData = {
    name: 'legacy.mbp',
    base64: Buffer.from(
      'AliasMicrosoft YaHei UIMBP 兼容别名\0Microsoft YaHei UI\0',
      'utf16le'
    ).toString('base64')
  }
  await menu('配置', '导入配置…')
  await until("document.querySelectorAll('.modbus-value').length === 50")
  assert.equal(await run("document.querySelector('[aria-label=起始地址]').value"), '0')
  assert.equal(
    await run(
      "document.querySelector('.modbus-register-table').textContent.includes('MBP 兼容别名')"
    ),
    true
  )
  console.log(
    'Modbus range: address 0x103, H03/H06/H10, shortcuts, range boundaries, persistence, JSON and MBP compatibility passed'
  )
}
