import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const timeout = setTimeout(() => app.exit(1), 30000)
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 800,
    height: 400,
    webPreferences: { sandbox: true, backgroundThrottling: false }
  })
  try {
    await window.loadURL('about:blank')
    await window.webContents.executeJavaScript(
      readFileSync(join(process.cwd(), '.tmp/ui-smoke/plot-renderer-fixture.js'), 'utf8')
    )
    const result = await window.webContents.executeJavaScript('runPlotRendererChecks()')
    const report = {
      ...result,
      gpu: app.getGPUFeatureStatus(),
      gpuInfo: await app.getGPUInfo('basic')
    }
    writeFileSync(
      join(process.cwd(), '.tmp/ui-smoke/plot-renderer-result.json'),
      JSON.stringify(report, null, 2)
    )
    console.log(JSON.stringify(report))
    clearTimeout(timeout)
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
