import assert from 'node:assert/strict'
import { test } from 'bun:test'
import {
  formatFirmwareTraffic,
  isReadableFirmwareTraffic
} from '../src/renderer/src/firmware-traffic-display'

test('firmware traffic switches existing bytes between Hex and decoded text', () => {
  assert.equal(formatFirmwareTraffic('43', true, 'utf-8'), '43')
  assert.equal(formatFirmwareTraffic('43', false, 'utf-8'), 'C')
  assert.equal(formatFirmwareTraffic('0141000A', false, 'utf-8'), '\\x01A\\x00\\x0A')
  assert.equal(formatFirmwareTraffic('C4E3BAC3', false, 'gbk'), '你好')
  assert.equal(formatFirmwareTraffic('C4E3BAC3', true, 'gbk'), 'C4 E3 BA C3')
})

test('ASCII view hides firmware control and binary frames while keeping readable text', () => {
  assert.equal(isReadableFirmwareTraffic('43', 'utf-8'), true)
  assert.equal(isReadableFirmwareTraffic('626F6F743D302E312D646576', 'utf-8'), true)
  assert.equal(isReadableFirmwareTraffic('06', 'utf-8'), false)
  assert.equal(isReadableFirmwareTraffic('014C45442E62696E00', 'utf-8'), false)
  assert.equal(isReadableFirmwareTraffic('FF', 'utf-8'), false)
  assert.equal(isReadableFirmwareTraffic('C280', 'utf-8'), false)
  assert.equal(isReadableFirmwareTraffic('C4E3BAC3', 'gbk'), true)
})
