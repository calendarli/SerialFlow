import { EventEmitter } from 'node:events'
import { Socket } from 'node:net'
import { parseTcpEndpoint } from '../common/remote-serial'

type Callback = (error?: Error | null) => void

// Raw TCP only: serial parameters and flow control belong to ser2net.
// A successful write means the local TCP stack accepted the bytes, not that
// the remote UART drained or the attached device acknowledged them.
export class TcpSerialPort extends EventEmitter {
  readonly path: string
  private readonly endpoint: ReturnType<typeof parseTcpEndpoint>
  private socket?: Socket
  isOpen = false

  constructor(
    path: string,
    private readonly timeoutMs = 10_000
  ) {
    super()
    this.endpoint = parseTcpEndpoint(path)
    this.path = this.endpoint.path
  }

  open(callback: Callback): void {
    if (this.socket) return callback(new Error('连接已启动，请创建新的 TCP 连接'))
    const socket = new Socket()
    this.socket = socket
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(error)
    }
    const timer = setTimeout(() => {
      const error = new Error('TCP 连接超时，请检查地址、端口、防火墙及 ser2net 服务')
      socket.destroy(error)
    }, this.timeoutMs)
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 10_000)
    socket.on('connect', () => {
      this.isOpen = true
      finish()
    })
    socket.on('data', (data: Buffer) => this.emit('data', data))
    socket.on('error', (error: Error) => {
      if (!settled) finish(error)
      else if (this.isOpen) this.emit('error', error)
    })
    socket.on('close', () => {
      this.isOpen = false
      finish(new Error('TCP 连接在建立前已关闭'))
      this.emit('close')
    })
    try {
      socket.connect(this.endpoint.port, this.endpoint.host)
    } catch (error) {
      socket.destroy()
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  }

  write(data: Buffer, callback: Callback): void {
    const socket = this.socket
    if (!this.isOpen || !socket || socket.destroyed)
      return callback(new Error('远程串口未打开或已经断开'))
    let settled = false
    const finish: Callback = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off('close', closed)
      callback(error)
    }
    const closed = (): void => finish(new Error('TCP 连接已断开，发送未完成'))
    const timer = setTimeout(() => {
      const error = new Error('TCP 发送超时，连接已关闭，请检查远端网络')
      socket.destroy(error)
      finish(error)
    }, this.timeoutMs)
    socket.once('close', closed)
    socket.write(data, finish)
  }

  drain(callback: Callback): void {
    // Socket.write's callback already waits for the TCP write to complete.
    callback(this.isOpen ? undefined : new Error('远程串口已经断开'))
  }

  close(callback: Callback): void {
    const socket = this.socket
    this.isOpen = false
    if (!socket || socket.closed) return callback()
    socket.once('close', () => callback())
    // Explicit close is immediate, including when the peer stops reading.
    socket.destroy()
  }
}

export function explainTcpError(error: unknown, path: string): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (/ECONNREFUSED/.test(message))
    return new Error(`无法连接 ${path}：连接被拒绝，请检查 ser2net 是否启动及监听端口是否正确`)
  if (/ENOTFOUND|EAI_AGAIN/.test(message))
    return new Error(`无法解析 ${path} 的主机名，请检查地址和 DNS`)
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(message))
    return new Error(`无法连接 ${path}：网络不可达或连接超时，请检查网络和防火墙`)
  if (/ECONNRESET|EPIPE/.test(message))
    return new Error(`${path} 的连接被远端中断，请检查 ser2net 日志和串口设备`)
  return new Error(`远程串口 ${path}：${message}`)
}
