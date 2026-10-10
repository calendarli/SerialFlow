import { normalizeDataFieldFormat, type DataWindowConfig } from './data-window-config'
import { formatDataValue, type DataMatch } from './data-window-parser'

export function dataWindowPlotValues(
  match: DataMatch,
  config: DataWindowConfig
): Record<string, number> {
  return Object.fromEntries(
    match.fields.map((field) => {
      const format = normalizeDataFieldFormat(config.fieldFormats[field.name])
      // HEX is the signed/unsigned integer represented by the bytes, without DEC scaling.
      const decimals = config.plotFormat === 'hex' ? 0 : format.decimals
      return [field.name, Number(formatDataValue(field.hex, format.signed, decimals).dec)]
    })
  )
}
