import { useEffect, useState } from 'react'
import {
  Activity,
  ArrowLeftRight,
  Clock3,
  Info,
  Pin,
  PinOff,
  Play,
  Pause,
  Ruler
} from 'lucide-react'
import type { PlotMeasurement, PlotMeasurementCommand } from '@common/plot-measurement'

export function PlotMeasurementWindow(): React.JSX.Element {
  const [data, setData] = useState<PlotMeasurement | null>(null)
  const [pinned, setPinned] = useState(false)
  const [pinBusy, setPinBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    document.title = '区间测量 · SerialFlow'
    let active = true
    let received = false
    const off = window.api.onPlotMeasurement((value) => {
      received = true
      setData(value)
    })
    void window.api
      .getPlotMeasurement()
      .then((value) => {
        if (active && !received) setData(value)
      })
      .catch((e) => {
        if (active) setError(String(e))
      })
    void window.api
      .getAlwaysOnTop()
      .then((value) => {
        if (active) setPinned(value)
      })
      .catch((e) => {
        if (active) setError(String(e))
      })
    return () => {
      active = false
      off()
    }
  }, [])
  const command = (value: PlotMeasurementCommand): void => {
    void window.api.commandPlotMeasurement(value).catch((e) => setError(String(e)))
  }
  return (
    <main className="plot-measurement-window">
      <header className="plot-measurement-heading">
        <div className="measurement-title">
          <span className="measurement-title-icon">
            <Ruler size={21} aria-hidden="true" />
          </span>
          <div>
            <h1>区间测量</h1>
            <span>
              双游标分析{' '}
              <span className="measurement-status">
                {data?.receivePaused ? '接收已暂停' : '正在接收'}
              </span>
            </span>
          </div>
        </div>
        <div className="measurement-actions">
          <button
            className="measurement-pin"
            aria-pressed={pinned}
            disabled={pinBusy}
            onClick={async () => {
              setPinBusy(true)
              try {
                setPinned(await window.api.setAlwaysOnTop(!pinned))
                setError('')
              } catch (e) {
                setError(String(e))
              } finally {
                setPinBusy(false)
              }
            }}
          >
            {pinned ? (
              <PinOff size={15} aria-hidden="true" />
            ) : (
              <Pin size={15} aria-hidden="true" />
            )}
            {pinned ? '取消置顶' : '启用置顶'}
          </button>
          {data && (
            <button
              className="measurement-resume"
              aria-pressed={data.receivePaused}
              onClick={() => command({ type: 'receive', paused: !data.receivePaused })}
            >
              {data.receivePaused ? (
                <Play size={14} aria-hidden="true" />
              ) : (
                <Pause size={14} aria-hidden="true" />
              )}
              {data.receivePaused ? '继续接收' : '暂停接收'}
            </button>
          )}
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      {data ? (
        <>
          <div className="measurement-summary" aria-label="测量概览">
            {(['a', 'b'] as const).map((cursor) => (
              <div className={`measurement-cursor-field cursor-${cursor}`} key={cursor}>
                <div className="measurement-summary-label">
                  <button
                    aria-label={`选择游标 ${cursor.toUpperCase()}`}
                    aria-pressed={data.active === cursor}
                    onClick={() => command({ type: 'select', cursor })}
                  >
                    {cursor.toUpperCase()}
                  </button>
                  <label htmlFor={`measurement-${cursor}`}>游标 {cursor.toUpperCase()}</label>
                  <span className="measurement-current">
                    {data.active === cursor ? '当前' : ''}
                  </span>
                </div>
                <div className="measurement-summary-value">
                  <input
                    id={`measurement-${cursor}`}
                    type="number"
                    aria-label={`游标 ${cursor.toUpperCase()} 采样点`}
                    min={1}
                    max={data.total}
                    value={data[cursor]}
                    onChange={(event) => {
                      const index = Number(event.target.value)
                      if (Number.isInteger(index) && index >= 1 && index <= data.total)
                        command({ type: 'move', cursor, index })
                    }}
                  />
                  <span>采样点</span>
                </div>
              </div>
            ))}
            <div className="measurement-metric">
              <div className="measurement-summary-label">
                <Clock3 size={14} aria-hidden="true" />
                时间差 <span>B − A</span>
              </div>
              <div className="measurement-summary-value">
                <strong title={data.deltaTime}>{data.deltaTime}</strong>
                <span>ms</span>
              </div>
            </div>
            <div className="measurement-metric">
              <div className="measurement-summary-label">
                <ArrowLeftRight size={14} aria-hidden="true" />
                采样间隔
              </div>
              <div className="measurement-summary-value">
                <strong>{Math.abs(data.b - data.a).toLocaleString()}</strong>
                <span>点</span>
              </div>
            </div>
          </div>
          <section className="plot-measurements" aria-label="双游标区间统计">
            <div className="measurement-table-heading">
              <div>
                <Activity size={16} aria-hidden="true" />
                <h2>通道统计</h2>
                <span className="measurement-count">{data.rows.length} 个通道</span>
              </div>
              <span>包含两端 · 原始有效样本</span>
            </div>
            <div className="plot-measurements-table">
              <table>
                <thead>
                  <tr>
                    {[
                      '通道',
                      'A',
                      'B',
                      'Δ值（B−A）',
                      '有效点数',
                      '最小值',
                      '最大值',
                      '平均值',
                      '峰峰值'
                    ].map((label) => (
                      <th key={label} scope="col">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row[0]} data-channel={row[0]}>
                      {row.map((cell, index) =>
                        index === 0 ? (
                          <th key={index} scope="row" title={cell}>
                            {cell}
                          </th>
                        ) : (
                          <td key={index}>{cell}</td>
                        )
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data.rows.length && (
                <p className="measurement-empty">暂无可见通道，请在曲线中启用需要测量的通道。</p>
              )}
            </div>
          </section>
          <footer className="measurement-hint">
            <Info size={14} aria-hidden="true" />
            <span>拖动 A/B 之间的区域可整体平移，统计同步更新。</span>
            <span>关闭窗口将结束测量</span>
          </footer>
        </>
      ) : (
        <p className="measurement-empty">等待测量数据…</p>
      )}
    </main>
  )
}
