import type { SerialPairsModel } from '../use-serial-pairs'

export function SerialPairPanel({ model }: { model: SerialPairsModel }): React.JSX.Element {
  const {
    first,
    setFirst,
    second,
    setSecond,
    status,
    busy,
    message,
    refresh,
    createPair,
    installCertificate
  } = model
  const canCreate =
    Boolean(status?.installed) &&
    Boolean(first && second) &&
    first !== second &&
    Boolean(status?.availablePorts.includes(first)) &&
    Boolean(status?.availablePorts.includes(second))
  const occupiedPortSet = new Set(status?.occupiedPorts ?? [])
  const portOptions = Array.from({ length: 999 }, (_, index) => `COM${index + 1}`)

  return (
    <section className="serial-pair-panel">
      <header>
        <div>
          <strong>虚拟串口对</strong>
          <span>使用 SerialFlow 自有 UMDF 2 驱动连接两个本地 COM 端口</span>
        </div>
        <button disabled={busy} onClick={() => void refresh()}>
          刷新状态
        </button>
      </header>

      <div className={`serial-pair-status ${status?.installed ? 'ready' : ''}`}>
        <i />
        <div>
          <strong>{status?.installed ? 'SerialFlow 驱动已就绪' : '驱动包不可用'}</strong>
          <span>{message}</span>
          {status?.commandPath && <small>{status.commandPath}</small>}
        </div>
      </div>

      <div className="serial-pair-card">
        <h2>创建串口对</h2>
        <p>向其中一个端口发送的数据，会从另一个端口收到，适合双软件互联和协议模拟。</p>
        <div className="serial-pair-form">
          <label>
            端口 A
            <select
              value={first}
              disabled={busy}
              onChange={(event) => setFirst(event.target.value)}
            >
              {portOptions.map((port) => (
                <option
                  key={port}
                  value={port}
                  className={occupiedPortSet.has(port) ? 'port-occupied' : 'port-available'}
                  disabled={occupiedPortSet.has(port) || port === second}
                >
                  {occupiedPortSet.has(port) ? '🔴' : '🟢'} {port}（
                  {occupiedPortSet.has(port) ? '已占用' : '可用'}）
                </option>
              ))}
            </select>
          </label>
          <b>↔</b>
          <label>
            端口 B
            <select
              value={second}
              disabled={busy}
              onChange={(event) => setSecond(event.target.value)}
            >
              {portOptions.map((port) => (
                <option
                  key={port}
                  value={port}
                  className={occupiedPortSet.has(port) ? 'port-occupied' : 'port-available'}
                  disabled={occupiedPortSet.has(port) || port === first}
                >
                  {occupiedPortSet.has(port) ? '🔴' : '🟢'} {port}（
                  {occupiedPortSet.has(port) ? '已占用' : '可用'}）
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary"
            disabled={!canCreate || busy}
            onClick={() => void createPair()}
          >
            {busy ? '正在创建…' : '创建虚拟串口对'}
          </button>
        </div>
        <small>
          已自动筛除当前被硬件或其他驱动占用的端口；创建前会再次检测。创建设备需要管理员权限。
        </small>
        <div className="serial-port-availability">
          <strong>端口检测</strong>
          <span className="available">可用 {status?.availablePorts.length ?? 0} 个</span>
          <span className="occupied">已占用 {status?.occupiedPorts.length ?? 0} 个</span>
          <p>
            {status?.occupiedPorts.length
              ? `已占用：${status.occupiedPorts.join('、')}`
              : '当前未检测到已占用的 COM 端口'}
          </p>
        </div>
      </div>

      <div className="serial-pair-card">
        <h2>管理与安装</h2>
        <div className="serial-pair-actions">
          {status?.certificateAvailable && !status.certificateInstalled && (
            <button className="primary" disabled={busy} onClick={() => void installCertificate()}>
              {busy ? '正在安装…' : '安装测试签名证书'}
            </button>
          )}
          <button
            disabled={!status?.installed}
            onClick={() => void window.api.openVirtualPortManager()}
          >
            定位 SerialFlow 管理程序
          </button>
        </div>
        <p className="serial-pair-warning">
          开发构建使用测试签名证书；正式发布包必须使用 Microsoft 签名。安装证书需要管理员权限，
          本应用不会自动关闭 Secure Boot 或修改系统测试模式。
        </p>
      </div>
    </section>
  )
}
