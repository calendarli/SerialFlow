import { expect, test } from 'bun:test'
import { normalizeSerialPortPath, serialPortLabel } from '../src/common/serial-port'

test('only Windows COM names are normalized to uppercase', () => {
  expect(normalizeSerialPortPath(' com3 ')).toBe('COM3')
  expect(normalizeSerialPortPath('/dev/ttyACM0')).toBe('/dev/ttyACM0')
  expect(normalizeSerialPortPath('/dev/cu.usbserial-D30GHEASA')).toBe('/dev/cu.usbserial-D30GHEASA')
  expect(normalizeSerialPortPath('/dev/serial/by-id/usb-Vendor_Device')).not.toBe(
    normalizeSerialPortPath('/dev/serial/by-id/usb-vendor_device')
  )
})

test('Windows generated identifiers are hidden without filtering Unix serial numbers', () => {
  expect(
    serialPortLabel({
      path: 'COM3',
      serialNumber: '9&35DBA404&1&0000',
      friendlyName: 'USB Serial Device (COM3)'
    })
  ).toBe('COM3 · USB Serial Device')
  for (const path of ['/dev/ttyACM0', '/dev/cu.usbmodem1234']) {
    expect(
      serialPortLabel({ path, manufacturer: 'Vendor', serialNumber: '9&35DBA404&1&0000' })
    ).toBe(`${path} · Vendor, 9&35DBA404&1&0000`)
    expect(serialPortLabel({ path, manufacturer: 'Vendor', serialNumber: 'M2_H-HB03061162' })).toBe(
      `${path} · Vendor, M2_H-HB03061162`
    )
    expect(serialPortLabel({ path })).toBe(path)
  }
})
