import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { formatFirmwareTraffic } from '../src/renderer/src/firmware-traffic-display'

test('firmware traffic switches existing bytes between Hex and decoded text', () => {
  assert.equal(formatFirmwareTraffic('43', true, 'utf-8'), '43')
  assert.equal(formatFirmwareTraffic('43', false, 'utf-8'), 'C')
  assert.equal(formatFirmwareTraffic('0141000A', false, 'utf-8'), '\\x01A\\x00\\x0A')
  assert.equal(formatFirmwareTraffic('C4E3BAC3', false, 'gbk'), '你好')
  assert.equal(formatFirmwareTraffic('C4E3BAC3', true, 'gbk'), 'C4 E3 BA C3')
})
