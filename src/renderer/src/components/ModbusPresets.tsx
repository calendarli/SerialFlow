import { useEffect, useState } from 'react'
import {
  encodeModbusCommand,
  modbusFormats,
  modbusPresetKey,
  modbusShortcutKey,
  moveItem,
  parseModbusPresets,
  saveModbusCommand,
  type ModbusCommand,
  type ModbusGroup,
  type ModbusPreset
} from '../modbus-presets'

type Props = {
  mode: 'shortcuts' | 'config'
  slave: number
  wordOrder: ModbusPreset['wordOrder']
  connected: boolean
  busy: boolean
  target: string
  onRun: (preset: ModbusPreset, commands: ModbusCommand[]) => Promise<void>
  onCancel: () => void
  onCapture?: () => ModbusPreset
}

export function ModbusPresets({
  mode,
  slave,
  wordOrder,
  connected,
  busy,
  target,
  onRun,
  onCancel,
  onCapture
}: Props): React.JSX.Element {
  const shortcuts = mode === 'shortcuts'
  const storageKey = shortcuts ? modbusShortcutKey : modbusPresetKey
  const [initial] = useState(() => {
    try {
      const stored = parseModbusPresets(localStorage.getItem(storageKey) || '[]')
      return {
        presets:
          shortcuts && !stored.length
            ? [{ id: crypto.randomUUID(), name: '快捷指令', slave, wordOrder, groups: [] }]
            : stored,
        error: ''
      }
    } catch (error) {
      return { presets: [], error: `无法读取已保存配置：${String(error)}。原数据未覆盖。` }
    }
  })
  const [presets, setPresets] = useState<ModbusPreset[]>(initial.presets)
  const [selected, setSelected] = useState(initial.presets[0]?.id || '')
  const [error, setError] = useState(initial.error)
  const [editor, setEditor] = useState<{ group: string; command: ModbusCommand } | null>(null)
  const [drag, setDrag] = useState<{ group: string; command?: string } | null>(null)
  const [dropTarget, setDropTarget] = useState<{
    group: string
    command?: string
    edge: 'before' | 'after' | 'inside'
  } | null>(null)
  const clearDrag = (): void => {
    setDrag(null)
    setDropTarget(null)
  }
  const dropEdge = (event: React.DragEvent<HTMLElement>): 'before' | 'after' => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
  }
  const dropClass = (group: string, command?: string): string =>
    dropTarget?.group === group && dropTarget.command === command
      ? ` is-drop-${dropTarget.edge}`
      : ''
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{
    x: number
    y: number
    group?: string
    command?: string
    list?: boolean
  } | null>(null)
  const [groupEditor, setGroupEditor] = useState<{ id: string; name: string } | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', escape)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', escape)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])
  const openMenu = (event: React.MouseEvent, group?: string, command?: string): void => {
    if (!shortcuts) return
    event.preventDefault()
    event.stopPropagation()
    if (busy || editor || groupEditor) return
    setMenu({
      x: Math.max(0, Math.min(event.clientX, window.innerWidth - 190)),
      y: Math.max(0, Math.min(event.clientY, window.innerHeight - 200)),
      group,
      command
    })
  }
  const openConfigMenu = (event: React.MouseEvent, id?: string): void => {
    event.preventDefault()
    event.stopPropagation()
    if (busy || editor) return
    if (id) setSelected(id)
    setMenu({
      x: Math.max(0, Math.min(event.clientX, window.innerWidth - 190)),
      y: Math.max(0, Math.min(event.clientY, window.innerHeight - 150)),
      list: true
    })
  }
  const selectedPreset = presets.find((item) => item.id === selected)
  const preset = selectedPreset
  const save = (next: ModbusPreset[]): boolean => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
      setPresets(next)
      setError('')
      return true
    } catch {
      setError('配置保存失败，请检查本地存储空间后重试')
      return false
    }
  }
  const update = (next: ModbusPreset): boolean => {
    return save(presets.map((item) => (item.id === next.id ? next : item)))
  }
  const groups = (next: ModbusGroup[]): void => {
    if (preset) update({ ...preset, groups: next })
  }
  const newCommand = (group: string): void =>
    setEditor({
      group,
      command: {
        id: crypto.randomUUID(),
        name: '新指令',
        address: '0',
        value: '0',
        format: 'uint16'
      }
    })
  const commands = preset?.groups.flatMap((group) => group.commands) || []
  const executionPreset = preset && shortcuts ? { ...preset, slave, wordOrder } : preset
  const detail = preset && (
    <div className="modbus-preset-detail">
      <div className="modbus-preset-tools">
        {!shortcuts && (
          <>
            <label>
              配置名称
              <input
                aria-label="配置名称"
                value={preset.name}
                onChange={(event) => update({ ...preset, name: event.target.value })}
              />
            </label>
            <label>
              从站地址
              <input
                aria-label="配置从站地址"
                type="number"
                min={1}
                max={247}
                value={preset.slave}
                onChange={(event) => {
                  const slave = Number(event.target.value)
                  if (Number.isInteger(slave) && slave >= 1 && slave <= 247)
                    update({ ...preset, slave })
                }}
              />
            </label>
            <label>
              字序
              <select
                aria-label="配置字序"
                value={preset.wordOrder}
                onChange={(event) =>
                  update({
                    ...preset,
                    wordOrder: event.target.value as ModbusPreset['wordOrder']
                  })
                }
              >
                <option value="abcd">ABCD</option>
                <option value="cdab">CDAB</option>
              </select>
            </label>
            <button
              className="primary"
              disabled={!connected || !commands.length}
              onClick={() => void onRun(preset, commands)}
            >
              应用并写入配置（{commands.length}）
            </button>
          </>
        )}
        {!shortcuts && (
          <button onClick={() => newCommand(preset.groups[0]?.id || '')}>添加写入项</button>
        )}
      </div>
      <p className="modbus-preset-note">
        {shortcuts
          ? '点击“写入”执行指令，右键管理分组和指令，拖动 ⋮⋮ 排序。使用当前通信设置，自动保存到本机。'
          : '设备参数预设独立保存，不包含左侧快捷指令。应用后按列表顺序写入，失败停止，已写入数据不会回滚。'}
      </p>
      {shortcuts && !preset.groups.length && (
        <p className="empty-rules">在空白处右键添加指令或分组</p>
      )}
      {preset.groups.map((group) => (
        <section
          key={group.id}
          className={`modbus-command-group${dropClass(group.id)}${drag?.group === group.id && !drag.command ? ' is-dragging' : ''}`}
          onContextMenu={(event) => openMenu(event, group.id)}
          onDragOver={(event) => {
            if (busy || !drag) return
            event.preventDefault()
            event.stopPropagation()
            event.dataTransfer.dropEffect = 'move'
            setDropTarget(
              !drag.command && drag.group === group.id
                ? null
                : {
                    group: group.id,
                    edge: drag.command ? 'inside' : dropEdge(event)
                  }
            )
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setDropTarget(null)
          }}
          onDrop={(event) => {
            event.preventDefault()
            if (busy || !drag) return
            event.stopPropagation()
            if (!drag.command)
              groups(moveItem(preset.groups, drag.group, group.id, dropEdge(event)))
            else {
              const command = preset.groups
                .find((item) => item.id === drag.group)
                ?.commands.find((item) => item.id === drag.command)
              if (command)
                groups(
                  preset.groups.map((item) => ({
                    ...item,
                    commands: [
                      ...item.commands.filter((item) => item.id !== command.id),
                      ...(item.id === group.id ? [command] : [])
                    ]
                  }))
                )
            }
            clearDrag()
          }}
        >
          <header>
            <span
              draggable={!busy}
              title="拖动排序分组"
              onDragStart={(event) => {
                event.dataTransfer.setData('text/plain', group.id)
                event.dataTransfer.effectAllowed = 'move'
                setDrag({ group: group.id })
              }}
              onDragEnd={clearDrag}
            >
              ⋮⋮
            </span>
            {shortcuts ? (
              <button
                className="modbus-group-toggle"
                aria-expanded={!collapsedGroups.has(group.id)}
                title="点击展开或折叠"
                onClick={() =>
                  setCollapsedGroups((current) => {
                    const next = new Set(current)
                    if (next.has(group.id)) next.delete(group.id)
                    else next.add(group.id)
                    return next
                  })
                }
              >
                <span className="group-arrow">{collapsedGroups.has(group.id) ? '▸' : '▾'}</span>
                <b className="folder-icon">▰</b>
                <strong>{group.name}</strong>
                <em>{group.commands.length} 条指令</em>
              </button>
            ) : (
              <input
                aria-label="分组名称"
                value={group.name}
                onChange={(event) =>
                  groups(
                    preset.groups.map((item) =>
                      item.id === group.id ? { ...item, name: event.target.value } : item
                    )
                  )
                }
              />
            )}
            {!shortcuts && (
              <>
                <button onClick={() => newCommand(group.id)}>添加指令</button>
                <button
                  onClick={() => groups(preset.groups.filter((item) => item.id !== group.id))}
                >
                  删除分组
                </button>
              </>
            )}
          </header>
          {!collapsedGroups.has(group.id) && group.commands.length === 0 && (
            <p>
              {shortcuts ? '右键添加指令，或拖入已有指令。' : '暂无指令，添加指令或拖入已有指令。'}
            </p>
          )}
          {(collapsedGroups.has(group.id) ? [] : group.commands).map((command) => (
            <div
              key={command.id}
              className={`modbus-command-row${dropClass(group.id, command.id)}${drag?.command === command.id ? ' is-dragging' : ''}`}
              onContextMenu={(event) => openMenu(event, group.id, command.id)}
              onDragOver={(event) => {
                if (busy || !drag?.command) return
                event.preventDefault()
                event.stopPropagation()
                event.dataTransfer.dropEffect = 'move'
                setDropTarget(
                  drag.command === command.id
                    ? null
                    : {
                        group: group.id,
                        command: command.id,
                        edge: dropEdge(event)
                      }
                )
              }}
              onDrop={(event) => {
                if (busy || !drag?.command) return
                event.preventDefault()
                event.stopPropagation()
                const source = preset.groups
                  .find((item) => item.id === drag.group)
                  ?.commands.find((item) => item.id === drag.command)
                if (!source) return
                groups(
                  preset.groups.map((item) => {
                    if (drag.group === group.id)
                      return item.id === group.id
                        ? {
                            ...item,
                            commands: moveItem(
                              item.commands,
                              source.id,
                              command.id,
                              dropEdge(event)
                            )
                          }
                        : item
                    const next = item.commands.filter((item) => item.id !== source.id)
                    if (item.id === group.id)
                      next.splice(
                        next.findIndex((item) => item.id === command.id) +
                          (dropEdge(event) === 'after' ? 1 : 0),
                        0,
                        source
                      )
                    return { ...item, commands: next }
                  })
                )
                clearDrag()
              }}
            >
              <span
                draggable={!busy}
                title="拖动排序指令"
                onDragStart={(event) => {
                  event.stopPropagation()
                  event.dataTransfer.setData('text/plain', command.id)
                  event.dataTransfer.effectAllowed = 'move'
                  setDrag({ group: group.id, command: command.id })
                }}
                onDragEnd={clearDrag}
              >
                ⋮⋮
              </span>
              <strong className="modbus-command-name">{command.name}</strong>
              {shortcuts && (
                <button
                  className="modbus-command-trigger"
                  aria-label={`写入 ${command.name}`}
                  disabled={!connected}
                  onClick={() => executionPreset && void onRun(executionPreset, [command])}
                >
                  写入
                </button>
              )}
              <span>地址 {command.address}</span>
              <code>{command.value}</code>
              <span>{command.format.toUpperCase()}</span>
              {!shortcuts && (
                <button disabled={!connected} onClick={() => void onRun(preset, [command])}>
                  写入
                </button>
              )}
              {!shortcuts && (
                <>
                  <button onClick={() => setEditor({ group: group.id, command: { ...command } })}>
                    编辑
                  </button>
                  <button
                    onClick={() =>
                      groups(
                        preset.groups.map((item) =>
                          item.id === group.id
                            ? {
                                ...item,
                                commands: item.commands.filter((item) => item.id !== command.id)
                              }
                            : item
                        )
                      )
                    }
                  >
                    删除
                  </button>
                </>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  )
  return (
    <section
      className={`modbus-presets modbus-presets-${mode}`}
      aria-label={shortcuts ? 'Modbus 快捷指令' : 'Modbus 配置管理器'}
      onContextMenu={(event) => openMenu(event)}
    >
      <header>
        <strong>{shortcuts ? '快捷指令' : '设备配置'}</strong>
        <span>
          当前串口：{target || '未连接'}
          {shortcuts ? ` · ID ${slave} · ${wordOrder.toUpperCase()}` : ''}
        </span>
      </header>
      {error && <p role="alert">{error}</p>}
      <fieldset disabled={busy}>
        {!shortcuts && (
          <div className="modbus-config-list-pane" onContextMenu={(event) => openConfigMenu(event)}>
            <p className="modbus-preset-note">右键保存主页当前寄存器地址和数据，或删除已有配置</p>
            <div className="modbus-preset-list">
              <table aria-label="设备配置列表">
                <thead>
                  <tr>
                    <th>配置名称</th>
                    <th>从站</th>
                    <th>字序</th>
                    <th>写入项</th>
                  </tr>
                </thead>
                <tbody>
                  {presets.map((item) => (
                    <tr
                      key={item.id}
                      className={item.id === selected ? 'selected' : ''}
                      aria-disabled={busy}
                      onClick={() => {
                        if (busy) return
                        setSelected(item.id)
                        setEditor(null)
                      }}
                      onContextMenu={(event) => openConfigMenu(event, item.id)}
                    >
                      <td>
                        <button aria-pressed={item.id === selected}>
                          {item.name || '未命名配置'}
                        </button>
                      </td>
                      <td>{item.slave}</td>
                      <td>{item.wordOrder.toUpperCase()}</td>
                      <td>
                        {item.groups.reduce((count, group) => count + group.commands.length, 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!presets.length && <p>暂无设备配置，读取主页寄存器数据后右键保存。</p>}
            </div>
          </div>
        )}
        {shortcuts && detail}
        {!shortcuts && !preset && (
          <p className="modbus-config-empty">选择配置后可应用并写入设备。</p>
        )}
      </fieldset>
      {!shortcuts && selectedPreset && (
        <button
          className="primary"
          disabled={
            busy || !connected || !selectedPreset.groups.some((group) => group.commands.length)
          }
          onClick={() =>
            void onRun(
              selectedPreset,
              selectedPreset.groups.flatMap((group) => group.commands)
            )
          }
        >
          应用并写入配置（
          {selectedPreset.groups.reduce((count, group) => count + group.commands.length, 0)}）
        </button>
      )}
      {busy && <button onClick={onCancel}>停止写入</button>}
      {menu && (preset || menu.list) && !busy && (
        <div
          className="context-menu modbus-shortcut-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          {menu.list ? (
            <>
              <button
                onClick={() => {
                  try {
                    if (!onCapture) return
                    const item = onCapture()
                    const baseName = item.name
                    let suffix = 2
                    while (presets.some((preset) => preset.name === item.name))
                      item.name = `${baseName} (${suffix++})`
                    if (save([...presets, item])) setSelected(item.id)
                  } catch (error) {
                    setError(error instanceof Error ? error.message : String(error))
                  }
                }}
              >
                保存配置
              </button>
              {preset && (
                <>
                  <button
                    onClick={() => {
                      const next = presets.filter((item) => item.id !== preset.id)
                      if (save(next)) {
                        setSelected(next[0]?.id || '')
                        setEditor(null)
                      }
                    }}
                  >
                    删除配置
                  </button>
                </>
              )}
            </>
          ) : (
            preset && (
              <>
                <button
                  role="menuitem"
                  onClick={() => setGroupEditor({ id: crypto.randomUUID(), name: '新分组' })}
                >
                  添加分组
                </button>
                <button role="menuitem" onClick={() => newCommand(menu.group || '')}>
                  添加指令
                </button>
                {menu.group && (
                  <>
                    {!menu.command && (
                      <>
                        <button
                          role="menuitem"
                          onClick={() => {
                            const group = preset.groups.find((item) => item.id === menu.group)
                            if (group) setGroupEditor({ id: group.id, name: group.name })
                          }}
                        >
                          重命名分组
                        </button>
                        <button
                          role="menuitem"
                          className="danger"
                          onClick={() =>
                            groups(preset.groups.filter((item) => item.id !== menu.group))
                          }
                        >
                          删除分组
                        </button>
                      </>
                    )}
                    {menu.command && (
                      <>
                        <button
                          role="menuitem"
                          onClick={() => {
                            const command = preset.groups
                              .find((item) => item.id === menu.group)
                              ?.commands.find((item) => item.id === menu.command)
                            if (command) setEditor({ group: menu.group!, command: { ...command } })
                          }}
                        >
                          编辑指令
                        </button>
                        <button
                          role="menuitem"
                          className="danger"
                          onClick={() =>
                            groups(
                              preset.groups.map((group) =>
                                group.id === menu.group
                                  ? {
                                      ...group,
                                      commands: group.commands.filter(
                                        (item) => item.id !== menu.command
                                      )
                                    }
                                  : group
                              )
                            )
                          }
                        >
                          删除指令
                        </button>
                      </>
                    )}
                  </>
                )}
              </>
            )
          )}
        </div>
      )}
      {groupEditor && preset && (
        <div className="modbus-dialog-backdrop" onContextMenu={(event) => event.stopPropagation()}>
          <form
            className="modbus-dialog"
            role="dialog"
            aria-label="分组编辑"
            onSubmit={(event) => {
              event.preventDefault()
              if (!groupEditor.name.trim()) return setError('请输入分组名称')
              const existing = preset.groups.some((group) => group.id === groupEditor.id)
              const next = existing
                ? preset.groups.map((group) =>
                    group.id === groupEditor.id
                      ? { ...group, name: groupEditor.name.trim() }
                      : group
                  )
                : [
                    ...preset.groups,
                    { ...groupEditor, name: groupEditor.name.trim(), commands: [] }
                  ]
              if (update({ ...preset, groups: next })) setGroupEditor(null)
            }}
          >
            <header>
              <strong>分组名称</strong>
            </header>
            <label>
              名称
              <input
                aria-label="分组名称"
                autoFocus
                value={groupEditor.name}
                onChange={(event) => setGroupEditor({ ...groupEditor, name: event.target.value })}
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <footer>
              <button type="button" onClick={() => setGroupEditor(null)}>
                取消
              </button>
              <button type="submit" className="primary">
                保存分组
              </button>
            </footer>
          </form>
        </div>
      )}
      {editor && preset && (
        <div className="modbus-dialog-backdrop">
          <form
            className="modbus-dialog"
            role="dialog"
            aria-label="快捷指令编辑"
            onSubmit={(event) => {
              event.preventDefault()
              try {
                if (!editor.command.name.trim()) throw new Error('请输入指令名称')
                encodeModbusCommand(editor.command, preset.slave, preset.wordOrder)
                const next = saveModbusCommand(preset.groups, editor.group, editor.command)
                if (update({ ...preset, groups: next })) setEditor(null)
              } catch (error) {
                setError(error instanceof Error ? error.message : String(error))
              }
            }}
          >
            <header>
              <strong>{shortcuts ? '快捷指令' : '配置写入项'}</strong>
            </header>
            {error && <p role="alert">{error}</p>}
            {shortcuts && (
              <label>
                所属分组
                <select
                  aria-label="指令分组"
                  value={editor.group}
                  onChange={(event) => setEditor({ ...editor, group: event.target.value })}
                >
                  <option value="">未分组</option>
                  {preset.groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(['name', 'address', 'value'] as const).map((key) => (
              <label key={key}>
                {key === 'name' ? '名称' : key === 'address' ? '寄存器地址（从 0 开始）' : '数据'}
                <input
                  autoFocus={key === 'name'}
                  aria-label={`指令${key === 'name' ? '名称' : key === 'address' ? '地址' : '数据'}`}
                  value={editor.command[key]}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      command: { ...editor.command, [key]: event.target.value }
                    })
                  }
                />
              </label>
            ))}
            <label>
              数据类型
              <select
                aria-label="指令数据类型"
                value={editor.command.format}
                onChange={(event) =>
                  setEditor({
                    ...editor,
                    command: {
                      ...editor.command,
                      format: event.target.value as ModbusCommand['format']
                    }
                  })
                }
              >
                {modbusFormats.map((format) => (
                  <option key={format} value={format}>
                    {format.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <p>地址与整数数据支持十进制或 0x 前缀十六进制；32 位数据占用连续两个寄存器。</p>
            <footer>
              <button
                type="button"
                onClick={() => {
                  setEditor(null)
                  setError('')
                }}
              >
                取消
              </button>
              <button type="submit" className="primary">
                保存指令
              </button>
            </footer>
          </form>
        </div>
      )}
    </section>
  )
}
