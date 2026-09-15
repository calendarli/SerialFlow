import { formatDataValue, type DataMatch } from './data-window-parser'
import { normalizeDataFieldFormat, type DataWindowConfig } from './data-window-config'
import { ScriptRuntime } from './scripts/script-runtime'
import { createScript } from './scripts/script-types'
import { compileProgramSource } from './scripts/program-source'

export const defaultDataProgram = `function process(data) {
  // 将“数据”替换为模板中的字段名；以下标定参数仅为示例。
  const ad = data['数据']
  const zero = 1000 // 空载 AD 值
  const calibrationAD = 5000 // 放置标定砝码后的 AD 值
  const calibrationGf = 500 // 标定砝码对应的 gf
  const gf = (ad - zero) * calibrationGf / (calibrationAD - zero)
  return [{ name: '压力', value: gf, unit: 'gf', decimals: 2 }]
}`

export type DataProgramValue = { name: string; value: number; unit: string; decimals: number }

export function dataProgramInput(
  match: DataMatch,
  config: DataWindowConfig
): Record<string, number> {
  return Object.fromEntries(
    match.fields.map((field) => {
      const format = normalizeDataFieldFormat(config.fieldFormats[field.name])
      const raw = formatDataValue(field.hex, format.signed)
      if (!Number.isSafeInteger(Number(raw.dec)))
        throw new Error(`字段“${field.name}”超出 JavaScript 安全整数范围，无法精确换算`)
      return [field.name, Number(formatDataValue(field.hex, format.signed, format.decimals).dec)]
    })
  )
}

export function buildDataProgram(source: string): string {
  return `${source}
if (typeof process !== 'function') throw new Error('请定义 process(data) 函数')
execute((data) => {
  const result = process(data)
  if (!Array.isArray(result) || result.length < 1 || result.length > 64)
    throw new Error('process 必须返回 1～64 项结果数组')
  return result.map(item => {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80 ||
        typeof item.value !== 'number' || !Number.isFinite(item.value) ||
        (item.unit !== undefined && (typeof item.unit !== 'string' || item.unit.length > 32)) ||
        (item.decimals !== undefined && (!Number.isInteger(item.decimals) || item.decimals < 0 || item.decimals > 20)))
      throw new Error('结果需要 name 和有限数值 value；unit 为文本，decimals 为 0～20 的整数')
    return { name: item.name, value: item.value, unit: item.unit || '', decimals: item.decimals ?? 2 }
  })
})`
}

export class DataProgramRuntime {
  private runtime = new ScriptRuntime()
  private generation = 0

  async run(source: string, data: Record<string, number>): Promise<DataProgramValue[]> {
    const generation = this.generation
    const compiled = await compileProgramSource(source)
    if (generation !== this.generation) throw new Error('数据换算已取消')
    const script = createScript()
    script.id = 'data-window'
    script.name = '数据换算'
    script.compiledCode = buildDataProgram(compiled)
    const result = await this.runtime.run(script, data, 'received', 0, {
      port: '',
      encoding: 'json',
      timestamp: Date.now(),
      byteLength: 0,
      scriptName: script.name,
      direction: 'received',
      index: 0
    })
    return result as unknown as DataProgramValue[]
  }

  dispose(): void {
    this.generation++
    this.runtime.restart()
  }
}
