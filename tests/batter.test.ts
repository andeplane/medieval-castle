// Whole-castle rule for battered plinths: a batter leans out into the open, never into a neighbouring
// wing, the courtyard or the courtyard stair tower. (2026-11-06: each wing's batter also ran down its two
// mitred ends, 1.1 m into the next wing; the stair tower's shaft, carved through the NE inner corner,
// showed it as a leaning strip beside the N wing.) Corner towers, the east turret and the gatehouse
// stand over the wings, so their own batters may run under a wing within their batter's width.
import { describe, it, expect } from 'vitest';
import { buildCastle } from '../src/castle/castle';
import { offsetPoly, type Builder } from '../src/castle/builder';
import { wingQuads, courtyard, stairTowerPoly, footprints } from '../src/castle/layout';
import { pointInPoly, type V2 } from '../src/core/math2d';
import { GROUND } from '../src/castle/spec';

/** Sloped masonry triangles (a batter's face: neither a wall nor a floor) whose centre lies in `zones`. */
function batterIntrusions(B: Builder, zones: { id: string; poly: V2[] }[], allow: V2[][]) {
  const out: { zone: string; at: [number, number, number] }[] = [];
  for (const k of ['old', 'new'] as const) {
    const p = B.bins[k].pos;
    for (let i = 0; i < p.length; i += 9) {
      const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
      const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-9) continue;
      const slope = Math.abs(ny) / nl;
      if (slope < 0.1 || slope > 0.5) continue; // batters slope 1 in 3 to 1 in 5
      // sample the triangle (not just its centre: a long batter face reaches far from its centre)
      for (let a = 0; a <= 8; a++) for (let b = 0; a + b <= 8; b++) {
        const c: [number, number, number] = [p[i] + (ux * a + vx * b) / 8, p[i + 1] + (uy * a + vy * b) / 8, p[i + 2] + (uz * a + vz * b) / 8];
        if (c[1] > GROUND + 4) continue; // plinth height; roofs and weatherings above are not batters
        if (allow.some((q) => pointInPoly(q, c[0], c[2]))) continue;
        const z = zones.find((zn) => pointInPoly(zn.poly, c[0], c[2]));
        if (z) { out.push({ zone: z.id, at: c }); break; }
      }
    }
  }
  return out;
}

describe('battered plinths', () => {
  const { builder } = buildCastle();
  const zones = [
    ...wingQuads().map((w) => ({ id: `wing ${w.id}`, poly: offsetPoly(w.quad, -0.05) })),
    { id: 'courtyard', poly: offsetPoly(courtyard(), -0.05) },
    { id: 'stair tower', poly: stairTowerPoly() },
  ];
  // every footprint but the outer castle outline (towers, gatehouse, east turret), grown by its batter
  const allow = footprints().slice(1).map((f) => offsetPoly(f, 1.6));

  it('lean out into the open, never into another wing, the courtyard or the stair tower', () => {
    const bad = batterIntrusions(builder, zones, allow);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('finds a batter that leans into a wing', () => {
    const B = buildCastle().builder, w = wingQuads()[0], q = offsetPoly(w.quad, -2);
    B.loft('old', offsetPoly(q, 1.1), GROUND - 1.6, q, GROUND + 2.6);
    const bad = batterIntrusions(B, zones, allow);
    expect(bad.length).toBeGreaterThan(0);
    expect(bad.every((b) => b.zone === 'wing N')).toBe(true);
  });
});
