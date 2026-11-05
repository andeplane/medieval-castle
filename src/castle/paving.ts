// Courtyard paving (pure): cobbles set in earth over the whole courtyard, with a path of flags from the
// gate passage to the N wing's courtyard door. One flat polygon in the `pave` bin (one draw call); the
// stones themselves are texture and parallax (render/materials.ts `paving`), never geometry. The
// shader reads this plan for the path strip and for how far each point is from a wall foot.
import { ShapeUtils, Vector2 } from 'three/webgpu';
import { type V2, sub, norm, dot, signedArea } from '../core/math2d';
import { rngFor } from '../core/rng';
import { GROUND } from './spec';
import { courtyard, stairTowerPoly, stairTowerCentre } from './layout';
import { planInterior } from './interior/plan';
import type { Builder } from './builder';

/** Top of the paving: where the courtyard ground was. The terrain under it is lowered (world/terrain.ts). */
export const PAVE_Y = GROUND + 0.02;
/** Metres per repeat of the cobble texture (render/texgen.ts COBBLES.tile); uvs are path-frame metres / PAVE_TILE. */
export const PAVE_TILE = 4;
/** Half the width of the flag path; FLAGS.tile (the flag texture's repeat) is the whole width. */
export const PATH_HALF = 1.0;
/** The well's outer radius (castle.ts courtyardDressing). */
export const WELL_R = 1.05;

/** The well's centre: a little west of the middle of the courtyard (seeded, so it never lands on the path). */
export function wellCentre(): V2 {
  const ct = courtyard(), r = rngFor('court-well');
  const m: V2 = [(ct[0][0] + ct[2][0]) / 2, (ct[0][1] + ct[2][1]) / 2];
  return [m[0] - 3.5 + r(), m[1] + 2 + r()];
}

export interface PavingPlan {
  /** Outline (the courtyard faces of the four wings) and holes (stair tower, well). */
  poly: V2[]; holes: V2[][];
  /** The flag path: a strip through `o` along `dir` (unit), PATH_HALF either side. */
  path: { o: V2; dir: V2; hw: number };
  /** Wall feet: the outline's edges, and round obstacles (stair tower, well) as circles. */
  walls: [V2, V2][]; rounds: { c: V2; r: number }[];
}

/** The plan, from the interior plan's courtyard doors (gate passage → the N wing). */
export function pavingPlan(doors = planInterior().doors): PavingPlan {
  const at = (id: string): V2 => { const d = doors.find((x) => x.id === id); if (!d) throw new Error(`paving: no door ${id}`); return [d.centre[0], d.centre[2]]; };
  const a = at('gate-court'), b = at(doors.find((d) => d.id.startsWith('court>N'))?.id ?? 'court>N');
  const poly = courtyard(), st = stairTowerPoly(), wc = wellCentre();
  const well = Array.from({ length: 20 }, (_, i) => [wc[0] + Math.cos((i / 20) * Math.PI * 2) * WELL_R * 0.98, wc[1] + Math.sin((i / 20) * Math.PI * 2) * WELL_R * 0.98] as V2);
  const sc = stairTowerCentre(), sr = Math.hypot(st[0][0] - sc[0], st[0][1] - sc[1]);
  return {
    poly, holes: [st, well],
    path: { o: a, dir: norm(sub(b, a)), hw: PATH_HALF },
    walls: poly.map((p, i) => [p, poly[(i + 1) % poly.length]] as [V2, V2]),
    rounds: [{ c: sc, r: sr * Math.cos(Math.PI / st.length) }, { c: wc, r: WELL_R }],
  };
}

/** Path frame of a point: metres along the path from its origin and across it (signed, + to the left). */
export function pathFrame(P: PavingPlan['path'], x: number, z: number): [number, number] {
  const d = sub([x, z], P.o);
  return [dot(d, P.dir), d[0] * -P.dir[1] + d[1] * P.dir[0]];
}
/** Texture coordinates of a point: path frame / PAVE_TILE, v = 0 on the path's right edge, so the flags
 *  (whose texture repeats once across the path) meet the cobbles on a joint on both sides. */
export function pavingUV(P: PavingPlan['path'], x: number, z: number): [number, number] {
  const [s, t] = pathFrame(P, x, z);
  return [s / PAVE_TILE, (t + P.hw) / PAVE_TILE];
}
const segDist = (p: V2, a: V2, b: V2) => {
  const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t);
};
/** Distance (m) from a point to the nearest wall foot: the courtyard faces, the stair tower and the well. */
export function wallDistance(P: PavingPlan, x: number, z: number) {
  let d = Infinity;
  for (const [a, b] of P.walls) d = Math.min(d, segDist([x, z], a, b));
  for (const c of P.rounds) d = Math.min(d, Math.hypot(x - c.c[0], z - c.c[1]) - c.r);
  return Math.max(0, d);
}

/** Keep the part of a polygon where (p − a) · n ≤ 0 (Sutherland–Hodgman against one line). */
function clipHalf(poly: V2[], a: V2, n: V2): V2[] {
  const out: V2[] = [], f = (p: V2) => (p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], fp = f(p), fq = f(q);
    if (fp <= 0) out.push(p);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) { const t = fp / (fp - fq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  }
  return out;
}
/**
 * A convex polygon minus a convex hole, as convex pieces: for each edge of the hole, what lies outside
 * that edge and inside all the edges before it. Works whether the hole is inside the polygon (the well)
 * or crosses its outline (the stair tower stands in the courtyard's corner, half in the wings).
 */
export function cutConvex(poly: V2[], hole: V2[]): V2[][] {
  const h = signedArea(hole) >= 0 ? hole : [...hole].reverse(), pieces: V2[][] = [];
  let rest = poly;
  for (let i = 0; i < h.length && rest.length >= 3; i++) {
    const a = h[i], b = h[(i + 1) % h.length], n: V2 = [b[1] - a[1], -(b[0] - a[0])]; // outward for a ccw hole
    const piece = clipHalf(rest, a, [-n[0], -n[1]]);
    if (piece.length >= 3 && Math.abs(signedArea(piece)) > 1e-6) pieces.push(piece);
    rest = clipHalf(rest, a, n);
  }
  return pieces;
}

/** Lay the paving into the builder's `pave` bin: the courtyard less the holes, flat and facing up, uvs in
 *  the path frame. Returns the triangle count. */
export function buildPaving(B: Builder, P: PavingPlan = pavingPlan()) {
  let pieces = [P.poly];
  for (const h of P.holes) pieces = pieces.flatMap((p) => cutConvex(p, h));
  let n = 0;
  for (const piece of pieces) {
    const tris = ShapeUtils.triangulateShape(piece.map((q) => new Vector2(q[0], q[1])), []);
    for (const [i, j, k] of tris) {
      const q = [piece[i], piece[j], piece[k]];
      B.bins.pave.tri([q[0][0], PAVE_Y, q[0][1]], [q[1][0], PAVE_Y, q[1][1]], [q[2][0], PAVE_Y, q[2][1]], [0, 1, 0],
        pavingUV(P.path, q[0][0], q[0][1]), pavingUV(P.path, q[1][0], q[1][1]), pavingUV(P.path, q[2][0], q[2][1]));
      n++;
    }
  }
  return n;
}
