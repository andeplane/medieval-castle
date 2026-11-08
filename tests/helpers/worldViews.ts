// Shared by the whole-castle checks (tests/world.test.ts, tests/world-views.test.ts): the castle's triangles,
// and the player's poses, the openings and the shut leaves as both files' visibility checks see them.
import * as THREE from 'three/webgpu';
import type { Builder } from '../../src/castle/builder';
import type { DoorSpec, InteriorGroup } from '../../src/castle/interior/types';
import type { buildInterior } from '../../src/castle/interior';
import type { PlanX } from '../../src/castle/interior/plan';
import { outerFootprint } from '../../src/castle/interior/plan';
import { placeLeaves, leafPoint, leafSwing, leafDepth, leafHead, leafClassFor } from '../../src/castle/interior/doorGeom';
import { caveSpan, CAVE_ZONE } from '../../src/castle/interior/caves';
import { heightAt } from '../../src/world/terrain';
import { pointInPoly, type V2 } from '../../src/core/math2d';
import { bakeInteriorLight, createInteriorLight } from '../../src/render/interiorLight';
import type { WindowInput } from '../../src/render/interiorMath';
import { createVisibility } from '../../src/world/visibility';
import { PAVE_Y } from '../../src/castle/paving';
import { WINGS } from '../../src/castle/spec';
import { courtyard, stairTowerPoly } from '../../src/castle/layout';
import { rayIndex } from './rays';

export type V3 = [number, number, number];
export const OUTDOOR = new Set(['courtyard', 'outside']);
/** Plan point at (across, through) of a door: along its wall and along its normal. */
export const on = (d: DoorSpec, across: number, through: number): V2 => [d.centre[0] + d.along[0] * across + d.normal[0] * through, d.centre[2] + d.along[1] * across + d.normal[1] * through];
/** The castle's triangles (after the interior's carve), each with its bounding box. */
export interface Tri { a: V3; b: V3; c: V3; lo: V3; hi: V3 }
export function trianglesOf(B: Builder): Tri[] {
  const out: Tri[] = [];
  for (const bin of Object.values(B.bins) as { pos: number[] }[]) for (let i = 0; i < bin.pos.length; i += 9) {
    const a = bin.pos.slice(i, i + 3) as V3, b = bin.pos.slice(i + 3, i + 6) as V3, c = bin.pos.slice(i + 6, i + 9) as V3;
    out.push({ a, b, c, lo: [0, 1, 2].map((k) => Math.min(a[k], b[k], c[k])) as V3, hi: [0, 1, 2].map((k) => Math.max(a[k], b[k], c[k])) as V3 });
  }
  return out;
}
export const mkTri = (a: V3, b: V3, c: V3): Tri => ({ a, b, c, lo: [0, 1, 2].map((j) => Math.min(a[j], b[j], c[j])) as V3, hi: [0, 1, 2].map((j) => Math.max(a[j], b[j], c[j])) as V3 });
/** A BVH over triangles, for rays: `hits(ray, near, far)` as three-mesh-bvh's raycastFirst (helpers/rays.ts, ~4× faster under coverage). */
export const bvhOf = (tris: Tri[]) => rayIndex(tris);
export function groupTris(gs: InteriorGroup[]): Tri[] {
  const B = { bins: {} as Record<string, { pos: number[] }> };
  gs.forEach((g, i) => g.object.traverse((o) => { if ((o as THREE.Mesh).isMesh) B.bins[`${i}:${o.name}`] = { pos: Array.from(((o as THREE.Mesh).geometry.getAttribute('position') as THREE.BufferAttribute).array) }; }));
  return trianglesOf(B as unknown as Builder);
}

/** The castle as the checks see it: set once the castle and its interior are built (beforeAll). */
export interface WorldFixture { P: PlanX; B: Builder; inner: ReturnType<typeof buildInterior>; lights: WindowInput[] }

/** The player's poses, the openings and the shut leaves, for the visibility checks (call `set` in beforeAll). */
export function worldViews() {
  let P!: PlanX, B!: Builder, inner!: ReturnType<typeof buildInterior>, lights!: WindowInput[];
  const set = (f: WorldFixture) => { ({ P, B, inner, lights } = f); };
  const cam = { position: { x: 0, y: 0, z: 0 } };
  let bakeCache: ReturnType<typeof bakeInteriorLight> | undefined;
  const baked = () => (bakeCache ??= bakeInteriorLight(inner.groups, { blocked: () => false }, { plan: P, windows: lights, sun: () => ({ dir: [-0.4, 0.63, 0.66], irradiance: [3, 3, 3] }), light: createInteriorLight() }));
  const court = courtyard(), roofs = Math.min(...WINGS.map((w) => w.top));
  const inCourt = (x: number, z: number) => pointInPoly(court, x, z);
  /** The visibility as main.ts makes it. */
  const makeVis = () => createVisibility(cam, inner.groups, P, { apertures: baked().apertures, ground: heightAt, court: inCourt, roofs });
  /** The castle as drawn, less its window glass (you see through it). */
  let solidCache: Tri[] | undefined, groupCache: Tri[] | undefined;
  const castleSolid = () => (solidCache ??= trianglesOf({ bins: Object.fromEntries(Object.entries(B.bins).filter(([k]) => k !== 'glass')) } as unknown as Builder));
  /** Every interior group's triangles (built once: the checks below only read them). */
  const allGroupTris = () => (groupCache ??= groupTris(inner.groups));
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
  return { set, cam, baked, makeVis, castleSolid, allGroupTris, shutLeaf, openingsOf, playerPoses };
}
