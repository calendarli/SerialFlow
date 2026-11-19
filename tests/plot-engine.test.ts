import { expect, test } from 'bun:test'
import { PlotBuffer, measurePlot, type PlotSample } from '../src/renderer/src/plot-data'
import {
  AutoRange,
  paddedRange,
  niceTicks,
  wheelScale,
  zoomRange,
  indexAtTime
} from '../src/renderer/src/plot/viewport'
import { GeometryCache } from '../src/renderer/src/plot/geometry'
import { StatisticsCache } from '../src/renderer/src/plot/statistics'
import { packSamples, unpackSamples } from '../src/renderer/src/plot/packet'
import { SampleClocks, defaultClock } from '../src/renderer/src/plot/clock'

function samples(count: number, capacity = count): PlotBuffer<PlotSample> {
  const buffer = new PlotBuffer<PlotSample>(capacity)
  for (let i = 0; i < count; i++)
    buffer.push({
      id: i + 1,
      timestamp: 1700000000000 + i * 10,
      port: 'P',
      values: { A: 1e9 + Math.sin(i) * 0.001 }
    })
  return buffer
}

test('wheel zoom is reversible for pixels, lines and pages and preserves the anchor', () => {
  for (const mode of [0, 1, 2]) {
    const range = { min: -10, max: 30 },
      anchor = 7
    const next = zoomRange(range, anchor, wheelScale(2, mode))
    const restored = zoomRange(next, anchor, wheelScale(-2, mode))
    expect(restored.min).toBeCloseTo(range.min, 10)
    expect(restored.max).toBeCloseTo(range.max, 10)
    expect((anchor - next.min) / (next.max - next.min)).toBeCloseTo(17 / 40, 10)
  }
})

test('automatic range expands for spikes immediately and waits before contracting', () => {
  const auto = new AutoRange()
  expect(auto.update({ min: 0, max: 10 }, 0)).toEqual({ min: 0, max: 10 })
  expect(auto.update({ min: -5, max: 100 }, 10)).toEqual({ min: -5, max: 100 })
  expect(auto.update({ min: 0, max: 10 }, 20).max).toBe(100)
  expect(auto.update({ min: 0, max: 10 }, 1519).max).toBe(100)
  expect(auto.update({ min: 0, max: 10 }, 1520).max).toBe(10)
  auto.reset()
  expect(auto.update({ min: 3, max: 4 }, 1600)).toEqual({ min: 3, max: 4 })
  expect(paddedRange(0, 0).max).toBeGreaterThan(0)
  expect(niceTicks(-1.3, 8.2)).toEqual([0, 2, 4, 6, 8])
})

test('time lookup handles repeated timestamps and fixed windows with insufficient data', () => {
  const buffer = samples(5)
  buffer.at(2)!.timestamp = buffer.at(1)!.timestamp
  expect(indexAtTime(buffer, 1699999990000)).toBe(0)
  expect(indexAtTime(buffer, buffer.at(1)!.timestamp)).toBe(1)
  expect(indexAtTime(buffer, buffer.at(1)!.timestamp, true)).toBe(3)
  expect(indexAtTime(buffer, buffer.at(-1)!.timestamp + 1)).toBe(5)
})

test('source clocks preserve fixed periods, unwrap counters and mark resets or unsynchronized sources', () => {
  const clocks = new SampleClocks()
  const fixed = { ...defaultClock, mode: 'period' as const, periodMs: 2.5 }
  expect(clocks.resolve('A', fixed, {}, 1000, 1000).timestamp).toBe(1000)
  expect(clocks.resolve('A', fixed, {}, 1100, 1000).timestamp).toBe(1002.5)
  const device = { ...defaultClock, mode: 'device' as const, field: 't', rollover: 256 }
  expect(clocks.resolve('B', device, { t: 254 }, 2000, 1002.5).timestamp).toBe(2000)
  expect(clocks.resolve('B', device, { t: 1 }, 2200, 2000).timestamp).toBe(2003)
  expect(clocks.resolve('B', device, { t: 0 }, 2300, 2003).gap).toBe(true)
  expect(clocks.resolve('B', device, {}, 2400, 2300).warning).toContain('无效')
  expect(clocks.resolve('A', fixed, {}, 2401, 2400).gap).toBe(true)
})

test('transfer packets preserve double precision timestamps, values, missing channels and breaks', () => {
  const input: PlotSample[] = [
    { id: 1, timestamp: 1700000000000.5, port: 'A', values: { x: 1e9 + 0.001 } },
    { id: 3, timestamp: 1700000000001, port: 'B', values: { y: -2 }, breakBefore: true }
  ]
  const output = unpackSamples(packSamples(input))
  expect(output[0].timestamp).toBe(input[0].timestamp)
  expect(output[0].values.x).toBe(input[0].values.x)
  expect(Number.isNaN(output[0].values.y)).toBe(true)
  expect(output[1].breakBefore).toBe(true)
  expect(output[1].port).toBe('B')
})

test('GPU blocks retain small signals at large offsets and reuse completed blocks', () => {
  const buffer = samples(5000, 6000),
    cache = new GeometryCache()
  const request = {
    start: 0,
    end: 4999,
    width: 1000,
    xMin: 1,
    xMax: 5000,
    xMode: 'points' as const,
    lineMode: 'linear' as const,
    channels: [{ name: 'A', port: 'P', color: '#123456' }]
  }
  const first = cache.build(buffer, request)
  expect(
    first[0].segments.some((value, index) => index % 2 === 1 && Math.abs(value) > 0.0001)
  ).toBe(true)
  const revision = first[0].revision
  buffer.push({ id: 5001, timestamp: 1700000050000, port: 'P', values: { A: 1e9 } })
  expect(cache.build(buffer, { ...request, end: 5000, xMax: 5001 })[0].revision).toBe(revision)
  const time = cache.build(buffer, {
    ...request,
    xMode: 'time',
    xMin: 1700000000000,
    xMax: 1700000050000
  })
  expect(Math.max(...time[0].segments.filter((_v, i) => i % 2 === 0))).toBeLessThan(50000)
})

test('geometry does not bridge missing values, disconnects or different sources', () => {
  const buffer = samples(6)
  buffer.at(2)!.values.A = NaN
  buffer.at(4)!.breakBefore = true
  const cache = new GeometryCache()
  const result = cache.build(buffer, {
    start: 0,
    end: 5,
    width: 1000,
    xMin: 1,
    xMax: 6,
    xMode: 'points',
    lineMode: 'linear',
    channels: [{ name: 'A', port: 'P', color: '#123456' }]
  })[0]
  const lines = Array.from({ length: result.segments.length / 4 }, (_, i) => [
    result.segments[i * 4],
    result.segments[i * 4 + 2]
  ])
  expect(lines).not.toContainEqual([1, 3])
  expect(lines).not.toContainEqual([3, 4])
  expect(lines).toContainEqual([4, 5])
})

test('cached statistics agree with raw measurements through reversed ranges and rollover', () => {
  const buffer = samples(5000, 5000),
    cache = new StatisticsCache()
  for (const [a, b] of [
    [0, 4999],
    [3200, 15],
    [2047, 2047],
    [0, 0]
  ]) {
    const actual = cache.measure(buffer, a, b, ['A', 'missing'])
    const expected = measurePlot(buffer, a, b, ['A', 'missing'])
    expect(actual.A.count).toBe(expected.A.count)
    expect(actual.A.min).toBe(expected.A.min)
    expect(actual.A.max).toBe(expected.A.max)
    expect(actual.A.mean).toBeCloseTo(expected.A.mean, 4)
    expect(actual.A.a).toBe(expected.A.a)
    expect(actual.missing.count).toBe(0)
  }
  buffer.push({ id: 5001, timestamp: 1700000050000, port: 'P', values: { A: 99 } })
  expect(cache.measure(buffer, 0, 4999, ['A']).A.min).toBe(99)
})
