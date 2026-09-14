import { parseQuickCommandsTransfer } from './config-transfer'
import type { CommandGroup, SavedCommand } from './types'

export type QuickCommandImport = {
  source: 'SerialFlow' | 'SSCOM' | 'VOFA+'
  groups: CommandGroup[]
  commands: SavedCommand[]
  notes: string[]
}

export type QuickCommandImportOptions = { mode: 'replace' } | { mode: 'group'; groupName: string }

export function applyQuickCommandImport(
  existing: { groups: CommandGroup[]; commands: SavedCommand[] },
  imported: QuickCommandImport,
  options: QuickCommandImportOptions
): { groups: CommandGroup[]; commands: SavedCommand[] } {
  if (options.mode === 'replace') return { groups: imported.groups, commands: imported.commands }
  const name = options.groupName.trim()
  if (!name) throw new Error('请输入导入组名称')
  // Remap every imported ID, including companion references, so repeated imports are independent.
  const used = new Set(
    [...existing.groups, ...existing.commands, ...imported.groups, ...imported.commands].map(
      (item) => item.id
    )
  )
  for (const command of [...existing.commands, ...imported.commands]) {
    const reference = command.companion?.commandId
    if (reference !== null && reference !== undefined) used.add(reference)
  }
  let nextId = 1
  const allocate = (): number => {
    while (used.has(nextId)) nextId++
    used.add(nextId)
    return nextId++
  }
  const wrapperId = allocate()
  const groupIds = new Map(imported.groups.map((group) => [group.id, allocate()]))
  const commandIds = new Map(imported.commands.map((command) => [command.id, allocate()]))
  const parent = (id: number | null): number => {
    if (id === null) return wrapperId
    const mapped = groupIds.get(id)
    if (mapped === undefined) throw new Error('导入指令引用了不存在的分组')
    return mapped
  }
  return {
    groups: [
      ...existing.groups,
      {
        id: wrapperId,
        parentId: null,
        name,
        autoLoop: false,
        loopDelay: 100,
        loopCount: 0,
        globals: {}
      },
      ...imported.groups.map((group) => ({
        ...group,
        id: groupIds.get(group.id)!,
        parentId: parent(group.parentId)
      }))
    ],
    commands: [
      ...existing.commands,
      ...imported.commands.map((command) => ({
        ...command,
        id: commandIds.get(command.id)!,
        parentId: parent(command.parentId),
        companion: command.companion
          ? {
              ...command.companion,
              commandId:
                command.companion.commandId === null
                  ? null
                  : (commandIds.get(command.companion.commandId) ?? null)
            }
          : undefined
      }))
    ]
  }
}

function command(id: number, name: string, template: string, hex: boolean): SavedCommand {
  return {
    id,
    parentId: null,
    name,
    template,
    hex,
    targetPort: '',
    autoSend: false,
    autoSendInterval: 1000,
    autoSendCount: 0,
    crcMode: null,
    parameters: []
  }
}

function hexText(value: string, label: string): string {
  const compact = value.replace(/\s/g, '')
  if (!/^(?:[\da-f]{2})*$/i.test(compact)) throw new Error(`${label}包含无效 HEX 数据`)
  return compact.toUpperCase().match(/../g)?.join(' ') || ''
}

function parseSscom(content: string): QuickCommandImport {
  const entries = new Map<number, string>()
  for (const line of content.split(/\r\n|\n|\r/)) {
    const match = /^\s*N(\d+)=(.*)$/i.exec(line)
    if (!match) continue
    const id = Number(match[1])
    if (entries.has(id)) throw new Error(`SSCOM 配置中 N${id} 重复`)
    entries.set(id, match[2])
  }
  const commands: SavedCommand[] = []
  for (const [id, value] of [...entries].sort(([a], [b]) => a - b)) {
    // N101…N199 are labels; later keys and old N33…N85 are application settings.
    if (id < 1 || id > 99) continue
    const match = /^([AH]),(.*)$/i.exec(value)
    if (!match) continue
    const hex = match[1].toUpperCase() === 'H'
    const template = hex ? hexText(match[2], `SSCOM 第 ${id} 条指令`) : match[2]
    if (!template) continue
    const metadata = entries.get(id + 100) || ''
    const modern = /^\d+,(.*),(\d+)$/.exec(metadata)
    const name = (modern ? modern[1] : metadata.replace(/^[^,]*,/, '')).trim()
    const item = command(id, name || `SSCOM 指令 ${id}`, template, hex)
    const delay = Number(modern?.[2] || entries.get(38)?.replace(/^,/, ''))
    if (Number.isSafeInteger(delay) && delay > 0 && delay <= 2147483647)
      item.autoSendInterval = delay
    commands.push(item)
  }
  if (!commands.length) throw new Error('SSCOM 配置中没有可导入的非空快捷指令')
  return {
    source: 'SSCOM',
    groups: [],
    commands,
    notes: [
      '仅导入多条发送列表的名称、内容、编码和间隔；自动换行、校验及循环勾选状态需在导入后重新设置。'
    ]
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('VOFA+ 命令节点格式不正确')
  return value as Record<string, unknown>
}

function interval(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647
    ? value
    : 1000
}

function parseVofa(root: Record<string, unknown>): QuickCommandImport {
  if (root.type !== 'cmds')
    throw new Error('请选择 VOFA+ 命令或命令组导出的 JSON 文件（非控件布局文件）')
  const result: QuickCommandImport = {
    source: 'VOFA+',
    groups: [],
    commands: [],
    notes: [
      '保留命令分组和发送间隔；循环发送需重新启用，控件绑定及按下／抬起参数不在命令组文件中。'
    ]
  }
  let nextId = 1
  let hasParameters = false
  const visit = (value: unknown, parentId: number | null, depth: number): void => {
    if (depth > 64 || nextId > 10000) throw new Error('VOFA+ 命令数量或分组层级过多')
    const node = object(value)
    if (typeof node.is_group !== 'boolean' || typeof node.name !== 'string')
      throw new Error('VOFA+ 命令缺少名称或分组标记')
    const id = nextId++
    const name = node.name.trim() || `VOFA+ ${id}`
    if (node.is_group) {
      if (!Array.isArray(node.subCmds)) throw new Error(`VOFA+ 分组“${name}”缺少命令列表`)
      result.groups.push({
        id,
        parentId,
        name,
        autoLoop: false,
        loopDelay: interval(node.loop_ms),
        loopCount: 0,
        globals: {}
      })
      for (const child of node.subCmds) visit(child, id, depth + 1)
      return
    }
    if (typeof node.hex_on !== 'boolean' || typeof node.cmd_hex !== 'string')
      throw new Error(`VOFA+ 指令“${name}”缺少内容或编码模式`)
    const item = command(id, name, '', node.hex_on)
    item.parentId = parentId
    item.autoSendInterval = interval(node.loop_ms)
    const parameter = (byteLength: number): string => {
      if (byteLength > 64) throw new Error(`VOFA+ 指令“${name}”的参数超过 64 字节`)
      const id = `p${item.parameters.length + 1}`
      item.parameters.push({ id, value: '', inputMode: item.hex ? 'hex' : 'ascii', byteLength })
      hasParameters = true
      return `{{${id}}}`
    }
    if (item.hex) {
      // A run of %% markers is a byte array supplied by the bound VOFA+ control.
      const parts = node.cmd_hex.split(/((?:%%\s*)+)/)
      item.template = parts
        .map((part, index) =>
          index % 2 ? parameter((part.match(/%%/g) || []).length) : hexText(part, name)
        )
        .filter(Boolean)
        .join(' ')
    } else {
      const encoded = hexText(node.cmd_hex, name).replace(/ /g, '')
      const bytes = Uint8Array.from(encoded.match(/../g) || [], (byte) => parseInt(byte, 16))
      let decoded: string
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new Error(`VOFA+ 指令“${name}”的文本不是有效的 UTF-8`)
      }
      item.template = decoded.replace(/%%|%[-+ #0]*\d*(?:\.\d+)?[diuoxXfFeEgGcs]/g, (token) =>
        token === '%%' ? '%' : parameter(1)
      )
    }
    if (item.template) result.commands.push(item)
  }
  visit(root.ctx, null, 0)
  if (!result.commands.length) throw new Error('VOFA+ 文件中没有可导入的非空快捷指令')
  if (hasParameters)
    result.notes.push(
      '参数占位符已转换为可填写参数；发送前请填写完整。文本参数需填写最终文本（包括所需精度和补零）。'
    )
  return result
}

export function parseQuickCommandImport(content: string): QuickCommandImport {
  const clean = content.replace(/^\uFEFF/, '')
  if (/^\s*N\d+=[AH],/im.test(clean)) return parseSscom(clean)
  let root: Record<string, unknown>
  try {
    root = object(JSON.parse(clean))
  } catch {
    throw new Error('无法识别配置：请选择 SerialFlow JSON、SSCOM INI 或 VOFA+ 命令组 JSON')
  }
  if (root.format === 'serialflow-quick-commands')
    return { source: 'SerialFlow', ...parseQuickCommandsTransfer(clean), notes: [] }
  return parseVofa(root)
}
