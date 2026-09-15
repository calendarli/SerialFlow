import { expect, test } from 'bun:test'
import { shiftPlotCursors, followPlotCursors } from '../src/renderer/src/plot-cursors'

test('range translation preserves spacing and cursor order at both boundaries', () => {
  expect(shiftPlotCursors({ a: 2, b: 5 }, 2, 9)).toEqual({ a: 4, b: 7 })
  expect(shiftPlotCursors({ a: 2, b: 5 }, 100, 9)).toEqual({ a: 6, b: 9 })
  expect(shiftPlotCursors({ a: 5, b: 2 }, -100, 9)).toEqual({ a: 3, b: 0 })
  expect(shiftPlotCursors({ a: 5, b: 2 }, 100, 9)).toEqual({ a: 9, b: 6 })
  expect(shiftPlotCursors({ a: 0, b: 9 }, 5, 9)).toEqual({ a: 0, b: 9 })
})

test('coincident and single-point ranges remain valid; offsets snap to samples', () => {
  expect(shiftPlotCursors({ a: 2, b: 2 }, 1.7, 9)).toEqual({ a: 4, b: 4 })
  expect(shiftPlotCursors({ a: 0, b: 0 }, 1, 0)).toEqual({ a: 0, b: 0 })
  expect(shiftPlotCursors({ a: 2, b: 5 }, NaN, 9)).toEqual({ a: 2, b: 5 })
})
test('live cursors follow the viewport and retain their interval through buffer rollover', () => {
  const selection = { a: 1, b: 3, endIndex: 4 }
  expect(followPlotCursors(selection, 5, 5)).toEqual({ a: 2, b: 4 })
  expect(followPlotCursors(selection, 999, 999)).toEqual({ a: 996, b: 998 })
  expect(followPlotCursors({ a: 998, b: 996, endIndex: 999 }, 999, 999)).toEqual({ a: 998, b: 996 })
  expect(followPlotCursors(selection, 0, 0)).toBeNull()
  expect(followPlotCursors(null, 999, 999)).toBeNull()
})
