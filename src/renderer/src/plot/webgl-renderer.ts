import { vertexShader, fragmentShader } from './shaders'
import { plotRect, type PlotRenderer, type PlotFrame, type Geometry } from './render-types'

export class WebGLRenderer implements PlotRenderer {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private vao: WebGLVertexArrayObject
  private buffers = new Map<string, { buffer: WebGLBuffer; revision: number; capacity: number }>()
  private uniforms: Record<string, WebGLUniformLocation | null> = {}
  constructor(private canvas: OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: false
    })
    if (!gl) throw new Error('WebGL2 不可用')
    this.gl = gl
    const program = gl.createProgram()
    const vao = gl.createVertexArray()
    if (!program || !vao) throw new Error('GPU 资源分配失败')
    this.program = program
    this.vao = vao
    try {
      for (const [kind, source] of [
        [gl.VERTEX_SHADER, vertexShader],
        [gl.FRAGMENT_SHADER, fragmentShader]
      ] as const) {
        const shader = gl.createShader(kind)
        if (!shader) throw new Error('无法创建曲线着色器')
        gl.shaderSource(shader, source)
        gl.compileShader(shader)
        const valid = gl.getShaderParameter(shader, gl.COMPILE_STATUS)
        const log = gl.getShaderInfoLog(shader)
        if (valid) gl.attachShader(program, shader)
        gl.deleteShader(shader)
        if (!valid) throw new Error(log || '曲线着色器编译失败')
      }
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program) || '曲线程序链接失败')
      for (const name of ['origin', 'scale', 'offset', 'surface', 'halfWidth', 'color'])
        this.uniforms[name] = gl.getUniformLocation(program, name)
    } catch (error) {
      gl.deleteProgram(program)
      gl.deleteVertexArray(vao)
      throw error
    }
  }
  render(frame: PlotFrame, geometry: Geometry[]): void {
    const gl = this.gl
    if (gl.isContextLost()) throw new Error('GPU 绘图上下文已丢失')
    const width = Math.max(1, Math.round(frame.width * frame.dpr))
    const height = Math.max(1, Math.round(frame.height * frame.dpr))
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
    gl.viewport(0, 0, width, height)
    gl.disable(gl.SCISSOR_TEST)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const rect = plotRect(frame),
      u = this.uniforms
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(
      Math.round(rect.x * frame.dpr),
      Math.round((frame.height - rect.y - rect.height) * frame.dpr),
      Math.round(rect.width * frame.dpr),
      Math.round(rect.height * frame.dpr)
    )
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.uniform2f(u.surface, frame.width, frame.height)
    gl.uniform2f(u.offset, rect.x, rect.y + rect.height)
    gl.uniform2f(
      u.scale,
      rect.width / (frame.xMax - frame.xMin),
      -rect.height / (frame.yMax - frame.yMin)
    )
    gl.uniform1f(u.halfWidth, frame.lineWidth / 2)
    const used = new Set<string>()
    for (const item of geometry) {
      used.add(item.key)
      let entry = this.buffers.get(item.key)
      if (!entry) {
        const buffer = gl.createBuffer()
        if (!buffer) throw new Error('曲线缓冲分配失败')
        entry = { buffer, revision: -1, capacity: 0 }
        this.buffers.set(item.key, entry)
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer)
      if (entry.revision !== item.revision) {
        if (entry.capacity < item.segments.byteLength) {
          entry.capacity = Math.max(4096, 2 ** Math.ceil(Math.log2(item.segments.byteLength || 1)))
          gl.bufferData(gl.ARRAY_BUFFER, entry.capacity, gl.DYNAMIC_DRAW)
        }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, item.segments)
        entry.revision = item.revision
      }
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0)
      gl.vertexAttribDivisor(0, 1)
      gl.uniform2f(u.origin, item.originX - frame.xMin, item.originY - frame.yMin)
      const color = Number.parseInt(item.color.slice(1), 16)
      gl.uniform4f(
        u.color,
        ((color >> 16) & 255) / 255,
        ((color >> 8) & 255) / 255,
        (color & 255) / 255,
        1
      )
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, item.segments.length / 4)
    }
    for (const [key, entry] of this.buffers)
      if (!used.has(key)) {
        gl.deleteBuffer(entry.buffer)
        this.buffers.delete(key)
      }
    gl.bindVertexArray(null)
    gl.disable(gl.SCISSOR_TEST)
  }
  dispose(): void {
    for (const entry of this.buffers.values()) this.gl.deleteBuffer(entry.buffer)
    this.buffers.clear()
    this.gl.deleteVertexArray(this.vao)
    this.gl.deleteProgram(this.program)
  }
}
