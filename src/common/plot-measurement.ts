export type PlotMeasurement = {
  a: number
  b: number
  total: number
  active: 'a' | 'b'
  receivePaused: boolean
  deltaTime: string
  rows: string[][]
}

export type PlotMeasurementCommand =
  | { type: 'end' }
  | { type: 'receive'; paused: boolean }
  | { type: 'select'; cursor: 'a' | 'b' }
  | { type: 'move'; cursor: 'a' | 'b'; index: number }

export function validMeasurement(value: unknown): value is PlotMeasurement {
  if (!value || typeof value !== 'object') return false
  const v = value as PlotMeasurement
  return (
    Number.isSafeInteger(v.total) &&
    v.total > 0 &&
    v.total <= 100000 &&
    [v.a, v.b].every((n) => Number.isSafeInteger(n) && n >= 1 && n <= v.total) &&
    (v.active === 'a' || v.active === 'b') &&
    typeof v.receivePaused === 'boolean' &&
    typeof v.deltaTime === 'string' &&
    v.deltaTime.length <= 100 &&
    Array.isArray(v.rows) &&
    v.rows.length <= 1000 &&
    v.rows.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 9 &&
        row.every((cell) => typeof cell === 'string' && cell.length <= 1000)
    )
  )
}

export function validMeasurementCommand(value: unknown): value is PlotMeasurementCommand {
  if (!value || typeof value !== 'object') return false
  const v = value as PlotMeasurementCommand
  return (
    v.type === 'end' ||
    (v.type === 'receive' && typeof v.paused === 'boolean') ||
    ((v.type === 'select' || v.type === 'move') &&
      (v.cursor === 'a' || v.cursor === 'b') &&
      (v.type === 'select' || (Number.isSafeInteger(v.index) && v.index >= 1 && v.index <= 100000)))
  )
}
