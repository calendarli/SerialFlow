import { plotVertices, type PlotBuffer, type PlotSample } from '../plot-data'
import type { Geometry } from './render-types'

export type GeometryRequest = {
  start: number
  end: number
  width: number
  xMin: number
  xMax: number
  xMode: 'points' | 'time'
  lineMode: 'linear' | 'step'
  channels: { name: string; port: string; color: string }[]
}

// Stable ID blocks keep completed GPU buffers unchanged during live scrolling.
export class GeometryCache {
  private cache = new Map<string, { signature: string; value: Geometry }>()
  private revision = 0
  clear(): void {
    this.cache.clear()
  }
  build(samples: PlotBuffer<PlotSample>, request: GeometryRequest): Geometry[] {
    const result: Geometry[] = [],
      used = new Set<string>()
    const size = 2048
    const start = Math.max(0, request.start - 1),
      end = Math.min(samples.length - 1, request.end + 1)
    for (const channel of request.channels) {
      for (let first = start; first <= end;) {
        const block = Math.floor(samples.at(first)!.id / size)
        let last = Math.min(end, first + size - 1 - (samples.at(first)!.id % size))
        while (last > first && Math.floor(samples.at(last)!.id / size) !== block) last--
        while (last < end && Math.floor(samples.at(last + 1)!.id / size) === block) last++
        const x = (sample: PlotSample): number =>
          request.xMode === 'time' ? sample.timestamp : sample.id
        const firstX = x(samples.at(first)!),
          lastX = x(samples.at(last)!)
        const pixels = Math.max(
          1,
          ((lastX - firstX) / Math.max(1e-9, request.xMax - request.xMin)) * request.width
        )
        const buckets = Math.max(1, 2 ** Math.ceil(Math.log2(pixels)))
        let before = first - 1
        while (before >= 0 && samples.at(before)!.port !== channel.port) before--
        const key = `${channel.name}\0${block}`
        const signature = `${samples.at(Math.max(0, before))?.id}:${samples.at(first)!.id}:${samples.at(last)!.id}:${buckets}:${request.xMode}:${request.lineMode}`
        let cached = this.cache.get(key)
        if (!cached || cached.signature !== signature) {
          const points = plotVertices(
            samples,
            channel.name,
            channel.port,
            Math.max(0, before),
            last,
            buckets,
            (sample) => (x(sample) - firstX) / Math.max(1, lastX - firstX)
          )
          const originX = points.length
            ? request.xMode === 'time'
              ? points[0].timestamp
              : samples.at(points[0].index)!.id
            : firstX
          const originY = points[0]?.value ?? 0
          const values: number[] = []
          let previous: { x: number; y: number } | null = null
          for (const point of points) {
            const px =
              (request.xMode === 'time' ? point.timestamp : samples.at(point.index)!.id) - originX
            const py = point.value - originY
            if (!Number.isFinite(Math.fround(px)) || !Number.isFinite(Math.fround(py))) {
              previous = null
              continue
            }
            if (previous && !point.move) {
              if (request.lineMode === 'step')
                values.push(previous.x, previous.y, px, previous.y, px, previous.y, px, py)
              else values.push(previous.x, previous.y, px, py)
            } else values.push(px, py, px, py)
            previous = { x: px, y: py }
          }
          cached = {
            signature,
            value: {
              key,
              revision: ++this.revision,
              color: channel.color,
              originX,
              originY,
              segments: new Float32Array(values)
            }
          }
          this.cache.set(key, cached)
        }
        cached.value.color = channel.color
        used.add(key)
        result.push(cached.value)
        first = last + 1
      }
    }
    for (const key of this.cache.keys()) if (!used.has(key)) this.cache.delete(key)
    return result
  }
}
