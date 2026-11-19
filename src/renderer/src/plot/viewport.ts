import type { PlotBuffer, PlotSample } from '../plot-data'

export type Range = { min: number; max: number }

export function wheelScale(delta: number, mode = 0): number {
  const pixels = delta * (mode === 1 ? 16 : mode === 2 ? 420 : 1)
  return Math.exp(Math.max(-500, Math.min(500, pixels)) * 0.002)
}

export function zoomRange(range: Range, anchor: number, factor: number): Range {
  const span = range.max - range.min
  if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(span)) return range
  const min = anchor + (range.min - anchor) * factor
  const max = anchor + (range.max - anchor) * factor
  return Number.isFinite(min) && Number.isFinite(max) && max > min ? { min, max } : range
}

export function indexAtTime(samples: PlotBuffer<PlotSample>, time: number, after = false): number {
  let low = 0,
    high = samples.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (samples.at(middle)!.timestamp < time || (after && samples.at(middle)!.timestamp === time))
      low = middle + 1
    else high = middle
  }
  return low
}

export function paddedRange(min: number, max: number): Range {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: -1, max: 1 }
  const span = Math.max(max - min, Math.abs(max) * 1e-9, 1e-9)
  const padding = span * 0.12
  const lower = min - padding,
    upper = max + padding
  return { min: Number.isFinite(lower) ? lower : min, max: Number.isFinite(upper) ? upper : max }
}

// Expand immediately; only shrink after the signal remains well inside the range.
export class AutoRange {
  private range: Range | null = null
  private shrinkSince: number | null = null
  reset(): void {
    this.range = null
    this.shrinkSince = null
  }
  update(target: Range, now: number): Range {
    const inset = (target.max - target.min) * 0.08
    if (!this.range || target.min + inset < this.range.min || target.max - inset > this.range.max) {
      this.range = this.range
        ? { min: Math.min(target.min, this.range.min), max: Math.max(target.max, this.range.max) }
        : target
      this.shrinkSince = null
    } else if (target.max - target.min < (this.range.max - this.range.min) * 0.65) {
      this.shrinkSince ??= now
      if (now - this.shrinkSince >= 1500) {
        this.range = target
        this.shrinkSince = null
      }
    } else this.shrinkSince = null
    return this.range
  }
}

export function niceTicks(min: number, max: number, count = 6): number[] {
  const raw = (max - min) / Math.max(1, count - 1)
  if (!Number.isFinite(raw) || raw <= 0) return [min]
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 2.5, 5, 10].find((n) => n * magnitude >= raw) ?? 10) * magnitude
  if (!Number.isFinite(step) || step <= 0) return [min]
  const first = Math.ceil(min / step) * step
  const result: number[] = []
  for (let i = 0; i < 32; i++) {
    const value = first + i * step
    if (value > max + step * 1e-8) break
    result.push(Math.abs(value) < step * 1e-9 ? 0 : Number(value.toPrecision(14)))
  }
  return result
}
