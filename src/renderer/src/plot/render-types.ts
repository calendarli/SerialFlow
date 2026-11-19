export type RendererMode = 'auto' | 'webgl2' | 'canvas'
export type Surface = { width: number; height: number; dpr: number }
export type PlotFrame = Surface & {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  lineWidth: number
}
export type Geometry = {
  key: string
  revision: number
  color: string
  originX: number
  originY: number
  // Segment endpoints relative to a double precision local origin.
  segments: Float32Array
}
export interface PlotRenderer {
  render(frame: PlotFrame, geometry: Geometry[]): void
  dispose(): void
}

// Shared by both renderers and the existing SVG overlay. Convert to physical
// pixels before stroking, so non-square panels cannot distort line widths.
export function plotRect(size: Surface): { x: number; y: number; width: number; height: number } {
  return {
    x: size.width * 0.028,
    y: size.height * (20 / 420),
    width: size.width * 0.812,
    height: size.height * (345 / 420)
  }
}
