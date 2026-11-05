import { describe, it, expect } from 'vitest';
import { WARM_INTERIOR, lookFromParams } from '../../src/light/look';
import { DEFAULT_RIG } from '../../src/light/rig';

describe('interior look', () => {
  it('overrides from URL parameters and ignores junk', () => {
    const q = new URLSearchParams('exposure=1.5&bloom=0&fill=0.2&haze=abc&adapt=0.5');
    const l = lookFromParams(WARM_INTERIOR, (k) => q.get(k));
    expect(l.exposure).toBe(1.5); expect(l.bloom.strength).toBe(0); expect(l.fill.intensity).toBe(0.2);
    expect(l.haze.density).toBe(WARM_INTERIOR.haze.density); expect(l.grade.adapt).toBe(0.5);
    expect(l.bloom.radius).toBe(WARM_INTERIOR.bloom.radius);
    expect(lookFromParams(WARM_INTERIOR, () => null)).toEqual(WARM_INTERIOR);
  });
  it('the rig takes the look\'s adaptation to firelight', () => {
    expect(DEFAULT_RIG.adapt).toBe(WARM_INTERIOR.grade.adapt);
    expect(WARM_INTERIOR.grade.adapt).toBeGreaterThan(0.3); expect(WARM_INTERIOR.grade.adapt).toBeLessThan(0.8);
  });
});
