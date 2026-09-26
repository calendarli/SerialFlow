import type { SerialFraming } from './types'

export type GlobalSerialFraming = Omit<SerialFraming, 'fixedLength'>

// Keep the existing project/storage format while sharing all non-length settings.
// Older projects use the first serial profile as the global framing rule.
export function applyGlobalFraming<T extends { framing: SerialFraming }>(
  configs: T[],
  patch: Partial<GlobalSerialFraming> = {}
): T[] {
  const first = configs[0]?.framing
  if (!first) return configs
  const global = { ...first, ...patch }
  return configs.map((config) => ({
    ...config,
    framing: { ...global, fixedLength: config.framing.fixedLength }
  }))
}
