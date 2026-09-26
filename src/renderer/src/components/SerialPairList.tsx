import { Network, RefreshCw, Trash2 } from 'lucide-react'
import type { SerialPairsModel } from '../use-serial-pairs'

export function SerialPairList({ model }: { model: SerialPairsModel }): React.JSX.Element {
  const { status, busy, message, refresh, removePair } = model
  const pairs = status?.pairs ?? []
  return (
    <section className="serial-pair-sidebar" aria-label="已创建的虚拟串口对">
      <div className="panel-title">
        <span>虚拟串口对</span>
        <button
          type="button"
          className="icon-button"
          title="刷新串口对列表"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="serial-pair-list-caption">
        已创建 <b>{pairs.length}</b> 组
      </div>
      <div className="serial-pair-sidebar-list" aria-busy={busy}>
        {pairs.map((pair) => {
          const [first, second] = pair.split(' ↔ ')
          const complete = /^COM\d+$/.test(first) && /^COM\d+$/.test(second ?? '')
          return (
            <article className="serial-pair-item" key={pair}>
              <Network size={19} aria-hidden="true" />
              <div>
                <strong>{pair}</strong>
                <small>{complete ? '双向虚拟串口' : '端点不完整，请刷新检查'}</small>
              </div>
              <button
                type="button"
                className="serial-pair-delete"
                title={`删除 ${pair}`}
                aria-label={`删除 ${pair}`}
                disabled={busy || !complete}
                onClick={() => void removePair(pair)}
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </article>
          )
        })}
        {!pairs.length && (
          <p className="serial-pair-empty">
            {busy
              ? '正在读取串口对…'
              : status
                ? '暂无已创建的串口对，请在右侧创建。'
                : '未能读取串口对，请刷新重试。'}
          </p>
        )}
      </div>
      <p className="serial-pair-sidebar-message" role="status">
        {message}
      </p>
    </section>
  )
}
