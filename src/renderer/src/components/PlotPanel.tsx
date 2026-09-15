import { PlotStore } from '../plot-store'
import { ClearActionIcon } from './ClearActionIcon'
import { settlingTime } from '../settling-time'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { PlotBuffer, measurePlot, plotVertices, type PlotSample as Sample } from '../plot-data'
import { FloatingPanel } from './FloatingPanel'
import { ProgramCodeEditor } from './ProgramCodeEditor'
import { defaultPlotProgram } from '../plot-program'
import { compileProgramSource } from '../scripts/program-source'

type Props = { store: PlotStore; enabledPorts: string[]; embedded?: boolean }
type PlotColors = { background: string; grid: string; series: string[] }
type YRange = { min: number; max: number }
type HoverValue = { name: string; color: string; value: number; y: number }
type HoverState = { x: number; timestamp: number; pointOffset: number; values: HoverValue[] }
type AxisCursor =
  { axis: 'x'; x: number; pointOffset: number } | { axis: 'y'; y: number; value: number }
type XRangeDrag = {
  mode: 'start' | 'pan' | 'end'
  x: number
  start: number
  end: number
  domainMin: number
  domainMax: number
}
type PidSettings = {
  enabled: boolean
  channel: string
  target: number
  kp: number
  ki: number
  kd: number
  windowSeconds: number
  direction: 'direct' | 'reverse'
  deadband: number
  outputMin: number
  outputMax: number
  antiWindup: boolean
  integralLimit: number
  derivativeFilterHz: number
}

const defaultSeriesColors = [
  '#2563eb',
  '#06b6d4',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#64748b'
]
const defaultPlotColors: PlotColors = {
  background: '#ffffff',
  grid: '#e8edf4',
  series: defaultSeriesColors
}
const plotColorsKey = 'serialflow.plotColors'
const plotHeightKey = 'serialflow.plotPanelHeight'
const xWindowKey = 'serialflow.plotXWindowPoints'
const disabledChannelsKey = 'serialflow.plotDisabledChannels'
const pidSettingsKey = 'serialflow.plotPidSettings'
const defaultPlotHeight = 260
const maxPlotPoints = 100000
const plotLeft = 28
const plotRight = 910
const plotTop = 20
const plotBottom = 365
const plotWidth = plotRight - plotLeft
const plotHeight = plotBottom - plotTop

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function firstIndexAfterId(items: PlotBuffer<Sample>, id: number): number {
  let low = 0,
    high = items.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (items.at(middle)!.id <= id) low = middle + 1
    else high = middle
  }
  return low
}

function isColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
}

function loadPlotColors(): PlotColors {
  try {
    const saved = JSON.parse(
      localStorage.getItem(plotColorsKey) || 'null'
    ) as Partial<PlotColors> | null
    return {
      background: isColor(saved?.background) ? saved.background : defaultPlotColors.background,
      grid: isColor(saved?.grid) ? saved.grid : defaultPlotColors.grid,
      series: defaultSeriesColors.map((color, index) =>
        isColor(saved?.series?.[index]) ? saved.series[index] : color
      )
    }
  } catch {
    return { ...defaultPlotColors, series: [...defaultSeriesColors] }
  }
}

function loadPlotHeight(): number {
  const saved = Number(localStorage.getItem(plotHeightKey))
  return Number.isFinite(saved) ? clamp(saved, 160, 520) : defaultPlotHeight
}

function loadXWindow(pointLimit: number): number {
  const saved = Number(localStorage.getItem(xWindowKey))
  return Number.isFinite(saved) ? clamp(Math.round(saved), 1, pointLimit) : pointLimit
}

function loadDisabledChannels(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(disabledChannelsKey) || '[]') as unknown
    return new Set(
      Array.isArray(saved)
        ? saved.filter((value): value is string => typeof value === 'string')
        : []
    )
  } catch {
    return new Set()
  }
}

function loadPidSettings(): PidSettings {
  const defaults: PidSettings = {
    enabled: false,
    channel: '',
    target: 0,
    kp: 1,
    ki: 0,
    kd: 0,
    windowSeconds: 5,
    direction: 'direct',
    deadband: 0,
    outputMin: -1000,
    outputMax: 1000,
    antiWindup: true,
    integralLimit: 1000,
    derivativeFilterHz: 10
  }
  try {
    const saved = JSON.parse(
      localStorage.getItem(pidSettingsKey) || 'null'
    ) as Partial<PidSettings> | null
    if (!saved) return defaults
    const outputMin = Number.isFinite(saved.outputMin)
      ? Number(saved.outputMin)
      : defaults.outputMin
    const outputMax = Number.isFinite(saved.outputMax)
      ? Number(saved.outputMax)
      : defaults.outputMax
    return {
      enabled: saved.enabled === true,
      channel: typeof saved.channel === 'string' ? saved.channel : '',
      target: Number.isFinite(saved.target) ? Number(saved.target) : defaults.target,
      kp: Math.max(0, Number(saved.kp) || 0),
      ki: Math.max(0, Number(saved.ki) || 0),
      kd: Math.max(0, Number(saved.kd) || 0),
      windowSeconds: clamp(Number(saved.windowSeconds) || defaults.windowSeconds, 1, 60),
      direction: saved.direction === 'reverse' ? 'reverse' : 'direct',
      deadband: Math.max(0, Number(saved.deadband) || 0),
      outputMin: Math.min(outputMin, outputMax),
      outputMax: Math.max(outputMin, outputMax),
      antiWindup: saved.antiWindup !== false,
      integralLimit: Math.max(0, Number(saved.integralLimit) || defaults.integralLimit),
      derivativeFilterHz: clamp(
        Number(saved.derivativeFilterHz) || defaults.derivativeFilterHz,
        0.01,
        1000
      )
    }
  } catch {
    return defaults
  }
}

function formatTime(timestamp: number, windowMs: number): string {
  const date = new Date(timestamp)
  const base = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
  return windowMs <= 60000 ? `${base}.${String(date.getMilliseconds()).padStart(3, '0')}` : base
}

function formatAxisValue(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  if ((absolute > 0 && absolute < 0.001) || absolute >= 100000) return value.toExponential(2)
  return Number(value.toPrecision(5)).toLocaleString()
}

export function PlotPanel({ store, enabledPorts, embedded = false }: Props): React.JSX.Element {
  const [paused, setPaused] = useState(false)
  const [frozenSamples, setFrozenSamples] = useState<PlotBuffer<Sample> | null>(null)
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('serialflow.plotCollapsed') === 'true'
  )
  const [height, setHeight] = useState(loadPlotHeight)
  const [plotColors, setPlotColors] = useState(loadPlotColors)
  const [resizing, setResizing] = useState(false)
  const [pointLimit, setPointLimit] = useState(() =>
    clamp(
      Math.floor(Number(localStorage.getItem('serialflow.plotPointLimit')) || 1000),
      100,
      maxPlotPoints
    )
  )
  const [startId, setStartId] = useState(0)
  const [xMode, setXMode] = useState<'time' | 'points'>('points')
  const [lineMode, setLineMode] = useState<'linear' | 'step'>('linear')
  const [yAutoMode, setYAutoMode] = useState<'full' | 'robust'>('full')
  const [cursors, setCursors] = useState<{ a: number; b: number } | null>(null)
  const cursorDrag = useRef<'a' | 'b' | null>(null)
  const [activeCursor, setActiveCursor] = useState<'a' | 'b'>('a')
  const measurementWindow = useRef<number | null>(null)
  const [xWindowPoints, setXWindowPoints] = useState(() => loadXWindow(pointLimit))
  const [viewEndIndex, setViewEndIndex] = useState<number | null>(null)
  const [manualYRange, setManualYRange] = useState<YRange | null>(null)
  const [hoverState, setHover] = useState<HoverState | null>(null)
  const [hoveredAxis, setHoveredAxis] = useState<'x' | 'y' | null>(null)
  const [axisCursor, setAxisCursor] = useState<AxisCursor | null>(null)
  const [timelineDragging, setTimelineDragging] = useState(false)
  const [disabledChannels, setDisabledChannels] = useState(loadDisabledChannels)
  const [pidSettings, setPidSettings] = useState(loadPidSettings)
  const [canvasWidth, setCanvasWidth] = useState(1000)
  const [openPanel, setOpenPanel] = useState<'settings' | 'colors' | 'pid' | 'program' | null>(null)
  const [programDraft, setProgramDraft] = useState(() => ({
    enabled: store.program.enabled,
    source: store.program.source || defaultPlotProgram
  }))
  const [programSaveError, setProgramSaveError] = useState('')
  const [programSaving, setProgramSaving] = useState(false)
  const resizeStart = useRef({ y: 0, height: defaultPlotHeight, max: 520 })
  const plotCanvasRef = useRef<HTMLDivElement | null>(null)
  const curveCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const plotWorkerRef = useRef<Worker | null>(null)
  const workerRenderingRef = useRef(false)
  const transferredCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const workerSyncRef = useRef({ key: '', lastId: 0 })
  const hoverFrameRef = useRef(0)
  const axisCursorFrameRef = useRef(0)
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null)
  const pidButtonRef = useRef<HTMLButtonElement | null>(null)
  const latestHeight = useRef(height)
  const xDrag = useRef<{ x: number; end: number } | null>(null)
  const xRangeDrag = useRef<XRangeDrag | null>(null)
  const yDrag = useRef<{ y: number; range: YRange } | null>(null)
  const closeFloatingPanel = useCallback(() => setOpenPanel(null), [])

  useEffect(() => {
    const canvas = plotCanvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(([entry]) =>
      setCanvasWidth(Math.max(1, entry.contentRect.width))
    )
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [collapsed])

  const revision = useSyncExternalStore(
    paused ? () => () => {} : store.subscribe,
    paused ? () => 0 : store.getSnapshot
  )
  useEffect(() => {
    store.configure(enabledPorts, pointLimit)
  }, [store, enabledPorts, pointLimit])
  useEffect(() => {
    setCursors(null)
    setPaused(false)
    setFrozenSamples(null)
    setViewEndIndex(null)
    setHover(null)
  }, [enabledPorts, pointLimit])
  const allSamples = paused && frozenSamples ? frozenSamples : store.samples
  const liveEndIndex = Math.max(0, allSamples.length - 1)
  const endIndex = clamp(viewEndIndex ?? liveEndIndex, 0, liveEndIndex)
  const viewStartIndex = endIndex - xWindowPoints + 1
  const startIndex = Math.max(0, viewStartIndex)
  const visibleCount = Math.min(allSamples.length, Math.max(0, endIndex - startIndex + 1))
  // The ring mutates in place; revision invalidates derived views once per presentation batch.
  const channelNames = useMemo(() => {
    void revision
    return [...store.channels.keys()]
  }, [store, revision])
  const activeChannelNames = useMemo(
    () => channelNames.filter((name) => !disabledChannels.has(name)),
    [channelNames, disabledChannels]
  )
  const windowStatistics = useMemo(() => {
    void revision
    return measurePlot(allSamples, startIndex, endIndex, activeChannelNames)
  }, [allSamples, revision, startIndex, endIndex, activeChannelNames])
  const autoYRange = useMemo<YRange>(() => {
    let min = Infinity,
      max = -Infinity
    if (yAutoMode === 'robust') {
      const values = allSamples
        .slice(startIndex, endIndex + 1)
        .flatMap((sample) =>
          activeChannelNames.flatMap((name) =>
            Number.isFinite(sample.values[name]) ? [sample.values[name]] : []
          )
        )
        .sort((a, b) => a - b)
      if (values.length) {
        const trim = values.length >= 40 ? Math.max(1, Math.floor(values.length * 0.01)) : 0
        min = values[trim]
        max = values[values.length - 1 - trim]
      }
    } else
      for (const item of Object.values(windowStatistics))
        if (item.count) {
          min = Math.min(min, item.min)
          max = Math.max(max, item.max)
        }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: -1, max: 1 }
    const padding = (max - min || Math.max(Math.abs(max), 1)) * 0.1
    return { min: min - padding, max: max + padding }
  }, [windowStatistics, yAutoMode, allSamples, startIndex, endIndex, activeChannelNames])
  const yRange = manualYRange ?? autoYRange
  const ySpan = Math.max(Number.EPSILON, yRange.max - yRange.min)
  const valueToY = useCallback(
    (value: number) => plotBottom - ((value - yRange.min) / ySpan) * plotHeight,
    [yRange.min, ySpan]
  )
  const timeStart = allSamples.at(startIndex)?.timestamp ?? 0
  const timeEnd = allSamples.at(endIndex)?.timestamp ?? timeStart
  const timeSpan = Math.max(1, timeEnd - timeStart)
  const indexToX = (index: number): number =>
    plotLeft +
    (xMode === 'time'
      ? ((allSamples.at(index)?.timestamp ?? timeStart) - timeStart) / timeSpan
      : (index - viewStartIndex) / Math.max(1, xWindowPoints - 1)) *
      plotWidth
  const xToIndex = (x: number): number => {
    const ratio = clamp((x - plotLeft) / plotWidth, 0, 1)
    if (xMode === 'points')
      return clamp(
        Math.round(viewStartIndex + ratio * Math.max(0, xWindowPoints - 1)),
        startIndex,
        endIndex
      )
    const target = timeStart + ratio * timeSpan
    let low = startIndex,
      high = endIndex
    while (low < high) {
      const mid = (low + high) >>> 1
      if (allSamples.at(mid)!.timestamp < target) low = mid + 1
      else high = mid
    }
    return low > startIndex &&
      target - allSamples.at(low - 1)!.timestamp < allSamples.at(low)!.timestamp - target
      ? low - 1
      : low
  }
  const series = useMemo(
    () =>
      activeChannelNames.map((name) => {
        const stats = windowStatistics[name]
        const colorIndex = channelNames.indexOf(name)
        return {
          name,
          colorIndex,
          color: plotColors.series[colorIndex],
          min: stats.count ? stats.min : 0,
          max: stats.count ? stats.max : 0,
          latest: stats.latest ?? NaN,
          renderPoints: workerRenderingRef.current
            ? []
            : plotVertices(
                allSamples,
                name,
                store.channels.get(name) || '',
                startIndex - 1,
                endIndex + 1,
                canvasWidth,
                (sample, index) =>
                  xMode === 'time'
                    ? (sample.timestamp - timeStart) / timeSpan
                    : (index - viewStartIndex) / Math.max(1, xWindowPoints - 1)
              )
        }
      }),
    [
      activeChannelNames,
      windowStatistics,
      channelNames,
      plotColors.series,
      allSamples,
      store,
      startIndex,
      endIndex,
      canvasWidth,
      xMode,
      timeStart,
      timeSpan,
      viewStartIndex,
      xWindowPoints
    ]
  )

  const measurement = useMemo(
    () => (cursors ? measurePlot(allSamples, cursors.a, cursors.b, activeChannelNames) : null),
    [allSamples, cursors, activeChannelNames]
  )
  const hoverIndex = hoverState ? xToIndex(hoverState.x) : 0
  const hover =
    hoverState && allSamples.length
      ? {
          ...hoverState,
          timestamp: allSamples.at(hoverIndex)?.timestamp ?? 0,
          pointOffset: hoverIndex - liveEndIndex,
          values: series.flatMap<HoverValue>((item) => {
            const value = allSamples.at(hoverIndex)?.values[item.name]
            return Number.isFinite(value)
              ? [{ name: item.name, color: item.color, value: value!, y: valueToY(value!) }]
              : []
          })
        }
      : null
  const beginMeasurement = (): void => {
    if (cursors) {
      setCursors(null)
      return
    }
    if (!visibleCount) return
    measurementWindow.current = xWindowPoints
    if (visibleCount < xWindowPoints) setXWindowPoints(Math.max(1, visibleCount))
    if (!paused) {
      setFrozenSamples(store.freeze())
      setPaused(true)
    }
    setCursors({
      a: startIndex + Math.floor((endIndex - startIndex) / 3),
      b: startIndex + Math.ceil(((endIndex - startIndex) * 2) / 3)
    })
    setHover(null)
    setActiveCursor('a')
  }
  const changeCursor = (which: 'a' | 'b', index: number): void => {
    if (!Number.isFinite(index)) return
    const next = clamp(Math.round(index), 0, liveEndIndex)
    setCursors((current) => (current ? { ...current, [which]: next } : null))
    if (next < startIndex || next > endIndex)
      setViewEndIndex(Math.min(liveEndIndex, next + Math.floor(xWindowPoints / 2)))
  }
  const moveMeasurement = (event: React.PointerEvent<SVGElement>, which: 'a' | 'b'): void => {
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
    if (rect) changeCursor(which, xToIndex(((event.clientX - rect.left) / rect.width) * 1000))
  }

  const timelineSpan = Math.max(1, pointLimit - 1)
  const timelineEndPercent = clamp(
    ((pointLimit - allSamples.length + endIndex) / timelineSpan) * 100,
    0,
    100
  )
  const timelineStartPercent = clamp(
    timelineEndPercent - ((xWindowPoints - 1) / timelineSpan) * 100,
    0,
    100
  )
  const timelineHandlesOverlap = timelineEndPercent - timelineStartPercent < 2.5

  useEffect(() => {
    const target = curveCanvasRef.current
    if (!target || transferredCanvasRef.current === target) return
    if (typeof target.transferControlToOffscreen !== 'function') return
    const worker =
      plotWorkerRef.current ||
      new Worker(new URL('../workers/plot.worker.ts', import.meta.url), { type: 'module' })
    plotWorkerRef.current = worker
    const offscreen = target.transferControlToOffscreen()
    worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen])
    transferredCanvasRef.current = target
    workerRenderingRef.current = true
  }, [collapsed, series.length])

  useEffect(() => {
    const worker = plotWorkerRef.current
    if (!workerRenderingRef.current || !worker) return
    const syncKey = `${paused ? 'paused' : 'live'}\u0000${startId}\u0000${enabledPorts.join('\u0000')}`
    const previous = workerSyncRef.current
    const lastId = allSamples.at(-1)?.id || 0
    const reset = previous.key !== syncKey || lastId < previous.lastId || !allSamples.length
    const additionStart = reset ? 0 : firstIndexAfterId(allSamples, previous.lastId)
    worker.postMessage({
      type: 'data',
      reset,
      samples: allSamples.slice(additionStart),
      pointLimit,
      pruneBeforeId: allSamples.at(0)?.id || 0
    })
    workerSyncRef.current = { key: syncKey, lastId }
  }, [allSamples, revision, enabledPorts, paused, pointLimit, startId])

  useEffect(() => {
    const worker = plotWorkerRef.current
    const host = plotCanvasRef.current
    if (!workerRenderingRef.current || !worker || !host || collapsed || !series.length) return
    const rect = host.getBoundingClientRect()
    worker.postMessage({
      type: 'render',
      width: rect.width,
      height: rect.height,
      dpr: Math.min(window.devicePixelRatio || 1, 2),
      xWindowPoints,
      endOffset: endIndex - liveEndIndex,
      yMin: yRange.min,
      yMax: yRange.max,
      channels: series.map((item) => ({
        name: item.name,
        color: item.color,
        port: store.channels.get(item.name) || ''
      })),
      xMode,
      timeStart,
      timeSpan,
      lineMode
    })
  }, [
    collapsed,
    endIndex,
    height,
    liveEndIndex,
    series,
    xWindowPoints,
    yRange,
    xMode,
    timeStart,
    timeSpan,
    lineMode,
    store
  ])

  useEffect(() => {
    const canvas = curveCanvasRef.current
    const host = plotCanvasRef.current
    if (workerRenderingRef.current || !canvas || !host || collapsed || !series.length) return
    const rect = host.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const targetWidth = Math.max(1, Math.round(rect.width * dpr))
    const targetHeight = Math.max(1, Math.round(rect.height * dpr))
    if (canvas.width !== targetWidth) canvas.width = targetWidth
    if (canvas.height !== targetHeight) canvas.height = targetHeight
    const context = canvas.getContext('2d')
    if (!context) return
    const drawSpan = Math.max(Number.EPSILON, yRange.max - yRange.min)
    context.setTransform(dpr * (rect.width / 1000), 0, 0, dpr * (rect.height / 420), 0, 0)
    context.clearRect(0, 0, 1000, 420)
    context.save()
    context.beginPath()
    context.rect(plotLeft, plotTop, plotWidth, plotHeight)
    context.clip()
    context.lineWidth = 2.5 * (1000 / Math.max(rect.width, 1))
    context.lineJoin = 'round'
    context.lineCap = 'round'
    for (const item of series) {
      if (!item.renderPoints.length) continue
      context.beginPath()
      let drawing = false
      let previousY = 0
      item.renderPoints.forEach((point) => {
        const x =
          plotLeft +
          (xMode === 'time'
            ? (point.timestamp - timeStart) / timeSpan
            : (point.index - viewStartIndex) / Math.max(1, xWindowPoints - 1)) *
            plotWidth
        const y = plotBottom - ((point.value - yRange.min) / drawSpan) * plotHeight
        if (!drawing || point.move) context.moveTo(x, y)
        else {
          if (lineMode === 'step') context.lineTo(x, previousY)
          context.lineTo(x, y)
        }
        previousY = y
        drawing = true
      })
      context.strokeStyle = item.color
      context.stroke()
    }
    context.restore()
  }, [
    collapsed,
    endIndex,
    height,
    series,
    xWindowPoints,
    yRange,
    xMode,
    timeStart,
    timeSpan,
    lineMode,
    viewStartIndex
  ])
  const xTickCount = clamp(Math.floor(canvasWidth / 135) + 1, 6, 16)
  const xTicks = useMemo(() => {
    const count = Math.min(xTickCount, xWindowPoints)
    if (count <= 1) return [{ x: plotRight, pointOffset: endIndex - liveEndIndex }]
    return Array.from({ length: count }, (_, index) => {
      const ratio = index / (count - 1)
      return {
        x: plotLeft + ratio * plotWidth,
        pointOffset:
          Math.round(viewStartIndex + ratio * Math.max(0, xWindowPoints - 1)) - liveEndIndex
      }
    })
  }, [endIndex, liveEndIndex, viewStartIndex, xTickCount, xWindowPoints])
  const yTicks = useMemo(
    () =>
      Array.from({ length: 6 }, (_, index) => {
        const ratio = index / 5
        return {
          y: plotBottom - ratio * plotHeight,
          value: yRange.min + ratio * ySpan
        }
      }),
    [yRange.min, ySpan]
  )
  const pidChannel = channelNames.includes(pidSettings.channel)
    ? pidSettings.channel
    : channelNames[0] || ''
  const pidAnalysis = useMemo(() => {
    void revision
    if (!pidSettings.enabled || !pidChannel || !allSamples.length) return null
    const latest = allSamples.at(-1)?.timestamp || 0
    const cutoff = latest - pidSettings.windowSeconds * 1000
    const points = allSamples.flatMap((sample) =>
      sample.timestamp >= cutoff && Number.isFinite(sample.values[pidChannel])
        ? [{ timestamp: sample.timestamp, value: sample.values[pidChannel] }]
        : []
    )
    const current = points.at(-1)?.value
    if (current === undefined)
      return { ready: false as const, sampleCount: 0, message: '等待所选通道的实时数据' }
    if (points.length < 5)
      return {
        ready: false as const,
        sampleCount: points.length,
        current,
        message: `样本不足：至少需要 5 个，当前 ${points.length} 个`
      }
    const initial = points[0].value
    const target = pidSettings.target
    const initialError = target - initial
    const currentError = target - current
    const responseSpan = Math.max(Math.abs(initialError), Math.abs(target) * 0.01, 0.000001)
    const tolerance = Math.max(
      pidSettings.deadband,
      responseSpan * 0.03,
      Math.abs(target) * 0.005,
      0.000001
    )
    const errors = points.map((point) => target - point.value)
    const intervals = points
      .slice(1)
      .map((point, index) => point.timestamp - points[index].timestamp)
      .filter((interval) => interval > 0)
    const sortedIntervals = [...intervals].sort((left, right) => left - right)
    const samplePeriodMs = sortedIntervals.length
      ? sortedIntervals[Math.floor(sortedIntervals.length / 2)]
      : 10
    const meanInterval = intervals.length
      ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length
      : samplePeriodMs
    const intervalDeviation = intervals.length
      ? Math.sqrt(
          intervals.reduce((sum, value) => sum + (value - meanInterval) ** 2, 0) / intervals.length
        )
      : 0
    const sampleJitter = meanInterval > 0 ? intervalDeviation / meanInterval : 0

    let integral = 0
    let filteredDerivative = 0
    let previousError = 0
    let previousTimestamp = points[0].timestamp
    let antiWindupActive = false
    let pTerm = 0
    let iTerm = 0
    let dTerm = 0
    let controlOutput = 0
    const outputMin = Math.min(pidSettings.outputMin, pidSettings.outputMax)
    const outputMax = Math.max(pidSettings.outputMin, pidSettings.outputMax)
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]
      const rawError = target - point.value
      const directedError = (pidSettings.direction === 'direct' ? 1 : -1) * rawError
      const error = Math.abs(rawError) <= pidSettings.deadband ? 0 : directedError
      const timestampDt = index ? (point.timestamp - previousTimestamp) / 1000 : 0
      const measuredDt = timestampDt > 0 ? timestampDt : samplePeriodMs / 1000
      const dt = clamp(measuredDt, 0.000001, Math.max(0.001, (samplePeriodMs / 1000) * 5))
      const rawDerivative = index ? (error - previousError) / dt : 0
      const filterAlpha = Math.exp(-2 * Math.PI * pidSettings.derivativeFilterHz * dt)
      filteredDerivative = filterAlpha * filteredDerivative + (1 - filterAlpha) * rawDerivative
      const previousIntegral = integral
      integral = clamp(integral + error * dt, -pidSettings.integralLimit, pidSettings.integralLimit)
      pTerm = pidSettings.kp * error
      iTerm = pidSettings.ki * integral
      dTerm = pidSettings.kd * filteredDerivative
      const unsaturated = pTerm + iTerm + dTerm
      controlOutput = clamp(unsaturated, outputMin, outputMax)
      const drivesFurtherIntoSaturation =
        (unsaturated > outputMax && error > 0) || (unsaturated < outputMin && error < 0)
      if (pidSettings.antiWindup && drivesFurtherIntoSaturation) {
        integral = previousIntegral
        iTerm = pidSettings.ki * integral
        controlOutput = clamp(pTerm + iTerm + dTerm, outputMin, outputMax)
        antiWindupActive = true
      }
      previousError = error
      previousTimestamp = point.timestamp
    }

    let crossings = 0
    for (let index = 1; index < errors.length; index += 1) {
      if (
        Math.abs(errors[index - 1]) > tolerance &&
        Math.abs(errors[index]) > tolerance &&
        Math.sign(errors[index - 1]) !== Math.sign(errors[index])
      )
        crossings += 1
    }
    const direction = Math.sign(initialError) || 1
    const overshoot = points.reduce(
      (maximum, point) => Math.max(maximum, (point.value - target) * direction),
      0
    )
    const overshootRatio = overshoot / responseSpan
    const tail = errors.slice(-Math.max(3, Math.ceil(errors.length * 0.25)))
    const tailMeanError = tail.reduce((sum, value) => sum + value, 0) / tail.length
    const progress = 1 - Math.abs(currentError) / responseSpan

    const baselineCount = Math.max(3, Math.min(10, Math.floor(points.length * 0.12)))
    const baselinePoints = points.slice(0, baselineCount)
    const baseline =
      baselinePoints.reduce((sum, point) => sum + point.value, 0) / baselinePoints.length
    const baselineNoise = Math.sqrt(
      baselinePoints.reduce((sum, point) => sum + (point.value - baseline) ** 2, 0) /
        baselinePoints.length
    )
    const stepAmplitude = target - baseline
    const stepThreshold = Math.max(baselineNoise * 3, Math.abs(stepAmplitude) * 0.02, tolerance)
    const stepIndex = points.findIndex(
      (point, index) => index >= baselineCount && Math.abs(point.value - baseline) >= stepThreshold
    )
    const normalizedResponse = (value: number): number =>
      Math.abs(stepAmplitude) > 0.000001 ? (value - baseline) / stepAmplitude : 0
    const findResponseTime = (level: number): number | null => {
      if (stepIndex < 0) return null
      const point = points
        .slice(stepIndex)
        .find((candidate) => normalizedResponse(candidate.value) >= level)
      return point ? point.timestamp : null
    }
    const time10 = findResponseTime(0.1)
    const time90 = findResponseTime(0.9)
    const riseTimeMs = time10 !== null && time90 !== null ? Math.max(0, time90 - time10) : null
    const settlingTimeMs = settlingTime(points, stepIndex, target, tolerance)
    const durationMs = Math.max(1, points.at(-1)!.timestamp - points[0].timestamp)
    const noiseRatio = baselineNoise / Math.max(Math.abs(stepAmplitude), 0.000001)
    const sampleScore = clamp(points.length / 50, 0, 1)
    const durationScore = clamp(durationMs / (pidSettings.windowSeconds * 1000 * 0.8), 0, 1)
    const signalScore = clamp(1 - noiseRatio * 8, 0, 1)
    const regularityScore = clamp(1 - sampleJitter * 2, 0, 1)
    const responseScore = clamp(
      points.reduce((maximum, point) => Math.max(maximum, normalizedResponse(point.value)), 0),
      0,
      1
    )
    const identificationConfidence = Math.round(
      (sampleScore * 0.2 +
        durationScore * 0.15 +
        signalScore * 0.25 +
        regularityScore * 0.2 +
        responseScore * 0.2) *
        100
    )
    let pFactor = 0
    let iFactor = 0
    let dFactor = 0
    const reasons: string[] = []
    if (crossings >= 3) {
      pFactor -= 0.1
      iFactor -= 0.15
      dFactor += 0.1
      reasons.push(`检测到 ${crossings} 次过零振荡，建议降低 P/I、提高 D`)
    } else if (overshootRatio > 0.1) {
      pFactor -= 0.05
      iFactor -= 0.08
      dFactor += 0.08
      reasons.push(`超调约 ${(overshootRatio * 100).toFixed(1)}%，建议抑制超调`)
    }
    if (Math.abs(currentError) > tolerance && crossings < 3) {
      if (progress < 0.3) {
        pFactor += 0.08
        iFactor += 0.04
        reasons.push('误差收敛较慢，建议小幅提高 P/I')
      } else if (Math.abs(tailMeanError) > tolerance) {
        iFactor += 0.06
        reasons.push('存在持续稳态误差，建议小幅提高 I')
      }
    }
    if (!reasons.length) reasons.push('当前响应接近目标，建议保持参数并继续观察')
    if (sampleJitter > 0.1)
      reasons.push(`采样周期抖动 ${(sampleJitter * 100).toFixed(1)}%，计算已按实际 Δt 补偿`)
    if (identificationConfidence < 50)
      reasons.push('阶跃辨识可信度偏低，建议延长窗口或提高阶跃信噪比')
    const recommendation = (
      name: 'P' | 'I' | 'D',
      value: number,
      factor: number
    ): { name: 'P' | 'I' | 'D'; current: number; delta: number; next: number } => {
      const delta = (value > 0 ? value : 0.1) * clamp(factor, -0.5, 0.5)
      return { name, current: value, delta, next: Math.max(0, value + delta) }
    }
    return {
      ready: true as const,
      sampleCount: points.length,
      current,
      error: currentError,
      controlOutput,
      pTerm,
      iTerm,
      dTerm,
      antiWindupActive,
      samplePeriodMs,
      sampleJitter,
      riseTimeMs,
      settlingTimeMs,
      identificationConfidence,
      overshootRatio,
      crossings,
      reasons,
      recommendations: [
        recommendation('P', pidSettings.kp, pFactor),
        recommendation('I', pidSettings.ki, iFactor),
        recommendation('D', pidSettings.kd, dFactor)
      ]
    }
  }, [allSamples, revision, pidChannel, pidSettings])

  const changePlotColors = (next: PlotColors): void => {
    setPlotColors(next)
    localStorage.setItem(plotColorsKey, JSON.stringify(next))
  }
  const changeSeriesColor = (index: number, color: string): void => {
    const seriesColors = [...plotColors.series]
    seriesColors[index] = color
    changePlotColors({ ...plotColors, series: seriesColors })
  }
  const toggleChannel = (name: string): void => {
    setDisabledChannels((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      localStorage.setItem(disabledChannelsKey, JSON.stringify([...next]))
      return next
    })
    setHover(null)
  }
  const updatePidSettings = (patch: Partial<PidSettings>): void => {
    const next = { ...pidSettings, ...patch }
    setPidSettings(next)
    localStorage.setItem(pidSettingsKey, JSON.stringify(next))
  }
  const beginResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const availableHeight = event.currentTarget.parentElement?.parentElement?.clientHeight || 700
    resizeStart.current = {
      y: event.clientY,
      height,
      max: Math.max(160, Math.min(520, availableHeight - 170))
    }
    latestHeight.current = height
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizing(true)
  }
  const resize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!resizing) return
    const next = clamp(
      resizeStart.current.height + event.clientY - resizeStart.current.y,
      160,
      resizeStart.current.max
    )
    latestHeight.current = next
    setHeight(next)
  }
  const finishResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!resizing) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    localStorage.setItem(plotHeightKey, String(latestHeight.current))
    setResizing(false)
  }
  const handleXWheel = (event: React.WheelEvent<SVGRectElement>): void => {
    event.preventDefault()
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
    if (!rect) return
    const pointerX = clamp(((event.clientX - rect.left) / rect.width) * 1000, plotLeft, plotRight)
    const ratio = (pointerX - plotLeft) / plotWidth
    const centerIndex = viewStartIndex + ratio * Math.max(0, xWindowPoints - 1)
    const next = Math.round(clamp(xWindowPoints * (event.deltaY > 0 ? 1.25 : 0.8), 1, pointLimit))
    const nextEnd = Math.round(
      clamp(centerIndex + (1 - ratio) * Math.max(0, next - 1), 0, liveEndIndex)
    )
    setXWindowPoints(next)
    setViewEndIndex(nextEnd >= liveEndIndex ? null : nextEnd)
    setAxisCursor({
      axis: 'x',
      x: pointerX,
      pointOffset: Math.round(centerIndex - liveEndIndex)
    })
    localStorage.setItem(xWindowKey, String(next))
  }
  const handleYWheel = (event: React.WheelEvent<SVGRectElement>): void => {
    event.preventDefault()
    const factor = event.deltaY > 0 ? 1.2 : 0.8
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
    if (!rect) return
    const pointerY = clamp(((event.clientY - rect.top) / rect.height) * 420, plotTop, plotBottom)
    const center = yRange.max - ((pointerY - plotTop) / plotHeight) * ySpan
    setManualYRange({
      min: center - (center - yRange.min) * factor,
      max: center + (yRange.max - center) * factor
    })
    setAxisCursor({ axis: 'y', y: pointerY, value: center })
  }
  const beginXDrag = (event: React.PointerEvent<SVGRectElement>): void => {
    event.preventDefault()
    xDrag.current = { x: event.clientX, end: endIndex }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveXDrag = (event: React.PointerEvent<SVGRectElement>): void => {
    if (!xDrag.current) return
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
    if (!rect) return
    const deltaPoints =
      ((event.clientX - xDrag.current.x) / rect.width) * (1000 / plotWidth) * xWindowPoints
    const next = Math.round(clamp(xDrag.current.end - deltaPoints, 0, liveEndIndex))
    setViewEndIndex(next >= liveEndIndex ? null : next)
  }
  const finishXDrag = (event: React.PointerEvent<SVGRectElement>): void => {
    if (!xDrag.current) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    xDrag.current = null
  }
  const beginYDrag = (event: React.PointerEvent<SVGRectElement>): void => {
    event.preventDefault()
    yDrag.current = { y: event.clientY, range: { ...yRange } }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveYDrag = (event: React.PointerEvent<SVGRectElement>): void => {
    if (!yDrag.current) return
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
    if (!rect) return
    const span = yDrag.current.range.max - yDrag.current.range.min
    const shift = -((event.clientY - yDrag.current.y) / rect.height) * (420 / plotHeight) * span
    setManualYRange({
      min: yDrag.current.range.min + shift,
      max: yDrag.current.range.max + shift
    })
  }
  const finishYDrag = (event: React.PointerEvent<SVGRectElement>): void => {
    if (!yDrag.current) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    yDrag.current = null
  }
  const moveXAxisCursor = (event: React.PointerEvent<SVGRectElement>): void => {
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
    if (rect) {
      const x = clamp(((event.clientX - rect.left) / rect.width) * 1000, plotLeft, plotRight)
      const pointOffset =
        xMode === 'time'
          ? xToIndex(x) - liveEndIndex
          : Math.round(
              viewStartIndex +
                ((x - plotLeft) / plotWidth) * Math.max(0, xWindowPoints - 1) -
                liveEndIndex
            )
      window.cancelAnimationFrame(axisCursorFrameRef.current)
      axisCursorFrameRef.current = window.requestAnimationFrame(() =>
        setAxisCursor({ axis: 'x', x, pointOffset })
      )
    }
    moveXDrag(event)
  }
  const moveYAxisCursor = (event: React.PointerEvent<SVGRectElement>): void => {
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
    if (rect) {
      const y = clamp(((event.clientY - rect.top) / rect.height) * 420, plotTop, plotBottom)
      const value = yRange.max - ((y - plotTop) / plotHeight) * ySpan
      window.cancelAnimationFrame(axisCursorFrameRef.current)
      axisCursorFrameRef.current = window.requestAnimationFrame(() =>
        setAxisCursor({ axis: 'y', y, value })
      )
    }
    moveYDrag(event)
  }
  const handlePlotHover = (event: React.PointerEvent<SVGRectElement>): void => {
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
    if (!rect || !series.length || !visibleCount) return setHover(null)
    const clientX = event.clientX
    window.cancelAnimationFrame(hoverFrameRef.current)
    hoverFrameRef.current = window.requestAnimationFrame(() => {
      const pointerX = clamp(((clientX - rect.left) / rect.width) * 1000, plotLeft, plotRight)
      const sampleIndex = xToIndex(pointerX)
      const pointerTime = allSamples.at(sampleIndex)?.timestamp ?? 0
      const values = series.flatMap<HoverValue>((item) => {
        const value = allSamples.at(sampleIndex)?.values[item.name]
        return Number.isFinite(value)
          ? [{ name: item.name, color: item.color, value: value!, y: valueToY(value!) }]
          : []
      })
      const pointOffset = sampleIndex - liveEndIndex
      setHover({ x: pointerX, timestamp: pointerTime, pointOffset, values })
    })
  }
  const beginXRangeDrag = (
    event: React.PointerEvent<HTMLElement>,
    mode: XRangeDrag['mode']
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    xRangeDrag.current = {
      mode,
      x: event.clientX,
      start: endIndex - xWindowPoints + 1,
      end: endIndex,
      domainMin: 0,
      domainMax: pointLimit - 1
    }
    setTimelineDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveXRangeDrag = (event: React.PointerEvent<HTMLElement>): void => {
    const drag = xRangeDrag.current
    if (!drag) return
    const rect = event.currentTarget.parentElement?.getBoundingClientRect()
    if (!rect) return
    const delta = Math.round(
      ((event.clientX - drag.x) / Math.max(rect.width, 1)) * Math.max(1, pointLimit - 1)
    )
    if (drag.mode === 'pan') {
      const nextEnd = Math.round(clamp(drag.end + delta, 0, liveEndIndex))
      setViewEndIndex(nextEnd >= liveEndIndex ? null : nextEnd)
      return
    }
    if (drag.mode === 'start') {
      const nextWindow = Math.round(clamp(drag.end - (drag.start + delta) + 1, 1, pointLimit))
      setXWindowPoints(nextWindow)
      localStorage.setItem(xWindowKey, String(nextWindow))
      return
    }
    const nextEnd = Math.round(clamp(drag.end + delta, 0, liveEndIndex))
    const nextWindow = Math.round(clamp(nextEnd - drag.start + 1, 1, pointLimit))
    setXWindowPoints(nextWindow)
    setViewEndIndex(nextEnd >= liveEndIndex ? null : nextEnd)
    localStorage.setItem(xWindowKey, String(nextWindow))
  }
  const finishXRangeDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (!xRangeDrag.current) return
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    xRangeDrag.current = null
    setTimelineDragging(false)
  }
  const clearPlotHover = (): void => {
    window.cancelAnimationFrame(hoverFrameRef.current)
    setHover(null)
  }

  useEffect(
    () => () => {
      window.cancelAnimationFrame(hoverFrameRef.current)
      window.cancelAnimationFrame(axisCursorFrameRef.current)
      plotWorkerRef.current?.terminate()
      plotWorkerRef.current = null
    },
    []
  )

  return (
    <section
      className={`plot-panel ${embedded ? 'embedded' : ''} ${collapsed ? 'collapsed' : ''} ${cursors ? 'measuring' : ''}`}
      style={
        embedded ? { height: collapsed ? 58 : cursors ? Math.max(460, height) : height } : undefined
      }
    >
      <header className="plot-toolbar plot-toolbar-compact">
        <div className="plot-heading">
          <strong>实时曲线</strong>
          <span>
            {allSamples.length.toLocaleString()} 个采样点 · {series.length} 个通道 ·{' '}
            {xWindowPoints.toLocaleString()} 点视窗 ·{' '}
            {paused ? '已冻结' : viewEndIndex === null ? '实时' : '历史'}
            {store.programError && (
              <span role="status" title={store.programError}>
                {' '}
                · 计算已停止，请检查计算通道设置
              </span>
            )}
          </span>
        </div>
        {!collapsed && (
          <div className="plot-side-controls" role="group" aria-label="曲线操作">
            <button
              aria-pressed={!!cursors}
              className={cursors ? 'active' : ''}
              disabled={!allSamples.length}
              title="冻结当前波形，拖动 A / B 测量并统计区间"
              onClick={beginMeasurement}
            >
              双游标
            </button>
            <button
              className={`plot-live-button ${viewEndIndex === null ? 'is-live' : ''}`}
              title="回到实时视窗"
              disabled={viewEndIndex === null}
              onClick={() => setViewEndIndex(null)}
            >
              {viewEndIndex === null ? '实时' : '回到实时'}
            </button>
            <button title="持续按当前视窗自动缩放 Y 轴" onClick={() => setManualYRange(null)}>
              Y 自动
            </button>
            <button
              className="plot-pause-button"
              aria-pressed={paused}
              title={paused ? '继续绘图' : '暂停绘图'}
              onClick={() => {
                if (!paused) setFrozenSamples(store.freeze())
                else {
                  if (measurementWindow.current !== null) {
                    setXWindowPoints(measurementWindow.current)
                    measurementWindow.current = null
                  }
                  setFrozenSamples(null)
                  setCursors(null)
                }
                setPaused((value) => !value)
              }}
            >
              {paused ? '继续' : '暂停'}
            </button>
            <button
              ref={pidButtonRef}
              title="PID 调参"
              aria-label="PID 调参"
              className={openPanel === 'pid' ? 'active' : ''}
              aria-expanded={openPanel === 'pid'}
              onClick={() => setOpenPanel((current) => (current === 'pid' ? null : 'pid'))}
            >
              PID
            </button>
            <button
              ref={settingsButtonRef}
              className={openPanel === 'settings' || openPanel === 'colors' ? 'active' : ''}
              aria-expanded={openPanel === 'settings' || openPanel === 'colors'}
              aria-haspopup="dialog"
              onClick={() =>
                setOpenPanel((current) =>
                  current === 'settings' || current === 'colors' ? null : 'settings'
                )
              }
            >
              设置
            </button>
            <button
              type="button"
              className="plot-clear-action clear-action-button"
              title="清空曲线"
              aria-label="清空曲线"
              onClick={() => {
                store.clear()
                setFrozenSamples(null)
                setPaused(false)
                setCursors(null)
                setViewEndIndex(null)
                setHover(null)
                setStartId((value) => value + 1)
                setOpenPanel(null)
              }}
            >
              <ClearActionIcon />
            </button>
            <FloatingPanel
              anchorRef={settingsButtonRef}
              open={openPanel === 'settings'}
              onClose={closeFloatingPanel}
            >
              <div className="plot-options-popover" role="dialog" aria-label="曲线设置">
                <strong>曲线设置</strong>
                <label>
                  绘图点数
                  <input
                    type="number"
                    min="100"
                    max={maxPlotPoints}
                    value={pointLimit}
                    onChange={(event) => {
                      const value = Math.min(
                        maxPlotPoints,
                        Math.max(100, Math.floor(Number(event.target.value) || 1000))
                      )
                      setPointLimit(value)
                      setXWindowPoints((current) => {
                        const next = current >= pointLimit ? value : Math.min(current, value)
                        localStorage.setItem(xWindowKey, String(next))
                        return next
                      })
                      localStorage.setItem('serialflow.plotPointLimit', String(value))
                    }}
                  />
                </label>
                <small>最多保留 100,000 个采样点</small>
                <span>X 轴</span>
                <div className="mini-segment" role="group" aria-label="曲线 X 轴模式">
                  <button
                    className={xMode === 'points' ? 'active' : ''}
                    aria-pressed={xMode === 'points'}
                    onClick={() => {
                      setXMode('points')
                      setHover(null)
                    }}
                  >
                    点序号
                  </button>
                  <button
                    className={xMode === 'time' ? 'active' : ''}
                    aria-pressed={xMode === 'time'}
                    onClick={() => {
                      setXMode('time')
                      setHover(null)
                    }}
                  >
                    时间
                  </button>
                </div>
                <small>时间轴使用电脑接收时间，设备采样周期需以设备时间戳为准。</small>
                <span>连线方式</span>
                <div className="mini-segment" role="group" aria-label="曲线连线方式">
                  <button
                    className={lineMode === 'linear' ? 'active' : ''}
                    aria-pressed={lineMode === 'linear'}
                    onClick={() => setLineMode('linear')}
                  >
                    直线
                  </button>
                  <button
                    className={lineMode === 'step' ? 'active' : ''}
                    aria-pressed={lineMode === 'step'}
                    onClick={() => setLineMode('step')}
                  >
                    阶梯
                  </button>
                </div>
                <span>Y 轴自动范围</span>
                <div className="mini-segment" role="group" aria-label="Y 轴自动范围">
                  <button
                    className={yAutoMode === 'full' ? 'active' : ''}
                    aria-pressed={yAutoMode === 'full'}
                    onClick={() => {
                      setYAutoMode('full')
                      setManualYRange(null)
                    }}
                  >
                    完整峰值
                  </button>
                  <button
                    className={yAutoMode === 'robust' ? 'active' : ''}
                    aria-pressed={yAutoMode === 'robust'}
                    onClick={() => {
                      setYAutoMode('robust')
                      setManualYRange(null)
                    }}
                  >
                    抑制异常
                  </button>
                </div>
                <small>
                  抑制异常模式在样本充足时忽略两端各 1% 的值来确定范围；测量统计始终包含原始峰值。
                </small>
                <button onClick={() => setOpenPanel('colors')}>曲线配色</button>
                <button onClick={() => setOpenPanel('program')}>计算通道</button>
                {store.programError && <small role="alert">计算已停止：{store.programError}</small>}
              </div>
            </FloatingPanel>
            <FloatingPanel
              anchorRef={settingsButtonRef}
              open={openPanel === 'program'}
              onClose={closeFloatingPanel}
            >
              <div className="plot-program-editor" role="dialog" aria-label="曲线计算通道">
                <strong>计算通道</strong>
                <div className="mini-segment" role="group" aria-label="曲线数据处理模式">
                  <button
                    className={!programDraft.enabled ? 'active' : ''}
                    onClick={() => setProgramDraft({ ...programDraft, enabled: false })}
                  >
                    普通模式
                  </button>
                  <button
                    className={programDraft.enabled ? 'active' : ''}
                    onClick={() => setProgramDraft({ ...programDraft, enabled: true })}
                  >
                    编程模式
                  </button>
                </div>
                <small>
                  对每个原始采样执行
                  process(data)，返回与数据窗口相同格式的结果数组。原始通道保留，计算通道名称包含单位；合计最多
                  8 个通道。可在图例隐藏原始 AD，单独查看 gf 量程。
                </small>
                {programDraft.enabled && (
                  <ProgramCodeEditor
                    aria-label="曲线计算程序"
                    value={programDraft.source}
                    onChange={(event) =>
                      setProgramDraft({ ...programDraft, source: event.target.value })
                    }
                  />
                )}
                <small>
                  程序按批处理全部采样，仅绘图降采样。超时或积压时停止计算并显示原始值。应用配置会清空旧曲线，避免混用不同公式的数据。
                </small>
                {(programSaveError || store.programError) && (
                  <p role="alert">{programSaveError || store.programError}</p>
                )}
                <button
                  disabled={programSaving}
                  onClick={async () => {
                    setProgramSaving(true)
                    try {
                      if (programDraft.enabled) {
                        if (!programDraft.source.trim()) throw new Error('请输入计算程序')
                        await compileProgramSource(programDraft.source)
                      }
                      localStorage.setItem('serialflow.plotProgram', JSON.stringify(programDraft))
                      store.configureProgram(programDraft.enabled, programDraft.source)
                      setPaused(false)
                      setFrozenSamples(null)
                      setCursors(null)
                      setHover(null)
                      setViewEndIndex(null)
                      setStartId((value) => value + 1)
                      setProgramSaveError('')
                      setOpenPanel(null)
                    } catch (cause) {
                      setProgramSaveError(cause instanceof Error ? cause.message : String(cause))
                    } finally {
                      setProgramSaving(false)
                    }
                  }}
                >
                  {programSaving ? '正在应用…' : '保存并应用'}
                </button>
              </div>
            </FloatingPanel>
            <FloatingPanel
              anchorRef={settingsButtonRef}
              open={openPanel === 'colors'}
              onClose={closeFloatingPanel}
            >
              <div className="plot-color-popover">
                <strong>实时曲线配色</strong>
                <div className="plot-color-grid">
                  <label>
                    背景
                    <input
                      type="color"
                      value={plotColors.background}
                      onChange={(event) =>
                        changePlotColors({ ...plotColors, background: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    网格
                    <input
                      type="color"
                      value={plotColors.grid}
                      onChange={(event) =>
                        changePlotColors({ ...plotColors, grid: event.target.value })
                      }
                    />
                  </label>
                  {plotColors.series.map((color, index) => (
                    <label key={index}>
                      曲线 {index + 1}
                      <input
                        type="color"
                        value={color}
                        onChange={(event) => changeSeriesColor(index, event.target.value)}
                      />
                    </label>
                  ))}
                </div>
                <button
                  onClick={() =>
                    changePlotColors({ ...defaultPlotColors, series: [...defaultSeriesColors] })
                  }
                >
                  恢复默认配色
                </button>
              </div>
            </FloatingPanel>
            <FloatingPanel
              anchorRef={pidButtonRef}
              open={openPanel === 'pid'}
              onClose={closeFloatingPanel}
            >
              <div className="plot-pid-popover">
                <div className="plot-pid-title">
                  <strong>PID 实时调参建议</strong>
                  <label>
                    <input
                      type="checkbox"
                      checked={pidSettings.enabled}
                      onChange={(event) => updatePidSettings({ enabled: event.target.checked })}
                    />
                    启用
                  </label>
                </div>
                <div className="plot-pid-grid">
                  <label>
                    反馈通道
                    <select
                      disabled={!pidSettings.enabled || !channelNames.length}
                      value={pidChannel}
                      onChange={(event) => updatePidSettings({ channel: event.target.value })}
                    >
                      {!channelNames.length && <option value="">暂无通道</option>}
                      {channelNames.map((name) => (
                        <option key={name}>{name}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    目标值
                    <input
                      type="number"
                      step="any"
                      disabled={!pidSettings.enabled}
                      value={pidSettings.target}
                      onChange={(event) =>
                        updatePidSettings({ target: Number(event.target.value) })
                      }
                    />
                  </label>
                  {(['kp', 'ki', 'kd'] as const).map((key) => (
                    <label key={key}>
                      当前 {key.slice(1).toUpperCase()}
                      <input
                        type="number"
                        min="0"
                        step="any"
                        disabled={!pidSettings.enabled}
                        value={pidSettings[key]}
                        onChange={(event) =>
                          updatePidSettings({ [key]: Math.max(0, Number(event.target.value) || 0) })
                        }
                      />
                    </label>
                  ))}
                  <label>
                    分析窗口
                    <span className="plot-pid-window-input">
                      <input
                        type="number"
                        min="1"
                        max="60"
                        disabled={!pidSettings.enabled}
                        value={pidSettings.windowSeconds}
                        onChange={(event) =>
                          updatePidSettings({
                            windowSeconds: clamp(Number(event.target.value) || 1, 1, 60)
                          })
                        }
                      />
                      秒
                    </span>
                  </label>
                  <label>
                    控制方向
                    <select
                      disabled={!pidSettings.enabled}
                      value={pidSettings.direction}
                      onChange={(event) =>
                        updatePidSettings({
                          direction: event.target.value as PidSettings['direction']
                        })
                      }
                    >
                      <option value="direct">正向（误差增大→输出增大）</option>
                      <option value="reverse">反向（误差增大→输出减小）</option>
                    </select>
                  </label>
                  <label>
                    误差死区
                    <input
                      type="number"
                      min="0"
                      step="any"
                      disabled={!pidSettings.enabled}
                      value={pidSettings.deadband}
                      onChange={(event) =>
                        updatePidSettings({
                          deadband: Math.max(0, Number(event.target.value) || 0)
                        })
                      }
                    />
                  </label>
                  <label>
                    输出下限
                    <input
                      type="number"
                      step="any"
                      disabled={!pidSettings.enabled}
                      value={pidSettings.outputMin}
                      onChange={(event) =>
                        updatePidSettings({ outputMin: Number(event.target.value) })
                      }
                    />
                  </label>
                  <label>
                    输出上限
                    <input
                      type="number"
                      step="any"
                      disabled={!pidSettings.enabled}
                      value={pidSettings.outputMax}
                      onChange={(event) =>
                        updatePidSettings({ outputMax: Number(event.target.value) })
                      }
                    />
                  </label>
                  <label>
                    积分限幅
                    <input
                      type="number"
                      min="0"
                      step="any"
                      disabled={!pidSettings.enabled}
                      value={pidSettings.integralLimit}
                      onChange={(event) =>
                        updatePidSettings({
                          integralLimit: Math.max(0, Number(event.target.value) || 0)
                        })
                      }
                    />
                  </label>
                  <label>
                    D 低通截止频率
                    <span className="plot-pid-window-input">
                      <input
                        type="number"
                        min="0.01"
                        max="1000"
                        step="any"
                        disabled={!pidSettings.enabled}
                        value={pidSettings.derivativeFilterHz}
                        onChange={(event) =>
                          updatePidSettings({
                            derivativeFilterHz: clamp(
                              Number(event.target.value) || 0.01,
                              0.01,
                              1000
                            )
                          })
                        }
                      />
                      Hz
                    </span>
                  </label>
                  <label className="plot-pid-check-option">
                    <input
                      type="checkbox"
                      disabled={!pidSettings.enabled}
                      checked={pidSettings.antiWindup}
                      onChange={(event) => updatePidSettings({ antiWindup: event.target.checked })}
                    />
                    输出饱和时停止同向积分
                  </label>
                </div>
                {!pidSettings.enabled ? (
                  <div className="plot-pid-empty">
                    启用后将计算控制增量、辨识阶跃响应并给出 P/I/D 增减建议
                  </div>
                ) : !pidAnalysis?.ready ? (
                  <div className="plot-pid-empty">{pidAnalysis?.message || '等待实时数据'}</div>
                ) : (
                  <div className="plot-pid-result">
                    <div className="plot-pid-metrics">
                      <span>实时值 {formatAxisValue(pidAnalysis.current)}</span>
                      <span>误差 {formatAxisValue(pidAnalysis.error)}</span>
                      <span>样本 {pidAnalysis.sampleCount}</span>
                      <span>周期 {pidAnalysis.samplePeriodMs.toFixed(2)} ms</span>
                      <span>抖动 {(pidAnalysis.sampleJitter * 100).toFixed(1)}%</span>
                    </div>
                    <div className="plot-pid-control-output">
                      <div>
                        <small>建议控制增量</small>
                        <strong>{formatAxisValue(pidAnalysis.controlOutput)}</strong>
                      </div>
                      <span>P {formatAxisValue(pidAnalysis.pTerm)}</span>
                      <span>I {formatAxisValue(pidAnalysis.iTerm)}</span>
                      <span>D {formatAxisValue(pidAnalysis.dTerm)}</span>
                      {pidAnalysis.antiWindupActive && <b>抗饱和已介入</b>}
                    </div>
                    <div className="plot-pid-identification">
                      <strong>
                        阶跃辨识可信度
                        <b
                          className={
                            pidAnalysis.identificationConfidence >= 75
                              ? 'high'
                              : pidAnalysis.identificationConfidence >= 50
                                ? 'medium'
                                : 'low'
                          }
                        >
                          {pidAnalysis.identificationConfidence}%
                        </b>
                      </strong>
                      <span>
                        上升时间{' '}
                        {pidAnalysis.riseTimeMs === null
                          ? '未识别'
                          : `${pidAnalysis.riseTimeMs.toFixed(1)} ms`}
                      </span>
                      <span>
                        稳定时间{' '}
                        {pidAnalysis.settlingTimeMs === null
                          ? '未稳定'
                          : `${pidAnalysis.settlingTimeMs.toFixed(1)} ms`}
                      </span>
                      <span>超调 {(pidAnalysis.overshootRatio * 100).toFixed(1)}%</span>
                    </div>
                    <div className="plot-pid-recommendations">
                      {pidAnalysis.recommendations.map((item) => (
                        <div key={item.name}>
                          <strong>{item.name}</strong>
                          <span
                            className={
                              item.delta > 0 ? 'increase' : item.delta < 0 ? 'decrease' : ''
                            }
                          >
                            {item.delta > 0 ? '+' : ''}
                            {formatAxisValue(item.delta)}
                          </span>
                          <span>建议 {formatAxisValue(item.next)}</span>
                        </div>
                      ))}
                    </div>
                    {pidAnalysis.reasons.map((reason) => (
                      <p key={reason}>{reason}</p>
                    ))}
                  </div>
                )}
                <small>
                  使用真实采样 Δt
                  进行积分和微分补偿。建议不会自动写入设备，请先确认方向和输出范围，并在低风险工况下逐项小幅验证。
                </small>
              </div>
            </FloatingPanel>
          </div>
        )}
        {embedded && (
          <button
            className="plot-collapse-button"
            aria-expanded={!collapsed}
            title={collapsed ? '展开实时曲线' : '收起实时曲线'}
            onClick={() => {
              const next = !collapsed
              if (next) setOpenPanel(null)
              setCollapsed(next)
              localStorage.setItem('serialflow.plotCollapsed', String(next))
            }}
          >
            {collapsed ? '展开' : '收起'}
          </button>
        )}
      </header>
      {!collapsed && (
        <div className="plot-legend">
          {channelNames.map((name, colorIndex) => {
            const item = series.find((candidate) => candidate.name === name)
            const enabled = !disabledChannels.has(name)
            return (
              <div key={name} className={enabled ? '' : 'disabled'}>
                <input
                  className="plot-channel-enabled"
                  type="checkbox"
                  checked={enabled}
                  aria-label={`${enabled ? '停用' : '启用'} ${name}`}
                  title={`${enabled ? '停用' : '启用'} ${name}`}
                  onChange={() => toggleChannel(name)}
                />
                <input
                  className="plot-series-color"
                  type="color"
                  value={plotColors.series[colorIndex]}
                  disabled={!enabled}
                  aria-label={`${name} 曲线颜色`}
                  title={`调整 ${name} 曲线颜色`}
                  onChange={(event) => changeSeriesColor(colorIndex, event.target.value)}
                />
                <strong>{name}</strong>
                {item ? (
                  <>
                    <span>当前 {formatAxisValue(item.latest)}</span>
                    <span>最小 {formatAxisValue(item.min)}</span>
                    <span>最大 {formatAxisValue(item.max)}</span>
                  </>
                ) : (
                  <span>已停用</span>
                )}
              </div>
            )
          })}
        </div>
      )}
      {!collapsed && (
        <div
          ref={plotCanvasRef}
          className="plot-canvas"
          style={{ background: plotColors.background }}
        >
          {series.length ? (
            <>
              <canvas ref={curveCanvasRef} className="plot-curve-canvas" aria-hidden="true" />
              <svg viewBox="0 0 1000 420" preserveAspectRatio="none" aria-label="实时数据曲线">
                {xTicks.map((tick) => (
                  <g key={tick.pointOffset}>
                    <line
                      x1={tick.x}
                      y1={plotTop}
                      x2={tick.x}
                      y2={plotBottom}
                      className="plot-grid-line"
                      style={{ stroke: plotColors.grid }}
                    />
                  </g>
                ))}
                {yTicks.map((tick) => (
                  <g key={tick.y}>
                    <line
                      x1={plotLeft}
                      y1={tick.y}
                      x2={plotRight}
                      y2={tick.y}
                      className="plot-grid-line"
                      style={{ stroke: plotColors.grid }}
                    />
                  </g>
                ))}
                <line
                  x1={plotLeft}
                  y1={plotBottom}
                  x2={plotRight}
                  y2={plotBottom}
                  className="plot-axis"
                />
                <line
                  x1={plotRight}
                  y1={plotTop}
                  x2={plotRight}
                  y2={plotBottom}
                  className="plot-axis"
                />
                {hoveredAxis === 'x' &&
                  Array.from({ length: 51 }, (_, index) => {
                    const major = index % 5 === 0
                    const x = plotLeft + (index / 50) * plotWidth
                    return (
                      <line
                        key={`x-ruler-${index}`}
                        x1={x}
                        y1={plotBottom}
                        x2={x}
                        y2={plotBottom + (major ? 17 : 9)}
                        className={`plot-ruler-tick ${major ? 'major' : ''}`}
                      />
                    )
                  })}
                {hoveredAxis === 'y' &&
                  Array.from({ length: 41 }, (_, index) => {
                    const major = index % 4 === 0
                    const y = plotTop + (index / 40) * plotHeight
                    return (
                      <line
                        key={`y-ruler-${index}`}
                        x1={plotRight}
                        y1={y}
                        x2={plotRight + (major ? 17 : 9)}
                        y2={y}
                        className={`plot-ruler-tick ${major ? 'major' : ''}`}
                      />
                    )
                  })}
                {axisCursor?.axis === 'x' && (
                  <line
                    x1={axisCursor.x}
                    y1={plotTop}
                    x2={axisCursor.x}
                    y2={plotBottom}
                    className="plot-axis-cursor"
                  />
                )}
                {axisCursor?.axis === 'y' && (
                  <line
                    x1={plotLeft}
                    y1={axisCursor.y}
                    x2={plotRight}
                    y2={axisCursor.y}
                    className="plot-axis-cursor"
                  />
                )}
                {hover && (
                  <g className="plot-crosshair" pointerEvents="none">
                    <line x1={hover.x} y1={plotTop} x2={hover.x} y2={plotBottom} />
                  </g>
                )}
                <rect
                  x={plotLeft}
                  y={plotTop}
                  width={plotWidth}
                  height={plotHeight}
                  fill="transparent"
                  className="plot-hover-area"
                  onPointerDown={(event) => {
                    if (cursors) {
                      moveMeasurement(event, activeCursor)
                      setActiveCursor(activeCursor === 'a' ? 'b' : 'a')
                    }
                  }}
                  onPointerMove={cursors ? undefined : handlePlotHover}
                  onPointerLeave={clearPlotHover}
                />
                {cursors && (
                  <g className="plot-measurement-selection" pointerEvents="none">
                    <rect
                      x={clamp(
                        Math.min(indexToX(cursors.a), indexToX(cursors.b)),
                        plotLeft,
                        plotRight
                      )}
                      y={plotTop}
                      width={Math.max(
                        0,
                        clamp(
                          Math.max(indexToX(cursors.a), indexToX(cursors.b)),
                          plotLeft,
                          plotRight
                        ) -
                          clamp(
                            Math.min(indexToX(cursors.a), indexToX(cursors.b)),
                            plotLeft,
                            plotRight
                          )
                      )}
                      height={plotHeight}
                    />
                  </g>
                )}
                {cursors &&
                  (['a', 'b'] as const).map((which) => {
                    const index = cursors[which]
                    if (index < startIndex || index > endIndex) return null
                    const x = indexToX(index)
                    return (
                      <g key={which} className={`plot-measurement-cursor cursor-${which}`}>
                        <line x1={x} x2={x} y1={plotTop} y2={plotBottom} />
                        <text
                          x={x + (which === 'a' ? -8 : 8)}
                          y={plotTop + 18}
                          textAnchor={which === 'a' ? 'end' : 'start'}
                        >
                          {which.toUpperCase()}
                        </text>
                        <rect
                          x={x - 9}
                          y={plotTop}
                          width={18}
                          height={plotHeight - 12}
                          fill="transparent"
                          role="slider"
                          tabIndex={0}
                          aria-label={`测量游标 ${which.toUpperCase()}`}
                          aria-valuemin={1}
                          aria-valuemax={allSamples.length}
                          aria-valuenow={index + 1}
                          onPointerDown={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            setActiveCursor(which)
                            cursorDrag.current = which
                            event.currentTarget.setPointerCapture(event.pointerId)
                          }}
                          onPointerMove={(event) => {
                            if (cursorDrag.current === which) moveMeasurement(event, which)
                          }}
                          onPointerUp={(event) => {
                            if (event.currentTarget.hasPointerCapture(event.pointerId))
                              event.currentTarget.releasePointerCapture(event.pointerId)
                            cursorDrag.current = null
                          }}
                          onPointerCancel={() => {
                            cursorDrag.current = null
                          }}
                          onKeyDown={(event) => {
                            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                              event.preventDefault()
                              changeCursor(
                                which,
                                event.key === 'Home'
                                  ? 0
                                  : event.key === 'End'
                                    ? liveEndIndex
                                    : index + (event.key === 'ArrowLeft' ? -1 : 1)
                              )
                            }
                          }}
                        />
                      </g>
                    )
                  })}
                <rect
                  x={plotLeft}
                  y={plotBottom - 10}
                  width={plotWidth}
                  height="50"
                  fill="transparent"
                  className="plot-x-axis-hit"
                  onPointerEnter={() => setHoveredAxis('x')}
                  onPointerLeave={() => {
                    window.cancelAnimationFrame(axisCursorFrameRef.current)
                    setHoveredAxis(null)
                    setAxisCursor(null)
                  }}
                  onWheel={handleXWheel}
                  onPointerDown={beginXDrag}
                  onPointerMove={moveXAxisCursor}
                  onPointerUp={finishXDrag}
                  onPointerCancel={finishXDrag}
                />
                <rect
                  x={plotRight - 10}
                  y={plotTop}
                  width="90"
                  height={plotHeight}
                  fill="transparent"
                  className="plot-y-axis-hit"
                  onPointerEnter={() => setHoveredAxis('y')}
                  onPointerLeave={() => {
                    window.cancelAnimationFrame(axisCursorFrameRef.current)
                    setHoveredAxis(null)
                    setAxisCursor(null)
                  }}
                  onWheel={handleYWheel}
                  onPointerDown={beginYDrag}
                  onPointerMove={moveYAxisCursor}
                  onPointerUp={finishYDrag}
                  onPointerCancel={finishYDrag}
                />
              </svg>
            </>
          ) : (
            <div className="plot-empty">
              <strong>{enabledPorts.length ? '等待数值数据…' : '尚未启用曲线端口'}</strong>
              <span>
                {enabledPorts.length
                  ? '支持 PWM=10, Speed=20 或 10,20,30 格式；曲线解析不会改变数据交互的显示格式。'
                  : '请在左侧“串口”配置中勾选“接收数据绘制曲线”。'}
              </span>
            </div>
          )}
          {series.length > 0 && (
            <div className="plot-axis-label-layer" aria-hidden="true">
              {xTicks.map((tick, index) => (
                <span
                  key={`x-${tick.pointOffset}`}
                  className="plot-html-x-label"
                  style={{
                    left: `${(tick.x / 1000) * 100}%`,
                    transform:
                      index === 0
                        ? 'none'
                        : index === xTicks.length - 1
                          ? 'translateX(-100%)'
                          : 'translateX(-50%)'
                  }}
                >
                  {xMode === 'time'
                    ? formatTime(timeStart + ((tick.x - plotLeft) / plotWidth) * timeSpan, timeSpan)
                    : tick.pointOffset}
                </span>
              ))}
              {yTicks.map((tick) => (
                <span
                  key={`y-${tick.y}`}
                  className="plot-html-y-label"
                  style={{
                    left: `${((plotRight + 15) / 1000) * 100}%`,
                    top: `${(tick.y / 420) * 100}%`
                  }}
                >
                  {formatAxisValue(tick.value)}
                </span>
              ))}
              {axisCursor?.axis === 'x' && (
                <span
                  className="plot-axis-cursor-label x"
                  style={{ left: `${(axisCursor.x / 1000) * 100}%` }}
                >
                  {xMode === 'time'
                    ? formatTime(
                        allSamples.at(axisCursor.pointOffset + liveEndIndex)?.timestamp ??
                          timeStart,
                        timeSpan
                      )
                    : axisCursor.pointOffset}
                </span>
              )}
              {axisCursor?.axis === 'y' && (
                <span
                  className="plot-axis-cursor-label y"
                  style={{
                    left: `${((plotRight + 15) / 1000) * 100}%`,
                    top: `${(axisCursor.y / 420) * 100}%`
                  }}
                >
                  {formatAxisValue(axisCursor.value)}
                </span>
              )}
            </div>
          )}
          {hover && series.length > 0 && (
            <>
              <div className="plot-hover-markers" aria-hidden="true">
                {hover.values.map((item) => (
                  <i
                    key={item.name}
                    style={{
                      left: `${(hover.x / 1000) * 100}%`,
                      top: `${(item.y / 420) * 100}%`,
                      background: item.color,
                      borderColor: item.color
                    }}
                  />
                ))}
              </div>
              <div
                className="plot-html-tooltip"
                style={
                  hover.x > 690
                    ? { right: `${((1000 - hover.x) / 1000) * 100 + 1}%` }
                    : { left: `${(hover.x / 1000) * 100 + 1}%` }
                }
              >
                <strong>点 {hover.pointOffset}</strong>
                <small>{formatTime(hover.timestamp, 0)}</small>
                {hover.values.map((item) => (
                  <span key={item.name} style={{ color: item.color }}>
                    {item.name}: {formatAxisValue(item.value)}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {!collapsed && series.length > 0 && (
        <div className="plot-x-range" aria-label="X 轴缩放和平移">
          <div className="plot-x-range-meta">
            <span>视窗 {xWindowPoints.toLocaleString()} 点</span>
            <span>
              {visibleCount.toLocaleString()} / {pointLimit.toLocaleString()} 点
            </span>
            <button disabled={viewEndIndex === null} onClick={() => setViewEndIndex(null)}>
              {viewEndIndex === null ? '实时' : '回到实时'}
            </button>
          </div>
          <div className={`plot-x-range-track ${timelineDragging ? 'dragging' : ''}`}>
            <div
              className="plot-x-range-selection"
              style={{ left: `${timelineStartPercent}%`, right: `${100 - timelineEndPercent}%` }}
              role="slider"
              aria-label="拖动当前视窗"
              aria-valuemin={1}
              aria-valuemax={pointLimit}
              aria-valuenow={xWindowPoints}
              tabIndex={0}
              onPointerDown={(event) => beginXRangeDrag(event, 'pan')}
              onPointerMove={moveXRangeDrag}
              onPointerUp={finishXRangeDrag}
              onPointerCancel={finishXRangeDrag}
            />
            <button
              className={`plot-x-range-handle start ${timelineHandlesOverlap ? 'overlap' : ''}`}
              style={{ left: `${timelineStartPercent}%` }}
              aria-label="调整视窗起点"
              title="拖动调整 X 轴缩放比例"
              onPointerDown={(event) => beginXRangeDrag(event, 'start')}
              onPointerMove={moveXRangeDrag}
              onPointerUp={finishXRangeDrag}
              onPointerCancel={finishXRangeDrag}
            />
            <button
              className={`plot-x-range-handle end ${timelineHandlesOverlap ? 'overlap' : ''}`}
              style={{ left: `${timelineEndPercent}%` }}
              aria-label="调整视窗终点"
              title="拖动调整 X 轴缩放比例"
              onPointerDown={(event) => beginXRangeDrag(event, 'end')}
              onPointerMove={moveXRangeDrag}
              onPointerUp={finishXRangeDrag}
              onPointerCancel={finishXRangeDrag}
            />
          </div>
        </div>
      )}
      {!collapsed && cursors && measurement && (
        <section className="plot-measurements" aria-label="双游标区间统计">
          <div className="plot-measurements-controls">
            <strong>区间测量</strong>
            {(['a', 'b'] as const).map((which) => (
              <label key={which}>
                <button
                  aria-pressed={activeCursor === which}
                  onClick={() => setActiveCursor(which)}
                >
                  {which.toUpperCase()}
                </button>
                <input
                  type="number"
                  aria-label={`游标 ${which.toUpperCase()} 采样点`}
                  min={1}
                  max={allSamples.length}
                  value={cursors[which] + 1}
                  onChange={(event) => changeCursor(which, Number(event.target.value) - 1)}
                />
              </label>
            ))}
            <span>
              Δt（B−A）
              {formatAxisValue(
                (allSamples.at(cursors.b)?.timestamp ?? 0) -
                  (allSamples.at(cursors.a)?.timestamp ?? 0)
              )}{' '}
              ms
            </span>
            <span>间隔 {Math.abs(cursors.b - cursors.a)} 点</span>
            <button
              onClick={() => {
                setCursors(null)
                setPaused(false)
                setFrozenSamples(null)
                if (measurementWindow.current !== null) {
                  setXWindowPoints(measurementWindow.current)
                  measurementWindow.current = null
                }
                setViewEndIndex(null)
              }}
            >
              结束测量并继续
            </button>
          </div>
          <small>
            波形已冻结，接收继续。拖动游标或选择 A / B
            后点击曲线；统计包含两端，平均值按有效采样点计算。
          </small>
          <div className="plot-measurements-table">
            <table>
              <thead>
                <tr>
                  <th>通道</th>
                  <th>A</th>
                  <th>B</th>
                  <th>Δ值（B−A）</th>
                  <th>有效点数</th>
                  <th>最小值</th>
                  <th>最大值</th>
                  <th>平均值</th>
                  <th>峰峰值</th>
                </tr>
              </thead>
              <tbody>
                {activeChannelNames.map((name) => {
                  const stats = measurement[name]
                  const show = (value: number | null): string =>
                    value === null || !Number.isFinite(value) ? '—' : formatAxisValue(value)
                  return (
                    <tr key={name} data-channel={name}>
                      <th>{name}</th>
                      <td>{show(stats.a)}</td>
                      <td>{show(stats.b)}</td>
                      <td>
                        {show(stats.a !== null && stats.b !== null ? stats.b - stats.a : null)}
                      </td>
                      <td>{stats.count}</td>
                      <td>{show(stats.count ? stats.min : null)}</td>
                      <td>{show(stats.count ? stats.max : null)}</td>
                      <td>{show(stats.count ? stats.mean : null)}</td>
                      <td>{show(stats.count ? stats.peakToPeak : null)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {embedded && !collapsed && (
        <div
          className={`plot-panel-resizer ${resizing ? 'resizing' : ''}`}
          title="拖拽调整数据交互顶部位置，双击恢复默认高度"
          onPointerDown={beginResize}
          onPointerMove={resize}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onDoubleClick={() => {
            latestHeight.current = defaultPlotHeight
            setHeight(defaultPlotHeight)
            localStorage.setItem(plotHeightKey, String(defaultPlotHeight))
          }}
        >
          <i />
        </div>
      )}
    </section>
  )
}
