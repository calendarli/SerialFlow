import { describe, expect, test } from 'bun:test'
import { parseModbusWorkspace, type ModbusWorkspace } from '../src/renderer/src/modbus-workspace'

const workspace: ModbusWorkspace = {
  version: 1,
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
      { definitions: { 50: workspace.definitions[0] } },
      { definitions: { 0: { format: 'float32', words: 1 } } }
    ])
      expect(() => parseModbusWorkspace(JSON.stringify({ ...workspace, ...patch }))).toThrow()
    expect(() => parseModbusWorkspace('{')).toThrow()
    expect(() => parseModbusWorkspace('null')).toThrow()
  })
})
