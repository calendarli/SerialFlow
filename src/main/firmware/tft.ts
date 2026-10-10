import type { YmodemPort } from './ymodem'

export type TftPort = YmodemPort & {
  update(options: { baudRate: number }, callback: (error?: Error | null) => void): unknown
  drain(callback: (error?: Error | null) => void): unknown
}
const end = Buffer.from([255, 255, 255])
export const tftCommand = (text: string): Buffer => Buffer.concat([Buffer.from(text, 'ascii'), end])
class ResponseTimeout extends Error {}

// Each exchange arms reception before writing. ACKs are scoped to that exchange:
// stale/duplicate responses must never acknowledge the next block.
export async function transferTft(
  port: TftPort,
  data: Buffer | null,
  baudRate: number,
  signal: AbortSignal,
  progress: (bytes: number) => void,
  log: (message: string) => void,
  timeouts = { connect: 600, ack: 30000 }
): Promise<void> {
  let failure: Error | undefined
  let receive: ((chunk: Buffer) => void) | undefined
  let failPending: ((error: Error) => void) | undefined
  const fail = (error: Error): void => {
    failure ??= error
    failPending?.(failure)
  }
  const onData = (chunk: Buffer): void => receive?.(chunk)
  const onClose = (): void => fail(new Error('串口屏连接已断开'))
  const onAbort = (): void => fail(new Error('任务已停止，屏幕文件可能不完整，请重新下载'))
  port.on('data', onData)
  port.on('error', fail)
  port.on('close', onClose)
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()

  const exchange = (
    start: (done: (error?: Error | null) => void) => void,
    parse?: (buffer: Buffer) => boolean,
    timeout = timeouts.ack
  ): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure)
      let buffer = Buffer.alloc(0)
      let written = false
      let accepted = !parse
      let settled = false
      const finish = (error?: Error | null): void => {
        if (settled || (!error && (!written || !accepted))) return
        settled = true
        clearTimeout(timer)
        receive = undefined
        failPending = undefined
        if (error) reject(error)
        else resolve(buffer)
      }
      const timer = setTimeout(
        () => finish(written ? new ResponseTimeout('串口屏响应超时') : new Error('串口操作超时')),
        timeout
      )
      failPending = finish
      receive = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]).subarray(-8192)
        try {
          accepted = accepted || Boolean(parse?.(buffer))
          finish()
        } catch (error) {
          finish(error as Error)
        }
      }
      try {
        start((error) => {
          written = true
          finish(error)
        })
      } catch (error) {
        finish(error as Error)
      }
    })
  const write = (bytes: Buffer, done: (error?: Error | null) => void): void => {
    port.write(bytes, (error) => {
      if (error || failure) done(error || failure)
      else {
        try {
          port.drain(done)
        } catch (cause) {
          done(cause as Error)
        }
      }
    })
  }
  const ack = (buffer: Buffer): boolean => {
    // Ordinary command replies are FF-terminated; do not mistake a 0x05
    // embedded in one for the download protocol's standalone acknowledgement.
    if (buffer[0] === 5) return true
    const boundary = buffer.lastIndexOf(end)
    if (boundary >= 0 && buffer[boundary + 3] === 5) return true
    if (buffer[0] === 8) throw new Error('设备请求资源跳转，当前仅支持完整 TFT 下载')
    return false
  }
  try {
    let connected = false
    for (const rate of new Set([baudRate, 9600, 115200, 57600, 38400, 19200, 4800, 2400, 1200])) {
      await exchange((done) => port.update({ baudRate: rate }, done))
      log(`正在联机：${rate} baud`)
      try {
        const response = await exchange(
          (done) =>
            write(
              Buffer.concat([
                tftCommand('DRAKJHSUYDGBNCJHGJKSHBDN'),
                Buffer.from([0, 255, 255, 255]),
                tftCommand('connect')
              ]),
              done
            ),
          (bytes) => /comok [^\xff]+\xff\xff\xff/.test(bytes.toString('latin1')),
          timeouts.connect + Math.ceil(1000000 / rate)
        )
        const info = response.toString('latin1').match(/comok ([^\xff]+)/)![1]
        log(`串口屏联机成功（${rate} baud）：${info}`)
        const capacity = Number(info.split(',').at(-1))
        if (data && Number.isSafeInteger(capacity) && capacity > 0 && data.length > capacity)
          throw new Error(`TFT 文件超过设备容量（${capacity} 字节）`)
        connected = true
        break
      } catch (error) {
        if (!(error instanceof ResponseTimeout)) throw error
      }
    }
    if (!connected) throw new Error('串口屏未响应，请检查供电、TX/RX 接线与设备是否支持 TFT 下载')
    if (!data) return
    // No undocumented resource-skip negotiation: send the complete file.
    // Drain the command at the detected baud before switching the host baud.
    log(`准备下载 TFT：${data.length} 字节，${baudRate} baud`)
    await exchange((done) => write(tftCommand('sleep=0'), done))
    await exchange(
      (done) =>
        write(tftCommand(`whmi-wri ${data.length},${baudRate},0`), (error) => {
          if (error || failure) done(error || failure)
          else {
            try {
              port.update({ baudRate }, done)
            } catch (cause) {
              done(cause as Error)
            }
          }
        }),
      ack
    )
    log('正在发送 TFT 文件')
    for (let offset = 0; offset < data.length; offset += 4096) {
      const block = data.subarray(offset, offset + 4096)
      await exchange(
        (done) => write(block, done),
        ack,
        timeouts.ack + Math.ceil((block.length * 10000) / baudRate)
      )
      progress(offset + block.length)
    }
    log('设备已确认全部 TFT 数据；请检查屏幕重启后的显示，尚未独立回读校验。')
  } finally {
    port.off('data', onData)
    port.off('error', fail)
    port.off('close', onClose)
    signal.removeEventListener('abort', onAbort)
  }
}
