import { execFile } from 'child_process'
import type { SerialPortInfo } from '../common/serial-port'

// Composite USB interfaces can expose a generated instance suffix as their serial.
// Match the interface to its physical USB parent by ContainerID, not by VID/PID alone.
const parentSerialScript = `
$ErrorActionPreference = 'Stop'
$devices = @(Get-ChildItem -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\USB' | Get-ChildItem | ForEach-Object {
  $props = Get-ItemProperty -LiteralPath $_.PSPath
  $parameters = Get-ItemProperty -LiteralPath ($_.PSPath + '\\Device Parameters') -ErrorAction SilentlyContinue
  [pscustomobject]@{ Key = $_.PSParentPath; Serial = $_.PSChildName; Container = $props.ContainerID; Port = $parameters.PortName }
})
$result = @(foreach ($device in $devices) {
  if (!$device.Port -or !$device.Container) { continue }
  $parents = @($devices | Where-Object {
    $_.Container -eq $device.Container -and $_.Key -notmatch '&MI_[0-9A-F]{2}$' -and
    $_.Serial -notmatch '^\\d+&[0-9a-f]+&\\d+&[0-9a-f]+$'
  } | Select-Object -ExpandProperty Serial -Unique)
  if ($parents.Count -eq 1) { [pscustomobject]@{ path = $device.Port; serialNumber = $parents[0] } }
})
ConvertTo-Json -InputObject $result -Compress
`

function readParentSerials(): Promise<SerialPortInfo[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(parentSerialScript, 'utf16le').toString('base64')
      ],
      { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(error)
        try {
          const result: unknown = JSON.parse(stdout.trim())
          if (!Array.isArray(result)) throw new Error('Invalid USB device metadata')
          resolve(
            result.filter(
              (item): item is SerialPortInfo =>
                item && typeof item.path === 'string' && typeof item.serialNumber === 'string'
            )
          )
        } catch (cause) {
          reject(cause)
        }
      }
    )
  })
}

export function createSerialPortLister(
  list: () => Promise<SerialPortInfo[]>,
  readParents = readParentSerials,
  platform = process.platform
): () => Promise<SerialPortInfo[]> {
  const cache = new Map<string, string | undefined>()
  let retryAfter = 0
  const key = (port: SerialPortInfo): string =>
    JSON.stringify([port.path, port.pnpId, port.serialNumber])
  return async () => {
    const ports = await list()
    if (platform !== 'win32') return ports
    const candidates = ports.filter(
      (port) =>
        /^COM\d+$/i.test(port.path) &&
        (!port.serialNumber || /^\d+&[0-9a-f]+&\d+&[0-9a-f]+$/i.test(port.serialNumber))
    )
    const present = new Set(candidates.map(key))
    for (const cached of cache.keys()) if (!present.has(cached)) cache.delete(cached)
    if (candidates.some((port) => !cache.has(key(port))) && Date.now() >= retryAfter) {
      try {
        const parents = await readParents()
        for (const port of candidates) {
          cache.set(
            key(port),
            parents.find((parent) => parent.path.toUpperCase() === port.path.toUpperCase())
              ?.serialNumber
          )
        }
      } catch {
        // Keep discovery usable when registry access is unavailable; retry with backoff.
        retryAfter = Date.now() + 30000
      }
    }
    return ports.map((port) => {
      const serialNumber = cache.get(key(port))
      return serialNumber ? { ...port, serialNumber } : port
    })
  }
}
