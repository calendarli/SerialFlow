export const modbusWorkspaceKey = 'serialflow.modbus.workspace.v1'
export const modbusTablesWorkspaceKey = 'serialflow.modbus.workspace.v2'

export const defaultModbusRange = { startAddress: 0, registerCount: 50 }
export type ModbusRange = typeof defaultModbusRange

function parseInteger(value: unknown): number {
  if (typeof value === 'number') return Number.isInteger(value) ? value : NaN
  return typeof value === 'string' && /^(?:\d+|0x[\da-f]+)$/i.test(value.trim())
    ? Number(value)
    : NaN
}

export function parseModbusRange(start: unknown, count: unknown): ModbusRange {
  const startAddress = parseInteger(start)
  const registerCount = parseInteger(count)
  if (!Number.isInteger(startAddress) || startAddress < 0 || startAddress > 0xffff)
    throw new Error('起始地址必须为 0–65535，支持十进制或 0x 十六进制')
  if (!Number.isInteger(registerCount) || registerCount < 1 || registerCount > 125)
    throw new Error('寄存器数量必须为 1–125')
  if (startAddress + registerCount > 0x10000)
    throw new Error('读取范围不能超过地址 65535（0xFFFF）')
  return { startAddress, registerCount }
}

export type RegisterDefinition = {
  alias?: string
  format: 'hex16' | 'uint16' | 'int32' | 'uint32' | 'float32'
  words: 1 | 2
}

export type ModbusWorkspace = ModbusRange & {
  version: 1
  mapName: string
  definitions: Record<number, RegisterDefinition>
}

export function parseModbusWorkspace(raw: string): ModbusWorkspace {
  const data = JSON.parse(raw)
  const integer = (value: unknown, min: number, max: number): boolean =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
  if (
    !data ||
    data.version !== 1 ||
    typeof data.mapName !== 'string' ||
    !data.definitions ||
    typeof data.definitions !== 'object' ||
    Array.isArray(data.definitions)
  )
    throw new Error('Modbus 本地数据格式无效')
  for (const [address, item] of Object.entries(data.definitions)) {
    const definition = item as RegisterDefinition
    if (
      !/^(?:\d+|0x[\da-f]+)$/i.test(address) ||
      !integer(Number(address), 0, 0xffff) ||
      !definition ||
      !['hex16', 'uint16', 'int32', 'uint32', 'float32'].includes(definition.format) ||
      (definition.alias !== undefined && typeof definition.alias !== 'string') ||
      definition.words !== (['hex16', 'uint16'].includes(definition.format) ? 1 : 2) ||
      Number(address) + definition.words > 0x10000
    )
      throw new Error('Modbus 本地寄存器映射无效')
  }
  return {
    version: 1,
    mapName: data.mapName,
    ...parseModbusRange(
      data.startAddress ?? defaultModbusRange.startAddress,
      data.registerCount ?? defaultModbusRange.registerCount
    ),
    definitions: Object.fromEntries(
      Object.entries(data.definitions).map(([address, definition]) => [Number(address), definition])
    ) as Record<number, RegisterDefinition>
  }
}

export type ModbusMapSettings = ModbusRange & {
  slave: number
  scanRate: number
  wordOrder: 'abcd' | 'cdab'
}

// Version 1 stays additive: old exports have registerCount but no startAddress.
export function parseModbusMap(raw: string): {
  definitions: Record<number, RegisterDefinition>
  settings: ModbusRange & Partial<ModbusMapSettings>
} {
  const data = JSON.parse(raw)
  if (
    !data ||
    data.format !== 'serialflow-modbus-map' ||
    data.version !== 1 ||
    !Array.isArray(data.registers)
  )
    throw new Error('不是受支持的 SerialFlow Modbus 配置')
  const range = parseModbusRange(
    data.startAddress ?? defaultModbusRange.startAddress,
    data.registerCount ?? defaultModbusRange.registerCount
  )
  const definitions: Record<number, RegisterDefinition> = {}
  for (const item of data.registers) {
    const address = parseInteger(item?.address)
    const format = ['hex16', 'uint16', 'int32', 'uint32', 'float32'].includes(item?.format)
      ? (item.format as RegisterDefinition['format'])
      : 'uint16'
    const words = format === 'hex16' || format === 'uint16' ? 1 : 2
    if (!Number.isInteger(address) || address < 0 || address + words > 0x10000)
      throw new Error('配置中的寄存器地址无效或超出范围')
    definitions[address] = {
      alias: typeof item.alias === 'string' ? item.alias : '',
      format,
      words
    }
  }
  return {
    definitions,
    settings: {
      ...range,
      ...(Number.isInteger(data.slave) ? { slave: Math.min(247, Math.max(1, data.slave)) } : {}),
      ...(Number.isInteger(data.scanRate)
        ? { scanRate: Math.min(60000, Math.max(50, data.scanRate)) }
        : {}),
      ...(['abcd', 'cdab'].includes(data.wordOrder) ? { wordOrder: data.wordOrder } : {})
    }
  }
}

export function exportModbusMap(
  name: string,
  definitions: Record<number, RegisterDefinition>,
  settings: ModbusMapSettings
): object {
  return {
    format: 'serialflow-modbus-map',
    version: 1,
    name,
    ...settings,
    functionCode: 3,
    registers: Object.entries(definitions)
      .map(([address, definition]) => ({ address: Number(address), ...definition }))
      .sort((left, right) => left.address - right.address)
  }
}

export type ModbusTable = ModbusRange & {
  id: string
  name: string
  mapName: string
  definitions: Record<number, RegisterDefinition>
}

export type ModbusTablesWorkspace = {
  version: 2
  activeTableId: string
  tables: ModbusTable[]
}

function validateTableIdentity(id: unknown, name: unknown, ids: Set<string>): void {
  if (typeof id !== 'string' || !id.trim() || ids.has(id) || Object.hasOwn(Object.prototype, id))
    throw new Error('寄存器表标识无效或重复')
  if (typeof name !== 'string' || !name.trim()) throw new Error('寄存器表名称不能为空')
  ids.add(id)
}

export function parseModbusTablesWorkspace(raw: string): ModbusTablesWorkspace {
  const data = JSON.parse(raw)
  if (data?.version === 1) {
    const legacy = parseModbusWorkspace(raw)
    return {
      version: 2,
      activeTableId: 'legacy-table',
      tables: [
        {
          id: 'legacy-table',
          name: '表 1',
          mapName: legacy.mapName,
          startAddress: legacy.startAddress,
          registerCount: legacy.registerCount,
          definitions: legacy.definitions
        }
      ]
    }
  }
  if (data?.version !== 2 || !Array.isArray(data.tables) || !data.tables.length)
    throw new Error('Modbus 多表数据格式无效')
  const ids = new Set<string>()
  const tables = data.tables.map((item: ModbusTable) => {
    validateTableIdentity(item?.id, item?.name, ids)
    const parsed = parseModbusWorkspace(JSON.stringify({ ...item, version: 1 }))
    return {
      id: item.id,
      name: item.name,
      mapName: parsed.mapName,
      startAddress: parsed.startAddress,
      registerCount: parsed.registerCount,
      definitions: parsed.definitions
    }
  })
  if (!ids.has(data.activeTableId)) throw new Error('当前寄存器表不存在')
  return { version: 2, activeTableId: data.activeTableId, tables }
}

type CommunicationSettings = Omit<ModbusMapSettings, keyof ModbusRange>

export function exportModbusTableCollection(
  tables: ModbusTable[],
  activeTableId: string,
  settings: CommunicationSettings
): object {
  return {
    format: 'serialflow-modbus-map',
    version: 2,
    ...settings,
    functionCode: 3,
    activeTableId,
    tables: tables.map((table) => ({
      id: table.id,
      name: table.name,
      mapName: table.mapName,
      startAddress: table.startAddress,
      registerCount: table.registerCount,
      registers: Object.entries(table.definitions)
        .map(([address, definition]) => ({ address: Number(address), ...definition }))
        .sort((left, right) => left.address - right.address)
    }))
  }
}

export function parseModbusTableCollection(raw: string): {
  workspace: ModbusTablesWorkspace
  settings: Partial<CommunicationSettings>
} {
  const data = JSON.parse(raw)
  if (
    data?.format !== 'serialflow-modbus-map' ||
    data.version !== 2 ||
    !Array.isArray(data.tables) ||
    !data.tables.length
  )
    throw new Error('不是受支持的 SerialFlow Modbus 多表配置')
  const ids = new Set<string>()
  const tables: ModbusTable[] = data.tables.map((item: ModbusTable & { registers?: unknown }) => {
    validateTableIdentity(item?.id, item?.name, ids)
    const { definitions, settings } = parseModbusMap(
      JSON.stringify({ ...item, format: 'serialflow-modbus-map', version: 1 })
    )
    return {
      id: item.id,
      name: item.name,
      mapName: typeof item.mapName === 'string' ? item.mapName : item.name,
      startAddress: settings.startAddress,
      registerCount: settings.registerCount,
      definitions
    }
  })
  const { settings } = parseModbusMap(
    JSON.stringify({ ...data, version: 1, startAddress: 0, registerCount: 1, registers: [] })
  )
  const communication: Partial<CommunicationSettings> = {}
  if (settings.slave !== undefined) communication.slave = settings.slave
  if (settings.scanRate !== undefined) communication.scanRate = settings.scanRate
  if (settings.wordOrder !== undefined) communication.wordOrder = settings.wordOrder
  const activeTableId = data.activeTableId ?? tables[0].id
  if (!ids.has(activeTableId)) throw new Error('当前寄存器表不存在')
  return { workspace: { version: 2, tables, activeTableId }, settings: communication }
}

export type ModbusTableValues = Record<string, Array<number | undefined>>

// All tables show the same device; keep overlapping raw words consistent after confirmed IO.
export function updateModbusTableValues(
  tables: ModbusTable[],
  current: ModbusTableValues,
  address: number,
  words: number[]
): ModbusTableValues {
  const next = { ...current }
  for (const table of tables) {
    const first = Math.max(address, table.startAddress)
    const end = Math.min(address + words.length, table.startAddress + table.registerCount)
    if (first >= end) continue
    const values = Array.from(
      { length: table.registerCount },
      (_, offset) => current[table.id]?.[offset]
    )
    for (let position = first; position < end; position++)
      values[position - table.startAddress] = words[position - address]
    next[table.id] = values
  }
  return next
}
