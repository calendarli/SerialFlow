// Real Electron IPC + loopback TCP, with no physical serial devices required.
import { app, BrowserWindow, dialog } from 'electron'
import { createServer, type Socket } from 'node:net'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as path from 'node:path'
import assert from 'node:assert/strict'
import NodeModule, { createRequire } from 'node:module'

const root = process.cwd()
const moduleRequire = createRequire(path.join(root, 'package.json'))
const Module = NodeModule as unknown as { _load: (name: string, ...args: unknown[]) => unknown }
const load = Module._load
Module._load = function (name, ...args) {
  if (name === 'serialport')
    return {
      SerialPort: class {
        static async list() {
          return []
        }
      }
    }
  return load.call(this, name, ...args)
}
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('in-process-gpu')
const output = path.join(root, '.tmp', 'ui-smoke')
const profile = fs.mkdtempSync(path.join(output, 'remote-serial-'))
app.setPath('appData', profile)
app.setPath('userData', profile)
app.getAppPath = () => root
BrowserWindow.prototype.show = function () {
  // Keep this isolated regression window out of the user's foreground.
}
const errors: string[] = []
app.on('web-contents-created', (_event, contents) => {
  contents.setBackgroundThrottling(false)
  contents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message)
  })
})
moduleRequire(path.join(root, 'out/main/index.js'))

async function until(fn: () => unknown | Promise<unknown>): Promise<void> {
  const end = Date.now() + 10_000
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('Remote serial UI condition timed out')
}

const deadline = setTimeout(() => {
  console.error('Remote serial UI timed out')
  app.exit(1)
}, 60_000)
app.whenReady().then(async () => {
  const peers = new Set<Socket>()
  let received = Buffer.alloc(0)
  const server = createServer((peer) => {
    peers.add(peer)
    peer.on('close', () => peers.delete(peer))
    peer.on('error', () => {})
    peer.on('data', (data) => {
      received = Buffer.concat([received, data])
      peer.write(data)
    })
    peer.write('READY\n')
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert(address && typeof address !== 'string')
    const endpoint = `tcp://127.0.0.1:${address.port}`
    await until(() => BrowserWindow.getAllWindows().length)
    const window = BrowserWindow.getAllWindows()[0]
    window.setOpacity(0)
    window.setSkipTaskbar(true)
    window.showInactive()
    const run = (source: string): Promise<unknown> => window.webContents.executeJavaScript(source)
    await until(() => run('Boolean(document.querySelector(".serial-profile .connect"))'))
    assert.deepEqual(await run('window.api.listPorts()'), [])
    await run(
      `(() => { const select = document.querySelector('[aria-label="串口组 1 连接方式"]'); select.value = 'tcp'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`
    )
    await until(() => run('Boolean(document.querySelector(".serial-remote-address"))'))
    const setAddress = (value: string): Promise<unknown> =>
      run(`(() => {
      const input = document.querySelector('.serial-remote-address');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await setAddress('tcp://bad:0')
    await run('document.querySelector(".serial-profile .connect").click()')
    await until(() => run('document.body.textContent.includes("远程地址格式应为")'))
    assert.deepEqual(await run('window.api.getOpenedPortPaths()'), [])
    await run('document.querySelector(".app-error-close").click()')
    await until(() => run('!document.querySelector(".app-error-dialog")'))
    await setAddress(endpoint)
    await run('document.querySelector(".serial-profile .connect").click()')
    await until(() => run('Boolean(document.querySelector(".serial-profile.open"))'))
    await until(() =>
      run('document.querySelector(".serial-profile .connect").textContent === "断开远程串口"')
    )
    assert.equal(await run('document.querySelector(".serial-remote-address").disabled'), true)
    assert.deepEqual(await run('window.api.getOpenedPortPaths()'), [endpoint])
    await until(() => run('document.body.textContent.includes("READY")'))
    await run(
      'window.__remoteBytes = []; window.__offRemote = window.api.onData(({chunks}) => { for (const chunk of chunks) window.__remoteBytes.push(...chunk) }); void 0'
    )
    const bytes = Buffer.from([0, 255, 13, 10, 65, 128])
    assert.equal(
      await run(
        `window.api.write(${JSON.stringify(endpoint)}, ${JSON.stringify(bytes.toString('base64'))})`
      ),
      bytes.length
    )
    await until(() => received.length === bytes.length)
    await until(() => run(`window.__remoteBytes.length === ${bytes.length}`))
    assert.deepEqual(received, bytes)
    assert.deepEqual(await run('window.__remoteBytes'), [...bytes])
    await run(`(() => {
      const input = document.querySelector('.sender textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'PING');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await run('document.querySelector(".send-button").click()')
    await until(() => received.length === bytes.length + 4)
    assert.equal(received.subarray(bytes.length).toString(), 'PING')
    await until(() => run('document.querySelector("footer").textContent.includes("TX 1 次")'))
    // Duplicate requests must not silently tear down the active session.
    assert.equal(
      await run(
        `window.api.openPort({ path: ${JSON.stringify(endpoint + '/')}, transport: 'tcp' }).then(() => false, e => e.message.includes('已经打开'))`
      ),
      true
    )
    assert.deepEqual(await run('window.api.getOpenedPortPaths()'), [endpoint])
    fs.writeFileSync(path.join(output, 'remote-serial.png'), (await window.capturePage()).toPNG())
    for (const peer of peers) peer.end()
    await until(() => run('!document.querySelector(".serial-profile.open")'))
    assert.deepEqual(await run('window.api.getOpenedPortPaths()'), [])
    await until(() => run('document.body.textContent.includes("连接已断开")'))
    await run('document.querySelector(".app-error-close").click()')
    await until(() => run('!document.querySelector(".app-error-dialog")'))
    await run('document.querySelector(".serial-profile .connect").click()')
    await until(() => run('Boolean(document.querySelector(".serial-profile.open"))'))
    await run('document.querySelector(".serial-profile .connect").click()')
    await until(() => run('!document.querySelector(".serial-profile.open")'))
    await until(() => peers.size === 0)

    // Exercise the actual project export/import handlers, using an isolated test file.
    const projectFile = path.join(profile, 'remote.serialflow')
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: projectFile })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectFile] })
    await run('document.querySelector("[title=导出工程]").click()')
    await until(
      () => fs.existsSync(projectFile) && fs.readFileSync(projectFile, 'utf8').includes(endpoint)
    )
    const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'))
    assert.equal(project.serialConfigs[0].transport, 'tcp')
    assert.equal(project.serialConfigs[0].path, endpoint)
    const reloaded = once(window.webContents, 'did-finish-load')
    window.reload()
    await reloaded
    await until(() =>
      run(`document.querySelector('.serial-remote-address')?.value === ${JSON.stringify(endpoint)}`)
    )
    await setAddress('tcp://another-host:2000')
    await run('document.querySelector("[title=导入工程]").click()')
    await until(() =>
      run(`document.querySelector('.serial-remote-address')?.value === ${JSON.stringify(endpoint)}`)
    )
    // Refreshing an empty local list must never replace the remote configuration.
    await run('document.querySelector("[title=刷新串口]").click()')
    assert.equal(await run('document.querySelector(".serial-remote-address").value'), endpoint)
    assert.deepEqual(errors, [])
    console.log(
      'PASS: remote TCP UI, binary IPC, disconnect/reconnect, duplicate protection, persistence and project import/export'
    )
    clearTimeout(deadline)
    for (const peer of peers) peer.destroy()
    server.close()
    app.exit(0)
  } catch (error) {
    console.error(error)
    for (const peer of peers) peer.destroy()
    server.close()
    clearTimeout(deadline)
    app.exit(1)
  }
})
