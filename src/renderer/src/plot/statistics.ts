import { measurePlot, type PlotBuffer, type PlotSample, type PlotStatistics } from '../plot-data'

// Exact raw statistics cached per stable ID block; viewport edges are measured
// separately. Drawing LOD never participates in measurements.
export class StatisticsCache {
  private blocks = new Map<string, { first: number; last: number; stats: PlotStatistics }>()
  clear(): void {
    this.blocks.clear()
  }
  measure(
    samples: PlotBuffer<PlotSample>,
    a: number,
    b: number,
    channels: string[]
  ): Record<string, PlotStatistics> {
    const start = Math.max(0, Math.min(a, b)),
      end = Math.min(samples.length - 1, Math.max(a, b))
    const result: Record<string, PlotStatistics> = Object.create(null)
    for (const name of channels) {
      let count = 0,
        min = Infinity,
        max = -Infinity,
        mean = 0
      let latest: number | null = null
      for (let first = start; first <= end;) {
        const block = Math.floor(samples.at(first)!.id / 2048)
        let last = Math.min(end, first + 2047 - (samples.at(first)!.id % 2048))
        // IDs may have gaps after a reset or retention change.
        while (last > first && Math.floor(samples.at(last)!.id / 2048) !== block) last--
        const key = `${name}\0${block}`
        let cached = this.blocks.get(key)
        if (
          !cached ||
          cached.first !== samples.at(first)!.id ||
          cached.last !== samples.at(last)!.id
        ) {
          cached = {
            first: samples.at(first)!.id,
            last: samples.at(last)!.id,
            stats: measurePlot(samples, first, last, [name])[name]
          }
          this.blocks.set(key, cached)
        }
        const stats = cached.stats
        if (stats.count) {
          const total = count + stats.count
          mean = mean * (count / total) + stats.mean * (stats.count / total)
          count = total
          min = Math.min(min, stats.min)
          max = Math.max(max, stats.max)
          latest = stats.latest
        }
        first = last + 1
      }
      const endpoint = (index: number): number | null => {
        const value = samples.at(index)?.values[name]
        return Number.isFinite(value) ? value! : null
      }
      result[name] = {
        count,
        min,
        max,
        mean,
        latest,
        peakToPeak: max - min,
        a: endpoint(a),
        b: endpoint(b)
      }
    }
    const oldest = samples.at(0)?.id ?? Infinity
    for (const [key, block] of this.blocks) if (block.last < oldest) this.blocks.delete(key)
    return result
  }
}
