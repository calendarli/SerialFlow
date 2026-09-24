import type { SerialPortInfo } from '@common/serial-port'

export type Port = SerialPortInfo
export type SerialConfig = {
  id: number
  name: string
  path: string
  baudRate: number
  dataBits: DataBits
  stopBits: StopBits
  parity: Parity
  framing: SerialFraming
  plotEnabled: boolean
}

export type TargetPortOption = { path: string; name: string }

export type SerialFramingMode = 'raw' | 'delimiter' | 'fixed' | 'header-footer' | 'idle'
export type SerialFraming = {
  mode: SerialFramingMode
  delimiter: string
  fixedLength: number
  header: string
  footer: string
  idleTimeout: number
}

export type Rule = {
  id: number
  groupId: number
  name: string
  pattern: string
  regex?: boolean
  receiveHex?: boolean
  reply: string
  hex: boolean
  enabled: boolean
  targetPort?: string
  parameters: Array<{
    id: string
    value: string
    mode?: 'manual' | 'program'
    inputMode?: 'ascii' | 'dec' | 'hex'
  }>
  parameterMode?: 'parameters' | 'program'
  parameterProgram?: string
}

export type CommandParameter = {
  id: string
  value: string
  inputMode: 'ascii' | 'dec' | 'hex'
  byteLength: number
  inputHex?: boolean
}
export type CrcMode = 'crc8' | 'modbus' | 'ccitt-false' | 'xmodem' | 'crc32'

export type SavedCommand = {
  id: number
  parentId: number | null
  name: string
  template: string
  releaseTemplate?: string
  processingMode?: 'template' | 'program'
  processingProgram?: string
  companion?: {
    enabled: boolean
    source: 'command' | 'custom'
    commandId: number | null
    template: string
    loop: boolean
    interval: number
  }
  hex: boolean
  autoSend: boolean
  autoSendInterval: number
  autoSendCount: number
  crcMode?: CrcMode | null
  targetPort?: string
  parameters: CommandParameter[]
}

export type CommandGroup = {
  id: number
  parentId: number | null
  name: string
  autoLoop: boolean
  loopDelay: number
  loopCount: number
  globals: Record<string, unknown>
}

export type AutoReplyGroup = {
  id: number
  name: string
  globals: Record<string, unknown>
}

export type InteractionEntry = {
  id: number
  direction: 'rx' | 'tx'
  kind?: 'firmware-log'
  text: string
  rawHex?: string
  plotText?: string
  timestampMs?: number
  bytes: number
  port: string
  time?: string
}

export type DataBits = 5 | 6 | 7 | 8
export type StopBits = 1 | 1.5 | 2
export type Parity = 'none' | 'even' | 'odd' | 'mark' | 'space'
