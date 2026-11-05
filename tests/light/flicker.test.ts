import { describe, it, expect } from 'vitest';
import { PROFILES, flicker, flickerAmount, hash1, noise1, seedOf } from '../../src/light/flicker';
import { FLAME_KINDS } from '../../src/light/types';

describe('flicker', () => {
  it('hash and noise are deterministic, bounded and smooth', () => {
    for (let i = 0; i < 200; i++) { const h = hash1(i * 7919); expect(h).toBeGreaterThanOrEqual(0); expect(h).toBeLessThan(1); }
    expect(hash1(42)).toBe(hash1(42));
    let prev = noise1(3, 0);
    for (let x = 0.01; x < 20; x += 0.01) {
      const n = noise1(3, x);
      expect(Math.abs(n)).toBeLessThanOrEqual(1);
      expect(Math.abs(n - prev)).toBeLessThan(0.05); // continuous
      prev = n;
    }
    expect(noise1(3, 5)).toBe(noise1(3, 5));
    expect(noise1(3, 5.5)).not.toBe(noise1(4, 5.5));
  });

  it('every kind has a profile with fire colours and sane ranges', () => {
    for (const k of FLAME_KINDS) {
      const p = PROFILES[k];
      expect(p.kind).toBe(k);
      expect(p.kelvin).toBeGreaterThan(1500); expect(p.kelvin).toBeLessThan(2200);
      expect(p.candela).toBeGreaterThan(0); expect(p.range).toBeGreaterThan(2);
    }
    expect(PROFILES.torch.candela).toBeGreaterThan(PROFILES.candle.candela);
    expect(PROFILES.hearth.range).toBeGreaterThan(PROFILES.candle.range);
  });

  it('averages ~1, never drops below a floor, and wavers', () => {
    for (const k of FLAME_KINDS) {
      let sum = 0, lo = Infinity, hi = -Infinity, n = 0;
      for (let t = 0; t < 120; t += 1 / 30) { const f = flicker(PROFILES[k], 7, t).k; sum += f; lo = Math.min(lo, f); hi = Math.max(hi, f); n++; }
      expect(sum / n).toBeGreaterThan(0.9); expect(sum / n).toBeLessThan(1.1);
      expect(lo).toBeGreaterThanOrEqual(0.35);
      expect(hi - lo).toBeGreaterThan(0.1);
    }
    // a torch wavers more than a lantern
    const spread = (k: 'torch' | 'lantern') => { const xs = Array.from({ length: 2000 }, (_, i) => flicker(PROFILES[k], 9, i / 30).k); const m = xs.reduce((a, b) => a + b) / xs.length; return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length; };
    expect(spread('torch')).toBeGreaterThan(spread('lantern'));
  });

  it('gutters: sometimes the flame dips sharply for a moment', () => {
    let dips = 0;
    for (let t = 0; t < 300; t += 1 / 60) {
      const a = flicker(PROFILES.torch, 11, t).k, b = flicker(PROFILES.torch, 11, t + 0.05).k;
      if (a - b > 0.12) dips++;
    }
    expect(dips).toBeGreaterThan(5);
  });

  it('different seeds are out of step; zero amount is steady', () => {
    const a = Array.from({ length: 100 }, (_, i) => flicker(PROFILES.torch, 1, i / 10).k);
    const b = Array.from({ length: 100 }, (_, i) => flicker(PROFILES.torch, 2, i / 10).k);
    expect(a.some((x, i) => Math.abs(x - b[i]) > 0.05)).toBe(true);
    expect(flicker(PROFILES.torch, 1, 3, 0)).toEqual({ k: 1, offset: [0, 0, 0] });
    const o = flicker(PROFILES.torch, 1, 3).offset;
    for (const c of o) expect(Math.abs(c)).toBeLessThanOrEqual(PROFILES.torch.sway);
  });

  it('maps emitter flicker to an amount', () => {
    expect(flickerAmount(0.25)).toBe(1); expect(flickerAmount(0.1)).toBeCloseTo(0.4); expect(flickerAmount(2)).toBe(1); expect(flickerAmount(-1)).toBe(0);
  });

  it('seeds positions stably', () => {
    expect(seedOf([1, 2, 3])).toBe(seedOf([1, 2, 3]));
    expect(seedOf([1, 2, 3])).not.toBe(seedOf([1, 2, 3.5]));
    expect(Number.isInteger(seedOf([0.3, 1.7, -2]))).toBe(true);
  });
});
