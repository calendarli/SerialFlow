export type FirmwareFamily = 'stm32' | 'esp32'
export type FirmwareTraffic = { direction: 'rx' | 'tx'; port: string; hex: string; bytes: number }
export type FirmwareFile = { path: string; name: string; size: number; address: string }
export type FirmwareRequest = {
  family: FirmwareFamily
  transport: 'uart' | 'swd' | 'ymodem'
  port: string
  probe: string
  chip: string
  baudRate: number
  files: FirmwareFile[]
  verify: boolean
  reset: boolean
  restorePort: boolean
  listenForC: boolean
  eraseAll: boolean
  manualBoot: boolean
  connectMode: 'NORMAL' | 'UR'
  toolPath: string
}
export type FirmwareState = {
  id: string
  busy: boolean
  operation: 'detect' | 'flash'
  port: string
  phase: string
  percent: number | null
  totalBytes?: number
  transferredBytes?: number
  startedAt: number
  finishedAt?: number
  outcome?: 'success' | 'error' | 'cancelled'
  logs: string[]
  logCount: number
  restoreWarning?: string
}
export type FirmwareTool = { path: string; available: boolean; version: string; error?: string }
export type FirmwareListenState = {
  port: string
  baudRate: number
  status: 'opening' | 'listening' | 'ready' | 'error'
  receivedCount: number
  error?: string
}
export const espChips = [
  'auto',
  'esp32',
  'esp32s2',
  'esp32s3',
  'esp32c2',
  'esp32c3',
  'esp32c5',
  'esp32c6',
  'esp32h2',
  'esp32p4'
] as const
