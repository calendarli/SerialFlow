import { expect, test } from 'bun:test'
import { applyGlobalFraming } from '../src/renderer/src/receive-framing-settings'
import { defaultSerialFraming, SerialFramer } from '../src/renderer/src/serial-framer'

const profiles = () => [
  {
    path: 'A',
    framing: {
      ...defaultSerialFraming,
      mode: 'delimiter' as const,
      delimiter: '\\r\\n',
      fixedLength: 2
    }
  },
  { path: 'B', framing: { ...defaultSerialFraming, mode: 'fixed' as const, fixedLength: 3 } }
]

test('legacy/project framing adopts first profile rules without losing per-port lengths', () => {
  const original = profiles()
  const migrated = applyGlobalFraming(original)
  expect(migrated.map((p) => p.framing.mode)).toEqual(['delimiter', 'delimiter'])
  expect(migrated.map((p) => p.framing.delimiter)).toEqual(['\\r\\n', '\\r\\n'])
  expect(migrated.map((p) => p.framing.fixedLength)).toEqual([2, 3])
  expect(original[1].framing.mode).toBe('fixed')
  expect(applyGlobalFraming([])).toEqual([])
  expect(applyGlobalFraming(JSON.parse(JSON.stringify(migrated)))).toEqual(migrated)
})

test('global edits preserve lengths across modes and apply every shared parameter', () => {
  let configs = applyGlobalFraming(profiles())
  for (const mode of ['idle', 'header-footer', 'raw', 'fixed', 'delimiter'] as const) {
    configs = applyGlobalFraming(configs, {
      mode,
      delimiter: '|',
      header: 'CC',
      footer: 'DD',
      idleTimeout: 42
    })
    for (const config of configs) {
      expect(config.framing).toMatchObject({
        mode,
        delimiter: '|',
        header: 'CC',
        footer: 'DD',
        idleTimeout: 42
      })
    }
    expect(configs.map((p) => p.framing.fixedLength)).toEqual([2, 3])
  }
})

test('global delimiter keeps ports isolated and fixed mode honors each port length', () => {
  const framer = new SerialFramer()
  const frames: Record<string, string[]> = { A: [], B: [] }
  const push = (config: ReturnType<typeof profiles>[number], text: string) =>
    framer.push(config.path, config.framing, new TextEncoder().encode(text), (frame) =>
      frames[config.path].push(new TextDecoder().decode(frame))
    )
  const shared = applyGlobalFraming(profiles(), { mode: 'delimiter', delimiter: '|' })
  push(shared[0], 'a')
  push(shared[1], 'b|')
  push(shared[0], 'c|')
  expect(frames).toEqual({ A: ['ac|'], B: ['b|'] })
  const fixed = applyGlobalFraming(shared, { mode: 'fixed' })
  push(fixed[0], '123456')
  push(fixed[1], '123456')
  expect(frames.A.slice(1)).toEqual(['12', '34', '56'])
  expect(frames.B.slice(1)).toEqual(['123', '456'])
})
