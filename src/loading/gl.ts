// WebGL2 side of the loading tunnel: compile the shader, draw one full-screen triangle per frame.
// It depends only on the narrow `GLLike` slice of WebGL2, so tests pass a small type-safe fake.
import { FRAG, VERT } from './tunnel.glsl';

export type GLLike = Pick<WebGL2RenderingContext,
  | 'createShader' | 'shaderSource' | 'compileShader' | 'getShaderParameter' | 'getShaderInfoLog'
  | 'createProgram' | 'attachShader' | 'bindAttribLocation' | 'linkProgram' | 'getProgramParameter' | 'getProgramInfoLog' | 'useProgram'
  | 'createBuffer' | 'bindBuffer' | 'bufferData' | 'enableVertexAttribArray' | 'vertexAttribPointer'
  | 'getUniformLocation' | 'uniform1f' | 'uniform2f' | 'uniform1fv' | 'uniform3fv' | 'viewport' | 'drawArrays'
  | 'VERTEX_SHADER' | 'FRAGMENT_SHADER' | 'COMPILE_STATUS' | 'LINK_STATUS' | 'ARRAY_BUFFER' | 'STATIC_DRAW' | 'FLOAT' | 'TRIANGLES'>
  & { getExtension(name: 'WEBGL_lose_context'): Pick<WEBGL_lose_context, 'loseContext'> | null };

export interface Frame {
  w: number; h: number; time: number;
  torches: Float32Array; fill: number; day: number; look: readonly [number, number];
}
export interface TunnelRenderer { draw(f: Frame): void; dispose(): void }
export interface Palette { stone: readonly (readonly [number, number, number])[]; mortar: readonly [number, number, number] }

/** Build the tunnel program; null (with a console warning) if the shader does not compile or link. */
export function createTunnelRenderer(gl: GLLike, pal: Palette, reduced: boolean, warn: (...a: unknown[]) => void = console.warn): TunnelRenderer | null {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) throw new Error('createShader failed');
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader compile failed');
    return s;
  };
  const prog = gl.createProgram();
  try {
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  } catch (e) { warn('loading tunnel shader failed', e); return null; }
  gl.bindAttribLocation(prog, 0, 'p');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { warn('loading tunnel link failed', gl.getProgramInfoLog(prog)); return null; }
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const u = (n: string) => gl.getUniformLocation(prog, n);
  const uRes = u('uRes'), uTime = u('uTime'), uI = u('uI'), uFill = u('uFill'), uLook = u('uLook'), uDay = u('uDay');
  gl.uniform3fv(u('uStone'), pal.stone.flat());
  gl.uniform3fv(u('uMortar'), [...pal.mortar]);
  gl.uniform1f(u('uMotion'), reduced ? 0 : 1);
  return {
    draw(f) {
      gl.viewport(0, 0, f.w, f.h);
      gl.uniform2f(uRes, f.w, f.h);
      gl.uniform1f(uTime, f.time);
      gl.uniform1fv(uI, f.torches);
      gl.uniform1f(uFill, f.fill);
      gl.uniform1f(uDay, f.day);
      gl.uniform2f(uLook, f.look[0], f.look[1]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() { gl.getExtension('WEBGL_lose_context')?.loseContext(); },
  };
}
