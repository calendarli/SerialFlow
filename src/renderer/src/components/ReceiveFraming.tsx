import { ChevronRight, Layers3 } from 'lucide-react'
import type { SerialConfig, SerialFramingMode } from '../types'
import type { GlobalSerialFraming } from '../receive-framing-settings'

type Props = {
  configs: SerialConfig[]
  onChange: (patch: Partial<GlobalSerialFraming>) => void
  onFixedLengthChange: (id: number, length: number) => void
}

export function ReceiveFraming(props: Props): React.JSX.Element {
  const config = props.configs[0]
  if (!config) return <></>
  const modeLabels: Record<SerialFramingMode, string> = {
    raw: '原始数据块',
    delimiter: '分隔符',
    fixed: '固定长度',
    'header-footer': '帧头 + 帧尾',
    idle: '空闲超时'
  }
  const summary =
    config.framing.mode === 'idle'
      ? '空闲 ' + config.framing.idleTimeout + ' ms'
      : config.framing.mode === 'fixed'
        ? '固定长度 · 按串口设置'
        : modeLabels[config.framing.mode]
  return (
    <details className="receive-framing">
      <summary>
        <Layers3 size={15} className="framing-icon" aria-hidden="true" />
        <strong>接收分帧</strong>
        <span className="framing-scope">全局</span>
        <span className="framing-summary">{summary}</span>
        <ChevronRight size={15} className="framing-chevron" aria-hidden="true" />
      </summary>
      <div className="receive-framing-body">
        <fieldset className="serial-framing-settings" aria-label="接收分帧参数">
          <label className="framing-mode">
            <span>分帧方式</span>
            <select
              value={config.framing.mode}
              onChange={(event) =>
                props.onChange({ mode: event.target.value as SerialFramingMode })
              }
            >
              <option value="raw">原始数据块</option>
              <option value="delimiter">分隔符</option>
              <option value="fixed">固定长度</option>
              <option value="header-footer">帧头 + 帧尾</option>
              <option value="idle">空闲超时</option>
            </select>
          </label>
          {config.framing.mode === 'delimiter' && (
            <label className="framing-parameter">
              <span>分隔符</span>
              <input
                value={config.framing.delimiter}
                placeholder="例如 \\r\\n"
                onChange={(event) => props.onChange({ delimiter: event.target.value })}
              />
            </label>
          )}
          {config.framing.mode === 'fixed' &&
            props.configs.map((item) => (
              <label
                className="framing-port-length"
                key={item.id}
                title={`${item.name} · ${item.path || '未选择端口'} · 每帧字节数`}
              >
                <span className="framing-port-name">
                  {item.name}
                  <small>{item.path || '未选择端口'}</small>
                </span>
                <input
                  type="number"
                  min="1"
                  max="1048576"
                  aria-label={`${item.name}每帧字节数`}
                  value={item.framing.fixedLength}
                  onChange={(event) =>
                    props.onFixedLengthChange(
                      item.id,
                      Math.min(1048576, Math.max(1, Math.floor(Number(event.target.value) || 1)))
                    )
                  }
                />
                <span className="framing-unit">字节</span>
              </label>
            ))}
          {config.framing.mode === 'header-footer' && (
            <>
              <label className="framing-parameter">
                <span>
                  帧头 <small>HEX</small>
                </span>
                <input
                  value={config.framing.header}
                  onChange={(event) => props.onChange({ header: event.target.value })}
                />
              </label>
              <label className="framing-parameter">
                <span>
                  帧尾 <small>HEX</small>
                </span>
                <input
                  value={config.framing.footer}
                  onChange={(event) => props.onChange({ footer: event.target.value })}
                />
              </label>
            </>
          )}
          {config.framing.mode === 'idle' && (
            <label className="framing-parameter">
              <span>
                空闲时间 <small>ms</small>
              </span>
              <input
                type="number"
                min="1"
                max="60000"
                value={config.framing.idleTimeout}
                onChange={(event) =>
                  props.onChange({
                    idleTimeout: Math.min(
                      60000,
                      Math.max(1, Math.floor(Number(event.target.value) || 1))
                    )
                  })
                }
              />
            </label>
          )}
          {config.framing.mode === 'raw' && (
            <p className="framing-hint">直接处理收到的数据块，无需额外参数。</p>
          )}
        </fieldset>
      </div>
    </details>
  )
}
