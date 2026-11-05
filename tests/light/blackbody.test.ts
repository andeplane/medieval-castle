import { describe, it, expect } from 'vitest';
import { kelvinToSrgb, kelvinToLinear, seenKelvin } from '../../src/light/blackbody';

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
  it('the adapted eye sees firelight warmer than white but not as the camera\'s orange', () => {
    expect(seenKelvin(1800, 0)).toBeCloseTo(1800);
    expect(seenKelvin(1800, 1)).toBeCloseTo(6500);
    expect(seenKelvin(1800, 2)).toBeCloseTo(6500); // clamped
    expect(seenKelvin(1800, 0.5, 5000)).toBeCloseTo(1e6 / ((1e6 / 1800 + 1e6 / 5000) / 2));
    // half way in mired is ~2800 K, not the 4150 K midpoint in kelvin
    const k = seenKelvin(1800, 0.5);
    expect(k).toBeGreaterThan(2700); expect(k).toBeLessThan(2900);
    const seen = kelvinToLinear(k), raw = kelvinToLinear(1800);
    expect(raw[2]).toBe(0); expect(seen[2]).toBeGreaterThan(0.05); expect(seen[1]).toBeGreaterThan(raw[1]);
  });
});
