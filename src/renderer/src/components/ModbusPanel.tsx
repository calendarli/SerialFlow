import { useEffect, useRef, useState } from 'react'
import { appendCrc, base64ToBytes, bytesToHex } from '../serial-utils'
import { ModbusClient } from '../modbus-client'
import { ModbusPresets } from './ModbusPresets'
import { sidebarPageMinimumWidth } from '../sidebar-layout'
import {
  modbusWorkspaceKey,
  modbusTablesWorkspaceKey,
  parseModbusTablesWorkspace,
  defaultModbusRange,
  parseModbusRange,
  parseModbusMap,
  exportModbusMap,
  parseModbusTableCollection,
  exportModbusTableCollection,
  updateModbusTableValues,
  type ModbusRange,
  type ModbusTable,
  type ModbusTableValues,
  type ModbusTablesWorkspace,
  type RegisterDefinition
} from '../modbus-workspace'
import {
  encodeModbusCommand,
  captureModbusTablesPreset,
  captureModbusCommand,
  runModbusCommands,
  type ModbusCommand,
  type ModbusPreset
} from '../modbus-presets'

type Props = {
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  ports: string[]
  onSend: (text: string, hex: boolean, port: string) => Promise<boolean>
}

type WordOrder = 'abcd' | 'cdab'
type RegisterDialog = {
  mode: 'add' | 'edit' | 'write' | 'delete'
  tableId: string
  address: number
  alias: string
  format: RegisterDefinition['format']
  value: string
}
type ModbusMenu = 'config' | 'communication' | 'operation'
type TableDialog = {
  mode: 'add' | 'rename' | 'delete'
  name: string
  startAddress: string
  registerCount: string
  error: string
}
type CommunicationSettings = {
  port: string
  slave: number
  wordOrder: WordOrder
  scanRate: number
}

const rowsPerGroup = 10
const newTableRange = { startAddress: 0, registerCount: 15 }
const mbpRegisterDefinitions: Record<number, RegisterDefinition> = {
  0: { alias: 'cmd+param', format: 'hex16', words: 1 },
  1: { alias: 'target position', format: 'int32', words: 2 },
  3: { alias: 'speed', format: 'float32', words: 2 },
  5: { alias: 'acceleration', format: 'float32', words: 2 },
  7: { alias: 'deceleration', format: 'float32', words: 2 },
  9: { alias: 'current (acc)', format: 'float32', words: 2 },
  11: { alias: 'current (normal)', format: 'float32', words: 2 },
  13: { alias: 'current (holding)', format: 'float32', words: 2 },
  15: { alias: 'reserved', format: 'uint16', words: 1 },
  16: { alias: 's1f : s1r', format: 'hex16', words: 1 },
  17: { alias: 's2f : s2r', format: 'hex16', words: 1 },
  18: { alias: 's3f : s3r (104 only)', format: 'hex16', words: 1 },
  19: { alias: 'reserved', format: 'uint16', words: 1 },
  20: { alias: 'reserved', format: 'uint16', words: 1 },
  21: { alias: 'reserved', format: 'uint16', words: 1 },
  22: { alias: 'reserved', format: 'uint16', words: 1 },
  23: { alias: 'reserved', format: 'uint16', words: 1 },
  24: { alias: 'zmd', format: 'uint16', words: 1 },
  25: { alias: 'osv', format: 'uint16', words: 1 },
  26: { alias: 'snr', format: 'uint16', words: 1 },
  27: { alias: 'zsd', format: 'float32', words: 2 },
  29: { alias: 'zsp', format: 'uint32', words: 2 },
  31: { alias: 'cid (105 only)', format: 'uint16', words: 1 },
  32: { alias: 'baudrate', format: 'uint32', words: 2 },
  34: { alias: 'mcs', format: 'uint16', words: 1 }
}

function utf16Pattern(value: string): Uint8Array {
  return Uint8Array.from([...value].flatMap((character) => [character.charCodeAt(0), 0]))
}

function findPattern(bytes: Uint8Array, pattern: Uint8Array, start = 0): number {
  outer: for (let index = start; index <= bytes.length - pattern.length; index += 1) {
    for (let offset = 0; offset < pattern.length; offset += 1)
      if (bytes[index + offset] !== pattern[offset]) continue outer
    return index
  }
  return -1
}

function extractCellText(bytes: Uint8Array, start: number, end: number): string {
  const candidates: string[] = []
  for (let index = start + (start % 2); index + 1 < end; index += 2) {
    let text = ''
    let cursor = index
    while (cursor + 1 < end) {
      const code = bytes[cursor] | (bytes[cursor + 1] << 8)
      const printable =
        (code >= 0x20 && code <= 0x7e) ||
        (code >= 0x3400 && code <= 0x9fff) ||
        (code >= 0xff01 && code <= 0xff5e)
      if (!printable) break
      text += String.fromCharCode(code)
      cursor += 2
    }
    const clean = text.trim()
    if (clean.length >= 2) candidates.push(clean)
    if (text) index = cursor - 2
  }
  return candidates.sort((left, right) => right.length - left.length)[0] || ''
}

function parseMbpAliases(bytes: Uint8Array): Record<number, string> {
  const aliasPattern = utf16Pattern('Alias')
  const fontPattern = utf16Pattern('Microsoft YaHei UI')
  const headers: number[] = []
  let cursor = 0
  while (cursor < bytes.length) {
    const offset = findPattern(bytes, aliasPattern, cursor)
    if (offset < 0) break
    headers.push(offset)
    cursor = offset + aliasPattern.length
  }
  if (!headers.length) throw new Error('未找到 MBP Alias 数据区块')
  const aliases: Record<number, string> = {}
  headers.slice(0, defaultModbusRange.registerCount / rowsPerGroup).forEach((header, group) => {
    const sectionEnd = headers[group + 1] ?? bytes.length
    const cells: number[] = []
    let cellCursor = header + aliasPattern.length
    while (cells.length < rowsPerGroup + 1) {
      const offset = findPattern(bytes, fontPattern, cellCursor)
      if (offset < 0 || offset >= sectionEnd) break
      cells.push(offset)
      cellCursor = offset + fontPattern.length
    }
    cells.slice(0, rowsPerGroup).forEach((cell, row) => {
      const end = cells[row + 1] ?? sectionEnd
      aliases[group * rowsPerGroup + row] = extractCellText(bytes, cell + fontPattern.length, end)
    })
  })
  if (!Object.values(aliases).some(Boolean)) throw new Error('MBP 文件中没有可用的寄存器别名')
  return aliases
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value) || minimum))
}

function word(value: number): [number, number] {
  const safe = clampInteger(value, 0, 0xffff)
  return [(safe >> 8) & 0xff, safe & 0xff]
}

function makeRequest(
  slave: number,
  functionCode: number,
  address: number,
  value: number
): Uint8Array {
  return appendCrc(
    Uint8Array.from([slave, functionCode, ...word(address), ...word(value)]),
    'modbus'
  )
}

function registerBytes(
  values: Array<number | undefined>,
  address: number,
  order: WordOrder,
  startAddress: number
): Uint8Array | null {
  const first = values[address - startAddress]
  const second = values[address - startAddress + 1]
  if (first === undefined || second === undefined) return null
  const words = order === 'abcd' ? [first, second] : [second, first]
  return Uint8Array.from([...word(words[0]), ...word(words[1])])
}

function formatRegister(
  values: Array<number | undefined>,
  address: number,
  definition: RegisterDefinition | undefined,
  definitions: Record<number, RegisterDefinition>,
  order: WordOrder,
  startAddress: number
): string {
  const value = values[address - startAddress]
  if (value === undefined) return '--'
  if (!definition) {
    const previous = definitions[address - 1]
    return previous?.words === 2 ? '--' : String(value)
  }
  if (definition.format === 'hex16') return `0x${value.toString(16).toUpperCase().padStart(4, '0')}`
  if (definition.words === 1) return String(value)
  const bytes = registerBytes(values, address, order, startAddress)
  if (!bytes) return '--'
  const view = new DataView(bytes.buffer)
  if (definition.format === 'float32') {
    const result = view.getFloat32(0, false)
    return Number.isFinite(result) ? String(Number(result.toPrecision(7))) : String(result)
  }
  return String(definition.format === 'int32' ? view.getInt32(0, false) : view.getUint32(0, false))
}

function encodeRegisterValue(
  value: number,
  definition: RegisterDefinition,
  order: WordOrder
): number[] {
  if (definition.words === 1) return [clampInteger(value, 0, 0xffff)]
  const buffer = new ArrayBuffer(4)
  const view = new DataView(buffer)
  if (definition.format === 'float32') view.setFloat32(0, value, false)
  else if (definition.format === 'int32') view.setInt32(0, value, false)
  else view.setUint32(0, value, false)
  const bytes = new Uint8Array(buffer)
  const words = [(bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]]
  return order === 'abcd' ? words : words.reverse()
}

function makeWriteRequest(slave: number, address: number, words: number[]): Uint8Array {
  if (words.length === 1) return makeRequest(slave, 6, address, words[0])
  return appendCrc(
    Uint8Array.from([
      slave,
      16,
      ...word(address),
      ...word(words.length),
      words.length * 2,
      ...words.flatMap((value) => word(value))
    ]),
    'modbus'
  )
}

export function ModbusPanel({
  ports,
  onSend,
  collapsed,
  onCollapsedChange
}: Props): React.JSX.Element {
  const layoutRef = useRef<HTMLElement>(null)
  const resizeStart = useRef<{ x: number; width: number } | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('serialflow.modbus.sidebarWidth'))
      return Number.isFinite(saved)
        ? Math.max(sidebarPageMinimumWidth, Math.min(600, saved))
        : sidebarPageMinimumWidth
    } catch {
      return sidebarPageMinimumWidth
    }
  })
  const [sidebarMaximum, setSidebarMaximum] = useState(600)
  useEffect(() => {
    const layout = layoutRef.current
    if (!layout) return
    const observer = new ResizeObserver(() => {
      const maximum = Math.max(
        sidebarPageMinimumWidth,
        Math.min(600, layout.clientWidth - 28 - 10 - 420)
      )
      setSidebarMaximum(maximum)
      setSidebarWidth((current) => Math.min(current, maximum))
    })
    observer.observe(layout)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    try {
      localStorage.setItem('serialflow.modbus.sidebarWidth', String(sidebarWidth))
    } catch {
      /* Keep resizing available when local storage is unavailable. */
    }
  }, [sidebarWidth])
  const resizeSidebar = (width: number): void => {
    setSidebarWidth(Math.round(Math.max(sidebarPageMinimumWidth, Math.min(sidebarMaximum, width))))
  }
  const [restored] = useState(() => {
    try {
      const raw =
        localStorage.getItem(modbusTablesWorkspaceKey) ?? localStorage.getItem(modbusWorkspaceKey)
      return { data: raw ? parseModbusTablesWorkspace(raw) : null, error: '' }
    } catch {
      return { data: null, error: 'Modbus 本地数据读取失败，已使用默认映射' }
    }
  })
  const [storageError, setStorageError] = useState(restored.error)
  const [port, setPort] = useState('')
  const [slave, setSlave] = useState(1)
  const functionCode = 3
  const [wordOrder, setWordOrder] = useState<WordOrder>('cdab')
  const [tables, setTables] = useState<ModbusTable[]>(
    () =>
      restored.data?.tables ?? [
        {
          id: crypto.randomUUID(),
          name: '表 1',
          mapName: '表 1',
          ...newTableRange,
          definitions: {}
        }
      ]
  )
  const [activeTableId, setActiveTableId] = useState(
    () => restored.data?.activeTableId ?? tables[0].id
  )
  const activeTable = tables.find((table) => table.id === activeTableId) || tables[0]
  const { startAddress, registerCount, definitions, mapName } = activeTable
  const tablesRef = useRef(tables)
  useEffect(() => {
    tablesRef.current = tables
  }, [tables])
  const setDefinitions = (
    next:
      | Record<number, RegisterDefinition>
      | ((current: Record<number, RegisterDefinition>) => Record<number, RegisterDefinition>)
  ): void => {
    setTables((current) =>
      current.map((table) =>
        table.id === activeTable.id
          ? { ...table, definitions: typeof next === 'function' ? next(table.definitions) : next }
          : table
      )
    )
  }
  const setMapName = (name: string): void => {
    setTables((current) =>
      current.map((table) => (table.id === activeTable.id ? { ...table, mapName: name } : table))
    )
  }
  const [tableDialog, setTableDialog] = useState<TableDialog | null>(null)
  const [registerDialog, setRegisterDialog] = useState<RegisterDialog | null>(null)
  const [openMenu, setOpenMenu] = useState<ModbusMenu | null>(null)
  const [settingsDialog, setSettingsDialog] = useState<CommunicationSettings | null>(null)
  const [scanRate, setScanRate] = useState(1000)
  const [polling, setPolling] = useState(false)
  const [rangeInput, setRangeInput] = useState(() => ({
    startAddress: String(startAddress),
    registerCount: String(registerCount)
  }))
  const [rangeError, setRangeError] = useState('')
  const [shortcutSubmenu, setShortcutSubmenu] = useState(false)
  const [shortcutDraft, setShortcutDraft] = useState<ModbusCommand | null>(null)
  const [tableValues, setTableValues] = useState<ModbusTableValues>({})
  const values =
    tableValues[activeTable.id] || Array.from<number | undefined>({ length: registerCount })
  const [tableErrors, setTableErrors] = useState<Record<string, string>>({})
  const [readBusy, setReadBusy] = useState(false)
  const readCycle = useRef({ busy: false, cancelled: false })
  const [selectedAddress, setSelectedAddress] = useState(startAddress)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; address: number } | null>(
    null
  )
  const [message, setMessage] = useState('No connection')
  const [txCount, setTxCount] = useState(0)
  const [errorCount, setErrorCount] = useState(0)
  const [lastResponseMs, setLastResponseMs] = useState<number | null>(null)
  const clientRef = useRef(new ModbusClient())
  const [presetBusy, setPresetBusy] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<'shortcuts' | 'config'>('shortcuts')
  const presetRun = useRef({ busy: false, cancelled: false })
  const connectionRevision = useRef({ value: 0 })
  const onSendRef = useRef(onSend)
  useEffect(() => {
    onSendRef.current = onSend
  }, [onSend])
  const targetPort = ports.includes(port) ? port : ports[0] || ''
  const normalizedSlave = clampInteger(slave, 1, 247)
  const normalizedRate = clampInteger(scanRate, 50, 60000)
  const workspace: ModbusTablesWorkspace = {
    version: 2,
    tables,
    activeTableId: activeTable.id
  }
  const serializedWorkspace = JSON.stringify(workspace)
  const initialWorkspace = useRef(serializedWorkspace)
  useEffect(() => {
    // Preserve unreadable storage until the user changes the workspace.
    if (restored.error && serializedWorkspace === initialWorkspace.current) return
    try {
      localStorage.setItem(modbusTablesWorkspaceKey, serializedWorkspace)
      setStorageError('')
    } catch {
      setStorageError('Modbus 数据保存失败，请检查本地存储空间')
    }
  }, [serializedWorkspace, restored.error])

  useEffect(() => {
    if (!contextMenu && !openMenu) return
    const close = (): void => {
      setContextMenu(null)
      setShortcutSubmenu(false)
      setOpenMenu(null)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [contextMenu, openMenu])

  const openCommunicationSettings = (): void => {
    setSettingsDialog({
      port: targetPort,
      slave: normalizedSlave,
      wordOrder,
      scanRate: normalizedRate
    })
    setOpenMenu(null)
  }

  const saveCommunicationSettings = (): void => {
    if (!settingsDialog) return
    setPort(settingsDialog.port)
    setSlave(clampInteger(settingsDialog.slave, 1, 247))
    setWordOrder(settingsDialog.wordOrder)
    setScanRate(clampInteger(settingsDialog.scanRate, 50, 60000))
    if (!settingsDialog.port) setPolling(false)
    setSettingsDialog(null)
    setMessage(settingsDialog.port ? 'Communication settings updated' : 'No connection')
  }

  useEffect(() => {
    setRangeInput({ startAddress: String(startAddress), registerCount: String(registerCount) })
    setRangeError('')
    setSelectedAddress(startAddress)
    setRegisterDialog(null)
    setContextMenu(null)
  }, [activeTable.id, startAddress, registerCount])

  useEffect(() => {
    const client = clientRef.current
    setTableValues({})
    setTableErrors({})
    setLastResponseMs(null)
    setRegisterDialog(null)
    setContextMenu(null)
    const connection = connectionRevision.current
    const offData = window.api.onData(({ path, chunks }) => {
      if (path === targetPort) for (const chunk of chunks) client.push(chunk)
    })
    const offStatus = window.api.onStatus(({ path, open }) => {
      if (path === targetPort && !open) {
        connection.value++
        readCycle.current.cancelled = true
        client.cancel('Modbus disconnected')
        setPolling(false)
        setMessage('No connection')
      }
    })
    return () => {
      connection.value++
      readCycle.current.cancelled = true
      client.cancel()
      offData()
      offStatus()
    }
  }, [targetPort, normalizedSlave])

  const resetRange = (range: ModbusRange): void => {
    connectionRevision.current.value++
    clientRef.current.cancel('Modbus register range changed')
    setPolling(false)
    setTables((current) =>
      current.map((table) =>
        table.id === activeTable.id
          ? { ...table, startAddress: range.startAddress, registerCount: range.registerCount }
          : table
      )
    )
    setRangeInput({
      startAddress: String(range.startAddress),
      registerCount: String(range.registerCount)
    })
    setTableValues((current) => ({
      ...current,
      [activeTable.id]: Array.from({ length: range.registerCount })
    }))
    setTableErrors((current) => ({ ...current, [activeTable.id]: '' }))
    setSelectedAddress(range.startAddress)
    setLastResponseMs(null)
    setRegisterDialog(null)
    setContextMenu(null)
    setRangeError('')
  }

  const applyRange = (): void => {
    try {
      const range = parseModbusRange(rangeInput.startAddress, rangeInput.registerCount)
      if (clientRef.current.busy || presetRun.current.busy || readCycle.current.busy)
        throw new Error('请等待当前 Modbus 读写完成后再修改范围')
      resetRange(range)
      setMessage(
        `读取范围已更新：${range.startAddress}–${range.startAddress + range.registerCount - 1}`
      )
    } catch (error) {
      setRangeError(error instanceof Error ? error.message : String(error))
    }
  }

  const readTable = async (table: ModbusTable, revision: number): Promise<string | null> => {
    const readRequest = makeRequest(
      normalizedSlave,
      functionCode,
      table.startAddress,
      table.registerCount
    )
    try {
      const frame = await clientRef.current.request(readRequest, async () => {
        if (revision !== connectionRevision.current.value) return false
        const success = await onSendRef.current(bytesToHex(readRequest), true, targetPort)
        if (success && revision === connectionRevision.current.value)
          setTxCount((count) => count + 1)
        return success
      })
      if (revision !== connectionRevision.current.value) return null
      const words = Array.from(
        { length: table.registerCount },
        (_, index) => (frame[3 + index * 2] << 8) | frame[4 + index * 2]
      )
      setTableValues((current) =>
        updateModbusTableValues(tablesRef.current, current, table.startAddress, words)
      )
      setTableErrors((current) => ({ ...current, [table.id]: '' }))
      setLastResponseMs(Date.now())
      return null
    } catch (error) {
      if (revision !== connectionRevision.current.value) return null
      const message = error instanceof Error ? error.message : String(error)
      setTableErrors((current) => ({ ...current, [table.id]: message }))
      setErrorCount((count) => count + 1)
      return `${table.name}：${message}`
    }
  }

  const sendRead = async (all = false, stopped: () => boolean = () => false): Promise<void> => {
    if (!targetPort || clientRef.current.busy || presetRun.current.busy || readCycle.current.busy)
      return
    const revision = connectionRevision.current.value
    const targets = all ? tablesRef.current : [activeTable]
    readCycle.current = { busy: true, cancelled: false }
    setReadBusy(true)
    setMessage('Waiting for response...')
    try {
      const errors: string[] = []
      for (const table of targets) {
        if (
          stopped() ||
          readCycle.current.cancelled ||
          revision !== connectionRevision.current.value
        )
          return
        const error = await readTable(table, revision)
        if (error) errors.push(error)
      }
      if (
        revision === connectionRevision.current.value &&
        !readCycle.current.cancelled &&
        !stopped()
      )
        setMessage(errors.length ? errors.join('；') : 'Connected')
    } finally {
      readCycle.current.busy = false
      setReadBusy(false)
    }
  }

  useEffect(() => {
    if (!polling || !targetPort) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      await sendRead(true, () => cancelled)
      if (!cancelled) timer = setTimeout(() => void poll(), normalizedRate)
    }
    timer = setTimeout(() => void poll(), 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // Read every table sequentially; switching the visible tab does not restart a cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling, normalizedSlave, normalizedRate, targetPort])

  const writeRegister = async (address: number, input: string): Promise<void> => {
    if (presetRun.current.busy) return setMessage('正在写入设备配置，请等待完成')
    if (readCycle.current.busy) return setMessage('请等待当前 Modbus 读取完成后再写入')
    if (!targetPort) return setMessage('No connection')
    const definition = definitions[address] || {
      format: 'uint16' as const,
      words: 1 as const
    }
    if (address < startAddress || address + definition.words > startAddress + registerCount)
      return setMessage('32 位数据需要当前读取范围内的两个连续寄存器')
    const numeric = Number(input)
    const integerFormat = definition.format !== 'float32'
    const minimum =
      definition.format === 'float32' ? -Infinity : definition.format === 'int32' ? -0x80000000 : 0
    const maximum =
      definition.format === 'float32'
        ? Infinity
        : definition.format === 'int32'
          ? 0x7fffffff
          : definition.words === 2
            ? 0xffffffff
            : 0xffff
    if (
      !input.trim() ||
      !Number.isFinite(numeric) ||
      (definition.format === 'float32' && !Number.isFinite(Math.fround(numeric))) ||
      (integerFormat && !Number.isInteger(numeric)) ||
      numeric < minimum ||
      numeric > maximum
    ) {
      setErrorCount((count) => count + 1)
      setMessage(`Value is outside the ${definition.format} range`)
      return
    }
    const encodedWords = encodeRegisterValue(numeric, definition, wordOrder)
    const request = makeWriteRequest(normalizedSlave, address, encodedWords)
    if (clientRef.current.busy) return setMessage('Waiting for current Modbus response; try again')
    const revision = connectionRevision.current.value
    setMessage('Waiting for write confirmation...')
    try {
      await clientRef.current.request(request, async () => {
        const success = await onSendRef.current(bytesToHex(request), true, targetPort)
        if (success && revision === connectionRevision.current.value)
          setTxCount((count) => count + 1)
        return success
      })
      if (revision !== connectionRevision.current.value) return
      setTableValues((current) =>
        updateModbusTableValues(tablesRef.current, current, address, encodedWords)
      )
      setLastResponseMs(Date.now())
      setMessage(`Register ${String(address).padStart(5, '0')} written`)
      setRegisterDialog((current) =>
        current?.mode === 'write' &&
        current.tableId === activeTable.id &&
        current.address === address
          ? null
          : current
      )
    } catch (error) {
      if (revision !== connectionRevision.current.value) return
      setErrorCount((count) => count + 1)
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const runPreset = async (preset: ModbusPreset, commands: ModbusCommand[]): Promise<void> => {
    if (!targetPort || presetRun.current.busy) return
    if (clientRef.current.busy || readCycle.current.busy) {
      setMessage('请等待当前 Modbus 响应后再写入配置')
      return
    }
    try {
      // Validate the complete batch before the first device write.
      commands.forEach((command) => encodeModbusCommand(command, preset.slave, preset.wordOrder))
    } catch (error) {
      setMessage(String(error))
      return
    }
    const revision = connectionRevision.current.value
    presetRun.current = { busy: true, cancelled: false }
    setPresetBusy(true)
    setPolling(false)
    let completed = 0
    const cancelled = (): boolean =>
      presetRun.current.cancelled || revision !== connectionRevision.current.value
    setMessage(`${preset.name}：准备写入 ${commands.length} 条指令`)
    try {
      await runModbusCommands(
        commands,
        async (command) => {
          const { request, address, words } = encodeModbusCommand(
            command,
            preset.slave,
            preset.wordOrder
          )
          await clientRef.current.request(request, async () => {
            if (cancelled()) return false
            const success = await onSendRef.current(bytesToHex(request), true, targetPort)
            if (success) setTxCount((count) => count + 1)
            return success
          })
          if (revision !== connectionRevision.current.value) throw new Error('连接已变化')
          if (preset.slave === normalizedSlave)
            setTableValues((current) =>
              updateModbusTableValues(tablesRef.current, current, address, words)
            )
          setLastResponseMs(Date.now())
        },
        cancelled,
        (count) => {
          completed = count
          setMessage(`${preset.name}：已确认 ${count}/${commands.length}`)
        }
      )
      setMessage(
        `${preset.name}：写入完成 ${completed}/${commands.length} · ID ${preset.slave} · ${preset.wordOrder.toUpperCase()}`
      )
    } catch (error) {
      setErrorCount((count) => count + 1)
      setMessage(
        `${preset.name}：已确认 ${completed}/${commands.length}，停止于「${commands[completed]?.name || ''}」：${error instanceof Error ? error.message : String(error)}；未确认的写入请读回核对`
      )
    } finally {
      presetRun.current.busy = false
      setPresetBusy(false)
    }
  }

  const importMap = async (): Promise<void> => {
    try {
      const selected = await window.api.openModbusMap()
      if (!selected) return
      if (clientRef.current.busy || presetRun.current.busy || readCycle.current.busy)
        throw new Error('请停止轮询并等待当前 Modbus 读写完成后再导入配置')
      const bytes = base64ToBytes(selected.base64)
      if (selected.name.toLowerCase().endsWith('.json')) {
        const raw = new TextDecoder().decode(bytes)
        if (JSON.parse(raw)?.version === 2) {
          const { workspace, settings } = parseModbusTableCollection(raw)
          connectionRevision.current.value++
          setPolling(false)
          setTables(workspace.tables)
          setActiveTableId(workspace.activeTableId)
          setTableValues({})
          setTableErrors({})
          setLastResponseMs(null)
          setRegisterDialog(null)
          setContextMenu(null)
          if (settings.slave !== undefined) setSlave(settings.slave)
          if (settings.scanRate !== undefined) setScanRate(settings.scanRate)
          if (settings.wordOrder !== undefined) setWordOrder(settings.wordOrder)
          setMessage(`已导入 ${workspace.tables.length} 张寄存器表`)
          return
        }
        const { definitions: next, settings } = parseModbusMap(raw)
        resetRange(settings)
        setDefinitions(next)
        if (settings.slave !== undefined) setSlave(settings.slave)
        if (settings.scanRate !== undefined) setScanRate(settings.scanRate)
        if (settings.wordOrder !== undefined) setWordOrder(settings.wordOrder)
        setMessage(`Imported ${Object.keys(next).length} register definitions`)
      } else {
        const aliases = parseMbpAliases(bytes)
        const next = Object.fromEntries(
          Object.entries(mbpRegisterDefinitions).map(([address, definition]) => [
            address,
            { ...definition, alias: aliases[Number(address)] || '' }
          ])
        ) as Record<number, RegisterDefinition>
        for (const [address, alias] of Object.entries(aliases))
          if (alias && !next[Number(address)])
            next[Number(address)] = { alias, format: 'uint16', words: 1 }
        resetRange(defaultModbusRange)
        setDefinitions(next)
        setMessage(`Imported ${Object.values(aliases).filter(Boolean).length} aliases`)
      }
      setMapName(selected.name)
    } catch (cause) {
      setErrorCount((count) => count + 1)
      setMessage(cause instanceof Error ? cause.message : 'MBP import failed')
    }
  }

  const exportMap = async (currentOnly = false): Promise<void> => {
    const communication = { slave: normalizedSlave, scanRate: normalizedRate, wordOrder }
    const path = await window.api.saveModbusMap(
      tables.length > 1 && !currentOnly
        ? exportModbusTableCollection(tables, activeTable.id, communication)
        : exportModbusMap(mapName, definitions, { ...communication, startAddress, registerCount })
    )
    if (path) {
      if (currentOnly || tables.length === 1) setMapName(path.split(/[\\/]/).at(-1) || mapName)
      setMessage('Modbus configuration exported')
    }
  }

  const deleteDefinition = (address: number): void => {
    setDefinitions((current) => {
      const next = { ...current }
      delete next[address]
      return next
    })
    setRegisterDialog(null)
    setMessage(`Register ${String(address).padStart(5, '0')} removed from the map`)
  }

  const openRegisterDialog = (mode: RegisterDialog['mode'], address: number): void => {
    const definition = definitions[address]
    const displayed = formatRegister(
      values,
      address,
      definition,
      definitions,
      wordOrder,
      startAddress
    )
    setRegisterDialog({
      mode,
      tableId: activeTable.id,
      address,
      alias: definition?.alias || `register ${address}`,
      format: definition?.format || 'uint16',
      value: displayed === '--' ? '0' : displayed
    })
  }

  const saveRegisterDefinition = (): void => {
    if (!registerDialog) return
    const words = registerDialog.format === 'hex16' || registerDialog.format === 'uint16' ? 1 : 2
    if (
      words === 2 &&
      (registerDialog.address >= startAddress + registerCount - 1 ||
        definitions[registerDialog.address + 1])
    ) {
      setMessage('Two-register data requires an empty following address')
      return
    }
    setDefinitions((current) => ({
      ...current,
      [registerDialog.address]: {
        alias: registerDialog.alias.trim(),
        format: registerDialog.format,
        words
      }
    }))
    setSelectedAddress(registerDialog.address)
    setRegisterDialog(null)
    setMessage(
      `Register ${String(registerDialog.address).padStart(5, '0')} ${registerDialog.mode === 'add' ? 'added' : 'updated'}`
    )
  }

  const createShortcut = (address: number, useCurrentValue: boolean): void => {
    try {
      const definition = definitions[address]
      const command: ModbusCommand = useCurrentValue
        ? captureModbusCommand(values, definitions, address, wordOrder, startAddress)
        : {
            id: crypto.randomUUID(),
            name: definition?.alias || `寄存器 ${address}`,
            address: `0x${address.toString(16).toUpperCase()}`,
            value: '',
            format: definition?.format || 'uint16'
          }
      if (useCurrentValue) encodeModbusCommand(command, normalizedSlave, wordOrder)
      setShortcutDraft(command)
      setSidebarTab('shortcuts')
      onCollapsedChange(false)
      setContextMenu(null)
      setShortcutSubmenu(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const openRegisterMenu = (event: React.MouseEvent, address: number): void => {
    event.preventDefault()
    setSelectedAddress(address)
    setShortcutSubmenu(false)
    setContextMenu({
      x: Math.max(4, Math.min(event.clientX, window.innerWidth - 200)),
      y: Math.max(4, Math.min(event.clientY, window.innerHeight - 245)),
      address
    })
  }

  const canWriteRegister = (address: number): boolean =>
    definitions[address - 1]?.words !== 2 &&
    address + (definitions[address]?.words || 1) <= startAddress + registerCount

  const groupCount = Math.ceil(registerCount / rowsPerGroup)

  const openTableDialog = (mode: TableDialog['mode']): void => {
    let index = tables.length + 1
    while (tables.some((table) => table.name === `表 ${index}`)) index++
    setTableDialog({
      mode,
      name: mode === 'add' ? `表 ${index}` : activeTable.name,
      startAddress:
        mode === 'add'
          ? String(Math.min(0xffff, startAddress + registerCount))
          : String(startAddress),
      registerCount:
        mode === 'add'
          ? String(
              Math.min(
                newTableRange.registerCount,
                0x10000 - Math.min(0xffff, startAddress + registerCount)
              )
            )
          : String(registerCount),
      error: ''
    })
  }

  const saveTableDialog = (): void => {
    if (!tableDialog) return
    try {
      if (clientRef.current.busy || presetRun.current.busy || readCycle.current.busy)
        throw new Error('请等待当前 Modbus 读写完成后再修改寄存器表')
      if (tableDialog.mode === 'delete') {
        if (tables.length === 1) throw new Error('至少保留一张寄存器表')
        const remaining = tables.filter((table) => table.id !== activeTable.id)
        setPolling(false)
        setTables(remaining)
        setActiveTableId(remaining[0].id)
        setTableValues((current) => {
          const next = { ...current }
          delete next[activeTable.id]
          return next
        })
        setTableErrors((current) => {
          const next = { ...current }
          delete next[activeTable.id]
          return next
        })
        setMessage(`已删除寄存器表「${activeTable.name}」`)
      } else {
        const name = tableDialog.name.trim()
        if (!name) throw new Error('请输入寄存器表名称')
        if (tableDialog.mode === 'add') {
          const range = parseModbusRange(tableDialog.startAddress, tableDialog.registerCount)
          const table: ModbusTable = {
            id: crypto.randomUUID(),
            name,
            mapName: name,
            ...range,
            definitions: {}
          }
          setPolling(false)
          setTables((current) => [...current, table])
          setActiveTableId(table.id)
          setMessage(`已新增寄存器表「${name}」`)
        } else {
          setTables((current) =>
            current.map((table) => (table.id === activeTable.id ? { ...table, name } : table))
          )
        }
      }
      setTableDialog(null)
    } catch (error) {
      setTableDialog({
        ...tableDialog,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return (
    <section
      ref={layoutRef}
      className="modbus-monitor"
      style={{ gridTemplateColumns: `${collapsed ? 0 : sidebarWidth}px 10px minmax(0, 1fr)` }}
    >
      <div
        className="modbus-sidebar-resizer"
        role="separator"
        aria-label="调整快捷指令栏宽度"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={sidebarMaximum}
        aria-valuenow={collapsed ? 0 : sidebarWidth}
        tabIndex={0}
        title="拖动调整宽度，双击恢复默认宽度"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          resizeStart.current = { x: event.clientX, width: collapsed ? 0 : sidebarWidth }
        }}
        onPointerMove={(event) => {
          if (resizeStart.current) {
            const width = resizeStart.current.width + event.clientX - resizeStart.current.x
            onCollapsedChange(width <= 0)
            if (width > 0) resizeSidebar(width)
          }
        }}
        onPointerUp={(event) => {
          resizeStart.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={() => {
          resizeStart.current = null
        }}
        onLostPointerCapture={() => {
          resizeStart.current = null
        }}
        onDoubleClick={() => {
          onCollapsedChange(false)
          resizeSidebar(sidebarPageMinimumWidth)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onCollapsedChange(!collapsed)
            return
          }
          const next =
            event.key === 'ArrowLeft'
              ? sidebarWidth - 10
              : event.key === 'ArrowRight'
                ? sidebarWidth + 10
                : event.key === 'Home'
                  ? sidebarPageMinimumWidth
                  : event.key === 'End'
                    ? sidebarMaximum
                    : null
          if (next !== null) {
            event.preventDefault()
            onCollapsedChange(false)
            resizeSidebar(next)
          }
        }}
      />
      <header className="modbus-toolbar modbus-menu-toolbar">
        <div className="modbus-title">
          <strong>Modbus RTU</strong>
          <span>
            {mapName} · {targetPort || '未选择串口'} · ID {normalizedSlave} · 03 Holding ·{' '}
            {wordOrder.toUpperCase()} · {normalizedRate}ms
          </span>
        </div>
        <nav className="modbus-menubar" aria-label="Modbus RTU 菜单">
          <div className="modbus-menu-root">
            <button onClick={() => setOpenMenu(openMenu === 'config' ? null : 'config')}>
              配置
            </button>
            {openMenu === 'config' && (
              <div
                className="modbus-menu-popover"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button
                  onClick={() => {
                    setOpenMenu(null)
                    void importMap()
                  }}
                >
                  导入配置…
                </button>
                <button
                  onClick={() => {
                    setOpenMenu(null)
                    void exportMap()
                  }}
                >
                  导出配置…
                </button>
                {tables.length > 1 && (
                  <button
                    onClick={() => {
                      setOpenMenu(null)
                      void exportMap(true)
                    }}
                  >
                    导出当前表…
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="modbus-menu-root">
            <button
              onClick={() => setOpenMenu(openMenu === 'communication' ? null : 'communication')}
            >
              通信
            </button>
            {openMenu === 'communication' && (
              <div
                className="modbus-menu-popover"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button onClick={openCommunicationSettings}>通信设置…</button>
              </div>
            )}
          </div>
          <div className="modbus-menu-root">
            <button onClick={() => setOpenMenu(openMenu === 'operation' ? null : 'operation')}>
              操作
            </button>
            {openMenu === 'operation' && (
              <div
                className="modbus-menu-popover"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button
                  disabled={!targetPort || polling || presetBusy || readBusy}
                  onClick={() => {
                    setOpenMenu(null)
                    void sendRead()
                  }}
                >
                  读取一次
                </button>
                <button
                  disabled={!targetPort || polling || presetBusy || readBusy}
                  onClick={() => {
                    setOpenMenu(null)
                    void sendRead(true)
                  }}
                >
                  读取所有表
                </button>
                <button
                  disabled={!targetPort || presetBusy}
                  onClick={() => {
                    setOpenMenu(null)
                    if (polling) {
                      readCycle.current.cancelled = true
                      setMessage('轮询已停止，等待当前响应结束')
                    }
                    setPolling((current) => !current)
                  }}
                >
                  {polling ? '停止轮询' : '开始轮询'}
                </button>
              </div>
            )}
          </div>
        </nav>
      </header>

      <div className="modbus-status" role="status">
        <span>Tx = {txCount}</span>
        <span>Err = {errorCount}</span>
        <span>ID = {normalizedSlave}</span>
        <span>F = {String(functionCode).padStart(2, '0')}</span>
        <span>SR = {normalizedRate}ms</span>
        <b
          className={
            targetPort && message === 'Connected'
              ? 'connected'
              : !targetPort || message === 'No connection'
                ? 'error'
                : ''
          }
        >
          {message}
        </b>
        <time>
          {lastResponseMs ? `Last RX ${new Date(lastResponseMs).toLocaleTimeString()}` : ''}
        </time>
      </div>

      <aside className="modbus-sidebar" hidden={collapsed}>
        <nav
          className="modbus-sidebar-tabs"
          role="tablist"
          aria-label="Modbus 二级导航"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next =
              event.key === 'Home'
                ? 'shortcuts'
                : event.key === 'End'
                  ? 'config'
                  : sidebarTab === 'shortcuts'
                    ? 'config'
                    : 'shortcuts'
            setSidebarTab(next)
            event.currentTarget
              .querySelector<HTMLButtonElement>(`[data-modbus-tab="${next}"]`)
              ?.focus()
          }}
        >
          {(['shortcuts', 'config'] as const).map((tab) => (
            <button
              key={tab}
              id={`modbus-tab-${tab}`}
              data-modbus-tab={tab}
              role="tab"
              aria-selected={sidebarTab === tab}
              aria-controls={`modbus-panel-${tab}`}
              tabIndex={sidebarTab === tab ? 0 : -1}
              onClick={() => setSidebarTab(tab)}
            >
              {tab === 'shortcuts' ? '快捷指令' : '配置管理器'}
            </button>
          ))}
        </nav>
        <div
          className="modbus-sidebar-panel"
          id="modbus-panel-shortcuts"
          role="tabpanel"
          aria-labelledby="modbus-tab-shortcuts"
          hidden={sidebarTab !== 'shortcuts'}
        >
          <ModbusPresets
            mode="shortcuts"
            slave={normalizedSlave}
            wordOrder={wordOrder}
            connected={!!targetPort}
            busy={presetBusy}
            target={targetPort}
            commandDraft={shortcutDraft}
            onCommandDraftConsumed={setShortcutDraft}
            onRun={runPreset}
            onCancel={() => {
              presetRun.current.cancelled = true
              setMessage('正在停止：等待当前指令响应，不再发送后续指令')
            }}
          />
        </div>
        <div
          className="modbus-sidebar-panel"
          id="modbus-panel-config"
          role="tabpanel"
          aria-labelledby="modbus-tab-config"
          hidden={sidebarTab !== 'config'}
        >
          <ModbusPresets
            mode="config"
            onCapture={() =>
              captureModbusTablesPreset(
                tables,
                tableValues,
                normalizedSlave,
                wordOrder,
                `${tables.length > 1 ? 'Modbus 多表' : mapName.replace(/\.[^.]+$/, '')} · ID ${normalizedSlave}`
              )
            }
            slave={normalizedSlave}
            wordOrder={wordOrder}
            connected={!!targetPort}
            busy={presetBusy}
            target={targetPort}
            onRun={runPreset}
            onCancel={() => {
              presetRun.current.cancelled = true
            }}
          />
        </div>
      </aside>
      <div className="modbus-table-wrap">
        <div className="modbus-tables-toolbar">
          <nav
            className="modbus-table-tabs"
            role="tablist"
            aria-label="寄存器表"
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const index = tables.findIndex((table) => table.id === activeTable.id)
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tables.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tables.length) %
                      tables.length
              setActiveTableId(tables[next].id)
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus()
            }}
          >
            {tables.map((table) => (
              <button
                key={table.id}
                id={`modbus-table-${table.id}`}
                role="tab"
                aria-selected={table.id === activeTable.id}
                aria-controls="modbus-active-table"
                tabIndex={table.id === activeTable.id ? 0 : -1}
                title={tableErrors[table.id] || `${table.name} · ${table.registerCount} 个寄存器`}
                onClick={() => setActiveTableId(table.id)}
              >
                <strong>
                  {table.name}
                  {tableErrors[table.id] ? ' ⚠' : ''}
                </strong>
                <small>
                  0x{table.startAddress.toString(16).toUpperCase()} · {table.registerCount} 个
                </small>
              </button>
            ))}
          </nav>
          <div className="modbus-table-actions">
            <button
              type="button"
              disabled={readBusy || presetBusy}
              onClick={() => openTableDialog('add')}
            >
              新增表
            </button>
            <button
              type="button"
              disabled={readBusy || presetBusy}
              onClick={() => openTableDialog('rename')}
            >
              重命名表
            </button>
            <button
              type="button"
              disabled={tables.length === 1 || readBusy || presetBusy}
              onClick={() => openTableDialog('delete')}
            >
              删除表
            </button>
          </div>
        </div>
        <div
          id="modbus-active-table"
          role="tabpanel"
          aria-labelledby={`modbus-table-${activeTable.id}`}
        >
          <form
            className="modbus-range"
            onSubmit={(event) => {
              event.preventDefault()
              applyRange()
            }}
          >
            <label>
              起始地址
              <input
                aria-label="起始地址"
                placeholder="0 或 0x103"
                value={rangeInput.startAddress}
                onChange={(event) =>
                  setRangeInput({ ...rangeInput, startAddress: event.target.value })
                }
              />
            </label>
            <label>
              寄存器数量
              <input
                aria-label="寄存器数量"
                inputMode="numeric"
                value={rangeInput.registerCount}
                onChange={(event) =>
                  setRangeInput({ ...rangeInput, registerCount: event.target.value })
                }
              />
            </label>
            <button type="submit" disabled={presetBusy}>
              应用范围
            </button>
            <span>
              {startAddress}–{startAddress + registerCount - 1} · 0x
              {startAddress.toString(16).toUpperCase()}–0x
              {(startAddress + registerCount - 1).toString(16).toUpperCase()}
            </span>
            <small>地址从 0 开始，支持十进制 / 0x 十六进制；数量 1–125</small>
            {tables.length > 1 && (
              <small>读取一次仅更新当前表；轮询依次读取全部 {tables.length} 张表</small>
            )}
            {rangeError && <p role="alert">{rangeError}</p>}
            {tableErrors[activeTable.id] && (
              <p role="alert">
                {activeTable.name}：{tableErrors[activeTable.id]}
              </p>
            )}
          </form>
          <table
            className="modbus-register-table"
            style={{ minWidth: Math.max(300, 34 + groupCount * 190) }}
          >
            <thead>
              <tr>
                <th aria-label="行号" />
                {Array.from({ length: groupCount }, (_, group) => (
                  <th colSpan={2} key={group}>
                    <span>Alias</span>
                    <strong
                      title={`0x${(startAddress + group * rowsPerGroup).toString(16).toUpperCase()}`}
                      onContextMenu={(event) =>
                        openRegisterMenu(event, startAddress + group * rowsPerGroup)
                      }
                    >
                      {String(startAddress + group * rowsPerGroup).padStart(5, '0')}
                    </strong>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: Math.min(rowsPerGroup, registerCount) }, (_, row) => (
                <tr key={row}>
                  <th>{row}</th>
                  {Array.from({ length: groupCount }, (_, group) => {
                    const address = startAddress + group * rowsPerGroup + row
                    if (address >= startAddress + registerCount)
                      return <td key={address} colSpan={2} />
                    const definition = definitions[address]
                    return (
                      <RegisterCells
                        key={address}
                        address={address}
                        alias={definition?.alias || ''}
                        value={formatRegister(
                          values,
                          address,
                          definition,
                          definitions,
                          wordOrder,
                          startAddress
                        )}
                        selected={selectedAddress === address}
                        onSelect={setSelectedAddress}
                        onContextMenu={(event) => openRegisterMenu(event, address)}
                        onWrite={
                          !canWriteRegister(address)
                            ? undefined
                            : () => openRegisterDialog('write', address)
                        }
                      />
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <footer className="modbus-hint">
        右键寄存器可新增、编辑、写入、删除或创建快捷指令；双击数值使用 H06/H10 写入；支持 MBP 导入和
        JSON 配置导入/导出。各表独立保存范围和定义，共用通信设置；数值不持久化。
        {storageError && <span role="alert">{storageError}</span>}
      </footer>
      {tableDialog && (
        <div className="modbus-dialog-backdrop" onMouseDown={() => setTableDialog(null)}>
          <form
            className="modbus-dialog"
            role="dialog"
            aria-label="寄存器表设置"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setTableDialog(null)
            }}
            onSubmit={(event) => {
              event.preventDefault()
              saveTableDialog()
            }}
          >
            <header>
              <strong>
                {tableDialog.mode === 'add'
                  ? '新增寄存器表'
                  : tableDialog.mode === 'rename'
                    ? '重命名寄存器表'
                    : '删除寄存器表'}
              </strong>
            </header>
            {tableDialog.mode === 'delete' ? (
              <p className="warning">
                删除「{activeTable.name}」及其映射定义？其他表和快捷指令会保留。
              </p>
            ) : (
              <label>
                表名称
                <input
                  autoFocus
                  aria-label="表名称"
                  value={tableDialog.name}
                  onChange={(event) => setTableDialog({ ...tableDialog, name: event.target.value })}
                />
              </label>
            )}
            {tableDialog.mode === 'add' && (
              <>
                <label>
                  起始地址
                  <input
                    aria-label="新表起始地址"
                    value={tableDialog.startAddress}
                    onChange={(event) =>
                      setTableDialog({ ...tableDialog, startAddress: event.target.value })
                    }
                  />
                </label>
                <label>
                  寄存器数量
                  <input
                    aria-label="新表寄存器数量"
                    inputMode="numeric"
                    value={tableDialog.registerCount}
                    onChange={(event) =>
                      setTableDialog({ ...tableDialog, registerCount: event.target.value })
                    }
                  />
                </label>
                <p>地址支持十进制 / 0x 十六进制；数量 1–125。</p>
              </>
            )}
            {tableDialog.error && (
              <p role="alert" className="warning">
                {tableDialog.error}
              </p>
            )}
            <footer>
              <button type="button" onClick={() => setTableDialog(null)}>
                取消
              </button>
              <button
                type="submit"
                className={tableDialog.mode === 'delete' ? 'danger' : 'primary'}
              >
                {tableDialog.mode === 'delete' ? '删除表' : '保存表'}
              </button>
            </footer>
          </form>
        </div>
      )}
      {contextMenu && (
        <div
          className="modbus-context-menu"
          role="menu"
          aria-label="寄存器操作"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <small>
            地址 {contextMenu.address} · 0x{contextMenu.address.toString(16).toUpperCase()}
          </small>
          <button
            disabled={
              Boolean(definitions[contextMenu.address]) ||
              definitions[contextMenu.address - 1]?.words === 2
            }
            onClick={() => {
              openRegisterDialog('add', contextMenu.address)
              setContextMenu(null)
            }}
          >
            新增寄存器
          </button>
          <button
            disabled={!definitions[contextMenu.address]}
            onClick={() => {
              setSelectedAddress(contextMenu.address)
              openRegisterDialog('edit', contextMenu.address)
              setContextMenu(null)
            }}
          >
            编辑寄存器
          </button>
          <button
            disabled={!canWriteRegister(contextMenu.address) || !targetPort || presetBusy}
            onClick={() => {
              openRegisterDialog('write', contextMenu.address)
              setContextMenu(null)
            }}
          >
            写入数值…
          </button>
          <div
            className="modbus-submenu-root"
            onMouseEnter={() => setShortcutSubmenu(true)}
            onMouseLeave={() => setShortcutSubmenu(false)}
          >
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={shortcutSubmenu}
              disabled={definitions[contextMenu.address - 1]?.words === 2 || presetBusy}
              onClick={() => setShortcutSubmenu(true)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight') {
                  event.preventDefault()
                  setShortcutSubmenu(true)
                }
              }}
            >
              创建快捷指令 <span>▸</span>
            </button>
            {shortcutSubmenu &&
              definitions[contextMenu.address - 1]?.words !== 2 &&
              !presetBusy && (
                <div
                  className="modbus-context-menu modbus-register-submenu"
                  role="menu"
                  aria-label="创建快捷指令"
                  style={{
                    left: contextMenu.x + 390 > window.innerWidth ? 'auto' : '100%',
                    right: contextMenu.x + 390 > window.innerWidth ? '100%' : 'auto'
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowLeft') {
                      event.preventDefault()
                      setShortcutSubmenu(false)
                    }
                  }}
                >
                  <button
                    role="menuitem"
                    disabled={
                      values[contextMenu.address - startAddress] === undefined ||
                      (definitions[contextMenu.address]?.words === 2 &&
                        values[contextMenu.address - startAddress + 1] === undefined)
                    }
                    onClick={() => createShortcut(contextMenu.address, true)}
                  >
                    使用当前值…
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => createShortcut(contextMenu.address, false)}
                  >
                    自定义数值…
                  </button>
                </div>
              )}
          </div>
          <i />
          <button
            className="danger"
            disabled={!definitions[contextMenu.address]}
            onClick={() => {
              openRegisterDialog('delete', contextMenu.address)
              setContextMenu(null)
            }}
          >
            删除定义
          </button>
        </div>
      )}
      {settingsDialog && (
        <div className="modbus-dialog-backdrop" onMouseDown={() => setSettingsDialog(null)}>
          <form
            className="modbus-dialog modbus-settings-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setSettingsDialog(null)
            }}
            onSubmit={(event) => {
              event.preventDefault()
              saveCommunicationSettings()
            }}
          >
            <header>
              <strong>通信设置</strong>
              <button type="button" aria-label="关闭" onClick={() => setSettingsDialog(null)}>
                ×
              </button>
            </header>
            <div className="modbus-settings-grid">
              <label className="wide">
                串口
                <select
                  autoFocus
                  value={settingsDialog.port}
                  onChange={(event) =>
                    setSettingsDialog({ ...settingsDialog, port: event.target.value })
                  }
                >
                  <option value="">选择已打开串口</option>
                  {ports.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                从站 ID
                <input
                  type="number"
                  min="1"
                  max="247"
                  value={settingsDialog.slave}
                  onChange={(event) =>
                    setSettingsDialog({ ...settingsDialog, slave: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                功能码
                <select value={functionCode} disabled>
                  <option value="3">03 Holding</option>
                </select>
              </label>
              <label>
                32 位字序
                <select
                  value={settingsDialog.wordOrder}
                  onChange={(event) =>
                    setSettingsDialog({
                      ...settingsDialog,
                      wordOrder: event.target.value as WordOrder
                    })
                  }
                >
                  <option value="cdab">CDAB · mbs=0</option>
                  <option value="abcd">ABCD · mbs=1</option>
                </select>
              </label>
              <label>
                扫描周期
                <span className="modbus-rate-input">
                  <input
                    type="number"
                    min="50"
                    max="60000"
                    value={settingsDialog.scanRate}
                    onChange={(event) =>
                      setSettingsDialog({
                        ...settingsDialog,
                        scanRate: Number(event.target.value)
                      })
                    }
                  />
                  <i>ms</i>
                </span>
              </label>
            </div>
            <footer>
              <button type="button" onClick={() => setSettingsDialog(null)}>
                取消
              </button>
              <button className="primary" type="submit">
                保存
              </button>
            </footer>
          </form>
        </div>
      )}
      {registerDialog && (
        <div className="modbus-dialog-backdrop" onMouseDown={() => setRegisterDialog(null)}>
          <form
            className="modbus-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setRegisterDialog(null)
            }}
            onSubmit={(event) => {
              event.preventDefault()
              if (registerDialog.mode === 'write')
                void writeRegister(registerDialog.address, registerDialog.value)
              else if (registerDialog.mode === 'delete') deleteDefinition(registerDialog.address)
              else saveRegisterDefinition()
            }}
          >
            <header>
              <strong>
                {registerDialog.mode === 'add'
                  ? '新增寄存器'
                  : registerDialog.mode === 'edit'
                    ? '编辑寄存器'
                    : registerDialog.mode === 'write'
                      ? '写入寄存器'
                      : '删除寄存器'}
              </strong>
              <button type="button" aria-label="关闭" onClick={() => setRegisterDialog(null)}>
                ×
              </button>
            </header>
            <p>地址 {String(registerDialog.address).padStart(5, '0')}</p>
            {(registerDialog.mode === 'add' || registerDialog.mode === 'edit') && (
              <>
                <label>
                  Alias
                  <input
                    autoFocus
                    value={registerDialog.alias}
                    placeholder="寄存器名称"
                    onChange={(event) =>
                      setRegisterDialog({ ...registerDialog, alias: event.target.value })
                    }
                  />
                </label>
                <label>
                  数据类型
                  <select
                    value={registerDialog.format}
                    onChange={(event) =>
                      setRegisterDialog({
                        ...registerDialog,
                        format: event.target.value as RegisterDefinition['format']
                      })
                    }
                  >
                    <option value="hex16">HEX16 · 1 个寄存器</option>
                    <option value="uint16">UINT16 · 1 个寄存器</option>
                    <option value="int32">INT32 · 2 个寄存器</option>
                    <option value="uint32">UINT32 · 2 个寄存器</option>
                    <option value="float32">FLOAT32 · 2 个寄存器</option>
                  </select>
                </label>
              </>
            )}
            {registerDialog.mode === 'write' && (
              <label>
                写入值 · {definitions[registerDialog.address]?.format}
                <input
                  autoFocus
                  value={registerDialog.value}
                  onChange={(event) =>
                    setRegisterDialog({ ...registerDialog, value: event.target.value })
                  }
                />
              </label>
            )}
            {registerDialog.mode === 'delete' && (
              <p className="warning">
                确定删除“{definitions[registerDialog.address]?.alias || '未命名寄存器'}”的映射定义？
              </p>
            )}
            <footer>
              <button type="button" onClick={() => setRegisterDialog(null)}>
                取消
              </button>
              <button
                className={registerDialog.mode === 'delete' ? 'danger' : 'primary'}
                type="submit"
              >
                {registerDialog.mode === 'delete'
                  ? '删除'
                  : registerDialog.mode === 'write'
                    ? '发送'
                    : '保存'}
              </button>
            </footer>
          </form>
        </div>
      )}
    </section>
  )
}

function RegisterCells({
  address,
  alias,
  value,
  selected,
  onSelect,
  onContextMenu,
  onWrite
}: {
  address: number
  alias: string
  value: string
  selected: boolean
  onSelect: (address: number) => void
  onContextMenu: (event: React.MouseEvent<HTMLTableCellElement>) => void
  onWrite?: (address: number) => void
}): React.JSX.Element {
  return (
    <>
      <td
        className="modbus-alias"
        title={alias || `寄存器 ${address}`}
        onClick={() => onSelect(address)}
        onContextMenu={onContextMenu}
      >
        {alias}
      </td>
      <td
        className={`modbus-value ${selected ? 'selected' : ''}`}
        data-address={address}
        title={`地址 ${address} · 0x${address.toString(16).toUpperCase()}${onWrite ? ' · 双击写入' : ' · 32 位数据需完整范围'}`}
        onClick={() => onSelect(address)}
        onContextMenu={onContextMenu}
        onDoubleClick={() => onWrite && void onWrite(address)}
      >
        {value}
      </td>
    </>
  )
}
