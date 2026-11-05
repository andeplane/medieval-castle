// Where a window, slit or loop may sit on a flat wall face. One rule: the opening with its dressing
// (jambs, sill, voussoirs, hood) lies wholly on one face, CLEAR from the face's ends and from any other
// building in front of or against it, and V_CLEAR from floors, string courses, plinth and parapet.
// If it does not fit where planned it moves up or down within its storey to clear the bands, then slides
// along the face; if it still does not fit it is left out. Pure: castle.ts calls it, tests/openings.test.ts
// checks the result.
import { type V2, add, scale, sub, norm, dot } from '../core/math2d';
import { wingQuads, squareTowerPoly, towerCentre, gatehouseFrame, eastTurretFrame, stairTowerPoly } from './layout';
import { TOWERS, GATEHOUSE, EAST_TURRET, STAIR_TOWER } from './spec';

export const CLEAR = 0.8;    // along the face: from its ends and from other buildings
export const V_CLEAR = 0.15; // up the face: from floors, string courses, plinth and parapet
export const FRONT = 1.5;    // open air an opening needs in front of it
export const MAX_SHIFT = 1.5;

export const OPEN_W: Record<string, number> = { slit: 0.16, loop: 0.62, lancet: 1.0, twin: 1.54, rect: 1.28, round: 0.78, small: 0.62 };
export const OPEN_H: Record<string, number> = { slit: 1.5, loop: 1.7, lancet: 3.15, twin: 3.05, rect: 1.75, round: 1.64, small: 0.85 };

/** Dressed extent of an opening around its (s, sill y): half width, below the sill, above the sill. */
export interface Dressed { hw: number; below: number; above: number }
export function dressed(kind: string): Dressed {
  const w = OPEN_W[kind], h = OPEN_H[kind];
  // slits and loops: jamb stones only (0.42 long); windows: sill below, voussoirs (lancet, twin, round),
  // hood mould (rect) or lintel (small) above, and the widest of voussoirs, hood and jambs either side
  if (kind === 'slit' || kind === 'loop') return { hw: w / 2 + 0.42, below: 0, above: h };
  return { hw: w / 2 + 0.6, below: 0.2, above: h + (kind === 'small' ? 0.35 : 0.5) };
}

/** Another building that an opening must keep clear of: plan outline and the height it reaches. */
export interface Mass { id: string; poly: V2[]; top: number }
/** A flat wall face: a → b with outward normal out; bands are [y0, y1] strips to keep clear of. */
export interface Face { owner: string; a: V2; b: V2; out: V2; bands: [number, number][] }
/** An opening's dressed box on its face (along s, up y). */
export interface Box { s0: number; s1: number; y0: number; y1: number }

export const boxOf = (d: Dressed, s: number, y: number): Box => ({ s0: s - d.hw, s1: s + d.hw, y0: y - d.below, y1: y + d.above });

/** Every building mass of the castle (for the in-front test). Roof ridges and parapets count. */
export function masses(): Mass[] {
  const out: Mass[] = wingQuads().map((w) => ({ id: w.id, poly: w.quad, top: w.top + (w.roof === 'gable' ? ((w.depth - 1.9) / 2) * Math.tan((52 * Math.PI) / 180) + 0.3 : 2.5) }));
  for (const t of TOWERS) {
    const poly = t.kind === 'square' ? squareTowerPoly(t) : circle(towerCentre(t), t.r + 0.8);
    out.push({ id: t.id, poly, top: t.top + 2.5 + (t.kind === 'round' ? t.cone : 0) });
  }
  const g = gatehouseFrame(), hw = GATEHOUSE.width / 2;
  out.push({ id: 'gate', poly: rectOn(g.base, g.dir, g.out, -hw, hw, -1, GATEHOUSE.project), top: GATEHOUSE.top + 2.5 });
  const e = eastTurretFrame(), ew = EAST_TURRET.w / 2;
  out.push({ id: 'eturret', poly: rectOn(e.base, e.dir, e.out, -ew, ew, -0.5, EAST_TURRET.project), top: EAST_TURRET.top + 7 });
  out.push({ id: 'stairtower', poly: stairTowerPoly(), top: STAIR_TOWER.top + 10 });
  return out;
}

const circle = (c: V2, r: number, n = 16): V2[] => Array.from({ length: n }, (_, i) => [c[0] + Math.cos((i / n) * 2 * Math.PI) * r, c[1] + Math.sin((i / n) * 2 * Math.PI) * r] as V2);
const rectOn = (o: V2, d: V2, n: V2, s0: number, s1: number, d0: number, d1: number): V2[] =>
  [[s0, d0], [s1, d0], [s1, d1], [s0, d1]].map(([s, dd]) => add(add(o, scale(d, s)), scale(n, dd)));

/** The plan rectangle in front of a dressed box, widened by CLEAR either side. */
export function frontRect(f: Face, b: Box): V2[] {
  const d = norm(sub(f.b, f.a));
  return rectOn(f.a, d, f.out, b.s0 - CLEAR, b.s1 + CLEAR, 0.02, FRONT);
}

/** Do two convex polygons overlap (separating axis test)? */
export function convexOverlap(p: V2[], q: V2[]): boolean {
  for (const poly of [p, q]) for (let i = 0; i < poly.length; i++) {
    const e = sub(poly[(i + 1) % poly.length], poly[i]), ax: V2 = [-e[1], e[0]];
    const pr = (pts: V2[]) => pts.map((v) => dot(v, ax));
    const a = pr(p), b = pr(q);
    if (Math.max(...a) <= Math.min(...b) || Math.max(...b) <= Math.min(...a)) return false;
  }
  return true;
}

/** Does the dressed box fit at this spot: on the face, clear of other masses and taken boxes? (Bands: clampToGap.) */
export function fits(f: Face, others: Mass[], taken: Box[], b: Box): boolean {
  const L = Math.hypot(f.b[0] - f.a[0], f.b[1] - f.a[1]);
  if (b.s0 < CLEAR || b.s1 > L - CLEAR) return false;
  if (taken.some((t) => b.s0 < t.s1 && b.s1 > t.s0 && b.y0 < t.y1 && b.y1 > t.y0)) return false;
  const front = frontRect(f, b);
  return !others.some((m) => m.id !== f.owner && m.top + V_CLEAR > b.y0 && convexOverlap(front, m.poly));
}

/**
 * Place an opening planned at (s, y): first nudge it up or down to clear the bands of its storey,
 * then slide it along the face (nearest spot first, up to MAX_SHIFT). Returns null to leave it out.
 */
export function fitOpening(f: Face, others: Mass[], taken: Box[], d: Dressed, s: number, y: number, maxShift = MAX_SHIFT): { s: number; y: number } | null {
  const yy = clampToGap(f.bands, d, y);
  if (yy === null) return null;
  for (let k = 0; k * 0.05 <= maxShift + 1e-9; k++) for (const sg of k ? [1, -1] : [1]) {
    const ss = s + sg * k * 0.05;
    if (fits(f, others, taken, boxOf(d, ss, yy))) return { s: ss, y: yy };
  }
  return null;
}

/** Move y the least so the dressed box clears the bands around its middle; null when the gap is too small. */
export function clampToGap(bands: [number, number][], d: Dressed, y: number): number | null {
  const mid = y + (d.above - d.below) / 2;
  let lo = -Infinity, hi = Infinity;
  for (const [y0, y1] of bands) {
    if (y1 <= mid) lo = Math.max(lo, y1 + V_CLEAR);
    else if (y0 >= mid) hi = Math.min(hi, y0 - V_CLEAR);
    else return null; // planned across a band
  }
  const ymin = lo + d.below, ymax = hi - d.above;
  if (ymin > ymax + 1e-9) return null;
  return Math.min(Math.max(y, ymin), ymax);
}
