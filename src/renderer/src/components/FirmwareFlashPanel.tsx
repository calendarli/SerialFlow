import { memo, useEffect, useRef, useState } from 'react'
import {
  espChips,
  type FirmwareFamily,
  type FirmwareRequest,
  type FirmwareState,
  type FirmwareTool
} from '@common/firmware'

import { serialPortLabel, type SerialPortInfo } from '@common/serial-port'

const storageKey = 'serialflow.firmware.settings.v1'
const defaults: FirmwareRequest = {
  family: 'stm32',
  transport: 'uart',
  port: '',
  probe: '',
  chip: 'auto',
  baudRate: 115200,
  files: [],
  verify: true,
  reset: true,
  restorePort: false,
  eraseAll: false,
  manualBoot: false,
  connectMode: 'NORMAL',
  toolPath: ''
}
function loadSettings(): { request: FirmwareRequest; tools: Record<FirmwareFamily, string> } {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}')
    const family = saved.family === 'esp32' ? 'esp32' : 'stm32'
    const tools = {
      stm32: typeof saved.tools?.stm32 === 'string' ? saved.tools.stm32 : '',
      esp32: typeof saved.tools?.esp32 === 'string' ? saved.tools.esp32 : ''
    }
    return {
      tools,
      request: {
        ...defaults,
        family,
        transport:
          family === 'stm32' && ['swd', 'ymodem'].includes(saved.transport)
            ? saved.transport
            : 'uart',
        baudRate:
          Number.isInteger(saved.baudRate) && saved.baudRate >= 1200 && saved.baudRate <= 3000000
            ? saved.baudRate
            : 115200,
        chip: espChips.includes(saved.chip) ? saved.chip : 'auto',
        verify: saved.transport === 'ymodem' ? false : saved.verify !== false,
        reset: saved.transport === 'ymodem' ? false : saved.reset !== false,
        restorePort: saved.restorePort === true,
        manualBoot: saved.manualBoot === true,
        connectMode: saved.connectMode === 'UR' ? 'UR' : 'NORMAL',
        toolPath: tools[family]
      }
    }
  } catch {
    return { request: defaults, tools: { stm32: '', esp32: '' } }
  }
}
const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    ''
  )
const formatBytes = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`

export const FirmwareFlashPanel = memo(function FirmwareFlashPanel(): React.JSX.Element {
  const [initial] = useState(loadSettings)
  const [request, setRequest] = useState(initial.request)
  const [toolPaths, setToolPaths] = useState(initial.tools)
  const [ports, setPorts] = useState<SerialPortInfo[]>([])
  const [probes, setProbes] = useState<string[]>([])
  const [tool, setTool] = useState<FirmwareTool | null>(null)
  const [state, setState] = useState<FirmwareState | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const logRef = useRef<HTMLPreElement>(null)
  const toolSequence = useRef(0)
  const busy = pending || Boolean(state?.busy)
  const serial = request.transport !== 'swd'
  const ymodem = request.transport === 'ymodem'
  const stm = request.family === 'stm32'
  const patch = (values: Partial<FirmwareRequest>): void =>
    setRequest((current) => ({ ...current, ...values }))
  const perform = async (work: () => Promise<void>): Promise<void> => {
    setPending(true)
    setError('')
    try {
      await work()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setPending(false)
    }
  }

  useEffect(() => {
    let alive = true
    let received = false
    const unsubscribePorts = window.api.onPortsChanged(setPorts)
    const unsubscribe = window.api.onFirmwareProgress((next) => {
      received = true
      setState(next)
      if (next.outcome === 'error' || (next.operation === 'detect' && !next.busy)) setShowLogs(true)
    })
    void window.api
      .getFirmwareState()
      .then((next) => {
        if (alive && !received) setState(next)
      })
      .catch((cause) => {
        if (alive) setError(errorText(cause))
      })
    void window.api
      .listPorts()
      .then((next) => {
        if (alive) setPorts(next)
      })
      .catch((cause) => {
        if (alive) setError(errorText(cause))
      })
    return () => {
      alive = false
      unsubscribe()
      unsubscribePorts()
    }
  }, [])

  useEffect(() => {
    const sequence = ++toolSequence.current
    if (request.transport === 'ymodem') {
      setTool(null)
      return
    }
    void window.api
      .getFirmwareTool(request.family, request.toolPath)
      .then((next) => {
        if (sequence === toolSequence.current) setTool(next)
      })
      .catch((cause) => {
        if (sequence === toolSequence.current) setError(errorText(cause))
      })
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- This is a request generation counter, not a DOM ref; invalidate pending requests.
      toolSequence.current++
    }
  }, [request.family, request.toolPath, request.transport])

  useEffect(() => {
    const settings = {
      family: request.family,
      transport: request.transport,
      baudRate: request.baudRate,
      chip: request.chip,
      verify: request.verify,
      reset: request.reset,
      restorePort: request.restorePort,
      manualBoot: request.manualBoot,
      connectMode: request.connectMode
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify({ ...settings, tools: toolPaths }))
    } catch {
      /* Optional preference persistence. */
    }
  }, [request, toolPaths])
  useEffect(() => {
    if (!state?.busy) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [state?.busy])
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [state?.logs, showLogs])

  const changeFamily = (family: FirmwareFamily): void => {
    setTool(null)
    patch({ family, transport: 'uart', files: [], toolPath: toolPaths[family], eraseAll: false })
    setError('')
  }
  const refresh = (): Promise<void> =>
    perform(async () => {
      if (serial) setPorts(await window.api.listPorts())
      else {
        const next = await window.api.listFirmwareProbes(request.toolPath)
        setProbes(next)
        patch({
          probe: next.includes(request.probe) ? request.probe : next.length === 1 ? next[0] : ''
        })
        if (!next.length) setError('未检测到 ST-LINK，请检查连接、供电与驱动')
      }
    })
  const chooseFiles = (): Promise<void> =>
    perform(async () => {
      const files = await window.api.chooseFirmwareFiles(request.family, request.transport)
      if (files.length) patch({ files: stm ? files : [...request.files, ...files].slice(0, 16) })
    })
  const chooseTool = (): Promise<void> =>
    perform(async () => {
      const path = await window.api.chooseFirmwareTool(request.family)
      if (path) {
        setTool(null)
        setToolPaths((current) => ({ ...current, [request.family]: path }))
        patch({ toolPath: path })
      }
    })
  const start = (operation: 'detect' | 'flash'): Promise<void> =>
    perform(async () => {
      const id = await window.api.startFirmware(request, operation)
      if (id) {
        setState(await window.api.getFirmwareState())
        setShowLogs(operation === 'detect')
      }
    })
  const targetReady = serial
    ? ports.some((port) => port.path === request.port)
    : Boolean(request.probe)
  const filesReady =
    request.files.length > 0 &&
    request.files.every((file) =>
      ymodem
        ? /\.bin$/i.test(file.path)
        : /\.hex$/i.test(file.path) || /^(0x[0-9a-f]+|\d+)$/i.test(file.address.trim())
    )
  const elapsed = state
    ? Math.max(0, Math.round(((state.finishedAt || now) - state.startedAt) / 1000))
    : 0
  const progressPercent =
    state?.percent ??
    (state?.totalBytes !== undefined && state.transferredBytes !== undefined
      ? Math.floor((state.transferredBytes * 100) / state.totalBytes)
      : null)
  const statusTone = error ? 'error' : state?.busy ? 'active' : state?.outcome || 'idle'
  const statusLabel = error || state?.phase || '就绪：选择设备与固件后开始烧录'
  const statusIcon =
    statusTone === 'success'
      ? '✓'
      : statusTone === 'error'
        ? '!'
        : statusTone === 'cancelled'
          ? '×'
          : '•'

  return (
    <section className="firmware-panel" aria-label="固件烧录">
      <div className="firmware-scroll">
        <fieldset disabled={busy} className="firmware-fields">
          <div className="firmware-row">
            <label>
              芯片
              <select
                aria-label="芯片系列"
                value={request.family}
                onChange={(e) => changeFamily(e.target.value as FirmwareFamily)}
              >
                <option value="stm32">STM32</option>
                <option value="esp32">ESP32 系列</option>
              </select>
            </label>
            <label>
              方式
              <select
                aria-label="烧录方式"
                value={request.transport}
                onChange={(e) => {
                  const transport = e.target.value as FirmwareRequest['transport']
                  patch({
                    transport,
                    files: [],
                    verify: transport !== 'ymodem',
                    reset: false,
                    eraseAll: false
                  })
                }}
              >
                <option value="uart">UART（芯片内置）</option>
                {stm && <option value="ymodem">Ymodem（设备升级）</option>}
                {stm && <option value="swd">ST-LINK / SWD</option>}
              </select>
            </label>
            {serial ? (
              <label>
                端口
                <select
                  aria-label="烧录串口"
                  value={request.port}
                  onChange={(e) => patch({ port: e.target.value })}
                >
                  <option value="">选择串口</option>
                  {request.port && !ports.some((port) => port.path === request.port) && (
                    <option value={request.port}>{request.port} · 设备已断开</option>
                  )}
                  {ports.map((port) => (
                    <option key={port.path} value={port.path}>
                      {serialPortLabel(port)}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                探针
                <select
                  aria-label="ST-LINK 探针"
                  value={request.probe}
                  onChange={(e) => patch({ probe: e.target.value })}
                >
                  <option value="">选择探针</option>
                  {probes.map((probe) => (
                    <option key={probe}>{probe}</option>
                  ))}
                </select>
              </label>
            )}
            <button onClick={() => void refresh()}>刷新</button>
            {!stm && (
              <label>
                型号
                <select
                  aria-label="ESP32 型号"
                  value={request.chip}
                  onChange={(e) => patch({ chip: e.target.value })}
                >
                  {espChips.map((chip) => (
                    <option key={chip} value={chip}>
                      {chip === 'auto' ? '自动识别' : chip.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button onClick={() => void chooseFiles()}>{stm ? '选择固件' : '添加 BIN'}</button>
            <button
              className="firmware-link"
              aria-expanded={advanced}
              onClick={() => setAdvanced(!advanced)}
            >
              高级设置 {advanced ? '▴' : '▾'}
            </button>
          </div>
          {request.files.length === 0 ? (
            <p className="firmware-hint">
              {stm
                ? ymodem
                  ? '请选择 BIN 固件；设备 Bootloader 决定写入地址。'
                  : '请选择 HEX 或 BIN 固件，HEX 地址从文件读取。'
                : '添加一个合并 BIN，或多个分区 BIN；请按构建产物填写每个文件的写入地址。'}
            </p>
          ) : (
            <div className="firmware-files">
              {request.files.map((file, index) => (
                <div className="firmware-file" key={`${file.path}-${index}`}>
                  <span title={file.path}>
                    {file.name} <small>{(file.size / 1024).toFixed(1)} KB</small>
                  </span>
                  {!ymodem && (
                    <label>
                      地址
                      {stm && /\.hex$/i.test(file.path) ? (
                        <span className="firmware-auto-address">从 HEX 读取</span>
                      ) : (
                        <input
                          aria-label={`${file.name} 写入地址`}
                          value={file.address}
                          placeholder="0x…（按构建配置）"
                          onChange={(e) =>
                            patch({
                              files: request.files.map((f, i) =>
                                i === index ? { ...f, address: e.target.value } : f
                              )
                            })
                          }
                        />
                      )}
                    </label>
                  )}
                  <button
                    aria-label={`移除 ${file.name}`}
                    onClick={() => patch({ files: request.files.filter((_, i) => i !== index) })}
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>
          )}
          {advanced && (
            <div className="firmware-advanced">
              <div className="firmware-row">
                {serial && (
                  <label>
                    波特率
                    <input
                      aria-label="烧录波特率"
                      type="number"
                      min="1200"
                      max="3000000"
                      value={request.baudRate}
                      onChange={(e) => patch({ baudRate: Number(e.target.value) })}
                    />
                  </label>
                )}
                {stm && !serial && (
                  <label>
                    连接模式
                    <select
                      value={request.connectMode}
                      onChange={(e) => patch({ connectMode: e.target.value as 'NORMAL' | 'UR' })}
                    >
                      <option value="NORMAL">正常连接</option>
                      <option value="UR">复位下连接（需 NRST）</option>
                    </select>
                  </label>
                )}
                {!stm && (
                  <label>
                    <input
                      type="checkbox"
                      checked={request.manualBoot}
                      onChange={(e) => patch({ manualBoot: e.target.checked })}
                    />
                    手动进入下载模式
                  </label>
                )}
                {!ymodem && (
                  <label>
                    <input
                      type="checkbox"
                      checked={request.eraseAll}
                      onChange={(e) => patch({ eraseAll: e.target.checked })}
                    />
                    整片擦除（清除全部数据）
                  </label>
                )}
              </div>
              {!ymodem && (
                <div className="firmware-row firmware-tool-path">
                  <span title={tool?.path || request.toolPath}>
                    {request.toolPath || tool?.path || '自动查找工具'}
                  </span>
                  <button onClick={() => void chooseTool()}>选择工具</button>
                  <button
                    onClick={() => {
                      setTool(null)
                      patch({ toolPath: '' })
                      setToolPaths((current) => ({ ...current, [request.family]: '' }))
                    }}
                  >
                    自动查找
                  </button>
                  <button
                    onClick={() =>
                      void perform(async () =>
                        setTool(await window.api.getFirmwareTool(request.family, request.toolPath))
                      )
                    }
                  >
                    重新检测
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="firmware-row firmware-options">
            {ymodem ? (
              <span>接收端按 Ymodem CRC16 确认数据；Flash 校验由设备升级程序负责</span>
            ) : stm ? (
              <label>
                <input
                  type="checkbox"
                  checked={request.verify}
                  onChange={(e) => patch({ verify: e.target.checked })}
                />
                烧录后校验
              </label>
            ) : (
              <span>✓ 自动校验写入数据</span>
            )}
            {(!stm || !serial) && (
              <label>
                <input
                  type="checkbox"
                  checked={request.reset}
                  onChange={(e) => patch({ reset: e.target.checked })}
                />
                完成后复位
              </label>
            )}
            {serial && (
              <label>
                <input
                  type="checkbox"
                  checked={request.restorePort}
                  onChange={(e) => patch({ restorePort: e.target.checked })}
                />
                结束后恢复原串口连接
              </label>
            )}
            {!ymodem && (
              <span className={tool?.available ? 'firmware-tool-ok' : 'firmware-tool-missing'}>
                {tool
                  ? tool.available
                    ? `${stm ? 'CubeProgrammer' : 'esptool'} ${tool.version}`
                    : tool.error
                  : '正在检测烧录工具…'}
              </span>
            )}
          </div>
        </fieldset>
        <p className="firmware-hint">
          {stm
            ? ymodem
              ? '先让设备自带 Bootloader 进入 Ymodem 接收状态；仅发送 BIN，须收到接收端 C 握手和各阶段确认。传输成功不等于已独立校验 Flash。'
              : serial
                ? '按芯片手册设置 BOOT 并复位进入系统 Bootloader；烧录完成后恢复 BOOT 配置并手动复位。'
                : '连接 SWDIO、SWCLK、GND 和目标电压参考；复位下连接还需要 NRST。'
            : '支持 DTR/RTS 的开发板可自动下载；否则勾选手动模式，按 BOOT/RESET 进入下载状态。'}
          {serial && ' 烧录时独占所选串口，自动发送任务不会自动恢复。'}
        </p>
        {showLogs && (
          <pre className="firmware-log" ref={logRef} aria-label="烧录日志">
            {state?.logs.join('\n') || '暂无日志'}
          </pre>
        )}
      </div>
      <div className="firmware-footer">
        <div className={`firmware-status firmware-status-${statusTone}`} role="status">
          <div className="firmware-status-heading">
            <span className="firmware-status-icon" aria-hidden="true">
              {statusIcon}
            </span>
            <span className="firmware-status-title" title={statusLabel}>
              {statusLabel}
            </span>
            {!error && state?.operation === 'flash' && (
              <strong className="firmware-status-percent">
                {progressPercent === null ? '进行中' : `${progressPercent}%`}
              </strong>
            )}
          </div>
          {!error && state?.operation === 'flash' && (
            <div
              className={`firmware-progress-track ${progressPercent === null && state.busy ? 'is-indeterminate' : ''}`}
              role="progressbar"
              aria-label="固件传输进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPercent ?? undefined}
            >
              <span
                className="firmware-progress-fill"
                style={{ width: `${progressPercent ?? 0}%` }}
              />
            </div>
          )}
          {!error && state && (
            <div className="firmware-status-meta">
              {state.totalBytes !== undefined && state.transferredBytes !== undefined && (
                <span>
                  {formatBytes(state.transferredBytes)} / {formatBytes(state.totalBytes)}
                </span>
              )}
              <span>用时 {elapsed} 秒</span>
            </div>
          )}
          {state?.restoreWarning && <span className="firmware-error">{state.restoreWarning}</span>}
        </div>
        <div className="firmware-actions">
          <button onClick={() => setShowLogs(!showLogs)} aria-expanded={showLogs}>
            {showLogs ? '收起日志' : '查看日志'}
          </button>
          <button
            disabled={!state}
            onClick={() =>
              void perform(async () => {
                await window.api.saveFirmwareLog()
              })
            }
          >
            导出日志
          </button>
          {state?.busy ? (
            <button
              className="send-cancel-button"
              onClick={() =>
                void window.api
                  .cancelFirmware(state.id)
                  .catch((cause) => setError(errorText(cause)))
              }
            >
              停止
            </button>
          ) : (
            <>
              {!ymodem && (
                <button
                  disabled={busy || !targetReady || !tool?.available}
                  onClick={() => void start('detect')}
                >
                  检测芯片
                </button>
              )}
              <button
                className="send-button"
                disabled={busy || !targetReady || !filesReady || (!ymodem && !tool?.available)}
                onClick={() => void start('flash')}
              >
                开始烧录
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  )
})
