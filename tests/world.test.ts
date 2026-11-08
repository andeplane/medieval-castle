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
// - every leaf, from shut to fully open, in either seat of a two-way door, stays in its doorway or its
//   room (or, swinging out into the courtyard, clear of every building and above the ground), under the
//   ceiling, off the stair treads and out of every other leaf's sweep;
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
import { stairOpts, leafSwingFits, type PlanX } from '../src/castle/interior/plan';
import { placeLeaves, leafPoint, leafSwing, leafDepth, leafHead, headRise, leafClassFor, stopPlane, doorCuts, LIP, GROW, type LeafPlace } from '../src/castle/interior/doorGeom';
import { archOutline, orient } from '../src/castle/interior/geom';
import { at } from '../src/castle/builder';
import { heightAt } from '../src/world/terrain';
import { mats, islandCastle } from './world';
import { planStair, spiralNosingY, STAIR_RULES, type SpiralPlan, type StraightPlan } from '../src/castle/interior/stairs';
import type { DoorSpec } from '../src/castle/interior/types';
import { masses, convexOverlap, CLEAR, FRONT, STAIR_SLIT, type Mass } from '../src/castle/openings';
import { pointInPoly, type V2 } from '../src/core/math2d';
import { bakeInteriorLight, createInteriorLight } from '../src/render/interiorLight';
import type { WindowInput } from '../src/render/interiorMath';
import { createVisibility, drawnSpaces, roomGraph } from '../src/world/visibility';
import { MeshBVH } from 'three-mesh-bvh';
import * as T3 from 'three';
import { buildTerrain } from '../src/world/terrain';
import { PAVE_Y } from '../src/castle/paving';
import { WINGS, TOWERS } from '../src/castle/spec';
import { outerFootprint } from '../src/castle/interior/plan';
import { caveSpan, caveWalk, CAVE_ZONE } from '../src/castle/interior/caves';
import { courtyard, stairTowerPoly } from '../src/castle/layout';
import { StoneSet } from '../src/castle/stones/set';
import { wallTorches } from '../src/render/interiorFire';
import { FireTable, roomFires, fireAt, MAX_FIRES } from '../src/light/roomLight';
import { OUTDOOR_TAG } from '../src/render/interiorMath';
import type { LightEmitter } from '../src/light/types';

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
const mkTri = (a: V3, b: V3, c: V3): Tri => ({ a, b, c, lo: [0, 1, 2].map((j) => Math.min(a[j], b[j], c[j])) as V3, hi: [0, 1, 2].map((j) => Math.max(a[j], b[j], c[j])) as V3 });
/** A BVH over triangles, for rays (three-mesh-bvh). */
function bvhOf(tris: Tri[]): MeshBVH {
  const list = tris.length ? tris : [mkTri([0, -1e4, 0], [1e-3, -1e4, 0], [0, -1e4, 1e-3])];
  const a = new Float32Array(list.length * 9);
  list.forEach((t, i) => { a.set(t.a, i * 9); a.set(t.b, i * 9 + 3); a.set(t.c, i * 9 + 6); });
  const g = new T3.BufferGeometry(); g.setAttribute('position', new T3.BufferAttribute(a, 3));
  return new MeshBVH(g);
}
/** World positions of every mesh under an object, as one non-indexed soup. */
function meshPositions(root: THREE.Object3D): number[] {
  const out: number[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrixWorld), a = g.getAttribute('position').array;
    for (let i = 0; i < a.length; i++) out.push(a[i]);
  });
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
/** Is a point inside another leaf's sweep (the sectors its board passes through from shut to fully open, either way)? */
function inSweep(q: V3, L: LeafPlace): boolean {
  if (q[1] <= L.pivot[1] - 0.05 || q[1] >= L.pivot[1] + L.height + 0.05) return false;
  const sector = (o: V3, a0: number, a1: number) => {
    const dx = q[0] - o[0], dz = q[2] - o[2];
    const x = dx * L.eU[0] + dz * L.eU[1], z = dx * L.eV[0] + dz * L.eV[1], a = Math.atan2(z, x);
    return Math.hypot(x, z) < L.width + 0.05 && a > a0 - 0.15 && a < a1 + 0.15;
  };
  return sector(L.pivot, 0, L.maxAngle) || (L.backAngle > 0 && sector(leafPoint(L, leafSwing(L, 0), [0, 0, L.backAxis]), -L.backAngle, 0));
}
/** A shut leaf's outline (world points) in the door's (u along `along`, y), without repeated points. */
function leafUV(d: DoorSpec, ring: V3[]): V2[] {
  const uv = ring.map((p): V2 => [(p[0] - d.centre[0]) * d.along[0] + (p[2] - d.centre[2]) * d.along[1], p[1]]);
  return uv.filter((p, i) => i === 0 || Math.hypot(p[0] - uv[i - 1][0], p[1] - uv[i - 1][1]) > 1e-6);
}
/** Halfway from each point of `outer` (and each edge's middle) to the nearest point of the closed outline `inner`. */
function midway(outer: V2[], inner: V2[]): V2[] {
  const pts = outer.flatMap((p, i) => (i + 1 < outer.length ? [p, [(p[0] + outer[i + 1][0]) / 2, (p[1] + outer[i + 1][1]) / 2] as V2] : [p]));
  return pts.map(([u, y]) => {
    let best: V2 = inner[0], bd = Infinity;
    for (let i = 0; i < inner.length; i++) {
      const [ax, ay] = inner[i], [bx, by] = inner[(i + 1) % inner.length], dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((u - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1))), q: V2 = [ax + dx * t, ay + dy * t];
      const dd = Math.hypot(q[0] - u, q[1] - y);
      if (dd < bd) { bd = dd; best = q; }
    }
    return [(u + best[0]) / 2, (y + best[1]) / 2];
  });
}
/** A door's outline at depth t from its mid-plane (doorCuts), grown by about g (jambs out, head up). */
function cutAt(d: DoorSpec, t: number, g = 0, P?: PlanX): V2[] {
  const cuts = doorCuts(d, P?.rise[d.id]), o = (cuts.find((c) => t >= c.t0 && t < c.t1) ?? cuts[cuts.length - 1]).o;
  return o.map(([u, y], i) => [u + Math.sign(u) * g, i < 2 ? y : y + g]);
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
      const sg = k === 0 ? -1 : 1;
      for (const [u, y] of cutAt(d, sg * d.wall / 2, 0.01, P).slice(2)) {
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
  // 7. leaves, every way they swing (forward, and back where they can): the whole swing in the doorway or the
  // room it swings into (or the open courtyard), under the ceiling, off the treads, clear of every other leaf's sweep
  const leaves = P.doors.flatMap((d) => placeLeaves(d).flatMap((pl) => (d.swingsBack ? [1, -1] as const : [1] as const).map((way) => ({ d, pl, way }))));
  const spirals = P.stairs.filter((s) => s.kind === 'spiral').map((s) => planStair(s, stairOpts(P, s)) as SpiralPlan);
  for (const { d, pl, way } of leaves) {
    const into = d.spaces[way > 0 ? pl.seat : 1 - pl.seat], r = rooms.get(into);
    if (!r && into !== 'courtyard') { bad.push(`${d.id}: swings out into ${into}`); continue; }
    if (r && pl.pivot[1] + pl.height > r.y1 - 0.02) bad.push(`${d.id}: leaf top above the ceiling of ${r.id}`);
    const faults = new Set<string>(), { zBack } = leafDepth(pl.kind);
    const sg = (pl.seat === 1 ? 1 : -1) * way, own = M.find((m) => pointInPoly(m.poly, ...on(d, 0, -sg * 0.3)));
    // the other leaves whose sweep this one could reach at all
    const others = leaves.filter((o) => o.d !== d && Math.hypot(o.pl.pivot[0] - pl.pivot[0], o.pl.pivot[2] - pl.pivot[2]) < o.pl.width + pl.width + 0.2);
    for (let i = 0; i <= 24; i++) for (let k = 0; k <= 8; k++) for (const y of [0, pl.height / 2, pl.height - 0.02]) for (const z of [zBack, 0]) {
      const q = leafPoint(pl, leafSwing(pl, way > 0 ? (pl.maxAngle * i) / 24 : (-pl.backAngle * i) / 24), [(pl.width * k) / 8, y, z]);
      const dx = q[0] - d.centre[0], dz = q[2] - d.centre[2];
      const across = dx * d.along[0] + dz * d.along[1], through = dx * d.normal[0] + dz * d.normal[1];
      // in the doorway or its rebate (a curved or skewed room face lies up to 0.15 m beyond the wall face at the centre)
      const inDoor = Math.abs(across) <= d.width / 2 + LIP + 1e-3 && Math.abs(through) <= d.wall / 2 + 0.15;
      if (r && !inDoor && !pointInPoly(r.poly, q[0], q[2])) faults.add(`${d.id}: leaf swings through the wall of ${r.id}`);
      if (!r && !inDoor) {
        // out into the courtyard: no building in the way, and the ground (paving or terrain) under its bottom edge
        if (M.some((m) => m !== own && m.top > q[1] && pointInPoly(m.poly, q[0], q[2]))) faults.add(`${d.id}: leaf swings into a building in the ${into}`);
        if (y === 0 && Math.max(heightAt(q[0], q[2]), floorUnder(tris, q[0], q[2], q[1] + 0.3, 0.6)) > q[1] - 0.005) faults.add(`${d.id}: leaf scrapes the ground of the ${into}`);
      }
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
      for (const o of others) if (inSweep(q, o.pl)) faults.add(`${d.id}: leaf swings into the leaf of ${o.d.id}`);
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

/** Highest surface under (x, z) between `top` and `top - depth` among `tris`, or -Infinity. */
function floorUnder(tris: Tri[], x: number, z: number, top: number, depth: number): number {
  let best = -Infinity;
  for (const t of tris) {
    if (t.lo[0] > x || t.hi[0] < x || t.lo[2] > z || t.hi[2] < z || t.lo[1] > top || t.hi[1] < top - depth) continue;
    const o: V3 = [x, top, z], d: V3 = [0, -depth, 0];
    if (!crosses(o, d, t)) continue;
    // height of the plane at (x, z)
    const e1 = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]], e2 = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (Math.abs(n[1]) < 1e-9) continue;
    best = Math.max(best, t.a[1] - (n[0] * (x - t.a[0]) + n[2] * (z - t.a[2])) / n[1]);
  }
  return best;
}

/**
 * Every door opens onto floor on both sides: 0.35 m past each wall face, across the doorway, the first surface
 * under the sill is within a step (0.3 m, the motor's autostep) of the sill. A door onto a void (the top of a
 * flight with no landing, 2026-11-06) is a fall. Outdoor sides use the terrain where the castle has no floor.
 */
function doorFloorFaults(P: PlanX, solid: Tri[], ground: (x: number, z: number) => number): string[] {
  const out: string[] = [];
  for (const d of P.doors) {
    if (d.spaces.includes('farbank')) continue;
    const r = Math.hypot(d.width, d.wall) + 1.5, near = solid.filter((t) => t.hi[0] > d.centre[0] - r && t.lo[0] < d.centre[0] + r && t.hi[2] > d.centre[2] - r && t.lo[2] < d.centre[2] + r);
    const y = d.centre[1];
    for (const [k, sgn] of [[0, -1], [1, 1]] as const) {
      const sp = d.spaces[k];
      for (const u of [-d.width / 4, 0, d.width / 4]) {
        const q = on(d, u, sgn * (d.wall / 2 + 0.35));
        let f = floorUnder(near, q[0], q[1], y + 0.35, 6);
        if (OUTDOOR.has(sp)) f = Math.max(f, ground(q[0], q[1]));
        if (!(f > y - 0.3)) { out.push(`${d.id}: no floor on the ${sp} side (${f === -Infinity ? 'none' : `${(f - y).toFixed(2)} m`} under the sill)`); break; }
      }
    }
  }
  return out;
}

/**
 * A straight flight is closed underneath: from points in the space under its treads, rays forward, back,
 * sideways and up meet the stair's own stone from behind (its outer faces), never a room face or nothing. So
 * nobody can stand under it and no camera outside sees its treads from below (see-through treads, 2026-11-06).
 */
function flightFaults(P: PlanX, tris: { p: V3[]; n: V3 }[]): string[] {
  const out: string[] = [];
  const Tn = tris.map((t) => ({ ...t, a: t.p[0], b: t.p[1], c: t.p[2] }));
  for (const s of P.stairs) {
    if (s.kind !== 'straight') continue;
    const sp = planStair(s, stairOpts(P, s)) as StraightPlan;
    const ends = [sp.o, [sp.o[0] + sp.d[0] * sp.run, 0, sp.o[2] + sp.d[1] * sp.run]], m = sp.width + 1;
    const T = Tn.filter((t) => t.p.some((q) => q[0] > Math.min(ends[0][0], ends[1][0]) - m && q[0] < Math.max(ends[0][0], ends[1][0]) + m && q[2] > Math.min(ends[0][2], ends[1][2]) - m && q[2] < Math.max(ends[0][2], ends[1][2]) + m));
    const dirs: [string, V3][] = [['forward', [sp.d[0], 0, sp.d[1]]], ['back', [-sp.d[0], 0, -sp.d[1]]], ['left', [sp.side[0], 0, sp.side[1]]], ['right', [-sp.side[0], 0, -sp.side[1]]], ['up', [0, 1, 0]], ['up-forward', [sp.d[0] * 0.7, 0.7, sp.d[1] * 0.7]]];
    let bad = 0, first = '';
    for (const st of sp.steps) {
      const yTop = st.y - STAIR_RULES.lip - 0.05;
      if (yTop - sp.yFloor < 0.4) continue;
      for (const f of [0.25, 0.5, 0.75]) for (const t of [0.3, 0.7]) {
        const sc = st.s0 + (Math.max(st.s1, st.s0 + 0.02) - st.s0) * t, v = (f - 0.5) * sp.width;
        const o: V3 = [sp.o[0] + sp.d[0] * sc + sp.side[0] * v, (sp.yFloor + 0.2 + yTop) / 2, sp.o[2] + sp.d[1] * sc + sp.side[1] * v];
        for (const [name, dir] of dirs) {
          const L = 20, D: V3 = [dir[0] * L, dir[1] * L, dir[2] * L];
          let tNear = Infinity, behind = false;
          for (const tr of T) {
            if (!crosses(o, D, tr as unknown as Tri)) continue;
            const e1 = [tr.b[0] - tr.a[0], tr.b[1] - tr.a[1], tr.b[2] - tr.a[2]], e2 = [tr.c[0] - tr.a[0], tr.c[1] - tr.a[1], tr.c[2] - tr.a[2]];
            const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            const den = n[0] * D[0] + n[1] * D[1] + n[2] * D[2];
            const tt = (n[0] * (tr.a[0] - o[0]) + n[1] * (tr.a[1] - o[1]) + n[2] * (tr.a[2] - o[2])) / den;
            const away = tr.n[0] * dir[0] + tr.n[1] * dir[1] + tr.n[2] * dir[2] > 0;
            if (tt < tNear - 0.01 / L) { tNear = tt; behind = away; } else if (Math.abs(tt - tNear) <= 0.01 / L) behind ||= away;
          }
          if (!behind) { bad++; if (!first) first = `${name} from ${o.map((x) => x.toFixed(2))}`; }
        }
      }
    }
    if (bad) out.push(`${s.id}: open under the flight (${bad} rays, e.g. ${first})`);
  }
  return out;
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
    if (P.caves?.openings.includes(d.id)) continue; // a natural opening in the caves has no reveal: the rock runs through
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

  it('opens every door onto floor on both sides, never onto a drop', () => {
    const solid = [...tris, ...groupTris(inner.groups)];
    expect(doorFloorFaults(P, solid, heightAt)).toEqual([]);
    // what it is for: the cellar stair cut back to its last tread leaves its top door over the cellar floor
    const s = P.stairs.find((x) => x.kind === 'straight')!, d = P.doors.find((x) => x.id === s.landings[s.landings.length - 1].door)!;
    const cut = solid.filter((t) => !(Math.hypot((t.lo[0] + t.hi[0]) / 2 - d.centre[0], (t.lo[2] + t.hi[2]) / 2 - d.centre[2]) < 1.6 && t.lo[1] > d.centre[1] - 0.6 && t.hi[1] < d.centre[1] + 0.05));
    expect(doorFloorFaults({ ...P, doors: [d] }, cut, heightAt)).toEqual([`${d.id}: no floor on the N-cellarstair side (-4.40 m under the sill)`]);
  }, 120_000);

  it('closes the space under every straight flight', () => {
    const st = shellTriangles(inner.groups.filter((g) => g.key.startsWith('stairs:')));
    expect(flightFaults(P, st)).toEqual([]);
    // what it is for: the same flight without its outer faces at the top end
    const s = P.stairs.find((x) => x.kind === 'straight')!, sp = planStair(s, stairOpts(P, s)) as StraightPlan;
    const end = st.filter((t) => !(t.n[0] * sp.d[0] + t.n[2] * sp.d[1] > 0.9 && t.c && Math.abs((t.c[0] - sp.o[0]) * sp.d[0] + (t.c[2] - sp.o[2]) * sp.d[1] - sp.run) < 0.02));
    expect(flightFaults(P, end)[0]).toMatch(/^N-cellarstair: open under the flight/);
  }, 120_000);

  it('checks every castle wall, window and plan door', () => {
    expect(walls.filter((w) => w.openings.length).length).toBeGreaterThan(20);
    expect(P.doors.filter((d) => d.spaces.some((s) => OUTDOOR.has(s))).length).toBeGreaterThanOrEqual(5);
    expect(tris.length).toBeGreaterThan(10_000);
  });

  it('holds every invariant', () => {
    expect(openingFaults(walls, P, masses(), tris)).toEqual([]);
  }, 300_000);

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
    // a door whose leaf, hung on its other jamb, would swing into a room's side wall
    const flip = (d: DoorSpec) => ({ ...d, hinge: d.hinge === 'left' ? 'right' as const : 'left' as const });
    const cramped = Q.doors.find((d) => d.leaf && d.kind === 'plank' && !leafSwingFits(Q, flip(d)))!;
    cramped.hinge = flip(cramped).hinge;
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
    expect(f.some((x) => x.startsWith(`${cramped.id}: leaf swings through the wall of`))).toBe(true);
    // a courtyard door's outward seat (it opens away from someone inside) with its sill sunk into the paving
    const R = structuredClone(P), sunk = R.doors.find((d) => d.id === 'court>E0-2')!;
    expect(sunk.swingsBack).toBe(true);
    sunk.centre[1] -= 0.3;
    expect(openingFaults(walls, { ...R, doors: [sunk] }, masses(), tris)).toContain('court>E0-2: leaf scrapes the ground of the courtyard');
  }, 300_000);

  // ---- the player's poses, the openings and the shut leaves, for the visibility checks below ----
  const cam = { position: { x: 0, y: 0, z: 0 } };
  let bakeCache: ReturnType<typeof bakeInteriorLight> | undefined;
  const baked = () => (bakeCache ??= bakeInteriorLight(inner.groups, { blocked: () => false }, { plan: P, windows: lights, sun: () => ({ dir: [-0.4, 0.63, 0.66], irradiance: [3, 3, 3] }), light: createInteriorLight() }));
  const court = courtyard(), roofs = Math.min(...WINGS.map((w) => w.top));
  const inCourt = (x: number, z: number) => pointInPoly(court, x, z);
  /** The visibility as main.ts makes it. */
  const makeVis = () => createVisibility(cam, inner.groups, P, { apertures: baked().apertures, ground: heightAt, court: inCourt, roofs });
  /** The castle as drawn, less its window glass (you see through it). */
  const castleSolid = () => trianglesOf({ bins: Object.fromEntries(Object.entries(B.bins).filter(([k]) => k !== 'glass')) } as unknown as Builder);
  /** A door's shut leaf as a flat outline at its mid-thickness: triangles, the outline, its depth along the door's normal. */
  const shutLeaf = (d: DoorSpec) => {
    const pl = placeLeaves(d)[0];
    if (!pl) return null;
    const cls = leafClassFor(d, pl.kind), top = leafHead(cls), sill = cls.sill;
    const { zBack, zFront } = leafDepth(pl.kind), z = (zBack + zFront) / 2, M = leafSwing(pl, 0), N = 24;
    const ring: V3[] = [leafPoint(pl, M, [0, 0, z]), leafPoint(pl, M, [pl.width, 0, z])];
    for (let i = 0; i <= N; i++) { const x = pl.width * (1 - i / N); ring.push(leafPoint(pl, M, [x, top(cls.sOff + x) - sill, z])); }
    const c = [0, 1, 2].map((k) => ring.reduce((s, p) => s + p[k], 0) / ring.length) as V3;
    const tris = ring.map((p, i) => mkTri(c, p, ring[(i + 1) % ring.length]));
    // and its rim, as thick as its boards (a ray slipping past the edge at a slant meets it)
    const at = (p: V3, dz: number): V3 => { const n = pl.eV; return [p[0] + n[0] * dz, p[1], p[2] + n[1] * dz]; };
    const half = (zFront - zBack) / 2;
    ring.forEach((p, i) => { const q = ring[(i + 1) % ring.length]; tris.push(mkTri(at(p, -half), at(q, -half), at(q, half)), mkTri(at(p, -half), at(q, half), at(p, half))); });
    const t = (ring[0][0] - d.centre[0]) * d.normal[0] + (ring[0][2] - d.centre[2]) * d.normal[1];
    return { tris, ring, t, sill };
  };
  /** Every door (at its mid-plane) and every window and slit (at its glass), with the two spaces it joins. */
  const openingsOf = () => {
    const ops: { id: string; spaces: [string, string]; p: V3; n: V2; leafT?: number; window?: boolean }[] = P.doors.map((d) => ({
      id: d.id, spaces: d.spaces.map((s) => (s === 'farbank' ? 'outside' : s)) as [string, string],
      p: [d.centre[0], d.centre[1] + Math.min(1.2, d.height / 2), d.centre[2]], n: d.normal, leafT: shutLeaf(d)?.t,
    }));
    for (const a of baked().apertures) if (a.door === undefined && a.kind !== 'portal') {
      ops.push({ id: `${a.id} (${P.rooms[a.room].id})`, spaces: [P.rooms[a.room].id, inCourt(a.c[0] + a.n[0], a.c[2] + a.n[2]) ? 'courtyard' : 'outside'], p: a.c, n: [a.n[0], a.n[2]], window: true });
    }
    return ops;
  };
  /** Where a player stands: near and far in front of every outdoor doorway, outside up to 150 m, the courtyard, every room and in front of each of its doors, the gate passage. */
  const playerPoses = () => {
    const poses: { label: string; eye: V3 }[] = [];
    const foot = outerFootprint(), tower = stairTowerPoly();
    const outdoors = (s: string, q: V2) => s === 'courtyard' ? inCourt(q[0], q[1]) && !pointInPoly(tower, q[0], q[1]) : !foot.some((f) => pointInPoly(f, q[0], q[1]));
    for (const d of P.doors) {
      const out = d.spaces.find((s) => OUTDOOR.has(s));
      if (!out) continue;
      const sgn = d.spaces[0] === out ? 1 : -1; // the normal points from spaces[0] to spaces[1]
      for (const dist of [1.5, 3, 5, 8, 12, 16, 20, 25, 30, 40, 60, 90, 150]) for (const side of [-4, -1.5, 0, 1.5, 4]) {
        const q = on(d, side, -sgn * (d.wall / 2 + dist));
        if (outdoors(out, q)) poses.push({ label: `${dist} m in front of ${d.id}, ${side} m aside`, eye: [q[0], Math.max(d.centre[1], heightAt(q[0], q[1]), 0) + 1.6, q[1]] });
      }
    }
    const xs = court.map((p) => p[0]), zs = court.map((p) => p[1]);
    for (let x = Math.min(...xs) + 1; x < Math.max(...xs); x += 3) for (let z = Math.min(...zs) + 1; z < Math.max(...zs); z += 3) {
      if (outdoors('courtyard', [x, z])) poses.push({ label: `the courtyard at (${x.toFixed(1)}, ${z.toFixed(1)})`, eye: [x, PAVE_Y + 1.6, z] });
    }
    // a cave room's floor slopes and dips: stand on it where you are (caves.ts caveSpan), not at its lowest point
    const floorAt = (r: { id: string; zone: string; y0: number }, q: V2, y: number) => (r.zone === CAVE_ZONE ? caveSpan(P.caves!, r.id, q)!.floor : y);
    for (const r of P.rooms) {
      const c = r.poly.reduce((a, q) => [a[0] + q[0] / r.poly.length, a[1] + q[1] / r.poly.length], [0, 0]);
      if (pointInPoly(r.poly, c[0], c[1])) poses.push({ label: `the middle of ${r.id}`, eye: [c[0], floorAt(r, c, r.y0) + 1.6, c[1]] });
    }
    const rooms = new Map(P.rooms.map((r) => [r.id, r]));
    for (const d of P.doors) for (const k of [0, 1]) {
      const r = rooms.get(d.spaces[k]), q = on(d, 0, (k === 0 ? -1 : 1) * (d.wall / 2 + 1.5));
      if (r && r.zone !== 'tunnel' && pointInPoly(r.poly, q[0], q[1])) poses.push({ label: `${r.id}, 1.5 m in front of ${d.id}`, eye: [q[0], floorAt(r, q, d.centre[1]) + 1.6, q[1]] });
    }
    // (the caves' walking lines are posed in their own test below, by the room graph: no need to cast every opening from them)
    const gm = P.doors.find((d) => d.id === 'gate-main')!, gc = P.doors.find((d) => d.id === 'gate-court')!;
    for (let f = 0; f <= 1 + 1e-9; f += 0.05) {
      const x = gm.centre[0] + (gc.centre[0] - gm.centre[0]) * f, z = gm.centre[2] + (gc.centre[2] - gm.centre[2]) * f;
      poses.push({ label: `the gate passage, ${(f * 100).toFixed(0)} % in`, eye: [x, gc.centre[1] + 1.7, z] });
    }
    return poses;
  };
  // One model for visibility and LOD: no level of detail or cull may add, move or remove an opening or a
  // door. Which rooms are drawn is a graph walk (world/visibility.ts): the same spaces from every distance.
  // Checked here by looking: from every pose a player has (in front of every outdoor doorway near and far,
  // the middle of every room and in front of each of its doors, the courtyard, outside, the gate passage),
  // every opening the eye can reach (a ray through the real castle, the rooms and the shut leaves, past the
  // glass) has its spaces drawn: both for an opening nothing shuts, the eye's side for a shut leaf.
  // Anders, 2026-11-07: from the gate passage the courtyard doors showed sky (E0-2) or plain wall (the stair
  // tower), from a few metres into the courtyard they were fine; a shut door in a room showed a white outline.
  it('draws the spaces of every opening seen from any pose, near or far, doors shut or open', () => {
    const vis = makeVis(), poses = playerPoses();
    const solid = [...castleSolid(), ...groupTris(inner.groups)];
    const faults = new Map<string, string>(), ray = new T3.Ray();
    let seen = 0, n = 0;
    for (const open of [false, true]) { // as the castle starts, and with every leaf swung open (any agent may open any door)
      const occ = bvhOf(open ? solid : [...solid, ...P.doors.flatMap((d) => shutLeaf(d)?.tris ?? [])]);
      const ops = openingsOf().map((o) => (open ? { ...o, leafT: undefined } : o));
      for (const d of P.doors) vis.setDoorOpen(d.id, open); // the doors system tells the graph (main.ts syncDoorLight)
      n = ops.length;
      poses.forEach(({ label, eye }, i) => {
        cam.position = { x: eye[0], y: eye[1], z: eye[2] };
        vis.update();
        for (const op of ops) {
          let target = op.p, need = op.spaces as string[];
          if (op.leafT !== undefined) { // a shut leaf: the eye's side, up to the leaf
            const side = Math.sign((eye[0] - op.p[0]) * op.n[0] + (eye[2] - op.p[2]) * op.n[1]) || 1;
            target = [op.p[0] + op.n[0] * (op.leafT + side * 0.04), op.p[1], op.p[2] + op.n[1] * (op.leafT + side * 0.04)];
            need = [side < 0 ? op.spaces[0] : op.spaces[1]];
          }
          // a window seen from outside shows its dark fallback pane, not the room (windows lead out only)
          if (op.window && (eye[0] - op.p[0]) * op.n[0] + (eye[2] - op.p[2]) * op.n[1] > 0) need = [op.spaces[1]];
          // A ray is only needed to tell whether an undrawn space is seen. Everything drawn is fine whether or not
          // it is seen, so the ray is skipped (it costs ~100 ms per 1000 under coverage); every 8th pose still
          // casts all of them, so the count of openings seen below shows the rays reach the openings.
          const undrawn = need.filter((s) => !vis.isRoomVisible(s) && !faults.has(`${op.id}:${s}`));
          if (!undrawn.length && i % 8) continue;
          const dv = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]], dist = Math.hypot(dv[0], dv[1], dv[2]);
          if (dist > 220 || dist < 0.05) continue;
          ray.origin.set(eye[0], eye[1], eye[2]); ray.direction.set(dv[0] / dist, dv[1] / dist, dv[2] / dist);
          if (occ.raycastFirst(ray, T3.DoubleSide, 0, dist - 0.02)) continue;
          seen++;
          for (const s of undrawn) faults.set(`${op.id}:${s}`, `${op.id}: ${s} not drawn, seen from ${label}${open ? ' (doors open)' : ''}`);
        }
      });
    }
    console.info(`openings seen: ${poses.length} poses, ${n} openings, ${seen} seen, ${faults.size} faults`);
    expect(poses.length).toBeGreaterThan(900);
    expect(seen).toBeGreaterThan(600); // 876 measured: a sample of the 6822 openings seen from every pose
    expect([...faults.values()]).toEqual([]);
  }, 300_000);

  // The caves (castle/interior/caves.ts) are rooms of the same graph: from anywhere in them the whole cave
  // group is drawn (and from the great cavern, deep under the moat, the outdoors is not), and from anywhere in the two cellars that open into
  // them, near their doorway or across the room, the cave group is drawn too: graph steps, never distance.
  it('draws the caves by the room graph, from every point of their walks and of the cellars they open into', () => {
    const vis = makeVis(), caves = new Set(P.rooms.filter((r) => r.zone === CAVE_ZONE).map((r) => r.id));
    const gi = inner.groups.findIndex((g) => g.rooms.some((r) => caves.has(r)));
    expect(caves.size).toBeGreaterThanOrEqual(12);
    expect(inner.groups[gi].rooms.every((r) => caves.has(r))).toBe(true);
    const look = (eye: V3) => { cam.position = { x: eye[0], y: eye[1], z: eye[2] }; return vis.update(); };
    const bad: string[] = [];
    let n = 0;
    for (const id of caves) for (const w of caveWalk(P.caves!, id)) {
      const v = look([w[0], w[1] + 1.6, w[2]]); n++;
      if (!v.from.some((s) => caves.has(s))) bad.push(`${id} at (${w[0].toFixed(1)}, ${w[2].toFixed(1)}): camera in ${v.from.join(', ')}`);
      if (!v.visible[gi]) bad.push(`${id} at (${w[0].toFixed(1)}, ${w[2].toFixed(1)}): the cave group is not drawn`);
      if (id === 'cave-cavern' && !v.underground) bad.push('the outdoors is drawn from the great cavern');
      for (const c of caves) if (!v.drawn.has(c)) { bad.push(`${c} not drawn from ${id}`); break; }
    }
    for (const id of ['N-c1', 'great-c']) {
      const r = P.rooms.find((x) => x.id === id)!, xs = r.poly.map((q) => q[0]), zs = r.poly.map((q) => q[1]);
      for (let x = Math.min(...xs) + 0.4; x < Math.max(...xs); x += 1) for (let z = Math.min(...zs) + 0.4; z < Math.max(...zs); z += 1) {
        if (!pointInPoly(r.poly, x, z)) continue;
        const v = look([x, r.y0 + 1.6, z]); n++;
        if (!v.visible[gi]) bad.push(`caves not drawn from ${id} at (${x.toFixed(1)}, ${z.toFixed(1)})`);
      }
    }
    expect(n).toBeGreaterThan(60);
    expect(bad).toEqual([]);
  });

  it('draws the same spaces from the same place at every distance (a graph, no distance or facing test)', () => {
    const vis = makeVis();
    const by = new Map<string, { drawn: string; label: string }>(), faults: string[] = [];
    for (const { label, eye } of playerPoses()) {
      cam.position = { x: eye[0], y: eye[1], z: eye[2] };
      const st = vis.update(), key = [...st.from].sort().join('+'), drawn = [...st.drawn].sort().join(',');
      const was = by.get(key);
      if (!was) by.set(key, { drawn, label }); else if (was.drawn !== drawn) faults.push(`${key}: ${label} draws other spaces than ${was.label}`);
    }
    expect(by.has('courtyard') && by.has('outside') && by.has('gate-1')).toBe(true);
    expect(faults).toEqual([]);
    // from outdoors no room is drawn only because of a window: the rooms are those its doors and stairs reach
    const doorsOnly = roomGraph(P), outdoor: string[] = [];
    for (const [key, { drawn }] of by) {
      if (!key.split('+').every((s) => s === 'courtyard' || s === 'outside')) continue;
      const reach = drawnSpaces(doorsOnly, key.split('+'));
      outdoor.push(...drawn.split(',').filter((s) => !reach.has(s)).map((s) => `${s} drawn from ${key} through a window`));
    }
    expect(outdoor).toEqual([]);
    // what the graph is for: from the gate passage every room off the courtyard is drawn, from far outside too
    const courtRooms = P.doors.filter((d) => d.spaces.includes('courtyard') && d.id !== 'gate-court').map((d) => d.spaces.find((s) => s !== 'courtyard')!);
    const g = P.doors.find((d) => d.id === 'gate-court')!, q = on(g, 0, -(g.wall / 2 + 2));
    cam.position = { x: q[0], y: g.centre[1] + 1.7, z: q[1] }; vis.update();
    expect(vis.roomId).toBe('gate-1');
    expect(courtRooms.filter((r) => !vis.isRoomVisible(r))).toEqual([]);
  }, 300_000);

  // Frustum culling by room (render/interiorLight.ts tagGroups, world/visibility.ts tagBoxes): each interior
  // mesh is culled by its rooms' boxes instead of one sphere round its group. A cull layer may decide only
  // how something is drawn: so every triangle of every mesh lies in one of the mesh's boxes (a frustum that
  // reaches a triangle reaches its box), and from player poses no mesh with a vertex in view is culled.
  it('culls interior meshes by bounds that hold every triangle of their rooms', () => {
    baked(); // tags the triangles and gives each mesh its room boxes
    const meshes: THREE.Mesh[] = [];
    for (const g of inner.groups) g.object.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    const outside: string[] = [], v = new THREE.Vector3();
    let boxes = 0;
    for (const m of meshes) {
      const bs = m.userData.roomBoxes as THREE.Box3[];
      boxes += bs.length;
      const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        if (!bs.some((b) => b.distanceToPoint(v) < 1e-4)) { outside.push(`${m.name}: vertex ${i} outside its rooms' boxes`); break; }
      }
    }
    expect(meshes.length).toBeGreaterThan(250);
    expect(boxes).toBeGreaterThan(meshes.length); // most meshes hold several rooms
    expect(outside).toEqual([]);
    // from a sample of the player's poses, looking four ways: a mesh with a vertex in the view is not culled
    const culledInView: string[] = [], camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.25, 30000), fr = new THREE.Frustum(), pv = new THREE.Matrix4();
    let culled = 0;
    playerPoses().filter((_, i) => i % 60 === 0).forEach(({ label, eye }) => {
      for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        camera.position.set(...eye); camera.lookAt(eye[0] + dx, eye[1], eye[2] + dz); camera.updateMatrixWorld();
        fr.setFromProjectionMatrix(pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
        for (const m of meshes) {
          if (m.intersectsFrustum(fr)) continue;
          culled++;
          const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
          for (let i = 0; i < pos.count; i++) if (fr.containsPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld))) { culledInView.push(`${m.name} culled with a vertex in view from ${label}`); break; }
        }
      }
    });
    expect(culled).toBeGreaterThan(0);
    expect(culledInView).toEqual([]);
  }, 300_000);

  // The shut leaf sits in its rebate a few cm off the jambs (doorGeom LIP − GROW). Past it, round the
  // leaf, the eye must meet something drawn with its own side (the castle, its own room's reveal, the
  // stop, the leaf): never only the far room's geometry, which the graph may leave out (the white outline
  // round a shut door, 2026-11-07: the whole reveal was the first room's, culled from the other side).
  it('seals every shut leaf from both sides, whatever is drawn beyond it', () => {
    const castleB = bvhOf(castleSolid()), groupB = new Map(inner.groups.map((g) => [g, bvhOf(groupTris([g]))]));
    const faults: string[] = [], ray = new T3.Ray();
    let rays = 0;
    for (const d of P.doors) {
      const leaf = shutLeaf(d);
      if (!leaf) continue;
      const leafB = bvhOf(leaf.tris), y0 = d.centre[1];
      // the gap ring: halfway between the leaf's edge and the rebate, at the leaf (a back-swinging leaf fills its
      // rebate, its own outline: halfway from each rebate corner to the nearest point of the leaf's outline)
      const gap = d.swingsBack ? midway(cutAt(d, leaf.t, 0, P).slice(2), leafUV(d, leaf.ring)) : outlineGrown(P, d, (GROW + LIP) / 2).slice(2);
      for (const k of [0, 1] as const) {
        const s = d.spaces[k], sg = k === 0 ? -1 : 1;
        const sets = [castleB, leafB, ...inner.groups.filter((g) => !g.rooms.length || g.rooms.includes(s)).map((g) => groupB.get(g)!)]; // groups with no room are always drawn
        let bad = 0, first = '';
        for (const across of [-0.6, 0, 0.6]) for (const back of [1, 2.5]) {
          const e = on(d, across, sg * (d.wall / 2 + back)), eye = new T3.Vector3(e[0], y0 + 1.5, e[1]);
          for (const [u, y] of gap) {
            if (y < y0 + 0.15) continue;
            const p = on(d, u, leaf.t), tgt = new T3.Vector3(p[0], y, p[1]), dist = tgt.distanceTo(eye);
            ray.origin.copy(eye); ray.direction.copy(tgt).sub(eye).normalize();
            rays++;
            if (!sets.some((b) => b.raycastFirst(ray, T3.DoubleSide, 0, dist + 3))) { bad++; if (!first) first = `${across} aside, ${back} m back, gap at (${u.toFixed(2)}, ${(y - y0).toFixed(2)})`; }
          }
        }
        if (bad) faults.push(`${d.id}: open past its shut leaf from ${s} (${bad} rays, e.g. ${first})`);
      }
    }
    expect(rays).toBeGreaterThan(10_000);
    expect(faults).toEqual([]);
  }, 300_000);

  // Anders, 2026-11-07, of court>E0-2: "or is the positioning wrong?". One outline: the leaf is the clear
  // outline grown by GROW, the castle's hole and the reveal are the clear outline (test 3 above), the
  // rebate the clear outline grown by LIP. The shut leaf covers its hole and fits its rebate, every door.
  it('hangs every leaf over its own hole: it covers the clear outline and fits the rebate', () => {
    const faults: string[] = [];
    for (const d of P.doors) {
      const leaf = shutLeaf(d);
      if (!leaf) continue;
      const uniq = leafUV(d, leaf.ring);
      const short = outlineGrown(P, d, -0.01).filter(([u, y]) => y > d.centre[1] + leaf.sill + 0.01 && !pointInPoly(uniq, u, y));
      if (short.length) faults.push(`${d.id}: leaf short of its hole at (${short[0][0].toFixed(2)}, ${(short[0][1] - d.centre[1]).toFixed(2)})`);
      // the rebate at the leaf (a back-swinging leaf's is its own outline, FIT out: it has no stop)
      const reb = d.swingsBack ? cutAt(d, leaf.t, 0.002, P) : outlineGrown(P, d, LIP + 0.002), big = uniq.filter(([u, y]) => y > d.centre[1] + 0.05 && !pointInPoly(reb, u, y));
      if (big.length) faults.push(`${d.id}: leaf bigger than its rebate at (${big[0][0].toFixed(2)}, ${(big[0][1] - d.centre[1]).toFixed(2)})`);
      const sg = d.swingInto === 1 ? 1 : -1, tl = (leaf.t - sg * stopPlane(d)) * sg;
      if (tl < 0 || tl > 0.15) faults.push(`${d.id}: leaf ${tl.toFixed(3)} m off where its stop is (or would be)`);
    }
    expect(faults).toEqual([]);
  }, 120_000);

  // Anders, 2026-11-07: white slivers along the gate passage's inner threshold. Since the terrain has holes
  // under the buildings (#57) nothing was left under the 12 cm between the passage's sill and the paving
  // at the courtyard face. From both sides of every outdoor doorway, every ray down across the threshold
  // meets a floor, a riser or the ground: none reaches the sky.
  it('meets the ground at every outdoor doorway: no sky through the threshold', () => {
    const terrain = buildTerrain(new THREE.MeshBasicMaterial(), undefined, { holes: inner.groundHoles.terrain });
    const tt = trianglesOf({ bins: { t: { pos: meshPositions(terrain.getObjectByName('terrain-near')!) } } } as unknown as Builder);
    const faults: string[] = [], ray = new T3.Ray();
    let rays = 0;
    for (const d of P.doors) {
      if (!d.spaces.some((s) => OUTDOOR.has(s))) continue;
      const r = d.wall / 2 + 7, near = (t: Tri) => Math.hypot((t.lo[0] + t.hi[0]) / 2 - d.centre[0], (t.lo[2] + t.hi[2]) / 2 - d.centre[2]) < r + Math.hypot(t.hi[0] - t.lo[0], t.hi[2] - t.lo[2]) / 2;
      const occ = bvhOf([...castleSolid().filter(near), ...groupTris(inner.groups).filter(near), ...tt.filter(near)]);
      let bad = 0, first = '';
      for (const sg of [-1, 1]) for (const back of [1.5, 3, 5]) {
        const e = on(d, 0, sg * (d.wall / 2 + back)), eye = new T3.Vector3(e[0], d.centre[1] + 1.7, e[1]);
        // off the exact sill and faces: a ray down the joint of two coplanar floors meets neither
        for (let t = -d.wall / 2 - 1.013; t <= d.wall / 2 + 1; t += 0.04) for (let y = d.centre[1] - 0.093; y <= d.centre[1] + 0.3; y += 0.02) for (const u of [-d.width / 2 + 0.1, -d.width / 4, 0, d.width / 4, d.width / 2 - 0.1]) {
          const p = on(d, u, t), tgt = new T3.Vector3(p[0], y, p[1]);
          ray.origin.copy(eye); ray.direction.copy(tgt).sub(eye).normalize();
          rays++;
          // the ray runs on 7 m past the doorway: well down into the ground on either side
          if (!occ.raycastFirst(ray, T3.DoubleSide, 0, 12)) { bad++; if (!first) first = `${back} m ${sg < 0 ? 'before' : 'past'} it, at ${t.toFixed(2)} through, ${(y - d.centre[1]).toFixed(2)} up`; }
        }
      }
      if (bad) faults.push(`${d.id}: ${bad} rays to the sky through the threshold (e.g. from ${first})`);
    }
    expect(rays).toBeGreaterThan(50_000);
    expect(faults).toEqual([]);
  }, 300_000);

  // walking through a doorway: from 1 m before it to 1 m past it, in 5 cm steps, the rooms on both
  // sides stay drawn at every step (inside the wall's thickness the camera is in neither room)
  it('keeps both rooms of every doorway drawn while the camera walks through it', () => {
    const vis = makeVis();
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

  // Anders, 2026-11-08: looking down into a room through an open door it was dark; a few steps closer
  // its torch suddenly lit. The rig lit the 8 fires nearest the camera, each only within 1.6 × its range
  // (a wall torch: 11 m), so a drawn room further off had no firelight at all. Now each room's fires are
  // its row of the fire table (light/roomLight.ts), set as main.ts sets it: walking up to and through
  // every doorway, from 15 m out, every room the graph draws has all its torches, at the same
  // candela, and the firelight its walls get is the same at every pose.
  it('lights every drawn room with all its fires, the same from every pose', () => {
    const vis = makeVis(), index = baked().roomIndex;
    const groupOf = new Map<string, string>();
    for (const g of inner.groups) for (const id of g.rooms) groupOf.set(id, g.key);
    const fire = wallTorches(P, (id) => groupOf.get(id));
    const table = new FireTable(1024), byRoom = new Map<string, LightEmitter[]>();
    fire.holders.forEach((h, i) => { if (!byRoom.has(h.room)) byRoom.set(h.room, []); byRoom.get(h.room)!.push(fire.emitters[i]); });
    for (const [id, es] of byRoom) table.set(index.get(id)!, roomFires(P.rooms.find((r) => r.id === id)!, es)); // as main.ts
    // the firelight on a room's floor at its centre, as the shader sums it (flicker held: motion 0)
    table.update(0, 0);
    const centre = (id: string): V3 => { const r = P.rooms.find((x) => x.id === id)!; return [r.poly.reduce((a, p) => a + p[0], 0) / r.poly.length, r.y0 + 0.01, r.poly.reduce((a, p) => a + p[1], 0) / r.poly.length]; };
    const lightOf = (id: string) => { const row = index.get(id)!; return fireAt(table.fires(row).map((f, k) => ({ ...f, candela: f.candela * table.flick[row * MAX_FIRES + k] })), centre(id), [0, 1, 0]); };
    const ref = new Map([...byRoom.keys()].map((id) => [id, lightOf(id)]));
    const faults = new Map<string, string>();
    let poses = 0, checked = 0;
    for (const d of P.doors) {
      const reach = d.wall / 2 + 15;
      for (let t = -reach; t <= reach + 1e-9; t += 0.25) {
        const q = on(d, 0, t);
        cam.position = { x: q[0], y: d.centre[1] + 1.6, z: q[1] };
        vis.update(); poses++;
        for (const [id, es] of byRoom) {
          if (!vis.isRoomVisible(id)) continue;
          checked++;
          const row = index.get(id)!;
          if (table.fires(row).length !== es.length) faults.set(id, `${id}: ${table.fires(row).length} of ${es.length} fires lit from ${t.toFixed(2)} m off ${d.id}`);
          else if (Math.abs(lightOf(id) - ref.get(id)!) > 1e-9) faults.set(id, `${id}: firelight ${lightOf(id).toFixed(3)} ≠ ${ref.get(id)!.toFixed(3)} from ${t.toFixed(2)} m off ${d.id}`);
        }
      }
    }
    expect(fire.emitters.length).toBeGreaterThan(10);
    expect(poses).toBeGreaterThan(1000);
    expect(checked).toBeGreaterThan(5000);
    expect([...faults.values()]).toEqual([]);
  }, 120_000);

  // Anders, 2026-11-08 (live, WebGPU): the reveal of a courtyard door rendered pitch black beside the daylit
  // wall. Its outer half was tagged to the room behind, so it got that room's daylight through the shut
  // door (none) and no sun (the outdoor doorways use the underground set). Over every outdoor door of the
  // castle: the interior stone between the shut leaf (or the mid plane) and the courtyard takes the sky
  // (OUTDOOR_TAG), the stone behind the leaf its room.
  it('lights every outdoor doorway from the sky up to its leaf, and from its room behind it', () => {
    baked();
    const faults: string[] = [];
    let outer = 0, inside = 0;
    const outdoorDoors = P.doors.filter((d) => OUTDOOR.has(d.spaces[0]) !== OUTDOOR.has(d.spaces[1]));
    for (const g of inner.groups) g.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const pos = m.geometry.getAttribute('position'), tag = m.geometry.getAttribute('interiorRoom');
      for (let i = 0; i < pos.count; i += 3) {
        const c: V3 = [0, 1, 2].map((k) => (pos.getComponent(i, k) + pos.getComponent(i + 1, k) + pos.getComponent(i + 2, k)) / 3) as V3;
        for (const d of outdoorDoors) {
          const s = OUTDOOR.has(d.spaces[0]) ? -1 : 1, dx = c[0] - d.centre[0], dz = c[2] - d.centre[2];
          const leaf = d.leaf ? s * (d.swingInto === 1 ? 1 : -1) * (d.wall / 2 - d.rebate) : 0; // the shut leaf, outward from the mid plane
          const through = (dx * d.normal[0] + dz * d.normal[1]) * s, across = dx * d.along[0] + dz * d.along[1];
          if (Math.abs(across) > d.width / 2 + 0.15 || // the jambs, and a back-swinging leaf's recess (LIP beyond them)
             c[1] < d.centre[1] + 0.05 || c[1] > d.centre[1] + d.height) continue;
          if (through > leaf + 0.1 && through < d.wall / 2 - 0.02) { outer++; if (tag.getX(i) !== OUTDOOR_TAG) faults.push(`${d.id}: outer reveal tagged ${tag.getX(i)}`); }
          if (through < leaf - 0.1 && through > -d.wall / 2 + 0.02) { inside++; if (tag.getX(i) < 0) faults.push(`${d.id}: inner reveal tagged ${tag.getX(i)}`); }
        }
      }
    });
    expect(faults.slice(0, 10)).toEqual([]);
    expect(outer).toBeGreaterThan(10);
    expect(inside).toBeGreaterThan(10);
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
