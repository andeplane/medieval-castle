import { describe, it, expect } from 'vitest';
import { lightScore, stepPool, emptyPool, assign, type Candidate, type Pools } from '../../src/light/budget';

const c = (x: number, candela = 10, range = 8): Candidate => ({ position: [x, 1.5, 0], candela, range });
const ids = (p: Pools) => ({ s: p.shadow.map((x) => x.source), p: p.plain.map((x) => x.source) });

describe('light score', () => {
  it('falls with distance, rises with brightness, is zero beyond reach', () => {
    const eye: [number, number, number] = [0, 1.5, 0];
    expect(lightScore(c(1), eye)).toBeGreaterThan(lightScore(c(3), eye));
    expect(lightScore(c(3, 20), eye)).toBeGreaterThan(lightScore(c(3, 10), eye));
    expect(lightScore(c(13), eye)).toBe(0);
    expect(lightScore(c(12.7), eye)).toBeGreaterThan(0);
  });
});

describe('pools', () => {
  it('fade a source in, keep it, and fade it out before reusing the slot', () => {
    let pool = emptyPool(2);
    pool = stepPool(pool, [5], 0.5);
    expect(pool[0]).toEqual({ source: 5, weight: 0.5 });
    expect(pool[1].source).toBe(-1);
    pool = stepPool(pool, [5], 0.5);
    expect(pool[0].weight).toBe(1);
    pool = stepPool(pool, [5], 0.5);
    expect(pool[0].weight).toBe(1);
    // 5 no longer wanted, 6 and 7 are: the free slot takes 6 at once, 7 waits for slot 0 to go dark
    pool = stepPool(pool, [6, 7], 0.5);
    expect(pool[0]).toEqual({ source: 5, weight: 0.5 });
    expect(pool[1]).toEqual({ source: 6, weight: 0.5 });
    pool = stepPool(pool, [6, 7], 0.5);
    expect(pool[0]).toEqual({ source: 7, weight: 0.5 });
    // nothing wanted: everything fades and frees
    pool = stepPool(pool, [], 1);
    expect(pool.every((s) => s.source === -1 && s.weight === 0)).toBe(true);
  });
  it('does not mutate its input', () => {
    const pool = emptyPool(1), copy = JSON.stringify(pool);
    stepPool(pool, [1], 1);
    expect(JSON.stringify(pool)).toBe(copy);
  });
});

describe('assign', () => {
  const opts = { keep: 1.25, fadeTime: 0.25 };
  it('gives the nearest fires shadows, the next plain lights, and leaves far ones dark', () => {
    const cands = [c(10), c(1), c(2), c(4), c(-3), c(30)];
    let p: Pools = { shadow: emptyPool(1), plain: emptyPool(2) };
    p = assign(p, cands, [0, 1.5, 0], 1, opts);
    expect(ids(p)).toEqual({ s: [1], p: [2, 4] });
    expect(p.shadow[0].weight).toBe(1);
  });
  it('honours visibility', () => {
    const cands = [c(1), c(2), c(3)];
    const p = assign({ shadow: emptyPool(1), plain: emptyPool(1) }, cands, [0, 1.5, 0], 1, { ...opts, visible: (id) => id !== 0 });
    expect(ids(p)).toEqual({ s: [1], p: [2] });
  });
  it('hysteresis: a lit source keeps its light against a slightly closer one', () => {
    const cands = [c(2.0), c(-2.1)];
    let p: Pools = { shadow: emptyPool(1), plain: emptyPool(0) };
    p = assign(p, cands, [0, 1.5, 0], 1, opts);
    expect(p.shadow[0].source).toBe(0);
    p = assign(p, cands, [-0.1, 1.5, 0], 1, opts); // now 1 is a little closer
    expect(p.shadow[0].source).toBe(0);
    p = assign(p, cands, [-1.5, 1.5, 0], 0.125, opts); // much closer: it wins
    expect(p.shadow[0]).toEqual({ source: 0, weight: 0.5 }); // fading out first …
    p = assign(p, cands, [-1.5, 1.5, 0], 0.125, opts);
    expect(p.shadow[0]).toEqual({ source: 1, weight: 0.5 }); // … then the slot goes to the new one
  });
  it('cross-fades a source moving from the plain pool to the shadow pool', () => {
    const cands = [c(1), c(3)];
    let p: Pools = { shadow: emptyPool(1), plain: emptyPool(1) };
    p = assign(p, cands, [0, 1.5, 0], 1, opts);
    expect(ids(p)).toEqual({ s: [0], p: [1] });
    p = assign(p, cands, [3.2, 1.5, 0], 0.125, opts); // source 1 now matters most
    const both = [...p.shadow, ...p.plain].filter((s) => s.source === 1);
    expect(both.length).toBeGreaterThanOrEqual(1);
    const total = both.reduce((a, s) => a + s.weight, 0);
    expect(total).toBeGreaterThan(0.4);
  });
  it('fadeTime 0 switches instantly; ties break by id', () => {
    const p = assign({ shadow: emptyPool(1), plain: emptyPool(1) }, [c(2), c(-2)], [0, 1.5, 0], 0.016, { keep: 1, fadeTime: 0 });
    expect(ids(p)).toEqual({ s: [0], p: [1] });
    expect(p.plain[0].weight).toBe(1);
  });
});
