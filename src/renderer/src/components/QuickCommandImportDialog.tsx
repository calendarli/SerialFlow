import { useState } from 'react'
import type { QuickCommandImport, QuickCommandImportOptions } from '../quick-command-import'

type Props = {
  imported: QuickCommandImport
  defaultGroupName: string
  onConfirm: (options: QuickCommandImportOptions) => void
  onCancel: () => void
}

export function QuickCommandImportDialog(props: Props): React.JSX.Element {
  const [mode, setMode] = useState<'group' | 'replace'>('group')
  const [groupName, setGroupName] = useState(props.defaultGroupName)
  return (
    <div
      className="modal-backdrop rule-create-backdrop"
      onContextMenu={(event) => event.stopPropagation()}
    >
      <form
        className="modal group-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-import-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') props.onCancel()
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (mode === 'group' && !groupName.trim()) return
          props.onConfirm(mode === 'group' ? { mode, groupName: groupName.trim() } : { mode })
        }}
      >
        <div className="modal-head">
          <div>
            <h2 id="command-import-title">导入快捷指令</h2>
            <p>
              {props.imported.source} · {props.imported.commands.length} 条指令 ·{' '}
              {props.imported.groups.length} 个分组
            </p>
          </div>
          <button type="button" aria-label="关闭导入" onClick={props.onCancel}>
            ×
          </button>
        </div>
        <div className="create-rule-form">
          <label>
            导入方式
            <select
              autoFocus
              value={mode}
              onChange={(event) => setMode(event.target.value as 'group' | 'replace')}
            >
              <option value="group">导入为一个新的组</option>
              <option value="replace">替换现有的所有指令和分组</option>
            </select>
          </label>
          {mode === 'group' ? (
            <>
              <label>
                新组名称
                <input
                  required
                  value={groupName}
                  placeholder="例如：电机调试"
                  onChange={(event) => setGroupName(event.target.value)}
                />
              </label>
              <p>
                保留现有指令。文件中的顶层指令和分组将作为新组的子命令和子组，原有嵌套结构保持不变。
              </p>
            </>
          ) : (
            <p className="form-error">确认导入后，当前全部快捷指令和分组将被文件中的内容替换。</p>
          )}
          {props.imported.source !== 'SerialFlow' && <p>导入的指令默认使用当前串口。</p>}
          {props.imported.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
        <div className="modal-foot">
          <button type="button" className="cancel-button" onClick={props.onCancel}>
            取消
          </button>
          <button type="submit" disabled={mode === 'group' && !groupName.trim()}>
            {mode === 'group' ? '导入到新组' : '确认替换全部'}
          </button>
        </div>
      </form>
    </div>
  )
}
