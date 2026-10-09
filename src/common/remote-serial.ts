export type SerialTransport = 'serial' | 'tcp'

export function isTcpPath(path: string): boolean {
  return /^tcp:/i.test(path.trim())
}

export function isRemoteSerial(config: { path: string; transport?: SerialTransport }): boolean {
  return config.transport === 'tcp' || isTcpPath(config.path)
}

export function parseTcpEndpoint(value: string): { host: string; port: number; path: string } {
  const invalid = (): never => {
    throw new Error(
      '远程地址格式应为 tcp://主机:端口，例如 tcp://192.168.1.50:2000；IPv6 地址请加方括号'
    )
  }
  if (typeof value !== 'string') return invalid()
  const text = value.trim()
  // Reject URL features which have no meaning for a raw serial byte stream.
  if (!/^tcp:\/\/(\[[0-9a-f:.]+\]|[^\s/:?#@\\%]+):[0-9]+\/?$/i.test(text)) return invalid()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return invalid()
  }
  const port = Number(url.port)
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return invalid()
  const hostname = url.hostname.toLowerCase()
  return {
    host: hostname.replace(/^\[|\]$/g, ''),
    port,
    path: `tcp://${hostname}:${port}`
  }
}
