import assert from 'node:assert/strict'
import type { BrowserWindow } from 'electron'

export async function checkSerialCommandDrag(window: BrowserWindow): Promise<void> {
  const run = (source: string): Promise<unknown> => window.webContents.executeJavaScript(source)
  const until = async (source: string): Promise<void> => {
    const deadline = Date.now() + 8000
    while (!(await run(source))) {
      if (Date.now() > deadline) throw new Error(`Command drag timeout: ${source}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  const groups = [1, 2].map((id) => ({ id, parentId: null, name: `Group ${id}`, globals: {} }))
  const commands = [1, 2].map((id) => ({
    id,
    parentId: id,
    name: `Command ${id}`,
    template: 'test',
    hex: false,
    parameters: []
  }))
  await run(`localStorage.setItem('serialflow.commands', ${JSON.stringify(JSON.stringify(commands))});
    localStorage.setItem('serialflow.commandGroups', ${JSON.stringify(JSON.stringify(groups))});
    localStorage.setItem('serialflow.sidebarCollapsed', 'false')`)
  window.webContents.reload()
  await until('Boolean(document.querySelector(\'[aria-label="快捷指令"]\'))')
  await run('document.querySelector(\'[aria-label="快捷指令"]\').click()')
  await until("document.querySelectorAll('.command-item').length === 2")
  const start = async (): Promise<void> => {
    await run(
      `Array.from(document.querySelectorAll('.command-item')).find(row => row.querySelector('strong').textContent === 'Command 1').querySelector('[draggable]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }))`
    )
  }
  const saved = (): Promise<unknown> =>
    run("JSON.parse(localStorage.getItem('serialflow.commands'))")
  await start()
  await run(
    "document.querySelector('.commands-panel').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))"
  )
  assert.equal(
    await run("document.querySelector('.command-root-drop').classList.contains('is-drop-target')"),
    true
  )
  await run(
    "document.querySelector('.commands-panel').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))"
  )
  await until(
    "JSON.parse(localStorage.getItem('serialflow.commands')).find(c => c.id === 1).parentId === null"
  )
  assert.equal(await run("document.querySelectorAll('.command-list > .command-item').length"), 1)
  for (const edge of ['before', 'after']) {
    await start()
    const dispatch = (type: string): Promise<unknown> =>
      run(`(() => {
      const row = Array.from(document.querySelectorAll('.command-item')).find(row => row.querySelector('strong').textContent === 'Command 2');
      const bounds = row.getBoundingClientRect();
      row.dispatchEvent(new DragEvent('${type}', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), clientY: ${edge === 'before' ? 'bounds.top + 1' : 'bounds.bottom - 1'} }));
    })()`)
    await dispatch('dragover')
    assert.equal(await run(`document.querySelectorAll('.list-drop-${edge}').length`), 1)
    await dispatch('drop')
    const state = (await saved()) as Array<{ id: number; parentId: number | null }>
    assert.equal(state.find((command) => command.id === 1)?.parentId, 2)
    assert.deepEqual(
      state.map((command) => command.id),
      edge === 'before' ? [1, 2] : [2, 1]
    )
    assert.equal(
      await run(
        "document.querySelectorAll('.list-drop-before, .list-drop-after, .is-drop-target').length"
      ),
      0
    )
  }
  await start()
  await run(
    "document.querySelector('.commands-panel').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))"
  )
  await run(
    "document.querySelector('.command-drag-source').dispatchEvent(new DragEvent('dragend', { bubbles: true }))"
  )
  assert.equal(
    await run("document.querySelectorAll('.is-drop-target, .list-is-dragging').length"),
    0
  )
  assert.equal(
    ((await saved()) as Array<{ id: number; parentId: number }>).find((command) => command.id === 1)
      ?.parentId,
    2
  )
  console.log(
    'Serial commands: blank-area ungrouping, cross-group insertion, ordering and cancellation passed'
  )
}
