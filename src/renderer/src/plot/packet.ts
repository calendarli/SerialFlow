import type { PlotSample } from '../plot-data'

export type SamplePacket = {
  names: string[]
  ports: string[]
  numbers: Float64Array
  sources: Uint16Array
  gaps: Uint8Array
}

// Transfer compact numeric batches; NaN represents a missing channel, never zero.
export function packSamples(samples: PlotSample[]): SamplePacket {
  const names = [...new Set(samples.flatMap((sample) => Object.keys(sample.values)))]
  const ports = [...new Set(samples.map((sample) => sample.port))]
  const stride = names.length + 2
  const numbers = new Float64Array(samples.length * stride)
  const sources = new Uint16Array(samples.length),
    gaps = new Uint8Array(samples.length)
  samples.forEach((sample, index) => {
    const offset = index * stride
    numbers[offset] = sample.id
    numbers[offset + 1] = sample.timestamp
    names.forEach((name, channel) => {
      numbers[offset + channel + 2] = sample.values[name] ?? NaN
    })
    sources[index] = ports.indexOf(sample.port)
    gaps[index] = sample.breakBefore ? 1 : 0
  })
  return { names, ports, numbers, sources, gaps }
}

export function unpackSamples(packet: SamplePacket): PlotSample[] {
  const { names, ports, numbers, sources, gaps } = packet,
    stride = names.length + 2
  return Array.from(sources, (port, index) => ({
    id: numbers[index * stride],
    timestamp: numbers[index * stride + 1],
    port: ports[port],
    breakBefore: gaps[index] === 1,
    values: Object.fromEntries(
      names.map((name, channel) => [name, numbers[index * stride + channel + 2]])
    )
  }))
}
