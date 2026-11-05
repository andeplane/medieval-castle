// Type-safe fakes for the loading screen's injected dependencies.
import { createTunnelRenderer, type GLLike, type Palette, type TunnelRenderer } from '../../src/loading/gl';
import type { LoadingDeps } from '../../src/loading/tunnel';
import type { Clock } from '../../src/loading/loop';
import type { TunnelBackend, BackendInit, WorkerLike } from '../../src/loading/backend';
import type { FromWorker, ToWorker } from '../../src/loading/protocol';

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

/** A clock whose frames run only when the test says so. */
export interface FakeClock extends Clock { time: number; frames: ((t: number) => void)[]; frame(ms?: number): void }
export function fakeClock(): FakeClock {
  const c: FakeClock = {
    time: 0, frames: [],
    frame(ms = 16) { c.time += ms; const fs = c.frames.splice(0); for (const f of fs) f(c.time); },
    now: () => c.time,
    raf: (cb) => c.frames.push(cb),
    caf: () => { c.frames.length = 0; },
  };
  return c;
}

export const quietRenderer = (gl: GLLike, pal: Palette, reduced: boolean): TunnelRenderer | null => createTunnelRenderer(gl, pal, reduced, () => {});

/** A backend that records what the screen asks of it. */
export interface FakeBackend extends TunnelBackend {
  init: BackendInit | null; shownValue: number; looks: [number, number][]; sizes: [number, number][]; progresses: number[];
  disposed: boolean; finishNow(): void;
}
export function fakeBackend(): FakeBackend {
  let fire: () => void = () => {};
  const done = new Promise<void>((r) => { fire = r; });
  const b: FakeBackend = {
    init: null, shownValue: 0, looks: [], sizes: [], progresses: [], disposed: false,
    get shown() { return b.shownValue; },
    offThread: true,
    progress: (p) => { b.progresses.push(p); },
    look: (x, y) => { b.looks.push([x, y]); },
    resize: (w, h) => { b.sizes.push([w, h]); },
    whenDone: () => done,
    dispose: () => { b.disposed = true; },
    finishNow: () => { b.shownValue = 1; fire(); },
  };
  return b;
}

export interface FakeDeps extends LoadingDeps {
  clock: FakeClock; be: FakeBackend; waits: number[];
  pointer: ((x: number, y: number) => void) | null; resize: (() => void) | null; unsubscribed: number; view: { w: number; h: number; dpr: number };
}
export function fakeDeps(o: { reducedMotion?: boolean } = {}): FakeDeps {
  const clock = fakeClock();
  const be = fakeBackend();
  const d: FakeDeps = {
    clock, be, waits: [], pointer: null, resize: null, unsubscribed: 0, view: { w: 800, h: 400, dpr: 2 },
    raf: clock.raf, caf: clock.caf,
    wait: async (ms) => { d.waits.push(ms); },
    nextFrame: async () => { clock.frame(); },
    reducedMotion: o.reducedMotion ?? false,
    viewport: () => d.view,
    onPointer: (cb) => { d.pointer = cb; return () => { d.unsubscribed++; }; },
    onResize: (cb) => { d.resize = cb; return () => { d.unsubscribed++; }; },
    backend: (_c, init) => { be.init = init; return be; },
  };
  return d;
}

/** A worker the test can answer for. */
export interface FakeWorker extends WorkerLike {
  sent: { m: ToWorker; transfer?: Transferable[] }[]; terminated: boolean;
  reply(m: FromWorker): void; fail(): void;
}
export function fakeWorker(): FakeWorker {
  let onMsg: (m: FromWorker) => void = () => {}, onErr: (e: unknown) => void = () => {};
  const w: FakeWorker = {
    sent: [], terminated: false,
    post: (m, transfer) => { w.sent.push({ m, transfer }); },
    listen: (a, b) => { onMsg = a; onErr = b; },
    terminate: () => { w.terminated = true; },
    reply: (m) => onMsg(m),
    fail: () => onErr(new Error('boom')),
  };
  return w;
}
