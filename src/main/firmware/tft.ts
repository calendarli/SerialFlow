import type { YmodemPort } from './ymodem'
import { setTimeout as delay } from 'node:timers/promises'

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
  timeouts = { connect: 600, ack: 30000 },
  useDetectedBaud = false
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
    timeout = timeouts.ack,
    stage = '串口屏通讯'
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
      const timer = setTimeout(() => {
        const received = buffer.length
          ? buffer.subarray(-32).toString('hex').toUpperCase().match(/../g)!.join(' ')
          : '无'
        finish(
          written
            ? new ResponseTimeout(`${stage}响应超时；已收到：${received}`)
            : new Error(`${stage}：串口操作超时；已收到：${received}`)
        )
      }, timeout)
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
  const reply = (buffer: Buffer, allowSkip = false): number | null => {
    // Ordinary command replies are FF-terminated; do not mistake a 0x05
    // embedded in one for the download protocol's standalone acknowledgement.
    let offset = 0
    while (offset < buffer.length) {
      if (buffer[offset] === 5) return 0
      if (buffer[offset] === 8 && allowSkip)
        return buffer.length - offset < 5 ? null : buffer.readUInt32LE(offset + 1)
      const boundary = buffer.indexOf(end, offset)
      if (boundary < 0) return null
      offset = boundary + 3
    }
    return null
  }
  try {
    let connected = false
    let detectedBaud = baudRate
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
        detectedBaud = rate
        break
      } catch (error) {
        if (!(error instanceof ResponseTimeout)) throw error
      }
    }
    if (!connected) throw new Error('串口屏未响应，请检查供电、TX/RX 接线与设备是否支持 TFT 下载')
    if (!data) return
    if (useDetectedBaud) baudRate = detectedBaud
    // Match the captured official downloader: stop the running screen program,
    // synchronize its command queue, then wake it before requesting v1.2 upload.
    log(`准备下载 TFT：${data.length} 字节，${baudRate} baud`)
    await exchange((done) => write(tftCommand('runmod=2'), done))
    await exchange(
      (done) => write(tftCommand('print "mystop_yesABC"'), done),
      (bytes) => bytes.includes(Buffer.from('mystop_yesABC')),
      timeouts.ack,
      '等待屏幕命令同步'
    )
    await exchange((done) => write(tftCommand('sleep=0'), done))
    await delay(100, undefined, { signal })
    log(`请求下载：whmi-wris ${data.length},${baudRate},1；等待下载许可 0x05`)
    await exchange(
      (done) =>
        write(tftCommand(`whmi-wris ${data.length},${baudRate},1`), (error) => {
          if (error || failure) done(error || failure)
          else if (baudRate === detectedBaud) done()
          else {
            try {
              port.update({ baudRate }, done)
            } catch (cause) {
              done(cause as Error)
            }
          }
        }),
      (bytes) => reply(bytes) !== null,
      timeouts.ack,
      `等待下载许可 0x05（${baudRate} baud）`
    )
    log(`已收到下载许可 0x05；准备发送首包（${baudRate} baud）`)
    // The captured official uploader leaves ~400 ms between readiness and data.
    await delay(400, undefined, { signal })
    for (let offset = 0; offset < data.length;) {
      const block = data.subarray(offset, offset + 4096)
      if (offset === 0) log(`正在发送 TFT 首包：${block.length} 字节（每次写入最多 1024 字节）`)
      const response = await exchange(
        (done) => {
          let sent = 0
          const sendNext = (error?: Error | null): void => {
            if (error || failure) return done(error || failure)
            if (sent === block.length) {
              if (offset === 0) log('首包已发送，等待屏幕确认 0x05 / 0x08')
              return done()
            }
            const part = block.subarray(sent, sent + 1024)
            sent += part.length
            try {
              write(part, sendNext)
            } catch (cause) {
              done(cause as Error)
            }
          }
          sendNext()
        },
        (bytes) => reply(bytes, true) !== null,
        timeouts.ack + Math.ceil((block.length * 10000) / baudRate),
        `等待文件 ${offset}–${offset + block.length} 字节确认`
      )
      const next = reply(response, true)!
      const sequential = offset + block.length
      if (next !== 0 && (next < sequential || next > data.length))
        throw new Error(`屏幕返回无效文件偏移：${next}`)
      offset = next || sequential
      if (sequential === block.length) log('屏幕已确认首包，继续下载')
      if (offset > sequential) log(`屏幕确认相同资源，跳转至 ${offset} / ${data.length} 字节`)
      progress(offset)
    }
    log('设备已确认全部 TFT 数据；请检查屏幕重启后的显示，尚未独立回读校验。')
  } finally {
    port.off('data', onData)
    port.off('error', fail)
    port.off('close', onClose)
    signal.removeEventListener('abort', onAbort)
  }
}
