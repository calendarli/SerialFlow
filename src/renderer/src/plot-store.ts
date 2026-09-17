import { PlotProgramRuntime } from './plot-program'
import { PlotBuffer, parsePlotValues, type PlotSample } from './plot-data'
import { displayChannelName } from './plot-display'

export class PlotStore {
  samples = new PlotBuffer<PlotSample>(1000)
  channels = new Map<string, string>()
  private portLabels = new Map<string, string>()
  private ports: string[] = []
  private nextId = 0
  private breaks = new Set<string>()
  private revision = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private listeners = new Set<() => void>()
  program = { enabled: false, source: '' }
  programError = ''
  private receivingPaused = false
  setReceivingPaused(paused: boolean): void {
    if (this.receivingPaused === paused) return
    this.receivingPaused = paused
    if (!paused) for (const port of this.ports) this.breaks.add(port)
  }
  constructor(
    private runtime: Pick<PlotProgramRuntime, 'run' | 'dispose'> = new PlotProgramRuntime()
  ) {}
  private generation = 0
  private queue: {
    port: string
    values: Record<string, number>
    timestamp: number
    gap?: boolean
  }[] = []
  private processing = false
  private processTimer: ReturnType<typeof setTimeout> | undefined
  configureProgram(enabled: boolean, source: string): void {
    this.program = { enabled, source }
    this.clear()
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = (): number => this.revision
  configure(ports: string[], capacity: number): void {
    if (ports.join('\0') !== this.ports.join('\0')) {
      this.ports = [...ports]
      this.clear(capacity)
    } else if (capacity !== this.samples.capacity) {
      const retained = this.samples.slice(-capacity)
      this.samples = new PlotBuffer(capacity)
      for (const sample of retained) this.samples.push(sample)
      this.notify()
    }
  }
  append(port: string, text: string, timestamp = Date.now()): void {
    if (this.receivingPaused || !this.ports.includes(port)) return
    const values = parsePlotValues(text)
    if (!values) return
    if (!this.program.enabled || this.programError) {
      this.appendValues(port, values, timestamp)
      return
    }
    this.queue.push({ port, values, timestamp })
    if (this.queue.length > 4096) {
      this.failProgram('计算跟不上接收速度，已停止计算并保留原始采样；请简化程序后重新应用')
      return
    }
    if (this.processTimer === undefined && !this.processing)
      this.processTimer = setTimeout(() => {
        this.processTimer = undefined
        void this.process()
      }, 8)
  }
  private inFlight: typeof this.queue = []
  private failProgram(message: string): void {
    this.programError = message
    this.generation++
    this.runtime.dispose()
    for (const item of [...this.inFlight, ...this.queue]) {
      if (item.gap) this.breaks.add(item.port)
      else this.appendValues(item.port, item.values, item.timestamp)
    }
    this.inFlight = []
    this.queue = []
    this.processing = false
    this.notify()
  }
  private async process(): Promise<void> {
    if (this.processing || !this.queue.length) return
    this.processing = true
    const generation = this.generation
    const batch = this.queue.splice(0, 256)
    this.inFlight = batch
    try {
      const inputs = batch.filter((item) => !item.gap)
      const outputs = inputs.length
        ? await this.runtime.run(
            this.program.source,
            inputs.map((item) => item.values)
          )
        : []
      if (generation !== this.generation) return
      let outputIndex = 0
      const converted = batch.map((item) => {
        const values = { ...item.values }
        for (const output of item.gap ? [] : outputs[outputIndex++]) {
          const name = `计算·${output.name}${output.unit ? ` (${output.unit})` : ''}`
          if (Object.hasOwn(values, name)) throw new Error(`计算结果名称重复：${name}`)
          values[name] = output.value
        }
        return { ...item, values }
      })
      for (const item of converted) {
        if (item.gap) this.breaks.add(item.port)
        else this.appendValues(item.port, item.values, item.timestamp)
      }
      this.inFlight = []
    } catch (cause) {
      if (generation === this.generation)
        this.failProgram(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (generation === this.generation) {
        this.processing = false
        if (this.queue.length) void this.process()
      }
    }
  }
  appendValues(port: string, values: Record<string, number>, timestamp = Date.now()): void {
    if (!this.ports.includes(port) && !port.startsWith('data-window:')) return
    const qualified = Object.fromEntries(
      Object.entries(values).flatMap(([key, value]) => {
        const name = this.ports.length > 1 ? `${port} · ${key}` : key
        if (!this.channels.has(name) && this.channels.size >= 8) return []
        this.channels.set(name, port)
        return [[name, value]]
      })
    )
    this.samples.push({
      id: ++this.nextId,
      port,
      breakBefore: this.breaks.delete(port),
      timestamp: Math.max(timestamp, this.samples.at(-1)?.timestamp ?? timestamp),
      values: qualified
    })
    this.notify()
  }
  setPortLabel(port: string, label: string): void {
    this.portLabels.set(port, label)
  }
  channelLabel(name: string): string {
    const port = this.channels.get(name) || ''
    const label = this.portLabels.get(port)?.trim()
    if (!label) return name
    const matchingPorts = this.ports.filter(
      (candidate) => this.portLabels.get(candidate)?.trim() === label
    )
    const index = matchingPorts.indexOf(port)
    return displayChannelName(name, port, index > 0 ? `${label} (${index + 1})` : label)
  }
  disconnect(port: string): void {
    if (!this.ports.includes(port)) return
    if (this.program.enabled && !this.programError && (this.processing || this.queue.length)) {
      this.queue.push({ port, values: {}, timestamp: Date.now(), gap: true })
    } else this.breaks.add(port)
  }
  clear(capacity = this.samples.capacity): void {
    this.generation++
    clearTimeout(this.processTimer)
    this.processTimer = undefined
    this.runtime.dispose()
    this.queue = []
    this.inFlight = []
    this.processing = false
    this.programError = ''
    this.samples = new PlotBuffer(capacity)
    this.channels = new Map()
    this.breaks.clear()
    this.notify()
  }
  freeze(): PlotBuffer<PlotSample> {
    const copy = new PlotBuffer<PlotSample>(this.samples.capacity)
    for (const value of this.samples.slice()) copy.push(value)
    return copy
  }
  private notify(): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.revision++
      for (const listener of this.listeners) listener()
    }, 32)
  }
  dispose(): void {
    this.generation++
    clearTimeout(this.processTimer)
    this.runtime.dispose()
    this.queue = []
    this.inFlight = []
    clearTimeout(this.timer)
    this.timer = undefined
    this.listeners.clear()
  }
}
