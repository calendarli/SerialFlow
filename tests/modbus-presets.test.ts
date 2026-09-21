import { describe, expect, test } from 'bun:test'
import {
  encodeModbusCommand,
  captureModbusPreset,
  moveItem,
  parseModbusPresets,
  runModbusCommands,
  saveModbusCommand,
  type ModbusCommand
} from '../src/renderer/src/modbus-presets'
import { ModbusClient } from '../src/renderer/src/modbus-client'
import { appendCrc } from '../src/renderer/src/serial-utils'

const command: ModbusCommand = {
  id: 'c',
  name: '速度',
  address: '0x100',
  value: '0x12345678',
  format: 'uint32'
}
describe('Modbus device presets', () => {
  test('captures exact typed homepage values and preserves 32-bit words in both orders', () => {
    for (const order of ['abcd', 'cdab'] as const) {
      for (const [format, value] of [
        ['float32', '-0'],
        ['float32', '1.23456789'],
        ['int32', '-2147483648'],
        ['uint32', '4294967295']
      ] as const) {
        const original = encodeModbusCommand({ ...command, address: '1', format, value }, 7, order)
        const snapshot = captureModbusPreset(
          [0, ...original.words, undefined],
          { 1: { alias: '参数', format, words: 2 } },
          7,
          order,
          '设备'
        )
        const captured = snapshot.groups[0].commands
        expect(captured).toHaveLength(2)
        expect(captured[0].value).toBe('0')
        expect(captured[1].name).toBe('参数')
        expect(encodeModbusCommand(captured[1], snapshot.slave, snapshot.wordOrder).words).toEqual(
          original.words
        )
      }
    }
  })
  test('does not create snapshots from missing data or incomplete/non-finite wide registers', () => {
    expect(() => captureModbusPreset([undefined], {}, 1, 'abcd', '设备')).toThrow('暂无有效')
    const definitions = { 0: { format: 'float32' as const, words: 2 as const } }
    expect(() => captureModbusPreset([1, undefined], definitions, 1, 'abcd', '设备')).toThrow(
      '不完整'
    )
    expect(() => captureModbusPreset([undefined, 1], definitions, 1, 'abcd', '设备')).toThrow(
      '不完整'
    )
    expect(() => captureModbusPreset([0x7fc0, 0], definitions, 1, 'abcd', '设备')).toThrow()
  })
  test('blank-area creation uses an ungrouped group and edits can move commands without duplicates', () => {
    const first = saveModbusCommand([], '', command)
    expect(first[0].name).toBe('未分组')
    const second = saveModbusCommand(first, '', { ...command, id: 'second' })
    expect(second).toHaveLength(1)
    expect(second[0].commands).toHaveLength(2)
    const moved = saveModbusCommand(
      [...second, { id: 'motion', name: '运动', commands: [] }],
      'motion',
      { ...command, value: '42' }
    )
    expect(moved[0].commands.map((item) => item.id)).toEqual(['second'])
    expect(moved[1].commands[0].value).toBe('42')
  })
  test('encodes H06 / H10 with explicit slave, address and word order', () => {
    expect([...encodeModbusCommand(command, 7, 'abcd').request.slice(0, -2)]).toEqual([
      7, 16, 1, 0, 0, 2, 4, 0x12, 0x34, 0x56, 0x78
    ])
    expect(encodeModbusCommand(command, 7, 'cdab').words).toEqual([0x5678, 0x1234])
    expect([
      ...encodeModbusCommand(
        { ...command, format: 'hex16', value: '0x1234' },
        1,
        'abcd'
      ).request.slice(0, -2)
    ]).toEqual([1, 6, 1, 0, 0x12, 0x34])
    expect(
      encodeModbusCommand({ ...command, format: 'float32', value: '-1.5' }, 1, 'abcd').words
    ).toEqual([0xbfc0, 0])
    expect(
      encodeModbusCommand({ ...command, format: 'int32', value: '-2147483648' }, 1, 'abcd').words
    ).toEqual([0x8000, 0])
  })
  test('rejects invalid values and register overflow before writing', () => {
    for (const changes of [
      { value: '' },
      { value: '4294967296' },
      { value: '-1' },
      { value: '1.5' },
      { address: '' },
      { address: '65535' },
      { address: '-1' },
      { value: '1e40', format: 'float32' as const }
    ]) {
      expect(() => encodeModbusCommand({ ...command, ...changes }, 1, 'abcd')).toThrow()
    }
    expect(() => encodeModbusCommand(command, 0, 'abcd')).toThrow()
  })
  test('preserves saved groups and order, rejects corrupt data', () => {
    const data = [
      {
        id: 'p',
        name: '设备',
        slave: 1,
        wordOrder: 'abcd' as const,
        groups: [{ id: 'g', name: '启动', commands: [command] }]
      }
    ]
    expect(parseModbusPresets(JSON.stringify(data))).toEqual(data)
    expect(() => parseModbusPresets('[null]')).toThrow()
    expect(() => parseModbusPresets(JSON.stringify([{ ...data[0], slave: 0 }]))).toThrow()
    expect(
      moveItem([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'a', 'c').map((item) => item.id)
    ).toEqual(['b', 'c', 'a'])
  })
  test('waits for matching acknowledgments and stops on a device exception', async () => {
    const client = new ModbusClient()
    const sent: string[] = []
    const completed: number[] = []
    await expect(
      runModbusCommands(
        [command, { ...command, id: 'd' }, { ...command, id: 'e' }],
        async (item) => {
          const { request } = encodeModbusCommand(item, 1, 'abcd')
          await client.request(request, async () => {
            sent.push(item.id)
            queueMicrotask(() =>
              client.push(
                appendCrc(
                  sent.length === 1 ? request.slice(0, 6) : new Uint8Array([1, 0x90, 2]),
                  'modbus'
                )
              )
            )
            return true
          })
        },
        () => false,
        (count) => completed.push(count)
      )
    ).rejects.toThrow('exception')
    expect(sent).toEqual(['c', 'd'])
    expect(completed).toEqual([1])
  })
  test('cancellation prevents remaining writes', async () => {
    let stop = false
    const sent: string[] = []
    await expect(
      runModbusCommands(
        [command, { ...command, id: 'd' }],
        async (item) => {
          sent.push(item.id)
          stop = true
        },
        () => stop,
        () => {}
      )
    ).rejects.toThrow('停止')
    expect(sent).toEqual(['c'])
  })
})
