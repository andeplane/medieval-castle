// Every window, slit and loop lies wholly on one wall face: clear of the face's ends, of every other
// building in front of it, and of floors, string courses, plinth and parapet (castle/openings.ts).
import { describe, it, expect } from 'vitest';
import { buildCastle } from '../src/castle/castle';
import { masses, boxOf, CLEAR, V_CLEAR, FRONT } from '../src/castle/openings';
import { mulberry32 } from '../src/core/rng';
import { pointInPoly, add, scale, sub, norm, type V2 } from '../src/core/math2d';

describe('window placement', () => {
  const others = masses();
  for (const seed of ['default', 1, 2, 3, 42]) it(`seed ${seed}: every opening fits its face`, () => {
    const { openings } = seed === 'default' ? buildCastle() : buildCastle(mulberry32(seed as number));
    const placed = openings.filter((o) => o.at);
    expect(placed.length).toBeGreaterThan(openings.length * 0.6);
    const bad: string[] = [], byFace = new Map<object, ReturnType<typeof boxOf>[]>();
    for (const o of placed) {
      const f = o.face, b = boxOf(o.d, o.at!.s, o.at!.y), L = Math.hypot(f.b[0] - f.a[0], f.b[1] - f.a[1]);
      const where = `${f.owner} ${o.kind} at s ${b.s0.toFixed(2)}..${b.s1.toFixed(2)} of ${L.toFixed(2)}, y ${b.y0.toFixed(2)}..${b.y1.toFixed(2)}`;
      if (b.s0 < CLEAR - 1e-6 || b.s1 > L - CLEAR + 1e-6) bad.push(`${where}: too near the face's ends`);
      for (const [y0, y1] of f.bands) if (b.y1 > y0 - V_CLEAR + 1e-6 && b.y0 < y1 + V_CLEAR - 1e-6) bad.push(`${where}: on band ${y0.toFixed(2)}..${y1.toFixed(2)}`);
      // the ground in front of it, CLEAR wider either side, is open air up to the opening's sill
      const d = norm(sub(f.b, f.a));
      for (const m of others) {
        if (m.id === f.owner || m.top + V_CLEAR <= b.y0) continue;
        let hit = false;
        for (let s = b.s0 - CLEAR; s <= b.s1 + CLEAR + 1e-6 && !hit; s += 0.1) for (let k = 0.05; k <= FRONT && !hit; k += 0.1) {
          const p: V2 = add(add(f.a, scale(d, s)), scale(f.out, k));
          hit = pointInPoly(m.poly, p[0], p[1]);
        }
        if (hit) bad.push(`${where}: against ${m.id}`);
      }
      // and no two openings on a face overlap
      const taken = byFace.get(f) ?? [];
      if (taken.some((t) => b.s0 < t.s1 && b.s1 > t.s0 && b.y0 < t.y1 && b.y1 > t.y0)) bad.push(`${where}: overlaps another opening`);
      byFace.set(f, [...taken, b]);
    }
    expect(bad).toEqual([]);
  }, 60_000);
});
