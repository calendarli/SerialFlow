import { describe, expect, test } from 'bun:test'
import { SerialPortMonitor } from '../src/main/serial-port-monitor'
import { serialPortLabel, type SerialPortInfo } from '../src/common/serial-port'

describe('serial device discovery', () => {
  test('publishes insertion, removal and metadata changes but ignores ordering', async () => {
    let ports: SerialPortInfo[] = [{ path: 'COM6' }, { path: 'COM3' }]
    const updates: SerialPortInfo[][] = []
    const monitor = new SerialPortMonitor(
      async () => ports,
      (next) => updates.push(next)
    )
    expect((await monitor.refresh()).map((port) => port.path)).toEqual(['COM3', 'COM6'])
    ports = [...ports].reverse()
    await monitor.refresh()
    expect(updates).toHaveLength(1)
    ports = [{ path: 'COM3', manufacturer: 'Microsoft', serialNumber: 'M2_H-HB03061162' }]
    await monitor.refresh()
    ports = [...ports, { path: 'COM6', manufacturer: 'FTDI', serialNumber: 'D30GHEASA' }]
    await monitor.refresh()
    ports = ports.map((port) => ({ ...port, serialNumber: 'replacement' }))
    await monitor.refresh()
    expect(updates).toHaveLength(4)
  })

  test('shares concurrent enumeration and recovers after errors without clearing devices', async () => {
    let resolve!: (ports: SerialPortInfo[]) => void
    let calls = 0
    let fail = false
    const updates: SerialPortInfo[][] = []
    const monitor = new SerialPortMonitor(
      () => {
        calls++
        if (fail) return Promise.reject(new Error('enumeration failed'))
        return new Promise((done) => {
          resolve = done
        })
      },
      (next) => updates.push(next)
    )
    const first = monitor.refresh()
    expect(monitor.refresh()).toBe(first)
    expect(calls).toBe(1)
    resolve([{ path: 'COM3' }])
    await first
    fail = true
    await expect(monitor.refresh()).rejects.toThrow('enumeration failed')
    expect(updates).toHaveLength(1)
    fail = false
    const recovered = monitor.refresh()
    resolve([])
    await recovered
    expect(updates).toEqual([[{ path: 'COM3' }], []])
  })

  test('automatically polls and stops polling on shutdown', async () => {
    let calls = 0
    const monitor = new SerialPortMonitor(
      async () => {
        calls++
        return []
      },
      () => {},
      5
    )
    monitor.start()
    monitor.start()
    try {
      await new Promise((resolve) => setTimeout(resolve, 35))
      expect(calls).toBeGreaterThan(1)
    } finally {
      monitor.stop()
    }
    const stopped = calls
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls).toBe(stopped)
  })

  test('labels devices with manufacturer and serial number, with missing metadata fallback', () => {
    expect(
      serialPortLabel({ path: 'COM3', manufacturer: 'Microsoft', serialNumber: 'M2_H-HB03061162' })
    ).toBe('COM3 · Microsoft, M2_H-HB03061162')
    expect(serialPortLabel({ path: 'COM6', manufacturer: 'FTDI', serialNumber: 'D30GHEASA' })).toBe(
      'COM6 · FTDI, D30GHEASA'
    )
    expect(serialPortLabel({ path: 'COM1' })).toBe('COM1')
    expect(serialPortLabel({ path: 'COM1', manufacturer: ' FTDI ', friendlyName: 'FTDI' })).toBe(
      'COM1 · FTDI'
    )
  })
})
