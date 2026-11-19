import { WebGLRenderer } from '../src/renderer/src/plot/webgl-renderer'
import { CanvasRenderer } from '../src/renderer/src/plot/canvas-renderer'
import { plotRect, type Geometry, type PlotFrame } from '../src/renderer/src/plot/render-types'

async function runPlotRendererChecks(): Promise<Record<string, unknown>> {
  const frame: PlotFrame = {
    width: 800,
    height: 240,
    dpr: 2,
    xMin: 1700000000000,
    xMax: 1700000000100,
    yMin: 1e9,
    yMax: 1e9 + 0.01,
    lineWidth: 2
  }
  const geometry: Geometry[] = [
    {
      key: 'signal',
      revision: 1,
      color: '#ff0000',
      originX: frame.xMin,
      originY: frame.yMin,
      segments: new Float32Array([0, 0.005, 100, 0.005])
    }
  ]
  const rect = plotRect(frame)
  const counts: Record<string, number> = {}
  const gpuCanvas = new OffscreenCanvas(1, 1)
  const gpu = new WebGLRenderer(gpuCanvas)
  const gl = gpuCanvas.getContext('webgl2')!
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
  const rendererName = debugInfo
    ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER)
  for (const backend of ['webgl2', 'canvas'] as const) {
    const canvas = backend === 'webgl2' ? gpuCanvas : new OffscreenCanvas(1, 1)
    const renderer = backend === 'webgl2' ? gpu : new CanvasRenderer(canvas)
    renderer.render(frame, geometry)
    const data =
      backend === 'webgl2'
        ? new Uint8Array(canvas.width * canvas.height * 4)
        : canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    if (backend === 'webgl2')
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data)
    let count = 0
    for (let i = 0; i < data.length; i += 4) if (data[i] > 100 && data[i + 3] > 80) count++
    if (count < rect.width * frame.dpr * 2 || count > rect.width * frame.dpr * 7)
      throw new Error(`${backend}: incorrect line coverage ${count}`)
    counts[backend] = count
    // An empty channel list must clear the previous image.
    renderer.render(frame, [])
    if (backend === 'webgl2') {
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data)
      if (data.some((value, index) => index % 4 === 3 && value !== 0))
        throw new Error('GPU did not clear')
    }
    if (backend === 'canvas') renderer.dispose()
  }
  const extension = gl.getExtension('WEBGL_lose_context')
  let contextLossDetected = false
  if (extension) {
    gpuCanvas.addEventListener('webglcontextlost', (event) => event.preventDefault())
    extension.loseContext()
    await new Promise((resolve) => setTimeout(resolve, 50))
    try {
      gpu.render(frame, geometry)
    } catch {
      contextLossDetected = true
    }
    if (!contextLossDetected) throw new Error('Context loss was not detected')
  }
  gpu.dispose()
  return { counts, rendererName, contextLossDetected, contextLossAvailable: !!extension }
}

;(
  globalThis as unknown as { runPlotRendererChecks: typeof runPlotRendererChecks }
).runPlotRendererChecks = runPlotRendererChecks
