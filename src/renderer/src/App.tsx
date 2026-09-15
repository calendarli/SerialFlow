import { normalizeSerialPortPath } from '@common/serial-port'
import {
  interactionDisplayKey,
  loadInteractionDisplay,
  normalizeInteractionDisplay,
  InteractionTextDecoder,
  type InteractionDisplay
} from './interaction-settings'
import { DataWindowManager } from './components/DataWindowManager'
import appIcon from './assets/app-icon.png'
import { WindowPinButton } from './components/WindowPinButton'
import { appendHexHistory, findReplyMatch, replyByteOffset } from './reply-matcher'
import { removeReplyGroup } from './auto-reply-groups'
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ReceivePanel } from './components/ReceivePanel'
import { PlotPanel } from './components/PlotPanel'
import { PlotStore } from './plot-store'
import { ModbusPanel } from './components/ModbusPanel'
import { AutoReplyPanel } from './components/AutoReplyPanel'
import { AboutPanel } from './components/AboutPanel'
import { useAppUpdates } from './use-app-updates'
import { UpdateNotice } from './components/UpdateControls'
import { CommandsPanel } from './components/CommandsPanel'
import { normalizeCommandExtensions } from './command-settings'
import { SendPanel } from './components/SendPanel'
import { SerialConfigPanel } from './components/SerialConfigPanel'
import { SerialPairPanel } from './components/SerialPairPanel'
import { Sidebar } from './components/Sidebar'
import {
  createAutoReplyTransfer,
  createQuickCommandsTransfer,
  parseAutoReplyTransfer
} from './config-transfer'
import {
  applyQuickCommandImport,
  type QuickCommandImport,
  type QuickCommandImportOptions
} from './quick-command-import'
import { defaultSerialFraming, SerialFramer } from './serial-framer'
import { autoReplyProgramRuntime } from './scripts/auto-reply-program'
import { fillGlobalPlaceholders, normalizeGroupGlobals } from './scripts/group-globals'
import {
  appendCrc,
  bytesToBase64,
  bytesToHex,
  convertSerialText,
  encodeSerialData,
  formatTime
} from './serial-utils'
import type {
  CommandGroup,
  AutoReplyGroup,
  CrcMode,
  DataBits,
  InteractionEntry,
  Parity,
  Port,
  Rule,
  SavedCommand,
  SerialConfig,
  SerialFraming,
  StopBits
} from './types'

const defaultRules: Rule[] = [
  {
    id: 1,
    groupId: 1,
    name: 'AT 应答',
    pattern: '^AT$',
    reply: 'OK\\r\\n',
    hex: false,
    enabled: true,
    parameters: []
  }
]

function loadRules(): Rule[] {
  try {
    const saved = JSON.parse(localStorage.getItem('serialflow.autoReplyRules') || 'null') as
      Partial<Rule>[] | null
    if (!Array.isArray(saved)) return defaultRules
    return saved.map((rule, index) => ({
      id: typeof rule.id === 'number' ? rule.id : Date.now() + index,
      groupId: typeof rule.groupId === 'number' ? rule.groupId : 1,
      name: rule.name || `规则 ${index + 1}`,
      pattern: rule.pattern || '',
      regex: rule.regex !== false,
      receiveHex:
        typeof rule.receiveHex === 'boolean'
          ? rule.receiveHex
          : Boolean(rule.hex && /^(?:[0-9a-f]{2}\s*)+$/i.test(rule.pattern || '')),
      reply: rule.reply || '',
      hex: Boolean(rule.hex),
      enabled: rule.enabled !== false,
      targetPort: typeof rule.targetPort === 'string' ? rule.targetPort : '',
      parameterMode:
        rule.parameterMode === 'program' || rule.parameters?.some((item) => item.mode === 'program')
          ? 'program'
          : 'parameters',
      parameterProgram: typeof rule.parameterProgram === 'string' ? rule.parameterProgram : '',
      parameters: Array.isArray(rule.parameters)
        ? rule.parameters
            .filter((item) => item?.id)
            .map((item) => ({
              id: item.id,
              value: item.value || '',
              inputMode:
                item.inputMode === 'ascii' || item.inputMode === 'dec' || item.inputMode === 'hex'
                  ? item.inputMode
                  : rule.hex
                    ? 'hex'
                    : 'ascii'
            }))
        : []
    }))
  } catch {
    return defaultRules
  }
}

function inferParameterByteLength(parameter: SavedCommand['parameters'][number]): number {
  if (Number.isInteger(parameter.byteLength) && parameter.byteLength > 0)
    return Math.min(64, parameter.byteLength)
  const value = parameter.value?.trim()
  if (!value) return 1
  try {
    const mode = parameter.inputMode || (parameter.inputHex ? 'hex' : 'dec')
    if (mode === 'ascii') return 1
    if (mode === 'hex' && /^[0-9a-f]+$/i.test(value))
      return Math.min(64, Math.max(1, Math.ceil(value.length / 2)))
    if (mode === 'dec' && /^\d+$/.test(value)) {
      const numericValue = BigInt(value)
      return Math.min(64, Math.max(1, Math.ceil(numericValue.toString(2).length / 8)))
    }
  } catch {
    /* Keep the safe default for malformed legacy values. */
  }
  return 1
}

function loadCommands(): SavedCommand[] {
  try {
    const saved = JSON.parse(localStorage.getItem('serialflow.commands') || '[]') as SavedCommand[]
    return Array.isArray(saved)
      ? saved.map((command) => ({
          ...command,
          ...normalizeCommandExtensions(command),
          parentId: command.parentId ?? null,
          releaseTemplate:
            typeof command.releaseTemplate === 'string' ? command.releaseTemplate : '',
          autoSend: Boolean(command.autoSend),
          autoSendInterval: Math.max(1, command.autoSendInterval || 1000),
          autoSendCount:
            Number.isInteger(command.autoSendCount) && command.autoSendCount >= 0
              ? command.autoSendCount
              : 0,
          crcMode: ['crc8', 'modbus', 'ccitt-false', 'xmodem', 'crc32'].includes(
            command.crcMode || ''
          )
            ? command.crcMode
            : null,
          targetPort: typeof command.targetPort === 'string' ? command.targetPort : '',
          parameters: Array.isArray(command.parameters)
            ? command.parameters.map((parameter) => ({
                ...parameter,
                inputMode: parameter.inputMode || (parameter.inputHex ? 'hex' : 'dec'),
                byteLength: inferParameterByteLength(parameter)
              }))
            : []
        }))
      : []
  } catch {
    return []
  }
}

function loadCommandGroups(): CommandGroup[] {
  try {
    const saved = JSON.parse(
      localStorage.getItem('serialflow.commandGroups') || '[]'
    ) as CommandGroup[]
    return Array.isArray(saved)
      ? saved.map((group) => ({
          ...group,
          parentId: group.parentId ?? null,
          autoLoop: Boolean(group.autoLoop),
          loopDelay: Math.max(1, group.loopDelay || 100),
          loopCount:
            Number.isInteger(group.loopCount) && group.loopCount >= 0 ? group.loopCount : 0,
          globals: normalizeGroupGlobals(group.globals)
        }))
      : []
  } catch {
    return []
  }
}

const defaultAutoReplyGroups: AutoReplyGroup[] = [{ id: 1, name: '默认分组', globals: {} }]

function loadAutoReplyGroups(): AutoReplyGroup[] {
  try {
    const saved = JSON.parse(localStorage.getItem('serialflow.autoReplyGroups') || 'null') as
      Partial<AutoReplyGroup>[] | null
    if (!Array.isArray(saved) || !saved.length) return defaultAutoReplyGroups
    return saved.map((group, index) => ({
      id: typeof group.id === 'number' ? group.id : Date.now() + index,
      name: group.name?.trim() || `分组 ${index + 1}`,
      globals: normalizeGroupGlobals(group.globals)
    }))
  } catch {
    return defaultAutoReplyGroups
  }
}

function convertRuleParameter(
  value: string,
  inputMode: 'ascii' | 'dec' | 'hex',
  hex: boolean
): string {
  if (!value) return ''
  if (inputMode === 'ascii') return hex ? bytesToHex(new TextEncoder().encode(value)) : value
  const clean = value.trim()
  if (inputMode === 'hex' ? !/^[0-9a-f]+$/i.test(clean) : !/^\d+$/.test(clean))
    throw new Error(
      inputMode === 'hex' ? 'HEX 参数只能包含 0-9、A-F' : 'DEC 参数只能输入十进制数字 0-9'
    )
  const numericValue = BigInt(inputMode === 'hex' ? `0x${clean}` : clean)
  if (!hex) return numericValue.toString(10)
  const converted = numericValue.toString(16).toUpperCase()
  return converted.padStart(converted.length + (converted.length % 2), '0')
}

function fillRuleParameters(rule: Rule, values?: Record<string, string>): string {
  return rule.parameters.reduce(
    (template, parameter) =>
      template.replaceAll(
        `{{${parameter.id}}}`,
        rule.parameterMode === 'program'
          ? (values?.[parameter.id] ?? parameter.value)
          : convertRuleParameter(
              values?.[parameter.id] ?? parameter.value,
              parameter.inputMode || (rule.hex ? 'hex' : 'ascii'),
              rule.hex
            )
      ),
    rule.reply
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function explainUiError(error: unknown, fallback = '操作失败，请重试'): string {
  let message = error instanceof Error ? error.message : String(error || '')
  message = message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error occurred in handler for '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
  return message || fallback
}

const sendPanelHeightKey = 'serialflow.sendPanelHeight'
function clampSendPanelHeight(value: number): number {
  const maximum = Math.max(160, window.innerHeight - 365)
  return Math.min(Math.max(Math.round(value), 160), maximum)
}
function loadSendPanelHeight(): number {
  const saved = Number(localStorage.getItem(sendPanelHeightKey))
  return clampSendPanelHeight(Number.isFinite(saved) && saved > 0 ? saved : 230)
}

const cacheSizeKey = 'serialflow.interactionCacheMb'
const cacheEntryKey = 'serialflow.interactionCacheEntries'
const interactionFontSizeKey = 'serialflow.interactionFontSize'
const globalFontUpgradeKey = 'serialflow.globalFontUpgrade20260814V2'
const receiveHexKey = 'serialflow.receiveHex'
const timestampKey = 'serialflow.timestamp'
const sendCrcEnabledKey = 'serialflow.sendCrcEnabled'
const sendCrcModeKey = 'serialflow.sendCrcMode'
const sendIntervalKey = 'serialflow.sendInterval'
const sendCountKey = 'serialflow.sendCount'
const autoPauseEnabledKey = 'serialflow.autoPauseEnabled'
const autoPausePatternKey = 'serialflow.autoPausePattern'
const autoPauseRegexKey = 'serialflow.autoPauseRegex'
const autoPauseHexKey = 'serialflow.autoPauseHex'
const serialConfigKey = 'serialflow.serialConfig'
const serialConfigsKey = 'serialflow.serialConfigs'

function formatCacheBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function formatFrequency(frequency: number): string {
  return frequency < 10 && frequency > 0
    ? frequency.toFixed(1)
    : Math.round(frequency).toLocaleString()
}
type PersistedSerialConfig = {
  name?: string
  path: string
  baudRate: number
  dataBits: DataBits
  stopBits: StopBits
  parity: Parity
  framing: SerialFraming
  plotEnabled: boolean
}
function normalizeSerialFraming(value?: Partial<SerialFraming>): SerialFraming {
  const mode = ['raw', 'delimiter', 'fixed', 'header-footer', 'idle'].includes(value?.mode || '')
    ? (value!.mode as SerialFraming['mode'])
    : defaultSerialFraming.mode
  return {
    ...defaultSerialFraming,
    ...value,
    mode,
    fixedLength: Math.max(1, Math.floor(Number(value?.fixedLength) || 8)),
    idleTimeout: Math.max(1, Math.floor(Number(value?.idleTimeout) || 20))
  }
}
function loadSerialConfig(): PersistedSerialConfig {
  const fallback: PersistedSerialConfig = {
    path: '',
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    framing: defaultSerialFraming,
    plotEnabled: false
  }
  try {
    const saved = JSON.parse(
      localStorage.getItem(serialConfigKey) || 'null'
    ) as Partial<PersistedSerialConfig> | null
    if (!saved) return fallback
    const dataBits = [5, 6, 7, 8].includes(Number(saved.dataBits))
      ? (saved.dataBits as DataBits)
      : fallback.dataBits
    let stopBits = [1, 1.5, 2].includes(Number(saved.stopBits))
      ? (saved.stopBits as StopBits)
      : fallback.stopBits
    if ((dataBits === 5 && stopBits === 2) || (dataBits !== 5 && stopBits === 1.5)) stopBits = 1
    const parity = ['none', 'even', 'odd', 'mark', 'space'].includes(String(saved.parity))
      ? (saved.parity as Parity)
      : fallback.parity
    const baudRate =
      Number.isInteger(saved.baudRate) && Number(saved.baudRate) > 0
        ? Number(saved.baudRate)
        : fallback.baudRate
    return {
      path: typeof saved.path === 'string' ? saved.path : '',
      baudRate,
      dataBits,
      stopBits,
      parity,
      framing: normalizeSerialFraming(saved.framing),
      plotEnabled: saved.plotEnabled === true
    }
  } catch {
    return fallback
  }
}
function loadSerialConfigs(): SerialConfig[] {
  try {
    const saved = JSON.parse(localStorage.getItem(serialConfigsKey) || 'null') as
      SerialConfig[] | null
    if (Array.isArray(saved) && saved.length) {
      return saved.map((config, index) => ({
        ...config,
        id: Number(config.id) || Date.now() + index,
        name: config.name?.trim() || `串口组 ${index + 1}`,
        framing: normalizeSerialFraming(config.framing),
        plotEnabled: config.plotEnabled === true
      }))
    }
  } catch {
    /* Migrate the previous single-port setting below. */
  }
  return [{ id: Date.now(), name: '串口组 1', ...loadSerialConfig() }]
}
function loadPositiveSetting(key: string, fallback: number): number {
  const value = Number(localStorage.getItem(key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}
function loadNonnegativeSetting(key: string, fallback: number): number {
  const value = Number(localStorage.getItem(key))
  return Number.isInteger(value) && value >= 0 ? value : fallback
}
function loadBooleanSetting(key: string, fallback: boolean): boolean {
  const value = localStorage.getItem(key)
  return value === null ? fallback : value === 'true'
}
function loadCrcMode(): CrcMode {
  const saved = localStorage.getItem(sendCrcModeKey)
  return ['crc8', 'modbus', 'ccitt-false', 'xmodem', 'crc32'].includes(saved || '')
    ? (saved as CrcMode)
    : 'modbus'
}
function loadEntryLimit(): number {
  const saved = localStorage.getItem(cacheEntryKey)
  if (saved === null) return 5000
  const value = Number(saved)
  return Number.isFinite(value) && value >= 0 ? value : 5000
}
function trimInteractionEntries(
  entries: InteractionEntry[],
  maxBytes: number,
  maxEntries: number
): InteractionEntry[] {
  let start = entries.length
  let bytes = 0
  let count = 0
  const entryLimit = maxEntries === 0 ? Number.POSITIVE_INFINITY : maxEntries
  while (start > 0 && count < entryLimit) {
    const nextBytes = entries[start - 1].bytes
    if (count > 0 && bytes + nextBytes > maxBytes) break
    start -= 1
    count += 1
    bytes += nextBytes
  }
  return start === 0 ? entries : entries.slice(start)
}

function App(): React.JSX.Element {
  const updates = useAppUpdates()
  const [ports, setPorts] = useState<Port[]>([])
  const [serialConfigs, setSerialConfigs] = useState<SerialConfig[]>(loadSerialConfigs)
  const [openedPorts, setOpenedPorts] = useState<Set<string>>(new Set())
  const serialSessionVersions = useRef(new Map<string, number>())
  const [sendPort, setSendPort] = useState('')
  const connected = openedPorts.size > 0
  const targetPortOptions = useMemo(() => {
    const seen = new Set<string>()
    return serialConfigs.flatMap((config, index) => {
      const path = normalizeSerialPortPath(config.path)
      if (!path || seen.has(path)) return []
      seen.add(path)
      return [{ path, name: config.name?.trim() || `串口组 ${index + 1}` }]
    })
  }, [serialConfigs])
  const plotPorts = useMemo(
    () =>
      serialConfigs
        .filter((config) => config.plotEnabled && config.path)
        .map((config) => config.path),
    [serialConfigs]
  )
  const openedPortList = useMemo(() => [...openedPorts], [openedPorts])
  const plotStore = useMemo(() => {
    const store = new PlotStore()
    try {
      const saved = JSON.parse(localStorage.getItem('serialflow.plotProgram') || 'null')
      if (saved && typeof saved.source === 'string')
        store.configureProgram(saved.enabled === true, saved.source)
    } catch {
      /* Use raw channels for invalid saved settings. */
    }
    return store
  }, [])
  useEffect(() => () => plotStore.dispose(), [plotStore])
  const [connectionBusy, setConnectionBusy] = useState(false)
  const [rxHex, setRxHex] = useState(() => loadBooleanSetting(receiveHexKey, false))
  const [timestamp, setTimestamp] = useState(() => loadBooleanSetting(timestampKey, true))
  const [paused, setPausedState] = useState(false)
  const receivePausedRef = useRef(false)
  const setPaused = useCallback(
    (value: boolean): void => {
      receivePausedRef.current = value
      plotStore.setReceivingPaused(value)
      setPausedState(value)
    },
    [plotStore]
  )
  const [autoPauseEnabled, setAutoPauseEnabled] = useState(() =>
    loadBooleanSetting(autoPauseEnabledKey, false)
  )
  const [autoPausePattern, setAutoPausePattern] = useState(
    () => localStorage.getItem(autoPausePatternKey) || ''
  )
  const [autoPauseRegex, setAutoPauseRegex] = useState(() =>
    loadBooleanSetting(autoPauseRegexKey, false)
  )
  const [autoPauseHex, setAutoPauseHex] = useState(() => loadBooleanSetting(autoPauseHexKey, true))
  const [interactionCache, setInteractionCache] = useState<{
    entries: InteractionEntry[]
    bytes: number
  }>({ entries: [], bytes: 0 })
  const [sendText, setSendText] = useState('')
  const [sendHex, setSendHex] = useState(false)
  const [sendLineEnding, setSendLineEnding] = useState<'' | '\n' | '\r' | '\n\r' | '\r\n'>('')
  const [sendCrcEnabled, setSendCrcEnabled] = useState(() =>
    loadBooleanSetting(sendCrcEnabledKey, false)
  )
  const [sendCrcMode, setSendCrcMode] = useState<CrcMode>(loadCrcMode)
  const [autoSend, setAutoSend] = useState(false)
  const [autoSendRunning, setAutoSendRunning] = useState(false)
  const [interval, setIntervalValue] = useState(() => loadPositiveSetting(sendIntervalKey, 1000))
  const [autoSendCount, setAutoSendCount] = useState(() => loadNonnegativeSetting(sendCountKey, 0))
  const [rules, setRules] = useState<Rule[]>(loadRules)
  const [autoReplyGroups, setAutoReplyGroups] = useState<AutoReplyGroup[]>(loadAutoReplyGroups)
  const [commands, setCommands] = useState<SavedCommand[]>(loadCommands)
  const [commandGroups, setCommandGroups] = useState<CommandGroup[]>(loadCommandGroups)
  const [sideTab, setSideTab] = useState<
    'serial' | 'pairs' | 'commands' | 'rules' | 'modbus' | 'about'
  >('serial')
  const [rxCommunicationCount, setRxCommunicationCount] = useState(0)
  const [txCommunicationCount, setTxCommunicationCount] = useState(0)
  const [rxFrequency, setRxFrequency] = useState(0)
  const [txFrequency, setTxFrequency] = useState(0)
  const [message, setMessage] = useState('就绪')
  const [errorDialog, setErrorDialog] = useState<string | null>(null)
  const [sendPanelHeight, setSendPanelHeight] = useState(loadSendPanelHeight)
  const [interactionDisplay, setInteractionDisplay] = useState(loadInteractionDisplay)
  const displayDecoders = useRef(new InteractionTextDecoder())
  const [interactionCacheMb, setInteractionCacheMb] = useState(() =>
    loadPositiveSetting(cacheSizeKey, 8)
  )
  const [interactionCacheEntries, setInteractionCacheEntries] = useState(loadEntryLimit)
  const [interactionFontSize, setInteractionFontSize] = useState(() => {
    const current = Math.min(24, Math.max(8, loadPositiveSetting(interactionFontSizeKey, 10)))
    if (localStorage.getItem(globalFontUpgradeKey)) return current
    const upgraded = Math.min(24, current + 4)
    localStorage.setItem(interactionFontSizeKey, String(upgraded))
    localStorage.setItem(globalFontUpgradeKey, '1')
    return upgraded
  })
  const replyBuffers = useRef(new Map<string, Uint8Array>())
  const pauseLineBuffers = useRef(new Map<string, string>())
  const pauseHexBuffers = useRef(new Map<string, string>())
  const connectionBusyRef = useRef(false)
  const textDecoders = useRef(new Map<string, TextDecoder>())
  const entryIdRef = useRef(0)
  const pendingFrameRef = useRef<number | null>(null)
  const pendingInteractionsRef = useRef<{
    entries: InteractionEntry[]
    rxEvents: number
    txEvents: number
  }>({ entries: [], rxEvents: 0, txEvents: 0 })
  const trafficEventsRef = useRef({ rx: 0, tx: 0 })
  const frequencySampleRef = useRef({ rx: 0, tx: 0, time: 0 })
  const interactionSettingsRef = useRef({
    maxBytes: interactionCacheMb * 1024 * 1024,
    maxEntries: interactionCacheEntries,
    timestamp
  })
  const autoSendCompletedRef = useRef(0)
  const serialFramerRef = useRef(new SerialFramer())
  const framingSignaturesRef = useRef(new Map<string, string>())
  const autoReplyErrorCountsRef = useRef(new Map<number, number>())
  const autoReplyGroupsRef = useRef(autoReplyGroups)

  useEffect(() => {
    interactionSettingsRef.current = {
      maxBytes: interactionCacheMb * 1024 * 1024,
      maxEntries: interactionCacheEntries,
      timestamp
    }
  }, [interactionCacheEntries, interactionCacheMb, timestamp])

  const showProblem = useCallback((problem: string): void => {
    setMessage(problem)
    setErrorDialog(problem)
  }, [])

  const showError = useCallback(
    (error: unknown, fallback: string): void => {
      showProblem(explainUiError(error, fallback))
    },
    [showProblem]
  )

  const flushInteractions = useCallback((): void => {
    pendingFrameRef.current = null
    const pending = pendingInteractionsRef.current
    pendingInteractionsRef.current = {
      entries: [],
      rxEvents: 0,
      txEvents: 0
    }
    startTransition(() => {
      if (pending.rxEvents) setRxCommunicationCount((count) => count + pending.rxEvents)
      if (pending.txEvents) setTxCommunicationCount((count) => count + pending.txEvents)
      if (!pending.entries.length) return
      const addedBytes = pending.entries.reduce((total, entry) => total + entry.bytes, 0)
      setInteractionCache((current) => {
        const entries = [...current.entries, ...pending.entries]
        const settings = interactionSettingsRef.current
        let totalBytes = current.bytes + addedBytes
        let start = 0
        while (
          start < entries.length &&
          ((settings.maxEntries > 0 && entries.length - start > settings.maxEntries) ||
            totalBytes > settings.maxBytes)
        ) {
          totalBytes -= entries[start].bytes
          start += 1
        }
        return { entries: start ? entries.slice(start) : entries, bytes: totalBytes }
      })
    })
  }, [])

  useEffect(
    () => () => {
      if (pendingFrameRef.current !== null) window.clearTimeout(pendingFrameRef.current)
    },
    []
  )

  const queueInteraction = useCallback(
    (
      direction: 'rx' | 'tx',
      port: string,
      text: string,
      bytes: number,
      visible = true,
      plotText?: string,
      rawHex?: string
    ): void => {
      const pending = pendingInteractionsRef.current
      const timestampMs = Date.now()
      if (direction === 'rx') plotStore.append(port, plotText ?? text, timestampMs)
      if (direction === 'rx') {
        pending.rxEvents += 1
        trafficEventsRef.current.rx += 1
      } else if (direction === 'tx') {
        pending.txEvents += 1
        trafficEventsRef.current.tx += 1
      }
      if (visible) {
        pending.entries.push({
          id: ++entryIdRef.current,
          direction,
          port,
          text,
          rawHex,
          plotText,
          timestampMs,
          bytes,
          time: interactionSettingsRef.current.timestamp
            ? formatTime(new Date(timestampMs))
            : undefined
        })
      }
      if (pendingFrameRef.current === null)
        // Batch presentation only; framing, matching and counters still see every frame.
        pendingFrameRef.current = window.setTimeout(flushInteractions, 32)
    },
    [flushInteractions, plotStore]
  )

  const compiledRules = useMemo(
    () =>
      rules.flatMap((rule) => {
        if (!rule.enabled) return []
        try {
          const literal = rule.receiveHex
            ? rule.pattern.trim().replace(/\s+/g, ' ').toUpperCase()
            : rule.pattern
          const source =
            rule.regex === false
              ? rule.receiveHex
                ? `(?<!\\S)${escapeRegExp(literal)}(?!\\S)`
                : `^${escapeRegExp(literal)}$`
              : rule.pattern
          return [{ rule, expression: new RegExp(source, 'm') }]
        } catch {
          return []
        }
      }),
    [rules]
  )
  const autoPauseExpression = useMemo(() => {
    if (!autoPauseEnabled || !autoPausePattern.trim()) return null
    try {
      const literal = autoPauseHex
        ? autoPausePattern.trim().replace(/\s+/g, ' ').toUpperCase()
        : autoPausePattern
      return new RegExp(autoPauseRegex ? autoPausePattern : `^${escapeRegExp(literal)}$`, 'm')
    } catch {
      return null
    }
  }, [autoPauseEnabled, autoPauseHex, autoPausePattern, autoPauseRegex])

  const applyPorts = useCallback((rawList: Port[]) => {
    const seen = new Set<string>()
    const list = rawList.filter((port) => {
      const path = normalizeSerialPortPath(port.path)
      if (!path || seen.has(path)) return false
      seen.add(path)
      return true
    })
    setPorts(list)
    setSerialConfigs((current) =>
      current.map((config, index) =>
        index === 0 && !config.path && list[0]?.path ? { ...config, path: list[0].path } : config
      )
    )
  }, [])

  const refreshPorts = useCallback(async () => {
    try {
      const list = await window.api.listPorts()
      applyPorts(list)
      setMessage(
        list.length
          ? `发现 ${list.length} 个串口`
          : '未发现串口设备，请检查 USB 连接、驱动安装和设备供电'
      )
    } catch (error) {
      showError(error, '刷新串口列表失败')
    }
  }, [applyPorts, showError])

  const send = useCallback(
    async (override?: {
      text: string
      hex: boolean
      crcMode?: CrcMode | null
      targetPort?: string
    }): Promise<boolean> => {
      const targetPort = override?.targetPort || sendPort
      if (!targetPort || !openedPorts.has(targetPort)) {
        showProblem(targetPort ? `目标串口 ${targetPort} 尚未打开` : '请选择一个已打开的发送串口')
        return false
      }
      try {
        const source = override?.text ?? sendText
        const effectiveHex = override?.hex ?? sendHex
        let bytes = encodeSerialData(source, effectiveHex)
        if (!override && sendLineEnding) {
          const suffix = new TextEncoder().encode(sendLineEnding)
          const merged = new Uint8Array(bytes.length + suffix.length)
          merged.set(bytes)
          merged.set(suffix, bytes.length)
          bytes = merged
        }
        const crcMode = override ? override.crcMode : sendCrcEnabled ? sendCrcMode : null
        if (crcMode) bytes = appendCrc(bytes, crcMode)
        if (!bytes.length) {
          showProblem('发送内容不能为空；如需发送换行，请启用“加回车换行”')
          return false
        }
        await window.api.write(targetPort, bytesToBase64(bytes))
        queueInteraction(
          'tx',
          targetPort,
          effectiveHex || crcMode
            ? bytesToHex(bytes)
            : new TextDecoder(interactionDisplay.encoding).decode(bytes),
          bytes.length
        )
        setMessage(`已通过 ${targetPort} 发送 ${bytes.length} 字节`)
        return true
      } catch (error) {
        showError(error, '发送失败')
        return false
      }
    },
    [
      interactionDisplay.encoding,
      sendLineEnding,
      openedPorts,
      queueInteraction,
      sendPort,
      sendCrcEnabled,
      sendCrcMode,
      sendHex,
      sendText,
      showError,
      showProblem
    ]
  )
  const sendRef = useRef(send)
  useEffect(() => {
    sendRef.current = send
  }, [send])
  const sendCommandData = useCallback(
    (text: string, hex: boolean, crcMode?: CrcMode | null, targetPort?: string): Promise<boolean> =>
      sendRef.current({ text, hex, crcMode, targetPort }),
    []
  )

  useEffect(() => {
    const unsubscribe = window.api.onPortsChanged(applyPorts)
    const timer = window.setTimeout(() => void refreshPorts(), 0)
    return () => {
      window.clearTimeout(timer)
      unsubscribe()
    }
  }, [applyPorts, refreshPorts])

  useEffect(() => {
    frequencySampleRef.current = { ...trafficEventsRef.current, time: performance.now() }
    const timer = window.setInterval(() => {
      const now = performance.now()
      const previous = frequencySampleRef.current
      const elapsedSeconds = Math.max((now - previous.time) / 1000, 0.001)
      const current = trafficEventsRef.current
      setRxFrequency((current.rx - previous.rx) / elapsedSeconds)
      setTxFrequency((current.tx - previous.tx) / elapsedSeconds)
      frequencySampleRef.current = { rx: current.rx, tx: current.tx, time: now }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const next = new Map(
      serialConfigs.map((config) => [config.path, JSON.stringify(config.framing)])
    )
    for (const [port, signature] of framingSignaturesRef.current) {
      if (next.get(port) === signature) continue
      serialFramerRef.current.clear(port)
      textDecoders.current.delete(port)
      replyBuffers.current.delete(port)
      pauseLineBuffers.current.delete(port)
      pauseHexBuffers.current.delete(port)
    }
    framingSignaturesRef.current = next
  }, [serialConfigs])

  useEffect(() => {
    const framer = serialFramerRef.current
    return () => framer.clear()
  }, [])

  useEffect(() => {
    const processReceivedFrame = (sourcePort: string, bytes: Uint8Array): void => {
      let decoder = textDecoders.current.get(sourcePort)
      if (!decoder) {
        decoder = new TextDecoder()
        textDecoders.current.set(sourcePort, decoder)
      }
      const text = decoder.decode(bytes, { stream: true })
      const chunkHex = bytesToHex(bytes)
      const activeRules = compiledRules.filter(
        ({ rule }) => !rule.targetPort || rule.targetPort === sourcePort
      )
      const needsReplyText = activeRules.some(({ rule }) => !rule.receiveHex)
      const needsReplyHex = activeRules.some(({ rule }) => rule.receiveHex)
      let replyBytes: Uint8Array = bytes
      if (activeRules.length) {
        const previousReply = replyBuffers.current.get(sourcePort)
        if (previousReply?.length) {
          replyBytes = new Uint8Array(previousReply.length + bytes.length)
          replyBytes.set(previousReply)
          replyBytes.set(bytes, previousReply.length)
        }
      }
      // Only prepare history representations that an enabled rule actually uses.
      let lineBuffer = needsReplyText ? new TextDecoder().decode(replyBytes, { stream: true }) : ''
      let hexBuffer = needsReplyHex ? bytesToHex(replyBytes) : ''
      let shouldAutoPause = false
      if (!paused && autoPauseExpression) {
        let pauseCandidates: string[]
        if (autoPauseHex) {
          const previous = pauseHexBuffers.current.get(sourcePort) || ''
          const history = appendHexHistory(previous, chunkHex)
          pauseHexBuffers.current.set(sourcePort, history)
          pauseCandidates = [history, chunkHex]
        } else {
          const history = ((pauseLineBuffers.current.get(sourcePort) || '') + text).slice(-8192)
          pauseLineBuffers.current.set(sourcePort, history)
          pauseCandidates = [
            history,
            ...history.split(/\r?\n/).map((line) => line.replace(/\r$/, ''))
          ]
        }
        shouldAutoPause = pauseCandidates.some((candidate) => {
          autoPauseExpression.lastIndex = 0
          return autoPauseExpression.test(candidate)
        })
      } else {
        pauseLineBuffers.current.delete(sourcePort)
        pauseHexBuffers.current.delete(sourcePort)
      }
      // Consume one match at a time, preserving the unprocessed suffix for later chunks.
      let matching = activeRules.length > 0
      while (matching) {
        matching = false
        const matches = activeRules
          .flatMap(({ rule, expression }, priority) => {
            if (rule.targetPort && rule.targetPort !== sourcePort) return []
            const selected = findReplyMatch(
              expression,
              rule.receiveHex ? hexBuffer : lineBuffer,
              !rule.receiveHex
            )
            return selected
              ? [
                  {
                    rule,
                    selected,
                    priority,
                    start: replyByteOffset(replyBytes, selected.start, !!rule.receiveHex)
                  }
                ]
              : []
          })
          .sort((a, b) => a.start - b.start || a.priority - b.priority)
        for (const { rule, selected } of matches) {
          const { input: matchedCandidate, match: matchedResult, end } = selected
          const consumedBytes = replyByteOffset(replyBytes, end, !!rule.receiveHex)
          replyBytes = replyBytes.subarray(consumedBytes)
          lineBuffer = needsReplyText ? new TextDecoder().decode(replyBytes, { stream: true }) : ''
          hexBuffer = needsReplyHex ? bytesToHex(replyBytes) : ''
          matching = true
          if (rule.parameterMode === 'program') {
            const sessionVersion = serialSessionVersions.current.get(sourcePort) || 0
            const match = Array.from(matchedResult, (value) => value ?? '')
            const groups = { ...(matchedResult.groups || {}) }
            const replyGroup =
              autoReplyGroupsRef.current.find((group) => group.id === rule.groupId) ||
              autoReplyGroupsRef.current[0]
            void autoReplyProgramRuntime
              .run(
                rule,
                { input: matchedCandidate, match, groups, port: sourcePort },
                replyGroup?.id || 1,
                replyGroup?.globals || {}
              )
              .then(({ values, globals }) => {
                if ((serialSessionVersions.current.get(sourcePort) || 0) !== sessionVersion) return
                if (replyGroup)
                  setAutoReplyGroups((current) =>
                    current.map((group) =>
                      group.id === replyGroup.id ? { ...group, globals } : group
                    )
                  )
                autoReplyErrorCountsRef.current.delete(rule.id)
                const reply = fillGlobalPlaceholders(
                  fillRuleParameters(rule, values),
                  globals,
                  rule.hex
                )
                  .replace(/\\r/g, '\r')
                  .replace(/\\n/g, '\n')
                void send({
                  text: reply,
                  hex: rule.hex,
                  targetPort: rule.targetPort || sourcePort
                }).catch((cause) => showError(cause, `自动回复“${rule.name}”发送失败`))
              })
              .catch((cause) => {
                if (cause instanceof Error && cause.message === '规则状态已重置') return
                const count = (autoReplyErrorCountsRef.current.get(rule.id) || 0) + 1
                autoReplyErrorCountsRef.current.set(rule.id, count)
                if (count === 1 || count % 10 === 0)
                  showError(
                    cause,
                    `自动回复“${rule.name}”编程执行失败（第 ${count} 次，规则保持启用）`
                  )
                else setMessage(`自动回复“${rule.name}”编程执行失败 ${count} 次，规则仍保持启用`)
              })
          } else {
            const replyGroup =
              autoReplyGroupsRef.current.find((group) => group.id === rule.groupId) ||
              autoReplyGroupsRef.current[0]
            const reply = fillGlobalPlaceholders(
              fillRuleParameters(rule),
              replyGroup?.globals || {},
              rule.hex
            )
              .replace(/\\r/g, '\r')
              .replace(/\\n/g, '\n')
            void send({ text: reply, hex: rule.hex, targetPort: rule.targetPort || sourcePort })
          }
          break
        }
      }
      if (activeRules.length) replyBuffers.current.set(sourcePort, replyBytes.slice(-8192))
      else replyBuffers.current.delete(sourcePort)
      const displayText = displayDecoders.current.decode(
        sourcePort,
        bytes,
        interactionDisplay.encoding
      )
      const rendered = rxHex ? `${chunkHex} ` : displayText
      queueInteraction(
        'rx',
        sourcePort,
        rendered,
        bytes.length,
        !receivePausedRef.current,
        text,
        chunkHex
      )
      if (shouldAutoPause) {
        pauseLineBuffers.current.set(sourcePort, '')
        pauseHexBuffers.current.set(sourcePort, '')
        setPaused(true)
        setMessage(`已按条件自动暂停：${autoPausePattern}`)
      }
    }
    const offData = window.api.onData(({ path: sourcePort, chunks }) => {
      const framing =
        serialConfigs.find((config) => config.path === sourcePort)?.framing || defaultSerialFraming
      for (const chunk of chunks) {
        try {
          serialFramerRef.current.push(sourcePort, framing, chunk, (frame) =>
            processReceivedFrame(sourcePort, frame)
          )
        } catch (cause) {
          showError(cause, `${sourcePort} 接收分帧失败`)
        }
      }
    })
    const offStatus = window.api.onStatus((status) => {
      if (!status.open) plotStore.disconnect(status.path)
      serialSessionVersions.current.set(
        status.path,
        (serialSessionVersions.current.get(status.path) || 0) + 1
      )
      displayDecoders.current.clear(status.path)
      serialFramerRef.current.clear(status.path)
      textDecoders.current.delete(status.path)
      replyBuffers.current.delete(status.path)
      pauseLineBuffers.current.delete(status.path)
      pauseHexBuffers.current.delete(status.path)
      setOpenedPorts((current) => {
        const next = new Set(current)
        if (status.open) next.add(status.path)
        else next.delete(status.path)
        return next
      })
      if (status.open) setSendPort((current) => current || status.path)
      else if (sendPort === status.path) {
        setSendPort('')
        setAutoSend(false)
        setAutoSendRunning(false)
      }
    })
    const offError = window.api.onError((error) =>
      showError(error.message, `${error.path} 串口通信异常`)
    )
    return () => {
      offData()
      offStatus()
      offError()
    }
  }, [
    interactionDisplay.encoding,
    autoPauseExpression,
    autoPauseHex,
    autoPausePattern,
    compiledRules,
    paused,
    queueInteraction,
    rxHex,
    serialConfigs,
    send,
    sendPort,
    showError,
    plotStore,
    setPaused
  ])

  useEffect(() => {
    if (!autoSendRunning || !connected) return
    let cancelled = false
    let timer = 0
    const period = Math.max(1, interval)
    let nextDeadline = performance.now() + period
    const run = async (): Promise<void> => {
      const success = await send()
      if (!success) {
        setAutoSendRunning(false)
        return
      }
      autoSendCompletedRef.current += 1
      if (autoSendCount > 0 && autoSendCompletedRef.current >= autoSendCount) {
        setAutoSendRunning(false)
        setMessage(`自动发送已完成，共发送 ${autoSendCompletedRef.current} 次`)
        return
      }
      if (!cancelled) {
        nextDeadline += period
        const now = performance.now()
        if (nextDeadline < now) nextDeadline = now
        timer = window.setTimeout(() => void run(), Math.max(0, nextDeadline - now))
      }
    }
    timer = window.setTimeout(() => void run(), period)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [autoSendCount, autoSendRunning, connected, interval, send])

  const triggerSend = useCallback(async (): Promise<void> => {
    if (autoSend && autoSendRunning) {
      setAutoSendRunning(false)
      setMessage('已停止自动发送')
      return
    }
    const success = await send()
    if (success && autoSend) {
      autoSendCompletedRef.current = 1
      if (autoSendCount === 1) {
        setMessage('自动发送已完成，共发送 1 次')
        return
      }
      setAutoSendRunning(true)
      setMessage(
        `自动发送已启动，周期 ${Math.max(1, interval)}ms，${autoSendCount === 0 ? '无限次数' : `共 ${autoSendCount} 次`}`
      )
    }
  }, [autoSend, autoSendCount, autoSendRunning, interval, send])

  const changeAutoSend = useCallback((enabled: boolean): void => {
    setAutoSend(enabled)
    if (!enabled) setAutoSendRunning(false)
    setMessage(enabled ? '已启用自动发送，请点击“启动发送”开始' : '已关闭自动发送')
  }, [])

  useEffect(() => {
    localStorage.setItem('serialflow.autoReplyRules', JSON.stringify(rules))
  }, [rules])

  useEffect(() => {
    autoReplyGroupsRef.current = autoReplyGroups
    localStorage.setItem('serialflow.autoReplyGroups', JSON.stringify(autoReplyGroups))
  }, [autoReplyGroups])

  useEffect(() => {
    localStorage.setItem('serialflow.commands', JSON.stringify(commands))
  }, [commands])

  useEffect(() => {
    const resize = (): void => setSendPanelHeight((current) => clampSendPanelHeight(current))
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  useEffect(() => {
    localStorage.setItem('serialflow.commandGroups', JSON.stringify(commandGroups))
  }, [commandGroups])

  useEffect(() => {
    localStorage.setItem(sendIntervalKey, String(interval))
  }, [interval])

  useEffect(() => {
    localStorage.setItem(sendCountKey, String(autoSendCount))
  }, [autoSendCount])

  useEffect(() => {
    localStorage.setItem(receiveHexKey, String(rxHex))
  }, [rxHex])

  useEffect(() => {
    localStorage.setItem(timestampKey, String(timestamp))
  }, [timestamp])

  useEffect(() => {
    localStorage.setItem(sendCrcEnabledKey, String(sendCrcEnabled))
    localStorage.setItem(sendCrcModeKey, sendCrcMode)
  }, [sendCrcEnabled, sendCrcMode])

  useEffect(() => {
    localStorage.setItem(autoPauseEnabledKey, String(autoPauseEnabled))
    localStorage.setItem(autoPausePatternKey, autoPausePattern)
    localStorage.setItem(autoPauseRegexKey, String(autoPauseRegex))
    localStorage.setItem(autoPauseHexKey, String(autoPauseHex))
  }, [autoPauseEnabled, autoPauseHex, autoPausePattern, autoPauseRegex])

  useEffect(() => {
    localStorage.setItem(serialConfigsKey, JSON.stringify(serialConfigs))
  }, [serialConfigs])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.key === 'Enter') {
        event.preventDefault()
        void triggerSend()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [triggerSend])

  const updateSerialConfig = (id: number, patch: Partial<SerialConfig>): void => {
    setSerialConfigs((current) =>
      current.map((config) => (config.id === id ? { ...config, ...patch } : config))
    )
  }

  const addSerialConfig = (): void => {
    const unused = ports.find((port) => !serialConfigs.some((config) => config.path === port.path))
    setSerialConfigs((current) => [
      ...current,
      {
        id: Date.now(),
        name: `串口组 ${current.length + 1}`,
        path: unused?.path || '',
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        framing: { ...defaultSerialFraming },
        plotEnabled: false
      }
    ])
  }

  const removeSerialConfig = (id: number): void => {
    setSerialConfigs((current) => current.filter((config) => config.id !== id))
  }

  const toggleConnection = async (config: SerialConfig): Promise<void> => {
    if (connectionBusyRef.current) return
    connectionBusyRef.current = true
    setConnectionBusy(true)
    const isOpen = openedPorts.has(config.path)
    try {
      if (isOpen) await window.api.closePort(config.path)
      else {
        if (!config.path) return showProblem('请选择串口；如果列表为空，请先点击刷新并检查设备连接')
        if (openedPorts.has(config.path)) return showProblem(`${config.path} 已经打开`)
        await window.api.openPort({
          path: config.path,
          baudRate: config.baudRate,
          dataBits: config.dataBits,
          stopBits: config.stopBits,
          parity: config.parity
        })
        setMessage(
          `已打开 ${config.path}（${config.baudRate} baud，${config.dataBits}${config.parity === 'none' ? 'N' : config.parity[0].toUpperCase()}${config.stopBits}）`
        )
      }
      if (isOpen) setMessage(`已断开 ${config.path}`)
    } catch (error) {
      showError(error, isOpen ? '断开串口失败' : '打开串口失败')
    } finally {
      connectionBusyRef.current = false
      setConnectionBusy(false)
    }
  }

  const changeDataBits = (config: SerialConfig, next: DataBits): void => {
    let nextStopBits = config.stopBits
    if (next === 5 && config.stopBits === 2) nextStopBits = 1.5
    if (next !== 5 && config.stopBits === 1.5) nextStopBits = 1
    updateSerialConfig(config.id, { dataBits: next, stopBits: nextStopBits })
  }

  const changeSendMode = (nextHex: boolean): void => {
    if (nextHex === sendHex) return
    try {
      setSendText((current) => convertSerialText(current, nextHex))
      setSendHex(nextHex)
      setMessage(nextHex ? '发送内容已转换为 HEX' : '发送内容已转换为 ASCII')
    } catch (error) {
      showError(error, '发送格式转换失败')
    }
  }

  const clearReceive = (): void => {
    if (pendingFrameRef.current !== null) window.clearTimeout(pendingFrameRef.current)
    pendingFrameRef.current = null
    pendingInteractionsRef.current = {
      entries: [],
      rxEvents: 0,
      txEvents: 0
    }
    trafficEventsRef.current = { rx: 0, tx: 0 }
    frequencySampleRef.current = { rx: 0, tx: 0, time: performance.now() }
    setInteractionCache({ entries: [], bytes: 0 })
    setRxCommunicationCount(0)
    setTxCommunicationCount(0)
    setRxFrequency(0)
    setTxFrequency(0)
  }
  const resetAutoReplyState = useCallback(
    (ruleId: number, notify = true): void => {
      const target = rules.find((rule) => rule.id === ruleId)
      const groupId = target?.groupId || 1
      const groupRuleIds = rules.filter((rule) => rule.groupId === groupId).map((rule) => rule.id)
      autoReplyProgramRuntime.resetGroup(groupId, groupRuleIds)
      setAutoReplyGroups((current) =>
        current.map((group) => (group.id === groupId ? { ...group, globals: {} } : group))
      )
      autoReplyErrorCountsRef.current.delete(ruleId)
      if (notify) setMessage('当前自动回复分组的 global 和编程状态已重置')
    },
    [rules]
  )
  const changeInteractionCacheMb = (value: number): void => {
    const next = Math.min(1024, Math.max(1, Number.isFinite(value) ? Math.round(value) : 8))
    setInteractionCacheMb(next)
    localStorage.setItem(cacheSizeKey, String(next))
    setInteractionCache((current) => {
      const entries = trimInteractionEntries(
        current.entries,
        next * 1024 * 1024,
        interactionCacheEntries
      )
      return { entries, bytes: entries.reduce((total, entry) => total + entry.bytes, 0) }
    })
  }
  const changeInteractionEntryLimit = (value: number): void => {
    const next = Math.min(1_000_000, Math.max(0, Number.isFinite(value) ? Math.round(value) : 5000))
    setInteractionCacheEntries(next)
    localStorage.setItem(cacheEntryKey, String(next))
    setInteractionCache((current) => {
      const entries = trimInteractionEntries(
        current.entries,
        interactionCacheMb * 1024 * 1024,
        next
      )
      return { entries, bytes: entries.reduce((total, entry) => total + entry.bytes, 0) }
    })
  }
  const changeInteractionDisplay = (value: InteractionDisplay): void => {
    const next = normalizeInteractionDisplay(value)
    localStorage.setItem(interactionDisplayKey, JSON.stringify(next))
    if (next.encoding !== interactionDisplay.encoding)
      displayDecoders.current = new InteractionTextDecoder()
    setInteractionDisplay(next)
  }
  const changeInteractionFontSize = (value: number): void => {
    const next = Math.min(24, Math.max(8, Math.round(value)))
    setInteractionFontSize(next)
    localStorage.setItem(interactionFontSizeKey, String(next))
  }
  const exportQuickCommands = async (): Promise<void> => {
    try {
      const path = await window.api.saveConfig(
        'quick-commands',
        createQuickCommandsTransfer(commandGroups, commands)
      )
      if (path) setMessage(`快捷指令已导出：${path}`)
    } catch (error) {
      showError(error, '导出快捷指令失败')
    }
  }
  const importQuickCommands = (
    imported: QuickCommandImport,
    options: QuickCommandImportOptions
  ): boolean => {
    try {
      const result = applyQuickCommandImport({ groups: commandGroups, commands }, imported, options)
      setCommands(result.commands)
      setCommandGroups(result.groups)
      setMessage(
        `${imported.source} 快捷指令已${options.mode === 'group' ? `导入新组“${options.groupName}”` : '替换导入'}：${imported.commands.length} 条指令，${imported.groups.length} 个分组`
      )
      return true
    } catch (error) {
      showError(error, '导入快捷指令失败')
      return false
    }
  }
  const exportAutoReplies = async (): Promise<void> => {
    try {
      const path = await window.api.saveConfig(
        'auto-replies',
        createAutoReplyTransfer(autoReplyGroups, rules)
      )
      if (path) setMessage(`自动回复规则已导出：${path}`)
    } catch (error) {
      showError(error, '导出自动回复规则失败')
    }
  }
  const importAutoReplies = async (): Promise<boolean> => {
    try {
      const selected = await window.api.openConfig('auto-replies')
      if (!selected) return false
      const imported = parseAutoReplyTransfer(selected.content)
      if (!window.confirm('导入将替换当前全部自动回复规则和分组，并重置运行状态，是否继续？'))
        return false
      rules.forEach((rule) => resetAutoReplyState(rule.id, false))
      setRules(imported.rules)
      setAutoReplyGroups(imported.groups)
      setMessage(
        `自动回复规则已导入：${imported.rules.length} 条规则，${imported.groups.length} 个分组`
      )
      return true
    } catch (error) {
      showError(error, '导入自动回复规则失败')
      return false
    }
  }
  const exportProject = async (): Promise<void> => {
    try {
      const path = await window.api.saveProject({
        format: 'serialflow-project',
        version: 1,
        exportedAt: new Date().toISOString(),
        serialConfigs,
        rules,
        autoReplyGroups,
        commands,
        commandGroups,
        settings: {
          rxHex,
          timestamp,
          interactionCacheMb,
          interactionCacheEntries,
          interactionFontSize,
          interactionDisplay
        }
      })
      if (path) setMessage(`工程已导出：${path}`)
    } catch (error) {
      showError(error, '导出工程失败')
    }
  }
  const importProject = async (): Promise<void> => {
    try {
      const selected = await window.api.openProject()
      if (!selected) return
      const project = JSON.parse(selected.content) as Record<string, unknown>
      if (project.format !== 'serialflow-project' || project.version !== 1)
        throw new Error('不是受支持的 SerialFlow 工程文件')
      if (Array.isArray(project.serialConfigs) && project.serialConfigs.length)
        setSerialConfigs(
          (project.serialConfigs as SerialConfig[]).map((config, index) => ({
            ...config,
            id: Number(config.id) || Date.now() + index,
            name: config.name?.trim() || `串口组 ${index + 1}`,
            framing: normalizeSerialFraming(config.framing),
            plotEnabled: config.plotEnabled === true
          }))
        )
      if (Array.isArray(project.rules))
        setRules(
          (project.rules as Rule[]).map((rule) => ({
            ...rule,
            groupId: Number(rule.groupId) || 1
          }))
        )
      if (Array.isArray(project.autoReplyGroups))
        setAutoReplyGroups(
          (project.autoReplyGroups as AutoReplyGroup[]).map((group) => ({
            ...group,
            globals: normalizeGroupGlobals(group.globals)
          }))
        )
      if (Array.isArray(project.commands))
        setCommands(
          (project.commands as SavedCommand[]).map((command) => ({
            ...command,
            ...normalizeCommandExtensions(command)
          }))
        )
      if (Array.isArray(project.commandGroups))
        setCommandGroups(
          (project.commandGroups as CommandGroup[]).map((group) => ({
            ...group,
            globals: normalizeGroupGlobals(group.globals)
          }))
        )
      const settings = project.settings as Record<string, unknown> | undefined
      if (settings) {
        if (typeof settings.rxHex === 'boolean') setRxHex(settings.rxHex)
        if (typeof settings.timestamp === 'boolean') setTimestamp(settings.timestamp)
        if (typeof settings.interactionCacheMb === 'number')
          changeInteractionCacheMb(settings.interactionCacheMb)
        if (typeof settings.interactionCacheEntries === 'number')
          changeInteractionEntryLimit(settings.interactionCacheEntries)
        if (settings.interactionDisplay)
          changeInteractionDisplay(normalizeInteractionDisplay(settings.interactionDisplay))
        if (typeof settings.interactionFontSize === 'number')
          changeInteractionFontSize(settings.interactionFontSize)
      }
      setMessage(`工程已导入：${selected.path}`)
    } catch (error) {
      showError(error, '导入工程失败')
    }
  }

  return (
    <main className="app-shell">
      <header>
        <div className="brand">
          <img className="brand-logo" src={appIcon} alt="" draggable={false} />
          <div>
            <h1>SerialFlow</h1>
            <small>高速串口调试助手</small>
          </div>
        </div>
        <div className="header-actions">
          <div className={`status ${connected ? 'online' : ''}`}>
            <i />
            {connected
              ? `已打开 ${openedPorts.size} 个串口：${[...openedPorts].join('、')}`
              : '未连接'}
          </div>
          <DataWindowManager />
          <WindowPinButton />
        </div>
      </header>
      <section className="workspace">
        <Sidebar
          activeTab={sideTab}
          onTabChange={setSideTab}
          commandCount={commands.length}
          enabledRuleCount={rules.filter((rule) => rule.enabled).length}
          serialContent={
            <SerialConfigPanel
              ports={ports}
              configs={serialConfigs}
              openedPorts={openedPorts}
              busy={connectionBusy}
              onChange={updateSerialConfig}
              onAdd={addSerialConfig}
              onRemove={removeSerialConfig}
              onDataBitsChange={changeDataBits}
              onRefresh={() => void refreshPorts()}
              onToggle={(config) => void toggleConnection(config)}
              onImportProject={() => void importProject()}
              onExportProject={() => void exportProject()}
            />
          }
          commandsContent={
            <CommandsPanel
              key={connected ? 'commands-connected' : 'commands-disconnected'}
              commands={commands}
              setCommands={setCommands}
              groups={commandGroups}
              setGroups={setCommandGroups}
              connected={connected}
              openedPorts={openedPortList}
              targetPorts={targetPortOptions}
              onSend={sendCommandData}
              onImport={importQuickCommands}
              onExport={() => void exportQuickCommands()}
            />
          }
          rulesContent={
            <AutoReplyPanel
              rules={rules}
              setRules={setRules}
              groups={autoReplyGroups}
              setGroups={setAutoReplyGroups}
              onDeleteGroup={(groupId, targetGroupId) => {
                const next = removeReplyGroup(autoReplyGroups, rules, groupId, targetGroupId)
                autoReplyProgramRuntime.resetGroup(groupId, next.movedIds)
                for (const id of next.movedIds) autoReplyErrorCountsRef.current.delete(id)
                setAutoReplyGroups(next.groups)
                setRules(next.rules)
                setMessage(`分组已删除，${next.movedIds.length} 条规则已迁移并暂停`)
              }}
              targetPorts={targetPortOptions}
              onResetState={resetAutoReplyState}
              onImport={importAutoReplies}
              onExport={() => void exportAutoReplies()}
            />
          }
          aboutContent={
            <AboutPanel updateState={updates.state} onUpdateAction={updates.runAction} />
          }
        />
        {sideTab === 'pairs' ? (
          <SerialPairPanel />
        ) : sideTab === 'modbus' ? (
          <ModbusPanel
            ports={openedPortList}
            onSend={(text, hex, port) => sendCommandData(text, hex, null, port)}
          />
        ) : (
          <section
            className="content interaction-content"
            style={{ gridTemplateRows: `minmax(200px, 1fr) ${sendPanelHeight}px` }}
          >
            <div className="interaction-stack">
              <PlotPanel
                store={plotStore}
                enabledPorts={plotPorts}
                receivePaused={paused}
                onReceivePausedChange={setPaused}
                embedded
              />
              <ReceivePanel
                entries={interactionCache.entries}
                rxHex={rxHex}
                timestamp={timestamp}
                paused={paused}
                autoPauseEnabled={autoPauseEnabled}
                autoPausePattern={autoPausePattern}
                autoPauseRegex={autoPauseRegex}
                autoPauseHex={autoPauseHex}
                cacheSizeMb={interactionCacheMb}
                cacheEntryLimit={interactionCacheEntries}
                display={interactionDisplay}
                onDisplayChange={changeInteractionDisplay}
                fontSize={interactionFontSize}
                onClear={clearReceive}
                onRxHexChange={setRxHex}
                onTimestampChange={setTimestamp}
                onPausedChange={setPaused}
                onAutoPauseEnabledChange={setAutoPauseEnabled}
                onAutoPausePatternChange={setAutoPausePattern}
                onAutoPauseRegexChange={setAutoPauseRegex}
                onAutoPauseHexChange={setAutoPauseHex}
                onCacheSizeChange={changeInteractionCacheMb}
                onCacheEntryLimitChange={changeInteractionEntryLimit}
                onFontSizeChange={changeInteractionFontSize}
              />
            </div>
            <SendPanel
              text={sendText}
              hex={sendHex}
              lineEnding={sendLineEnding}
              autoSend={autoSend}
              autoSendRunning={autoSendRunning}
              interval={interval}
              autoSendCount={autoSendCount}
              crcEnabled={sendCrcEnabled}
              crcMode={sendCrcMode}
              openedPorts={openedPortList}
              targetPort={sendPort}
              onTextChange={setSendText}
              onHexChange={changeSendMode}
              onLineEndingChange={setSendLineEnding}
              onAutoSendChange={changeAutoSend}
              onIntervalChange={setIntervalValue}
              onAutoSendCountChange={setAutoSendCount}
              onSend={() => void triggerSend()}
              onCrcEnabledChange={setSendCrcEnabled}
              onCrcModeChange={setSendCrcMode}
              onTargetPortChange={setSendPort}
              height={sendPanelHeight}
              onHeightChange={(value) => setSendPanelHeight(clampSendPanelHeight(value))}
              onHeightCommit={(value) => {
                const height = clampSendPanelHeight(value)
                setSendPanelHeight(height)
                localStorage.setItem(sendPanelHeightKey, String(height))
              }}
            />
          </section>
        )}
      </section>
      <UpdateNotice state={updates.state} onAction={updates.runAction} />
      {errorDialog && (
        <div
          className="modal-backdrop app-error-backdrop"
          role="presentation"
          onPointerDown={() => setErrorDialog(null)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setErrorDialog(null)
          }}
        >
          <section
            className="app-error-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="app-error-title"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="app-error-icon">!</div>
            <div className="app-error-content">
              <h2 id="app-error-title">操作未完成</h2>
              <p>{errorDialog}</p>
            </div>
            <button className="app-error-close" title="关闭" onClick={() => setErrorDialog(null)}>
              ×
            </button>
            <div className="app-error-actions">
              <button autoFocus onClick={() => setErrorDialog(null)}>
                知道了
              </button>
            </div>
          </section>
        </div>
      )}
      <footer>
        <span>{message}</span>
        <div className="footer-traffic">
          通讯 <span className="rx">RX {rxCommunicationCount.toLocaleString()} 次</span> /{' '}
          <span className="tx">TX {txCommunicationCount.toLocaleString()} 次</span> · 缓存{' '}
          {formatCacheBytes(interactionCache.bytes)} / {interactionCacheMb} MB · 频率{' '}
          <span className="rx">RX {formatFrequency(rxFrequency)} Hz</span> /{' '}
          <span className="tx">TX {formatFrequency(txFrequency)} Hz</span>
        </div>
      </footer>
    </main>
  )
}

export default App
