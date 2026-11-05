import { describe, it, expect } from 'vitest';
import { LoadingModel, torchThresholds, N_TORCH, FILL_FROM, spanProgress, caption } from '../../src/loading/model';

describe('torchThresholds', () => {
  it('lights torches in order, all before the fill stretch', () => {
    const t = torchThresholds();
    expect(t).toHaveLength(N_TORCH);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
    expect(t[0]).toBeGreaterThan(0);
    expect(t[t.length - 1]).toBeLessThan(FILL_FROM);
  });
  it('handles a single torch', () => expect(torchThresholds(1)).toEqual([0.03]));
});

describe('LoadingModel', () => {
  it('starts pitch dark', () => {
    const m = new LoadingModel();
    m.tick(0, 0);
    expect(m.shown).toBe(0);
    expect(m.ignite.every((x) => x === null)).toBe(true);
    expect(m.torch(0, 0)).toBe(0);
    expect(m.fill()).toBe(0);
    expect(m.caption).toBe('Down to the cellar… 0%');
  });

  it('eases toward the target no faster than needed and never goes backwards', () => {
    const m = new LoadingModel();
    m.setTarget(0.5, 'Cutting the stone…');
    m.setTarget(0.2);
    expect(m.target).toBe(0.5);
    expect(m.label).toBe('Cutting the stone…');
    m.tick(16, 0.016);
    expect(m.shown).toBeGreaterThan(0);
    expect(m.shown).toBeLessThan(0.5);
    for (let t = 32; t < 10_000; t += 16) m.tick(t, 0.016);
    expect(m.shown).toBe(0.5);
    m.setTarget(2);
    expect(m.target).toBe(1);
    m.setTarget(-1);
    expect(m.target).toBe(1);
  });

  it('strikes torches one after another in order (torch 0 is the farthest)', () => {
    const m = new LoadingModel();
    m.setTarget(1);
    const order: number[] = [];
    for (let t = 0; t < 5000; t += 16) {
      m.tick(t, 0.016);
      m.ignite.forEach((at, i) => { if (at !== null && !order.includes(i)) order.push(i); });
    }
    expect(order).toEqual([...Array(N_TORCH).keys()]);
    const times = m.ignite as number[];
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(16);
    expect(m.done).toBe(true);
    expect(m.fill()).toBe(1);
    expect(m.percent).toBe(100);
  });

  it('flares on ignition then settles to a steady 1', () => {
    const m = new LoadingModel();
    m.setTarget(0.05);
    m.tick(1000, 0.1);
    expect(m.ignite[0]).toBe(1000);
    expect(m.torch(0, 1000)).toBe(0);
    expect(m.torch(0, 1150)).toBeGreaterThan(0);
    const settled = m.torch(0, 4000);
    expect(settled).toBeCloseTo(1, 3);
    expect(m.torch(1, 4000)).toBe(0);
  });

  it('skips the sputter for reduced motion', () => {
    const m = new LoadingModel({ reduced: true });
    m.setTarget(0.05);
    m.tick(0, 0.1);
    expect(m.torch(0, 275)).toBeCloseTo(0.25, 5);
  });

  it('shows a fixed preview with torches already burning', () => {
    const m = new LoadingModel({ fixed: 0.5 });
    expect(m.fixed).toBe(true);
    m.tick(10, 0.016);
    const lit = m.thresholds.filter((t) => t <= 0.5).length;
    expect(m.ignite.filter((x) => x !== null)).toHaveLength(lit);
    expect(m.torch(0, 10)).toBe(1);
    expect(new LoadingModel({ fixed: 7 }).shown).toBe(1);
  });

  it('brings up the fill only in the last stretch', () => {
    const m = new LoadingModel({ fixed: FILL_FROM });
    expect(m.fill()).toBe(0);
    const h = new LoadingModel({ fixed: (FILL_FROM + 1) / 2 });
    expect(h.fill()).toBeCloseTo(0.5, 5);
  });
});

describe('caption', () => {
  it('reads step then percent', () => expect(caption('Cutting the stone…', 0.426)).toBe('Cutting the stone… 43%'));
});

describe('spanProgress', () => {
  const s = { start: 0.2, end: 0.6, ms: 1000, t0: 500 };
  it('moves linearly with time over the expected duration', () => {
    expect(spanProgress(s, 500)).toBe(0.2);
    expect(spanProgress(s, 0)).toBe(0.2);
    expect(spanProgress(s, 1000)).toBeCloseTo(0.4);
    expect(spanProgress(s, 1250)).toBeCloseTo(0.5);
  });
  it('slows past the expected time but never reaches the end', () => {
    const a = spanProgress(s, 1500), b = spanProgress(s, 3000), c = spanProgress(s, 60_000);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(c).toBeLessThan(0.6);
  });
});

describe('LoadingModel spans', () => {
  it('follows the running step in time, without creeping when there is none', () => {
    const m = new LoadingModel();
    for (let t = 0; t < 2000; t += 16) m.tick(t, 0.016);
    expect(m.shown).toBe(0);
    m.setSpan(0, 0.5, 4000, 2000);
    for (let t = 2000; t <= 4000; t += 16) m.tick(t, 0.016);
    expect(m.shown).toBeCloseTo(0.25, 1);
    m.setSpan(0.5, 0.9, 1000, 4000);
    for (let t = 4000; t <= 4500; t += 16) m.tick(t, 0.016);
    expect(m.shown).toBeGreaterThan(0.5);
    expect(m.shown).toBeLessThan(0.75);
    expect(m.span!.ms).toBe(1000);
    m.setSpan(0.9, 0.95, 0, 4500);
    expect(m.span!.ms).toBe(1);
  });
});
