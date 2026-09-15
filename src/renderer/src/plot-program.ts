import { buildDataProgram, type DataProgramValue } from './data-window-program'
import { compileProgramSource } from './scripts/program-source'
import { createScript } from './scripts/script-types'
import { ScriptRuntime } from './scripts/script-runtime'

export const defaultPlotProgram = `function process(data) {
  // data 的键为原始通道名，例如 CH1 或 AD。
  // 请用实际测量值替换下面的标定参数。
  const gf = (data.CH1 - 1000) * 500 / (5000 - 1000)
  return [{ name: '压力', value: gf, unit: 'gf', decimals: 2 }]
}`

export function buildPlotProgram(source: string): string {
  return `let convert;
(function(execute) {
${buildDataProgram(source)}
})(handler => { convert = handler });
execute(batch => batch.map(data => convert(data)))`
}

export class PlotProgramRuntime {
  private runtime = new ScriptRuntime()
  private generation = 0
  async run(source: string, batch: Record<string, number>[]): Promise<DataProgramValue[][]> {
    const generation = this.generation
    const compiled = await compileProgramSource(source)
    if (generation !== this.generation) throw new Error('曲线计算已取消')
    const script = createScript()
    script.id = 'plot-program'
    script.name = '曲线计算通道'
    script.compiledCode = buildPlotProgram(compiled)
    return (await this.runtime.run(script, batch, 'received', 0, {
      port: '',
      encoding: 'json',
      timestamp: Date.now(),
      byteLength: 0,
      scriptName: script.name,
      direction: 'received',
      index: 0
    })) as unknown as DataProgramValue[][]
  }
  dispose(): void {
    this.generation++
    this.runtime.restart()
  }
}
