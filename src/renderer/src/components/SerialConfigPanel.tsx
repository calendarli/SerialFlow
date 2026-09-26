import { useState } from 'react'
import { serialPortLabel } from '@common/serial-port'
import type { DataBits, Parity, Port, SerialConfig, StopBits } from '../types'

type Props = {
  ports: Port[]
  configs: SerialConfig[]
  openedPorts: Set<string>
  busy: boolean
  onChange: (id: number, patch: Partial<SerialConfig>) => void
  onAdd: () => void
  onRemove: (id: number) => void
  onRefresh: () => void
  onToggle: (config: SerialConfig) => void
  onDataBitsChange: (config: SerialConfig, value: DataBits) => void
  onImportProject: () => void
  onExportProject: () => void
}

const baudRates = [
  9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 1500000, 2000000, 3000000
]

export function SerialConfigPanel(props: Props): React.JSX.Element {
  const [collapsedIds, setCollapsedIds] = useState<Set<number>>(new Set())
  return (
    <div className="serial-config-content multi-serial-config">
      <div className="panel-title">
        <span>多串口配置</span>
        <div>
          <button className="project-button" title="导入工程" onClick={props.onImportProject}>
            导入
          </button>
          <button className="project-button" title="导出工程" onClick={props.onExportProject}>
            导出
          </button>
          <button
            className="icon-button"
            title="刷新串口"
            disabled={props.busy}
            onClick={props.onRefresh}
          >
            ↻
          </button>
          <button
            className="icon-button add-port"
            title="添加串口配置"
            disabled={props.busy}
            onClick={props.onAdd}
          >
            ＋
          </button>
        </div>
      </div>
      <div className="serial-profile-list">
        {props.configs.map((config, index) => {
          const isOpen = props.openedPorts.has(config.path)
          const disabled = isOpen || props.busy
          const isCollapsed = collapsedIds.has(config.id)
          return (
            <section
              className={`serial-profile ${isOpen ? 'open' : ''} ${isCollapsed ? 'collapsed' : ''}`}
              key={config.id}
            >
              <div className="serial-profile-head">
                <button
                  className="serial-collapse-button"
                  title={isCollapsed ? '展开配置' : '收起配置'}
                  onClick={() =>
                    setCollapsedIds((current) => {
                      const next = new Set(current)
                      if (next.has(config.id)) next.delete(config.id)
                      else next.add(config.id)
                      return next
                    })
                  }
                >
                  {isCollapsed ? '▸' : '▾'}
                </button>
                <input
                  className="serial-group-name"
                  aria-label={`串口组 ${index + 1} 名称`}
                  value={config.name}
                  placeholder={`串口组 ${index + 1}`}
                  onChange={(event) => props.onChange(config.id, { name: event.target.value })}
                />
                <span>{isOpen ? '已打开' : '未打开'}</span>
                <button
                  className="serial-remove-button"
                  title="删除配置"
                  disabled={disabled || props.configs.length === 1}
                  onClick={() => props.onRemove(config.id)}
                >
                  ×
                </button>
              </div>
              {!isCollapsed && (
                <>
                  <label>
                    端口
                    <select
                      className={`serial-port-select ${isOpen ? 'port-open' : ''}`}
                      value={config.path}
                      disabled={disabled}
                      onChange={(event) => props.onChange(config.id, { path: event.target.value })}
                    >
                      <option value="">选择串口</option>
                      {config.path && !props.ports.some((port) => port.path === config.path) && (
                        <option value={config.path}>{config.path} · 设备已断开</option>
                      )}
                      {props.ports.map((port) => (
                        <option
                          key={port.path}
                          value={port.path}
                          className={props.openedPorts.has(port.path) ? 'port-open' : 'port-closed'}
                          disabled={props.configs.some(
                            (item) => item.id !== config.id && item.path === port.path
                          )}
                        >
                          {serialPortLabel(port)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    波特率
                    <select
                      value={config.baudRate}
                      disabled={disabled}
                      onChange={(event) =>
                        props.onChange(config.id, { baudRate: Number(event.target.value) })
                      }
                    >
                      {baudRates.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <div className="grid-two">
                    <label>
                      数据位
                      <select
                        value={config.dataBits}
                        disabled={disabled}
                        onChange={(event) =>
                          props.onDataBitsChange(config, Number(event.target.value) as DataBits)
                        }
                      >
                        {[5, 6, 7, 8].map((value) => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      停止位
                      <select
                        value={config.stopBits}
                        disabled={disabled}
                        onChange={(event) =>
                          props.onChange(config.id, {
                            stopBits: Number(event.target.value) as StopBits
                          })
                        }
                      >
                        <option value={1}>1</option>
                        {config.dataBits === 5 && <option value={1.5}>1.5</option>}
                        {config.dataBits !== 5 && <option value={2}>2</option>}
                      </select>
                    </label>
                  </div>
                  <label>
                    校验位
                    <select
                      value={config.parity}
                      disabled={disabled}
                      onChange={(event) =>
                        props.onChange(config.id, { parity: event.target.value as Parity })
                      }
                    >
                      <option value="none">无校验</option>
                      <option value="even">偶校验</option>
                      <option value="odd">奇校验</option>
                      <option value="mark">Mark</option>
                      <option value="space">Space</option>
                    </select>
                  </label>
                  <div className="serial-plot-setting">
                    <label>
                      <input
                        type="checkbox"
                        checked={config.plotEnabled}
                        onChange={(event) =>
                          props.onChange(config.id, { plotEnabled: event.target.checked })
                        }
                      />
                      接收数据绘制曲线
                    </label>
                    <span
                      className="regex-help plot-data-help"
                      tabIndex={0}
                      aria-label="曲线数据格式说明"
                      title="查看曲线数据格式说明"
                      data-tooltip={
                        '仅绘制该端口接收到的 RX 数值文本。\n命名格式：PWM=10, PID=-2.5（也支持冒号）\n顺序格式：10,20,30 或 10 20 30（显示为 CH1～CH8）\n每帧最多 8 个通道，请用接收分帧得到完整数据帧；二进制 HEX 帧不能直接绘制。'
                      }
                    >
                      ?
                    </span>
                  </div>
                  <button
                    className={`connect ${isOpen ? 'disconnect' : ''}`}
                    disabled={props.busy || !config.path}
                    onClick={() => props.onToggle(config)}
                  >
                    {props.busy ? '正在处理…' : isOpen ? '关闭此串口' : '打开此串口'}
                  </button>
                </>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
