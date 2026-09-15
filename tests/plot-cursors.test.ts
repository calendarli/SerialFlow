import { expect, test } from 'bun:test'
import { shiftPlotCursors } from '../src/renderer/src/plot-cursors'

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
