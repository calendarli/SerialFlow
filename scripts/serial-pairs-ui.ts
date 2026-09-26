import { ipcMain, type BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function checkSerialPairs(window: BrowserWindow): Promise<void> {
  let pairs = ['COM20 ↔ COM21', 'COM30 ↔ COM31', 'COM40 ↔ 等待对端']
  let failure = false
  const removals: string[] = []
  const channels = ['virtualPorts:status', 'virtualPorts:create', 'virtualPorts:remove']
  for (const channel of channels) ipcMain.removeHandler(channel)
  ipcMain.handle('virtualPorts:status', () => ({
    installed: true,
    pairs,
    occupiedPorts: pairs
      .flatMap((pair) => pair.split(' ↔ '))
      .filter((port) => /^COM\d+$/.test(port)),
    availablePorts: Array.from({ length: 10 }, (_, index) => `COM${index + 10}`).filter(
      (port) => !pairs.some((pair) => pair.split(' ↔ ').includes(port))
    ),
    certificateAvailable: false,
    certificateInstalled: false
  }))
  ipcMain.handle('virtualPorts:create', (_event, first: string, second: string) => {
    pairs = [...pairs, `${first} ↔ ${second}`]
    return { first, second }
  })
  ipcMain.handle('virtualPorts:remove', (_event, first: string, second: string) => {
    if (failure) throw new Error('模拟删除失败')
    const pair = `${first} ↔ ${second}`
    removals.push(pair)
    pairs = pairs.filter((item) => item !== pair)
    return '已删除'
  })
  const run = (source: string): Promise<unknown> => window.webContents.executeJavaScript(source)
  const until = async (source: string): Promise<void> => {
    const deadline = Date.now() + 8000
    while (!(await run(source))) {
      if (Date.now() > deadline) throw new Error(`Serial pairs timeout: ${source}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  const refresh = () => run('document.querySelector("[title=刷新串口对列表]").click()')
  try {
    await run('document.querySelector("[aria-label=虚拟串口对]").click()')
    await until('Boolean(document.querySelector(".serial-pair-panel"))')
    if (await run('Boolean(document.querySelector("[aria-label=展开侧栏]"))'))
      await run('document.querySelector("[aria-label=展开侧栏]").click()')
    await until('document.querySelectorAll(".side-page .serial-pair-item").length === 3')
    assert.equal(
      await run('document.querySelector(".config-panel").classList.contains("full-page-tab-only")'),
      false
    )
    assert.equal(
      await run(`document.querySelector('[aria-label="删除 COM40 ↔ 等待对端"]').disabled`),
      true
    )
    await run('document.querySelector("[aria-label=收起侧栏]").click()')
    assert.equal(await run('document.querySelector(".side-page") === null'), true)
    await run('document.querySelector("[aria-label=展开侧栏]").click()')
    await until('document.querySelectorAll(".serial-pair-item").length === 3')
    await run(
      'document.querySelector(".sidebar-resizer").dispatchEvent(new MouseEvent("dblclick", {bubbles:true}))'
    )
    const pairWidth = await run(
      'document.querySelector(".config-panel").getBoundingClientRect().width'
    )
    await run('document.querySelector("[aria-label=串口]").click()')
    assert.equal(
      await run('document.querySelector(".config-panel").getBoundingClientRect().width'),
      pairWidth
    )
    await run('document.querySelector("[aria-label=虚拟串口对]").click()')
    // Allow the tab-entry refresh effect to start before exercising mutations.
    await new Promise((resolve) => setTimeout(resolve, 100))
    await until(
      'document.querySelectorAll(".serial-pair-item").length === 3 && !document.querySelector(".serial-pair-form button").disabled'
    )
    await run('document.querySelector(".serial-pair-form button").click()')
    await until('document.querySelectorAll(".serial-pair-item").length === 4')
    assert(pairs.includes('COM10 ↔ COM11'))
    await until(`!document.querySelector('[aria-label="删除 COM10 ↔ COM11"]').disabled`)
    await run(`document.querySelector('[aria-label="删除 COM10 ↔ COM11"]').click()`)
    await until('document.querySelectorAll(".serial-pair-item").length === 3')
    assert.deepEqual(removals, ['COM10 ↔ COM11'])
    failure = true
    await until(`!document.querySelector('[aria-label="删除 COM20 ↔ COM21"]').disabled`)
    await run(`document.querySelector('[aria-label="删除 COM20 ↔ COM21"]').click()`)
    await until(
      'document.querySelector(".serial-pair-sidebar-message").textContent.includes("模拟删除失败")'
    )
    assert.equal(await run('document.querySelectorAll(".serial-pair-item").length'), 3)
    failure = false
    pairs = []
    await refresh()
    await until(
      'Boolean(document.querySelector(".serial-pair-empty")) && !document.querySelector("[title=刷新串口对列表]").disabled'
    )
    assert.equal(await run('document.querySelectorAll(".serial-pair-item").length'), 0)
    pairs = ['COM20 ↔ COM21', 'COM30 ↔ COM31']
    await refresh()
    await until('document.querySelectorAll(".serial-pair-item").length === 2')
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    writeFileSync(
      join(process.cwd(), '.tmp/ui-smoke/serial-pairs.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    console.log(
      'Serial pairs: shared sidebar, collapse, width, tab switching, create/remove, incomplete pairs, failures and empty state passed (mock driver)'
    )
  } finally {
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
