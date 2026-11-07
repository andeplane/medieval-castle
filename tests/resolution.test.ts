import { describe, it, expect } from 'vitest';
import { ResolutionGovernor, startRatio, PIXEL_BUDGET, passTexels, gtaoSizeFor } from '../src/render/resolution';

describe('dynamic resolution', () => {
  it('starts at the top and steps down while over budget, a second apart', () => {
    const g = new ResolutionGovernor({ max: 2 });
    expect(g.ratio).toBe(2);
    expect(g.update(30, 0)).toBe(1.75);
    expect(g.update(30, 500)).toBe(1.75); // too soon
    expect(g.update(30, 1000)).toBe(1.5);
    expect(g.update(30, 2000)).toBe(1.25);
    expect(g.update(30, 3000)).toBe(1);
    expect(g.update(30, 4000)).toBe(1); // floor
  });
  it('steps up only when the bigger frame would still fit, and waits longer to do it', () => {
    const g = new ResolutionGovernor({ max: 2, budgetMs: 15, headroom: 0.8 });
    g.update(30, 0); g.update(30, 1000); // 1.5
    expect(g.ratio).toBe(1.5);
    expect(g.update(1, 2000)).toBe(1.5); // too soon after the last change
    // at 1.5 → 1.75 the load grows by (1.75/1.5)² ≈ 1.36: 9 ms → 12.25 ≥ 12 (budget × headroom): hold
    expect(g.update(9, 4000)).toBe(1.5);
    expect(g.update(8, 4000)).toBe(1.75);
    expect(g.update(13, 8000)).toBe(1.75); // within budget: hold
    expect(g.update(1, 8000)).toBe(2);
    expect(g.update(1, 12000)).toBe(2); // ceiling
  });
  it('ignores missing loads and clamps min to max', () => {
    const g = new ResolutionGovernor({ max: 1, min: 1.5 });
    expect(g.update(0, 0)).toBe(1);
    expect(g.update(NaN, 0)).toBe(1);
    expect(g.update(50, 0)).toBe(1);
    const h = new ResolutionGovernor({ max: 2, min: 0.5, step: 0.5 });
    expect(h.update(100, 0)).toBe(1.5);
  });
  it('can start below its ceiling and climb to it with headroom', () => {
    const g = new ResolutionGovernor({ max: 2, start: 1.25 });
    expect(g.ratio).toBe(1.25);
    expect(g.update(1, 0)).toBe(1.5);
    expect(g.update(1, 3000)).toBe(1.75);
    expect(g.update(1, 6000)).toBe(2);
    expect(new ResolutionGovernor({ max: 2, start: 0.5 }).ratio).toBe(1); // clamped to min
    expect(new ResolutionGovernor({ max: 1.5, start: 3 }).ratio).toBe(1.5); // and to max
  });
});

describe('start ratio (1440p pixel budget)', () => {
  it('keeps the screen ratio when the canvas fits the budget', () => {
    expect(startRatio(1600, 900, 1)).toBe(1);
    expect(startRatio(1280, 720, 2)).toBe(2); // 3.7 M device pixels at 2×: exactly 1440p
    expect(startRatio(0, 0, 2)).toBe(2);
  });
  it('steps down on the governor grid for big retina canvases', () => {
    expect(startRatio(1512, 982, 2)).toBe(1.5); // MacBook Pro 14", full screen
    expect(startRatio(1728, 1117, 2)).toBe(1.25); // MacBook Pro 16"
    expect(startRatio(2560, 1440, 2)).toBe(1);
    expect(startRatio(3840, 2160, 2)).toBe(1); // never below min
    expect(startRatio(1728, 1117, 2, PIXEL_BUDGET * 4)).toBe(2);
  });
});

describe('half-res AO sizing', () => {
  // GTAONode sizes its target as Math.round(size × scale); PassNode (its depth/normal pre-pass) floors
  const gtao = (n: number, s: number) => Math.round(s * n);
  it('matches the pre-pass texel for texel at every buffer size', () => {
    for (const s of [0.5, 1]) for (let n = 1; n <= 4096; n++) expect(gtao(gtaoSizeFor(n, s), s)).toBe(passTexels(n, s));
  });
  it('fixes the odd sizes that put a seam down the middle', () => {
    expect(gtao(2469, 0.5)).not.toBe(passTexels(2469, 0.5)); // what three does on its own
    expect(passTexels(2469, 0.5)).toBe(1234);
  });
});
