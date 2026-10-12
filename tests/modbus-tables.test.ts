import { describe, expect, test } from 'bun:test'
import {
  parseModbusTablesWorkspace,
  parseModbusTableCollection,
  exportModbusTableCollection,
  updateModbusTableValues,
  type ModbusTable,
  type ModbusTablesWorkspace
} from '../src/renderer/src/modbus-workspace'
import { captureModbusTablesPreset, encodeModbusCommand } from '../src/renderer/src/modbus-presets'

const tables: ModbusTable[] = [
  {
    id: 'control',
    name: '控制',
    mapName: 'control.json',
    startAddress: 259,
    registerCount: 2,
    definitions: {
      259: { alias: '位置', format: 'uint32', words: 2 },
      10: { alias: '保留定义', format: 'uint16', words: 1 }
    }
  },
  {
    id: 'status',
    name: '状态',
    mapName: 'status.json',
    startAddress: 768,
    registerCount: 3,
    definitions: { 768: { alias: '状态位', format: 'hex16', words: 1 } }
  }
]
const workspace: ModbusTablesWorkspace = { version: 2, activeTableId: 'status', tables }

describe('Modbus multiple tables', () => {
  test('migrates old storage into one table without dropping nonzero or offscreen mappings', () => {
    for (const range of [{}, { startAddress: 259, registerCount: 2 }]) {
      const restored = parseModbusTablesWorkspace(
        JSON.stringify({
          version: 1,
          mapName: 'old.json',
          definitions: tables[0].definitions,
          ...range
        })
      )
      expect(restored.version).toBe(2)
      expect(restored.tables).toHaveLength(1)
      expect(restored.tables[0]).toMatchObject({
        id: restored.activeTableId,
        mapName: 'old.json',
        definitions: tables[0].definitions,
        startAddress: 'startAddress' in range ? 259 : 0,
        registerCount: 'registerCount' in range ? 2 : 50
      })
    }
  })

  test('persists independent names/ranges/definitions and selection without live data', () => {
    const restored = parseModbusTablesWorkspace(
      JSON.stringify({
        ...workspace,
        values: { control: [1, 2] },
        tables: tables.map((table) => ({ ...table, values: [1] }))
      })
    )
    expect(restored).toEqual(workspace)
    restored.tables[0].definitions[259].alias = '修改控制'
    expect(restored.tables[1].definitions[768].alias).toBe('状态位')
  })

  test('round trips a version 2 collection including communication settings and active table', () => {
    const settings = { slave: 7, wordOrder: 'abcd' as const, scanRate: 250 }
    const exported = exportModbusTableCollection(tables, 'status', settings)
    expect(exported).toMatchObject({ version: 2, format: 'serialflow-modbus-map' })
    expect(parseModbusTableCollection(JSON.stringify(exported))).toEqual({ workspace, settings })
    const withoutSelection = { ...exported, activeTableId: undefined }
    expect(
      parseModbusTableCollection(JSON.stringify(withoutSelection)).workspace.activeTableId
    ).toBe('control')
  })

  test('rejects malformed multi-table data atomically', () => {
    for (const patch of [
      { version: 3 },
      { tables: [] },
      { tables: [null] },
      { activeTableId: 'missing' },
      { tables: [tables[0], tables[0]] },
      { tables: [{ ...tables[0], name: '' }] },
      { tables: [{ ...tables[0], id: '__proto__' }] },
      { tables: [{ ...tables[0], startAddress: 65535, registerCount: 2 }] }
    ])
      expect(() => parseModbusTablesWorkspace(JSON.stringify({ ...workspace, ...patch }))).toThrow()
    const exported = exportModbusTableCollection(tables, 'status', {
      slave: 1,
      wordOrder: 'abcd',
      scanRate: 1000
    })
    for (const patch of [
      { tables: [] },
      { tables: [null] },
      { activeTableId: 'missing' },
      {
        tables: [{ id: 'bad', name: '坏表', startAddress: 65535, registerCount: 2, registers: [] }]
      }
    ])
      expect(() => parseModbusTableCollection(JSON.stringify({ ...exported, ...patch }))).toThrow()
  })

  test('updates only matching addresses and synchronizes overlapping tables without filling unread words', () => {
    const overlap = { ...tables[1], id: 'overlap', startAddress: 260, registerCount: 3 }
    const previous = { status: [42, 43, 44] }
    const next = updateModbusTableValues([...tables, overlap], previous, 259, [0x1234, 0x5678])
    expect(next.control).toEqual([0x1234, 0x5678])
    expect(next.status).toBe(previous.status)
    expect(next.overlap).toEqual([0x5678, undefined, undefined])
    expect(previous).toEqual({ status: [42, 43, 44] })
    expect(updateModbusTableValues(tables, next, 768, [9]).status).toEqual([9, 43, 44])
  })

  test('captures all loaded tables as named groups using absolute addresses', () => {
    const preset = captureModbusTablesPreset(
      tables,
      { control: [0x1234, 0x5678], status: [42, undefined, undefined] },
      7,
      'abcd',
      '多表'
    )
    expect(preset.groups.map((group) => group.name)).toEqual(['控制', '状态'])
    expect(
      preset.groups.flatMap((group) => group.commands.map((command) => command.address))
    ).toEqual(['259', '768'])
    expect([
      ...encodeModbusCommand(preset.groups[0].commands[0], 7, 'abcd').request.slice(0, -2)
    ]).toEqual([7, 16, 1, 3, 0, 2, 4, 0x12, 0x34, 0x56, 0x78])
    expect(
      captureModbusTablesPreset(tables, { status: [42] }, 7, 'abcd', '部分数据').groups
    ).toHaveLength(1)
    expect(() =>
      captureModbusTablesPreset(tables, { control: [1], status: [42] }, 7, 'abcd', '不完整')
    ).toThrow('控制')
    expect(() => captureModbusTablesPreset(tables, {}, 7, 'abcd', '无数据')).toThrow('暂无有效')
  })
})
