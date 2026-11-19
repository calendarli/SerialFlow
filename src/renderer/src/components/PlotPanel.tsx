import { defaultClock, normalizeClock, type SampleClock } from '../plot/clock'
import { packSamples } from '../plot/packet'
import { StatisticsCache } from '../plot/statistics'
import { GeometryCache } from '../plot/geometry'
import { CanvasRenderer } from '../plot/canvas-renderer'
import type { PlotStatistics } from '../plot-data'
import {
  AutoRange,
  paddedRange,
  niceTicks,
  wheelScale,
  zoomRange,
  indexAtTime
} from '../plot/viewport'
import type { RendererMode } from '../plot/render-types'
import { PlotStore } from '../plot-store'
import {
  shiftPlotCursors,
  followPlotCursors,
  type AnchoredPlotCursors,
  type PlotCursors
} from '../plot-cursors'
import { ClearActionIcon } from './ClearActionIcon'
import { settlingTime } from '../settling-time'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { PlotBuffer, type PlotSample as Sample } from '../plot-data'
import { FloatingPanel } from './FloatingPanel'
import { ProgramCodeEditor } from './ProgramCodeEditor'
import { defaultPlotProgram } from '../plot-program'
import { formatPlotValue } from '../plot-display'
import { compileProgramSource } from '../scripts/program-source'

type Props = {
  store: PlotStore
  enabledPorts: string[]
  embedded?: boolean
  receivePaused: boolean
  onReceivePausedChange: (paused: boolean) => void
}
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
  grid: '#aebdce',
  series: defaultSeriesColors
}
const plotColorsKey = 'serialflow.plotColors'
const plotHeightKey = 'serialflow.plotPanelHeight'
const xWindowKey = 'serialflow.plotXWindowPoints'
const disabledChannelsKey = 'serialflow.plotDisabledChannels'
const pidSettingsKey = 'serialflow.plotPidSettings'
const maxPlotPoints = 100000
const plotLeft = 28
const plotRight = 840
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
      // Upgrade the former default too, including palettes saved when editing series colors.
      grid:
        isColor(saved?.grid) && saved.grid.toLowerCase() !== '#e8edf4'
          ? saved.grid
          : defaultPlotColors.grid,
      series: defaultSeriesColors.map((color, index) =>
        isColor(saved?.series?.[index]) ? saved.series[index] : color
      )
    }
  } catch {
    return { ...defaultPlotColors, series: [...defaultSeriesColors] }
  }
}

function loadPlotHeight(): number | null {
  const saved = Number(localStorage.getItem(plotHeightKey))
  return Number.isFinite(saved) && saved >= 160 ? saved : null
}

function loadXWindow(pointLimit: number): number {
  const saved = Number(localStorage.getItem(xWindowKey) || pointLimit)
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
  return formatPlotValue(value)
}

export function PlotPanel({
  store,
  enabledPorts,
  embedded = false,
  receivePaused,
  onReceivePausedChange
}: Props): React.JSX.Element {
  const [paused, setPaused] = useState(false)
  const [frozenSamples, setFrozenSamples] = useState<PlotBuffer<Sample> | null>(null)
  // Always show the empty grid on startup, including profiles saved by older versions.
  const [collapsed, setCollapsed] = useState(false)
  const [requestedHeight, setHeight] = useState(loadPlotHeight)
  const [availableHeight, setAvailableHeight] = useState(700)
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
  const [xMode, setXMode] = useState<'time' | 'points'>(() =>
    localStorage.getItem('serialflow.plotXMode') === 'time' ? 'time' : 'points'
  )
  const [timeWindow, setTimeWindow] = useState(() =>
    clamp(Number(localStorage.getItem('serialflow.plotTimeWindow')) || 10000, 1, 86400000)
  )
  const [rendererMode, setRendererMode] = useState<RendererMode>(() => {
    const mode = localStorage.getItem('serialflow.plotRenderer')
    return mode === 'canvas' || mode === 'webgl2' ? mode : 'auto'
  })
  const [lineWidth, setLineWidth] = useState(() =>
    clamp(Number(localStorage.getItem('serialflow.plotLineWidth')) || 1.5, 0.5, 8)
  )
  const [clockSettings, setClockSettings] = useState<Record<string, SampleClock>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('serialflow.plotClocks') || '{}')
      return Object.fromEntries(
        Object.entries(saved).map(([port, clock]) => [port, normalizeClock(clock as SampleClock)])
      )
    } catch {
      return {}
    }
  })
  const [canvasEpoch, setCanvasEpoch] = useState(0)
  const [canvasFallback, setCanvasFallback] = useState(false)
  const [mainFallback, setMainFallback] = useState(false)
  const [rendererStatus, setRendererStatus] = useState('初始化中')
  const [rendererReason, setRendererReason] = useState('')
  const [workerReady, setWorkerReady] = useState(false)
  const frameSequence = useRef(0)
  const autoRange = useRef(new AutoRange())
  const fallbackStatistics = useRef(new StatisticsCache())
  const fallbackGeometry = useRef(new GeometryCache())
  const statsRequest = useRef(0)
  const [workerStatistics, setWorkerStatistics] = useState<{
    window: Record<string, PlotStatistics>
    measurement: Record<string, PlotStatistics> | null
  } | null>(null)
  const [lineMode, setLineMode] = useState<'linear' | 'step'>('linear')
  const [yAutoMode, setYAutoMode] = useState<'full' | 'robust'>('full')
  const [cursorSelection, setCursorSelection] = useState<AnchoredPlotCursors | null>(null)
  const [cursorMode, setCursorMode] = useState<'follow' | 'fixed'>('follow')
  const [fixedCursorIds, setFixedCursorIds] = useState<PlotCursors | null>(null)
  const cursorDrag = useRef<'a' | 'b' | null>(null)
  const rangeDrag = useRef<{ anchor: number; cursors: PlotCursors } | null>(null)
  const [activeCursor, setActiveCursor] = useState<'a' | 'b'>('a')
  const measurementWindow = useRef<number | null>(null)
  const [xWindowPoints, setXWindowPoints] = useState(() => loadXWindow(pointLimit))
  const [viewEndId, setViewEndId] = useState<number | null>(null)
  const [viewEndTime, setViewEndTime] = useState<number | null>(null)
  const [manualYRange, setManualYRange] = useState<YRange | null>(null)
  const [hoverState, setHover] = useState<HoverState | null>(null)
  const [hoveredAxis, setHoveredAxis] = useState<'x' | 'y' | null>(null)
  const [axisCursor, setAxisCursor] = useState<AxisCursor | null>(null)
  const [timelineDragging, setTimelineDragging] = useState(false)
  const [disabledChannels, setDisabledChannels] = useState(loadDisabledChannels)
  const [pidSettings, setPidSettings] = useState(loadPidSettings)
  const [canvasWidth, setCanvasWidth] = useState(1000)
  const [canvasHeight, setCanvasHeight] = useState(420)
  const [openPanel, setOpenPanel] = useState<'settings' | 'colors' | 'pid' | 'program' | null>(null)
  const [programDraft, setProgramDraft] = useState(() => ({
    enabled: store.program.enabled,
    source: store.program.source || defaultPlotProgram
  }))
  const [programSaveError, setProgramSaveError] = useState('')
  const [measurementError, setMeasurementError] = useState('')
  const [programSaving, setProgramSaving] = useState(false)
  const resizeStart = useRef({ y: 0, height: 0, max: 530 })
  const panelRef = useRef<HTMLElement | null>(null)
  const maxHeight = Math.max(160, availableHeight - 170)
  const preferredHeight = requestedHeight ?? availableHeight / 2
  const height = clamp(preferredHeight, 160, maxHeight)
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
  const xDrag = useRef<{ x: number; end: number; id: number; time: number } | null>(null)
  const xRangeDrag = useRef<XRangeDrag | null>(null)
  const yDrag = useRef<{ y: number; range: YRange } | null>(null)
  const closeFloatingPanel = useCallback(() => setOpenPanel(null), [])

  useEffect(() => {
    const container = panelRef.current?.parentElement
    if (!embedded || !container) return
    const observer = new ResizeObserver(() => setAvailableHeight(container.clientHeight))
    setAvailableHeight(container.clientHeight)
    observer.observe(container)
    return () => observer.disconnect()
  }, [embedded])

  useEffect(() => {
    const canvas = plotCanvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(([entry]) => {
      setCanvasWidth(Math.max(1, entry.contentRect.width))
      setCanvasHeight(Math.max(1, entry.contentRect.height))
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [collapsed])

  const revision = useSyncExternalStore(
    paused ? () => () => {} : store.subscribe,
    paused ? () => 0 : store.getSnapshot
  )
  useEffect(() => {
    store.configureClocks(clockSettings)
    localStorage.setItem('serialflow.plotClocks', JSON.stringify(clockSettings))
    setViewEndId(null)
    setViewEndTime(null)
    setCursorSelection(null)
    setFixedCursorIds(null)
    setFrozenSamples(null)
    setPaused(false)
    setStartId((value) => value + 1)
    autoRange.current.reset()
  }, [store, clockSettings])
  useEffect(() => {
    store.configure(enabledPorts, pointLimit)
  }, [store, enabledPorts, pointLimit])
  useEffect(() => {
    setCursorSelection(null)
    setFixedCursorIds(null)
    setPaused(false)
    setFrozenSamples(null)
    setViewEndId(null)
    setViewEndTime(null)
    setFixedCursorIds(null)
    setHover(null)
    autoRange.current.reset()
    fallbackStatistics.current.clear()
    fallbackGeometry.current.clear()
    setWorkerStatistics(null)
  }, [enabledPorts, pointLimit])
  const allSamples = paused && frozenSamples ? frozenSamples : store.samples
  const liveEndIndex = Math.max(0, allSamples.length - 1)
  const viewEndIndex =
    viewEndId === null ? null : Math.max(0, firstIndexAfterId(allSamples, viewEndId) - 1)
  const historyExpired =
    viewEndId !== null && !!allSamples.length && viewEndId < allSamples.at(0)!.id
  const setViewEndIndex = useCallback(
    (index: number | null): void => {
      setViewEndTime(null)
      setViewEndId(
        index === null ? null : (allSamples.at(clamp(index, 0, liveEndIndex))?.id ?? null)
      )
    },
    [allSamples, liveEndIndex]
  )
  const endIndex = clamp(viewEndIndex ?? liveEndIndex, 0, liveEndIndex)
  const cursors = useMemo(() => {
    void revision
    if (cursorMode === 'fixed' && fixedCursorIds) {
      const a = firstIndexAfterId(allSamples, fixedCursorIds.a) - 1
      const b = firstIndexAfterId(allSamples, fixedCursorIds.b) - 1
      return a >= 0 &&
        b >= 0 &&
        allSamples.at(a)?.id === fixedCursorIds.a &&
        allSamples.at(b)?.id === fixedCursorIds.b
        ? { a, b }
        : null
    }
    return followPlotCursors(cursorSelection, endIndex, allSamples.length - 1)
  }, [cursorMode, fixedCursorIds, allSamples, revision, cursorSelection, endIndex])
  const setCursors = useCallback(
    (value: React.SetStateAction<PlotCursors | null>): void => {
      const next = typeof value === 'function' ? value(cursors) : value
      setCursorSelection(next ? { ...next, endIndex } : null)
      setFixedCursorIds(
        next ? { a: allSamples.at(next.a)!.id, b: allSamples.at(next.b)!.id } : null
      )
    },
    [cursors, endIndex, allSamples]
  )
  const viewStartIndex = endIndex - xWindowPoints + 1
  const timeEnd = viewEndTime ?? allSamples.at(endIndex)?.timestamp ?? 0
  const timeSpan = timeWindow
  const timeStart = timeEnd - timeSpan
  const startIndex =
    xMode === 'time'
      ? Math.min(endIndex, indexAtTime(allSamples, timeStart))
      : Math.max(0, viewStartIndex)
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
    if (!workerReady)
      return fallbackStatistics.current.measure(
        allSamples,
        startIndex,
        endIndex,
        activeChannelNames
      )
    return Object.fromEntries(
      activeChannelNames.map((name) => [
        name,
        workerStatistics?.window[name] ?? {
          count: 0,
          min: Infinity,
          max: -Infinity,
          mean: 0,
          peakToPeak: NaN,
          latest: null,
          a: null,
          b: null
        }
      ])
    )
  }, [
    allSamples,
    revision,
    startIndex,
    endIndex,
    activeChannelNames,
    workerReady,
    workerStatistics
  ])
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
    return paddedRange(min, max)
  }, [windowStatistics, yAutoMode, allSamples, startIndex, endIndex, activeChannelNames])
  const stableYRange = useMemo(
    () => autoRange.current.update(autoYRange, performance.now()),
    [autoYRange]
  )
  const yRange = manualYRange ?? stableYRange
  const ySpan = Math.max(Number.EPSILON, yRange.max - yRange.min)
  const valueToY = useCallback(
    (value: number) => plotBottom - ((value - yRange.min) / ySpan) * plotHeight,
    [yRange.min, ySpan]
  )
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
          latest: stats.latest ?? NaN
        }
      }),
    [activeChannelNames, windowStatistics, channelNames, plotColors.series]
  )

  const hasSeries = series.length > 0

  const measurement = useMemo(() => {
    // The ring also changes in place once it reaches capacity.
    void revision
    return cursors
      ? workerReady
        ? (workerStatistics?.measurement ?? null)
        : fallbackStatistics.current.measure(allSamples, cursors.a, cursors.b, activeChannelNames)
      : null
  }, [allSamples, cursors, activeChannelNames, revision, workerReady, workerStatistics])
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
  const endMeasurement = useCallback((): void => {
    setCursorSelection(null)
    setFixedCursorIds(null)
    setPaused(false)
    setFrozenSamples(null)
    if (measurementWindow.current !== null) {
      setXWindowPoints(measurementWindow.current)
      measurementWindow.current = null
    }
    setViewEndIndex(null)
  }, [setViewEndIndex])
  const beginMeasurement = (): void => {
    if (cursors) {
      endMeasurement()
      return
    }
    setMeasurementError('')
    if (!visibleCount) return
    measurementWindow.current = xWindowPoints
    if (visibleCount < xWindowPoints) setXWindowPoints(Math.max(1, visibleCount))
    setFrozenSamples(null)
    setPaused(false)
    setCursors({
      a: startIndex + Math.floor((endIndex - startIndex) / 3),
      b: startIndex + Math.ceil(((endIndex - startIndex) * 2) / 3)
    })
    setHover(null)
    setActiveCursor('a')
  }
  const changeCursor = useCallback(
    (which: 'a' | 'b', index: number): void => {
      if (!Number.isFinite(index)) return
      const next = clamp(Math.round(index), 0, liveEndIndex)
      const targetEnd =
        next < startIndex || next > endIndex
          ? Math.min(liveEndIndex, next + Math.floor(xWindowPoints / 2))
          : endIndex
      if (cursors) {
        const updated = { ...cursors, [which]: next }
        setCursorSelection({ ...updated, endIndex: targetEnd })
        setFixedCursorIds({ a: allSamples.at(updated.a)!.id, b: allSamples.at(updated.b)!.id })
      }
      if (targetEnd !== endIndex) setViewEndIndex(targetEnd)
    },
    [liveEndIndex, startIndex, endIndex, xWindowPoints, setViewEndIndex, cursors, allSamples]
  )
  useEffect(
    () =>
      window.api.onPlotMeasurementCommand((command) => {
        if (command.type === 'end') endMeasurement()
        else if (command.type === 'receive') onReceivePausedChange(command.paused)
        else if (command.type === 'select') setActiveCursor(command.cursor)
        else changeCursor(command.cursor, command.index - 1)
      }),
    [endMeasurement, changeCursor, onReceivePausedChange]
  )
  useEffect(() => {
    const show = (value: number | null): string =>
      value === null || !Number.isFinite(value) ? '—' : formatAxisValue(value)
    void window.api
      .syncPlotMeasurement(
        cursors && measurement
          ? {
              a: cursors.a + 1,
              b: cursors.b + 1,
              total: allSamples.length,
              active: activeCursor,
              receivePaused,
              deltaTime: formatAxisValue(
                (allSamples.at(cursors.b)?.timestamp ?? 0) -
                  (allSamples.at(cursors.a)?.timestamp ?? 0)
              ),
              rows: activeChannelNames.map((name) => {
                const stats = measurement[name]
                if (!stats)
                  return [store.channelLabel(name), '—', '—', '—', '0', '—', '—', '—', '—']
                return [
                  store.channelLabel(name),
                  show(stats.a),
                  show(stats.b),
                  show(stats.a !== null && stats.b !== null ? stats.b - stats.a : null),
                  String(stats.count),
                  show(stats.count ? stats.min : null),
                  show(stats.count ? stats.max : null),
                  show(stats.count ? stats.mean : null),
                  show(stats.count ? stats.peakToPeak : null)
                ]
              })
            }
          : null
      )
      .catch((error) => {
        setMeasurementError(String(error))
        endMeasurement()
      })
  }, [
    cursors,
    measurement,
    activeCursor,
    activeChannelNames,
    store,
    allSamples,
    endMeasurement,
    receivePaused
  ])
  useEffect(
    () => () => {
      void window.api.syncPlotMeasurement(null).catch(() => {})
    },
    []
  )
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
    timelineEndPercent -
      (((xMode === 'time' ? visibleCount : xWindowPoints) - 1) / timelineSpan) * 100,
    0,
    100
  )
  const timelineHandlesOverlap = timelineEndPercent - timelineStartPercent < 2.5

  useEffect(() => {
    const target = curveCanvasRef.current
    if (!target || collapsed || !hasSeries || mainFallback) return
    if (typeof target.transferControlToOffscreen !== 'function') {
      setMainFallback(true)
      setRendererStatus('兼容绘图')
      return
    }
    const worker = new Worker(new URL('../workers/plot.worker.ts', import.meta.url), {
      type: 'module'
    })
    plotWorkerRef.current = worker
    workerSyncRef.current = { key: '', lastId: 0 }
    let alive = true
    const fail = (reason: string): void => {
      if (!alive) return
      alive = false
      worker.terminate()
      plotWorkerRef.current = null
      workerRenderingRef.current = false
      setWorkerReady(false)
      setRendererReason(reason)
      if (canvasFallback || rendererMode === 'canvas') {
        setMainFallback(true)
        setRendererStatus('兼容绘图（主线程）')
      } else {
        setCanvasFallback(true)
        setRendererStatus('切换兼容绘图')
      }
      setCanvasEpoch((value) => value + 1)
    }
    const timeout = window.setTimeout(() => fail('绘图引擎初始化超时'), 5000)
    worker.onmessage = (event) => {
      if (!alive) return
      if (event.data.type === 'ready') {
        window.clearTimeout(timeout)
        workerRenderingRef.current = true
        setWorkerReady(true)
        setRendererStatus(event.data.backend === 'webgl2' ? 'WebGL2' : '兼容绘图')
      } else if (
        event.data.type === 'statistics' &&
        event.data.requestId === statsRequest.current
      ) {
        setWorkerStatistics(event.data)
      } else if (event.data.type === 'failed') fail(event.data.reason)
      else if (event.data.type === 'frame' && target.isConnected) {
        target.dataset.renderer = event.data.backend
        target.dataset.frame = String(event.data.requestId)
        target.dataset.renderMs = String(event.data.duration)
        target.dataset.segments = String(event.data.segments)
        target.dataset.xSpan = String(event.data.xSpan)
        target.dataset.yMin = String(event.data.yMin)
        target.dataset.yMax = String(event.data.yMax)
      }
    }
    worker.onerror = (event) => {
      event.preventDefault()
      fail(event.message || '绘图线程异常')
    }
    try {
      const offscreen = target.transferControlToOffscreen()
      transferredCanvasRef.current = target
      // Suppress main-thread drawing as soon as ownership is transferred.
      workerRenderingRef.current = true
      worker.postMessage(
        { type: 'init', canvas: offscreen, mode: canvasFallback ? 'canvas' : rendererMode },
        [offscreen]
      )
    } catch (error) {
      fail(String(error))
    }
    return () => {
      alive = false
      window.clearTimeout(timeout)
      worker.terminate()
      if (plotWorkerRef.current === worker) plotWorkerRef.current = null
      workerRenderingRef.current = false
      transferredCanvasRef.current = null
      setWorkerReady(false)
    }
  }, [collapsed, hasSeries, canvasEpoch, mainFallback, canvasFallback, rendererMode])

  useEffect(() => {
    const worker = plotWorkerRef.current
    if (!workerRenderingRef.current || !worker) return
    const syncKey = `${paused ? 'paused' : 'live'}\u0000${startId}\u0000${enabledPorts.join('\u0000')}`
    const previous = workerSyncRef.current
    const lastId = allSamples.at(-1)?.id || 0
    const reset = previous.key !== syncKey || lastId < previous.lastId || !allSamples.length
    const additionStart = reset ? 0 : firstIndexAfterId(allSamples, previous.lastId)
    const packet = packSamples(allSamples.slice(additionStart))
    worker.postMessage(
      {
        type: 'data',
        reset,
        packet,
        pointLimit,
        pruneBeforeId: allSamples.at(0)?.id || 0
      },
      [packet.numbers.buffer, packet.sources.buffer, packet.gaps.buffer]
    )
    workerSyncRef.current = { key: syncKey, lastId }
  }, [allSamples, revision, enabledPorts, paused, pointLimit, startId, workerReady, canvasEpoch])

  useEffect(() => {
    if (!workerReady || !plotWorkerRef.current) return
    plotWorkerRef.current.postMessage({
      type: 'statistics',
      requestId: ++statsRequest.current,
      start: startIndex,
      end: endIndex,
      channels: activeChannelNames,
      cursors
    })
  }, [revision, startIndex, endIndex, activeChannelNames, cursors, workerReady, paused, startId])

  useEffect(() => {
    const worker = plotWorkerRef.current
    const host = plotCanvasRef.current
    if (!workerRenderingRef.current || !worker || !host || collapsed || !series.length) return
    const rect = host.getBoundingClientRect()
    worker.postMessage({
      type: 'render',
      requestId: ++frameSequence.current,
      lineWidth,
      width: rect.width,
      height: rect.height,
      dpr: Math.min(window.devicePixelRatio || 1, 2),
      xWindowPoints,
      endOffset: endIndex - liveEndIndex,
      endId: allSamples.at(endIndex)?.id ?? 0,
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
    lineWidth,
    canvasWidth,
    canvasHeight,
    workerReady,
    canvasEpoch,
    allSamples,
    revision,
    store
  ])

  useEffect(() => {
    const canvas = curveCanvasRef.current
    const host = plotCanvasRef.current
    if (
      workerRenderingRef.current ||
      !canvas ||
      !host ||
      collapsed ||
      !series.length ||
      transferredCanvasRef.current === canvas
    )
      return
    const rect = host.getBoundingClientRect()
    const xMin =
      xMode === 'time' ? timeStart : (allSamples.at(endIndex)?.id ?? 0) - xWindowPoints + 1
    const xMax = xMode === 'time' ? timeStart + timeSpan : xMin + Math.max(1, xWindowPoints - 1)
    const renderer = new CanvasRenderer(canvas)
    renderer.render(
      {
        width: rect.width,
        height: rect.height,
        dpr: Math.min(window.devicePixelRatio || 1, 2),
        xMin,
        xMax,
        yMin: yRange.min,
        yMax: yRange.max,
        lineWidth
      },
      fallbackGeometry.current.build(allSamples, {
        start: startIndex,
        end: endIndex,
        width: rect.width * 0.812,
        xMin,
        xMax,
        xMode,
        lineMode,
        channels: series.map((item) => ({
          name: item.name,
          port: store.channels.get(item.name) || '',
          color: item.color
        }))
      })
    )
    canvas.dataset.renderer = 'canvas-main'
    renderer.dispose()
  }, [
    collapsed,
    series,
    endIndex,
    allSamples,
    startIndex,
    xMode,
    timeStart,
    timeSpan,
    xWindowPoints,
    yRange,
    lineWidth,
    lineMode,
    store,
    canvasWidth,
    canvasHeight,
    mainFallback,
    canvasEpoch
  ])

  const xTickCount = clamp(Math.floor(canvasWidth / 135) + 1, 6, 16)
  const xTicks = useMemo(() => {
    const count = xMode === 'time' ? xTickCount : Math.min(xTickCount, xWindowPoints)
    if (count <= 1) return [{ x: plotRight, pointOffset: endIndex - liveEndIndex }]
    return Array.from({ length: count }, (_, index) => {
      const ratio = index / (count - 1)
      return {
        x: plotLeft + ratio * plotWidth,
        pointOffset:
          Math.round(viewStartIndex + ratio * Math.max(0, xWindowPoints - 1)) - liveEndIndex
      }
    })
  }, [endIndex, liveEndIndex, viewStartIndex, xTickCount, xWindowPoints, xMode])
  const yTicks = useMemo(
    () =>
      niceTicks(yRange.min, yRange.max).map((value) => ({
        y: plotBottom - ((value - yRange.min) / ySpan) * plotHeight,
        value
      })),
    [yRange.min, yRange.max, ySpan]
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
      max: Math.max(160, availableHeight - 170)
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
    if (event.currentTarget.hasPointerCapture(event.pointerId))
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
    if (xMode === 'time') {
      const next = clamp(timeWindow * wheelScale(event.deltaY, event.deltaMode), 1, 86400000)
      const anchor = timeStart + ratio * timeSpan
      const nextEnd = clamp(
        anchor + (1 - ratio) * next,
        allSamples.at(0)?.timestamp ?? 0,
        allSamples.at(-1)?.timestamp ?? 0
      )
      setTimeWindow(next)
      localStorage.setItem('serialflow.plotTimeWindow', String(next))
      const latest = allSamples.at(-1)?.timestamp ?? 0
      setViewEndIndex(
        nextEnd >= latest
          ? null
          : Math.min(liveEndIndex, Math.max(0, indexAtTime(allSamples, nextEnd, true) - 1))
      )
      setViewEndTime(nextEnd >= latest ? null : nextEnd)
      return
    }
    const centerIndex = viewStartIndex + ratio * Math.max(0, xWindowPoints - 1)
    const next = Math.round(
      clamp(xWindowPoints * wheelScale(event.deltaY, event.deltaMode), 1, pointLimit)
    )
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
    const factor = wheelScale(event.deltaY, event.deltaMode)
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
    if (!rect) return
    const pointerY = clamp(((event.clientY - rect.top) / rect.height) * 420, plotTop, plotBottom)
    const center = yRange.max - ((pointerY - plotTop) / plotHeight) * ySpan
    setManualYRange(zoomRange(yRange, center, factor))
    setAxisCursor({ axis: 'y', y: pointerY, value: center })
  }
  const beginXDrag = (event: React.PointerEvent<SVGRectElement>): void => {
    event.preventDefault()
    xDrag.current = {
      x: event.clientX,
      end: endIndex,
      id: allSamples.at(endIndex)?.id ?? 0,
      time: timeEnd
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveXDrag = (event: React.PointerEvent<SVGRectElement>): void => {
    if (!xDrag.current) return
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
    if (!rect) return
    if (xMode === 'time') {
      const requestedTime =
        xDrag.current.time -
        ((event.clientX - xDrag.current.x) / rect.width) * (1000 / plotWidth) * timeSpan
      const latest = allSamples.at(-1)?.timestamp ?? 0
      const target = clamp(requestedTime, allSamples.at(0)?.timestamp ?? 0, latest)
      setViewEndIndex(
        target >= latest
          ? null
          : Math.min(liveEndIndex, Math.max(0, indexAtTime(allSamples, target, true) - 1))
      )
      setViewEndTime(target >= latest ? null : target)
      return
    }
    const deltaPoints =
      ((event.clientX - xDrag.current.x) / rect.width) * (1000 / plotWidth) * xWindowPoints
    const next = Math.round(
      clamp(firstIndexAfterId(allSamples, xDrag.current.id) - 1 - deltaPoints, 0, liveEndIndex)
    )
    setViewEndIndex(next >= liveEndIndex ? null : next)
  }
  const finishXDrag = (event: React.PointerEvent<SVGRectElement>): void => {
    if (!xDrag.current) return
    if (event.currentTarget.hasPointerCapture(event.pointerId))
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
    if (event.currentTarget.hasPointerCapture(event.pointerId))
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
      start: xMode === 'time' ? startIndex : endIndex - xWindowPoints + 1,
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
    if (xMode === 'time') {
      const nextStart = drag.mode === 'start' ? clamp(drag.start + delta, 0, drag.end) : drag.start
      const nextEnd =
        drag.mode === 'end' ? clamp(drag.end + delta, nextStart, liveEndIndex) : drag.end
      const duration = Math.max(
        1,
        (allSamples.at(nextEnd)?.timestamp ?? timeEnd) -
          (allSamples.at(nextStart)?.timestamp ?? timeStart)
      )
      setTimeWindow(duration)
      localStorage.setItem('serialflow.plotTimeWindow', String(duration))
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
      ref={panelRef}
      className={`plot-panel ${embedded ? 'embedded' : ''} ${collapsed ? 'collapsed' : ''} ${cursors ? 'measuring' : ''}`}
      style={embedded ? { height: collapsed ? 58 : height } : undefined}
    >
      <header className="plot-toolbar plot-toolbar-compact">
        <div className="plot-heading">
          <strong>实时曲线</strong>
          {measurementError && <span role="alert">{measurementError}</span>}
          <span>
            {allSamples.length.toLocaleString()} 个采样点 · {series.length} 个通道 ·{' '}
            {xMode === 'time'
              ? `${timeWindow / 1000} 秒视窗`
              : `${xWindowPoints.toLocaleString()} 点视窗`}{' '}
            ·{' '}
            {receivePaused
              ? '接收已暂停'
              : paused
                ? '已冻结'
                : viewEndIndex === null
                  ? '实时'
                  : '历史'}
            {cursorMode === 'fixed' && fixedCursorIds && !cursors && (
              <span role="status"> · 固定游标采样已淘汰</span>
            )}
            {historyExpired && <span role="status"> · 历史数据已淘汰，显示最早可用采样</span>}
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
              title="打开实时区间测量，A / B 跟随曲线滚动；再次点击结束测量"
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
            <button title="适配当前数据后固定量程" onClick={() => setManualYRange(autoYRange)}>
              适配一次
            </button>
            <button
              aria-pressed={manualYRange === null}
              title="快速扩展、延迟回缩自动量程"
              onClick={() => setManualYRange(null)}
            >
              Y 自动
            </button>
            <button
              className="plot-pause-button"
              aria-pressed={receivePaused || paused}
              title={
                cursors || receivePaused
                  ? receivePaused
                    ? '继续接收'
                    : '暂停接收'
                  : paused
                    ? '继续绘图'
                    : '暂停绘图'
              }
              onClick={() => {
                if (cursors || receivePaused) {
                  onReceivePausedChange(!receivePaused)
                  return
                }
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
              {receivePaused || paused ? '继续' : '暂停'}
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
                  游标模式
                  <select
                    aria-label="游标模式"
                    value={cursorMode}
                    onChange={(event) => {
                      if (cursors) {
                        setCursorSelection({ ...cursors, endIndex })
                        setFixedCursorIds({
                          a: allSamples.at(cursors.a)!.id,
                          b: allSamples.at(cursors.b)!.id
                        })
                      }
                      setCursorMode(event.target.value as 'follow' | 'fixed')
                    }}
                  >
                    <option value="follow">跟随视窗</option>
                    <option value="fixed">固定采样</option>
                  </select>
                </label>

                <label>
                  绘图引擎
                  <select
                    aria-label="绘图引擎"
                    value={rendererMode}
                    onChange={(event) => {
                      const mode = event.target.value as RendererMode
                      setRendererMode(mode)
                      setCanvasFallback(false)
                      setMainFallback(false)
                      setRendererReason('')
                      setCanvasEpoch((value) => value + 1)
                      localStorage.setItem('serialflow.plotRenderer', mode)
                    }}
                  >
                    <option value="auto">自动</option>
                    <option value="webgl2">WebGL2</option>
                    <option value="canvas">兼容绘图</option>
                  </select>
                </label>
                <small role="status">
                  当前：{rendererStatus}
                  {rendererReason ? ` · ${rendererReason}` : ''}
                </small>
                <label>
                  线宽（px）
                  <input
                    aria-label="曲线线宽"
                    type="number"
                    min="0.5"
                    max="8"
                    step="0.5"
                    value={lineWidth}
                    onChange={(event) => {
                      const value = clamp(Number(event.target.value) || 1.5, 0.5, 8)
                      setLineWidth(value)
                      localStorage.setItem('serialflow.plotLineWidth', String(value))
                    }}
                  />
                </label>
                {xMode === 'time' && (
                  <label>
                    显示时长（秒）
                    <input
                      aria-label="曲线显示时长"
                      type="number"
                      min="0.001"
                      max="86400"
                      step="1"
                      value={timeWindow / 1000}
                      onChange={(event) => {
                        const value = clamp((Number(event.target.value) || 10) * 1000, 1, 86400000)
                        setTimeWindow(value)
                        localStorage.setItem('serialflow.plotTimeWindow', String(value))
                      }}
                    />
                  </label>
                )}
                <label>
                  Y 最小值
                  <input
                    aria-label="Y 最小值"
                    type="number"
                    value={yRange.min}
                    onChange={(event) => {
                      const min = Number(event.target.value)
                      if (Number.isFinite(min) && min < yRange.max)
                        setManualYRange({ min, max: yRange.max })
                    }}
                  />
                </label>
                <label>
                  Y 最大值
                  <input
                    aria-label="Y 最大值"
                    type="number"
                    value={yRange.max}
                    onChange={(event) => {
                      const max = Number(event.target.value)
                      if (Number.isFinite(max) && max > yRange.min)
                        setManualYRange({ min: yRange.min, max })
                    }}
                  />
                </label>

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
                      localStorage.setItem('serialflow.plotXMode', 'points')
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
                      localStorage.setItem('serialflow.plotXMode', 'time')
                      setHover(null)
                    }}
                  >
                    时间
                  </button>
                </div>
                <small>时间窗口保持固定时长。每个串口独立配置时间源；更改时间源会清空曲线。</small>
                {enabledPorts.map((port) => {
                  const clock = clockSettings[port] ?? defaultClock
                  const update = (patch: Partial<SampleClock>): void =>
                    setClockSettings((current) => ({
                      ...current,
                      [port]: normalizeClock({ ...clock, ...patch })
                    }))
                  return (
                    <div key={port} className="plot-clock-setting">
                      <label>
                        {port} 时间源
                        <select
                          aria-label={`${port} 时间源`}
                          value={clock.mode}
                          onChange={(event) =>
                            update({ mode: event.target.value as SampleClock['mode'] })
                          }
                        >
                          <option value="receive">上位机接收时间</option>
                          <option value="period">固定采样周期</option>
                          <option value="device">设备时间字段</option>
                        </select>
                      </label>
                      {clock.mode === 'period' && (
                        <label>
                          采样周期（ms）
                          <input
                            type="number"
                            min="0.001"
                            step="0.001"
                            value={clock.periodMs}
                            onChange={(event) => update({ periodMs: Number(event.target.value) })}
                          />
                        </label>
                      )}
                      {clock.mode === 'device' && (
                        <>
                          <label>
                            时间字段
                            <input
                              aria-label={`${port} 设备时间字段`}
                              defaultValue={clock.field}
                              onBlur={(event) => {
                                if (event.target.value !== clock.field)
                                  update({ field: event.target.value })
                              }}
                            />
                          </label>
                          <label>
                            每单位毫秒数
                            <input
                              type="number"
                              min="0.000001"
                              step="0.001"
                              value={clock.unitMs}
                              onChange={(event) => update({ unitMs: Number(event.target.value) })}
                            />
                          </label>
                          <label>
                            回绕模数（0 为重启）
                            <input
                              type="number"
                              min="0"
                              value={clock.rollover}
                              onChange={(event) => update({ rollover: Number(event.target.value) })}
                            />
                          </label>
                        </>
                      )}
                    </div>
                  )
                })}
                <small>
                  设备时间相对首包接收时间显示。固定周期不能识别无序号的丢包；多源时间回退会重新对齐并断开连线，不代表设备已精确同步。
                </small>
                {store.clockWarning && <small role="status">{store.clockWarning}</small>}
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
                        <option key={name} value={name}>
                          {store.channelLabel(name)}
                        </option>
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
                  aria-label={`${enabled ? '停用' : '启用'} ${store.channelLabel(name)}`}
                  title={`${enabled ? '停用' : '启用'} ${store.channelLabel(name)}`}
                  onChange={() => toggleChannel(name)}
                />
                <input
                  className="plot-series-color"
                  type="color"
                  value={plotColors.series[colorIndex]}
                  disabled={!enabled}
                  aria-label={`${store.channelLabel(name)} 曲线颜色`}
                  title={`调整 ${store.channelLabel(name)} 曲线颜色`}
                  onChange={(event) => changeSeriesColor(colorIndex, event.target.value)}
                />
                <strong title={store.channelLabel(name)}>{store.channelLabel(name)}</strong>
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
          {hasSeries && (
            <canvas
              key={canvasEpoch}
              ref={curveCanvasRef}
              className="plot-curve-canvas"
              aria-hidden="true"
            />
          )}
          <svg
            viewBox="0 0 1000 420"
            preserveAspectRatio="none"
            aria-label="实时数据曲线"
            style={{ pointerEvents: hasSeries ? undefined : 'none' }}
          >
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
                } else if (event.button === 0) {
                  beginXDrag(event)
                  beginYDrag(event)
                }
              }}
              onWheel={(event) => {
                handleXWheel(event)
                handleYWheel(event)
              }}
              onPointerUp={(event) => {
                finishXDrag(event)
                finishYDrag(event)
              }}
              onPointerCancel={() => {
                xDrag.current = null
                yDrag.current = null
              }}
              onPointerMove={
                cursors
                  ? undefined
                  : (event) => {
                      if (xDrag.current || yDrag.current) {
                        moveXDrag(event)
                        moveYDrag(event)
                      } else handlePlotHover(event)
                    }
              }
              onPointerLeave={clearPlotHover}
            />
            {cursors && (
              <g className="plot-measurement-selection">
                <rect
                  x={clamp(Math.min(indexToX(cursors.a), indexToX(cursors.b)), plotLeft, plotRight)}
                  y={plotTop}
                  width={Math.max(
                    0,
                    clamp(Math.max(indexToX(cursors.a), indexToX(cursors.b)), plotLeft, plotRight) -
                      clamp(Math.min(indexToX(cursors.a), indexToX(cursors.b)), plotLeft, plotRight)
                  )}
                  height={plotHeight}
                  role="slider"
                  tabIndex={0}
                  aria-label="整体平移双游标"
                  aria-valuemin={1}
                  aria-valuemax={allSamples.length - Math.abs(cursors.b - cursors.a)}
                  aria-valuenow={Math.min(cursors.a, cursors.b) + 1}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return
                    event.preventDefault()
                    event.stopPropagation()
                    const rect = event.currentTarget.ownerSVGElement!.getBoundingClientRect()
                    rangeDrag.current = {
                      anchor: xToIndex(((event.clientX - rect.left) / rect.width) * 1000),
                      cursors: { ...cursors }
                    }
                    event.currentTarget.setPointerCapture(event.pointerId)
                  }}
                  onPointerMove={(event) => {
                    const drag = rangeDrag.current
                    if (!drag) return
                    const rect = event.currentTarget.ownerSVGElement!.getBoundingClientRect()
                    const index = xToIndex(((event.clientX - rect.left) / rect.width) * 1000)
                    setCursors(shiftPlotCursors(drag.cursors, index - drag.anchor, liveEndIndex))
                  }}
                  onPointerUp={(event) => {
                    rangeDrag.current = null
                    if (event.currentTarget.hasPointerCapture(event.pointerId))
                      if (event.currentTarget.hasPointerCapture(event.pointerId))
                        event.currentTarget.releasePointerCapture(event.pointerId)
                  }}
                  onPointerCancel={() => {
                    rangeDrag.current = null
                  }}
                  onLostPointerCapture={() => {
                    rangeDrag.current = null
                  }}
                  onKeyDown={(event) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                    event.preventDefault()
                    const offset =
                      event.key === 'Home'
                        ? -liveEndIndex
                        : event.key === 'End'
                          ? liveEndIndex
                          : event.key === 'ArrowLeft'
                            ? -1
                            : 1
                    setCursors(shiftPlotCursors(cursors, offset, liveEndIndex))
                  }}
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
          {!hasSeries && (
            <div className="plot-empty">
              <strong>{enabledPorts.length ? '等待数值数据…' : '尚未启用曲线端口'}</strong>
              <span>
                {enabledPorts.length
                  ? '支持 PWM=10, Speed=20 或 10,20,30 格式；曲线解析不会改变数据交互的显示格式。'
                  : '请在左侧“串口”配置中勾选“接收数据绘制曲线”。'}
              </span>
            </div>
          )}
          <div className="plot-axis-label-layer" aria-hidden="true">
            {cursors &&
              (['a', 'b'] as const).map((which) => {
                const index = cursors[which]
                if (index < startIndex || index > endIndex) return null
                return (
                  <span
                    key={which}
                    className={`plot-cursor-label cursor-${which}`}
                    style={{
                      left: `${(indexToX(index) / 1000) * 100}%`,
                      top: `calc(${(plotTop / 420) * 100}% + 4px)`,
                      transform:
                        indexToX(index) < plotLeft + 30
                          ? 'translateX(8px)'
                          : indexToX(index) > plotRight - 30
                            ? 'translateX(calc(-100% - 8px))'
                            : undefined
                    }}
                  >
                    {which.toUpperCase()}
                  </span>
                )
              })}
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
                  ? allSamples.length
                    ? formatTime(timeStart + ((tick.x - plotLeft) / plotWidth) * timeSpan, timeSpan)
                    : `${formatAxisValue((((tick.x - plotLeft) / plotWidth - 1) * timeSpan) / 1000)} s`
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
                      allSamples.at(axisCursor.pointOffset + liveEndIndex)?.timestamp ?? timeStart,
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
                    {store.channelLabel(item.name)}: {formatAxisValue(item.value)}
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
            <span>
              视窗{' '}
              {xMode === 'time'
                ? `${timeWindow / 1000} 秒`
                : `${xWindowPoints.toLocaleString()} 点`}
            </span>
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
      {embedded && !collapsed && (
        <div
          className={`plot-panel-resizer ${resizing ? 'resizing' : ''}`}
          title="拖拽调整曲线与数据显示区比例，双击恢复 50%"
          onPointerDown={beginResize}
          onPointerMove={resize}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onDoubleClick={() => {
            latestHeight.current = availableHeight / 2
            setHeight(null)
            localStorage.removeItem(plotHeightKey)
          }}
        >
          <i />
        </div>
      )}
    </section>
  )
}
