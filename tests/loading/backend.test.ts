import { describe, it, expect } from 'vitest';
import { localBackend, workerBackend } from '../../src/loading/backend';
import { PALETTE } from '../../src/loading/tunnel';
import { fakeClock, fakeGL, fakeWorker, quietRenderer } from './fakes';

const init = { w: 100, h: 50, reduced: false, palette: PALETTE };
const offscreen = {} as OffscreenCanvas;

describe('localBackend', () => {
  it('draws on the main thread, resizes the canvas and resolves when done', async () => {
    const gl = fakeGL();
    const clock = fakeClock();
    const c = { width: 0, height: 0 };
    const b = localBackend(c, gl, init, clock, quietRenderer);
    expect(b.offThread).toBe(false);
    clock.frame();
    expect([c.width, c.height]).toEqual([100, 50]);
    b.resize(200, 80);
    b.look(1, -1);
    clock.frame(10);
    expect(c.width).toBe(100);   // under 30 fps: no redraw yet
    clock.frame(30);
    expect([c.width, c.height]).toEqual([200, 80]);
    expect(gl.uniforms.get('uLook')).toEqual([1, -1]);
    let done = false;
    void b.whenDone().then(() => { done = true; });
    b.progress(1);
    for (let i = 0; i < 400; i++) clock.frame();
    await Promise.resolve();
    expect(b.shown).toBe(1);
    expect(done).toBe(true);
    b.dispose();
    expect(gl.lost).toBe(true);
  });

  it('walks a boot step in time', () => {
    const clock = fakeClock();
    const b = localBackend({ width: 0, height: 0 }, null, init, clock, quietRenderer);
    b.span(0, 0.5, 1000);
    for (let i = 0; i < 31; i++) clock.frame();   // ~0.5 s
    expect(b.shown).toBeGreaterThan(0.15);
    expect(b.shown).toBeLessThan(0.35);
    b.dispose();
  });

  it('works without GL', () => {
    const clock = fakeClock();
    const b = localBackend({ width: 0, height: 0 }, null, { ...init, fixed: 0.3 }, clock, quietRenderer);
    clock.frame();
    expect(b.shown).toBeGreaterThanOrEqual(0.3);
    b.dispose();
  });
});

describe('workerBackend', () => {
  it('transfers the canvas, forwards messages and mirrors the worker progress', async () => {
    const w = fakeWorker();
    const b = workerBackend(offscreen, w, { ...init, fixed: 0.2 });
    expect(b.offThread).toBe(true);
    expect(w.sent[0]).toEqual({ m: { t: 'init', canvas: offscreen, w: 100, h: 50, reduced: false, fixed: 0.2, palette: PALETTE }, transfer: [offscreen] });
    expect(b.shown).toBe(0.2);
    b.progress(0.6);
    b.look(0.5, 0.5);
    b.resize(10, 20);
    expect(w.sent.slice(1).map((s) => s.m)).toEqual([{ t: 'progress', p: 0.6 }, { t: 'look', x: 0.5, y: 0.5 }, { t: 'size', w: 10, h: 20 }]);
    b.span(0.3, 0.5, 2000);
    expect(w.sent.at(-1)!.m).toEqual({ t: 'span', start: 0.3, end: 0.5, ms: 2000 });
    w.reply({ t: 'shown', v: 0.42 });
    expect(b.shown).toBe(0.42);
    let done = false;
    void b.whenDone().then(() => { done = true; });
    w.reply({ t: 'shown', v: 1 });
    await Promise.resolve();
    expect(done).toBe(true);
    b.dispose();
    expect(w.sent.at(-1)!.m).toEqual({ t: 'stop' });
    expect(w.terminated).toBe(true);
  });

  it('follows the target directly when the worker has no GL', async () => {
    const w = fakeWorker();
    const b = workerBackend(offscreen, w, init);
    b.progress(0.3);
    w.reply({ t: 'nogl' });
    expect(b.shown).toBe(0.3);
    const n = w.sent.length;
    b.progress(0.7);
    expect(b.shown).toBe(0.7);
    b.span(0.8, 0.9, 100);
    expect(b.shown).toBe(0.8);
    expect(w.sent.length).toBe(n);
    b.progress(1);
    await b.whenDone();
  });

  it('falls back the same way when the worker errors, and is done at once if already complete', async () => {
    const w = fakeWorker();
    const b = workerBackend(offscreen, w, init);
    b.progress(1);
    w.fail();
    expect(b.shown).toBe(1);
    await b.whenDone();
    b.progress(0.5);
    expect(b.shown).toBe(1);
  });
});
