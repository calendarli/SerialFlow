import { appendCrc } from './serial-utils'

export const modbusFormats = ['hex16', 'uint16', 'int32', 'uint32', 'float32'] as const
export type ModbusFormat = (typeof modbusFormats)[number]
export type ModbusCommand = {
  id: string
  name: string
  address: string
  value: string
  format: ModbusFormat
}
export type ModbusGroup = { id: string; name: string; commands: ModbusCommand[] }
export type ModbusPreset = {
  id: string
  name: string
  slave: number
  wordOrder: 'abcd' | 'cdab'
  groups: ModbusGroup[]
}
export const modbusPresetKey = 'serialflow.modbus.presets.v1'
export const modbusShortcutKey = 'serialflow.modbus.shortcuts.v1'

export function captureModbusPreset(
  values: Array<number | undefined>,
  definitions: Record<number, { alias?: string; format: ModbusFormat; words: 1 | 2 }>,
  slave: number,
  wordOrder: ModbusPreset['wordOrder'],
  name: string
): ModbusPreset {
  const commands: ModbusCommand[] = []
  for (let address = 0; address < values.length; address++) {
    const first = values[address]
    if (first === undefined) continue
    if (definitions[address - 1]?.words === 2)
      throw new Error(`地址 ${address - 1} 的 32 位数据不完整，请先读取寄存器`)
    const definition = definitions[address]
    const format = definition?.format || 'uint16'
    let value = first
    if (definition?.words === 2) {
      const second = values[address + 1]
      if (second === undefined)
        throw new Error(`地址 ${address} 的 32 位数据不完整，请先读取寄存器`)
      const view = new DataView(new ArrayBuffer(4))
      view.setUint16(0, wordOrder === 'abcd' ? first : second)
      view.setUint16(2, wordOrder === 'abcd' ? second : first)
      value =
        format === 'float32'
          ? view.getFloat32(0)
          : format === 'int32'
            ? view.getInt32(0)
            : view.getUint32(0)
    }
    const command: ModbusCommand = {
      id: crypto.randomUUID(),
      name: definition?.alias || `寄存器 ${address}`,
      address: String(address),
      value: Object.is(value, -0) ? '-0' : String(value),
      format
    }
    encodeModbusCommand(command, slave, wordOrder)
    commands.push(command)
    if (definition?.words === 2) address++
  }
  if (!commands.length)
    throw new Error('主页暂无有效寄存器数据，请先读取设备或写入寄存器后再保存配置')
  return {
    id: crypto.randomUUID(),
    name,
    slave,
    wordOrder,
    groups: [{ id: crypto.randomUUID(), name: '主页寄存器', commands }]
  }
}

export function saveModbusCommand(
  groups: ModbusGroup[],
  groupId: string,
  command: ModbusCommand
): ModbusGroup[] {
  const target =
    groupId || groups.find((group) => group.name === '未分组')?.id || crypto.randomUUID()
  const next = groups.map((group) => ({
    ...group,
    commands:
      group.id === target
        ? group.commands.some((item) => item.id === command.id)
          ? group.commands.map((item) => (item.id === command.id ? command : item))
          : [...group.commands, command]
        : group.commands.filter((item) => item.id !== command.id)
  }))
  if (!next.some((group) => group.id === target))
    next.push({ id: target, name: '未分组', commands: [command] })
  return next
}

export function encodeModbusCommand(
  command: ModbusCommand,
  slave: number,
  order: ModbusPreset['wordOrder']
): { request: Uint8Array; address: number; words: number[] } {
  const address = Number(command.address)
  const value = Number(command.value)
  const wide = !['hex16', 'uint16'].includes(command.format)
  if (!Number.isInteger(slave) || slave < 1 || slave > 247) throw new Error('从站地址必须为 1–247')
  if (!modbusFormats.includes(command.format) || !['abcd', 'cdab'].includes(order))
    throw new Error('无效的数据类型或字序')
  if (
    !/^(?:\d+|0x[\da-f]+)$/i.test(command.address.trim()) ||
    !Number.isInteger(address) ||
    address < 0 ||
    address > (wide ? 65534 : 65535)
  )
    throw new Error('寄存器地址超出范围（32 位数据需要两个寄存器）')
  const minimum = command.format === 'int32' ? -2147483648 : 0
  const maximum = wide ? (command.format === 'int32' ? 2147483647 : 4294967295) : 65535
  if (
    !command.value.trim() ||
    !Number.isFinite(value) ||
    (command.format === 'float32'
      ? !Number.isFinite(Math.fround(value))
      : !Number.isInteger(value) || value < minimum || value > maximum)
  )
    throw new Error(`数据超出 ${command.format.toUpperCase()} 范围`)
  const view = new DataView(new ArrayBuffer(4))
  if (command.format === 'float32') view.setFloat32(0, value)
  else if (command.format === 'int32') view.setInt32(0, value)
  else view.setUint32(0, value)
  const words = wide ? [view.getUint16(0), view.getUint16(2)] : [value]
  if (wide && order === 'cdab') words.reverse()
  const bytes = (n: number): number[] => [n >> 8, n & 255]
  const body =
    words.length === 1
      ? [slave, 6, ...bytes(address), ...bytes(words[0])]
      : [slave, 16, ...bytes(address), 0, 2, 4, ...words.flatMap(bytes)]
  return { request: appendCrc(Uint8Array.from(body), 'modbus'), address, words }
}

export function moveItem<T extends { id: string }>(
  items: T[],
  source: string,
  target: string
): T[] {
  const from = items.findIndex((item) => item.id === source)
  const to = items.findIndex((item) => item.id === target)
  if (from < 0 || to < 0 || from === to) return items
  const next = [...items]
  next.splice(to, 0, next.splice(from, 1)[0])
  return next
}

export function parseModbusPresets(raw: string): ModbusPreset[] {
  const data: unknown = JSON.parse(raw)
  if (!Array.isArray(data)) throw new Error('配置列表损坏')
  const ids = new Set<string>()
  const checkId = (id: unknown): void => {
    if (typeof id !== 'string' || !id || ids.has(id)) throw new Error('配置标识损坏')
    ids.add(id)
  }
  for (const preset of data) {
    if (
      !preset ||
      typeof preset.name !== 'string' ||
      !Array.isArray(preset.groups) ||
      !Number.isInteger(preset.slave) ||
      preset.slave < 1 ||
      preset.slave > 247 ||
      !['abcd', 'cdab'].includes(preset.wordOrder)
    )
      throw new Error('设备配置损坏')
    checkId(preset.id)
    for (const group of preset.groups) {
      if (!group || typeof group.name !== 'string' || !Array.isArray(group.commands))
        throw new Error('分组损坏')
      checkId(group.id)
      for (const command of group.commands) {
        if (
          !command ||
          typeof command.name !== 'string' ||
          typeof command.address !== 'string' ||
          typeof command.value !== 'string'
        )
          throw new Error('快捷指令损坏')
        checkId(command.id)
        encodeModbusCommand(command, preset.slave, preset.wordOrder)
      }
    }
  }
  return data as ModbusPreset[]
}

export async function runModbusCommands(
  commands: ModbusCommand[],
  write: (command: ModbusCommand) => Promise<void>,
  cancelled: () => boolean,
  progress: (completed: number) => void
): Promise<void> {
  for (let index = 0; index < commands.length; index++) {
    if (cancelled()) throw new Error('写入已停止')
    await write(commands[index])
    progress(index + 1)
  }
}
