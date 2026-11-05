import { describe, expect, test } from 'vitest';
import * as THREE from 'three/webgpu';
import { SHOT_STOPS, createAutoExposure, gpuLumaReader, type LumaReader } from '../src/render/exposure';
import { EXPOSURE } from '../src/render/interiorMath';

/** A reader that returns a flat grid at a given log2 luminance. */
const flat = (log2: () => number, fail = false): LumaReader & { calls: number } => {
  const r = {
    w: 4, h: 2, calls: 0,
    request() {
      r.calls++;
      if (fail) return Promise.reject(new Error('lost context'));
      const v = Math.round(((log2() + 14) / 18) * 255);
      return Promise.resolve(new Uint8Array(4 * 2 * 4).fill(v));
    },
  };
  return r;
};

describe('auto exposure', () => {
  test('outdoors stays at the base exposure; a dark room raises it smoothly to the cap', async () => {
    let L = -1;
    const target = { toneMappingExposure: 0 }, reader = flat(() => L);
    const ae = createAutoExposure({ target, reader, every: 1 });
    expect(target.toneMappingExposure).toBe(EXPOSURE.base);
    await ae.measure(); ae.update(1 / 60, { inside: false, deep: false });
    expect(ae.state.target).toBe(0);
    L = -9;
    await ae.measure();
    const seq: number[] = [];
    for (let i = 0; i < 240; i++) { ae.update(1 / 60, { inside: true, deep: false }); seq.push(ae.state.exposure); }
    expect(seq.every((v, i) => i === 0 || v >= seq[i - 1])).toBe(true);     // monotonic, no jumps
    expect(seq[59]).toBeLessThan(EXPOSURE.base * 2 ** EXPOSURE.maxStops * 0.8); // still adapting after 1 s
    expect(seq[239]).toBeGreaterThan(EXPOSURE.base * 2 ** (EXPOSURE.maxStops - 0.2));
    expect(seq[239]).toBeLessThanOrEqual(EXPOSURE.base * 2 ** EXPOSURE.maxStops + 1e-9);
    ae.update(1, { inside: true, deep: true });
    expect(ae.state.target).toBe(EXPOSURE.deepStops);
  });
  test('reads back only every N frames and never twice at once; failures are ignored', async () => {
    const reader = flat(() => -5);
    const ae = createAutoExposure({ target: { toneMappingExposure: 0 }, reader, every: 3 });
    const p = ae.measure();
    expect(p).not.toBe(null);
    expect(ae.measure()).toBe(null);          // pending
    await p;
    expect(ae.measure()).toBe(null); expect(ae.measure()).toBe(null);
    await ae.measure();
    expect(reader.calls).toBe(2);
    expect(ae.state.samples).toBe(2);
    const bad = createAutoExposure({ target: { toneMappingExposure: 0 }, reader: flat(() => 0, true), every: 1 });
    await bad.measure();
    expect(bad.state.samples).toBe(0);
    expect(createAutoExposure({ target: { toneMappingExposure: 0 }, reader: null }).measure()).toBe(null);
  });
  test('?exposure fixes it; ?shot sets it from where the camera is', () => {
    const t = { toneMappingExposure: 0 };
    const fixed = createAutoExposure({ target: t, reader: flat(() => -9), fixed: 1.3 });
    expect(fixed.measure()).toBe(null);
    fixed.update(1, { inside: true, deep: true });
    expect(t.toneMappingExposure).toBe(1.3);
    const shot = createAutoExposure({ target: t, reader: flat(() => -9), shot: true });
    expect(shot.measure()).toBe(null);
    shot.update(0, { inside: false, deep: false }); expect(t.toneMappingExposure).toBe(EXPOSURE.base);
    shot.update(0, { inside: true, deep: false }); expect(t.toneMappingExposure).toBeCloseTo(EXPOSURE.base * 2 ** SHOT_STOPS.inside);
    shot.update(0, { inside: true, deep: true }); expect(t.toneMappingExposure).toBeCloseTo(EXPOSURE.base * 2 ** SHOT_STOPS.deep);
  });
  test('gpuLumaReader renders a reduction quad and reads it back through the renderer', async () => {
    const calls: string[] = [];
    const renderer = {
      getRenderTarget: () => null,
      setRenderTarget: (rt: unknown) => { calls.push(rt ? 'rt' : 'screen'); },
      readRenderTargetPixelsAsync: async (_rt: unknown, _x: number, _y: number, w: number, h: number) => new Uint8Array(w * h * 4),
    };
    const quad = THREE.QuadMesh.prototype.render;
    THREE.QuadMesh.prototype.render = function () { calls.push('quad'); } as typeof quad;
    try {
      const r = gpuLumaReader(renderer as unknown as THREE.WebGPURenderer, new THREE.Texture(), 8, 4);
      expect([r.w, r.h]).toEqual([8, 4]);
      expect((await r.request()).length).toBe(8 * 4 * 4);
      expect(calls).toEqual(['rt', 'quad', 'screen']);
    } finally { THREE.QuadMesh.prototype.render = quad; }
  });
});
