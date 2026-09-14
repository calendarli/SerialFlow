// SSCOM commonly saves INI files using the Windows Chinese code page.
export function decodeConfigText(bytes: Uint8Array, allowGbk = false): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder('utf-16be', { fatal: true }).decode(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    if (allowGbk) return new TextDecoder('gb18030', { fatal: true }).decode(bytes)
    throw new Error('配置文件不是有效的 UTF-8 文本')
  }
}
