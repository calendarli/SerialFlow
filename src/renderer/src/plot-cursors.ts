export type PlotCursors = { a: number; b: number }
export type AnchoredPlotCursors = PlotCursors & { endIndex: number }

export function followPlotCursors(
  selection: AnchoredPlotCursors | null,
  endIndex: number,
  lastIndex: number
): PlotCursors | null {
  if (!selection || lastIndex < 0 || Math.abs(selection.a - selection.b) > lastIndex) return null
  return shiftPlotCursors(selection, endIndex - selection.endIndex, lastIndex)
}

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
