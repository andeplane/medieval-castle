import { describe, it, expect } from 'vitest';
import { PropMesh, compose, translate, rotX, rotY, rotZ, applyP, applyD, IDENTITY, v3, type V3 } from '../src/props/geom';
import { checkMesh } from './helpers/mesh';

const close = (a: V3, b: V3) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 9));

describe('transforms', () => {
  it('composes translate and rotations like matrices', () => {
    close(applyP(IDENTITY, [1, 2, 3]), [1, 2, 3]);
    close(applyP(compose(translate(1, 0, 0), rotY(Math.PI / 2)), [1, 0, 0]), [1, 0, -1]);
    close(applyP(rotX(Math.PI / 2), [0, 1, 0]), [0, 0, 1]);
    close(applyP(rotZ(Math.PI / 2), [1, 0, 0]), [0, 1, 0]);
    close(applyD(translate(5, 5, 5), [0, 1, 0]), [0, 1, 0]);
  });
  it('vector helpers', () => {
    expect(v3.norm([0, 0, 0])).toEqual([0, 0, 0]);
    close(v3.mul([1, 2, 3], 2), [2, 4, 6]);
  });
});

describe('PropMesh primitives', () => {
  it('sharp box has 12 triangles, bevelled 44, and no bottom drops its faces', () => {
    const a = new PropMesh(); a.box('wood', [0, 0, 0], [1, 1, 1]); expect(a.triangles).toBe(12);
    const b = new PropMesh(); b.box('wood', [0, 0, 0], [1, 1, 1], { bevel: 0.05 }); expect(b.triangles).toBe(44);
    const c = new PropMesh(); c.box('wood', [0, 0, 0], [1, 1, 1], { bevel: 0.05, noBottom: true }); expect(c.triangles).toBe(44 - 2 - 8 - 4);
    for (const m of [a, b, c]) checkMesh(m);
    expect(b.bounds()).toEqual({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] });
  });
  it('box grain follows the longest axis unless given, and skew/taper move only the top', () => {
    const m = new PropMesh(); m.box('wood', [0, 0.5, 0], [0.2, 1, 0.2], { skew: [0.1, 0], taper: 0.5 });
    const bb = m.bounds(); expect(bb.max[0]).toBeCloseTo(0.15, 9); expect(bb.min[0]).toBeCloseTo(-0.1, 9);
    const g = new PropMesh(); g.box('wood', [0, 0, 0], [0.2, 0.2, 1], { grain: 2 }); checkMesh(g);
    const y = new PropMesh(); y.box('wood', [0, 0, 0], [0.2, 1, 0.5]); checkMesh(y);
  });
  it('tube with and without caps, variable radius', () => {
    const m = new PropMesh(); m.tube('wood', [[0, 0, 0], [0, 1, 0]], 0.1, 8);
    expect(m.triangles).toBe(16 + 16); checkMesh(m);
    const n = new PropMesh(); n.tube('iron', [[0, 0, 0], [1, 0, 0], [1, 1, 0]], [0.1, 0.2, 0.1], 6, [false, false]);
    expect(n.triangles).toBe(2 * 2 * 6); checkMesh(n);
  });
  it('lathe with caps and wobble; degenerate segments are skipped', () => {
    const m = new PropMesh(); m.lathe('ceramic', [[0, 0], [0, 0.1], [0.2, 0.2], [0.1, 0.4]], 8, { capTop: true, capBottom: true, wobble: () => 1.1, grainUp: true });
    expect(m.triangles).toBe(2 * 8 * 2 + 8 + 8); checkMesh(m);
  });
  it('sheet faces up by default and down when flipped', () => {
    const f = (s: number, t: number): V3 => [s, 0, t];
    const a = new PropMesh(); a.sheet('cloth', f, 2, 2, [1, 1]);
    const b = new PropMesh(); b.sheet('cloth', f, 2, 2, [1, 1], true);
    expect(a.bins.cloth.nor[1]).toBeLessThan(0); // (ds × dt) for x=s, z=t points down
    expect(b.bins.cloth.nor[1]).toBeGreaterThan(0);
    checkMesh(a); checkMesh(b);
  });
  it('with/tinted restore state even when the body throws', () => {
    const m = new PropMesh();
    expect(() => m.with(translate(1, 0, 0), () => { throw new Error('x'); })).toThrow();
    expect(() => m.tinted([0, 0, 0], () => { throw new Error('y'); })).toThrow();
    expect(m.xf).toEqual(IDENTITY); expect(m.tint).toEqual([1, 1, 1]);
    m.with(translate(0, 2, 0), () => m.tinted([0.5, 0.5, 0.5], () => m.box('iron', [0, 0, 0], [1, 1, 1])));
    expect(m.bounds().min[1]).toBeCloseTo(1.5); expect(m.bins.iron.col[0]).toBe(0.5);
  });
  it('append copies triangles, tints and applies the current transform', () => {
    const a = new PropMesh(); a.tinted([0.2, 0.3, 0.4], () => a.box('wax', [0, 0, 0], [1, 1, 1]));
    const b = new PropMesh(); b.with(translate(10, 0, 0), () => b.append(a));
    expect(b.triangles).toBe(12); expect(b.bounds().min[0]).toBeCloseTo(9.5); expect(b.bins.wax.col.slice(0, 3)).toEqual([0.2, 0.3, 0.4]);
    checkMesh(b);
  });
  it('quad emits two triangles and empty bounds are infinite', () => {
    const m = new PropMesh();
    expect(m.bounds().min[0]).toBe(Infinity);
    m.quad('straw', [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
    expect(m.triangles).toBe(2); checkMesh(m);
  });
});
