import type { EventEmitter } from 'node:events'

const SOH = 0x01
const STX = 0x02
const EOT = 0x04
const ACK = 0x06
const NAK = 0x15
const CAN = 0x18
const CRC_REQUEST = 0x43
const MAX_RETRIES = 10
const RESPONSE_TIMEOUT = 30000
const FINISH_TIMEOUT = 60000

export type YmodemPort = Pick<EventEmitter, 'on' | 'off'> & {
  write(data: Buffer, callback: (error?: Error | null) => void): unknown
}

export function crc16Ymodem(data: Uint8Array): number {
  let crc = 0
  for (const byte of data) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}

export function ymodemPacket(
  sequence: number,
  data: Buffer,
  size: 128 | 1024,
  padding: number
): Buffer {
  if (data.length > size) throw new Error('Ymodem 数据包超出长度')
  const packet = Buffer.alloc(size + 5, padding)
  packet[0] = size === 128 ? SOH : STX
  packet[1] = sequence & 0xff
  packet[2] = 0xff ^ packet[1]
  data.copy(packet, 3)
  const crc = crc16Ymodem(packet.subarray(3, size + 3))
  packet.writeUInt16BE(crc, size + 3)
  return packet
}

export function ymodemHeader(name: string, length: number): Buffer {
  if (!/^[\x20-\x7e]{1,64}$/.test(name) || name.includes('/') || name.includes('\\'))
    throw new Error('Ymodem 固件名必须是 1–64 个 ASCII 字符，且不能包含路径')
  if (!Number.isSafeInteger(length) || length < 1 || length > 128 * 1024 * 1024)
    throw new Error('Ymodem 固件大小无效')
  const header = Buffer.from(`${name}\0${length}\0`, 'ascii')
  if (header.length > 128) throw new Error('Ymodem 文件信息超出首包长度')
  return ymodemPacket(0, header, 128, 0)
}

class Controls {
  private queue: number[] = []
  private pending?: { resolve: (byte: number) => void; reject: (error: Error) => void }
  private failed?: Error
  private onData = (chunk: Buffer): void => {
    for (const byte of chunk) {
      if (this.pending) {
        const pending = this.pending
        this.pending = undefined
        pending.resolve(byte)
      } else if (this.queue.length < 4096) this.queue.push(byte)
    }
  }
  private onError = (error: Error): void => this.fail(error)
  private onClose = (): void => this.fail(new Error('Ymodem 串口已断开'))
  private onAbort = (): void => this.fail(new Error('任务已停止'))

  constructor(
    private port: YmodemPort,
    private signal: AbortSignal
  ) {
    port.on('data', this.onData)
    port.on('error', this.onError)
    port.on('close', this.onClose)
    signal.addEventListener('abort', this.onAbort)
    if (signal.aborted) this.onAbort()
  }

  dispose(): void {
    this.port.off('data', this.onData)
    this.port.off('error', this.onError)
    this.port.off('close', this.onClose)
    this.signal.removeEventListener('abort', this.onAbort)
  }

  private fail(error: Error): void {
    this.failed = error
    this.pending?.reject(error)
    this.pending = undefined
  }

  async read(timeout = RESPONSE_TIMEOUT): Promise<number> {
    if (this.failed) throw this.failed
    if (this.queue.length) return this.queue.shift()!
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending === pending) this.pending = undefined
        reject(new Error('Ymodem 等待接收端响应超时'))
      }, timeout)
      const pending = {
        resolve: (byte: number): void => {
          clearTimeout(timer)
          resolve(byte)
        },
        reject: (error: Error): void => {
          clearTimeout(timer)
          reject(error)
        }
      }
      this.pending = pending
    })
  }

  async response(timeout = RESPONSE_TIMEOUT): Promise<number> {
    const byte = await this.read(timeout)
    if (byte === CAN) {
      let next: number
      try {
        next = await this.read(1000)
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('超时')) throw error
        throw new Error('Ymodem 接收端返回了不完整取消序列')
      }
      if (next === CAN) throw new Error('Ymodem 接收端已取消传输')
      throw new Error('Ymodem 接收端返回了无效取消序列')
    }
    return byte
  }

  async write(data: Buffer): Promise<void> {
    if (this.failed) throw this.failed
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.signal.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      }
      const onAbort = (): void => finish(new Error('任务已停止'))
      const timer = setTimeout(() => finish(new Error('Ymodem 串口写入超时')), RESPONSE_TIMEOUT)
      this.signal.addEventListener('abort', onAbort)
      try {
        this.port.write(data, (error) => finish(error || undefined))
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    if (this.failed) throw this.failed
  }
}

async function acknowledged(controls: Controls, packet: Buffer, stage: string): Promise<void> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await controls.write(packet)
    let answer: number
    try {
      answer = await controls.response()
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('超时')) throw error
      continue
    }
    if (answer === ACK) return
    // STM32 IAP receivers can request a CRC16 packet again with C after a bad packet.
    if (answer !== NAK && answer !== CRC_REQUEST)
      throw new Error(`${stage}：接收端返回异常字节 0x${answer.toString(16)}`)
  }
  throw new Error(`${stage}：接收端未确认，已达到 ${MAX_RETRIES} 次重试上限`)
}

export async function sendYmodem(
  port: YmodemPort,
  name: string,
  data: Buffer,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
  onStage: (stage: string) => void,
  preconfirmedC = false
): Promise<void> {
  const header = ymodemHeader(name, data.length)
  const controls = new Controls(port, signal)
  let finished = false
  try {
    if (preconfirmedC) onStage('已完成 C 选口握手，发送 Ymodem 文件信息')
    else {
      onStage('等待接收端发出 C 握手')
      const deadline = Date.now() + 30000
      while (true) {
        const byte = await controls.response(Math.max(1, deadline - Date.now()))
        if (byte === CRC_REQUEST) break
        if (Date.now() >= deadline) throw new Error('未收到 Ymodem CRC16 握手 C')
      }
    }
    onStage('发送 Ymodem 文件信息')
    await acknowledged(controls, header, '文件信息包')
    if ((await controls.response(FINISH_TIMEOUT)) !== CRC_REQUEST)
      throw new Error('文件信息包后未收到接收端的 CRC16 请求 C')
    onStage('Ymodem 传输固件')
    for (let offset = 0, sequence = 1; offset < data.length; sequence++) {
      const size: 128 | 1024 = data.length - offset >= 1024 ? 1024 : 128
      const count = Math.min(size, data.length - offset)
      await acknowledged(
        controls,
        ymodemPacket(sequence, data.subarray(offset, offset + count), size, 0x1a),
        `数据包 ${sequence}`
      )
      offset += count
      onProgress(offset)
    }
    onStage('Ymodem 结束传输')
    let endConfirmed = false
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await controls.write(Buffer.from([EOT]))
      let answer: number
      try {
        answer = await controls.response()
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('超时')) throw error
        continue
      }
      if (answer === ACK) {
        endConfirmed = true
        break
      }
      if (answer !== NAK) throw new Error(`EOT 阶段收到异常字节 0x${answer.toString(16)}`)
    }
    if (!endConfirmed) throw new Error('EOT 未得到接收端确认')
    if ((await controls.response(FINISH_TIMEOUT)) !== CRC_REQUEST)
      throw new Error('EOT 后未收到空文件包请求 C')
    await acknowledged(controls, ymodemPacket(0, Buffer.alloc(0), 128, 0), '结束空包')
    finished = true
  } finally {
    if (!finished)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500)
        try {
          port.write(Buffer.from([CAN, CAN]), () => {
            clearTimeout(timer)
            resolve()
          })
        } catch {
          clearTimeout(timer)
          resolve()
        }
      })
    controls.dispose()
  }
}
