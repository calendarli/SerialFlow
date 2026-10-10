import assert from 'node:assert/strict'
import type { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Run against the real receive UI; send can use either TCP or the serial IPC harness.
export async function checkMultilineInteraction(
  window: BrowserWindow,
  send: (text: string) => void | Promise<void>
): Promise<void> {
  const run = (source: string): Promise<unknown> => window.webContents.executeJavaScript(source)
  const until = async (source: string): Promise<void> => {
    const deadline = Date.now() + 8000
    while (!(await run(source))) {
      if (Date.now() > deadline) {
        console.error(
          await run(
            `Array.from(document.querySelectorAll('.interaction-virtual-row')).map(el => ({ index: el.dataset.index, text: el.textContent, top: el.getBoundingClientRect().top, height: el.offsetHeight, transform: el.style.transform }))`
          )
        )
        throw new Error(`Multiline receive timeout: ${source}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  }
  const visible = (text: string): string =>
    `Array.from(document.querySelectorAll('.interaction-entry pre')).some(pre => pre.textContent === ${JSON.stringify(text.replace(/\r\n?/g, '\n'))})`
  const assertLayout = async (
    text: string,
    markers: string[],
    lineOffsets: number[]
  ): Promise<void> => {
    await until(visible(text))
    await until(`(() => {
      const rows = Array.from(document.querySelectorAll('.interaction-virtual-row')).map(el => el.getBoundingClientRect()).sort((a,b) => a.top - b.top);
      return rows.every((rect, i) => !i || rect.top >= rows[i - 1].bottom - 1);
    })()`)
    const layout = (await run(`(() => {
      const pre = Array.from(document.querySelectorAll('.interaction-entry pre')).find(pre => pre.textContent === ${JSON.stringify(text.replace(/\r\n?/g, '\n'))});
      const row = pre.closest('.interaction-virtual-row');
      const lineHeight = parseFloat(getComputedStyle(pre).lineHeight);
      const tops = ${JSON.stringify(markers)}.map(marker => {
        const range = document.createRange();
        const offset = pre.textContent.indexOf(marker);
        range.setStart(pre.firstChild, offset);
        range.setEnd(pre.firstChild, offset + marker.length);
        return range.getBoundingClientRect().top;
      });
      const rows = Array.from(document.querySelectorAll('.interaction-virtual-row')).map(el => el.getBoundingClientRect()).sort((a,b) => a.top - b.top);
      return { lineHeight, tops, clipped: pre.scrollHeight > pre.clientHeight + 1,
        height: row.getBoundingClientRect().height, preHeight: pre.getBoundingClientRect().height,
        overlapping: rows.some((rect, i) => i && rect.top < rows[i - 1].bottom - 1) };
    })()`)) as {
      lineHeight: number
      tops: number[]
      clipped: boolean
      height: number
      preHeight: number
      overlapping: boolean
    }
    assert.equal(layout.clipped, false, 'Every line must fit inside the pre element')
    assert.equal(layout.overlapping, false, 'Multiline records must not overlap adjacent records')
    assert(layout.height >= layout.preHeight, 'The virtual row must contain its complete text')
    for (let i = 1; i < markers.length; i++)
      assert(
        Math.abs(layout.tops[i] - layout.tops[0] - lineOffsets[i] * layout.lineHeight) < 2,
        `Line ${markers[i]} must retain its vertical position`
      )
  }

  const lf = 'LF:first\nLF:second\n\nLF:fourth'
  await send(lf)
  await assertLayout(lf, ['LF:first', 'LF:second', 'LF:fourth'], [0, 1, 3])
  const crlf = 'CRLF:first\r\nCRLF:second\r\nCRLF:third'
  await send(crlf)
  await assertLayout(crlf, ['CRLF:first', 'CRLF:second', 'CRLF:third'], [0, 1, 2])
  const cr = 'CR:first\rCR:second'
  await send(cr)
  await assertLayout(cr, ['CR:first', 'CR:second'], [0, 1])

  // Raw framing preserves network chunks. A split CRLF must not hide either part.
  await send('SPLIT:first\r')
  await until(visible('SPLIT:first\r'))
  const split = '\nSPLIT:second\r\nSPLIT:third'
  await send(split)
  await assertLayout(split, ['SPLIT:second', 'SPLIT:third'], [0, 1])

  // Remeasure when the font changes, and when settings are saved without a size
  // change (which does not generate another ResizeObserver notification).
  for (const resize of [true, false]) {
    await run('document.querySelector("[title=数据交互设置]").click()')
    if (resize)
      await run(`(() => {
        const input = document.querySelector('.interaction-settings-grid input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '14');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`)
    await run('document.querySelector(".interaction-settings-actions .primary").click()')
    await until('!document.querySelector(".interaction-settings").open')
    await assertLayout(split, ['SPLIT:second', 'SPLIT:third'], [0, 1])
  }
  const large = Array.from({ length: 36 }, (_, i) => `LARGE:line-${i}`).join('\n')
  await send(large)
  await until(visible(large))
  await until(
    `(() => { const view = document.querySelector('.interaction-view'); return view.scrollHeight - view.scrollTop - view.clientHeight < 2 })()`
  )
  await assertLayout(large, ['LARGE:line-0', 'LARGE:line-35'], [0, 35])

  // Evict the earlier rows from the DOM, then search into a measured multiline row.
  for (let i = 0; i < 32; i++) {
    const text = `TAIL:${i}`
    await send(text)
    await until(visible(text))
  }
  await run(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))`
  )
  await until('Boolean(document.querySelector("#interaction-search-input"))')
  await run(`(() => {
    const input = document.querySelector('#interaction-search-input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'LF:fourth');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await run('document.querySelector(".interaction-search .find-button").click()')
  await until('Boolean(document.querySelector(".interaction-entry.search-match"))')
  await assertLayout(lf, ['LF:first', 'LF:second', 'LF:fourth'], [0, 1, 3])
  await until(`(() => {
    const row = document.querySelector('.interaction-entry.search-match').getBoundingClientRect();
    const view = document.querySelector('.interaction-view').getBoundingClientRect();
    return row.top >= view.top - 1 && row.bottom <= view.bottom + 1;
  })()`)
  // Receiving more data while inspecting history must not jump back to the tail.
  await send('TAIL:while-searching')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(await run(visible(lf)), true)
  writeFileSync(
    join(process.cwd(), '.tmp/ui-smoke/interaction-multiline.png'),
    (await window.capturePage()).toPNG()
  )
  await run('document.querySelector(".interaction-search .close-search").click()')
  console.log(
    'PASS: multiline LF/CRLF/CR, blank lines, split CRLF, font resize, large records, scrolling and search'
  )
}
