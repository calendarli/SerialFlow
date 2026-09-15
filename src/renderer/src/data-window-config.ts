export type DataFieldFormat = { signed: boolean; decimals: number }
export type DataWindowConfig = {
  name: string
  port: string
  template: string
  fieldFormats: Record<string, DataFieldFormat>
  programming?: boolean
  program?: string
}
export function normalizeDataFieldFormat(value: unknown): DataFieldFormat {
  const item = value as Partial<DataFieldFormat> | null
  return {
    signed: item?.signed === true,
    decimals:
      typeof item?.decimals === 'number' &&
      Number.isInteger(item.decimals) &&
      item.decimals >= 0 &&
      item.decimals <= 20
        ? item.decimals
        : 0
  }
}
export const dataWindowListKey = 'serialflow.dataWindows'
export const dataWindowKey = (id: string): string => `serialflow.dataWindow.${id}`
export function readDataWindowConfig(id: string): DataWindowConfig {
  try {
    const saved = JSON.parse(localStorage.getItem(dataWindowKey(id)) || 'null')
    if (
      saved &&
      typeof saved.name === 'string' &&
      typeof saved.port === 'string' &&
      typeof saved.template === 'string'
    )
      return {
        name: saved.name,
        port: saved.port,
        template: saved.template,
        programming: saved.programming === true,
        program: typeof saved.program === 'string' ? saved.program : undefined,
        fieldFormats: Object.fromEntries(
          Object.entries(
            saved.fieldFormats && typeof saved.fieldFormats === 'object' ? saved.fieldFormats : {}
          ).map(([name, value]) => [name, normalizeDataFieldFormat(value)])
        )
      }
  } catch {
    /* Fall back to an editable example. */
  }
  return { name: '数据窗口', port: '', template: 'AA 02 {数据:4} BB', fieldFormats: {} }
}
export function readDataWindowIds(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(dataWindowListKey) || '[]')
    if (Array.isArray(saved))
      return [
        ...new Set(
          saved.filter(
            (id): id is string => typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id)
          )
        )
      ]
  } catch {
    /* Ignore invalid saved data. */
  }
  return []
}
