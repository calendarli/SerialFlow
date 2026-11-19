export const vertexShader = `#version 300 es
precision highp float;
layout(location=0) in vec4 segment;
uniform vec2 origin;
uniform vec2 scale;
uniform vec2 offset;
uniform vec2 surface;
uniform float halfWidth;
out vec2 localPosition;
flat out float segmentLength;
void main() {
  vec2 a = (segment.xy + origin) * scale + offset;
  vec2 b = (segment.zw + origin) * scale + offset;
  vec2 delta = b-a;
  float len = length(delta);
  vec2 tangent = len > 0.00001 ? delta / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-tangent.y, tangent.x);
  bool endPoint = gl_VertexID == 1 || gl_VertexID == 2 || gl_VertexID == 4;
  float side = (gl_VertexID == 0 || gl_VertexID == 1 || gl_VertexID == 3) ? -1.0 : 1.0;
  float along = endPoint ? len + halfWidth + 1.0 : -halfWidth - 1.0;
  float across = side * (halfWidth + 1.0);
  vec2 pixel = a + tangent * along + normal * across;
  gl_Position = vec4(pixel / surface * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
  localPosition = vec2(along, across);
  segmentLength = len;
}`

export const fragmentShader = `#version 300 es
precision highp float;
in vec2 localPosition;
flat in float segmentLength;
uniform vec4 color;
uniform float halfWidth;
out vec4 outputColor;
void main() {
  float cap = max(-localPosition.x, localPosition.x - segmentLength);
  float distanceToLine = length(vec2(max(cap, 0.0), localPosition.y));
  float alpha = 1.0 - smoothstep(max(0.0, halfWidth - 0.5), halfWidth + 0.5, distanceToLine);
  outputColor = vec4(color.rgb, color.a * alpha);
}`
