/// <reference lib="webworker" />

import { PlotBuffer, plotVertices, type PlotSample } from '../plot-data'
type InitMessage = { type: 'init'; canvas: OffscreenCanvas }
type DataMessage = {
  type: 'data'
  reset: boolean
  samples: PlotSample[]
  pointLimit: number
  pruneBeforeId: number
}
type RenderMessage = {
  type: 'render'
  width: number
  height: number
  dpr: number
  xWindowPoints: number
  endOffset: number
  yMin: number
  yMax: number
  channels: { name: string; color: string; port: string }[]
  xMode: 'time' | 'points'
  timeStart: number
  timeSpan: number
  lineMode: 'linear' | 'step'
}
type Message = InitMessage | DataMessage | RenderMessage

const plotLeft = 28
const plotRight = 910
const plotTop = 20
const plotBottom = 365
const plotWidth = plotRight - plotLeft
const plotHeight = plotBottom - plotTop

let canvas: OffscreenCanvas | null = null
let context: OffscreenCanvasRenderingContext2D | null = null
let samples = new PlotBuffer<PlotSample>(1000)
let pendingRender: RenderMessage | null = null
let renderQueued = false

function draw(message: RenderMessage): void {
  if (!canvas || !context) return
  const width = Math.max(1, Math.round(message.width * message.dpr))
  const height = Math.max(1, Math.round(message.height * message.dpr))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  context.setTransform(
    message.dpr * (message.width / 1000),
    0,
    0,
    message.dpr * (message.height / 420),
    0,
    0
  )
  context.clearRect(0, 0, 1000, 420)
  const liveEndIndex = Math.max(0, samples.length - 1)
  const endIndex = Math.max(0, Math.min(liveEndIndex, liveEndIndex + message.endOffset))
  const viewStartIndex = endIndex - message.xWindowPoints + 1
  const firstIndex = Math.max(0, viewStartIndex - 1)
  const lastIndex = Math.min(samples.length, endIndex + 2)
  const ySpan = Math.max(Number.EPSILON, message.yMax - message.yMin)
  context.save()
  context.beginPath()
  context.rect(plotLeft, plotTop, plotWidth, plotHeight)
  context.clip()
  context.lineWidth = 2.5 * (1000 / Math.max(message.width, 1))
  context.lineJoin = 'round'
  context.lineCap = 'round'
  for (const channel of message.channels) {
    const points = plotVertices(
      samples,
      channel.name,
      channel.port,
      firstIndex,
      lastIndex - 1,
      message.width,
      (sample, index) =>
        message.xMode === 'time'
          ? (sample.timestamp - message.timeStart) / message.timeSpan
          : (index - viewStartIndex) / Math.max(1, message.xWindowPoints - 1)
    )
    if (!points.length) continue
    context.beginPath()
    let drawing = false
    let previousY = 0
    for (const point of points) {
      const x =
        plotLeft +
        (message.xMode === 'time'
          ? (point.timestamp - message.timeStart) / message.timeSpan
          : (point.index - viewStartIndex) / Math.max(1, message.xWindowPoints - 1)) *
          plotWidth
      const y = plotBottom - ((point.value - message.yMin) / ySpan) * plotHeight
      if (!drawing || point.move) context.moveTo(x, y)
      else {
        if (message.lineMode === 'step') context.lineTo(x, previousY)
        context.lineTo(x, y)
      }
      previousY = y
      drawing = true
    }
    context.strokeStyle = channel.color
    context.stroke()
  }
  context.restore()
}

function queueRender(message: RenderMessage): void {
  pendingRender = message
  if (renderQueued) return
  renderQueued = true
  self.requestAnimationFrame(() => {
    renderQueued = false
    const next = pendingRender
    pendingRender = null
    if (next) draw(next)
  })
}

self.onmessage = (event: MessageEvent<Message>): void => {
  const message = event.data
  if (message.type === 'init') {
    canvas = message.canvas
    context = canvas.getContext('2d')
    return
  }
  if (message.type === 'data') {
    if (message.reset || samples.capacity !== message.pointLimit) {
      const retained = message.reset ? [] : samples.slice(-message.pointLimit)
      samples = new PlotBuffer(message.pointLimit)
      for (const sample of retained) samples.push(sample)
    }
    for (const sample of message.samples) samples.push(sample)
    return
  }
  queueRender(message)
}

export {}
