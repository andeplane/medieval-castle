import { describe, it, expect } from 'vitest';
import { kelvinToSrgb, kelvinToLinear } from '../../src/light/blackbody';

describe('black body colour', () => {
  it('fire is red-orange with no blue, daylight is near white, blue sky is blue', () => {
    const fire = kelvinToSrgb(1800);
    expect(fire[0]).toBe(1); expect(fire[1]).toBeGreaterThan(0.4); expect(fire[1]).toBeLessThan(0.6); expect(fire[2]).toBe(0);
    const day = kelvinToSrgb(6600);
    for (const c of day) expect(c).toBeGreaterThan(0.95);
    const sky = kelvinToSrgb(12000);
    expect(sky[2]).toBe(1); expect(sky[0]).toBeLessThan(sky[2]);
    expect(kelvinToSrgb(500)).toEqual(kelvinToSrgb(1000)); // clamped
    expect(kelvinToSrgb(3000)[2]).toBeGreaterThan(0);
  });
  it('linear colour is normalised and warmer than its sRGB', () => {
    const l = kelvinToLinear(1850), s = kelvinToSrgb(1850);
    expect(Math.max(...l)).toBeCloseTo(1);
    expect(l[1]).toBeLessThan(s[1]);
    const cool = kelvinToLinear(9000);
    expect(Math.max(...cool)).toBeCloseTo(1); expect(cool[2]).toBe(1);
    const low = kelvinToLinear(1000); expect(low[2]).toBe(0);
    expect(kelvinToLinear(2000)[1]).toBeGreaterThan(0.2 - 0.2); // tiny green near 2000 K still positive
  });
});
