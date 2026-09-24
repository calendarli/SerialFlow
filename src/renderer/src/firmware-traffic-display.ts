import type { DisplayEncoding } from './interaction-settings'

export function isReadableFirmwareTraffic(hex: string, encoding: DisplayEncoding): boolean {
  if (!hex || hex.length % 2) return false
  const bytes = Uint8Array.from(hex.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16))
  try {
    const decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes)
    return (
      !!decoded &&
      [...decoded].every((character) => {
        const code = character.codePointAt(0)!
      return code >= 0x20 && (code < 0x7f || code > 0x9f) && code !== 0xfffd
      })
    )
  } catch {
    return false
  }
}

export function formatFirmwareTraffic(
  hex: string,
  hexMode: boolean,
  encoding: DisplayEncoding
): string {
  if (hexMode) return hex.match(/.{2}/g)?.join(' ') ?? ''
  const bytes = Uint8Array.from(hex.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16))
  return new TextDecoder(encoding).decode(bytes).replace(
    // Control bytes remain visible when showing binary firmware packets as text.
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/g,
    (character) => `\\x${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  )
}
