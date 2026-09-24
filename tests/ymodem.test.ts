import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'bun:test'
import { crc16Ymodem, sendYmodem, ymodemHeader, ymodemPacket } from '../src/main/firmware/ymodem'

const SOH = 0x01
const STX = 0x02
const EOT = 0x04
const ACK = 0x06
const NAK = 0x15
const CAN = 0x18
const C = 0x43

class Receiver extends EventEmitter {
  packets: Buffer[] = []
  eots = 0
  acknowledged = 0
  private phase: 'header' | 'data' | 'final' | 'done' = 'header'
  private rejectOnce = false
  constructor(
    private eotMode: 'standard' | 'stm32' = 'standard',
    retry = false
  ) {
    super()
    this.rejectOnce = retry
    queueMicrotask(() => this.reply(C))
  }
  private reply(...bytes: number[]): void {
    queueMicrotask(() => this.emit('data', Buffer.from(bytes)))
  }
  write(data: Buffer, callback: (error?: Error | null) => void): void {
    callback()
    if (data[0] === CAN) return
    if (data[0] === EOT) {
      this.eots++
      if (this.eotMode === 'standard' && this.eots === 1) this.reply(NAK)
      else {
        this.phase = 'final'
        this.reply(ACK, C)
      }
      return
    }
    assert([SOH, STX].includes(data[0]))
    const size = data[0] === SOH ? 128 : 1024
    assert.equal(data.length, size + 5)
    assert.equal(data[1] ^ data[2], 0xff)
    assert.equal(data.readUInt16BE(size + 3), crc16Ymodem(data.subarray(3, size + 3)))
    this.packets.push(Buffer.from(data))
    if (this.phase === 'header') {
      assert.equal(data[1], 0)
      this.phase = 'data'
      this.reply(ACK, C)
    } else if (this.phase === 'data') {
      if (this.rejectOnce) {
        this.rejectOnce = false
        this.reply(this.eotMode === 'stm32' ? C : NAK)
        return
      }
      assert.equal(data[1], (this.acknowledged + 1) & 255)
      this.acknowledged++
      this.reply(ACK)
    } else if (this.phase === 'final') {
      assert.equal(data[1], 0)
      assert(data.subarray(3, 131).every((value) => value === 0))
      this.phase = 'done'
      this.reply(ACK)
    } else assert.fail('unexpected packet after final ACK')
  }
}

test('Ymodem CRC16, metadata and padding match packet rules', () => {
  assert.equal(crc16Ymodem(Buffer.from('123456789')), 0x31c3)
  const header = ymodemHeader('firmware.bin', 1030)
  assert.equal(header[0], SOH)
  assert.equal(header.subarray(3, 21).toString('ascii'), 'firmware.bin\x001030\x00')
  const data = ymodemPacket(257, Buffer.from([1, 2, 3]), 1024, 0x1a)
  assert.equal(data[0], STX)
  assert.equal(data[1], 1)
  assert(data.subarray(6, 1027).every((byte) => byte === 0x1a))
  assert.throws(() => ymodemHeader('固件.bin', 3), /ASCII/)
})

for (const eotMode of ['standard', 'stm32'] as const) {
  test(`Ymodem sender completes ${eotMode} receiver handshake with NAK retry`, async () => {
    const receiver = new Receiver(eotMode, true)
    const progress: number[] = []
    await sendYmodem(
      receiver,
      'firmware.bin',
      Buffer.alloc(2051, 0xa5),
      new AbortController().signal,
      (value) => progress.push(value),
      () => {}
    )
    assert.deepEqual(progress, [1024, 2048, 2051])
    assert.equal(receiver.eots, eotMode === 'standard' ? 2 : 1)
    assert.equal(receiver.packets[0][0], SOH)
    assert.equal(receiver.packets.at(-1)![0], SOH)
    assert.equal(receiver.packets.filter((packet) => packet[1] === 1).length, 2)
  })
}

test('Ymodem uses 128-byte tail blocks to bound flash padding', async () => {
  const receiver = new Receiver()
  await sendYmodem(
    receiver,
    'firmware.bin',
    Buffer.alloc(129, 0x5a),
    new AbortController().signal,
    () => {},
    () => {}
  )
  assert.deepEqual(
    receiver.packets.map((packet) => packet[0]),
    [SOH, SOH, SOH, SOH]
  )
  assert.equal(
    receiver.packets[2].subarray(4, 131).every((byte) => byte === 0x1a),
    true
  )
})

test('Ymodem sender stops on peer cancellation and sends cancel on failure', async () => {
  class CancellingReceiver extends Receiver {
    writes: Buffer[] = []
    override write(data: Buffer, callback: (error?: Error | null) => void): void {
      this.writes.push(Buffer.from(data))
      if (data[0] === SOH && data[1] === 0) {
        callback()
        queueMicrotask(() => this.emit('data', Buffer.from([CAN, CAN])))
      } else callback()
    }
  }
  const receiver = new CancellingReceiver()
  await assert.rejects(
    sendYmodem(
      receiver,
      'firmware.bin',
      Buffer.from([1]),
      new AbortController().signal,
      () => {},
      () => {}
    ),
    /取消/
  )
  assert.deepEqual(receiver.writes.at(-1), Buffer.from([CAN, CAN]))
})

test('Ymodem sender cancellation interrupts a pending handshake', async () => {
  const controller = new AbortController()
  const port = Object.assign(new EventEmitter(), {
    writes: [] as Buffer[],
    write(data: Buffer, callback: (error?: Error | null) => void) {
      this.writes.push(Buffer.from(data))
      callback()
    }
  })
  const task = sendYmodem(
    port,
    'firmware.bin',
    Buffer.from([1]),
    controller.signal,
    () => {},
    () => {}
  )
  controller.abort()
  await assert.rejects(task, /停止/)
  assert.deepEqual(port.writes, [Buffer.from([CAN, CAN])])
})
