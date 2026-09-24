import { readFile, stat } from 'fs/promises'
import { extname, isAbsolute } from 'path'
import { espChips, type FirmwareRequest } from '@common/firmware'

export type AddressRange = { start: number; end: number }
export const hexAddress = (value: number): string => `0x${value.toString(16).toUpperCase()}`

export function parseAddress(value: string): number {
  if (typeof value !== 'string' || !/^(?:0x[0-9a-fA-F]{1,8}|[0-9]{1,10})$/.test(value.trim()))
    throw new Error('地址必须是 0x 开头的十六进制数或十进制整数')
  const address = Number(value)
  if (!Number.isSafeInteger(address) || address < 0 || address > 0xffffffff)
    throw new Error('地址超出 32 位范围')
  return address
}

export function assertNoOverlap(ranges: AddressRange[]): void {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i].start < sorted[i - 1].end)
      throw new Error(`固件地址范围重叠：${hexAddress(sorted[i].start)}`)
}

export function parseIntelHex(text: string): AddressRange[] {
  let base = 0
  let eof = false
  const ranges: AddressRange[] = []
  for (const [index, raw] of text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .entries()) {
    const line = raw.trim()
    if (!line) continue
    const fail = (): never => {
      throw new Error(`HEX 第 ${index + 1} 行格式或校验和错误`)
    }
    if (eof || !/^:(?:[0-9a-fA-F]{2}){5,260}$/.test(line)) fail()
    const bytes = Buffer.from(line.slice(1), 'hex')
    const length = bytes[0]
    if (bytes.length !== length + 5 || (bytes.reduce((sum, n) => sum + n, 0) & 255) !== 0) fail()
    const offset = bytes.readUInt16BE(1)
    const type = bytes[3]
    if (type === 0) {
      if (offset + length > 0x10000) fail()
      if (length) ranges.push({ start: base + offset, end: base + offset + length })
    } else if (type === 1) {
      if (length !== 0 || offset !== 0) fail()
      eof = true
    } else if (type === 2 || type === 4) {
      if (length !== 2 || offset !== 0) fail()
      base = bytes.readUInt16BE(4) * (type === 2 ? 16 : 65536)
    } else if (type === 3 || type === 5) {
      if (length !== 4 || offset !== 0) fail()
    } else fail()
  }
  if (!eof || !ranges.length) throw new Error('HEX 缺少结束记录或有效数据')
  assertNoOverlap(ranges)
  return ranges
}

export function validateRequest(request: FirmwareRequest, flash: boolean): void {
  if (
    !request ||
    !['stm32', 'esp32'].includes(request.family) ||
    !['uart', 'swd', 'ymodem'].includes(request.transport)
  )
    throw new Error('无效的芯片或连接方式')
  if (request.family === 'esp32' && request.transport !== 'uart')
    throw new Error('ESP32 请使用串口下载')
  if (request.transport === 'ymodem' && (request.verify || request.eraseAll || request.reset))
    throw new Error('Ymodem 接收端自行控制擦除、校验与复位，请关闭这些选项')
  if (
    request.transport !== 'swd' &&
    (typeof request.port !== 'string' || !/^(COM[1-9]\d{0,2}|\/dev\/[\w./-]+)$/i.test(request.port))
  )
    throw new Error('请选择有效串口')
  if (request.transport === 'swd' && !/^[a-zA-Z0-9]{8,64}$/.test(request.probe))
    throw new Error('请刷新并选择 ST-LINK 探针')
  if (!Number.isInteger(request.baudRate) || request.baudRate < 1200 || request.baudRate > 3000000)
    throw new Error('波特率范围为 1200–3000000')
  if (!['NORMAL', 'UR'].includes(request.connectMode)) throw new Error('无效的连接模式')
  if (request.family === 'esp32' && !(espChips as readonly string[]).includes(request.chip))
    throw new Error('不支持的 ESP32 型号')
  for (const key of ['verify', 'reset', 'restorePort', 'eraseAll', 'manualBoot'] as const)
    if (typeof request[key] !== 'boolean') throw new Error('烧录选项无效')
  if (typeof request.toolPath !== 'string') throw new Error('工具路径无效')
  if (
    flash &&
    (!Array.isArray(request.files) || !request.files.length || request.files.length > 16)
  )
    throw new Error('请选择 1–16 个固件文件')
  if (flash && request.family === 'stm32' && request.files.length !== 1)
    throw new Error('STM32 每次请选择一个 HEX 或 BIN 文件')
  if (
    flash &&
    request.transport === 'ymodem' &&
    (typeof request.files[0]?.path !== 'string' || !/\.bin$/i.test(request.files[0].path))
  )
    throw new Error('Ymodem 烧录仅支持 BIN 文件')
}

export async function inspectYmodemFirmware(request: FirmwareRequest): Promise<Buffer> {
  validateRequest(request, true)
  const file = request.files[0]
  if (!file || !isAbsolute(file.path)) throw new Error('固件路径无效')
  const info = await stat(file.path)
  if (!info.isFile() || !info.size || info.size > 128 * 1024 * 1024)
    throw new Error('Ymodem 固件为空或超过 128 MB')
  const data = await readFile(file.path)
  if (data.length !== info.size) throw new Error('固件文件已变化，请重新选择')
  return data
}

export async function inspectFirmware(
  request: FirmwareRequest
): Promise<Array<{ data: Buffer; extension: string; address: number; ranges: AddressRange[] }>> {
  validateRequest(request, true)
  const allRanges: AddressRange[] = []
  const inspected: Array<{
    data: Buffer
    extension: string
    address: number
    ranges: AddressRange[]
  }> = []
  let total = 0
  for (const file of request.files) {
    if (!file || typeof file.path !== 'string' || !isAbsolute(file.path))
      throw new Error('固件路径无效')
    const extension = extname(file.path).toLowerCase()
    if (!(request.family === 'stm32' ? ['.hex', '.bin'] : ['.bin']).includes(extension))
      throw new Error(request.family === 'stm32' ? 'STM32 支持 HEX / BIN' : 'ESP32 请使用 BIN 固件')
    const info = await stat(file.path)
    total += info.size
    if (
      !info.isFile() ||
      !info.size ||
      total > 128 * 1024 * 1024 ||
      (extension === '.hex' && info.size > 32 * 1024 * 1024)
    )
      throw new Error('固件为空或过大（总计最多 128 MB，HEX 最多 32 MB）')
    const data = await readFile(file.path)
    if (data.length !== info.size) throw new Error('固件文件已变化，请重新选择')
    const ranges =
      extension === '.hex'
        ? parseIntelHex(data.toString('utf8'))
        : [{ start: parseAddress(file.address), end: parseAddress(file.address) + data.length }]
    for (const range of ranges) {
      const minimum = request.family === 'stm32' ? 0x08000000 : 0
      const maximum = request.family === 'stm32' ? 0x10000000 : 128 * 1024 * 1024
      if (range.start < minimum || range.end > maximum)
        throw new Error('固件地址超出支持的 Flash 范围；首版不支持选项字节、RAM 或外部存储器烧录')
    }
    for (const range of ranges) allRanges.push(range)
    inspected.push({
      data,
      extension,
      address: ranges.reduce((minimum, range) => Math.min(minimum, range.start), Infinity),
      ranges
    })
  }
  assertNoOverlap(allRanges)
  return inspected
}
