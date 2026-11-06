import { describe, it, expect } from 'vitest';
import { serveTunnel } from '../../src/loading/worker';
import { PALETTE } from '../../src/loading/tunnel';
import type { FromWorker, ToWorker, WorkerScope } from '../../src/loading/protocol';
import { fakeClock, fakeGL, quietRenderer, type FakeGL } from './fakes';

function scope() {
  const out: FromWorker[] = [];
  const s: WorkerScope = { onmessage: null, postMessage: (m) => { out.push(m); } };
  return { s, out, send: (m: ToWorker) => s.onmessage!({ data: m }) };
}
const canvas = () => ({ width: 0, height: 0 }) as unknown as OffscreenCanvas;

describe('serveTunnel', () => {
  it('draws on the transferred canvas, follows progress and reports it back', () => {
    const { s, out, send } = scope();
    const clock = fakeClock();
    const gl = fakeGL();
    serveTunnel(s, { clock, getGL: () => gl, makeRenderer: quietRenderer });
    send({ t: 'progress', p: 0.5 });   // before init: ignored
    send({ t: 'span', start: 0, end: 1, ms: 1 });
    const c = canvas();
    send({ t: 'init', canvas: c, w: 320, h: 180, reduced: false, palette: PALETTE });
    send({ t: 'init', canvas: canvas(), w: 1, h: 1, reduced: false, palette: PALETTE });   // second init ignored
    clock.frame();
    expect([c.width, c.height]).toEqual([320, 180]);
    expect(out).toEqual([{ t: 'shown', v: 0 }]);
    send({ t: 'span', start: 0, end: 0.4, ms: 1000 });
    for (let i = 0; i < 32; i++) clock.frame();
    expect((out.at(-1) as { v: number }).v).toBeGreaterThan(0.1);
    send({ t: 'progress', p: 1 });
    send({ t: 'look', x: 0.3, y: -0.3 });
    send({ t: 'size', w: 640, h: 360 });
    for (let i = 0; i < 400; i++) clock.frame();
    expect([c.width, c.height]).toEqual([640, 360]);
    const [lx, ly] = gl.uniforms.get('uLook') as number[];   // eased all the way to the pointer
    expect(lx).toBeCloseTo(0.3);
    expect(ly).toBeCloseTo(-0.3);
    expect(out.at(-1)).toEqual({ t: 'shown', v: 1 });
    const n = out.length;
    clock.frame();
    expect(out.length).toBe(n);   // no repeat while unchanged
    send({ t: 'stop' });
    expect(gl.lost).toBe(true);
    expect(clock.frames).toHaveLength(0);
    send({ t: 'stop' });
  });

  it('reports nogl when there is no WebGL2 or the shader fails, but keeps reporting progress', () => {
    for (const getGL of [() => null, () => { const g: FakeGL = fakeGL(); g.failLink = true; return g; }]) {
      const { s, out, send } = scope();
      const clock = fakeClock();
      serveTunnel(s, { clock, getGL, makeRenderer: quietRenderer });
      send({ t: 'init', canvas: canvas(), w: 2, h: 2, reduced: true, fixed: 0.5, palette: PALETTE });
      clock.frame();
      expect(out).toEqual([{ t: 'nogl' }, { t: 'shown', v: 0.5 }]);
    }
  });
});
