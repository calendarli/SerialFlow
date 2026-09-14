import type { SerialPortInfo } from '../common/serial-port'

export class SerialPortMonitor {
  private pending?: Promise<SerialPortInfo[]>
  private fingerprint = ''
  private timer?: ReturnType<typeof setTimeout>
  private running = false

  constructor(
    private readonly list: () => Promise<SerialPortInfo[]>,
    private readonly changed: (ports: SerialPortInfo[]) => void,
    private readonly interval = 1000
  ) {}

  refresh(): Promise<SerialPortInfo[]> {
    if (this.pending) return this.pending
    this.pending = this.list()
      .then((ports) => {
        const sorted = [...ports].sort((a, b) =>
          a.path.localeCompare(b.path, undefined, { numeric: true })
        )
        const fingerprint = JSON.stringify(
          sorted.map((port) => [
            port.path,
            port.manufacturer,
            port.serialNumber,
            port.friendlyName,
            port.vendorId,
            port.productId,
            port.pnpId,
            port.locationId
          ])
        )
        if (fingerprint !== this.fingerprint) {
          this.fingerprint = fingerprint
          this.changed(sorted)
        }
        return sorted
      })
      .finally(() => {
        this.pending = undefined
      })
    return this.pending
  }

  start(): void {
    if (this.running) return
    this.running = true
    const poll = async (): Promise<void> => {
      try {
        await this.refresh()
      } catch {
        // A transient enumeration failure must not clear the last known device list.
      } finally {
        if (this.running) this.timer = setTimeout(() => void poll(), this.interval)
      }
    }
    void poll()
  }

  stop(): void {
    this.running = false
    clearTimeout(this.timer)
  }
}
