import { useEffect, useMemo, useRef, useState } from 'react'
import { appendCrc, base64ToBytes, bytesToHex } from '../serial-utils'
import { ModbusClient } from '../modbus-client'
import { ModbusPresets } from './ModbusPresets'
import { sidebarPageMinimumWidth } from '../sidebar-layout'
import {
  encodeModbusCommand,
  captureModbusPreset,
  runModbusCommands,
  type ModbusCommand,
  type ModbusPreset
} from '../modbus-presets'

type Props = {
  ports: string[]
  onSend: (text: string, hex: boolean, port: string) => Promise<boolean>
}

type RegisterDefinition = {
  alias?: string
  format: 'hex16' | 'uint16' | 'int32' | 'uint32' | 'float32'
  words: 1 | 2
}

type WordOrder = 'abcd' | 'cdab'
type RegisterDialog = {
  mode: 'add' | 'edit' | 'write' | 'delete'
  address: number
  alias: string
  format: RegisterDefinition['format']
  value: string
}
type ModbusMenu = 'config' | 'communication' | 'operation'
type CommunicationSettings = {
  port: string
  slave: number
  wordOrder: WordOrder
  scanRate: number
}

const registerCount = 50
const rowsPerGroup = 10
const registerDefinitions: Record<number, RegisterDefinition> = {
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
  headers.slice(0, registerCount / rowsPerGroup).forEach((header, group) => {
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
  order: WordOrder
): Uint8Array | null {
  const first = values[address]
  const second = values[address + 1]
  if (first === undefined || second === undefined) return null
  const words = order === 'abcd' ? [first, second] : [second, first]
  return Uint8Array.from([...word(words[0]), ...word(words[1])])
}

function formatRegister(
  values: Array<number | undefined>,
  address: number,
  definition: RegisterDefinition | undefined,
  definitions: Record<number, RegisterDefinition>,
  order: WordOrder
): string {
  const value = values[address]
  if (value === undefined) return '--'
  if (!definition) {
    const previous = definitions[address - 1]
    return previous?.words === 2 ? '--' : String(value)
  }
  if (definition.format === 'hex16') return `0x${value.toString(16).toUpperCase().padStart(4, '0')}`
  if (definition.words === 1) return String(value)
  const bytes = registerBytes(values, address, order)
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

export function ModbusPanel({ ports, onSend }: Props): React.JSX.Element {
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
  const [port, setPort] = useState('')
  const [slave, setSlave] = useState(1)
  const functionCode = 3
  const [wordOrder, setWordOrder] = useState<WordOrder>('cdab')
  const [definitions, setDefinitions] = useState<Record<number, RegisterDefinition>>(() => ({
    ...registerDefinitions
  }))
  const [registerDialog, setRegisterDialog] = useState<RegisterDialog | null>(null)
  const [openMenu, setOpenMenu] = useState<ModbusMenu | null>(null)
  const [settingsDialog, setSettingsDialog] = useState<CommunicationSettings | null>(null)
  const [mapName, setMapName] = useState('vsmd104_105_x4.mbp')
  const [scanRate, setScanRate] = useState(1000)
  const [polling, setPolling] = useState(false)
  const [values, setValues] = useState<Array<number | undefined>>(() =>
    Array.from({ length: registerCount })
  )
  const [selectedAddress, setSelectedAddress] = useState(0)
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

  useEffect(() => {
    if (!contextMenu && !openMenu) return
    const close = (): void => {
      setContextMenu(null)
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

  const readRequest = useMemo(
    () => makeRequest(normalizedSlave, functionCode, 0, registerCount),
    [functionCode, normalizedSlave]
  )

  useEffect(() => {
    const client = clientRef.current
    setValues(Array.from({ length: registerCount }))
    const connection = connectionRevision.current
    const offData = window.api.onData(({ path, chunks }) => {
      if (path === targetPort) for (const chunk of chunks) client.push(chunk)
    })
    const offStatus = window.api.onStatus(({ path, open }) => {
      if (path === targetPort && !open) {
        connection.value++
        client.cancel('Modbus disconnected')
        setPolling(false)
        setMessage('No connection')
      }
    })
    return () => {
      connection.value++
      client.cancel()
      offData()
      offStatus()
    }
  }, [targetPort, normalizedSlave])

  const sendRead = async (): Promise<void> => {
    if (!targetPort || clientRef.current.busy || presetRun.current.busy) return
    const revision = connectionRevision.current.value
    setMessage('Waiting for response...')
    try {
      const frame = await clientRef.current.request(readRequest, async () => {
        const success = await onSendRef.current(bytesToHex(readRequest), true, targetPort)
        if (success && revision === connectionRevision.current.value)
          setTxCount((count) => count + 1)
        return success
      })
      if (revision !== connectionRevision.current.value) return
      setValues(
        Array.from(
          { length: registerCount },
          (_, index) => (frame[3 + index * 2] << 8) | frame[4 + index * 2]
        )
      )
      setLastResponseMs(Date.now())
      setMessage('Connected')
    } catch (error) {
      if (revision !== connectionRevision.current.value) return
      setErrorCount((count) => count + 1)
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    if (!polling || !targetPort) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      await sendRead()
      if (!cancelled) timer = setTimeout(() => void poll(), normalizedRate)
    }
    timer = setTimeout(() => void poll(), 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // The callback's connection and request are fixed for this polling session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling, readRequest, normalizedRate, targetPort])

  const writeRegister = async (address: number, input: string): Promise<void> => {
    if (presetRun.current.busy) return setMessage('正在写入设备配置，请等待完成')
    if (!targetPort) return setMessage('No connection')
    const definition = definitions[address] || {
      format: 'uint16' as const,
      words: 1 as const
    }
    const numeric = Number(input)
    const integerFormat = definition.format !== 'float32'
    const minimum = definition.format === 'int32' ? -0x80000000 : 0
    const maximum =
      definition.format === 'int32' ? 0x7fffffff : definition.words === 2 ? 0xffffffff : 0xffff
    if (
      !Number.isFinite(numeric) ||
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
      setValues((currentValues) =>
        currentValues.map((value, index) => {
          const offset = index - address
          return offset >= 0 && offset < encodedWords.length ? encodedWords[offset] : value
        })
      )
      setLastResponseMs(Date.now())
      setMessage(`Register ${String(address).padStart(5, '0')} written`)
      setRegisterDialog(null)
    } catch (error) {
      if (revision !== connectionRevision.current.value) return
      setErrorCount((count) => count + 1)
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const runPreset = async (preset: ModbusPreset, commands: ModbusCommand[]): Promise<void> => {
    if (!targetPort || presetRun.current.busy) return
    if (clientRef.current.busy) {
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
            setValues((current) =>
              current.map((value, index) =>
                index >= address && index < address + words.length ? words[index - address] : value
              )
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
      const bytes = base64ToBytes(selected.base64)
      if (selected.name.toLowerCase().endsWith('.json')) {
        const config = JSON.parse(new TextDecoder().decode(bytes)) as {
          format?: string
          version?: number
          slave?: number
          scanRate?: number
          wordOrder?: WordOrder
          registers?: Array<{
            address?: number
            alias?: string
            format?: RegisterDefinition['format']
          }>
        }
        if (
          config.format !== 'serialflow-modbus-map' ||
          config.version !== 1 ||
          !Array.isArray(config.registers)
        )
          throw new Error('不是受支持的 SerialFlow Modbus 配置')
        const validFormats = new Set<RegisterDefinition['format']>([
          'hex16',
          'uint16',
          'int32',
          'uint32',
          'float32'
        ])
        const next: Record<number, RegisterDefinition> = {}
        for (const item of config.registers) {
          const address = Number(item.address)
          if (!Number.isInteger(address) || address < 0 || address >= registerCount) continue
          const format = validFormats.has(item.format as RegisterDefinition['format'])
            ? (item.format as RegisterDefinition['format'])
            : 'uint16'
          next[address] = {
            alias: typeof item.alias === 'string' ? item.alias : '',
            format,
            words: format === 'hex16' || format === 'uint16' ? 1 : 2
          }
        }
        setDefinitions(next)
        if (Number.isInteger(config.slave)) setSlave(clampInteger(Number(config.slave), 1, 247))
        if (Number.isInteger(config.scanRate))
          setScanRate(clampInteger(Number(config.scanRate), 50, 60000))
        if (config.wordOrder === 'abcd' || config.wordOrder === 'cdab')
          setWordOrder(config.wordOrder)
        setMessage(`Imported ${Object.keys(next).length} register definitions`)
      } else {
        const aliases = parseMbpAliases(bytes)
        const next = Object.fromEntries(
          Object.entries(registerDefinitions).map(([address, definition]) => [
            address,
            { ...definition, alias: aliases[Number(address)] || '' }
          ])
        ) as Record<number, RegisterDefinition>
        for (const [address, alias] of Object.entries(aliases))
          if (alias && !next[Number(address)])
            next[Number(address)] = { alias, format: 'uint16', words: 1 }
        setDefinitions(next)
        setMessage(`Imported ${Object.values(aliases).filter(Boolean).length} aliases`)
      }
      setMapName(selected.name)
    } catch (cause) {
      setErrorCount((count) => count + 1)
      setMessage(cause instanceof Error ? cause.message : 'MBP import failed')
    }
  }

  const exportMap = async (): Promise<void> => {
    const path = await window.api.saveModbusMap({
      format: 'serialflow-modbus-map',
      version: 1,
      name: mapName,
      slave: normalizedSlave,
      functionCode,
      scanRate: normalizedRate,
      wordOrder,
      registerCount,
      registers: Object.entries(definitions)
        .map(([address, definition]) => ({ address: Number(address), ...definition }))
        .sort((left, right) => left.address - right.address)
    })
    if (path) {
      setMapName(path.split(/[\\/]/).at(-1) || mapName)
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
    const displayed = definition
      ? formatRegister(values, address, definition, definitions, wordOrder)
      : '0'
    setRegisterDialog({
      mode,
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
      (registerDialog.address >= registerCount - 1 || definitions[registerDialog.address + 1])
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

  return (
    <section
      ref={layoutRef}
      className="modbus-monitor"
      style={{ gridTemplateColumns: `${sidebarWidth}px 10px minmax(0, 1fr)` }}
    >
      <div
        className="modbus-sidebar-resizer"
        role="separator"
        aria-label="调整快捷指令栏宽度"
        aria-orientation="vertical"
        aria-valuemin={sidebarPageMinimumWidth}
        aria-valuemax={sidebarMaximum}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        title="拖动调整宽度，双击恢复默认宽度"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          resizeStart.current = { x: event.clientX, width: sidebarWidth }
        }}
        onPointerMove={(event) => {
          if (resizeStart.current)
            resizeSidebar(resizeStart.current.width + event.clientX - resizeStart.current.x)
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
        onDoubleClick={() => resizeSidebar(sidebarPageMinimumWidth)}
        onKeyDown={(event) => {
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
                  disabled={!targetPort || polling || presetBusy}
                  onClick={() => {
                    setOpenMenu(null)
                    void sendRead()
                  }}
                >
                  读取一次
                </button>
                <button
                  disabled={!targetPort || presetBusy}
                  onClick={() => {
                    setOpenMenu(null)
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

      <aside className="modbus-sidebar">
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
              captureModbusPreset(
                values,
                definitions,
                normalizedSlave,
                wordOrder,
                `${mapName.replace(/\.[^.]+$/, '')} · ID ${normalizedSlave}`
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
        <table className="modbus-register-table">
          <thead>
            <tr>
              <th aria-label="行号" />
              {Array.from({ length: registerCount / rowsPerGroup }, (_, group) => (
                <th colSpan={2} key={group}>
                  <span>Alias</span>
                  <strong>{String(group * rowsPerGroup).padStart(5, '0')}</strong>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rowsPerGroup }, (_, row) => (
              <tr key={row}>
                <th>{row}</th>
                {Array.from({ length: registerCount / rowsPerGroup }, (_, group) => {
                  const address = group * rowsPerGroup + row
                  const definition = definitions[address]
                  return (
                    <RegisterCells
                      key={address}
                      address={address}
                      alias={definition?.alias || ''}
                      value={formatRegister(values, address, definition, definitions, wordOrder)}
                      selected={selectedAddress === address}
                      onSelect={setSelectedAddress}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        setSelectedAddress(address)
                        setContextMenu({
                          x: Math.min(event.clientX, window.innerWidth - 190),
                          y: Math.min(event.clientY, window.innerHeight - 190),
                          address
                        })
                      }}
                      onWrite={
                        definitions[address - 1]?.words === 2
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
      <footer className="modbus-hint">
        右键寄存器可新增、编辑、写入或删除；双击数值使用 H06/H10 写入；支持 MBP 导入和 JSON
        配置导入/导出。
      </footer>
      {contextMenu && (
        <div
          className="modbus-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
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
            disabled={
              !definitions[contextMenu.address] ||
              definitions[contextMenu.address - 1]?.words === 2 ||
              !targetPort
            }
            onClick={() => {
              openRegisterDialog('write', contextMenu.address)
              setContextMenu(null)
            }}
          >
            写入数值…
          </button>
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
        title={`地址 ${String(address).padStart(5, '0')}${onWrite ? ' · 双击写入' : ' · 32 位数据高地址'}`}
        onClick={() => onSelect(address)}
        onContextMenu={onContextMenu}
        onDoubleClick={() => onWrite && void onWrite(address)}
      >
        {value}
      </td>
    </>
  )
}
