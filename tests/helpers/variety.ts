// Whole-castle variety measures for the furnished rooms (props-variety.test.ts): how alike two rooms of one
// role are (what stands where, seen from the doorway one walks in by; the pieces; the textile colours), and
// which quarters of a room's floor have nothing in or near them.
import { pointInPoly, type V2 } from '../../src/core/math2d';
import type { InteriorPlan, RoomSpec } from '../../src/castle/interior/types';
import { flat, wallsOf, type RoomDressing } from '../../src/props/dress';
import type { Placed } from '../../src/props/place';
import type { WindowFace } from '../../src/castle/interior/shell';
import { centroidOf, orient } from '../../src/castle/interior/geom';

/** Not part of a room's furnishing: shutters come with the windows. */
const OWN = (name: string) => name !== 'shutter';

/** Distance from a point to the nearest wall of the room, and which walls are that close. */
function wallsNear(poly: V2[], p: V2, d: number) {
  const out: V2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (L * L)));
    if (Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz) <= d) out.push([dx / L, dz / L]);
  }
  return out;
}

/**
 * Where a piece stands in its room, as a person reads it: hung on a wall, standing on another piece, in a
 * corner, against a wall with a window, against a plain wall, in the middle of the room, or free elsewhere.
 */
export function anchorOf(p: Placed, r: RoomSpec, windows: readonly WindowFace[]): string {
  if (p.prop.kind.placement !== 'floor') return 'hung';
  if (p.at[1] > r.y0 + 0.05) return 'on';
  const poly = orient(r.poly), b = p.prop.bounds, cs = Math.cos(p.yaw), sn = Math.sin(p.yaw);
  const corners: V2[] = [[b.min[0], b.min[2]], [b.max[0], b.min[2]], [b.max[0], b.max[2]], [b.min[0], b.max[2]]].map(([x, z]) => [p.at[0] + cs * x + sn * z, p.at[2] - sn * x + cs * z]);
  const near = corners.flatMap((q) => wallsNear(poly, q, 0.2));
  if (near.length) {
    const dirs: V2[] = [];
    for (const t of near) if (!dirs.some((u) => Math.abs(u[0] * t[0] + u[1] * t[1]) > 0.9)) dirs.push(t);
    if (dirs.length > 1) return 'corner';
    const back: V2 = [p.at[0], p.at[2]];
    return windows.some((w) => w.room === r.id && Math.abs((back[0] - w.c[0]) * w.n[0] + (back[1] - w.c[1]) * w.n[1]) < 1.2 && Math.abs((back[0] - w.c[0]) * w.t[0] + (back[1] - w.c[1]) * w.t[1]) < w.w / 2 + 0.8) ? 'window' : 'wall';
  }
  const c = centroidOf(poly);
  return Math.hypot(p.at[0] - c[0], p.at[2] - c[1]) < 1.2 ? 'centre' : 'free';
}

/**
 * A room as a multiset of tokens, what a person takes in from the doorway: every piece as kind@anchor
 * (anchorOf), and every textile's colour (the toned props' tone) as tone:n.
 */
export function layoutTokens(d: RoomDressing, r: RoomSpec, windows: readonly WindowFace[], tone: (seed: number) => number, toned: ReadonlySet<string>): Map<string, number> {
  const out = new Map<string, number>(), add = (k: string) => out.set(k, (out.get(k) ?? 0) + 1);
  for (const p of d.placed) {
    if (!OWN(p.prop.kind.name)) continue;
    add(`${p.prop.kind.name}@${anchorOf(p, r, windows)}`);
    if (toned.has(p.prop.kind.name)) add(`tone:${tone(p.prop.seed)}`);
  }
  return out;
}

/** Weighted Jaccard of two token multisets: 1 the same room, 0 nothing in common. */
export function similarity(a: Map<string, number>, b: Map<string, number>): number {
  let lo = 0, hi = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) { const x = a.get(k) ?? 0, y = b.get(k) ?? 0; lo += Math.min(x, y); hi += Math.max(x, y); }
  return hi ? lo / hi : 1;
}

/** Pairwise similarity within each role (roles with two rooms or more): the mean and the most alike pair. */
export function roleSimilarity(rooms: { role: string; room: string; tokens: Map<string, number> }[]) {
  const by = new Map<string, typeof rooms>();
  for (const x of rooms) by.set(x.role, [...(by.get(x.role) ?? []), x]);
  const out: { role: string; n: number; mean: number; max: number; pair: string }[] = [];
  for (const [role, xs] of by) {
    if (xs.length < 2) continue;
    let sum = 0, k = 0, max = 0, pair = '';
    for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
      const s = similarity(xs[i].tokens, xs[j].tokens);
      sum += s; k++;
      if (s > max) { max = s; pair = `${xs[i].room}~${xs[j].room}`; }
    }
    out.push({ role, n: xs.length, mean: sum / k, max, pair });
  }
  return out.sort((a, b) => b.mean - a.mean);
}

/**
 * The quarters of a room's floor (split at its centroid along its longest wall and across it) with no
 * piece in them or within `reach` of them. A quarter with less than `minArea` m² of floor is not counted.
 */
export function emptyQuarters(d: RoomDressing, r: RoomSpec, P: InteriorPlan, reach = 0.6, minArea = 1.5): number[] {
  const poly = orient(r.poly), c = centroidOf(poly), w = [...wallsOf(r, P)].sort((a, b) => b.L - a.L)[0];
  const u: V2 = [(w.b[0] - w.a[0]) / w.L, (w.b[1] - w.a[1]) / w.L], v: V2 = [-u[1], u[0]];
  const quarter = (p: V2) => (((p[0] - c[0]) * u[0] + (p[1] - c[1]) * u[1] >= 0 ? 1 : 0) + ((p[0] - c[0]) * v[0] + (p[1] - c[1]) * v[1] >= 0 ? 2 : 0));
  const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]), cell = 0.25;
  const cells: V2[][] = [[], [], [], []];
  for (let x = Math.min(...xs) + cell / 2; x < Math.max(...xs); x += cell) for (let z = Math.min(...zs) + cell / 2; z < Math.max(...zs); z += cell) if (pointInPoly(poly, x, z)) cells[quarter([x, z])].push([x, z]);
  // what is in the room: footprint corners and centres of standing pieces, rugs, things hung on the walls
  const marks: V2[] = [];
  for (const p of d.placed) {
    if (!OWN(p.prop.kind.name)) continue;
    marks.push([p.at[0], p.at[2]]);
    if (p.prop.kind.placement === 'floor' && !flat(p.prop)) {
      const b = p.prop.bounds, cs = Math.cos(p.yaw), sn = Math.sin(p.yaw);
      for (const [lx, lz] of [[b.min[0], b.min[2]], [b.max[0], b.min[2]], [b.max[0], b.max[2]], [b.min[0], b.max[2]]]) marks.push([p.at[0] + cs * lx + sn * lz, p.at[2] - sn * lx + cs * lz]);
    }
  }
  const empty: number[] = [];
  for (let q = 0; q < 4; q++) {
    if (cells[q].length * cell * cell < minArea) continue;
    if (!cells[q].some((g) => marks.some((m) => Math.hypot(m[0] - g[0], m[1] - g[1]) <= reach))) empty.push(q);
  }
  return empty;
}
