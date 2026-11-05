// D.1 guards: the stone course layout is the texture's layout, covers each face, never overlaps an
// opening, interlocks at corners and is a pure function of the seed.
import { describe, it, expect } from 'vitest';
import { layoutFace, masonrySpec, bandRange, rectShape, F_EXT_L, F_EXT_R, type StoneFace } from '../src/castle/stones/layout';
import type { V2 } from '../src/core/math2d';

const plane = (over: Partial<StoneFace> = {}): StoneFace => ({
  mat: 'old', geom: { kind: 'plane', o: [0, 0, 0], r: [1, 0, 0], n: [0, 0, 1] },
  s0: 0, s1: 9.3, y0: 2.6, y1: 11.1, u0: 0, holes: [], ends: [false, false], sil: false, owner: -1, ...over,
});
const lancet: V2[] = [[3.5, 5], [4.5, 5], [4.5, 7.4], [4.25, 7.9], [4.0, 8.15], [3.75, 7.9], [3.5, 7.4]];

describe('stone courses', () => {
  for (const mat of ['old', 'new'] as const) {
    it(`${mat}: courses cover the face and stones tile each course`, () => {
      const f = plane({ mat });
      const stones = layoutFace(f, 0);
      expect(stones.length).toBeGreaterThan(50);
      const bands = new Map<number, { ya: number; yb: number; iv: [number, number][] }>();
      for (const s of stones) {
        expect(s.b - s.a).toBeGreaterThanOrEqual(0.12 - 1e-9);
        expect(s.a).toBeGreaterThanOrEqual(f.s0 - 1e-9); expect(s.b).toBeLessThanOrEqual(f.s1 + 1e-9);
        const b = bands.get(s.course) ?? { ya: Infinity, yb: -Infinity, iv: [] };
        b.ya = Math.min(b.ya, s.ya); b.yb = Math.max(b.yb, s.yb); b.iv.push([s.a, s.b]);
        bands.set(s.course, b);
      }
      const list = [...bands.values()].sort((p, q) => p.ya - q.ya);
      // courses are stacked without gaps from the bottom to the top of the face
      expect(list[0].ya).toBeLessThan(f.y0 + 0.08 + 1e-9);
      expect(list[list.length - 1].yb).toBeGreaterThan(f.y1 - 0.08 - 1e-9);
      for (let i = 1; i < list.length; i++) expect(Math.abs(list[i].ya - list[i - 1].yb)).toBeLessThan(1e-9);
      // every course is tiled end to end (split stones share their interval)
      for (const b of list) {
        const iv = [...new Map(b.iv.map((v) => [v.join(), v])).values()].sort((p, q) => p[0] - q[0]);
        expect(iv[0][0]).toBeCloseTo(f.s0, 9); expect(iv[iv.length - 1][1]).toBeCloseTo(f.s1, 9);
        for (let i = 1; i < iv.length; i++) expect(iv[i][0]).toBeCloseTo(iv[i - 1][1], 9);
      }
    });
  }

  it('sits on the texture stones: inner joints are the texture joints', () => {
    const M = masonrySpec('new');
    const u0 = 1.7, f = plane({ mat: 'new', u0 });
    const joints = new Set<string>();
    for (const c of M.courses) for (const st of c.stones) joints.add(`${c.y0.toFixed(4)}:${(((st.x0 % M.tile) + M.tile) % M.tile).toFixed(4)}`);
    let checked = 0;
    for (const s of layoutFace(f, 0)) {
      if (s.a <= f.s0 + 1e-9 || s.ya <= f.y0 + 1e-9) continue;
      const cy = (((s.ya % M.tile) + M.tile) % M.tile);
      const course = M.courses.find((c) => Math.abs(c.y0 - cy) < 1e-6);
      if (!course) continue; // upper half of a split stone
      const x = (((s.a + u0) % M.tile) + M.tile) % M.tile;
      expect(joints.has(`${course.y0.toFixed(4)}:${x.toFixed(4)}`) || joints.has(`${course.y0.toFixed(4)}:${(x === 0 ? M.tile : x).toFixed(4)}`)).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('never overlaps an opening', () => {
    const f = plane({ holes: [lancet] });
    const stones = layoutFace(f, 0);
    for (const s of stones) {
      const r = bandRange(lancet, s.ya + 1e-6, s.yb - 1e-6);
      if (r) expect(s.b <= r[0] || s.a >= r[1]).toBe(true);
    }
    // and is cut close around it (no wide bare margin)
    const beside = stones.filter((s) => s.ya > 5.5 && s.yb < 7 && s.b <= 3.5 + 1e-9);
    expect(Math.max(...beside.map((s) => s.b))).toBeGreaterThan(3.5 - 0.15);
  });

  it('also keeps out of solids standing on the face', () => {
    const stones = layoutFace(plane(), 0, [rectShape(6, 7.5, 2.6, 9)]); // a buttress
    for (const s of stones) if (s.yb > 2.65 && s.ya < 8.95) expect(s.b <= 6 || s.a >= 7.5).toBe(true);
  });

  it('interlocks at a convex corner: exactly one face reaches round it in every course', () => {
    const A = layoutFace(plane({ ends: [false, true] }), 0);
    const B = layoutFace(plane({ geom: { kind: 'plane', o: [9.3, 0, 0], r: [0, 0, -1], n: [1, 0, 0] }, s1: 6, u0: 9.3, ends: [true, false] }), 1);
    const courses = new Set(A.map((s) => s.course));
    for (const c of courses) {
      const a = A.some((s) => s.course === c && s.flags & F_EXT_R), b = B.some((s) => s.course === c && s.flags & F_EXT_L);
      expect(a !== b).toBe(true);
    }
  });

  it('is a pure function of the seed', () => {
    const f = plane({ holes: [lancet] });
    expect(JSON.stringify(layoutFace(f, 3))).toBe(JSON.stringify(layoutFace(f, 3)));
  });
});
