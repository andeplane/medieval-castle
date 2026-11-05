import { describe, it, expect } from 'vitest';
import { ResolutionGovernor } from '../src/render/resolution';

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
});
