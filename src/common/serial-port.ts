export type SerialPortInfo = {
  path: string
  manufacturer?: string
  serialNumber?: string
  friendlyName?: string
  vendorId?: string
  productId?: string
  pnpId?: string
  locationId?: string
}

// COM names are case-insensitive; Unix device paths must retain their case.
export function normalizeSerialPortPath(path: string): string {
  const trimmed = path.trim()
  return /^COM\d+$/i.test(trimmed) ? trimmed.toUpperCase() : trimmed
}

export function serialPortLabel(port: SerialPortInfo): string {
  const path = port.path.trim()
  const serialNumber = port.serialNumber?.trim()
  // Windows may return a generated USB instance suffix instead of a hardware serial.
  // Keep this heuristic limited to COM ports and the specific generated identifier shape.
  const generatedSerial =
    /^COM\d+$/i.test(path) && /^\d+&[0-9a-f]+&\d+&[0-9a-f]+$/i.test(serialNumber ?? '')
  const friendlyName = port.friendlyName
    ?.trim()
    .replace(/\s*\((COM\d+)\)$/i, (suffix, name: string) =>
      name.toUpperCase() === path.toUpperCase() ? '' : suffix
    )
    .trim()
  const seen = new Set([path.toLowerCase()])
  const details = [port.manufacturer, generatedSerial ? undefined : serialNumber, friendlyName]
    .map((value) => value?.trim())
    .filter((value): value is string => {
      if (!value || seen.has(value.toLowerCase())) return false
      seen.add(value.toLowerCase())
      return true
    })
  return details.length ? `${path} · ${details.join(', ')}` : path
}
