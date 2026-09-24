import type { DisplayEncoding } from './interaction-settings'

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
