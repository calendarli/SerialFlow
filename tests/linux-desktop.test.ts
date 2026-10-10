import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import type { Configuration } from 'app-builder-lib'
import type { LinuxPackager } from 'app-builder-lib/out/linuxPackager'
import { LinuxTargetHelper } from 'app-builder-lib/out/targets/LinuxTargetHelper'

const config = Bun.YAML.parse(readFileSync('electron-builder.yml', 'utf8')) as Configuration
const metadata = JSON.parse(readFileSync('package.json', 'utf8'))
// Exercise the installed builder's desktop generator without downloading Linux binaries.
const helper = new LinuxTargetHelper({
  config,
  platformSpecificBuildOptions: config.linux,
  executableName: metadata.name,
  info: { metadata },
  appInfo: {
    productName: config.productName,
    sanitizedProductName: config.productName,
    description: metadata.description
  },
  fileAssociations: []
} as unknown as LinuxPackager)

test('DEB desktop icon resolves to an installed PNG without a theme cache lookup', async () => {
  const entry = await helper.computeDesktopEntry({ ...config.linux, ...config.deb })
  const icon = entry.match(/^Icon=(.+)$/m)?.[1]
  const resources = config.linux?.extraResources
  expect(Array.isArray(resources)).toBe(true)
  const resource = (Array.isArray(resources) ? resources : []).find(
    (item) => typeof item !== 'string' && item.to === 'icon.png'
  )
  if (!resource || typeof resource === 'string' || !resource.from || !resource.to)
    throw new Error('Missing installed Linux icon')
  expect(icon).toBe(posix.join('/opt', config.productName!, 'resources', resource.to))
  const png = readFileSync(resource.from)
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(256)
  expect(png.readUInt32BE(16)).toBe(png.readUInt32BE(20))
  expect(png.equals(readFileSync(config.linux!.icon!))).toBe(true)
  expect(entry).toContain(`Exec=/opt/${config.productName}/${metadata.name} %U`)
})

test('portable Linux targets retain theme icons and matching window identity', async () => {
  for (const options of [config.linux, { ...config.linux, ...config.appImage }]) {
    const entry = await helper.computeDesktopEntry(options!)
    expect(entry).toContain(`\nIcon=${metadata.name}\n`)
    expect(entry).toContain(`\nStartupWMClass=${helper.getDesktopFileName()}\n`)
    expect(`${helper.getDesktopFileName()}.desktop`).toBe(metadata.desktopName)
  }
})
