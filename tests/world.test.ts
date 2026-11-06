// The whole castle from the seed, every opening checked together (Anders: "why do we keep repeating the
// same kind of bug?"). Doors and the gate are the interior plan's DoorSpecs; windows and slits castle.ts's
// openings, placed by openings.ts around the doors of their face. A door is cut through the castle once,
// by its own carve, with the outlines its reveal and leaf follow (doorGeom doorOutlines). Invariants:
// - one owner per hole: no castle window or arch cuts into a doorway, and no two doors' cuts overlap;
// - every doorway is open: no castle surface is left in it, 1 cm inside its outline, through the wall;
// - the castle's hole is the reveal's outline: 1 cm outside it the castle face is still there, so centre,
//   width, height and head match within 1 cm;
// - an outdoor door lies on one face with its rebate, CLEAR from the face's ends and corners, with open
//   air FRONT deep in front of it, CLEAR wider either side (not jammed against a tower), as windows are;
// - an indoor door opens fully into the rooms on both sides (no junction through its jambs or rebate);
// - every leaf, from shut to fully open, stays in its doorway or its room, under the ceiling, off the
//   stair treads and out of every other leaf's sweep.
import { describe, it, expect, beforeAll } from 'vitest';
import type { WallRecord, Builder } from '../src/castle/builder';
import { buildInterior } from '../src/castle/interior';
import { stairOpts, type PlanX } from '../src/castle/interior/plan';
import { placeLeaves, leafPoint, leafDepth, m4swing, headRise, LIP, type LeafPlace } from '../src/castle/interior/doorGeom';
import { archOutline } from '../src/castle/interior/geom';
import { at } from '../src/castle/builder';
import { heightAt } from '../src/world/terrain';
import { mats, islandCastle } from './world';
import { planStair, spiralNosingY, type SpiralPlan } from '../src/castle/interior/stairs';
import type { DoorSpec } from '../src/castle/interior/types';
import { masses, convexOverlap, CLEAR, FRONT, type Mass } from '../src/castle/openings';
import { pointInPoly, type V2 } from '../src/core/math2d';
import { bakeInteriorLight, createInteriorLight } from '../src/render/interiorLight';
import type { WindowInput } from '../src/render/interiorMath';
import { createVisibility } from '../src/world/visibility';
import { outerFootprint } from '../src/castle/interior/plan';
import { courtyard, stairTowerPoly } from '../src/castle/layout';
import { StoneSet } from '../src/castle/stones/set';

type V3 = [number, number, number];
const OUTDOOR = new Set(['courtyard', 'outside']);
/** Plan point at (across, through) of a door: along its wall and along its normal. */
const on = (d: DoorSpec, across: number, through: number): V2 => [d.centre[0] + d.along[0] * across + d.normal[0] * through, d.centre[2] + d.along[1] * across + d.normal[1] * through];
const leafy = (d: DoorSpec) => d.leaf && d.kind !== 'gate';
const bbox = (pts: V2[]) => ({ s0: Math.min(...pts.map((p) => p[0])), s1: Math.max(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), y1: Math.max(...pts.map((p) => p[1])) });
/** The castle's triangles (after the interior's carve), each with its bounding box. */
interface Tri { a: V3; b: V3; c: V3; lo: V3; hi: V3 }
function trianglesOf(B: Builder): Tri[] {
  const out: Tri[] = [];
  for (const bin of Object.values(B.bins) as { pos: number[] }[]) for (let i = 0; i < bin.pos.length; i += 9) {
    const a = bin.pos.slice(i, i + 3) as V3, b = bin.pos.slice(i + 3, i + 6) as V3, c = bin.pos.slice(i + 6, i + 9) as V3;
    out.push({ a, b, c, lo: [0, 1, 2].map((k) => Math.min(a[k], b[k], c[k])) as V3, hi: [0, 1, 2].map((k) => Math.max(a[k], b[k], c[k])) as V3 });
  }
  return out;
}
/** Does the segment o → o + d cross the triangle? */
function crosses(o: V3, d: V3, t: Tri): boolean {
  const e1 = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]], e2 = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]];
  const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-12) return false;
  const s = [o[0] - t.a[0], o[1] - t.a[1], o[2] - t.a[2]], u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
  if (u < 0 || u > 1) return false;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]], v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
  if (v < 0 || u + v > 1) return false;
  const r = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
  return r >= 0 && r <= 1;
}
/** A door's clear outline grown (g > 0) or shrunk (g < 0) by about g: the head's rise and the jambs move by g. */
function outlineGrown(P: PlanX, d: DoorSpec, g: number): V2[] {
  const rise = leafy(d) ? headRise(d.head, d.width) : P.rise[d.id] ?? headRise(d.head, d.width);
  return archOutline(0, d.centre[1], d.width + 2 * g, d.height + (d.head === 'flat' ? g : 0), d.head, d.head === 'flat' ? 0 : rise + g);
}
/** Where a line through the door, at across u and height y, crosses a wall face: (s, y, depth from the mid-plane) or null. */
function crossing(w: WallRecord, d: DoorSpec, u: number, y: number) {
  const dn = d.normal[0] * w.out[0] + d.normal[1] * w.out[1];
  if (Math.abs(dn) < 0.5 || y < w.y0 || y > w.y1) return null;
  const p0 = on(d, u, 0), t = -((p0[0] - w.a[0]) * w.out[0] + (p0[1] - w.a[1]) * w.out[1]) / dn;
  if (Math.abs(t) > d.wall / 2 + 0.02) return null;
  const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]), p = on(d, u, t);
  const s = ((p[0] - w.a[0]) * (w.b[0] - w.a[0]) + (p[1] - w.a[1]) * (w.b[1] - w.a[1])) / L;
  return s > 0.02 && s < L - 0.02 ? { s, t, L } : null;
}
/** Does a wall face end at a corner (a turn sharper than a polygonal tower's 45° facets) or at nothing (a junction)? */
function endIsCorner(walls: WallRecord[], w: WallRecord, end: V2): boolean {
  const e: V2 = [w.b[0] - w.a[0], w.b[1] - w.a[1]], L = Math.hypot(e[0], e[1]);
  return !walls.some((v) => {
    if (v === w || v.y1 < w.y0 || v.y0 > w.y1) return false;
    if (Math.hypot(v.a[0] - end[0], v.a[1] - end[1]) > 0.02 && Math.hypot(v.b[0] - end[0], v.b[1] - end[1]) > 0.02) return false;
    const f: V2 = [v.b[0] - v.a[0], v.b[1] - v.a[1]];
    return Math.abs(e[0] * f[0] + e[1] * f[1]) / (L * Math.hypot(f[0], f[1])) > Math.cos((50 * Math.PI) / 180);
  });
}
/** Is a point inside another leaf's sweep (the sector its board passes through from shut to fully open)? */
function inSweep(q: V3, L: LeafPlace): boolean {
  const dx = q[0] - L.pivot[0], dz = q[2] - L.pivot[2];
  const x = dx * L.eU[0] + dz * L.eU[1], z = dx * L.eV[0] + dz * L.eV[1], a = Math.atan2(z, x);
  return q[1] > L.pivot[1] - 0.05 && q[1] < L.pivot[1] + L.height + 0.05 && Math.hypot(x, z) < L.width + 0.05 && a > -0.15 && a < L.maxAngle + 0.15;
}

function openingFaults(walls: WallRecord[], P: PlanX, M: Mass[], tris: Tri[]): string[] {
  const bad: string[] = [];
  const rooms = new Map(P.rooms.map((r) => [r.id, r]));
  // 1. no two of the castle's holes in a face overlap
  walls.forEach((w, i) => w.openings.forEach((a, j) => w.openings.slice(j + 1).forEach((b) => {
    const A = bbox(a.pts), B = bbox(b.pts);
    if (A.s0 < B.s1 - 0.01 && B.s0 < A.s1 - 0.01 && A.y0 < B.y1 - 0.01 && B.y0 < A.y1 - 0.01) bad.push(`castle wall ${i}: two openings overlap`);
  })));
  // each door's cut (its plan box through the wall, with the rebate) and each castle opening's (its face box, its depth in)
  const cut = (d: DoorSpec) => {
    const hw = d.width / 2 + (leafy(d) ? LIP : 0) - 0.01, ht = d.wall / 2 - 0.01, top = outlineGrown(P, d, leafy(d) ? LIP : 0);
    return { foot: [on(d, -hw, -ht), on(d, hw, -ht), on(d, hw, ht), on(d, -hw, ht)], y0: d.centre[1], y1: bbox(top).y1 };
  };
  const doorCuts = P.doors.map((d) => ({ d, ...cut(d) }));
  walls.forEach((w, i) => w.openings.forEach((o, j) => {
    const b = bbox(o.pts), foot = [[b.s0 + 0.01, -0.01], [b.s1 - 0.01, -0.01], [b.s1 - 0.01, -o.depth + 0.01], [b.s0 + 0.01, -o.depth + 0.01]].map(([s, dd]) => { const p = at(w.frame, s, 0, dd); return [p[0], p[2]] as V2; });
    for (const c of doorCuts) if (b.y0 < c.y1 && c.y0 < b.y1 && convexOverlap(foot, c.foot)) bad.push(`cut twice: castle wall ${i} opening ${j} and ${c.d.id}`);
  }));
  doorCuts.forEach((a, i) => doorCuts.slice(i + 1).forEach((b) => {
    if (a.y0 < b.y1 && b.y0 < a.y1 && convexOverlap(a.foot, b.foot)) bad.push(`cut twice: ${a.d.id} and ${b.d.id}`);
  }));
  for (const d of P.doors) {
    const yMid = d.centre[1] + Math.min(1.2, d.height / 2);
    const near = tris.filter((t) => t.hi[1] > d.centre[1] && t.lo[1] < d.centre[1] + d.height + d.width && Math.hypot((t.lo[0] + t.hi[0]) / 2 - d.centre[0], (t.lo[2] + t.hi[2]) / 2 - d.centre[2]) < d.width + d.wall + Math.hypot(t.hi[0] - t.lo[0], t.hi[2] - t.lo[2]) / 2 + 1);
    const ray = (u: number, y: number, t0: number, t1: number) => {
      const p = on(d, u, t0), q = on(d, u, t1), o: V3 = [p[0], y, p[1]], dir: V3 = [q[0] - p[0], 0, q[1] - p[1]];
      return near.some((t) => t.hi[1] >= y && t.lo[1] <= y && crosses(o, dir, t));
    };
    // 2. the doorway is open: 1 cm inside its clear outline nothing of the castle is left, wall face to wall face
    const inner = outlineGrown(P, d, -0.01);
    for (const [u, y] of [...inner.slice(2), [0, d.centre[1] + 0.3] as V2, [0, d.centre[1] + 1.2] as V2]) {
      if (ray(u, Math.max(y, d.centre[1] + 0.05), -d.wall / 2 - 0.05, d.wall / 2 + 0.05)) { bad.push(`${d.id}: castle surface left in the doorway at (${u.toFixed(2)}, ${(y - d.centre[1]).toFixed(2)})`); break; }
    }
    // 3. on an outdoor face the castle's hole is the reveal's outline: 1 cm outside it the face is still there
    const k = d.spaces.findIndex((s) => OUTDOOR.has(s));
    if (k >= 0) {
      const sg = k === 0 ? -1 : 1, grow = leafy(d) && sg === (d.swingInto === 1 ? 1 : -1) ? LIP : 0;
      for (const [u, y] of outlineGrown(P, d, grow + 0.01).slice(2)) {
        if (!ray(u, y, sg * (d.wall / 2 + 0.15), sg * (d.wall / 2 - 0.15))) { bad.push(`${d.id}: its hole in the castle face is bigger than its outline at (${u.toFixed(2)}, ${(y - d.centre[1]).toFixed(2)})`); break; }
      }
    }
    // 5. indoor sides: both jambs with their rebate open into the room (no junction through the doorway)
    for (const k of [0, 1]) {
      const r = rooms.get(d.spaces[k]), sg = k === 0 ? -1 : 1;
      if (!r || r.zone === 'tunnel') continue; // a tunnel ends in its door
      for (const s of [-1, 1]) {
        const p = on(d, s * (d.width / 2 + LIP), sg * (d.wall / 2 + 0.3));
        if (!pointInPoly(r.poly, p[0], p[1])) bad.push(`${d.id}: jamb ${s > 0 ? '+' : '-'} not in ${r.id} (a junction in the doorway)`);
      }
    }
    // 6. outdoor side: on one face, CLEAR from its ends and corners, open air in front
    if (k < 0) continue;
    const sg = k === 0 ? -1 : 1, hw = d.width / 2 + (leafy(d) ? LIP : 0);
    const own = M.find((m) => pointInPoly(m.poly, ...on(d, 0, -sg * 0.3)));
    const front = [[-hw - CLEAR, 0.02], [hw + CLEAR, 0.02], [hw + CLEAR, FRONT], [-hw - CLEAR, FRONT]].map(([a, t]) => on(d, a, sg * (d.wall / 2 + t)));
    for (const m of M) if (m !== own && m.top > d.centre[1] && convexOverlap(front, m.poly)) bad.push(`${d.id}: jammed against ${m.id} (within ${FRONT} m in front, ${CLEAR} m either side)`);
    const faces = walls.map((w) => ({ w, x: crossing(w, d, 0, yMid) })).filter((f) => f.x && f.x.t * sg > d.wall / 2 - 0.05);
    if (faces.length !== 1) { bad.push(`${d.id}: on ${faces.length} outdoor wall faces`); continue; }
    const { w, x } = faces[0];
    if (Math.abs(Math.abs(x!.t) - d.wall / 2) > 0.01) bad.push(`${d.id}: its reveal ends ${Math.abs(Math.abs(x!.t) - d.wall / 2).toFixed(3)} m off the castle face`);
    const need = (end: V2) => (endIsCorner(walls, w, end) ? CLEAR : 0.05);
    if (x!.s - hw < need(w.a) - 1e-6) bad.push(`${d.id}: ${(x!.s - hw).toFixed(2)} m from the end of its face (needs ${need(w.a)})`);
    if (x!.L - x!.s - hw < need(w.b) - 1e-6) bad.push(`${d.id}: ${(x!.L - x!.s - hw).toFixed(2)} m from the end of its face (needs ${need(w.b)})`);
  }
  // 7. leaves: the whole swing in the doorway or its room, under the ceiling, off the treads, clear of other leaves
  const leaves = P.doors.flatMap((d) => placeLeaves(d).map((pl) => ({ d, pl })));
  const spirals = P.stairs.filter((s) => s.kind === 'spiral').map((s) => planStair(s, stairOpts(P, s)) as SpiralPlan);
  for (const { d, pl } of leaves) {
    const into = d.spaces[d.swingInto], r = rooms.get(into);
    if (!r) { bad.push(`${d.id}: swings out into ${into}`); continue; }
    if (pl.pivot[1] + pl.height > r.y1 - 0.02) bad.push(`${d.id}: leaf top above the ceiling of ${r.id}`);
    const faults = new Set<string>(), { zBack } = leafDepth(pl.kind);
    for (let i = 0; i <= 24; i++) for (let k = 0; k <= 8; k++) for (const y of [0, pl.height / 2, pl.height - 0.02]) for (const z of [zBack, 0]) {
      const q = leafPoint(pl, m4swing((pl.maxAngle * i) / 24), [(pl.width * k) / 8, y, z]);
      const dx = q[0] - d.centre[0], dz = q[2] - d.centre[2];
      const across = dx * d.along[0] + dz * d.along[1], through = dx * d.normal[0] + dz * d.normal[1];
      // in the doorway or its rebate (a curved or skewed room face lies up to 0.15 m beyond the wall face at the centre)
      const inDoor = Math.abs(across) <= d.width / 2 + LIP + 1e-3 && Math.abs(through) <= d.wall / 2 + 0.15;
      if (!inDoor && !pointInPoly(r.poly, q[0], q[2])) faults.add(`${d.id}: leaf swings through the wall of ${r.id}`);
      for (const sp of spirals) {
        const ex = q[0] - sp.c[0], ez = q[2] - sp.c[1], rr = Math.hypot(ex, ez);
        if (rr < sp.rn || rr > sp.R) continue;
        const T = Math.PI * 2, prog0 = (Math.atan2(ez, ex) - sp.theta0) * sp.dir;
        for (const st of sp.steps) {
          const prog = prog0 + Math.round((st.a0 - prog0) / T) * T;
          if (prog < st.a0 || prog > st.a1) continue;
          // each step is a stone from its tread down to its soffit, or to the floor when built solid
          const under = st.solid ? sp.yFloor - 1 : spiralNosingY(sp, prog) - sp.T;
          if (q[1] < st.y - 0.01 && q[1] > under + 0.01) faults.add(`${d.id}: leaf swings into the steps of ${sp.id}`);
        }
      }
      for (const o of leaves) if (o.d !== d && inSweep(q, o.pl)) faults.add(`${d.id}: leaf swings into the leaf of ${o.d.id}`);
    }
    bad.push(...faults);
  }
  return bad;
}

describe('every opening in the castle: one owner, one outline, room to open', () => {
  let walls: WallRecord[], P: PlanX, tris: Tri[], B: Builder, inner: ReturnType<typeof buildInterior>, lights: WindowInput[];
  beforeAll(() => {
    const isl = islandCastle(); // the castle as main.ts lays it, cut by the interior as main.ts does
    B = isl.builder; lights = isl.lights as WindowInput[];
    inner = buildInterior(mats(), B, { heightAt });
    P = inner.plan;
    walls = B.walls; tris = trianglesOf(B);
  }, 300_000);

  it('checks every castle wall, window and plan door', () => {
    expect(walls.filter((w) => w.openings.length).length).toBeGreaterThan(20);
    expect(P.doors.filter((d) => d.spaces.some((s) => OUTDOOR.has(s))).length).toBeGreaterThanOrEqual(5);
    expect(tris.length).toBeGreaterThan(10_000);
  });

  it('holds every invariant', () => {
    expect(openingFaults(walls, P, masses(), tris)).toEqual([]);
  }, 120_000);

  it('reports what it is for', () => {
    // a door slid into the stair tower's corner of the north wing, a window over the stair door, a slab left in
    // the east door, the west door's hole cut too big, and a leaf hung so it opens into the side wall
    const Q = structuredClone(P), id = (x: string) => Q.doors.find((d) => d.id === x)!;
    const n = id('court>N0-4'), st = id('court>stairtower'), e = id('court>E0-2'), w = id('court>W0-2');
    const lean = (n.centre[0] - st.centre[0]) * n.along[0] + (n.centre[2] - st.centre[2]) * n.along[1];
    n.centre[0] -= n.along[0] * (lean - 1.0); n.centre[2] -= n.along[1] * (lean - 1.0);
    id('N0-2>N0-3').hinge = id('N0-2>N0-3').hinge === 'left' ? 'right' : 'left';
    const k = walls.findIndex((x) => crossing(x, st, 0, st.centre[1] + 1)), x = crossing(walls[k], st, 0, st.centre[1] + 1)!;
    const twin = walls.map((v, i) => (i === k ? { ...v, openings: [...v.openings, { pts: [[x.s - 0.3, st.centre[1] + 1], [x.s + 0.3, st.centre[1] + 1], [x.s + 0.3, st.centre[1] + 1.5], [x.s - 0.3, st.centre[1] + 1.5]] as V2[], depth: 0.5, fill: 'wood' as const, reveal: 'trim' as const }] } : v));
    const slab = (a: V3, b: V3, c: V3): Tri => ({ a, b, c, lo: [0, 1, 2].map((j) => Math.min(a[j], b[j], c[j])) as V3, hi: [0, 1, 2].map((j) => Math.max(a[j], b[j], c[j])) as V3 });
    const [p, q] = [on(e, -1, 0), on(e, 1, 0)];
    const broken = [...tris.filter((t) => Math.hypot(t.lo[0] - w.centre[0], t.lo[2] - w.centre[2]) > 1.5 && Math.hypot(t.hi[0] - w.centre[0], t.hi[2] - w.centre[2]) > 1.5), slab([p[0], e.centre[1], p[1]], [q[0], e.centre[1], q[1]], [p[0], e.centre[1] + 3, p[1]]), slab([q[0], e.centre[1], q[1]], [q[0], e.centre[1] + 3, q[1]], [p[0], e.centre[1] + 3, p[1]])];
    const f = openingFaults(twin, Q, masses(), broken);
    expect(f.some((x) => x.startsWith('court>N0-4: jammed against stairtower'))).toBe(true);
    expect(f.some((x) => x.startsWith('cut twice:') && x.endsWith('court>stairtower'))).toBe(true);
    expect(f.some((x) => x.startsWith('court>E0-2: castle surface left in the doorway'))).toBe(true);
    expect(f.some((x) => x.startsWith('court>W0-2: its hole in the castle face is bigger than its outline'))).toBe(true);
    expect(f).toContain('N0-2>N0-3: leaf swings through the wall of N0-3');
  }, 120_000);

  // One model for visibility and LOD: no level of detail or cull may add, move or remove an opening or a
  // door. Culling (world/visibility.ts) works per room group; the real stones (castle/stones) are one set
  // drawn at three levels of detail. Both are checked here over the whole castle, from the poses a player has.
  it('draws every room and leaf seen through an outdoor doorway, from every pose in front of it', () => {
    const bake = bakeInteriorLight(inner.groups, { blocked: () => false }, { plan: P, windows: lights, sun: () => ({ dir: [-0.4, 0.63, 0.66], irradiance: [3, 3, 3] }), light: createInteriorLight() });
    const cam = { position: { x: 0, y: 0, z: 0 } };
    const vis = createVisibility(cam, inner.groups, P, { apertures: bake.apertures, ground: heightAt });
    const foot = outerFootprint(), court = courtyard(), tower = stairTowerPoly();
    const outdoors = (s: string, q: V2) => s === 'courtyard' ? pointInPoly(court, q[0], q[1]) && !pointInPoly(tower, q[0], q[1]) : !foot.some((f) => pointInPoly(f, q[0], q[1]));
    const faults: string[] = [];
    let poses = 0;
    for (const d of P.doors) {
      const out = d.spaces.find((s) => OUTDOOR.has(s)); if (!out) continue;
      const room = d.spaces.find((s) => s !== out)!, sgn = d.spaces[0] === out ? 1 : -1; // the normal points from spaces[0] to spaces[1]
      for (const dist of [1.5, 3, 5, 8, 12, 16, 20, 25, 30, 40, 60]) for (const side of [-4, -1.5, 0, 1.5, 4]) {
        const q = on(d, side, -sgn * (d.wall / 2 + dist));
        if (!outdoors(out, q)) continue;
        for (const h of [1.6, 0.9]) {
          cam.position = { x: q[0], y: Math.max(d.centre[1], heightAt(q[0], q[1])) + h, z: q[1] };
          const st = vis.update();
          if (st.inside) continue; // in the doorway's own embrasure: the inside rules hold there
          poses++;
          if (!vis.isRoomVisible(room)) faults.push(`${d.id}: ${room} culled from ${dist} m, ${side} m aside`);
          if (leafy(d) && !(vis.isRoomVisible(d.spaces[0]) || vis.isRoomVisible(d.spaces[1]))) faults.push(`${d.id}: leaf culled from ${dist} m`);
        }
      }
    }
    expect(poses).toBeGreaterThan(300);
    expect(faults).toEqual([]);
    // inside: every room joined to the camera's room by a door is drawn, from the middle of every room
    const shown: string[] = [];
    for (const r of P.rooms) {
      const c = r.poly.reduce((a, q) => [a[0] + q[0] / r.poly.length, a[1] + q[1] / r.poly.length], [0, 0]);
      if (!pointInPoly(r.poly, c[0], c[1])) continue;
      cam.position = { x: c[0], y: r.y0 + 1.6, z: c[1] };
      if (vis.update().room < 0 || vis.roomId !== r.id) continue;
      for (const d of P.doors) if (d.spaces.includes(r.id)) for (const s of d.spaces) if (!OUTDOOR.has(s) && s !== 'farbank' && !vis.isRoomVisible(s)) shown.push(`${r.id}: ${s} behind ${d.id} culled`);
    }
    expect(shown).toEqual([]);
  }, 120_000);

  it('lays no real stone, at any level of detail, in a doorway', () => {
    // every level draws the same stones (field.ts: hi, mid, lo and silhouette-only are one set and a draw
    // range), so a stone outside a doorway at one level is outside it at all of them
    const set = new StoneSet(B.stoneFaces, B.stoneExcl);
    const faults: string[] = [];
    for (const d of P.doors) {
      if (!d.spaces.some((s) => OUTDOOR.has(s))) continue;
      const c: V3 = [d.centre[0], d.centre[1] + d.height / 2, d.centre[2]];
      for (const s of set.stonesNear(c, Math.max(d.width, d.height) + 1)) {
        const p = s.centre, dx = p[0] - d.centre[0], dz = p[2] - d.centre[2];
        const across = dx * d.along[0] + dz * d.along[1], through = dx * d.normal[0] + dz * d.normal[1];
        if (Math.abs(across) < d.width / 2 - 0.05 && Math.abs(through) < d.wall / 2 + 0.3 && p[1] > d.centre[1] + 0.05 && p[1] < d.centre[1] + d.height - 0.3) faults.push(`${d.id}: stone at ${p.map((v) => v.toFixed(2))}`);
      }
    }
    expect(faults).toEqual([]);
  }, 120_000);
});
