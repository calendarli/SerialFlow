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
        接收分帧 <span>全局 · {summary}</span>
      </summary>
      <div className="receive-framing-body">
        <fieldset className="serial-framing-settings">
          <legend>接收分帧</legend>
          <label>
            方式
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
            <label>
              分隔符
              <input
                value={config.framing.delimiter}
                placeholder="例如 \\r\\n"
                onChange={(event) => props.onChange({ delimiter: event.target.value })}
              />
            </label>
          )}
          {config.framing.mode === 'fixed' &&
            props.configs.map((item) => (
              <label key={item.id}>
                {item.name} · {item.path || '未选择端口'} · 每帧字节数
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
              </label>
            ))}
          {config.framing.mode === 'header-footer' && (
            <div className="grid-two">
              <label>
                帧头 HEX
                <input
                  value={config.framing.header}
                  onChange={(event) => props.onChange({ header: event.target.value })}
                />
              </label>
              <label>
                帧尾 HEX
                <input
                  value={config.framing.footer}
                  onChange={(event) => props.onChange({ footer: event.target.value })}
                />
              </label>
            </div>
          )}
          {config.framing.mode === 'idle' && (
            <label>
              空闲时间（ms）
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
          <small>
            所有串口共用分帧规则，仅固定长度按串口设置。分帧后再进行显示、条件暂停和自动回复匹配。
          </small>
        </fieldset>
      </div>
    </details>
  )
}
