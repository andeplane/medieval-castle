// Type-safe fakes for the loading screen's injected dependencies.
import { createTunnelRenderer, type GLLike } from '../../src/loading/gl';
import type { LoadingDeps } from '../../src/loading/tunnel';

export interface FakeGL extends GLLike {
  calls: string[];
  uniforms: Map<string, unknown>;
  lost: boolean;
  failCompile: number | null;   // GL shader type that fails to compile
  failLink: boolean;
  nullShader: boolean;
  noLoseExt: boolean;
}

export function fakeGL(): FakeGL {
  const uniforms = new Map<string, unknown>();
  const loc = (name: string) => ({ name });
  type Loc = ReturnType<typeof loc>;
  const set = (l: WebGLUniformLocation | null, v: unknown) => { if (l) uniforms.set((l as Loc).name, v); };
  const shaders = new Map<WebGLShader, number>();
  const gl: FakeGL = {
    calls: [], uniforms, lost: false, failCompile: null, failLink: false, nullShader: false, noLoseExt: false,
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88e4, FLOAT: 0x1406, TRIANGLES: 0x0004,
    createShader(type) { if (gl.nullShader) return null; const s = {}; shaders.set(s, type); return s; },
    shaderSource() {}, compileShader() {},
    getShaderParameter(s) { return shaders.get(s) !== gl.failCompile; },
    getShaderInfoLog() { return 'ERROR: 0:1: syntax'; },
    createProgram() { return {}; },
    attachShader() {}, bindAttribLocation() {}, linkProgram() {},
    getProgramParameter() { return !gl.failLink; },
    getProgramInfoLog() { return 'link error'; },
    useProgram() { gl.calls.push('useProgram'); },
    createBuffer() { return {}; },
    bindBuffer() {}, bufferData() {}, enableVertexAttribArray() {}, vertexAttribPointer() {},
    getUniformLocation(_p, name) { return loc(name); },
    uniform1f(l, x) { set(l, x); },
    uniform2f(l, x, y) { set(l, [x, y]); },
    uniform1fv(l, v) { set(l, Array.from(v as Iterable<number>)); },
    uniform3fv(l, v) { set(l, Array.from(v as Iterable<number>)); },
    viewport(x, y, w, h) { gl.calls.push(`viewport ${x} ${y} ${w} ${h}`); },
    drawArrays() { gl.calls.push('draw'); },
    getExtension() { return gl.noLoseExt ? null : { loseContext: () => { gl.lost = true; } }; },
  };
  return gl;
}

export interface FakeDeps extends LoadingDeps {
  time: number;
  frames: ((t: number) => void)[];
  /** run the pending animation frame at time += ms */
  frame(ms?: number): void;
  waits: number[];
  pointer: ((x: number, y: number) => void) | null;
  unsubscribed: boolean;
  gl: FakeGL | null;
}

export function fakeDeps(o: Partial<Pick<LoadingDeps, 'reducedMotion' | 'makeRenderer'>> & { gl?: FakeGL | null } = {}): FakeDeps {
  const d: FakeDeps = {
    time: 0, frames: [], waits: [], pointer: null, unsubscribed: false,
    gl: o.gl === undefined ? fakeGL() : o.gl,
    frame(ms = 16) { d.time += ms; const fs = d.frames.splice(0); for (const f of fs) f(d.time); },
    now: () => d.time,
    raf: (cb) => d.frames.push(cb),
    caf: () => { d.frames.length = 0; },
    wait: async (ms) => { d.waits.push(ms); },
    nextFrame: async () => { d.frame(); },
    reducedMotion: o.reducedMotion ?? false,
    viewport: () => ({ w: 800, h: 400, dpr: 2 }),
    getGL: () => d.gl,
    onPointer: (cb) => { d.pointer = cb; return () => { d.unsubscribed = true; }; },
    makeRenderer: o.makeRenderer ?? createRendererRef,
  };
  return d;
}

const createRendererRef: LoadingDeps['makeRenderer'] = (gl, pal, reduced) => createTunnelRenderer(gl, pal, reduced, () => {});
