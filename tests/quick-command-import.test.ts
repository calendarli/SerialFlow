import { describe, expect, test } from 'bun:test'
import { decodeConfigText } from '../src/common/config-text'
import {
  applyQuickCommandImport,
  parseQuickCommandImport
} from '../src/renderer/src/quick-command-import'
import { createQuickCommandsTransfer } from '../src/renderer/src/config-transfer'

const vofaCommand = (patch = {}) => ({
  name: '查询',
  is_group: false,
  hex_on: true,
  cmd_hex: 'AA 01 FF',
  loop_on: true,
  loop_ms: 250,
  loop_count: 1,
  subCmds: [],
  ...patch
})
const vofa = (ctx: unknown) => JSON.stringify({ type: 'cmds', vnumber: 100, ctx })

describe('import destinations', () => {
  const empty = { groups: [], commands: [] }
  test('new group keeps existing data and wraps both root commands and nested groups', () => {
    const existing = parseQuickCommandImport('N1=A,existing')
    const imported = parseQuickCommandImport(
      vofa({
        name: 'VOFA',
        is_group: true,
        subCmds: [vofaCommand(), { name: 'nested', is_group: true, subCmds: [vofaCommand()] }]
      })
    )
    const rootCommand = { ...imported.commands[0], id: 100, parentId: null }
    imported.commands.push(rootCommand)
    const before = JSON.stringify({ existing, imported })
    const result = applyQuickCommandImport(existing, imported, {
      mode: 'group',
      groupName: ' 新组 '
    })
    expect(result.commands[0]).toBe(existing.commands[0])
    const wrapper = result.groups[0]
    expect(wrapper).toMatchObject({ name: '新组', parentId: null, autoLoop: false })
    expect(result.groups[1].parentId).toBe(wrapper.id)
    expect(result.groups[2].parentId).toBe(result.groups[1].id)
    expect(result.commands[1].parentId).toBe(result.groups[1].id)
    expect(result.commands[2].parentId).toBe(result.groups[2].id)
    expect(result.commands[3].parentId).toBe(wrapper.id)
    expect(new Set([...result.groups, ...result.commands].map((item) => item.id)).size).toBe(7)
    expect(JSON.stringify({ existing, imported })).toBe(before)
  })
  test('repeat imports remap companion references within each new group', () => {
    const imported = parseQuickCommandImport('N1=A,main\nN2=A,attached')
    imported.commands[0].companion = {
      enabled: true,
      source: 'command',
      commandId: 2,
      template: '',
      loop: true,
      interval: 200
    }
    const first = applyQuickCommandImport(empty, imported, { mode: 'group', groupName: 'first' })
    const second = applyQuickCommandImport(first, imported, { mode: 'group', groupName: 'second' })
    expect(second.commands[0].companion?.commandId).toBe(second.commands[1].id)
    expect(second.commands[2].companion?.commandId).toBe(second.commands[3].id)
    expect(second.commands[2].companion?.commandId).not.toBe(second.commands[1].id)
    expect(second.commands[2].parentId).toBe(second.groups[1].id)
    expect(new Set([...second.groups, ...second.commands].map((item) => item.id)).size).toBe(6)
  })
  test('dangling references cannot bind to existing or newly imported commands', () => {
    const existing = parseQuickCommandImport('N1=A,existing')
    existing.commands[0].companion = {
      enabled: true,
      source: 'command',
      commandId: 3,
      template: '',
      loop: false,
      interval: 200
    }
    const imported = parseQuickCommandImport('N2=A,imported')
    imported.commands[0].companion = { ...existing.commands[0].companion, commandId: 1 }
    const result = applyQuickCommandImport(existing, imported, { mode: 'group', groupName: 'new' })
    expect(result.commands[1].companion?.commandId).toBeNull()
    expect(result.commands.some((command) => command.id === 3)).toBe(false)
    expect(result.commands[0].companion?.commandId).toBe(3)
  })
  test('replacement removes all existing entries without adding a wrapper', () => {
    const imported = parseQuickCommandImport('N1=A,new')
    const existing = applyQuickCommandImport(empty, parseQuickCommandImport('N2=A,old'), {
      mode: 'group',
      groupName: 'old'
    })
    expect(applyQuickCommandImport(existing, imported, { mode: 'replace' })).toEqual({
      groups: [],
      commands: imported.commands
    })
  })
  test('new groups require a nonblank name', () => {
    expect(() =>
      applyQuickCommandImport(empty, parseQuickCommandImport('N1=A,x'), {
        mode: 'group',
        groupName: '  '
      })
    ).toThrow('组名称')
  })
})

describe('SSCOM imports', () => {
  test('old INI retains commas, spaces, order and ignores application settings', () => {
    const result = parseQuickCommandImport(
      '; SSCOM\r\nN102=,复位\r\nN2=H,41540d0a\r\nN101=,查询\r\nN1=A, AT+X=1,2 \r\nN33=,ignore\r\nN35=,A\r\nN38=,2000'
    )
    expect(result.source).toBe('SSCOM')
    expect(result.commands.map((c) => c.template)).toEqual([' AT+X=1,2 ', '41 54 0D 0A'])
    expect(result.commands[0]).toMatchObject({
      name: '查询',
      targetPort: '',
      autoSend: false,
      autoSendInterval: 2000
    })
  })
  test('modern INI supports 99 commands, labels containing commas and skips empty entries', () => {
    const result = parseQuickCommandImport(
      'N101=3,设置,速度,500\nN1=A,SPEED=1\nN2=A,\nN199=1,末项,1200\nN99=H,FF00\nN1053=,ignore'
    )
    expect(result.commands).toHaveLength(2)
    expect(result.commands[0]).toMatchObject({ name: '设置,速度', autoSendInterval: 500 })
    expect(result.commands[1]).toMatchObject({ name: '末项', template: 'FF 00' })
  })
  test('rejects malformed HEX, duplicates and empty lists', () => {
    expect(() => parseQuickCommandImport('N1=H,ABC')).toThrow('HEX')
    expect(() => parseQuickCommandImport('N1=A,a\nN1=A,b')).toThrow('重复')
    expect(() => parseQuickCommandImport('N1=A,')).toThrow('非空')
  })
})

describe('VOFA+ imports', () => {
  test('preserves nested groups, repeated names and converts byte array parameters', () => {
    const result = parseQuickCommandImport(
      vofa({
        name: '组',
        is_group: true,
        subCmds: [
          vofaCommand({ cmd_hex: 'AA %% %% %% %% FF' }),
          { name: '子组', is_group: true, subCmds: [vofaCommand()] }
        ]
      })
    )
    expect(result.groups).toHaveLength(2)
    expect(result.groups[1].parentId).toBe(result.groups[0].id)
    expect(result.commands[1].parentId).toBe(result.groups[1].id)
    expect(result.commands[0]).toMatchObject({
      template: 'AA {{p1}} FF',
      targetPort: '',
      autoSend: false,
      autoSendInterval: 250
    })
    expect(result.commands[0].parameters).toEqual([
      { id: 'p1', value: '', inputMode: 'hex', byteLength: 4 }
    ])
    expect(result.notes.some((n) => n.includes('参数占位符'))).toBe(true)
  })
  test('decodes UTF-8 string commands from cmd_hex and converts printf parameters', () => {
    const cmd_hex = Buffer.from('速度=%.2f,%d,100%%\r\n').toString('hex')
    const result = parseQuickCommandImport(vofa(vofaCommand({ hex_on: false, cmd_hex })))
    expect(result.commands[0].template).toBe('速度={{p1}},{{p2}},100%\r\n')
    expect(result.commands[0].parameters.map((p) => p.inputMode)).toEqual(['ascii', 'ascii'])
  })
  test('rejects wrong file types, broken nodes and malformed byte content', () => {
    expect(() => parseQuickCommandImport('{"type":"tabview"}')).toThrow('命令组')
    expect(() => parseQuickCommandImport(vofa({ name: 'broken' }))).toThrow('标记')
    expect(() => parseQuickCommandImport(vofa(vofaCommand({ cmd_hex: 'GG' })))).toThrow('HEX')
    expect(() =>
      parseQuickCommandImport(vofa(vofaCommand({ hex_on: false, cmd_hex: 'FF' })))
    ).toThrow('UTF-8')
  })
  test('rejects excessive nesting without overflowing the stack', () => {
    let ctx: unknown = vofaCommand()
    for (let i = 0; i < 66; i++) ctx = { name: 'group', is_group: true, subCmds: [ctx] }
    expect(() => parseQuickCommandImport(vofa(ctx))).toThrow('层级')
  })
})

test('SerialFlow round trip retains fixed ports and remains strict about versions', () => {
  const command = parseQuickCommandImport('N1=A,test').commands[0]
  command.targetPort = 'COM3'
  const transfer = createQuickCommandsTransfer([], [command])
  expect(parseQuickCommandImport('\uFEFF' + JSON.stringify(transfer))).toMatchObject({
    source: 'SerialFlow',
    commands: [command]
  })
  expect(() => parseQuickCommandImport(JSON.stringify({ ...transfer, version: 2 }))).toThrow(
    '不是受支持'
  )
  expect(() => parseQuickCommandImport('invalid')).toThrow('无法识别')
})

test('configuration decoding handles UTF-8, GBK and UTF-16 BOMs without silent replacement', () => {
  expect(decodeConfigText(new TextEncoder().encode('\uFEFF中文'))).toBe('中文')
  const gbk = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4])
  expect(decodeConfigText(gbk, true)).toBe('中文')
  expect(() => decodeConfigText(gbk)).toThrow('UTF-8')
  expect(decodeConfigText(Uint8Array.from([0xff, 0xfe, 0x2d, 0x4e]))).toBe('中')
  expect(decodeConfigText(Uint8Array.from([0xfe, 0xff, 0x4e, 0x2d]))).toBe('中')
})
