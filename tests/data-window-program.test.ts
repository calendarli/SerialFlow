import { expect, test } from 'bun:test'
import { getQuickJS } from 'quickjs-emscripten'
import {
  buildDataProgram,
  dataProgramInput,
  defaultDataProgram
} from '../src/renderer/src/data-window-program'
import { compileProgramSource } from '../src/renderer/src/scripts/program-source'

async function evaluate(source: string, data = { 数据: 3000 }): Promise<unknown> {
  const compiled = await compileProgramSource(source)
  const engine = (await getQuickJS()).newContext()
  const deadline = Date.now() + 100
  engine.runtime.setInterruptHandler(() => Date.now() > deadline)
  try {
    const result = engine.evalCode(`let handler; function execute(fn) { handler = fn }
${buildDataProgram(compiled)}
handler(${JSON.stringify(data)})`)
    if (result.error) {
      const error = engine.dump(result.error)
      result.error.dispose()
      throw new Error(JSON.stringify(error))
    }
    const value = engine.dump(result.value)
    result.value.dispose()
    return value
  } finally {
    engine.dispose()
  }
}

test('calibrated AD converts to gf and supports TypeScript and multiple outputs', async () => {
  expect(await evaluate(defaultDataProgram)).toEqual([
    { name: '压力', value: 250, unit: 'gf', decimals: 2 }
  ])
  expect(
    await evaluate(`function process(data: Record<string, number>) {
    return [{name:'差值',value:data.数据 - 4000}, {name:'电压',value:data.数据 / 1000,unit:'V',decimals:3}]
  }`)
  ).toEqual([
    { name: '差值', value: -1000, unit: '', decimals: 2 },
    { name: '电压', value: 3, unit: 'V', decimals: 3 }
  ])
})

test('input respects signed and decimal settings, including special field names', () => {
  expect(
    dataProgramInput(
      {
        frame: '',
        fields: [
          { name: '压力', hex: 'FF 9C' },
          { name: '__proto__', hex: '01' }
        ]
      },
      {
        name: '',
        port: '',
        template: '',
        fieldFormats: { 压力: { signed: true, decimals: 2 } }
      }
    )
  ).toEqual(
    Object.fromEntries([
      ['压力', -1],
      ['__proto__', 1]
    ])
  )
  expect(() =>
    dataProgramInput(
      { frame: '', fields: [{ name: 'AD', hex: '20 00 00 00 00 00 00' }] },
      {
        name: '',
        port: '',
        template: '',
        fieldFormats: {}
      }
    )
  ).toThrow('安全整数')
})

test('invalid outputs, missing fields, syntax errors and infinite loops fail safely', async () => {
  for (const source of [
    'function process() { return [{name:"压力",value:1/0}] }',
    'function process(data) { return [{name:"压力",value:data.missing * 2}] }',
    'function process() { return [{name:"压力",value:1,decimals:21}] }',
    'async function process() { return [] }',
    'function process() { return [] }',
    'function process() { while(true) {} }',
    'function process('
  ])
    await expect(evaluate(source)).rejects.toThrow()
})
