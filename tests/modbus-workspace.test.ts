import { describe, expect, test } from 'bun:test'
import {
  defaultModbusRange,
  parseModbusRange,
  parseModbusMap,
  exportModbusMap,
  parseModbusWorkspace,
  type ModbusWorkspace
} from '../src/renderer/src/modbus-workspace'

const workspace: ModbusWorkspace = {
  version: 1,
  ...defaultModbusRange,
  mapName: '导入后编辑.json',
  definitions: {
    0: { alias: '运动控制', format: 'uint16', words: 1 },
    10: { alias: '位置', format: 'int32', words: 2 }
  }
}

describe('Modbus workspace persistence', () => {
  test('restores imported/manual mappings and preserves deleted definitions', () => {
    expect(parseModbusWorkspace(JSON.stringify(workspace))).toEqual(workspace)
    expect(
      parseModbusWorkspace(JSON.stringify({ ...workspace, definitions: {} })).definitions
    ).toEqual({})
    expect(parseModbusWorkspace(JSON.stringify({ ...workspace, values: [42] }))).toEqual(workspace)
  })

  test('rejects malformed or incompatible storage', () => {
    for (const patch of [
      { version: 2 },
      { mapName: null },
      { definitions: { 65536: workspace.definitions[0] } },
      { definitions: { 65535: workspace.definitions[10] } },
      { startAddress: 65535, registerCount: 2 },
      { definitions: { 0: { format: 'float32', words: 1 } } }
    ])
      expect(() => parseModbusWorkspace(JSON.stringify({ ...workspace, ...patch }))).toThrow()
    expect(() => parseModbusWorkspace('{')).toThrow()
    expect(() => parseModbusWorkspace('null')).toThrow()
  })

  test('migrates legacy local data and preserves definitions outside the visible range', () => {
    const legacy = {
      version: workspace.version,
      mapName: workspace.mapName,
      definitions: workspace.definitions
    }
    expect(parseModbusWorkspace(JSON.stringify(legacy))).toEqual(workspace)
    const custom = {
      ...workspace,
      startAddress: 259,
      registerCount: 2,
      definitions: { ...workspace.definitions, 259: workspace.definitions[10] }
    }
    expect(parseModbusWorkspace(JSON.stringify(custom))).toEqual(custom)
  })
})

describe('Modbus register range and map compatibility', () => {
  test('accepts decimal and hexadecimal addresses with inclusive protocol boundaries', () => {
    for (const start of ['259', '0x103', ' 0X0103 ', 259])
      expect(parseModbusRange(start, '3')).toEqual({ startAddress: 259, registerCount: 3 })
    expect(parseModbusRange('0xffff', 1)).toEqual({ startAddress: 65535, registerCount: 1 })
    expect(parseModbusRange(65411, 125).registerCount).toBe(125)
    for (const start of ['', '0x', '1e2', '0b11', '-1', '1.5', 65536, null, true])
      expect(() => parseModbusRange(start, 1)).toThrow()
    for (const count of ['', 0, -1, 1.5, 126, null])
      expect(() => parseModbusRange(0, count)).toThrow()
    expect(() => parseModbusRange(65535, 2)).toThrow('范围')
  })

  const legacy = {
    format: 'serialflow-modbus-map',
    version: 1,
    slave: 7,
    scanRate: 250,
    wordOrder: 'abcd',
    registerCount: 50,
    registers: [{ address: 10, alias: '位置', format: 'int32' }]
  }

  test('imports old version 1 maps with or without registerCount', () => {
    for (const registerCount of [50, undefined]) {
      const parsed = parseModbusMap(JSON.stringify({ ...legacy, registerCount }))
      expect(parsed.settings).toEqual({
        ...defaultModbusRange,
        slave: 7,
        scanRate: 250,
        wordOrder: 'abcd'
      })
      expect(parsed.definitions).toEqual({ 10: workspace.definitions[10] })
    }
  })

  test('round trips nonzero ranges and absolute addresses without dropping offscreen definitions', () => {
    const definitions = { ...workspace.definitions, 259: workspace.definitions[10] }
    const settings = {
      startAddress: 259,
      registerCount: 2,
      slave: 7,
      scanRate: 250,
      wordOrder: 'abcd' as const
    }
    const exported = exportModbusMap('custom.json', definitions, settings)
    expect(exported).toMatchObject({
      format: 'serialflow-modbus-map',
      version: 1,
      startAddress: 259,
      registerCount: 2
    })
    expect(parseModbusMap(JSON.stringify(exported))).toEqual({ definitions, settings })
    expect(
      parseModbusMap(
        JSON.stringify({
          ...legacy,
          startAddress: '0x103',
          registerCount: 2,
          registers: [{ address: '0x103', alias: '位置', format: 'int32' }]
        })
      ).definitions
    ).toEqual({ 259: workspace.definitions[10] })
  })

  test('rejects invalid imports before replacing the workspace', () => {
    for (const patch of [
      { version: 2 },
      { startAddress: 'no address' },
      { registerCount: 126 },
      { startAddress: 65535, registerCount: 2 },
      { registers: [null] },
      { registers: [{ address: 65535, format: 'uint32' }] },
      { registers: [{ address: 65536 }] }
    ])
      expect(() => parseModbusMap(JSON.stringify({ ...legacy, ...patch }))).toThrow()
  })
})
