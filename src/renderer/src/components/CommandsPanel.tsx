import { useListReorder } from './useListReorder'
import { ProgramCodeEditor } from './ProgramCodeEditor'
import { memo, useEffect, useRef, useState } from 'react'
import { bytesToHex, convertSerialText } from '../serial-utils'
import type { CommandGroup, CrcMode, SavedCommand, TargetPortOption } from '../types'
import { evaluateGlobalPlaceholders } from '../scripts/group-globals'
import { normalizeCommandExtensions } from '../command-settings'
import { CommandRunner } from '../command-runner'
import {
  parseQuickCommandImport,
  type QuickCommandImport,
  type QuickCommandImportOptions
} from '../quick-command-import'
import { QuickCommandImportDialog } from './QuickCommandImportDialog'
import {
  CommandProgramRuntime,
  defaultCommandProgram,
  type CommandPhase
} from '../scripts/command-program'

type Props = {
  commands: SavedCommand[]
  setCommands: (value: SavedCommand[]) => void
  groups: CommandGroup[]
  setGroups: (value: CommandGroup[]) => void
  connected: boolean
  openedPorts?: readonly string[]
  targetPorts: TargetPortOption[]
  onSend: (
    text: string,
    hex: boolean,
    crcMode?: CrcMode | null,
    targetPort?: string
  ) => Promise<boolean>
  onImport: (imported: QuickCommandImport, options: QuickCommandImportOptions) => boolean
  onExport: () => void
}
type Draft = {
  name: string
  template: string
  releaseTemplate: string
  processingMode: 'template' | 'program'
  processingProgram: string
  companion: NonNullable<SavedCommand['companion']>
  hex: boolean
  autoSend: boolean
  autoSendInterval: number
  autoSendCount: number
  crcEnabled: boolean
  crcMode: CrcMode
  targetPort: string
  parameters: Array<{ id: string; byteLength: number }>
}
type Menu = { x: number; y: number; type: 'root' | 'group' | 'command'; id: number | null }
type DraggedNode = { type: 'group' | 'command'; id: number }
const emptyDraft = (): Draft => ({
  name: '',
  template: '',
  releaseTemplate: '',
  processingMode: 'template',
  processingProgram: defaultCommandProgram,
  companion: {
    enabled: false,
    source: 'command',
    commandId: null,
    template: '',
    loop: true,
    interval: 200
  },
  hex: false,
  autoSend: false,
  autoSendInterval: 1000,
  autoSendCount: 0,
  crcEnabled: false,
  crcMode: 'modbus',
  targetPort: '',
  parameters: []
})

type ParameterMode = SavedCommand['parameters'][number]['inputMode']

function convertNumericParameter(
  value: string,
  inputHex: boolean,
  outputHex: boolean,
  byteLength?: number
): string {
  const clean = value.trim()
  if (!clean) return ''
  if (inputHex ? !/^[0-9a-f]+$/i.test(clean) : !/^\d+$/.test(clean)) {
    throw new Error(inputHex ? 'HEX 参数只能包含 0-9、A-F' : 'DEC 参数只能输入十进制数字 0-9')
  }
  const numericValue = BigInt(inputHex ? `0x${clean}` : clean)
  if (byteLength) {
    const maximum = (1n << BigInt(byteLength * 8)) - 1n
    if (numericValue > maximum) {
      throw new Error(
        `${byteLength} 字节参数超出范围（HEX 最大 ${maximum
          .toString(16)
          .toUpperCase()
          .padStart(byteLength * 2, '0')}，DEC 最大 ${maximum.toString(10)}）`
      )
    }
  }
  const converted = numericValue.toString(outputHex ? 16 : 10).toUpperCase()
  if (!outputHex) return converted
  return converted.padStart(
    byteLength ? byteLength * 2 : converted.length + (converted.length % 2),
    '0'
  )
}

function convertParameterForCommand(
  value: string,
  mode: ParameterMode,
  outputHex: boolean,
  byteLength: number
): string {
  if (!value) return ''
  if (mode === 'ascii') return outputHex ? bytesToHex(new TextEncoder().encode(value)) : value
  return convertNumericParameter(value, mode === 'hex', outputHex, byteLength)
}

function convertParameterMode(value: string, from: ParameterMode, to: ParameterMode): string {
  if (!value || from === to) return value
  if (from === 'ascii' && to === 'hex') return convertSerialText(value, true).replace(/\s+/g, '')
  if (from === 'hex' && to === 'ascii') return convertSerialText(value, false)
  if (from === 'ascii' && to === 'dec') return convertNumericParameter(value, false, false)
  if (from === 'dec' && to === 'ascii') return value
  return convertNumericParameter(value, from === 'hex', to === 'hex')
}

function numericParameterFits(value: string, mode: ParameterMode, byteLength: number): boolean {
  if (!value || mode === 'ascii') return true
  if (mode === 'hex' ? !/^[0-9a-f]+$/i.test(value) : !/^\d+$/.test(value)) return false
  const numericValue = BigInt(mode === 'hex' ? `0x${value}` : value)
  return numericValue <= (1n << BigInt(byteLength * 8)) - 1n
}

function numericParameterPlaceholder(mode: ParameterMode, byteLength: number): string {
  if (mode === 'ascii') return 'ASCII 文本'
  const maximum = (1n << BigInt(byteLength * 8)) - 1n
  if (mode === 'dec') return `DEC 0-${maximum.toString(10)}`
  const hexMaximum = maximum
    .toString(16)
    .toUpperCase()
    .padStart(byteLength * 2, '0')
  return byteLength <= 4
    ? `HEX ${'0'.repeat(byteLength * 2)}-${hexMaximum}`
    : `HEX 最多 ${byteLength * 2} 位`
}

function buildCommand(
  command: SavedCommand,
  template = command.template,
  globals: Record<string, unknown> = {}
): string {
  const result = command.parameters.reduce((current, parameter) => {
    const value = convertParameterForCommand(
      parameter.value,
      parameter.inputMode,
      command.hex,
      parameter.byteLength
    )
    return current.replaceAll(`{{${parameter.id}}}`, value)
  }, template)
  const withGlobals = evaluateGlobalPlaceholders(result, globals, command.hex)
  return command.hex ? withGlobals : withGlobals.replace(/\\r/g, '\r').replace(/\\n/g, '\n')
}

export const CommandsPanel = memo(function CommandsPanel(props: Props): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [pendingImport, setPendingImport] = useState<{
    imported: QuickCommandImport
    groupName: string
  } | null>(null)
  const [importLoading, setImportLoading] = useState(false)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [targetParentId, setTargetParentId] = useState<number | null>(null)
  const [editingCommandId, setEditingCommandId] = useState<number | null>(null)
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null)
  const [groupName, setGroupName] = useState('')
  const [groupTargetPort, setGroupTargetPort] = useState('')
  const [groupAutoLoop, setGroupAutoLoop] = useState(false)
  const [groupLoopDelay, setGroupLoopDelay] = useState(100)
  const [groupLoopCount, setGroupLoopCount] = useState(0)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [error, setError] = useState('')
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [draggedNode, setDraggedNode] = useState<DraggedNode | null>(null)
  const [dropTargetId, setDropTargetId] = useState<number | null | undefined>(undefined)
  const [activeAutoSendIds, setActiveAutoSendIds] = useState<Set<number>>(new Set())
  const [activeGroupLoopIds, setActiveGroupLoopIds] = useState<Set<number>>(new Set())
  const [activeHoldIds, setActiveHoldIds] = useState<Set<number>>(new Set())
  const propsRef = useRef(props)
  const lifecycleRef = useRef(0)
  const sendPreparedRef = useRef<
    (command: SavedCommand, phase: CommandPhase, current: () => boolean) => Promise<boolean>
  >(async () => false)
  const [programRuntime] = useState(() => new CommandProgramRuntime())
  const [runner] = useState(
    () =>
      new CommandRunner({
        getCommand: (id) => propsRef.current.commands.find((command) => command.id === id),
        send: (command, phase, current) => sendPreparedRef.current(command, phase, current),
        onChange: (auto, held) => {
          setActiveAutoSendIds(auto)
          setActiveHoldIds(held)
        },
        onError: (cause) => setError(cause instanceof Error ? cause.message : String(cause))
      })
  )
  const groupLoopTokensRef = useRef(new Map<number, number>())

  const groupGlobalsRef = useRef(
    new Map(props.groups.map((group) => [group.id, { ...group.globals }]))
  )

  useEffect(() => {
    for (const group of props.groups) groupGlobalsRef.current.set(group.id, { ...group.globals })
    for (const id of groupGlobalsRef.current.keys())
      if (!props.groups.some((group) => group.id === id)) groupGlobalsRef.current.delete(id)
  }, [props.groups])

  const buildGroupedCommand = (command: SavedCommand, template = command.template): string => {
    const group = props.groups.find((item) => item.id === command.parentId)
    if (!group) return buildCommand(command, template)
    const globals = { ...(groupGlobalsRef.current.get(group.id) || group.globals) }
    const result = buildCommand(command, template, globals)
    if (JSON.stringify(globals) !== JSON.stringify(groupGlobalsRef.current.get(group.id))) {
      groupGlobalsRef.current.set(group.id, globals)
      props.setGroups(
        props.groups.map((item) => (item.id === group.id ? { ...item, globals } : item))
      )
    }
    return result
  }

  const sendPreparedCommand = async (
    command: SavedCommand,
    phase: CommandPhase,
    current: () => boolean
  ): Promise<boolean> => {
    if (!current() || !propsRef.current.connected) return false
    if (
      command.targetPort &&
      propsRef.current.openedPorts &&
      !propsRef.current.openedPorts.includes(command.targetPort)
    )
      throw new Error(`目标串口 ${command.targetPort} 尚未打开`)
    const text = buildGroupedCommand(
      command,
      phase === 'release' ? command.releaseTemplate : command.template
    )
    if (command.processingMode === 'program') {
      const bytes = await programRuntime.run(command, text, phase)
      if (!current() || !propsRef.current.connected) return false
      if (
        command.targetPort &&
        propsRef.current.openedPorts &&
        !propsRef.current.openedPorts.includes(command.targetPort)
      )
        return false
      return propsRef.current.onSend(bytesToHex(bytes), true, command.crcMode, command.targetPort)
    }
    if (!current()) return false
    return propsRef.current.onSend(text, command.hex, command.crcMode, command.targetPort)
  }
  useEffect(() => {
    propsRef.current = props
    sendPreparedRef.current = sendPreparedCommand
  })
  useEffect(() => runner.sync(props.commands), [props.commands, runner])
  useEffect(() => {
    let lastTask = ''
    return window.api.onFirmwareProgress((state) => {
      if (!state.busy || !state.port || state.id === lastTask) return
      lastTask = state.id
      const affected = propsRef.current.commands.filter(
        (command) => !command.targetPort || command.targetPort === state.port
      )
      for (const command of affected) void runner.stop(command.id, false)
      // Invalidate group loops containing an affected command, including ancestors.
      const groups = new Set<number>()
      for (const command of affected) {
        let id = command.parentId
        while (id !== null && !groups.has(id)) {
          groups.add(id)
          id = propsRef.current.groups.find((group) => group.id === id)?.parentId ?? null
        }
      }
      for (const id of groups)
        groupLoopTokensRef.current.set(id, (groupLoopTokensRef.current.get(id) || 0) + 1)
      setActiveGroupLoopIds((current) => new Set([...current].filter((id) => !groups.has(id))))
    })
  }, [runner])
  useEffect(() => {
    if (props.openedPorts) runner.syncPorts(props.openedPorts)
  }, [props.openedPorts, props.commands, runner])
  useEffect(() => {
    if (!props.connected) {
      runner.stopAll(false)
      for (const [id, token] of groupLoopTokensRef.current)
        groupLoopTokensRef.current.set(id, token + 1)
      setActiveGroupLoopIds(new Set())
    }
  }, [props.connected, runner])
  useEffect(() => {
    const generation = ++lifecycleRef.current
    const releaseHolds = (): void => runner.stopAll(true, true)
    const visibility = (): void => {
      if (document.hidden) releaseHolds()
    }
    window.addEventListener('blur', releaseHolds)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('blur', releaseHolds)
      document.removeEventListener('visibilitychange', visibility)
      runner.stopAll()
      void runner.drain().then(() => {
        // StrictMode replays effects; only dispose a runtime that remains unmounted.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Read the latest generation after drain to distinguish StrictMode remounts.
        if (lifecycleRef.current === generation) programRuntime.dispose()
      })
    }
  }, [runner, programRuntime])

  useEffect(() => {
    const close = (): void => setMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
    }
  }, [])

  useEffect(
    () => () => {
      for (const [id, token] of groupLoopTokensRef.current) {
        groupLoopTokensRef.current.set(id, token + 1)
      }
    },
    []
  )

  const update = (id: number, patch: Partial<SavedCommand>): void =>
    props.setCommands(
      props.commands.map((command) => (command.id === id ? { ...command, ...patch } : command))
    )
  const updateParameter = (
    command: SavedCommand,
    parameterId: string,
    patch: Partial<SavedCommand['parameters'][number]>
  ): void =>
    update(command.id, {
      parameters: command.parameters.map((parameter) =>
        parameter.id === parameterId ? { ...parameter, ...patch } : parameter
      )
    })
  const switchParameterMode = (
    command: SavedCommand,
    parameterId: string,
    inputMode: ParameterMode
  ): void => {
    const parameter = command.parameters.find((item) => item.id === parameterId)
    if (!parameter || parameter.inputMode === inputMode) return
    try {
      const value = convertParameterMode(parameter.value, parameter.inputMode, inputMode)
      if (!numericParameterFits(value, inputMode, parameter.byteLength)) {
        throw new Error(`${parameter.byteLength} 字节不足以保存当前参数值`)
      }
      updateParameter(command, parameterId, {
        inputMode,
        value
      })
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const sendCommand = (command: SavedCommand): void => {
    if (runner.isActive(command.id)) return void runner.stop(command.id)
    if (!props.connected) return setError('请先打开串口')
    setError('')
    runner.start(command)
  }
  const pressCommand = (command: SavedCommand): void => {
    if (command.autoSend) return
    if (!props.connected) return setError('请先打开串口')
    setError('')
    runner.start(command)
  }
  const releaseCommand = (command: SavedCommand): void => {
    if (!command.autoSend) void runner.stop(command.id)
  }
  const openMenu = (event: React.MouseEvent, type: Menu['type'], id: number | null): void => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({
      x: Math.min(event.clientX, window.innerWidth - 170),
      y: Math.min(event.clientY, window.innerHeight - 150),
      type,
      id
    })
  }
  const openCommandCreator = (parentId: number | null): void => {
    setEditingCommandId(null)
    setTargetParentId(parentId)
    setDraft(emptyDraft())
    setError('')
    setCreating(true)
    setMenu(null)
  }
  const openCommandEditor = (id: number): void => {
    const command = props.commands.find((item) => item.id === id)
    if (!command) return
    setEditingCommandId(id)
    setTargetParentId(command.parentId)
    setDraft({
      name: command.name,
      template: command.template,
      releaseTemplate: command.releaseTemplate || '',
      processingMode: command.processingMode === 'program' ? 'program' : 'template',
      processingProgram: command.processingProgram || defaultCommandProgram,
      companion: normalizeCommandExtensions(command).companion!,
      hex: command.hex,
      autoSend: command.autoSend,
      autoSendInterval: command.autoSendInterval,
      autoSendCount: command.autoSendCount || 0,
      crcEnabled: Boolean(command.crcMode),
      crcMode: command.crcMode || 'modbus',
      targetPort: command.targetPort || '',
      parameters: command.parameters.map((parameter) => ({
        id: parameter.id,
        byteLength: parameter.byteLength || 1
      }))
    })
    setError('')
    setCreating(true)
    setMenu(null)
  }
  const openGroupCreator = (parentId: number | null): void => {
    setEditingGroupId(null)
    setTargetParentId(parentId)
    setGroupName('')
    setGroupTargetPort('')
    setGroupAutoLoop(false)
    setGroupLoopDelay(100)
    setGroupLoopCount(0)
    setError('')
    setCreatingGroup(true)
    setMenu(null)
  }
  const openGroupEditor = (id: number): void => {
    const group = props.groups.find((item) => item.id === id)
    if (!group) return
    setEditingGroupId(id)
    setTargetParentId(group.parentId)
    setGroupName(group.name)
    setGroupTargetPort('')
    setGroupAutoLoop(group.autoLoop)
    setGroupLoopDelay(group.loopDelay)
    setGroupLoopCount(group.loopCount)
    setError('')
    setCreatingGroup(true)
    setMenu(null)
  }
  const createGroup = (): void => {
    if (!groupName.trim()) return setError('请输入组名称')
    if (!Number.isInteger(groupLoopDelay) || groupLoopDelay < 1)
      return setError('组循环延迟不能小于 1ms')
    if (!Number.isInteger(groupLoopCount) || groupLoopCount < 0)
      return setError('组循环次数必须是大于或等于 0 的整数')
    if (editingGroupId !== null && activeGroupLoopIds.has(editingGroupId))
      stopGroupLoop(editingGroupId)
    if (editingGroupId === null)
      props.setGroups([
        ...props.groups,
        {
          id: Date.now(),
          parentId: targetParentId,
          name: groupName.trim(),
          autoLoop: groupAutoLoop,
          loopDelay: groupLoopDelay,
          loopCount: groupLoopCount,
          globals: {}
        }
      ])
    else
      props.setGroups(
        props.groups.map((group) =>
          group.id === editingGroupId
            ? {
                ...group,
                name: groupName.trim(),
                autoLoop: groupAutoLoop,
                loopDelay: groupLoopDelay,
                loopCount: groupLoopCount
              }
            : group
        )
      )
    if (editingGroupId !== null && groupTargetPort) {
      const groupIds = new Set(descendantGroupIds(editingGroupId))
      props.setCommands(
        props.commands.map((command) =>
          command.parentId !== null && groupIds.has(command.parentId)
            ? { ...command, targetPort: groupTargetPort }
            : command
        )
      )
    }
    setCreatingGroup(false)
    setEditingGroupId(null)
    setError('')
  }
  const createCommand = (): void => {
    if (!draft.name.trim()) return setError('请输入指令名称')
    if (!draft.template) return setError('请输入发送指令')
    if (draft.processingMode === 'program' && !draft.processingProgram.trim())
      return setError('请输入 process(data, context) 处理函数')
    if (draft.companion.enabled) {
      if (draft.companion.source === 'custom' && !draft.companion.template)
        return setError('请输入自定义附带指令内容')
      if (
        draft.companion.source === 'command' &&
        !props.commands.some(
          (command) => command.id === draft.companion.commandId && command.id !== editingCommandId
        )
      )
        return setError('请选择一条已有的其他快捷指令作为附带指令')
      if (
        !Number.isInteger(draft.companion.interval) ||
        draft.companion.interval < 1 ||
        draft.companion.interval > 2147483647
      )
        return setError('附带指令间隔必须是 1~2147483647ms 的整数')
    }
    if (!Number.isFinite(draft.autoSendInterval) || draft.autoSendInterval < 1)
      return setError('自动发送周期不能小于 1ms')
    if (!Number.isInteger(draft.autoSendCount) || draft.autoSendCount < 0)
      return setError('自动发送次数必须是大于或等于 0 的整数')
    const definitions = draft.parameters
      .map((parameter) => ({ ...parameter, id: parameter.id.trim() }))
      .filter((parameter) => parameter.id)
    const ids = definitions.map((parameter) => parameter.id)
    if (ids.some((id) => /[{}]/.test(id))) return setError('参数名字不能包含花括号')
    if (new Set(ids).size !== ids.length) return setError('参数名字不能重复')
    if (
      definitions.some(
        (parameter) =>
          !Number.isInteger(parameter.byteLength) ||
          parameter.byteLength < 1 ||
          parameter.byteLength > 64
      )
    )
      return setError('参数字节数必须是 1-64 的整数')
    if (editingCommandId === null) {
      props.setCommands([
        ...props.commands,
        {
          id: Date.now(),
          parentId: targetParentId,
          name: draft.name.trim(),
          template: draft.template,
          releaseTemplate: draft.releaseTemplate,
          processingMode: draft.processingMode,
          processingProgram: draft.processingProgram,
          companion: { ...draft.companion },
          hex: draft.hex,
          autoSend: draft.autoSend,
          autoSendInterval: draft.autoSendInterval,
          autoSendCount: draft.autoSendCount,
          crcMode: draft.crcEnabled ? draft.crcMode : null,
          targetPort: draft.targetPort,
          parameters: definitions.map(({ id, byteLength }) => ({
            id,
            byteLength,
            value: '',
            inputMode: draft.hex ? 'hex' : 'ascii'
          }))
        }
      ])
    } else {
      const current = props.commands.find((command) => command.id === editingCommandId)
      if (!current) return setError('要编辑的指令不存在')
      const parameters = definitions.map(({ id, byteLength }) => {
        const existing = current.parameters.find((parameter) => parameter.id === id)
        return existing
          ? { ...existing, byteLength }
          : {
              id,
              byteLength,
              value: '',
              inputMode: draft.hex ? ('hex' as const) : ('ascii' as const)
            }
      })
      props.setCommands(
        props.commands.map((command) =>
          command.id === editingCommandId
            ? {
                ...command,
                name: draft.name.trim(),
                template: draft.template,
                releaseTemplate: draft.releaseTemplate,
                processingMode: draft.processingMode,
                processingProgram: draft.processingProgram,
                companion: { ...draft.companion },
                hex: draft.hex,
                autoSend: draft.autoSend,
                autoSendInterval: draft.autoSendInterval,
                autoSendCount: draft.autoSendCount,
                crcMode: draft.crcEnabled ? draft.crcMode : null,
                targetPort: draft.targetPort,
                parameters
              }
            : command
        )
      )
    }
    setCreating(false)
    setEditingCommandId(null)
    setError('')
  }
  const descendantGroupIds = (id: number): number[] => {
    const children = props.groups
      .filter((group) => group.parentId === id)
      .flatMap((group) => descendantGroupIds(group.id))
    return [id, ...children]
  }
  const deleteGroup = (id: number): void => {
    const ids = new Set(descendantGroupIds(id))
    ids.forEach((groupId) =>
      groupLoopTokensRef.current.set(groupId, (groupLoopTokensRef.current.get(groupId) || 0) + 1)
    )
    setActiveGroupLoopIds((current) => new Set([...current].filter((groupId) => !ids.has(groupId))))
    props.setGroups(props.groups.filter((group) => !ids.has(group.id)))
    props.setCommands(
      props.commands.filter((command) => command.parentId === null || !ids.has(command.parentId))
    )
    setActiveAutoSendIds(
      (current) =>
        new Set(
          [...current].filter((commandId) => {
            const command = props.commands.find((item) => item.id === commandId)
            return command && (command.parentId === null || !ids.has(command.parentId))
          })
        )
    )
    setMenu(null)
  }
  const toggleGroup = (id: number): void =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const groupCommandCount = (id: number): number => {
    const directCount = props.commands.filter((command) => command.parentId === id).length
    return (
      directCount +
      props.groups
        .filter((group) => group.parentId === id)
        .reduce((total, group) => total + groupCommandCount(group.id), 0)
    )
  }
  const groupCommandsInOrder = (id: number): SavedCommand[] => [
    ...props.groups
      .filter((group) => group.parentId === id)
      .flatMap((group) => groupCommandsInOrder(group.id)),
    ...props.commands.filter((command) => command.parentId === id)
  ]
  const stopGroupLoop = (id: number): void => {
    groupLoopTokensRef.current.set(id, (groupLoopTokensRef.current.get(id) || 0) + 1)
    setActiveGroupLoopIds((current) => {
      const next = new Set(current)
      next.delete(id)
      return next
    })
  }
  const commandOrder = useListReorder(
    props.commands,
    (next, source, target) => {
      const visited = new Set<number>()
      let stoppedLoop = false
      for (const parentId of [source.parentId, target.parentId]) {
        let ancestorId = parentId
        while (ancestorId !== null && !visited.has(ancestorId)) {
          visited.add(ancestorId)
          if (activeGroupLoopIds.has(ancestorId)) {
            stopGroupLoop(ancestorId)
            stoppedLoop = true
          }
          ancestorId = props.groups.find((group) => group.id === ancestorId)?.parentId ?? null
        }
      }
      props.setCommands(
        next.map((command) =>
          command.id === source.id ? { ...command, parentId: target.parentId } : command
        )
      )
      setDraggedNode(null)
      setDropTargetId(undefined)
      setError(stoppedLoop ? '顺序已更新，受影响组的自动循环已停止，可手动重新启动' : '')
    },
    () => true,
    true
  )
  const clearDrag = (): void => {
    commandOrder.clear()
    setDraggedNode(null)
    setDropTargetId(undefined)
  }
  const startDrag = (event: React.DragEvent, node: DraggedNode): void => {
    event.stopPropagation()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-serialflow-command-node', JSON.stringify(node))
    setDraggedNode(node)
    setDropTargetId(undefined)
    setMenu(null)
  }
  const canDrop = (parentId: number | null): boolean => {
    if (!draggedNode) return false
    const source =
      draggedNode.type === 'group'
        ? props.groups.find((group) => group.id === draggedNode.id)
        : props.commands.find((command) => command.id === draggedNode.id)
    if (!source || source.parentId === parentId) return false
    const visited = new Set<number>()
    let ancestorId = parentId
    while (ancestorId !== null) {
      if (visited.has(ancestorId)) return false
      if (draggedNode.type === 'group' && ancestorId === draggedNode.id) return false
      visited.add(ancestorId)
      const ancestor = props.groups.find((group) => group.id === ancestorId)
      if (!ancestor) return false
      ancestorId = ancestor.parentId
    }
    return true
  }
  const dragOver = (event: React.DragEvent, parentId: number | null): void => {
    if (!draggedNode) return
    event.preventDefault()
    event.stopPropagation()
    const allowed = canDrop(parentId)
    event.dataTransfer.dropEffect = allowed ? 'move' : 'none'
    setDropTargetId(allowed ? parentId : undefined)
  }
  const dragLeave = (event: React.DragEvent): void => {
    if (!draggedNode) return
    event.stopPropagation()
    if (
      !(event.relatedTarget instanceof Node) ||
      !event.currentTarget.contains(event.relatedTarget)
    )
      setDropTargetId(undefined)
  }
  const dropNode = (event: React.DragEvent, parentId: number | null): void => {
    if (!draggedNode) return
    event.preventDefault()
    event.stopPropagation()
    if (canDrop(parentId)) {
      const source =
        draggedNode.type === 'group'
          ? props.groups.find((group) => group.id === draggedNode.id)!
          : props.commands.find((command) => command.id === draggedNode.id)!
      // Running group loops hold a snapshot of their commands. Stop affected ancestors
      // so a moved command is not sent again from its previous group.
      const affectedGroups = new Set<number>()
      for (const startId of [source.parentId, parentId]) {
        let ancestorId = startId
        while (ancestorId !== null && !affectedGroups.has(ancestorId)) {
          affectedGroups.add(ancestorId)
          ancestorId = props.groups.find((group) => group.id === ancestorId)?.parentId ?? null
        }
      }
      let stoppedLoop = false
      for (const id of affectedGroups) {
        if (activeGroupLoopIds.has(id)) {
          stopGroupLoop(id)
          stoppedLoop = true
        }
      }
      if (draggedNode.type === 'command') update(draggedNode.id, { parentId })
      else
        props.setGroups(
          props.groups.map((group) =>
            group.id === draggedNode.id ? { ...group, parentId } : group
          )
        )
      if (parentId !== null)
        setCollapsed((current) => {
          const next = new Set(current)
          next.delete(parentId)
          return next
        })
      setError(stoppedLoop ? '归属已更新，受影响组的自动循环已停止，可手动重新启动' : '')
    }
    clearDrag()
  }
  const importCommands = async (): Promise<void> => {
    setImportLoading(true)
    try {
      const selected = await window.api.openConfig('quick-commands')
      if (!selected) return
      const imported = parseQuickCommandImport(selected.content)
      const filename = selected.path.split(/[\\/]/).pop() || imported.source
      setPendingImport({
        imported,
        groupName: filename.replace(/(?:\.cmds)?\.(json|ini)$/i, '') || imported.source
      })
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setImportLoading(false)
    }
  }
  const confirmImport = (options: QuickCommandImportOptions): void => {
    if (!pendingImport || !props.onImport(pendingImport.imported, options)) return
    if (options.mode === 'replace') {
      for (const id of activeGroupLoopIds)
        groupLoopTokensRef.current.set(id, (groupLoopTokensRef.current.get(id) || 0) + 1)
      runner.stopAll(false)
      setActiveAutoSendIds(new Set())
      setActiveHoldIds(new Set())
      setActiveGroupLoopIds(new Set())
      setCollapsed(new Set())
    }
    setPendingImport(null)
    setMenu(null)
    setError('')
  }
  const toggleGroupLoop = (group: CommandGroup): void => {
    if (activeGroupLoopIds.has(group.id)) return stopGroupLoop(group.id)
    if (!props.connected) return setError('请先打开串口')
    const commands = groupCommandsInOrder(group.id)
    if (!commands.length) return setError('当前组及子组内没有可发送的指令')
    const token = (groupLoopTokensRef.current.get(group.id) || 0) + 1
    groupLoopTokensRef.current.set(group.id, token)
    setActiveGroupLoopIds((current) => new Set(current).add(group.id))
    setError('')
    const run = async (): Promise<void> => {
      let completedLoops = 0
      while (
        groupLoopTokensRef.current.get(group.id) === token &&
        (group.loopCount === 0 || completedLoops < group.loopCount)
      ) {
        for (let index = 0; index < commands.length; index += 1) {
          if (groupLoopTokensRef.current.get(group.id) !== token) return
          const command = commands[index]
          try {
            const success = await runner.sendOnce(
              command,
              () => groupLoopTokensRef.current.get(group.id) === token
            )
            if (groupLoopTokensRef.current.get(group.id) !== token) return
            if (!success) return stopGroupLoop(group.id)
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
            return stopGroupLoop(group.id)
          }
          const isLastSend =
            group.loopCount > 0 &&
            completedLoops + 1 >= group.loopCount &&
            index === commands.length - 1
          if (!isLastSend) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, group.loopDelay))
          }
        }
        completedLoops += 1
      }
      if (groupLoopTokensRef.current.get(group.id) === token) stopGroupLoop(group.id)
    }
    void run()
  }
  const copyPlaceholder = async (id: string, index: number): Promise<void> => {
    if (!id.trim()) return
    try {
      await navigator.clipboard.writeText(`{{${id.trim()}}}`)
      setCopiedIndex(index)
      window.setTimeout(() => setCopiedIndex(null), 1200)
    } catch {
      setError('复制失败，请检查剪贴板权限')
    }
  }
  const renderCommand = (command: SavedCommand): React.JSX.Element => (
    <section
      className={`command-item ${commandOrder.className(command)} ${draggedNode?.type === 'command' && draggedNode.id === command.id ? 'is-dragging' : ''}`}
      key={`command-${command.id}`}
      {...commandOrder.dropProps(command)}
      onDragOver={(event) => {
        commandOrder.dropProps(command).onDragOver?.(event)
        if (draggedNode?.type === 'command') setDropTargetId(undefined)
      }}
      onContextMenu={(event) => openMenu(event, 'command', command.id)}
    >
      <div
        className="command-head"
        title={
          command.releaseTemplate
            ? `按下：${command.template}\n抬起：${command.releaseTemplate}`
            : command.template
        }
      >
        <div
          className="command-drag-source"
          draggable
          title="拖动调整组内顺序，或拖到目标组、顶层调整归属"
          onDragStart={(event) => {
            startDrag(event, { type: 'command', id: command.id })
            commandOrder.start(event, command)
          }}
          onDragEnd={clearDrag}
        >
          <span className="command-drag-grip" aria-hidden="true">
            ⠿
          </span>
          <strong>{command.name}</strong>
          <span className={`format-badge ${command.hex ? 'hex' : ''}`}>
            {command.hex ? 'HEX' : 'ASCII'}
          </span>
          <span className="port-badge">{command.targetPort || '当前串口'}</span>
          {command.crcMode && (
            <span className="crc-badge">
              {command.crcMode === 'modbus' ? 'CRC-16/MODBUS' : command.crcMode.toUpperCase()}
            </span>
          )}
          {command.autoSend && (
            <span
              className={`auto-send-badge ${props.connected && activeAutoSendIds.has(command.id) ? 'running' : ''}`}
            >
              {props.connected && activeAutoSendIds.has(command.id)
                ? '发送中'
                : `自动 ${command.autoSendInterval}ms / ${command.autoSendCount === 0 ? '∞' : `${command.autoSendCount}次`}`}
            </span>
          )}
        </div>
        <button
          className={`command-send ${props.connected && activeAutoSendIds.has(command.id) ? 'stop' : ''} ${activeHoldIds.has(command.id) ? 'held' : ''}`}
          aria-pressed={activeAutoSendIds.has(command.id) || activeHoldIds.has(command.id)}
          onPointerDown={(event) => {
            if (command.autoSend || event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            void pressCommand(command)
          }}
          onPointerUp={(event) => {
            if (command.autoSend) return
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId)
            void releaseCommand(command)
          }}
          onPointerCancel={() => releaseCommand(command)}
          onLostPointerCapture={() => releaseCommand(command)}
          onBlur={() => releaseCommand(command)}
          onKeyDown={(event) => {
            if (!command.autoSend && (event.key === 'Enter' || event.key === ' '))
              event.preventDefault()
            if (!command.autoSend && !event.repeat && (event.key === 'Enter' || event.key === ' '))
              void pressCommand(command)
          }}
          onKeyUp={(event) => {
            if (!command.autoSend && (event.key === 'Enter' || event.key === ' '))
              void releaseCommand(command)
          }}
          onClick={() => {
            if (command.autoSend) void sendCommand(command)
          }}
        >
          {command.autoSend
            ? props.connected && activeAutoSendIds.has(command.id)
              ? '停止'
              : '启动'
            : command.releaseTemplate || command.companion?.enabled
              ? '按住发送'
              : '发送'}
        </button>
      </div>
      {(command.processingMode === 'program' || command.companion?.enabled) && (
        <div className="command-features">
          {command.processingMode === 'program' && (
            <span className="parameter-mode-badge program">编程处理</span>
          )}
          {command.companion?.enabled && (
            <span
              className="command-companion-badge"
              title="按住期间执行；自动发送时跟随启动和停止"
            >
              附带：
              {command.companion.source === 'custom'
                ? '自定义指令'
                : props.commands.find((item) => item.id === command.companion?.commandId)?.name ||
                  '指令已删除'}
              {' · '}
              {command.companion.loop ? `${command.companion.interval}ms 循环` : '执行一次'}
            </span>
          )}
        </div>
      )}
      {command.parameters.map((parameter) => (
        <div className="command-parameter" key={parameter.id}>
          <label>
            <span>
              {parameter.id} · {parameter.byteLength} 字节
            </span>
            <input
              inputMode={parameter.inputMode === 'dec' ? 'numeric' : 'text'}
              maxLength={parameter.inputMode === 'hex' ? parameter.byteLength * 2 : undefined}
              value={parameter.value}
              placeholder={numericParameterPlaceholder(parameter.inputMode, parameter.byteLength)}
              onChange={(event) => {
                const value = event.target.value
                if (numericParameterFits(value, parameter.inputMode, parameter.byteLength))
                  updateParameter(command, parameter.id, {
                    value: parameter.inputMode === 'hex' ? value.toUpperCase() : value
                  })
              }}
            />
          </label>
          <select
            className="parameter-mode-select"
            aria-label={`${parameter.id} 参数格式`}
            value={parameter.inputMode}
            onChange={(event) =>
              switchParameterMode(command, parameter.id, event.target.value as ParameterMode)
            }
          >
            <option value="ascii">ASCII</option>
            <option value="dec">DEC</option>
            <option value="hex">HEX</option>
          </select>
        </div>
      ))}
    </section>
  )
  const renderLevel = (parentId: number | null, depth = 0): React.JSX.Element[] => {
    const nodes: React.JSX.Element[] = []
    for (const group of props.groups.filter((item) => item.parentId === parentId)) {
      const isCollapsed = collapsed.has(group.id)
      nodes.push(
        <section
          className={`command-group ${depth === 0 ? 'root-group' : 'nested-group'} ${draggedNode?.type === 'group' && draggedNode.id === group.id ? 'is-dragging' : ''} ${dropTargetId === group.id ? 'is-drop-target' : ''}`}
          key={`group-${group.id}`}
          style={{ '--tree-depth': depth } as React.CSSProperties}
          onContextMenu={(event) => openMenu(event, 'group', group.id)}
          onDragOver={(event) => dragOver(event, group.id)}
          onDragLeave={dragLeave}
          onDrop={(event) => dropNode(event, group.id)}
        >
          <div className="group-title-row">
            <button
              className="group-title"
              draggable
              title="点击展开或折叠；拖动到目标组或顶层以调整归属"
              onDragStart={(event) => startDrag(event, { type: 'group', id: group.id })}
              onDragEnd={clearDrag}
              onClick={() => toggleGroup(group.id)}
            >
              <span className="group-arrow">{isCollapsed ? '▸' : '▾'}</span>
              <b className="folder-icon">▰</b>
              <strong>{group.name}</strong>
              <em>{groupCommandCount(group.id)} 条指令</em>
              {Object.keys(group.globals).length > 0 && (
                <span className="group-global-badge">
                  global · {Object.keys(group.globals).length}
                </span>
              )}
            </button>
            {group.autoLoop && (
              <button
                className={`group-loop-button ${activeGroupLoopIds.has(group.id) ? 'stop' : ''}`}
                onClick={() => toggleGroupLoop(group)}
              >
                {activeGroupLoopIds.has(group.id) ? '停止' : '循环'}
              </button>
            )}
          </div>
          {!isCollapsed && <div className="group-children">{renderLevel(group.id, depth + 1)}</div>}
        </section>
      )
    }
    nodes.push(
      ...props.commands.filter((command) => command.parentId === parentId).map(renderCommand)
    )
    return nodes
  }

  return (
    <div
      className="commands-panel"
      onContextMenu={(event) => openMenu(event, 'root', null)}
      onDragOver={(event) => dragOver(event, null)}
      onDragLeave={dragLeave}
      onDrop={(event) => dropNode(event, null)}
    >
      <div className="side-section-head">
        <div>
          <strong>快捷指令</strong>
          <small>右键新建 · 拖动名称调整归属</small>
        </div>
        <div className="side-section-actions">
          <button
            title="导入 SerialFlow JSON、SSCOM INI 或 VOFA+ 命令组 JSON"
            disabled={importLoading || pendingImport !== null}
            onClick={() => void importCommands()}
          >
            导入
          </button>
          <button onClick={props.onExport}>导出</button>
          <span className="side-section-count">{props.commands.length} 条</span>
        </div>
      </div>
      <div
        className={`command-root-drop ${dropTargetId === null ? 'is-drop-target' : ''}`}
        onDragOver={(event) => dragOver(event, null)}
        onDragLeave={dragLeave}
        onDrop={(event) => dropNode(event, null)}
      >
        顶层（无归属组）<span>拖到此处移出分组</span>
      </div>
      <div
        className="command-list"
        onDragOver={(event) => dragOver(event, null)}
        onDragLeave={dragLeave}
        onDrop={(event) => dropNode(event, null)}
      >
        {renderLevel(null)}
        {!props.commands.length && !props.groups.length && (
          <div className="empty-rules">在空白处右键新建组或指令</div>
        )}
      </div>
      {error && !creating && !creatingGroup && <p className="side-error">{error}</p>}

      {menu && (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {menu.type !== 'command' && (
            <>
              <button onClick={() => openGroupCreator(menu.id)}>＋ 新建组</button>
              <button onClick={() => openCommandCreator(menu.id)}>›_ 新建指令</button>
            </>
          )}
          {menu.type === 'command' && (
            <>
              <button onClick={() => openCommandEditor(menu.id!)}>✎ 编辑指令</button>
              <div className="menu-separator" />
              <button
                className="danger"
                onClick={() => {
                  props.setCommands(props.commands.filter((item) => item.id !== menu.id))
                  setMenu(null)
                }}
              >
                删除当前指令
              </button>
            </>
          )}
          {menu.type === 'group' && (
            <>
              <button onClick={() => openGroupEditor(menu.id!)}>✎ 编辑组</button>
              <button
                onClick={() => {
                  props.setGroups(
                    props.groups.map((group) =>
                      group.id === menu.id ? { ...group, globals: {} } : group
                    )
                  )
                  setMenu(null)
                  setError('当前快捷指令组的 global 已重置')
                }}
              >
                ↻ 重置 global
              </button>
              <div className="menu-separator" />
              <button className="danger" onClick={() => deleteGroup(menu.id!)}>
                删除组及内容
              </button>
            </>
          )}
        </div>
      )}

      {pendingImport && (
        <QuickCommandImportDialog
          imported={pendingImport.imported}
          defaultGroupName={pendingImport.groupName}
          onConfirm={confirmImport}
          onCancel={() => setPendingImport(null)}
        />
      )}
      {creatingGroup && (
        <div className="modal-backdrop rule-create-backdrop">
          <div className="modal group-modal">
            <div className="modal-head">
              <div>
                <h2>{editingGroupId === null ? '新建指令组' : '编辑指令组'}</h2>
                <p>{editingGroupId === null ? '组内可继续创建子组和指令' : '修改当前组的名称'}</p>
              </div>
              <button onClick={() => setCreatingGroup(false)}>×</button>
            </div>
            <div className="create-rule-form">
              <label>
                组名称
                <input
                  autoFocus
                  value={groupName}
                  placeholder="例如：电机控制"
                  onChange={(event) => setGroupName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') createGroup()
                  }}
                />
              </label>
              <div className="command-auto-settings group-loop-settings">
                <label>
                  <input
                    type="checkbox"
                    checked={groupAutoLoop}
                    onChange={(event) => setGroupAutoLoop(event.target.checked)}
                  />
                  启用组自动循环
                </label>
                <div className={groupAutoLoop ? '' : 'disabled'}>
                  <input
                    aria-label="组内指令发送延迟"
                    type="number"
                    min="1"
                    disabled={!groupAutoLoop}
                    value={groupLoopDelay}
                    onChange={(event) => setGroupLoopDelay(Number(event.target.value))}
                  />
                  <span>ms 延迟</span>
                </div>
                <div className={groupAutoLoop ? '' : 'disabled'}>
                  <input
                    aria-label="组循环次数，0 表示无限"
                    type="number"
                    min="0"
                    disabled={!groupAutoLoop}
                    value={groupLoopCount}
                    onChange={(event) => setGroupLoopCount(Number(event.target.value))}
                  />
                  <span>次</span>
                </div>
              </div>
              <small className="group-loop-help">
                循环次数为 0 时持续循环，延迟作用于每两条指令之间
              </small>
              {editingGroupId !== null && (
                <label>
                  批量修改组内指令目标端口
                  <select
                    value={groupTargetPort}
                    onChange={(event) => setGroupTargetPort(event.target.value)}
                  >
                    <option value="">不修改</option>
                    {props.targetPorts.map((port) => (
                      <option key={port.path} value={port.path}>
                        {port.name}（{port.path}）
                      </option>
                    ))}
                  </select>
                  <small>保存后同时修改当前组及所有子组内的指令</small>
                </label>
              )}
              {error && <p className="form-error">{error}</p>}
            </div>
            <div className="modal-foot">
              <button className="cancel-button" onClick={() => setCreatingGroup(false)}>
                取消
              </button>
              <button onClick={createGroup}>
                {editingGroupId === null ? '创建组' : '保存修改'}
              </button>
            </div>
          </div>
        </div>
      )}

      {creating && (
        <div className="modal-backdrop rule-create-backdrop">
          <div
            className="modal create-rule-modal command-editor-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="command-editor-title"
          >
            <div className="modal-head">
              <div>
                <h2 id="command-editor-title">
                  {editingCommandId === null ? '新建快捷指令' : '编辑快捷指令'}
                </h2>
                <p>定义模板、参数及最终发送编码</p>
              </div>
              <button aria-label="关闭指令编辑器" onClick={() => setCreating(false)}>
                ×
              </button>
            </div>
            <div className="create-rule-form command-editor-form">
              <div className="command-identity-grid">
                <label className="command-name-field">
                  指令名称
                  <input
                    autoFocus
                    value={draft.name}
                    placeholder="例如：设置 PID"
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </label>
                <label className="command-port-field">
                  目标端口
                  <select
                    value={draft.targetPort}
                    onChange={(event) => setDraft({ ...draft, targetPort: event.target.value })}
                  >
                    <option value="">当前串口</option>
                    {props.targetPorts.map((port) => (
                      <option key={port.path} value={port.path}>
                        {port.name}（{port.path}）
                      </option>
                    ))}
                  </select>
                </label>
                <div className="form-row command-encoding-field">
                  <span>发送编码</span>
                  <div className="mini-segment">
                    <button
                      className={!draft.hex ? 'active' : ''}
                      onClick={() => setDraft({ ...draft, hex: false })}
                    >
                      ASCII
                    </button>
                    <button
                      className={draft.hex ? 'active' : ''}
                      onClick={() => setDraft({ ...draft, hex: true })}
                    >
                      HEX
                    </button>
                  </div>
                </div>
              </div>
              <div className="command-editor-columns">
                <section className="command-editor-main" aria-label="指令内容">
                  <div className="command-section-heading">
                    <h3>指令内容</h3>
                    <span>模板与参数</span>
                  </div>
                  <label className="command-packet-field">
                    按下发送指令
                    <textarea
                      className="compact-packet-input"
                      rows={1}
                      value={draft.template}
                      placeholder={
                        draft.hex
                          ? '例如：01 06 {{目标值}}'
                          : '例如：PID {{比例参数}} {{积分参数}} {{微分参数}}\\r\\n'
                      }
                      onChange={(event) => setDraft({ ...draft, template: event.target.value })}
                    />
                    <small>
                      使用完整参数名字定位，例如 <code>{'{{目标速度}}'}</code>
                    </small>
                  </label>
                  <label className="command-packet-field command-release-field">
                    抬起发送指令（可选）
                    <textarea
                      rows={1}
                      className="command-release-input compact-packet-input"
                      value={draft.releaseTemplate}
                      placeholder={
                        draft.hex ? '例如：01 06 00 00' : '例如：STOP {{目标速度}}\\r\\n'
                      }
                      onChange={(event) =>
                        setDraft({ ...draft, releaseTemplate: event.target.value })
                      }
                    />
                    <small>普通指令按钮抬起时发送；自动发送停止或完成时发送一次</small>
                  </label>
                  <div className="parameter-editor">
                    <div className="parameter-editor-head">
                      <span>指令参数</span>
                      <button
                        onClick={() =>
                          setDraft({
                            ...draft,
                            parameters: [...draft.parameters, { id: '', byteLength: 1 }]
                          })
                        }
                      >
                        ＋ 添加参数
                      </button>
                    </div>
                    {draft.parameters.map((parameter, index) => (
                      <div className="parameter-edit-row command-parameter-edit-row" key={index}>
                        <input
                          aria-label={`参数 ${index + 1} 名称`}
                          value={parameter.id}
                          placeholder="参数名字，例如 目标速度"
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              parameters: draft.parameters.map((value, itemIndex) =>
                                itemIndex === index ? { ...value, id: event.target.value } : value
                              )
                            })
                          }
                        />
                        <label className="parameter-byte-length">
                          <input
                            aria-label={`参数 ${index + 1} 字节数`}
                            type="number"
                            min="1"
                            max="64"
                            value={parameter.byteLength}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                parameters: draft.parameters.map((value, itemIndex) =>
                                  itemIndex === index
                                    ? { ...value, byteLength: Number(event.target.value) }
                                    : value
                                )
                              })
                            }
                          />
                          <span>字节</span>
                        </label>
                        <button
                          className="copy-placeholder"
                          disabled={!parameter.id.trim()}
                          onClick={() => void copyPlaceholder(parameter.id, index)}
                        >
                          {copiedIndex === index
                            ? '已复制'
                            : parameter.id.trim()
                              ? `{{${parameter.id.trim()}}}`
                              : '{{参数名字}}'}
                        </button>
                        <button
                          aria-label={`删除参数 ${index + 1}`}
                          className="remove-parameter"
                          onClick={() =>
                            setDraft({
                              ...draft,
                              parameters: draft.parameters.filter(
                                (_, itemIndex) => itemIndex !== index
                              )
                            })
                          }
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {draft.parameters.length > 0 && (
                      <small className="parameter-byte-help">
                        DEC/HEX 参数按无符号数限制范围；发送 HEX 指令时按大端顺序左侧补零，例如 2
                        字节 DEC 10 → 00 0A
                      </small>
                    )}
                  </div>
                  <div className="command-processing-section">
                    <div className="form-row">
                      <span>指令处理</span>
                      <div className="mini-segment">
                        <button
                          className={draft.processingMode === 'template' ? 'active' : ''}
                          onClick={() => setDraft({ ...draft, processingMode: 'template' })}
                        >
                          普通模式
                        </button>
                        <button
                          className={draft.processingMode === 'program' ? 'active' : ''}
                          onClick={() => setDraft({ ...draft, processingMode: 'program' })}
                        >
                          编程模式
                        </button>
                      </div>
                    </div>
                    {draft.processingMode === 'program' && (
                      <div className="command-program-editor">
                        发送前处理函数（JS / TS）
                        <ProgramCodeEditor
                          aria-label="快捷指令处理程序"
                          spellCheck={false}
                          value={draft.processingProgram}
                          onChange={(event) =>
                            setDraft({ ...draft, processingProgram: event.target.value })
                          }
                          onKeyDown={(event) => {
                            if (
                              (event.ctrlKey || event.metaKey) &&
                              event.key.toLowerCase() === 's'
                            ) {
                              event.preventDefault()
                              createCommand()
                            }
                            if (event.key === 'Tab') {
                              event.preventDefault()
                              const input = event.currentTarget
                              const start = input.selectionStart
                              const end = input.selectionEnd
                              setDraft({
                                ...draft,
                                processingProgram:
                                  draft.processingProgram.slice(0, start) +
                                  '  ' +
                                  draft.processingProgram.slice(end)
                              })
                              requestAnimationFrame(() =>
                                input.setSelectionRange(start + 2, start + 2)
                              )
                            }
                          }}
                        />
                        <small>
                          直接编写 JS 或 TS，无需切换语言。 process(data, context)
                          返回完整字节数组或 Uint8Array；data
                          是替换参数并编码后的字节。context.phase 区分
                          press（主指令）、release（抬起）、companion（被附带执行）。
                        </small>
                        <small>
                          处理顺序：参数替换 → 编码 → 处理函数 → 标准
                          CRC。自定义校验已在函数内追加时，请关闭标准 CRC。Tab 缩进，Ctrl+S 保存。
                        </small>
                      </div>
                    )}
                  </div>
                </section>
                <aside className="command-editor-options" aria-label="发送选项">
                  <div className="command-section-heading">
                    <h3>发送选项</h3>
                    <span>按需启用</span>
                  </div>
                  <div className="command-crc-settings">
                    <label>
                      <input
                        type="checkbox"
                        checked={draft.crcEnabled}
                        onChange={(event) =>
                          setDraft({ ...draft, crcEnabled: event.target.checked })
                        }
                      />
                      附加 CRC 校验
                    </label>
                    <select
                      aria-label="CRC 校验算法"
                      disabled={!draft.crcEnabled}
                      value={draft.crcMode}
                      onChange={(event) =>
                        setDraft({ ...draft, crcMode: event.target.value as CrcMode })
                      }
                    >
                      <option value="crc8">CRC-8</option>
                      <option value="modbus">CRC-16/MODBUS（低字节在前）</option>
                      <option value="ccitt-false">CRC-16/CCITT-FALSE</option>
                      <option value="xmodem">CRC-16/XMODEM</option>
                      <option value="crc32">CRC-32</option>
                    </select>
                  </div>
                  <div className="command-auto-settings">
                    <label>
                      <input
                        type="checkbox"
                        checked={draft.autoSend}
                        onChange={(event) => setDraft({ ...draft, autoSend: event.target.checked })}
                      />
                      自动发送
                    </label>
                    <div className={draft.autoSend ? '' : 'disabled'}>
                      <input
                        aria-label="自动发送间隔"
                        type="number"
                        min="1"
                        disabled={!draft.autoSend}
                        value={draft.autoSendInterval}
                        onChange={(event) =>
                          setDraft({ ...draft, autoSendInterval: Number(event.target.value) })
                        }
                      />
                      <span>ms 间隔</span>
                    </div>
                    <div className={draft.autoSend ? '' : 'disabled'}>
                      <input
                        aria-label="自动发送次数，0 表示无限"
                        type="number"
                        min="0"
                        disabled={!draft.autoSend}
                        value={draft.autoSendCount}
                        onChange={(event) =>
                          setDraft({ ...draft, autoSendCount: Number(event.target.value) })
                        }
                      />
                      <span>次数</span>
                    </div>
                  </div>
                  <small className="auto-send-count-help">
                    {draft.autoSend
                      ? '在指令列表点击启动，0 次表示持续发送。'
                      : '启用后可设置发送间隔和次数。'}
                  </small>
                  <div className="command-companion-settings">
                    <label className="command-option-toggle">
                      <input
                        type="checkbox"
                        checked={draft.companion.enabled}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            companion: { ...draft.companion, enabled: event.target.checked }
                          })
                        }
                      />
                      附带执行指令
                    </label>
                    {draft.companion.enabled && (
                      <>
                        <small>执行来源（二选一）</small>
                        <div
                          className="mini-segment"
                          role="group"
                          aria-label="附带执行来源（二选一）"
                        >
                          <button
                            className={draft.companion.source === 'command' ? 'active' : ''}
                            aria-pressed={draft.companion.source === 'command'}
                            onClick={() =>
                              setDraft({
                                ...draft,
                                companion: { ...draft.companion, source: 'command' }
                              })
                            }
                          >
                            已有快捷指令
                          </button>
                          <button
                            className={draft.companion.source === 'custom' ? 'active' : ''}
                            aria-pressed={draft.companion.source === 'custom'}
                            onClick={() =>
                              setDraft({
                                ...draft,
                                companion: { ...draft.companion, source: 'custom' }
                              })
                            }
                          >
                            自定义输入
                          </button>
                        </div>
                        {draft.companion.source === 'command' ? (
                          <label>
                            附带指令
                            <select
                              value={draft.companion.commandId ?? ''}
                              onChange={(event) =>
                                setDraft({
                                  ...draft,
                                  companion: {
                                    ...draft.companion,
                                    commandId: event.target.value
                                      ? Number(event.target.value)
                                      : null
                                  }
                                })
                              }
                            >
                              <option value="">请选择已有快捷指令</option>
                              {props.commands
                                .filter((command) => command.id !== editingCommandId)
                                .map((command) => (
                                  <option key={command.id} value={command.id}>
                                    {props.groups.find((group) => group.id === command.parentId)
                                      ?.name || '顶层'}{' '}
                                    / {command.name}（{command.targetPort || '当前串口'}）
                                  </option>
                                ))}
                            </select>
                          </label>
                        ) : (
                          <label>
                            自定义附带内容（{draft.hex ? 'HEX' : 'ASCII'}）
                            <textarea
                              className="compact-packet-input"
                              rows={1}
                              aria-label="自定义附带指令内容"
                              value={draft.companion.template}
                              placeholder={
                                draft.hex ? '例如：01 03 00 00 00 02' : '例如：GET X\\r\\n'
                              }
                              onChange={(event) =>
                                setDraft({
                                  ...draft,
                                  companion: { ...draft.companion, template: event.target.value }
                                })
                              }
                            />
                          </label>
                        )}
                        <div className="command-companion-timing">
                          <label className="command-option-toggle">
                            <input
                              type="checkbox"
                              checked={draft.companion.loop}
                              onChange={(event) =>
                                setDraft({
                                  ...draft,
                                  companion: { ...draft.companion, loop: event.target.checked }
                                })
                              }
                            />
                            循环执行
                          </label>
                          <label>
                            间隔
                            <input
                              aria-label="附带指令循环间隔"
                              type="number"
                              min="1"
                              max="2147483647"
                              step="1"
                              disabled={!draft.companion.loop}
                              value={draft.companion.interval}
                              onChange={(event) =>
                                setDraft({
                                  ...draft,
                                  companion: {
                                    ...draft.companion,
                                    interval: Number(event.target.value)
                                  }
                                })
                              }
                            />
                            ms
                          </label>
                        </div>
                        <small>
                          主指令成功发送后立即执行一次。勾选循环后，每次发送完成再等待指定间隔；松开按钮即停止。
                          自动发送时跟随启动和停止；组循环中每条主指令附带执行一次。
                        </small>
                        <small>
                          {draft.companion.source === 'custom'
                            ? '自定义内容支持主指令的参数占位符，使用主指令的端口、编码、编程处理及 CRC。'
                            : '使用所选指令自己的端口、参数、编程处理及 CRC；不启动它的自动发送、抬起或其他附带指令。'}
                        </small>
                      </>
                    )}
                  </div>
                </aside>
              </div>
              {error && <p className="form-error">{error}</p>}
            </div>
            <div className="modal-foot">
              <button className="cancel-button" onClick={() => setCreating(false)}>
                取消
              </button>
              <button onClick={createCommand}>
                {editingCommandId === null ? '创建指令' : '保存修改'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})
