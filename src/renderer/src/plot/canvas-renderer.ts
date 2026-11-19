import { plotRect, type Geometry, type PlotFrame, type PlotRenderer } from './render-types'

export class CanvasRenderer implements PlotRenderer {
  private context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
  constructor(private canvas: OffscreenCanvas | HTMLCanvasElement) {
    const context = canvas.getContext('2d') as
      OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
    if (!context) throw new Error('Canvas 2D 初始化失败')
    this.context = context
  }
  render(frame: PlotFrame, geometry: Geometry[]): void {
    const { canvas, context: ctx } = this
    const width = Math.max(1, Math.round(frame.width * frame.dpr))
    const height = Math.max(1, Math.round(frame.height * frame.dpr))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    ctx.setTransform(frame.dpr, 0, 0, frame.dpr, 0, 0)
    ctx.clearRect(0, 0, frame.width, frame.height)
    const rect = plotRect(frame)
    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.clip()
    ctx.lineWidth = frame.lineWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const item of geometry) {
      const x = (v: number): number =>
        rect.x + ((v + (item.originX - frame.xMin)) / (frame.xMax - frame.xMin)) * rect.width
      const y = (v: number): number =>
        rect.y +
        rect.height -
        ((v + (item.originY - frame.yMin)) / (frame.yMax - frame.yMin)) * rect.height
      ctx.beginPath()
      for (let i = 0; i < item.segments.length; i += 4) {
        ctx.moveTo(x(item.segments[i]), y(item.segments[i + 1]))
        ctx.lineTo(x(item.segments[i + 2]), y(item.segments[i + 3]))
      }
      ctx.strokeStyle = item.color
      ctx.stroke()
    }
    ctx.restore()
  }
  dispose(): void {
    /* Canvas owns its drawing resources. */
  }
}
