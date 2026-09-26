import { expect, test } from 'bun:test'
import { dataWindowPlotValues } from '../src/renderer/src/data-window-plot'
import type { DataWindowConfig } from '../src/renderer/src/data-window-config'

const match = {
  frame: 'AA FF 85 01 00 BB',
  fields: [
    { name: '温度', hex: 'FF 85' },
    { name: '压力', hex: '01 00' }
  ]
}
const config: DataWindowConfig = {
  name: '测试',
  port: 'COM1',
  template: 'AA {温度:2} {压力:2} BB',
  fieldFormats: { 温度: { signed: true, decimals: 2 }, 压力: { signed: false, decimals: 1 } }
}

test('existing configurations and DEC plots use independent signed decimal scales', () => {
  expect(dataWindowPlotValues(match, config)).toEqual({ 温度: -1.23, 压力: 25.6 })
  expect(dataWindowPlotValues(match, { ...config, plotFormat: 'dec' })).toEqual({
    温度: -1.23,
    压力: 25.6
  })
})

test('HEX plots use full byte values without DEC scaling and retain sign', () => {
  expect(dataWindowPlotValues(match, { ...config, plotFormat: 'hex' })).toEqual({
    温度: -123,
    压力: 256
  })
  expect(
    dataWindowPlotValues(
      { frame: '00 10', fields: [{ name: '值', hex: '00 10' }] },
      { ...config, plotFormat: 'hex' }
    )
  ).toEqual({ 值: 16 })
  expect(
    dataWindowPlotValues(
      { frame: '80 00', fields: [{ name: '温度', hex: '80 00' }] },
      { ...config, plotFormat: 'hex' }
    )
  ).toEqual({ 温度: -32768 })
  expect(config.fieldFormats.温度.decimals).toBe(2)
})
