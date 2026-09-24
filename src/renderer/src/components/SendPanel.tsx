import { ClearActionIcon } from './ClearActionIcon'
import { FirmwareFlashPanel } from './FirmwareFlashPanel'
import { useEffect, useRef, useState } from 'react'
import type { CrcMode } from '../types'
import { FloatingPanel } from './FloatingPanel'

type LineEnding = '' | '\n' | '\r' | '\n\r' | '\r\n'
type Progress = Parameters<Parameters<typeof window.api.onFileTransferProgress>[0]>[0]

type Props = {
  text: string
  hex: boolean
  lineEnding: LineEnding
  autoSend: boolean
  autoSendRunning: boolean
  interval: number
  autoSendCount: number
  crcEnabled: boolean
  crcMode: CrcMode
  openedPorts: string[]
  targetPort: string
  onTextChange: (value: string) => void
  onHexChange: (value: boolean) => void
  onLineEndingChange: (value: LineEnding) => void
  onAutoSendChange: (value: boolean) => void
  onIntervalChange: (value: number) => void
  onAutoSendCountChange: (value: number) => void
  onSend: () => void
  onCrcEnabledChange: (value: boolean) => void
  onCrcModeChange: (value: CrcMode) => void
  onTargetPortChange: (value: string) => void
  height: number
  onHeightChange: (value: number) => void
  onHeightCommit: (value: number) => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function SendPanel(props: Props): React.JSX.Element {
  const [resizing, setResizing] = useState(false)
  const [mode, setMode] = useState<'message' | 'file' | 'firmware'>('message')
  const [file, setFile] = useState<{ path: string; name: string; size: number } | null>(null)
  const [chunkSize, setChunkSize] = useState(1024)
  const [chunkDelay, setChunkDelay] = useState(0)
  const [fileStatus, setFileStatus] = useState('请选择要发送的文件')
  const [progress, setProgress] = useState<Progress | null>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const optionsAnchorRef = useRef<HTMLButtonElement | null>(null)
  const dragStart = useRef({ y: 0, height: props.height })
  const latestHeight = useRef(props.height)

  useEffect(
    () =>
      window.api.onFileTransferProgress((next) => {
        if (next.direction !== 'send') return
        setProgress(next)
        setFileStatus(next.message)
      }),
    []
  )

  const beginResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragStart.current = { y: event.clientY, height: props.height }
    latestHeight.current = props.height
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizing(true)
  }
  const resize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!resizing) return
    const nextHeight = dragStart.current.height - (event.clientY - dragStart.current.y)
    latestHeight.current = nextHeight
    props.onHeightChange(nextHeight)
  }
  const finishResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!resizing) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    props.onHeightCommit(latestHeight.current)
    setResizing(false)
  }
  const chooseFile = async (): Promise<void> => {
    const selected = await window.api.selectTransferFile()
    if (!selected) return
    setFile(selected)
    setProgress(null)
    setFileStatus(`已选择 ${selected.name}`)
  }
  const sendFile = async (): Promise<void> => {
    try {
      if (!props.targetPort) throw new Error('请选择已打开的发送串口')
      if (!file) throw new Error('请选择要发送的文件')
      await window.api.startFileTransfer(props.targetPort, file.path, chunkSize, 'raw', chunkDelay)
      setFileStatus('文件传输任务已启动')
    } catch (error) {
      setFileStatus(error instanceof Error ? error.message : String(error))
    }
  }
  const percent = progress?.totalBytes
    ? Math.min(100, (progress.transferredBytes / progress.totalBytes) * 100)
    : 0
  const canCancel = progress && !['completed', 'error', 'cancelled'].includes(progress.state)

  const portSelect = (
    <select
      className="send-port-select"
      aria-label="发送串口"
      value={props.targetPort}
      onChange={(event) => props.onTargetPortChange(event.target.value)}
    >
      <option value="">选择目标串口</option>
      {props.openedPorts.map((path) => (
        <option key={path}>{path}</option>
      ))}
    </select>
  )

  return (
    <div className="sender card compact-sender">
      <div
        className={`send-panel-resizer ${resizing ? 'resizing' : ''}`}
        title="拖拽调整发送区高度，双击恢复默认"
        onPointerDown={beginResize}
        onPointerMove={resize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onDoubleClick={() => props.onHeightCommit(230)}
      >
        <i />
      </div>

      <div className="send-mode-tabs">
        <button className={mode === 'message' ? 'active' : ''} onClick={() => setMode('message')}>
          发送消息
        </button>
        <button className={mode === 'file' ? 'active' : ''} onClick={() => setMode('file')}>
          发送文件
        </button>
        <button className={mode === 'firmware' ? 'active' : ''} onClick={() => setMode('firmware')}>
          固件烧录
        </button>
        <button
          hidden={mode === 'firmware'}
          className="send-editor-clear clear-action-button"
          title={
            mode === 'message'
              ? '清空输入框'
              : canCancel
                ? '文件发送中，暂时不能清空'
                : '清空所选文件'
          }
          aria-label={mode === 'message' ? '清空输入框' : '清空所选文件'}
          disabled={mode === 'file' && Boolean(canCancel)}
          onClick={() => {
            if (mode === 'message') {
              props.onTextChange('')
              return
            }
            setFile(null)
            setProgress(null)
            setFileStatus('请选择要发送的文件')
          }}
        >
          <ClearActionIcon />
        </button>
      </div>

      {mode === 'message' ? (
        <>
          <textarea
            value={props.text}
            onChange={(event) => props.onTextChange(event.target.value)}
            placeholder={props.hex ? '例如：01 03 00 00 00 02' : '输入要发送的数据…'}
          />
          <div className="send-bottom-bar">
            <button className="send-hex-toggle" onClick={() => props.onHexChange(!props.hex)}>
              {props.hex ? 'Hex' : 'ASCII'}
            </button>
            {portSelect}
            <label className="send-crc-toggle">
              <input
                type="checkbox"
                checked={props.crcEnabled}
                onChange={(event) => props.onCrcEnabledChange(event.target.checked)}
              />{' '}
              CRC
            </label>
            <select
              className="crc-select"
              aria-label="CRC 格式"
              disabled={!props.crcEnabled}
              value={props.crcMode}
              onChange={(event) => props.onCrcModeChange(event.target.value as CrcMode)}
            >
              <option value="crc8">CRC-8</option>
              <option value="modbus">CRC-16/MODBUS</option>
              <option value="ccitt-false">CRC-16/CCITT-FALSE</option>
              <option value="xmodem">CRC-16/XMODEM</option>
              <option value="crc32">CRC-32</option>
            </select>
            <select
              className="line-ending-select"
              aria-label="发送后追加"
              value={props.lineEnding}
              onChange={(event) => props.onLineEndingChange(event.target.value as LineEnding)}
            >
              <option value="">无追加</option>
              <option value={'\n'}>\\n</option>
              <option value={'\r'}>\\r</option>
              <option value={'\n\r'}>\\n\\r</option>
              <option value={'\r\n'}>\\r\\n</option>
            </select>
            <div className="send-button-group">
              <button
                className={`send-button ${props.autoSendRunning ? 'stop' : ''}`}
                onClick={props.onSend}
              >
                {props.autoSend ? (props.autoSendRunning ? '停止发送' : '连续发送') : '发送(S)'}
              </button>
              <button
                ref={optionsAnchorRef}
                className="send-options-trigger"
                title="发送设置"
                aria-label="打开发送设置"
                onClick={() => setOptionsOpen((current) => !current)}
              />
              <FloatingPanel
                anchorRef={optionsAnchorRef}
                open={optionsOpen}
                onClose={() => setOptionsOpen(false)}
                className="send-options-floating"
              >
                <div className="send-options-popover">
                  <button
                    className={`continuous-send ${props.autoSend ? 'active' : ''}`}
                    onClick={() => props.onAutoSendChange(!props.autoSend)}
                  >
                    <i /> 连续发送
                  </button>
                  <label className="send-stepper">
                    <span>发送后延时 (ms)</span>
                    <button onClick={() => props.onIntervalChange(Math.max(1, props.interval - 1))}>
                      −
                    </button>
                    <input
                      type="number"
                      min="1"
                      value={props.interval}
                      onChange={(event) => props.onIntervalChange(Number(event.target.value))}
                    />
                    <button onClick={() => props.onIntervalChange(props.interval + 1)}>+</button>
                  </label>
                  <label className="send-stepper">
                    <span>重复次数（0 为无限）</span>
                    <button
                      disabled={props.autoSendRunning}
                      onClick={() =>
                        props.onAutoSendCountChange(Math.max(0, props.autoSendCount - 1))
                      }
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min="0"
                      disabled={props.autoSendRunning}
                      value={props.autoSendCount}
                      onChange={(event) =>
                        props.onAutoSendCountChange(
                          Math.max(0, Math.floor(Number(event.target.value) || 0))
                        )
                      }
                    />
                    <button
                      disabled={props.autoSendRunning}
                      onClick={() => props.onAutoSendCountChange(props.autoSendCount + 1)}
                    >
                      +
                    </button>
                  </label>
                  <small>● 按 Ctrl + Enter 发送</small>
                </div>
              </FloatingPanel>
            </div>
          </div>
        </>
      ) : mode === 'file' ? (
        <div className="send-file-view">
          <div className="send-file-status send-file-main">
            <span>{fileStatus}</span>
            {progress && (
              <span>
                {percent.toFixed(1)}% · {formatBytes(progress.transferredBytes)} /{' '}
                {formatBytes(progress.totalBytes)}
              </span>
            )}
            <i>
              <b style={{ width: `${percent}%` }} />
            </i>
          </div>
          <div className="send-bottom-bar file-send-bar">
            <button className="choose-file-button" onClick={() => void chooseFile()}>
              选择文件
            </button>
            <select
              value={chunkSize}
              onChange={(event) => setChunkSize(Number(event.target.value))}
            >
              <option value={256}>256 B</option>
              <option value={512}>512 B</option>
              <option value={1024}>1 KB 分块</option>
              <option value={4096}>4 KB 分块</option>
            </select>
            <label
              className="file-chunk-delay"
              data-tooltip="每发送完一个文件区块后等待指定时间，再发送下一个区块。0 表示不延时。"
            >
              区块延时
              <input
                type="number"
                min="0"
                max="60000"
                value={chunkDelay}
                onChange={(event) =>
                  setChunkDelay(
                    Math.min(60000, Math.max(0, Math.floor(Number(event.target.value) || 0)))
                  )
                }
              />
              ms
            </label>
            {portSelect}
            {canCancel && (
              <button
                className="send-cancel-button"
                onClick={() => void window.api.cancelFileTransfer(progress.taskId)}
              >
                取消
              </button>
            )}
            <button
              className="send-button"
              disabled={!file || !props.targetPort}
              onClick={() => void sendFile()}
            >
              发送文件
            </button>
          </div>
        </div>
      ) : null}
      <div className="firmware-host" hidden={mode !== 'firmware'}>
        <FirmwareFlashPanel openedPorts={props.openedPorts} />
      </div>
    </div>
  )
}
