/// <reference lib="webworker" />
import { PlotBuffer, type PlotSample } from '../plot-data'
import { unpackSamples, type SamplePacket } from '../plot/packet'
import { StatisticsCache } from '../plot/statistics'
import { GeometryCache } from '../plot/geometry'
import { CanvasRenderer } from '../plot/canvas-renderer'
import { WebGLRenderer } from '../plot/webgl-renderer'
import type { PlotRenderer, RendererMode } from '../plot/render-types'
import { indexAtTime } from '../plot/viewport'

type RenderMessage = {
  type: 'render'
  requestId: number
  width: number
  height: number
  dpr: number
  xWindowPoints: number
  endOffset: number
  endId: number
  yMin: number
  yMax: number
  channels: { name: string; color: string; port: string }[]
  xMode: 'time' | 'points'
  timeStart: number
  timeSpan: number
  lineMode: 'linear' | 'step'
  lineWidth: number
}
type Message =
  | { type: 'init'; canvas: OffscreenCanvas; mode: RendererMode }
  | {
      type: 'data'
      reset: boolean
      packet: SamplePacket
      pointLimit: number
      pruneBeforeId: number
    }
  | { type: 'dispose' }
  | {
      type: 'statistics'
      requestId: number
      start: number
      end: number
      channels: string[]
      cursors: { a: number; b: number } | null
    }
  | RenderMessage

let renderer: PlotRenderer | null = null
let samples = new PlotBuffer<PlotSample>(1000)
let pending: RenderMessage | null = null
let queued = false
let failed = false
let backend = 'canvas'
const geometry = new GeometryCache()
const statistics = new StatisticsCache()

function fail(error: unknown): void {
  if (failed) return
  failed = true
  renderer?.dispose()
  renderer = null
  self.postMessage({
    type: 'failed',
    reason: error instanceof Error ? error.message : String(error)
  })
}

function draw(message: RenderMessage): void {
  if (!renderer || failed) return
  const started = performance.now()
  if (samples.length && samples.at(0)!.id > message.endId) return
  let low = 0,
    high = samples.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (samples.at(mid)!.id <= message.endId) low = mid + 1
    else high = mid
  }
  const end = Math.max(0, Math.min(samples.length - 1, low - 1))
  const start =
    message.xMode === 'time'
      ? indexAtTime(samples, message.timeStart)
      : Math.max(0, end - message.xWindowPoints + 1)
  const xMin =
    message.xMode === 'time'
      ? message.timeStart
      : (samples.at(end)?.id ?? 0) - message.xWindowPoints + 1
  const xMax =
    message.xMode === 'time'
      ? message.timeStart + message.timeSpan
      : xMin + Math.max(1, message.xWindowPoints - 1)
  const blocks = geometry.build(samples, {
    start,
    end,
    width: message.width * 0.812,
    xMin,
    xMax,
    xMode: message.xMode,
    lineMode: message.lineMode,
    channels: message.channels
  })
  renderer.render({ ...message, xMin, xMax, lineWidth: message.lineWidth || 1.5 }, blocks)
  self.postMessage({
    type: 'frame',
    xSpan: xMax - xMin,
    yMin: message.yMin,
    yMax: message.yMax,
    requestId: message.requestId,
    backend,
    duration: performance.now() - started,
    segments: blocks.reduce((sum, block) => sum + block.segments.length / 4, 0)
  })
}

self.onmessage = (event: MessageEvent<Message>): void => {
  const message = event.data
  try {
    if (message.type === 'init') {
      backend = message.mode === 'canvas' ? 'canvas' : 'webgl2'
      renderer =
        backend === 'canvas'
          ? new CanvasRenderer(message.canvas)
          : new WebGLRenderer(message.canvas)
      message.canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault()
        fail(new Error('GPU context lost'))
      })
      self.postMessage({ type: 'ready', backend })
    } else if (message.type === 'data') {
      if (message.reset || message.pointLimit !== samples.capacity) {
        const retained = message.reset ? [] : samples.slice(-message.pointLimit)
        samples = new PlotBuffer(message.pointLimit)
        for (const sample of retained) samples.push(sample)
        geometry.clear()
        statistics.clear()
      }
      for (const sample of unpackSamples(message.packet)) samples.push(sample)
    } else if (message.type === 'render') {
      pending = message
      if (queued || failed) return
      queued = true
      self.requestAnimationFrame(() => {
        queued = false
        const next = pending
        pending = null
        try {
          if (next) draw(next)
        } catch (error) {
          fail(error)
        }
      })
    } else if (message.type === 'statistics') {
      self.postMessage({
        type: 'statistics',
        requestId: message.requestId,
        window: statistics.measure(samples, message.start, message.end, message.channels),
        measurement: message.cursors
          ? statistics.measure(samples, message.cursors.a, message.cursors.b, message.channels)
          : null
      })
    } else {
      renderer?.dispose()
      renderer = null
      geometry.clear()
      self.close()
    }
  } catch (error) {
    fail(error)
  }
}

export {}
