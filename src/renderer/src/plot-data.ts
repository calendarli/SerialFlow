export type PlotSample = {
  id: number
  timestamp: number
  port: string
  breakBefore?: boolean
  values: Record<string, number>
}

// A fixed-capacity FIFO: appending a point never copies the history.
export class PlotBuffer<T> {
  private items: (T | undefined)[]
  private head = 0
  length = 0
  constructor(readonly capacity: number) {
    this.items = new Array(capacity)
  }
  push(value: T): void {
    this.items[(this.head + this.length) % this.capacity] = value
    if (this.length < this.capacity) this.length++
    else this.head = (this.head + 1) % this.capacity
  }
  at(index: number): T | undefined {
    if (index < 0) index += this.length
    return index >= 0 && index < this.length
      ? this.items[(this.head + index) % this.capacity]
      : undefined
  }
  slice(start = 0, end = this.length): T[] {
    if (start < 0) start = Math.max(0, this.length + start)
    if (end < 0) end = Math.max(0, this.length + end)
    const result: T[] = []
    for (let index = Math.max(0, start); index < Math.min(end, this.length); index++)
      result.push(this.at(index)!)
    return result
  }
  indexOf(value: T): number {
    for (let index = 0; index < this.length; index++) if (this.at(index) === value) return index
    return -1
  }
  flatMap<R>(fn: (value: T, index: number) => R[]): R[] {
    const result: R[] = []
    for (let index = 0; index < this.length; index++) result.push(...fn(this.at(index)!, index))
    return result
  }
}

export function parsePlotValues(text: string): Record<string, number> | null {
  const named = [
    ...text.matchAll(
      /([\p{L}_][\p{L}\p{N}_]*)\s*[=:]\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/gu
    )
  ]
  if (named.length)
    return Object.fromEntries(named.slice(0, 8).map((item) => [item[1], Number(item[2])]))
  const parts = text
    .trim()
    .split(/[,;\s]+/)
    .filter(Boolean)
  if (!parts.length || parts.length > 8 || parts.some((value) => !Number.isFinite(Number(value))))
    return null
  return Object.fromEntries(parts.map((value, index) => [`CH${index + 1}`, Number(value)]))
}

export type PlotStatistics = {
  count: number
  min: number
  max: number
  mean: number
  peakToPeak: number
  a: number | null
  b: number | null
  latest: number | null
}

export function measurePlot(
  samples: PlotBuffer<PlotSample>,
  a: number,
  b: number,
  channels: string[]
): Record<string, PlotStatistics> {
  const start = Math.max(0, Math.min(a, b))
  const end = Math.min(samples.length - 1, Math.max(a, b))
  const result: Record<string, PlotStatistics> = Object.create(null)
  for (const name of channels) {
    let latest: number | null = null
    let min = Infinity,
      max = -Infinity,
      mean = 0,
      count = 0
    for (let index = start; index <= end; index++) {
      const value = samples.at(index)?.values[name]
      if (value === undefined || !Number.isFinite(value)) continue
      count++
      latest = value
      min = Math.min(min, value)
      max = Math.max(max, value)
      // Weighted update avoids overflowing a sum for large finite samples.
      mean = mean * ((count - 1) / count) + value / count
    }
    const endpoint = (index: number): number | null => {
      const value = samples.at(index)?.values[name]
      return value !== undefined && Number.isFinite(value) ? value : null
    }
    result[name] = {
      count,
      min,
      max,
      mean,
      peakToPeak: max - min,
      a: endpoint(a),
      b: endpoint(b),
      latest
    }
  }
  return result
}

export type PlotVertex = { index: number; timestamp: number; value: number; move: boolean }

// Bucket by horizontal screen position. Keep first, last and both extrema in temporal order.
export function plotVertices(
  samples: PlotBuffer<PlotSample>,
  name: string,
  port: string,
  start: number,
  end: number,
  buckets: number,
  position: (sample: PlotSample, index: number) => number
): PlotVertex[] {
  const result: PlotVertex[] = []
  let first: PlotVertex | null = null
  let last: PlotVertex | null = null
  let minimum: PlotVertex | null = null
  let maximum: PlotVertex | null = null
  let bucket = -Infinity
  let move = true
  const flush = (): void => {
    if (!first) return
    const chosen = [...new Set([first, minimum!, maximum!, last!])].sort(
      (a, b) => a.index - b.index
    )
    chosen[0] = { ...chosen[0], move }
    result.push(...chosen)
    move = false
    first = last = minimum = maximum = null
  }
  for (let index = Math.max(0, start); index <= Math.min(end, samples.length - 1); index++) {
    const sample = samples.at(index)!
    if (sample.port !== port) continue
    if (sample.breakBefore) {
      flush()
      move = true
    }
    const value = sample.values[name]
    if (!Number.isFinite(value)) {
      flush()
      move = true
      continue
    }
    const nextBucket = Math.floor(position(sample, index) * Math.max(1, buckets))
    if (nextBucket !== bucket) {
      flush()
      bucket = nextBucket
    }
    const point = { index, timestamp: sample.timestamp, value, move: false }
    first ??= point
    last = point
    if (!minimum || value < minimum.value) minimum = point
    if (!maximum || value > maximum.value) maximum = point
  }
  flush()
  return result
}
