import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { once } from 'node:events'
import { createServer, type Server, Socket } from 'node:net'
import { isRemoteSerial, parseTcpEndpoint } from '../src/common/remote-serial'
import { normalizeSerialPortPath } from '../src/common/serial-port'
import { TcpSerialPort, explainTcpError } from '../src/main/tcp-serial-port'
import { writeSerialData } from '../src/main/serial-write'

const servers: Server[] = []
const peers = new Set<Socket>()
const clients: TcpSerialPort[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => close(client)))
  for (const peer of peers) peer.destroy()
  peers.clear()
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
})

async function listen(
  onConnection: (socket: Socket) => void = () => {}
): Promise<{ server: Server; path: string }> {
  const server = createServer((socket) => {
    peers.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => peers.delete(socket))
    onConnection(socket)
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing TCP test address')
  return { server, path: `tcp://127.0.0.1:${address.port}` }
}

function client(path: string): TcpSerialPort {
  const port = new TcpSerialPort(path)
  clients.push(port)
  return port
}

function open(port: TcpSerialPort): Promise<void> {
  return new Promise((resolve, reject) => port.open((error) => (error ? reject(error) : resolve())))
}

function close(port: TcpSerialPort): Promise<void> {
  return new Promise((resolve, reject) =>
    port.close((error) => (error ? reject(error) : resolve()))
  )
}

function readBytes(port: TcpSerialPort | Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    const done = (error?: Error): void => {
      clearTimeout(timer)
      port.off('data', data)
      port.off('error', done)
      error ? reject(error) : resolve(Buffer.concat(parts))
    }
    const timer = setTimeout(() => done(new Error('Timed out reading test bytes')), 2000)
    const data = (chunk: Buffer): void => {
      parts.push(chunk)
      size += chunk.length
      if (size >= length) done()
    }
    port.on('data', data)
    port.on('error', done)
  })
}

describe('remote endpoint validation', () => {
  test('normalizes host, explicit port and IPv6 without changing local device paths', () => {
    expect(parseTcpEndpoint(' TCP://EXAMPLE.local:02000/ ')).toEqual({
      host: 'example.local',
      port: 2000,
      path: 'tcp://example.local:2000'
    })
    expect(parseTcpEndpoint('tcp://[2001:db8::1]:2000').host).toBe('2001:db8::1')
    expect(normalizeSerialPortPath(' tcp://HOST:2000/ ')).toBe('tcp://host:2000')
    expect(normalizeSerialPortPath('com3')).toBe('COM3')
    expect(normalizeSerialPortPath('/dev/ttyUSB0')).toBe('/dev/ttyUSB0')
    expect(isRemoteSerial({ path: '', transport: 'tcp' })).toBe(true)
    expect(isRemoteSerial({ path: 'tcp://host:2000' })).toBe(true)
    expect(isRemoteSerial({ path: 'COM3' })).toBe(false)
  })

  for (const value of [
    '',
    'tcp://',
    'tcp://host',
    'tcp://host:0',
    'tcp://host:65536',
    'tcp://host:-1',
    'tcp://host:1.5',
    'telnet://host:2000',
    'rfc2217://host:2000',
    'http://host:2000',
    'tcp://user:pass@host:2000',
    'tcp://host:2000/path',
    'tcp://host:2000?x',
    'tcp://host:2000#x',
    'tcp://host:2000/../',
    'tcp://a b:2000',
    'tcp://host\\foo:2000',
    'tcp://2001:db8::1:2000'
  ]) {
    test(`rejects invalid or unsupported endpoint: ${value}`, () => {
      expect(() => parseTcpEndpoint(value)).toThrow('远程地址格式')
    })
  }
})

test('preserves all 256 byte values in both directions, including immediate server data', async () => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index))
  let received!: Promise<Buffer>
  const { path } = await listen((peer) => {
    received = readBytes(peer, bytes.length)
    peer.write(bytes.subarray(0, 13))
    setTimeout(() => peer.write(bytes.subarray(13)), 5)
  })
  const port = client(path)
  const incoming = readBytes(port, bytes.length)
  await open(port)
  await writeSerialData(port, bytes, false)
  expect(await incoming).toEqual(bytes)
  expect(await received).toEqual(bytes)
  expect(port.isOpen).toBe(true)
  const disconnected = once(port, 'close')
  await close(port)
  await disconnected
  expect(port.isOpen).toBe(false)
  await expect(writeSerialData(port, bytes, false)).rejects.toThrow('断开')
})

test('remote EOF closes the connection and a new connection can be opened', async () => {
  const { server, path } = await listen()
  const first = client(path)
  const connected = once(server, 'connection')
  await open(first)
  const [peer] = (await connected) as [Socket]
  const disconnected = once(first, 'close')
  peer.end()
  await disconnected
  expect(first.isOpen).toBe(false)
  const second = client(path)
  await open(second)
  expect(second.isOpen).toBe(true)
})

test('connection refusal rejects without an unhandled error and can be closed safely', async () => {
  const { server, path } = await listen()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  const port = client(path)
  await expect(open(port)).rejects.toThrow('ECONNREFUSED')
  await close(port)
  expect(port.isOpen).toBe(false)
  expect(explainTcpError(new Error('connect ECONNREFUSED'), path).message).toContain('ser2net')
})

test('a stalled connection is timed out and releases the socket exactly once', async () => {
  // Hold the connection before completion, as with a stalled DNS lookup/network.
  const sockets: Socket[] = []
  const stalled = spyOn(Socket.prototype, 'connect').mockImplementation(function (this: Socket) {
    sockets.push(this)
    return this
  })
  const port = new TcpSerialPort('tcp://example.invalid:2000', 20)
  clients.push(port)
  let callbacks = 0
  try {
    const result = new Promise<void>((resolve, reject) =>
      port.open((error) => {
        callbacks += 1
        error ? reject(error) : resolve()
      })
    )
    await expect(result).rejects.toThrow('TCP 连接超时')
    await close(port)
    expect(sockets[0]?.destroyed).toBe(true)
    expect(port.isOpen).toBe(false)
    expect(callbacks).toBe(1)
  } finally {
    stalled.mockRestore()
  }
})

for (const action of ['close', 'timeout'] as const) {
  test(`${action} releases a write whose socket callback never completes`, async () => {
    const { path } = await listen()
    const sockets: Socket[] = []
    const connect = Socket.prototype.connect
    const connected = spyOn(Socket.prototype, 'connect').mockImplementation(function (
      this: Socket,
      ...args: unknown[]
    ) {
      sockets.push(this)
      return Reflect.apply(connect, this, args) as Socket
    })
    const port = new TcpSerialPort(path, 20)
    clients.push(port)
    const errors: Error[] = []
    port.on('error', (error) => errors.push(error))
    try {
      await open(port)
    } finally {
      connected.mockRestore()
    }
    // Hold completion independently of OS/runtime TCP buffering behavior.
    const blocked = spyOn(sockets[0], 'write').mockImplementation(() => false)
    try {
      const closed = new Promise<void>((resolve) => port.once('close', resolve))
      const result = writeSerialData(port, Buffer.from([1]), false).then(
        () => undefined,
        (error: Error) => error
      )
      if (action === 'close') await close(port)
      const error = await result
      expect(error?.message).toContain(action === 'close' ? '断开' : '超时')
      await closed
      expect(port.isOpen).toBe(false)
      expect(sockets[0].destroyed).toBe(true)
      if (action === 'timeout') expect(errors[0]?.message).toContain('TCP 发送超时')
    } finally {
      blocked.mockRestore()
    }
  })
}

test('separate remote ports do not mix traffic', async () => {
  const firstServer = await listen((peer) =>
    peer.on('data', (data) => peer.write(Buffer.concat([Buffer.from('A'), data])))
  )
  const secondServer = await listen((peer) =>
    peer.on('data', (data) => peer.write(Buffer.concat([Buffer.from('B'), data])))
  )
  const first = client(firstServer.path)
  const second = client(secondServer.path)
  await Promise.all([open(first), open(second)])
  const firstRead = readBytes(first, 2)
  const secondRead = readBytes(second, 2)
  await Promise.all([
    writeSerialData(first, Buffer.from('1'), false),
    writeSerialData(second, Buffer.from('2'), false)
  ])
  expect((await firstRead).toString()).toBe('A1')
  expect((await secondRead).toString()).toBe('B2')
})
