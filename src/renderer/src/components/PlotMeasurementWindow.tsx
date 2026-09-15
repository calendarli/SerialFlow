import { useEffect, useState } from 'react'
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
        <strong>区间测量</strong>
        <button
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
          {pinned ? '取消置顶' : '启用置顶'}
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {data ? (
        <section className="plot-measurements" aria-label="双游标区间统计">
          <div className="plot-measurements-controls">
            {(['a', 'b'] as const).map((cursor) => (
              <label key={cursor}>
                <button
                  aria-pressed={data.active === cursor}
                  onClick={() => command({ type: 'select', cursor })}
                >
                  {cursor.toUpperCase()}
                </button>
                <input
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
              </label>
            ))}
            <span>Δt（B−A）{data.deltaTime} ms</span>
            <span>间隔 {Math.abs(data.b - data.a)} 点</span>
            <button onClick={() => command({ type: 'end' })}>结束测量并继续</button>
          </div>
          <small>
            波形已冻结，接收继续。拖动两游标之间的区域可整体平移；拖动曲线游标或修改 A / B
            采样点，统计同步更新。统计包含两端，平均值按有效采样点计算。关闭窗口将结束测量。
          </small>
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
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row[0]} data-channel={row[0]}>
                    {row.map((cell, index) =>
                      index === 0 ? <th key={index}>{cell}</th> : <td key={index}>{cell}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <p>等待测量数据…</p>
      )}
    </main>
  )
}
