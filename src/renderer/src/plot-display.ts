const plotNumberFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 20
})

export function formatPlotValue(value: number): string {
  return Number.isFinite(value) ? plotNumberFormatter.format(value) : '—'
}

export function displayChannelName(name: string, port: string, portLabel?: string): string {
  if (!port.startsWith('data-window:') || !portLabel?.trim()) return name
  const prefix = `${port} · `
  const field = name.startsWith(prefix) ? name.slice(prefix.length) : name
  return `${portLabel.trim()} · ${field}`
}
