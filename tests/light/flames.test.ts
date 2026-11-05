import { describe, it, expect } from 'vitest';
import { linkFlames, flameBrightness, packFlames, LOOKS, KIND_INDEX } from '../../src/light/flames';
import { FLAME_KINDS, type Flame, type LightEmitter } from '../../src/light/types';
import { flicker, PROFILES } from '../../src/light/flicker';

const em = (kind: LightEmitter['kind'], x: number, seed?: number): LightEmitter => ({ kind, position: [x, 1, 0], colour: [1, 1, 1], intensity: 1, flicker: 0.2, seed });

describe('flames', () => {
  it('has a look and index for every kind', () => {
    for (const k of FLAME_KINDS) { expect(LOOKS[k].bright).toBeGreaterThan(0); expect(KIND_INDEX[k]).toBeGreaterThanOrEqual(0); }
    expect(LOOKS.torch.smoke).toBeGreaterThan(0); expect(LOOKS.candle.smoke).toBe(0);
    expect(LOOKS.candle.blue).toBeGreaterThan(LOOKS.torch.blue);
  });

  it('links a flame to the nearest emitter of its kind so they waver together', () => {
    const flames: Flame[] = [
      { kind: 'torch', base: [0, 0.9, 0], height: 0.3, up: [0, 0.97, 0.24] },
      { kind: 'candle', base: [0.05, 0.95, 0], height: 0.03 },
      { kind: 'candle', base: [9, 0.95, 0], height: 0.03 },
    ];
    const es = [em('candle', 0, 77), em('torch', 0.1, 55), em('torch', 0.3)];
    const L = linkFlames(flames, es);
    expect(L[0].seed).toBe(55);
    expect(L[1].seed).toBe(77);
    expect(L[2].seed).not.toBe(77); // nothing near: its own seed
    expect(L[0].up[1]).toBeGreaterThan(0.99); // flames rise even on a tilted torch
    expect(L[0].up[2]).toBeGreaterThan(0);
    expect(L[1].up).toEqual([0, 1, 0]);
    // emitter without a seed: flame takes the emitter's position seed
    const L2 = linkFlames([{ kind: 'torch', base: [0.3, 1, 0], height: 0.3 }], [em('torch', 0.3)]);
    expect(L2[0].seed).toBe(linkFlames([{ kind: 'torch', base: [0.3, 1, 0], height: 0.3 }], [em('torch', 0.3)])[0].seed);
  });

  it('brightness follows the shared flicker, steady without motion', () => {
    const L = linkFlames([{ kind: 'torch', base: [0, 1, 0], height: 0.3 }], [em('torch', 0, 9)]);
    const b = flameBrightness(L, 2.5, 1);
    expect(b[0]).toBeCloseTo(flicker(PROFILES.torch, 9, 2.5, 0.8).k, 6); // em() flicker 0.2 → amount 0.8
    expect(L[0].amount).toBeCloseTo(0.8);
    expect(linkFlames([{ kind: 'candle', base: [5, 1, 0], height: 0.03 }], [])[0].amount).toBe(0.5);
    const out = new Float32Array(1);
    expect(flameBrightness(L, 2.5, 0, out)).toBe(out);
    expect(out[0]).toBe(1);
  });

  it('packs instance attributes', () => {
    const L = linkFlames([{ kind: 'torch', base: [1, 2, 3], height: 0.3 }, { kind: 'candle', base: [4, 5, 6], height: 0.03 }], []);
    const P = packFlames(L);
    expect(P.count).toBe(2);
    expect(Array.from(P.base)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(P.shape[0]).toBeCloseTo(0.3); expect(P.shape[1]).toBeCloseTo(0.3 * LOOKS.torch.width);
    expect(P.shape[2]).toBeGreaterThanOrEqual(0); expect(P.shape[2]).toBeLessThan(1);
    expect(P.shape[3]).toBe(KIND_INDEX.torch); expect(P.shape[7]).toBe(KIND_INDEX.candle);
    expect(P.look[2]).toBeCloseTo(LOOKS.torch.bright);
    expect(P.glow[2]).toBe(LOOKS.torch.smoke);
    expect(P.smokers).toBe(1);
  });
});
