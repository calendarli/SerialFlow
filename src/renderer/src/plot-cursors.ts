export type PlotCursors = { a: number; b: number }

// Clamp the shared offset, not each cursor, so reversed ranges keep their width.
export function shiftPlotCursors(
  cursors: PlotCursors,
  offset: number,
  lastIndex: number
): PlotCursors {
  if (!Number.isFinite(offset)) return cursors
  const delta = Math.max(
    -Math.min(cursors.a, cursors.b),
    Math.min(lastIndex - Math.max(cursors.a, cursors.b), Math.round(offset))
  )
  return { a: cursors.a + delta, b: cursors.b + delta }
}
