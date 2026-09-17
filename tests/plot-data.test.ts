import { expect, test } from 'bun:test'
import { getQuickJS } from 'quickjs-emscripten'
import {
  PlotBuffer,
  measurePlot,
  parsePlotValues,
  plotVertices,
  type PlotSample
} from '../src/renderer/src/plot-data'
import { PlotStore } from '../src/renderer/src/plot-store'
import { formatPlotValue } from '../src/renderer/src/plot-display'
import { buildPlotProgram, defaultPlotProgram } from '../src/renderer/src/plot-program'
import { formatTime } from '../src/renderer/src/serial-utils'

test('fast receive timestamps preserve local 24-hour time and millisecond padding', () => {
  expect(formatTime(new Date(2026, 0, 1, 0, 0, 0, 1))).toBe('00:00:00.001')
  expect(formatTime(new Date(2026, 0, 1, 23, 59, 59, 999))).toBe('23:59:59.999')
})

test('plot values show full decimal digits and data windows use names without merging channels', () => {
  expect(formatPlotValue(8330123)).toBe('8,330,123')
  expect(formatPlotValue(8330123.25)).toBe('8,330,123.25')
  const store = new PlotStore()
  store.configure(['data-window:first', 'data-window:second'], 10)
  store.setPortLabel('data-window:first', 'AD')
  store.setPortLabel('data-window:second', 'AD')
  store.appendValues('data-window:first', { value: 1 })
  store.appendValues('data-window:second', { value: 2 })
  expect([...store.channels.keys()]).toEqual([
    'data-window:first · value',
    'data-window:second · value'
  ])
  expect(store.channelLabel('data-window:first · value')).toBe('AD · value')
  expect(store.channelLabel('data-window:second · value')).toBe('AD (2) · value')
  store.dispose()
})

function samples(values: (number | undefined)[]): PlotBuffer<PlotSample> {
  const buffer = new PlotBuffer<PlotSample>(Math.max(1, values.length))
  values.forEach((value, index) =>
    buffer.push({
      id: index + 1,
      timestamp: index * 10,
      port: 'P',
      values: value === undefined ? {} : { AD: value }
    })
  )
  return buffer
}

test('ring wraps in order without retaining evicted points; snapshots remain frozen', () => {
  const store = new PlotStore()
  store.configure(['P'], 3)
  for (let i = 0; i < 3; i++) store.append('P', `AD=${i}`, i)
  const frozen = store.freeze()
  for (let i = 3; i < 100; i++) store.append('P', `AD=${i}`, i)
  expect(store.samples.slice().map((item) => item.values.AD)).toEqual([97, 98, 99])
  expect(frozen.slice().map((item) => item.values.AD)).toEqual([0, 1, 2])
  store.configure(['P'], 2)
  expect(store.samples.slice().map((item) => item.values.AD)).toEqual([98, 99])
  store.configure(['Q'], 2)
  expect(store.samples.length).toBe(0)
  store.dispose()
})

test('cursor ranges include both endpoints, work reversed or coincident, skip missing/nonfinite values', () => {
  const buffer = samples([10, undefined, 30, NaN, 50, Infinity])
  for (const [a, b] of [
    [0, 4],
    [4, 0]
  ]) {
    const stats = measurePlot(buffer, a, b, ['AD', 'missing'])
    expect(stats.AD).toMatchObject({
      count: 3,
      min: 10,
      max: 50,
      mean: 30,
      peakToPeak: 40,
      a: a === 0 ? 10 : 50,
      b: b === 4 ? 50 : 10
    })
    expect(stats.missing.count).toBe(0)
    expect(stats.missing.a).toBeNull()
  }
  expect(measurePlot(buffer, 2, 2, ['AD']).AD).toMatchObject({
    count: 1,
    min: 30,
    max: 30,
    mean: 30,
    peakToPeak: 0
  })
  expect(measurePlot(buffer, 1, 1, ['AD']).AD.count).toBe(0)
  expect(measurePlot(samples([1e308, 1e308]), 0, 1, ['AD']).AD.mean).toBe(1e308)
})

test('pixel decimation retains endpoints and spikes, splits missing data, and ignores other ports', () => {
  const buffer = samples([0, 1, 100, -30, 2, 3, undefined, 9, 8])
  buffer.at(1)!.port = 'Q'
  const points = plotVertices(buffer, 'AD', 'P', 0, 8, 1, (_, i) => i / 9)
  expect(points.map((point) => point.value)).toEqual([0, 100, -30, 3, 9, 8])
  expect(points.filter((point) => point.move).map((point) => point.index)).toEqual([0, 7])
  const full = samples(
    Array.from({ length: 100000 }, (_, i) => (i === 54321 ? 100000 : Math.sin(i)))
  )
  const reduced = plotVertices(full, 'AD', 'P', 0, 99999, 1000, (_, i) => i / 100000)
  expect(reduced.length).toBeLessThanOrEqual(4000)
  expect(Math.max(...reduced.map((item) => item.value))).toBe(100000)
  expect(measurePlot(full, 0, 99999, ['AD']).AD.count).toBe(100000)
})

test('numeric parser supports named/scientific values and rejects invalid lists', () => {
  expect(parsePlotValues('AD=1e3 pressure=-.25')).toEqual({ AD: 1000, pressure: -0.25 })
  expect(parsePlotValues('1,2,3')).toEqual({ CH1: 1, CH2: 2, CH3: 3 })
  expect(parsePlotValues('bad,2')).toBeNull()
})

test('actual QuickJS batch conversion keeps every sample and its peak', async () => {
  const engine = (await getQuickJS()).newContext()
  try {
    const evaluation = engine.evalCode(`let handler; function execute(fn) { handler=fn }
${buildPlotProgram(defaultPlotProgram)}
handler([{CH1:1000},{CH1:5000},{CH1:3000}])`)
    if (evaluation.error) {
      const message = engine.dump(evaluation.error)
      evaluation.error.dispose()
      throw new Error(JSON.stringify(message))
    }
    expect(
      engine.dump(evaluation.value).map((items: { value: number }[]) => items[0].value)
    ).toEqual([0, 500, 250])
    evaluation.value.dispose()
  } finally {
    engine.dispose()
  }
})

test('batch queue preserves order, disconnect gaps and raw inputs on failure', async () => {
  const store = new PlotStore({
    run: async (_source, batch) =>
      batch.map((values) => [{ name: '压力', value: values.AD * 2, unit: 'gf', decimals: 2 }]),
    dispose: () => {}
  })
  store.configure(['P'], 1000)
  store.configureProgram(true, 'test')
  for (let i = 0; i < 300; i++) store.append('P', `AD=${i}`)
  store.disconnect('P')
  store.append('P', 'AD=400')
  await Bun.sleep(50)
  expect(store.samples.length).toBe(301)
  expect(store.samples.at(299)?.values['计算·压力 (gf)']).toBe(598)
  expect(store.samples.at(300)?.breakBefore).toBe(true)
  expect(store.samples.at(300)?.values['计算·压力 (gf)']).toBe(800)
  store.dispose()
  const failed = new PlotStore({
    run: async () => {
      throw new Error('timeout')
    },
    dispose: () => {}
  })
  failed.configure(['P'], 100)
  failed.configureProgram(true, 'test')
  failed.append('P', 'AD=1')
  failed.append('P', 'AD=2')
  await Bun.sleep(30)
  failed.append('P', 'AD=3')
  expect(failed.programError).toBe('timeout')
  expect(failed.samples.slice().map((item) => item.values.AD)).toEqual([1, 2, 3])
  failed.dispose()
})

test('reconfiguration cancels in-flight results; overflow is explicit and does not lose raw samples', async () => {
  let release: (() => void) | undefined
  const store = new PlotStore({
    run: async (_source, batch) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return batch.map(() => [{ name: 'x', value: 1, unit: '', decimals: 2 }])
    },
    dispose: () => {}
  })
  store.configure(['P'], 10000)
  store.configureProgram(true, 'test')
  store.append('P', 'AD=1')
  await Bun.sleep(15)
  store.clear()
  release?.()
  await Bun.sleep(5)
  expect(store.samples.length).toBe(0)
  for (let i = 0; i < 4100; i++) store.append('P', `AD=${i}`)
  expect(store.programError).toContain('跟不上')
  expect(store.samples.length).toBe(4100)
  store.dispose()
})
test('receive pause excludes new plot samples and resumes with a gap', () => {
  const store = new PlotStore()
  store.configure(['COM1'], 1000)
  store.append('COM1', 'AD=1', 1)
  store.setReceivingPaused(true)
  store.append('COM1', 'AD=999', 2)
  expect(store.samples.length).toBe(1)
  store.setReceivingPaused(false)
  store.append('COM1', 'AD=2', 3)
  expect(store.samples.length).toBe(2)
  expect(store.samples.at(1)?.values.AD).toBe(2)
  expect(store.samples.at(1)?.breakBefore).toBe(true)
  store.dispose()
})
