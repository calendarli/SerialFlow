export function bytesToBase64(bytes: Uint8Array): string {
  let value = ''
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value)
}

export function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

export function hexToBytes(value: string): Uint8Array {
  const clean = value.replace(/\s+/g, '')
  if (!clean || clean.length % 2 || /[^0-9a-f]/i.test(clean)) {
    throw new Error('HEX 数据格式错误，请输入成对的十六进制字符')
  }
  return Uint8Array.from(clean.match(/.{2}/g)!.map((item) => parseInt(item, 16)))
}

export function encodeSerialData(value: string, hex: boolean): Uint8Array {
  return hex ? hexToBytes(value) : new TextEncoder().encode(value)
}

export function appendCrc(bytes: Uint8Array, mode: CrcMode): Uint8Array {
  let checksum: number
  let checksumBytes: number[]
  if (mode === 'crc8') {
    checksum = 0
    for (const byte of bytes) {
      checksum ^= byte
      for (let bit = 0; bit < 8; bit += 1)
        checksum = checksum & 0x80 ? (checksum << 1) ^ 0x07 : checksum << 1
      checksum &= 0xff
    }
    checksumBytes = [checksum]
  } else if (mode === 'modbus') {
    checksum = 0xffff
    for (const byte of bytes) {
      checksum ^= byte
      for (let bit = 0; bit < 8; bit += 1)
        checksum = checksum & 1 ? (checksum >>> 1) ^ 0xa001 : checksum >>> 1
    }
    checksumBytes = [checksum & 0xff, (checksum >>> 8) & 0xff]
  } else if (mode === 'ccitt-false' || mode === 'xmodem') {
    checksum = mode === 'ccitt-false' ? 0xffff : 0
    for (const byte of bytes) {
      checksum ^= byte << 8
      for (let bit = 0; bit < 8; bit += 1)
        checksum = checksum & 0x8000 ? (checksum << 1) ^ 0x1021 : checksum << 1
      checksum &= 0xffff
    }
    checksumBytes = [(checksum >>> 8) & 0xff, checksum & 0xff]
  } else {
    checksum = 0xffffffff
    for (const byte of bytes) {
      checksum ^= byte
      for (let bit = 0; bit < 8; bit += 1)
        checksum = checksum & 1 ? (checksum >>> 1) ^ 0xedb88320 : checksum >>> 1
    }
    checksum = (checksum ^ 0xffffffff) >>> 0
    checksumBytes = [
      (checksum >>> 24) & 0xff,
      (checksum >>> 16) & 0xff,
      (checksum >>> 8) & 0xff,
      checksum & 0xff
    ]
  }
  const result = new Uint8Array(bytes.length + checksumBytes.length)
  result.set(bytes)
  result.set(checksumBytes, bytes.length)
  return result
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ')
}

export function convertSerialText(value: string, toHex: boolean): string {
  if (!value) return ''
  if (toHex) return bytesToHex(new TextEncoder().encode(value))
  const bytes = hexToBytes(value)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('HEX 数据不是有效的 UTF-8 文本，无法无损转换为 ASCII')
  }
}

export function formatTime(now = new Date()): string {
  // This runs for every serial frame. Local clock fields avoid constructing Intl formatters.
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  const seconds = String(now.getSeconds()).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}.${String(now.getMilliseconds()).padStart(3, '0')}`
}
import type { CrcMode } from './types'
