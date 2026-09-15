import { expect, test } from 'bun:test'
import { validMeasurement, validMeasurementCommand } from '../src/common/plot-measurement'

test('measurement IPC accepts bounded snapshots and reversed or coincident cursors', () => {
  const value = {
    a: 5,
    b: 1,
    total: 5,
    active: 'b',
    receivePaused: false,
    deltaTime: '-40',
    rows: [['AD', '50', '10', '-40', '5', '10', '50', '30', '40']]
  }
  expect(validMeasurement(value)).toBe(true)
  expect(validMeasurement({ ...value, b: 5 })).toBe(true)
  for (const patch of [
    { a: 0 },
    { b: 6 },
    { total: Infinity },
    { active: 'c' },
    { receivePaused: 'true' },
    { rows: [['AD']] },
    { rows: [[...value.rows[0].slice(0, 8), 1]] }
  ])
    expect(validMeasurement({ ...value, ...patch })).toBe(false)
  expect(validMeasurement(null)).toBe(false)
})

test('measurement commands reject invalid cursor positions and commands', () => {
  for (const command of [
    { type: 'end' },
    { type: 'receive', paused: true },
    { type: 'receive', paused: false },
    { type: 'select', cursor: 'a' },
    { type: 'move', cursor: 'b', index: 100000 }
  ])
    expect(validMeasurementCommand(command)).toBe(true)
  for (const command of [
    null,
    { type: 'pin' },
    { type: 'receive', paused: 'true' },
    { type: 'select', cursor: 'c' },
    ...[0, -1, 1.5, Infinity, 100001].map((index) => ({ type: 'move', cursor: 'a', index }))
  ])
    expect(validMeasurementCommand(command)).toBe(false)
})
