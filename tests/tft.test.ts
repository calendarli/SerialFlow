import { EventEmitter } from 'node:events'
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transferTft, tftCommand } from '../src/main/firmware/tft'
import { inspectTftFirmware, validateRequest } from '../src/main/firmware/validation'
import { FirmwareManager } from '../src/main/firmware/manager'
import type { FirmwareRequest } from '../src/common/firmware'

class Screen extends EventEmitter {
  baudRate = 115200
  rates: number[] = []
  blocks: Buffer[] = []
  commands: string[] = []
  downloading = false
  capacity = 4194304
  reply = true
  disconnect = false
  duplicate = false
  connectRate = 115200
  onBlock?: () => void
  update(options: { baudRate: number }, done: (error?: Error) => void): void {
    this.baudRate = options.baudRate
    this.rates.push(options.baudRate)
    done()
  }
  drain(done: (error?: Error) => void): void {
    done()
  }
  write(bytes: Buffer, done: (error?: Error) => void): void {
    if (this.downloading) {
      this.blocks.push(Buffer.from(bytes))
      this.onBlock?.()
      if (this.disconnect) this.emit('close')
      else if (this.reply) this.emit('data', Buffer.from(this.duplicate ? [5, 5] : [5]))
    } else {
      const command = bytes.toString('latin1')
      this.commands.push(command)
      if (command.startsWith('print "mystop_yesABC"'))
        this.emit('data', Buffer.from('mystop_yesABC'))
      if (command.includes('connect') && this.baudRate === this.connectRate) {
        // Fragmented response plus preceding normal command reply.
        this.emit('data', Buffer.from([1, 255, 255, 255]))
        this.emit('data', Buffer.from('com'))
        this.emit(
          'data',
          tftCommand(`ok 0,30517-0,TJC1612T118_011N,124,61744,DD27350109AC7872,${this.capacity}`)
        )
      }
      if (command.startsWith('whmi-wris ') && command.endsWith(',1\xff\xff\xff')) {
        this.downloading = true
        this.emit('data', Buffer.from([5]))
      }
    }
    done()
  }
}
const run = (
  screen: Screen,
  data: Buffer | null,
  signal = new AbortController().signal,
  progress: (n: number) => void = () => {}
) => transferTft(screen, data, 115200, signal, progress, () => {}, { connect: 1, ack: 5 })

test('TFT scans baud, parses split comok, switches baud and sends exact 4096 byte blocks', async () => {
  const screen = new Screen()
  screen.connectRate = 9600
  const data = Buffer.alloc(8193, 0xab)
  const progress: number[] = []
  await run(screen, data, undefined, (n) => progress.push(n))
  expect(screen.rates).toEqual([115200, 9600, 115200])
  expect(
    screen.commands.some(
      (command) => command === tftCommand('whmi-wris 8193,115200,1').toString('latin1')
    )
  ).toBe(true)
  expect(screen.blocks.map((b) => b.length)).toEqual([4096, 4096, 1])
  expect(Buffer.concat(screen.blocks)).toEqual(data)
  expect(progress).toEqual([4096, 8192, 8193])
  expect(screen.listenerCount('data')).toBe(0)
})
test('TFT detection does not enter download and capacity rejection does not send data', async () => {
  const screen = new Screen()
  await run(screen, null)
  expect(screen.downloading).toBe(false)
  screen.capacity = 1
  await expect(run(screen, Buffer.alloc(2))).rejects.toThrow('容量')
  expect(screen.blocks.length).toBe(0)
})

test('TFT missing ready ACK never sends a file block; stalled driver operations are fatal', async () => {
  const screen = new Screen()
  const originalWrite = screen.write.bind(screen)
  screen.write = (bytes, done) => {
    if (bytes.toString('ascii').startsWith('whmi-wri')) done()
    else originalWrite(bytes, done)
  }
  await expect(run(screen, Buffer.alloc(1))).rejects.toThrow('超时')
  expect(screen.blocks).toEqual([])
  const stalled = new Screen()
  stalled.drain = () => {}
  await expect(run(stalled, null)).rejects.toThrow('串口操作超时')
  expect(stalled.rates).toEqual([115200])
})

test('TFT no device response fails discovery without issuing download command', async () => {
  const screen = new Screen()
  screen.connectRate = 0
  await expect(run(screen, Buffer.alloc(1))).rejects.toThrow('未响应')
  expect(screen.downloading).toBe(false)
  expect(screen.listenerCount('data')).toBe(0)
})
test('TFT duplicate ACK cannot confirm following block; unconfirmed data is never retried', async () => {
  const screen = new Screen()
  screen.duplicate = true
  screen.onBlock = () => {
    if (screen.blocks.length === 2) screen.reply = false
  }
  const progress: number[] = []
  await expect(run(screen, Buffer.alloc(4097), undefined, (n) => progress.push(n))).rejects.toThrow(
    '超时'
  )
  expect(screen.blocks.length).toBe(2)
  expect(progress).toEqual([4096])
  expect(screen.listenerCount('error')).toBe(0)
})

test('TFT enhanced replies support fragmented skip, zero continuation and reject invalid offsets', async () => {
  for (const target of [0, 8192, 8193, 1, 9000]) {
    const screen = new Screen()
    const write = screen.write.bind(screen)
    screen.write = (bytes, done) => {
      if (!screen.downloading || screen.blocks.length) return write(bytes, done)
      screen.blocks.push(Buffer.from(bytes))
      const response = Buffer.alloc(5)
      response[0] = 8
      response.writeUInt32LE(target, 1)
      screen.emit('data', response.subarray(0, 2))
      setTimeout(() => screen.emit('data', response.subarray(2)), 1)
      done()
    }
    const data = Buffer.alloc(8193)
    data[8192] = 0x73
    const progress: number[] = []
    const result = run(screen, data, undefined, (n) => progress.push(n))
    if (target === 1 || target === 9000) {
      await expect(result).rejects.toThrow('无效文件偏移')
      expect(progress).toEqual([])
    } else {
      await result
      expect(progress.at(-1)).toBe(data.length)
      expect(screen.blocks.length).toBe(target === 0 ? 3 : target === 8192 ? 2 : 1)
      if (target === 8192) expect(screen.blocks[1]).toEqual(data.subarray(8192))
    }
  }
})
test('TFT disconnect, cancellation and serial write failures abort and remove listeners', async () => {
  for (const kind of ['disconnect', 'abort', 'write']) {
    const screen = new Screen()
    const controller = new AbortController()
    screen.disconnect = kind === 'disconnect'
    if (kind === 'abort') screen.onBlock = () => controller.abort()
    if (kind === 'write') screen.write = (_bytes, done) => done(new Error('write failed'))
    await expect(run(screen, Buffer.alloc(1), controller.signal)).rejects.toThrow()
    expect(screen.listenerCount('data')).toBe(0)
    expect(screen.listenerCount('close')).toBe(0)
  }
})

const base: FirmwareRequest = {
  family: 'tft',
  transport: 'uart',
  port: 'COM9',
  probe: '',
  chip: 'auto',
  baudRate: 115200,
  files: [],
  verify: false,
  reset: false,
  restorePort: true,
  listenForC: false,
  eraseAll: false,
  manualBoot: false,
  connectMode: 'NORMAL',
  toolPath: ''
}
test('TFT preflight rejects unsupported options, files and empty images', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tft-test-'))
  try {
    const path = join(dir, 'screen.TFT')
    const request = { ...base, files: [{ path, name: 'screen.TFT', size: 1, address: '' }] }
    writeFileSync(path, Buffer.from([1]))
    expect(await inspectTftFirmware(request)).toEqual(Buffer.from([1]))
    for (const patch of [
      { transport: 'swd' },
      { verify: true },
      { reset: true },
      { eraseAll: true },
      { listenForC: true },
      { files: [] },
      { files: [request.files[0], request.files[0]] }
    ])
      expect(() => validateRequest({ ...request, ...patch } as FirmwareRequest, true)).toThrow()
    writeFileSync(path, Buffer.alloc(0))
    await expect(inspectTftFirmware(request)).rejects.toThrow('为空')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('TFT manager completes, fails or cancels with exclusive port cleanup and restore warning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tft-manager-'))
  try {
    const path = join(dir, 'screen.tft')
    writeFileSync(path, Buffer.alloc(12))
    for (const mode of ['success', 'disconnect', 'cancel', 'restore']) {
      const screen = new Screen()
      screen.disconnect = mode === 'disconnect'
      let acquired = 0,
        closed = 0,
        released = 0
      const manager = new FirmwareManager({
        resources: dir,
        temp: dir,
        emit: () => {},
        acquire: async () => {
          acquired++
          return async () => {
            released++
            if (mode === 'restore') throw new Error('restore failed')
          }
        },
        openTft: async () => ({
          port: screen,
          close: async () => {
            closed++
          }
        })
      })
      if (mode === 'cancel') screen.onBlock = () => manager.cancel(manager.snapshot()!.id)
      manager.start(
        { ...base, files: [{ path, name: 'screen.tft', size: 12, address: '' }] },
        'flash'
      )
      const deadline = Date.now() + 2000
      while (manager.snapshot()?.busy && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 1))
      expect(manager.snapshot()?.busy).toBe(false)
      expect(manager.snapshot()?.outcome).toBe(
        mode === 'disconnect' ? 'error' : mode === 'cancel' ? 'cancelled' : 'success'
      )
      expect([acquired, closed, released]).toEqual([1, 1, 1])
      if (mode === 'restore') expect(manager.snapshot()?.restoreWarning).toContain('restore failed')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TFT detection restores the existing port even with post-flash restoration disabled', async () => {
  for (const mode of ['success', 'error', 'cancel', 'restore-error']) {
    let restored = false
    const screen = new Screen()
    const request = { ...base, restorePort: false }
    const manager = new FirmwareManager({
      resources: '',
      temp: '',
      emit: () => {},
      acquire: async (effective) => {
        expect(effective.restorePort).toBe(true)
        return async () => {
          restored = true
          if (mode === 'restore-error') throw new Error('restore failed')
        }
      },
      openTft: async () => {
        if (mode === 'error') throw new Error('open failed')
        if (mode === 'cancel') manager.cancel(manager.snapshot()!.id)
        return { port: screen, close: async () => {} }
      }
    })
    manager.start(request, 'detect')
    const deadline = Date.now() + 2000
    while (manager.snapshot()?.busy && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 1))
    expect(manager.snapshot()?.busy).toBe(false)
    expect(restored).toBe(true)
    expect(request.restorePort).toBe(false)
    expect(manager.snapshot()?.outcome).toBe(
      mode === 'error' ? 'error' : mode === 'cancel' ? 'cancelled' : 'success'
    )
    if (mode === 'restore-error')
      expect(manager.snapshot()?.restoreWarning).toContain('restore failed')
  }
})
