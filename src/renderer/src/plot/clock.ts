export type SampleClock = {
  mode: 'receive' | 'period' | 'device'
  periodMs: number
  field: string
  unitMs: number
  rollover: number
}
export const defaultClock: SampleClock = {
  mode: 'receive',
  periodMs: 10,
  field: 'timestamp',
  unitMs: 1,
  rollover: 0
}
export function normalizeClock(value: Partial<SampleClock> | null | undefined): SampleClock {
  return {
    mode: value?.mode === 'period' || value?.mode === 'device' ? value.mode : 'receive',
    periodMs: Math.max(0.001, Math.min(86400000, Number(value?.periodMs) || 10)),
    field:
      typeof value?.field === 'string' && value.field.trim() ? value.field.trim() : 'timestamp',
    unitMs: Math.max(1e-6, Math.min(86400000, Number(value?.unitMs) || 1)),
    rollover: Math.max(0, Number.isFinite(value?.rollover) ? Number(value?.rollover) : 0)
  }
}

type ClockState = { base: number; source: number; last: number; wraps: number; count: number }
export class SampleClocks {
  private states = new Map<string, ClockState>()
  reset(): void {
    this.states.clear()
  }
  disconnect(port: string): void {
    this.states.delete(port)
  }
  resolve(
    port: string,
    clock: SampleClock,
    values: Record<string, number>,
    received: number,
    last: number
  ): { timestamp: number; gap: boolean; warning: string } {
    if (clock.mode === 'receive')
      return {
        timestamp: Math.max(received, last),
        gap: received < last,
        warning: received < last ? '接收时钟回退，已断开连线' : ''
      }
    let state = this.states.get(port)
    const raw = clock.mode === 'device' ? values[clock.field] : (state?.count ?? 0) * clock.periodMs
    if (!Number.isFinite(raw)) {
      this.states.delete(port)
      return {
        timestamp: Math.max(received, last),
        gap: true,
        warning: `设备时间字段 ${clock.field} 无效，该采样使用接收时间`
      }
    }
    let gap = false,
      warning = ''
    if (state && clock.mode === 'device' && raw < state.last) {
      if (clock.rollover > 0 && state.last - raw > clock.rollover / 2) state.wraps += clock.rollover
      else {
        state = undefined
        gap = true
        warning = '设备时钟重置，已重新对齐并断开连线'
      }
    }
    if (!state) {
      state = { base: Math.max(received, last), source: raw, last: raw, wraps: 0, count: 0 }
      this.states.set(port, state)
    }
    let timestamp =
      state.base + (raw + state.wraps - state.source) * (clock.mode === 'device' ? clock.unitMs : 1)
    if (!Number.isFinite(timestamp)) {
      this.states.delete(port)
      return {
        timestamp: Math.max(received, last),
        gap: true,
        warning: '设备时间超出有效范围，该采样使用接收时间'
      }
    }
    if (timestamp < last) {
      state.base += last - timestamp
      timestamp = last
      gap = true
      warning = '时间源未同步，已重新对齐并断开连线'
    }
    state.last = raw
    state.count++
    return { timestamp, gap, warning }
  }
}
