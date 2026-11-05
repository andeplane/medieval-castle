import { describe, it, expect } from 'vitest';
import { WARM_INTERIOR, lookFromParams, whiteBalance } from '../../src/light/look';

describe('interior look', () => {
  it('overrides from URL parameters and ignores junk', () => {
    const q = new URLSearchParams('exposure=1.5&bloom=0&fill=0.2&haze=abc&adapt=0.5');
    const l = lookFromParams(WARM_INTERIOR, (k) => q.get(k));
    expect(l.exposure).toBe(1.5); expect(l.bloom.strength).toBe(0); expect(l.fill.intensity).toBe(0.2);
    expect(l.haze.density).toBe(WARM_INTERIOR.haze.density); expect(l.grade.adapt).toBe(0.5);
    expect(l.bloom.radius).toBe(WARM_INTERIOR.bloom.radius);
    expect(lookFromParams(WARM_INTERIOR, () => null)).toEqual(WARM_INTERIOR);
  });
  it('white balance keeps luminance and cools firelight a little', () => {
    const w = whiteBalance(1800, 0.2);
    expect(0.2126 * w[0] + 0.7152 * w[1] + 0.0722 * w[2]).toBeCloseTo(1);
    expect(w[2]).toBeGreaterThan(w[1]); expect(w[1]).toBeGreaterThan(w[0]);
    expect(whiteBalance(1800, 0)).toEqual([1, 1, 1].map(() => expect.closeTo(1, 6)));
    for (const c of whiteBalance(1000, 1)) expect(Number.isFinite(c)).toBe(true);
  });
});
