import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import electron from 'electron'
import { run } from './optional'

const root = resolve(import.meta.dirname, '..')
const suite =
  process.argv[2] === 'updates'
    ? 'update-ui-smoke'
    : process.argv[2] === 'serial'
      ? 'serial-ui-performance'
      : process.argv[2] === 'plot'
        ? 'plot-ui-smoke'
        : 'firmware-ui-smoke'
const output = resolve(root, '.tmp', 'ui-smoke')
await mkdir(output, { recursive: true })
const result = await Bun.build({
  entrypoints: [resolve(root, `scripts/${suite}.ts`)],
  target: 'node',
  format: 'cjs',
  packages: 'external',
  outdir: output,
  naming: `${suite}.cjs`
})
if (!result.success) throw new AggregateError(result.logs, 'UI smoke compilation failed')
run(electron as unknown as string, [resolve(output, `${suite}.cjs`)], root, false, 90000)
