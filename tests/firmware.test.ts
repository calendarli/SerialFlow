import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'bun:test'
import type { FirmwareRequest } from '../src/common/firmware'
import * as validation from '../src/main/firmware/validation'
import { flashCommands, FirmwareManager } from '../src/main/firmware/manager'
const base: FirmwareRequest = {
  family: 'stm32',
  transport: 'uart',
  port: 'COM9',
  probe: '',
  chip: 'auto',
  baudRate: 115200,
  files: [],
  verify: true,
  reset: true,
  restorePort: true,
  eraseAll: false,
  manualBoot: false,
  connectMode: 'NORMAL',
  toolPath: ''
}
function record(type: number, address: number, data: number[] = []) {
  const bytes = [data.length, address >> 8, address & 255, type, ...data]
  bytes.push(-bytes.reduce((sum, n) => sum + n, 0) & 255)
  return ':' + Buffer.from(bytes).toString('hex').toUpperCase()
}
const hex = [record(4, 0, [8, 0]), record(0, 16, [1, 2, 3, 4]), record(1, 0)].join('\n')

test('HEX validates extended addresses, checksums, EOF, overlaps and unsupported records', () => {
  assert.deepEqual(validation.parseIntelHex(hex), [{ start: 0x08000010, end: 0x08000014 }])
  assert.deepEqual(
    validation.parseIntelHex(
      [record(2, 0, [0x12, 0x34]), record(0, 2, [1]), record(1, 0)].join('\n')
    ),
    [{ start: 0x12342, end: 0x12343 }]
  )
  for (const bad of [
    hex.replace('01020304', '01020305'),
    hex.split('\n').slice(0, 2).join('\n'),
    hex + '\n' + record(0, 0, [1]),
    [record(0, 1, [1, 2]), record(0, 2, [3]), record(1, 0)].join('\n'),
    [record(6, 0), record(1, 0)].join('\n')
  ])
    assert.throws(() => validation.parseIntelHex(bad))
  assert.throws(() => validation.parseAddress('0x1000 -e all'))
  assert.throws(() => validation.parseAddress('4294967296'))
})

test('preflight rejects protected STM32 regions, ESP overlaps, missing addresses and unsupported formats', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'serialflow-test-'))
  try {
    const bin = path.join(directory, 'firmware with spaces.bin')
    const hexPath = path.join(directory, 'firmware.hex')
    fs.writeFileSync(bin, Buffer.alloc(16))
    fs.writeFileSync(hexPath, hex)
    const file = { path: bin, name: path.basename(bin), size: 16, address: '0x08000000' }
    assert.equal(
      (await validation.inspectFirmware({ ...base, files: [file] }))[0].address,
      0x08000000
    )
    assert.equal(
      (
        await validation.inspectFirmware({
          ...base,
          files: [{ ...file, path: hexPath, address: '' }]
        })
      )[0].address,
      0x08000010
    )
    await assert.rejects(
      validation.inspectFirmware({ ...base, files: [{ ...file, address: '0x1FFF7800' }] }),
      /Flash/
    )
    const esp: FirmwareRequest = {
      ...base,
      family: 'esp32',
      files: [
        { ...file, address: '0x1000' },
        { ...file, address: '0x1008' }
      ]
    }
    await assert.rejects(validation.inspectFirmware(esp), /重叠/)
    await assert.rejects(
      validation.inspectFirmware({ ...esp, files: [{ ...file, address: '' }] }),
      /地址/
    )
    await assert.rejects(
      validation.inspectFirmware({ ...esp, files: [{ ...file, path: hexPath }] }),
      /BIN/
    )
    fs.writeFileSync(
      hexPath,
      [record(4, 0, [0x1f, 0xff]), record(0, 0x7800, [1]), record(1, 0)].join('\n')
    )
    await assert.rejects(
      validation.inspectFirmware({ ...base, files: [{ ...file, path: hexPath }] }),
      /Flash/
    )
    const largeHex: string[] = []
    for (let i = 0; i < 150000; i++) {
      if (i % 65536 === 0) largeHex.push(record(4, 0, [8, Math.floor(i / 65536)]))
      largeHex.push(record(0, i % 65536, [i & 255]))
    }
    largeHex.push(record(1, 0))
    fs.writeFileSync(hexPath, largeHex.join('\n'))
    assert.equal(
      (await validation.inspectFirmware({ ...base, files: [{ ...file, path: hexPath }] }))[0].ranges
        .length,
      150000
    )
    fs.writeFileSync(bin, '')
    await assert.rejects(validation.inspectFirmware({ ...base, files: [file] }), /为空/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('commands preserve arguments and avoid unsupported UART reset or forced security bypass', () => {
  const file = {
    name: 'firmware.bin',
    size: 4,
    path: 'C:\\firmware with spaces.bin',
    address: '0x08000000'
  }
  const uart = flashCommands({ ...base, files: [file] }, [file.path])[0].args
  assert(uart.includes(file.path))
  assert(uart.includes('-v'))
  assert(!uart.includes('-rst'))
  assert(!uart.includes('-e'))
  const swd = flashCommands(
    { ...base, transport: 'swd', probe: '1234567890', files: [file], eraseAll: true },
    [file.path]
  )[0].args
  assert(swd.includes('-rst'))
  assert(swd.includes('-e'))
  const esp = flashCommands(
    { ...base, family: 'esp32', manualBoot: true, files: [{ ...file, address: '0x1000' }] },
    [file.path]
  )[0].args
  assert(esp.includes('no-reset'))
  assert(esp.includes('write-flash'))
  assert(!esp.includes('--force'))
  assert(!esp.includes('--trust-flash-content'))
  assert.deepEqual(esp.slice(-2), ['0x1000', file.path])
  assert.throws(() => flashCommands({ ...base, transport: 'ymodem' }, []), /Ymodem/)
})

test('Ymodem request accepts BIN only and cannot claim unsupported controls or chip detection', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'serialflow-ymodem-validation-'))
  try {
    const bin = path.join(directory, 'firmware.bin')
    const hexPath = path.join(directory, 'firmware.hex')
    fs.writeFileSync(bin, Buffer.from([1, 2, 3]))
    fs.writeFileSync(hexPath, hex)
    const request: FirmwareRequest = {
      ...base,
      transport: 'ymodem',
      verify: false,
      reset: false,
      files: [{ path: bin, name: 'firmware.bin', size: 3, address: '' }]
    }
    assert.deepEqual(await validation.inspectYmodemFirmware(request), Buffer.from([1, 2, 3]))
    assert.throws(() => validation.validateRequest({ ...request, verify: true }, true), /Ymodem/)
    assert.throws(() => validation.validateRequest({ ...request, eraseAll: true }, true), /Ymodem/)
    assert.throws(
      () =>
        validation.validateRequest(
          { ...request, files: [{ ...request.files[0], path: hexPath }] },
          true
        ),
      /BIN/
    )
    assert.throws(() => validation.validateRequest({ ...request, family: 'esp32' }, true), /ESP32/)
    const manager = new FirmwareManager({
      resources: directory,
      temp: directory,
      emit() {
        /* Assertions read snapshots directly. */
      },
      acquire: async () => async () => {}
    })
    assert.throws(() => manager.start(request, 'detect'), /检测/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('Ymodem firmware task owns and restores the serial port without CubeProgrammer', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'serialflow-ymodem-manager-'))
  try {
    const bin = path.join(directory, 'firmware.bin')
    fs.writeFileSync(bin, Buffer.alloc(129, 0x5a))
    const request: FirmwareRequest = {
      ...base,
      transport: 'ymodem',
      verify: false,
      reset: false,
      files: [{ path: bin, name: 'firmware.bin', size: 129, address: '' }]
    }
    const port = new EventEmitter() as EventEmitter & {
      write: (data: Buffer, callback: (error?: Error | null) => void) => void
    }
    let phase: 'header' | 'data' | 'final' = 'header'
    let released = 0
    let closed = 0
    port.write = (data, callback) => {
      callback()
      if (data[0] === 0x04) {
        phase = 'final'
        queueMicrotask(() => port.emit('data', Buffer.from([0x06, 0x43])))
      } else if (phase === 'header') {
        phase = 'data'
        queueMicrotask(() => port.emit('data', Buffer.from([0x06, 0x43])))
      } else queueMicrotask(() => port.emit('data', Buffer.from([0x06])))
    }
    const manager = new FirmwareManager({
      resources: directory,
      temp: directory,
      emit() {
        /* Assertions read snapshots directly. */
      },
      acquire: async () => async () => {
        released++
      },
      openYmodem: async () => {
        setTimeout(() => port.emit('data', Buffer.from([0x43])), 0)
        return {
          port,
          close: async () => {
            closed++
          }
        }
      }
    })
    manager.start(request, 'flash')
    await until(() => !manager.snapshot()!.busy)
    assert.equal(manager.snapshot()!.outcome, 'success')
    assert.equal(manager.snapshot()!.percent, 100)
    assert.equal(released, 1)
    assert.equal(closed, 1)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function harness(directory, behavior = 'success') {
  const calls: string[][] = []
  let released = 0
  let acquired = 0
  let current
  const mocks = {
    child_process: {
      spawn(_exe, args, options) {
        assert.equal(options.shell, false)
        assert.equal(options.windowsHide, true)
        calls.push(args)
        const child = Object.assign(new EventEmitter(), {
          pid: 123456,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: (): boolean => true
        })
        let closed = false
        child.kill = () => {
          if (!closed) {
            closed = true
            setImmediate(() => child.emit('close', null))
          }
          return true
        }
        current = child
        setImmediate(() => {
          if (args[0] === 'version') {
            child.stdout.write('esptool v5.3.1\n')
            child.emit('close', 0)
            return
          }
          if (behavior === 'hang') return
          if (behavior === 'error') {
            child.stderr.write('A fatal error occurred: disconnected')
            child.emit('close', 0)
            return
          }
          child.stdout.write('Chip is ESP32\nWriting at 0x1000 (50 %)\nHash of data verified.\n')
          child.emit('close', 0)
        })
        return child
      },
      execFile(_exe, args, _options, callback) {
        assert(args.includes('/T'))
        current.kill()
        setImmediate(callback)
      }
    }
  }
  const manager = new FirmwareManager({
    process: mocks.child_process,
    resources: directory,
    temp: directory,
    emit() {
      /* Assertions read snapshots directly. */
    },
    acquire: async () => {
      acquired++
      if (behavior === 'busy') throw new Error('端口正在传输文件')
      return async () => {
        released++
        if (behavior === 'restore-error') throw new Error('device removed')
      }
    }
  })
  return { manager, calls, acquired: () => acquired, released: () => released }
}

async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('test condition timed out')
}

test('task success, failures, cancellation, duplicate starts and restoration release resources', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'serialflow-manager-test-'))
  try {
    const exe = path.join(directory, process.platform === 'win32' ? 'esptool.exe' : 'esptool')
    fs.writeFileSync(exe, '')
    const bin = path.join(directory, 'firmware.bin')
    fs.writeFileSync(bin, Buffer.from([1, 2, 3, 4]))
    const request: FirmwareRequest = {
      ...base,
      family: 'esp32',
      toolPath: exe,
      files: [{ path: bin, name: 'firmware.bin', size: 4, address: '0x1000' }]
    }
    for (const behavior of ['success', 'error', 'hang', 'busy', 'restore-error']) {
      const h = harness(directory, behavior)
      const id = h.manager.start(request, 'flash')
      assert.throws(() => h.manager.start(request, 'flash'), /已有任务/)
      if (behavior === 'hang') {
        await until(() => h.calls.length === 2)
        h.manager.cancel('incorrect-task-id')
        assert(h.manager.snapshot()!.busy)
        h.manager.cancel(id)
      }
      await until(() => !h.manager.snapshot()!.busy)
      const state = h.manager.snapshot()!
      assert.equal(
        state.outcome,
        behavior === 'hang'
          ? 'cancelled'
          : ['error', 'busy'].includes(behavior)
            ? 'error'
            : 'success',
        JSON.stringify(state)
      )
      assert.equal(h.released(), behavior === 'busy' ? 0 : 1)
      if (behavior === 'restore-error') assert.match(state.restoreWarning!, /恢复串口失败/)
      if (behavior === 'success') {
        assert.equal(state.percent, 100)
        const copied = h.calls[1].at(-1)!
        assert.notEqual(copied, bin)
        assert(!fs.existsSync(copied), 'temporary firmware must be removed')
      }
      assert.equal(
        fs.readdirSync(directory).filter((name) => name.startsWith('serialflow-flash-')).length,
        0
      )
    }
    const h = harness(directory)
    const bad = { ...request, files: [{ ...request.files[0], address: '' }] }
    h.manager.start(bad, 'flash')
    await until(() => !h.manager.snapshot()!.busy)
    assert.equal(h.acquired(), 0, 'invalid firmware must fail before taking the serial port')
    assert.equal(h.calls.length, 1, 'invalid firmware must not invoke a device command')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
