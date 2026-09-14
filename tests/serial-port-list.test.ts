import { expect, test } from 'bun:test'
import { createSerialPortLister } from '../src/main/serial-port-list'
import type { SerialPortInfo } from '../src/common/serial-port'

test('enriches generated serials, preserves real serials and invalidates cache after removal', async () => {
  const device = { path: 'COM3', serialNumber: '9&35DBA404&1&0000' }
  let ports: SerialPortInfo[] = [device, { path: 'COM6', serialNumber: 'D30GHEASA' }]
  let reads = 0
  const list = createSerialPortLister(
    async () => ports,
    async () => {
      reads++
      return [{ path: 'COM3', serialNumber: 'M2_H-HB03061162' }]
    },
    'win32'
  )
  expect((await list()).map((port) => port.serialNumber)).toEqual(['M2_H-HB03061162', 'D30GHEASA'])
  await list()
  expect(reads).toBe(1)
  expect(device.serialNumber).toBe('9&35DBA404&1&0000')
  ports = []
  await list()
  ports = [device]
  await list()
  expect(reads).toBe(2)
})

test('registry failures preserve discovery and back off retries', async () => {
  const ports = [{ path: 'COM3' }]
  let reads = 0
  const list = createSerialPortLister(
    async () => ports,
    async () => {
      reads++
      throw new Error('Access denied')
    },
    'win32'
  )
  expect(await list()).toEqual(ports)
  expect(await list()).toEqual(ports)
  expect(reads).toBe(1)
})

test('other platforms never query the Windows registry', async () => {
  let reads = 0
  const ports = [{ path: '/dev/ttyUSB0' }]
  const list = createSerialPortLister(
    async () => ports,
    async () => {
      reads++
      return []
    },
    'linux'
  )
  expect(await list()).toEqual(ports)
  expect(reads).toBe(0)
})

for (const platform of ['linux', 'darwin'] as const) {
  test(`${platform} retains native device metadata and never invokes Windows enrichment`, async () => {
    const path = platform === 'linux' ? '/dev/ttyACM0' : '/dev/cu.usbmodemM2_H-HB03061162'
    let ports: SerialPortInfo[] = [
      {
        path,
        manufacturer: 'Device Vendor',
        serialNumber: 'M2_H-HB03061162',
        friendlyName: 'USB Controller',
        vendorId: '3513',
        productId: '0002'
      }
    ]
    let reads = 0
    const list = createSerialPortLister(
      async () => ports,
      async () => {
        reads++
        throw new Error('Windows reader must not run')
      },
      platform
    )
    expect(await list()).toEqual(ports)
    ports = []
    expect(await list()).toEqual([])
    ports = [{ path, serialNumber: '9&35DBA404&1&0000' }]
    expect(await list()).toEqual(ports)
    expect(reads).toBe(0)
  })
}
