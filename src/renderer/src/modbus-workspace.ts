export const modbusWorkspaceKey = 'serialflow.modbus.workspace.v1'

export type RegisterDefinition = {
  alias?: string
  format: 'hex16' | 'uint16' | 'int32' | 'uint32' | 'float32'
  words: 1 | 2
}

export type ModbusWorkspace = {
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
      !integer(Number(address), 0, 49) ||
      !definition ||
      !['hex16', 'uint16', 'int32', 'uint32', 'float32'].includes(definition.format) ||
      (definition.alias !== undefined && typeof definition.alias !== 'string') ||
      definition.words !== (['hex16', 'uint16'].includes(definition.format) ? 1 : 2)
    )
      throw new Error('Modbus 本地寄存器映射无效')
  }
  return { version: 1, mapName: data.mapName, definitions: data.definitions }
}
