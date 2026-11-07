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
//   stair treads and out of every other leaf's sweep;
// - a round tower's spiral takes its light through real slits (openings.ts stairSlits): open from outside
//   into the stairwell, the embrasure behind each clear of every step stone, off the doors and the drum's
//   other openings, and every such spiral has some.
// - no reveal triangle spans the wall's mid-plane: the interior light gives each triangle the room nearest
//   its centre, so a soffit quad from face to face lit its two halves from the two rooms (saw teeth round
//   the gate-inner head, 2026-11-06).
import { describe, it, expect, beforeAll } from 'vitest';
import type { WallRecord, Builder, CurvedRecord } from '../src/castle/builder';
import * as THREE from 'three/webgpu';
import type { InteriorGroup } from '../src/castle/interior/types';
import { nicheSplay } from '../src/castle/interior/shell';
import { buildInterior } from '../src/castle/interior';
import { stairOpts, type PlanX } from '../src/castle/interior/plan';
import { placeLeaves, leafPoint, leafDepth, m4swing, headRise, LIP, type LeafPlace } from '../src/castle/interior/doorGeom';
import { archOutline, orient } from '../src/castle/interior/geom';
import { at } from '../src/castle/builder';
import { heightAt } from '../src/world/terrain';
import { mats, islandCastle } from './world';
import { planStair, spiralNosingY, type SpiralPlan } from '../src/castle/interior/stairs';
import type { DoorSpec } from '../src/castle/interior/types';
import { masses, convexOverlap, CLEAR, FRONT, STAIR_SLIT, type Mass } from '../src/castle/openings';
import { pointInPoly, type V2 } from '../src/core/math2d';
import { bakeInteriorLight, createInteriorLight } from '../src/render/interiorLight';
import type { WindowInput } from '../src/render/interiorMath';
import { createVisibility, courtView } from '../src/world/visibility';
import { WINGS, TOWERS } from '../src/castle/spec';
import { outerFootprint } from '../src/castle/interior/plan';
import { courtyard, stairTowerPoly } from '../src/castle/layout';
import { StoneSet } from '../src/castle/stones/set';
import { wallTorches } from '../src/render/interiorFire';
import { LightRig } from '../src/light/rig';

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

/**
 * Castle surfaces lying just behind a room's walls (`depth` m or less, from 2 mm outside the face). The
 * stone materials push each pixel back by up to their parallax depth (6 cm), so a castle face this close
 * behind a room wall shows through its joints: white specks of sunlit stone in a firelit room. Sampled
 * every 0.2 m over every wall of every room cell (tunnels are carved and drawn on their own).
 */
function hiddenFaceFaults(P: PlanX, tris: Tri[], depth: number): string[] {
  const out = new Map<string, number>();
  for (const r of P.rooms) {
    if (r.zone === 'tunnel') continue;
    const p = orient(r.poly);
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 0.2) continue;
      const e: V2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n: V2 = [e[1], -e[0]]; // outward of a CCW outline
      const lo = [Math.min(a[0], b[0]) - 0.2, r.y0, Math.min(a[1], b[1]) - 0.2], hi = [Math.max(a[0], b[0]) + 0.2, r.y1, Math.max(a[1], b[1]) + 0.2];
      const near = tris.filter((t) => t.hi[0] > lo[0] && t.lo[0] < hi[0] && t.hi[1] > lo[1] && t.lo[1] < hi[1] && t.hi[2] > lo[2] && t.lo[2] < hi[2]);
      if (!near.length) continue;
      for (let s = 0.1; s < L - 0.05; s += 0.2) for (let y = r.y0 + 0.1; y < r.y1 - 0.05; y += 0.2) {
        const o: V3 = [a[0] + e[0] * s + n[0] * 0.002, y, a[1] + e[1] * s + n[1] * 0.002], d: V3 = [n[0] * depth, 0, n[1] * depth];
        if (near.some((t) => crosses(o, d, t))) out.set(r.id, (out.get(r.id) ?? 0) + 1);
      }
    }
  }
  return [...out].map(([id, k]) => `${id}: castle surface within ${Math.round(depth * 100)} cm behind its walls at ${k} points`);
}

/** The triangles of interior groups (world space). */
function groupTris(gs: InteriorGroup[]): Tri[] {
  const B = { bins: {} as Record<string, { pos: number[] }> };
  gs.forEach((g, i) => g.object.traverse((o) => { if ((o as THREE.Mesh).isMesh) B.bins[`${i}:${o.name}`] = { pos: Array.from(((o as THREE.Mesh).geometry.getAttribute('position') as THREE.BufferAttribute).array) }; }));
  return trianglesOf(B as unknown as Builder);
}

/** Is a point inside one of a spiral's step stones (tread down to soffit, or to the floor when solid)? */
function inStep(sp: SpiralPlan, q: V3): boolean {
  const ex = q[0] - sp.c[0], ez = q[2] - sp.c[1], rr = Math.hypot(ex, ez);
  if (rr < sp.rn || rr > sp.R + 0.1) return false; // tread ends run 8 cm into the wall
  const T = Math.PI * 2, prog0 = (Math.atan2(ez, ex) - sp.theta0) * sp.dir;
  return sp.steps.some((st) => {
    const prog = prog0 + Math.round((st.a0 - prog0) / T) * T;
    if (prog < st.a0 || prog > st.a1) return false;
    const under = st.solid ? sp.yFloor - 1 : spiralNosingY(sp, prog) - sp.T;
    return q[1] < st.y + 0.01 && q[1] > under - 0.01;
  });
}

/**
 * The round towers' spiral stairs and their slits: each slit is open from 0.3 m outside the drum to 0.25 m
 * inside the stairwell (no castle or interior surface left in it), its embrasure (front at the shaft's flat
 * strip, `below` under the sill to `above` over the head) is clear of every step stone, of the stair's doors,
 * and of the drum's other openings; every such stair has at least three.
 */
function slitFaults(curved: CurvedRecord[], P: PlanX, ext: Tri[], inner: Map<string, Tri[]>): string[] {
  const bad: string[] = [], S = STAIR_SLIT;
  const spirals = P.stairs.filter((s) => s.kind === 'spiral' && TOWERS.some((t) => t.kind === 'round' && s.id === `${t.id}-stair`));
  for (const s of spirals) {
    const sp = planStair(s, stairOpts(P, s)) as SpiralPlan, mine = curved.filter((c) => c.room === s.id);
    if (mine.length < 3) bad.push(`${s.id}: ${mine.length} light slits`);
    const near = (o: V3) => [...ext, ...(inner.get(s.id) ?? [])].filter((t) => Math.hypot((t.lo[0] + t.hi[0]) / 2 - o[0], (t.lo[2] + t.hi[2]) / 2 - o[2]) < 3 + Math.hypot(t.hi[0] - t.lo[0], t.hi[2] - t.lo[2]) / 2 && t.hi[1] > o[1] - 3 && t.lo[1] < o[1] + 3);
    for (const c of mine) {
      const n: V2 = [Math.cos(c.a), Math.sin(c.a)], tan: V2 = [-n[1], n[0]], o: V2 = [c.c[0] + n[0] * c.R, c.c[1] + n[1] * c.R];
      const where = `${s.id} slit at ${c.y.toFixed(2)}`;
      const T = (o[0] - sp.c[0]) * n[0] + (o[1] - sp.c[1]) * n[1] - Math.sqrt(sp.R * sp.R - S.facet * S.facet); // drum face to the flat strip
      const W = (u: number, y: number, t: number): V3 => [o[0] + tan[0] * u - n[0] * t, y, o[1] + tan[1] * u - n[1] * t];
      const tr = near(W(0, c.y, 0));
      // open: straight through, outside to stairwell
      for (const y of [c.y + 0.05, c.y + c.h / 2, c.y + c.h - 0.05]) for (const u of [-c.w / 2 + 0.02, 0, c.w / 2 - 0.02]) {
        const a = W(u, y, -0.3), b = W(u, y, T + 0.25), d: V3 = [b[0] - a[0], 0, b[2] - a[2]];
        if (tr.some((t) => t.hi[1] >= y && t.lo[1] <= y && crosses(a, d, t))) { bad.push(`${where}: not open at (${u.toFixed(2)}, ${(y - c.y).toFixed(2)})`); break; }
      }
      // the embrasure's front on the flat strip, and its depth to the slit, clear of the steps
      const wf = c.w + 2 * nicheSplay(T + 0.1);
      let hit = false;
      for (let y = c.y - S.below; y <= c.y + c.h + S.above + 1e-9 && !hit; y += 0.05) for (let u = -wf / 2; u <= wf / 2 + 1e-9 && !hit; u += 0.05) for (const t of [T - 0.1, T, T + 0.03]) {
        if (inStep(sp, W(u, y, t))) { hit = true; bad.push(`${where}: its embrasure runs into the steps at (${u.toFixed(2)}, ${(y - c.y).toFixed(2)})`); break; }
      }
      // off the stair's doors (their reveals, a door's width and its rebate either side) and every other door
      for (const d of P.doors) {
        const dx = d.centre[0] - o[0], dz = d.centre[2] - o[1];
        if (d.centre[1] < c.y + c.h + S.above && d.centre[1] + d.height + 0.6 > c.y - S.below && Math.hypot(dx, dz) < d.width / 2 + LIP + wf / 2 + d.wall) bad.push(`${where}: against door ${d.id}`);
      }
      // off the drum's other openings (surround 0.25 m round each)
      for (const e of curved) {
        if (e === c || Math.hypot(e.c[0] - c.c[0], e.c[1] - c.c[1]) > 0.01) continue;
        const da = Math.abs(((((e.a - c.a) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) * c.R;
        if (da < (e.w + c.w) / 2 + 0.6 && e.y - 0.25 < c.y + c.h + 0.25 && c.y - 0.25 < e.y + e.h + 0.25) bad.push(`${where}: overlaps another opening on its drum`);
      }
      }
    }
    return bad;
  }

/** Interior triangles (world space) with their face normals. */
function shellTriangles(groups: InteriorGroup[]): { p: V3[]; n: V3; c?: V3 }[] {
  const out: { p: V3[]; n: V3; c?: V3 }[] = [];
  for (const g of groups) g.object.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const a = m.geometry.getAttribute('position').array;
    for (let i = 0; i + 8 < a.length; i += 9) {
      const p = [0, 1, 2].map((k) => [a[i + k * 3], a[i + k * 3 + 1], a[i + k * 3 + 2]] as V3);
      const e1 = [0, 1, 2].map((k) => p[1][k] - p[0][k]), e2 = [0, 1, 2].map((k) => p[2][k] - p[0][k]);
      const c: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], l = Math.hypot(...c);
      if (l > 1e-9) out.push({ p, n: [c[0] / l, c[1] / l, c[2] / l], c: [0, 1, 2].map((k) => (p[0][k] + p[1][k] + p[2][k]) / 3) as V3 });
    }
  });
  return out;
}

/** Reveal triangles (in a doorway, facing across it) that reach both sides of the wall's mid-plane. */
function revealFaults(P: PlanX, tris: { p: V3[]; n: V3; c?: V3 }[]): string[] {
  const bad: string[] = [];
  for (const d of P.doors) {
    const hw = d.width / 2 + LIP + 0.02, top = bbox(outlineGrown(P, d, LIP)).y1 + 0.02, R = hw + d.wall;
    for (const t of tris) {
      if (t.c && Math.hypot(t.c[0] - d.centre[0], t.c[2] - d.centre[2]) > R + d.wall) continue; // far from this door
      if (Math.abs(t.n[0] * d.normal[0] + t.n[2] * d.normal[1]) > 0.2) continue; // the faces and the rebate step
      const loc = t.p.map((q) => { const x = q[0] - d.centre[0], z = q[2] - d.centre[2]; return [x * d.along[0] + z * d.along[1], q[1], x * d.normal[0] + z * d.normal[1]]; });
      if (loc.some(([u, y, w]) => Math.hypot(u, w) > R || Math.abs(u) > hw || Math.abs(w) > d.wall / 2 + 0.2 || y < d.centre[1] - 0.01 || y > top)) continue;
      const ws = loc.map((q) => q[2]);
      if (Math.min(...ws) < -0.01 && Math.max(...ws) > 0.01) { bad.push(`${d.id}: a reveal triangle spans the wall's mid-plane`); break; }
    }
  }
  return bad;
}

describe('every opening in the castle: one owner, one outline, room to open', () => {
  let walls: WallRecord[], P: PlanX, tris: Tri[], B: Builder, inner: ReturnType<typeof buildInterior>, lights: WindowInput[], curved: CurvedRecord[], stairTris: Map<string, Tri[]>, shell: { p: V3[]; n: V3 }[];
  beforeAll(() => {
    const isl = islandCastle(); // the castle as main.ts lays it, cut by the interior as main.ts does
    B = isl.builder; lights = isl.lights as WindowInput[];
    inner = buildInterior(mats(), B, { heightAt });
    P = inner.plan; shell = shellTriangles(inner.groups);
    walls = B.walls; tris = trianglesOf(B); curved = B.curved;
    stairTris = new Map(inner.groups.filter((g) => g.key.startsWith('stairs:')).map((g) => [g.key.slice(7), groupTris([g])]));
  }, 300_000);

  it('lights every round tower\'s spiral through real slits', () => {
    expect(curved.filter((c) => c.room).length).toBeGreaterThanOrEqual(6);
    expect(slitFaults(curved, P, tris, stairTris)).toEqual([]);
    // what it is for: a slit dropped onto the steps, one painted on the drum with no hole, one on a door
    const c = curved.find((x) => x.room === 'se-stair')!, sp = P.stairs.find((x) => x.id === 'se-stair')!;
    const f = slitFaults([{ ...c, y: c.y - 1.6 }], P, tris, stairTris);
    expect(f.some((x) => x.includes('its embrasure runs into the steps'))).toBe(true);
    expect(f).toContain('se-stair: 1 light slits');
    const solid = slitFaults([c], P, [...tris, ...trianglesOf({ bins: { x: { pos: (() => { const n: V2 = [Math.cos(c.a), Math.sin(c.a)], t: V2 = [-n[1], n[0]], o = [c.c[0] + n[0] * c.R, c.c[1] + n[1] * c.R]; return [o[0] - t[0], c.y, o[1] - t[1], o[0] + t[0], c.y, o[1] + t[1], o[0], c.y + 2, o[1]]; })() } } } as unknown as Builder)], stairTris);
    expect(solid.some((x) => x.includes('not open'))).toBe(true);
    const door = P.doors.find((d) => d.spaces.includes(sp.id))!;
    const onDoor = slitFaults([{ ...c, c: [door.centre[0] - Math.cos(c.a) * c.R, door.centre[2] - Math.sin(c.a) * c.R], y: door.centre[1] + 0.5 }], P, tris, stairTris);
    expect(onDoor.some((x) => x.includes(`against door ${door.id}`))).toBe(true);
  }, 120_000);

  it('checks every castle wall, window and plan door', () => {
    expect(walls.filter((w) => w.openings.length).length).toBeGreaterThan(20);
    expect(P.doors.filter((d) => d.spaces.some((s) => OUTDOOR.has(s))).length).toBeGreaterThanOrEqual(5);
    expect(tris.length).toBeGreaterThan(10_000);
  });

  it('holds every invariant', () => {
    expect(openingFaults(walls, P, masses(), tris)).toEqual([]);
  }, 120_000);

  it('leaves no castle surface just behind a room wall (it shows through the parallax joints)', () => {
    expect(hiddenFaceFaults(P, tris, 0.08)).toEqual([]);
  }, 120_000);

  it('finds a castle face just behind a room wall', () => {
    // a castle face 3 cm behind the first wall of the undercroft N0-2
    const r = P.rooms.find((x) => x.id === 'N0-2')!, p = orient(r.poly);
    const [a, b] = [p[0], p[1]], L = Math.hypot(b[0] - a[0], b[1] - a[1]), nn: V2 = [((b[1] - a[1]) / L) * 0.03, (-(b[0] - a[0]) / L) * 0.03];
    const A: V3 = [a[0] + nn[0], r.y0 + 0.5, a[1] + nn[1]], B: V3 = [b[0] + nn[0], r.y0 + 0.5, b[1] + nn[1]], C: V3 = [b[0] + nn[0], r.y0 + 2, b[1] + nn[1]];
    const shard: Tri = { a: A, b: B, c: C, lo: [0, 1, 2].map((j) => Math.min(A[j], B[j], C[j])) as V3, hi: [0, 1, 2].map((j) => Math.max(A[j], B[j], C[j])) as V3 };
    expect(hiddenFaceFaults(P, [...tris, shard], 0.08).some((x) => x.startsWith('N0-2: castle surface within 8 cm'))).toBe(true);
   }, 120_000);

  it('lights each half of a reveal from one room', () => {
    expect(revealFaults(P, shell)).toEqual([]);
    // a soffit quad of gate-inner as one face-to-face triangle pair, as before 2026-11-06
    const d = P.doors.find((x) => x.id === 'gate-inner')!, y = d.centre[1] + d.height;
    const W = (u: number, w: number): V3 => [d.centre[0] + d.along[0] * u + d.normal[0] * w, y, d.centre[2] + d.along[1] * u + d.normal[1] * w];
    expect(revealFaults(P, [{ p: [W(-0.5, -d.wall / 2), W(0.5, -d.wall / 2), W(0.5, d.wall / 2)], n: [0, -1, 0] }])).toEqual(['gate-inner: a reveal triangle spans the wall\'s mid-plane']);
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
    const vis = createVisibility(cam, inner.groups, P, { apertures: bake.apertures, ground: heightAt, inCourt: courtView(courtyard(), Math.min(...WINGS.map((w) => w.top))) }); // as main.ts
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
    // and no more: walking up to the gate, the rooms off the courtyard stay culled behind the walls
    const gate = P.doors.find((d) => d.id === 'gate-main')!, courtRooms = P.doors.filter((d) => d.spaces.includes('courtyard') && d.id !== 'gate-court').map((d) => d.spaces.find((s) => s !== 'courtyard')!);
    for (const dist of [5, 15, 30]) {
      const q = on(gate, 0, -(gate.wall / 2 + dist));
      cam.position = { x: q[0], y: gate.centre[1] + 1.6, z: q[1] };
      vis.update();
      expect(courtRooms.filter((r) => vis.isRoomVisible(r))).toEqual([]);
    }
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

  // walking through a doorway: from 1 m before it to 1 m past it, in 5 cm steps, the rooms on both
  // sides stay drawn at every step (inside the wall's thickness the camera is in neither room)
  it('keeps both rooms of every doorway drawn while the camera walks through it', () => {
    const bake = bakeInteriorLight(inner.groups, { blocked: () => false }, { plan: P, windows: lights, sun: () => ({ dir: [-0.4, 0.63, 0.66], irradiance: [3, 3, 3] }), light: createInteriorLight() });
    const cam = { position: { x: 0, y: 0, z: 0 } };
    const vis = createVisibility(cam, inner.groups, P, { apertures: bake.apertures, ground: heightAt, inCourt: courtView(courtyard(), Math.min(...WINGS.map((w) => w.top))) }); // as main.ts
    const faults = new Map<string, string>();
    let poses = 0;
    for (const d of P.doors) {
      const rooms = d.spaces.filter((s) => !OUTDOOR.has(s) && s !== 'farbank');
      if (!rooms.length) continue;
      const reach = d.wall / 2 + 1;
      for (let t = -reach; t <= reach + 1e-9; t += 0.05) for (const across of [0, -d.width / 4, d.width / 4]) {
        const q = on(d, across, t);
        cam.position = { x: q[0], y: d.centre[1] + 1.6, z: q[1] };
        vis.update(); poses++;
        for (const r of rooms) if (!vis.isRoomVisible(r) && !faults.has(`${d.id}:${r}`)) faults.set(`${d.id}:${r}`, `${d.id}: ${r} culled ${t.toFixed(2)} m through, ${across.toFixed(2)} m aside (camera room ${vis.roomId ?? 'none'})`);
      }
    }
    expect(poses).toBeGreaterThan(1000);
    expect([...faults.values()]).toEqual([]);
  }, 120_000);

  // firelight never goes out because the camera crossed a doorway: walking through every doorway, a
  // torch whose light still reaches the camera keeps its light (main.ts picks lights by distance only)
  it('keeps every torch that reaches the camera lit while it walks through a doorway', () => {
    const groupOf = new Map<string, string>();
    for (const g of inner.groups) for (const id of g.rooms) groupOf.set(id, g.key);
    const fire = wallTorches(P, (id) => groupOf.get(id));
    const rig = new LightRig({ create: () => ({ set() {} }) }, { shadows: 0, lights: 8 }); // as main.ts
    rig.setEmitters(fire.emitters);
    const src = rig.meanLights();
    const faults: string[] = [];
    for (const d of P.doors) {
      const reach = d.wall / 2 + 2;
      let prev = new Set<number>();
      for (let t = -reach; t <= reach + 1e-9; t += 0.05) {
        const q = on(d, 0, t), eye: V3 = [q[0], d.centre[1] + 1.6, q[1]];
        rig.update(0, 1, eye); // as main.ts: no visibility filter
        const lit = new Set([...rig.snapshot().plain].filter((s) => s.source >= 0 && s.weight > 0).map((s) => s.source));
        for (const id of prev) if (!lit.has(id) && Math.hypot(...src[id].position.map((v, k) => v - eye[k]) as V3) < src[id].range) faults.push(`${d.id}: torch ${id} went out ${t.toFixed(2)} m through`);
        prev = lit;
      }
    }
    expect(fire.emitters.length).toBeGreaterThan(10);
    expect(faults).toEqual([]);
  }, 60_000);

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
