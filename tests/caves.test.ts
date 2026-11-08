// The caves under the north moat (castle/interior/caves.ts plan, caveGeom.ts rock): a pure function of the
// seed, rooms and openings of the interior plan, deep under the moat, with walkable floors and headroom
// along every walk. The walk itself, through every chamber with the player's motor, is in keypaths.test.ts.
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three/webgpu';
import * as T3 from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { planInterior, validatePlan, type PlanX } from '../src/castle/interior/plan';
import { buildInterior, type InteriorResult } from '../src/castle/interior/index';
import { caveSpan, caveWalk, fireSpot, passageFrame, passageFloor, ellipseRadius, poolDepth, isCave, CAVE_ZONE, type CavePlan } from '../src/castle/interior/caves';
import { caveField, caveRock, behindPortal, surfaceNets, poolDisc, stepBlocks, caveFires, caveRampSoups, cacheLayout, fungiSpots, fallenBlocks, speleothems, buildCaves, primeCaveRock, rockOpenness, bakePartOpenness, bakeFungiLight, caveShading, FUNGI_REACH, CAVE_CELL, TIP_CLEAR } from '../src/castle/interior/caveGeom';
import { caveRockOffThread, packCaveRock, type CaveWorker } from '../src/castle/interior/caveOffThread';
import { Builder } from '../src/castle/builder';
import { interiorViews } from '../src/camera/interiorViews';
import { navGraph, findPath, doorsOnWayToCaves } from '../src/castle/interior/nav';
import { roomGraph, drawnSpaces } from '../src/world/visibility';
import { islandOutline, moatOuter } from '../src/castle/layout';
import { pointInPoly, type V2 } from '../src/core/math2d';
import { heightAt } from '../src/world/terrain';
import { buildCastle } from '../src/castle/castle';
import { CARRIED_LANTERN, lanternAt, lanternLit, lanternFire } from '../src/player/lantern';
import { fireAt, firesByRoom } from '../src/light/roomLight';
import { mats } from './world';

type V3 = [number, number, number];
/** A vertex of an open edge sits within a cell of where its quads were left out. */
let portalB: ReturnType<typeof behindPortal> | null = null;
const closeBehind = (pos: ArrayLike<number>, i: number) => {
  const b = (portalB ??= behindPortal(planInterior().caves!));
  for (const dx of [-0.4, 0, 0.4]) for (const dz of [-0.4, 0, 0.4]) for (const dy of [-0.4, 0, 0.4]) if (b(pos[3 * i] + dx, pos[3 * i + 1] + dy, pos[3 * i + 2] + dz)) return true;
  return false;
};
let P: PlanX, C: CavePlan;
beforeAll(() => { P = planInterior(); C = P.caves!; });

describe('cave plan', () => {
  it('is part of the interior plan: rooms, natural openings and two doorways from different cellars', () => {
    expect(validatePlan(P).errors).toEqual([]);
    const caves = P.rooms.filter(isCave);
    expect(caves.length).toBe(C.chambers.length + C.passages.length);
    expect(C.chambers.length).toBeGreaterThanOrEqual(7);
    for (const id of C.openings) {
      const d = P.doors.find((x) => x.id === id)!;
      expect(d.leaf).toBe(false);
      expect(d.spaces.every((s) => P.rooms.find((r) => r.id === s)?.zone === CAVE_ZONE)).toBe(true);
    }
    // the castle doorways: one into the entrance from the N cellar, one out of the far end into the great tower's cellar
    const portals = P.doors.filter((d) => !C.openings.includes(d.id) && d.spaces.some((s) => s.startsWith('cave')));
    expect(portals.map((d) => d.spaces)).toEqual([['N-c1', C.entrance], ['great-c', C.exit]]);
    for (const d of portals) expect(d.leaf).toBe(false);
  });

  it('is a pure function of the seed, and valid for other seeds', () => {
    expect(JSON.stringify(planInterior().caves)).toBe(JSON.stringify(C));
    for (const seed of [2, 77, 4242]) {
      const Q = planInterior(seed);
      expect(validatePlan(Q).errors).toEqual([]);
      expect(JSON.stringify(Q.caves)).not.toBe(JSON.stringify(C));
    }
  });

  it('runs under the moat, 6–14 m under the water, with a great cavern, a pool, a squeeze, a drop and two dead ends with finds', () => {
    const isl = islandOutline(), moat = moatOuter(isl);
    const underMoat = C.chambers.filter((k) => !pointInPoly(isl, k.c[0], k.c[1]) && pointInPoly(moat, k.c[0], k.c[1]));
    expect(underMoat.length).toBeGreaterThanOrEqual(2);
    for (const k of underMoat) { expect(k.y).toBeLessThanOrEqual(-6); expect(k.y).toBeGreaterThanOrEqual(-14); }
    const big = [...C.chambers].sort((a, b) => b.a * b.b - a.a * a.b)[0];
    expect(big.id).toBe('cave-cavern');
    expect(Math.PI * big.a * big.b).toBeGreaterThan(200);
    expect(big.h).toBeGreaterThan(5);
    expect(big.pool).toBeTruthy();
    expect(C.passages.filter((p) => p.w < 1.2)).toHaveLength(1); // the squeeze
    const drop = C.passages.find((p) => p.steps)!;
    expect(drop.from[1] - drop.to[1]).toBeGreaterThan(3.5);
    // dead ends: chambers with one opening, each with something to find
    const degree = (id: string) => P.doors.filter((d) => d.spaces.includes(id)).length;
    const dead = C.chambers.filter((k) => degree(k.id) === 1).map((k) => k.id).sort();
    expect(dead).toEqual(['cave-cache', 'cave-ossuary']);
    for (const id of dead) expect(C.features.some((f) => f.room === id)).toBe(true);
    expect(C.features.map((f) => f.kind).sort()).toEqual(['bones', 'bones', 'cache', 'fire', 'lantern', 'lost-lantern', 'shrine']);
  });

  it('keeps every ceiling under the ground and the moat bed above it', () => {
    for (const r of P.rooms.filter(isCave)) for (const q of r.poly) {
      const s = caveSpan(C, r.id, [q[0] * 0.98 + r.poly[0][0] * 0.02, q[1] * 0.98 + r.poly[0][1] * 0.02])!;
      expect(s.ceil + 0.5, `${r.id}`).toBeLessThan(heightAt(q[0], q[1]));
    }
  });

  it('caveSpan, caveWalk and the helpers', () => {
    expect(caveSpan(C, 'N-c1', [0, 0])).toBeNull();
    const k = C.chambers.find((c) => c.pool)!;
    expect(caveSpan(C, k.id, k.pool!.c)!.floor).toBeCloseTo(k.y - k.pool!.depth, 5);
    expect(poolDepth(k, [k.pool!.c[0] + k.pool!.r * 2, k.pool!.c[1]])).toBe(0);
    expect(poolDepth(C.chambers.find((c) => !c.pool)!, [0, 0])).toBe(0);
    expect(ellipseRadius(k, k.axis)).toBeCloseTo(k.a, 6);
    const p = C.passages[0], { L } = passageFrame(p);
    expect(passageFloor(p, -1)).toBe(p.from[1]);
    expect(passageFloor(p, L + 1)).toBe(p.to[1]);
    const w = caveWalk(C, p.id);
    expect(w[0]).toEqual(p.from); expect(w[w.length - 1][1]).toBeCloseTo(p.to[1], 6);
    expect(caveWalk(C, k.id)).toEqual([[k.c[0], k.y, k.c[1]]]);
    const drop = C.passages.find((x) => x.steps)!, mid = passageFrame(drop);
    const q: V2 = [mid.a[0] + mid.u[0] * mid.L / 2, mid.a[1] + mid.u[1] * mid.L / 2];
    expect(caveSpan(C, drop.id, q)!.floor).toBeCloseTo(passageFloor(drop, mid.L / 2) - (drop.from[1] - drop.to[1]) / drop.steps!, 6);
  });

  it('draws the cave from its cellars by graph steps, and the cellars from the cave', () => {
    const g = roomGraph(P);
    const fromCellar = drawnSpaces(g, ['N-c1']);
    expect(fromCellar.has(C.entrance)).toBe(true);
    const fromCavern = drawnSpaces(g, ['cave-cavern']);
    for (const r of P.rooms.filter(isCave)) expect(fromCavern.has(r.id)).toBe(true); // every opening is open
    expect(fromCavern.has('N-c1') && fromCavern.has('great-c')).toBe(true);
  });

  it('stands open the way in from the courtyard and the cellar stair\'s top door, and never opens the caves to the outdoors', () => {
    const ids = doorsOnWayToCaves(P), path = findPath(navGraph(P), 'courtyard', C.entrance)!;
    expect(ids).toEqual(['court>N0-4', 'N0-3>N-cellarstair']); // in from the courtyard, and the cellar stair's top door
    for (const id of ids) expect(path.doors).toContain(id);
    expect(path.doors).toContain('N-cellarstair>N-c1'); // the stair's foot door stays as it is
    expect(path.doors).toContain('N0-3>N0-4'); // and so does the one between
    expect(doorsOnWayToCaves({ ...P, caves: null })).toEqual([]);
    // with them open, every cave room draws at most one room more than with them shut and nothing outdoors
    // it did not already (the climb sees out through the great tower's open tunnels): no castle under the moat
    const g = roomGraph(P), open = new Set(ids);
    for (const r of P.rooms.filter(isCave)) {
      const shut = drawnSpaces(g, [r.id], 2), seen = drawnSpaces(g, [r.id], 2, (d) => open.has(d));
      const added = [...seen].filter((s) => !shut.has(s));
      expect(added).not.toContain('courtyard'); expect(added).not.toContain('outside');
      expect(added.length).toBeLessThanOrEqual(1); // the breach: the stair top's room; the climb: N0-4 off the courtyard it already drew
    }
    expect(drawnSpaces(g, ['cave-cavern'], 2, (d) => open.has(d))).toEqual(drawnSpaces(g, ['cave-cavern'], 2));
  });

  it('is on the nav graph: from the N cellar to the cavern and on to the great tower', () => {
    const G = navGraph(P);
    const a = findPath(G, 'N-c1', 'cave-cavern')!, b = findPath(G, 'cave-cavern', 'great-c')!;
    expect(a.nodes).toContain('room:cave-squeeze');
    expect(a.nodes).toContain('room:cave-drop');
    expect(b.nodes).toContain('room:cave-climb');
  });
});

describe('cave rock', () => {
  let res: InteriorResult, bvh: MeshBVH;
  beforeAll(() => {
    res = buildInterior(mats(), buildCastle().builder, { heightAt, plan: P });
    const g = res.groups.find((x) => x.key === 'cave:-1')!;
    const soup: number[] = [];
    g.object.updateMatrixWorld(true);
    const add = (a: ArrayLike<number>) => { for (let i = 0; i < a.length; i++) soup.push(a[i]); };
    for (const m of g.object.children as THREE.Mesh[]) if (!/pool|glow/.test(m.name)) add(m.geometry.attributes.position.array);
    for (const c of res.collision) if (c.name.startsWith('ramp:cave')) add(c.attributes.position.array);
    const geo = new T3.BufferGeometry(); geo.setAttribute('position', new T3.BufferAttribute(new Float32Array(soup), 3));
    bvh = new MeshBVH(geo);
  }, 120_000);

  const cast = (o: V3, dir: V3, far: number) => {
    const r = new T3.Ray(new T3.Vector3(...o), new T3.Vector3(...dir));
    return bvh.raycastFirst(r, T3.DoubleSide, 0, far);
  };
  /** Points every 0.5 m along every walk (passages: their lines; chambers: across both axes through the centre). */
  const walkPoints = (): { room: string; p: V3 }[] => {
    const out: { room: string; p: V3 }[] = [];
    for (const p of C.passages) {
      const { a, u, L } = passageFrame(p);
      for (let t = 0.2; t < L - 0.1; t += 0.5) out.push({ room: p.id, p: [a[0] + u[0] * t, passageFloor(p, t), a[1] + u[1] * t] });
    }
    for (const k of C.chambers) for (const ax of [k.axis, [-k.axis[1], k.axis[0]] as V2]) {
      const R = ellipseRadius(k, ax) * 0.55;
      for (let s = -R; s <= R; s += 0.5) {
        const q: V2 = [k.c[0] + ax[0] * s, k.c[1] + ax[1] * s];
        if (poolDepth(k, q) > 0) continue; // the pool is waded around, not walked through
        if (C.features.some((f) => f.room === k.id && Math.hypot(f.at[0] - q[0], f.at[2] - q[1]) < 1.6)) continue; // nor are the finds
        out.push({ room: k.id, p: [q[0], k.y, q[1]] });
      }
    }
    return out;
  };

  it('is one closed, inward-facing soup in the rock bin', () => {
    const R = caveRock(C, P.seed);
    expect(R.tris.length / 3).toBeGreaterThan(10_000);
    expect(caveRock(C, P.seed)).toBe(R); // cached
    // every vertex lies on the field's zero surface (within a cell) and its normal points into the air
    const F = caveField(C, P.seed), off: number[] = [];
    for (let i = 0; i < R.pos.length; i += 3 * 37) {
      const p = [R.pos[i], R.pos[i + 1], R.pos[i + 2]], n = [R.nor[i], R.nor[i + 1], R.nor[i + 2]];
      if (!(Math.abs(F.f(p[0], p[1], p[2])) < CAVE_CELL)) off.push(i / 3);
      if (!(F.f(p[0] + n[0] * 0.3, p[1] + n[1] * 0.3, p[2] + n[2] * 0.3) < F.f(p[0] - n[0] * 0.3, p[1] - n[1] * 0.3, p[2] - n[2] * 0.3))) off.push(i / 3);
    }
    expect(off).toEqual([]);
    // closed: no edge is open (every edge has a triangle on each side)
    const edges = new Map<string, number>();
    for (let t = 0; t < R.tris.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = R.tris[t + e], b = R.tris[t + (e + 1) % 3], k = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
    // (a few non-manifold corners share 4); open only at the two doorways, in the wall behind the collars
    const behind = behindPortal(C), open = [...edges].filter(([, c]) => c % 2 !== 0).map(([k]) => k.split(',').map(Number));
    expect(open.length).toBeGreaterThan(20);
    expect(open.flat().filter((i) => !(behind(R.pos[3 * i], R.pos[3 * i + 1], R.pos[3 * i + 2]) || closeBehind(R.pos, i)))).toEqual([]);
    const g = res.groups.find((x) => x.key === 'cave:-1')!;
    expect(g.rooms.sort()).toEqual(P.rooms.filter(isCave).map((r) => r.id).sort());
    expect((g.object.children as THREE.Mesh[]).map((m) => m.name).sort()).toEqual(['glow', 'iron', 'pool', 'rock', 'trim', 'wood'].map((k) => `interior-cave:-1-${k}`));
  }, 120_000);

  it('shows no gap from any cave view: every ray of a 64 × 36 grid meets a front face (no culled slivers)', () => {
    // what the renderer draws of the caves, front faces only
    const g = res.groups.find((x) => x.key === 'cave:-1')!, soup: number[] = [];
    for (const m of g.object.children as THREE.Mesh[]) { const a = m.geometry.attributes.position.array; for (let i = 0; i < a.length; i++) soup.push(a[i]); }
    const geo = new T3.BufferGeometry(); geo.setAttribute('position', new T3.BufferAttribute(new Float32Array(soup), 3));
    const seen = new MeshBVH(geo), missed: string[] = [];
    for (const v of interiorViews(P).filter((x) => ['caves', 'cave-wall', 'cave-squeeze', 'cave-drop', 'cave-steps', 'cave-ossuary', 'cave-cache', 'cave-pool'].includes(x.name))) {
      const cam = new T3.PerspectiveCamera(55, 16 / 9, 0.05, 500);
      cam.position.set(...v.pos); cam.lookAt(...v.target); cam.updateMatrixWorld();
      const rc = new T3.Raycaster();
      for (let i = 0; i < 64; i++) for (let j = 0; j < 36; j++) {
        rc.setFromCamera(new T3.Vector2(((i + 0.5) / 64) * 2 - 1, ((j + 0.5) / 36) * 2 - 1), cam);
        if (!seen.raycastFirst(rc.ray, T3.FrontSide, 0, 200)) missed.push(`${v.name} (${i}, ${j})`);
      }
    }
    expect(missed).toEqual([]);
  });

  it('surface nets: a sphere is closed and the right size', () => {
    const S = surfaceNets((x, y, z) => Math.hypot(x, y, z) - 2, [-2.5, -2.5, -2.5], [2.5, 2.5, 2.5], 0.25);
    for (let i = 0; i < S.pos.length; i += 3) expect(Math.abs(Math.hypot(S.pos[i], S.pos[i + 1], S.pos[i + 2]) - 2)).toBeLessThan(0.05);
    expect(S.tris.length % 3).toBe(0);
  });

  it('has a walkable floor under every walk point, within 0.3 m of the plan and no steeper than the motor climbs', () => {
    const bad: string[] = [];
    const pts = walkPoints();
    expect(pts.length).toBeGreaterThan(200);
    for (const { room, p } of pts) {
      const h = cast([p[0], p[1] + 1.0, p[2]], [0, -1, 0], 2.5);
      if (!h) { bad.push(`${room} (${p[0].toFixed(1)}, ${p[2].toFixed(1)}): no floor`); continue; }
      const dy = h.point.y - p[1], n = h.face!.normal;
      if (Math.abs(dy) > 0.3) bad.push(`${room} (${p[0].toFixed(1)}, ${p[2].toFixed(1)}): floor ${dy.toFixed(2)} m off`);
      if (Math.abs(n.y) < Math.cos((48 * Math.PI) / 180)) bad.push(`${room} (${p[0].toFixed(1)}, ${p[2].toFixed(1)}): floor at ${(Math.acos(Math.abs(n.y)) * 180 / Math.PI).toFixed(0)}°`);
    }
    expect(bad).toEqual([]);
  });

  it('has at least 2 m of headroom along every walk', () => {
    const bad: string[] = [];
    for (const { room, p } of walkPoints()) {
      const h = cast([p[0], p[1] + 0.05, p[2]], [0, 1, 0], 2.0);
      if (h) bad.push(`${room} (${p[0].toFixed(1)}, ${p[2].toFixed(1)}): ${(h.distance + 0.05).toFixed(2)} m`);
    }
    expect(bad).toEqual([]);
  });

  it('is wide enough to pass everywhere along the walks (the squeeze too)', () => {
    const bad: string[] = [];
    for (const p of C.passages) {
      const { a, u, L } = passageFrame(p), s: V3 = [-u[1], 0, u[0]];
      for (let t = 0.3; t < L - 0.2; t += 0.5) for (const y of [0.4, 1.2, 1.7]) {
        const o: V3 = [a[0] + u[0] * t, passageFloor(p, t) + y, a[1] + u[1] * t];
        const l = cast(o, [-s[0], 0, -s[2]], 2), r = cast(o, s, 2);
        const w = (l?.distance ?? 2) + (r?.distance ?? 2);
        if (w < 0.75) bad.push(`${p.id} at ${t.toFixed(1)} m, ${y} m up: ${w.toFixed(2)} m`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('builds the steps, the pool, the fungi, the finds, the ramps and the lantern', () => {
    const drop = C.passages.find((p) => p.steps)!, blocks = stepBlocks(drop, P.seed);
    expect(blocks).toHaveLength(drop.steps! - 1);
    for (let i = 1; i < blocks.length; i++) expect(blocks[i].c[1]).toBeLessThan(blocks[i - 1].c[1]);
    const k = C.chambers.find((c) => c.pool)!, disc = poolDisc(k);
    expect(disc.y).toBeLessThan(k.y);
    for (const q of disc.pts) expect(poolDepth(k, q)).toBeLessThan(0.14 + 0.1); // the rim tucks under the basin's slope
    expect(fungiSpots(caveRock(C, P.seed), C, P.seed).length).toBeGreaterThan(20);
    const ramps = caveRampSoups(C);
    expect(ramps.map((r) => r.id)).toEqual([drop.id]);
    expect(ramps[0].soup).toHaveLength(18);
    const f = caveFires(C, 'cave:-1'), lantern = C.features.find((x) => x.kind === 'lantern')!;
    expect(f.emitters.map((e) => e.kind)).toEqual(['lantern', 'brazier']);
    expect(f.group).toEqual(['cave:-1', 'cave:-1']);
    expect(f.flames[0].base[1]).toBeGreaterThan(cacheLayout(lantern.at, lantern.dir).lantern[1]);
  });

  it('lights the great cavern with the smugglers\' fire: by the pool, clear of it, of every walk and of the finds', () => {
    const k = C.chambers.find((c) => c.id === 'cave-cavern')!, fire = C.features.find((x) => x.kind === 'fire')!;
    expect(fire.room).toBe(k.id);
    const q: V2 = [fire.at[0], fire.at[2]], dPool = Math.hypot(q[0] - k.pool!.c[0], q[1] - k.pool!.c[1]);
    expect(dPool).toBeGreaterThan(k.pool!.r + 1); expect(dPool).toBeLessThan(k.pool!.r + 2);
    expect(poolDepth(k, q)).toBe(0);
    for (const p of C.passages) for (const [i, e] of p.ends.entries()) if (e === k.id) {
      const m = i ? p.to : p.from, a: V2 = [m[0], m[2]], d: V2 = [k.c[0] - a[0], k.c[1] - a[1]], L2 = d[0] ** 2 + d[1] ** 2;
      const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1]) / L2));
      expect(Math.hypot(q[0] - a[0] - d[0] * t, q[1] - a[1] - d[1] * t)).toBeGreaterThan(1.5);
    }
    for (const o of C.features) if (o !== fire) expect(Math.hypot(o.at[0] - q[0], o.at[2] - q[1])).toBeGreaterThan(2.4);
    // nothing fallen or grown on it
    for (const b of fallenBlocks(C, P.seed)) expect(Math.hypot(b.c[0] - q[0], b.c[2] - q[1])).toBeGreaterThan(1.6);
    for (const s of speleothems(caveRock(C, P.seed), C, P.seed)) if (s.dir === 1) expect(Math.hypot(s.base[0] - q[0], s.base[2] - q[1])).toBeGreaterThan(1.6);
    // a real fire for src/light (the brazier profile), its light half a metre over the logs
    const e = caveFires(C, 'g').emitters.find((x) => x.kind === 'brazier')!;
    expect(e.position).toEqual([fire.at[0], fire.at[1] + 0.5, fire.at[2]]);
    // and what the shaders know: the pool's water level and the fire
    const sh = caveShading(C);
    expect(sh.pool).toEqual([k.pool!.c[0], poolDisc(k).y, k.pool!.c[1], k.pool!.r]);
    expect(sh.fire).toEqual([...e.position, e.intensity]);
    const none = caveShading({ ...C, chambers: C.chambers.map((c) => ({ ...c, pool: undefined })), features: [] });
    expect(none.pool[3]).toBe(0); expect(none.fire[1]).toBeLessThan(-1000);
    expect(fireSpot({ ...k, pool: undefined }, C.passages, C.features)).toBeNull();
    // each cave fire is the fire of the room it stands in (no holder: by position), so it lights the room
    // the camera is in there; the caves have no furniture, so main.ts keeps these with furniture too
    const byRoom = firesByRoom(P.rooms, caveFires(C, 'g').emitters);
    expect(byRoom.get('cave-cavern')?.map((x) => x.kind)).toEqual(['brazier']);
    expect([...byRoom.keys()].every((id) => isCave(P.rooms.find((r) => r.id === id)!))).toBe(true);
    expect([...byRoom.values()].flat().length).toBe(caveFires(C, 'g').emitters.length);
  });

  it('bakes how open the rock is: 1 on open ground, less in a slot and under a shelf', () => {
    const floor = (_x: number, y: number) => -y; // air above y = 0
    const slot = (x: number) => Math.abs(x) - 0.4; // a slot 0.8 m wide
    const shelf = (x: number, y: number) => Math.max(-y, Math.min(y - 0.6, 1.6 - y, 2 - x)); // and an overhang of rock 0.6 m over it
    const at = (f: (x: number, y: number, z: number) => number, p: V3, n: V3) => rockOpenness(f, p, n)[0];
    expect(at(floor, [0, 0, 0], [0, 1, 0])).toBeGreaterThan(0.95);
    expect(at(slot, [-0.4, 0, 0], [1, 0, 0])).toBeLessThan(0.7); // open only along the slot
    expect(at(shelf, [0, 0, 0], [0, 1, 0])).toBeLessThan(at(floor, [0, 0, 0], [0, 1, 0]) - 0.3);
    // the cave's own: all in 0..1, the open floors of the cavern near 1, and some real recesses
    const R = caveRock(C, P.seed);
    expect(R.open.length).toBe(R.pos.length / 3);
    let low = 0;
    for (let i = 0; i < R.open.length; i++) { expect(R.open[i]).toBeGreaterThanOrEqual(0); expect(R.open[i]).toBeLessThanOrEqual(1); if (R.open[i] < 0.8) low++; }
    expect(low).toBeGreaterThan(R.open.length * 0.1);
    const k = C.chambers.find((c) => c.id === 'cave-cavern')!;
    let best = 0;
    for (let i = 0; i < R.open.length; i++) if (R.nor[3 * i + 1] > 0.9 && Math.hypot(R.pos[3 * i] - k.c[0], R.pos[3 * i + 2] - k.c[1]) < 2) best = Math.max(best, R.open[i]);
    expect(best).toBeGreaterThan(0.9);
  });

  it('bakes the openness of the rock that is not the soup from the same field (no lighter blocks against a recess)', () => {
    const floor = (_x: number, y: number) => -y;
    const bin = { pos: [0, 0, 0, 0, 0, 0, 0, -3, 0], nor: [0, 1, 0, 0, 1, 0, 0, 1, 0], uv: [0.3, 0.2, 0.8, 0.4, 0.8, 0] };
    bakePartOpenness(bin, 1, floor);
    expect(bin.uv[0]).toBe(0.3);                  // the soup's own is left
    expect(bin.uv[2]).toBeGreaterThan(0.95);      // on open ground
    expect(bin.uv[4]).toBeLessThan(0.05);         // 3 m down in the rock
    expect([bin.uv[3], bin.uv[5]]).toEqual([0.4, 0]); // the fungi light is left
    // the whole cave: every block, cone, collar and step vertex is the field's, so none is the old fixed 0.8
    const B = new Builder(), R = caveRock(C, P.seed);
    buildCaves(B, C, P.seed, []);
    const bin2 = B.bins.rock, from = R.tris.length, f = caveField(C, P.seed).f;
    const n = bin2.pos.length / 3 - from;
    expect(n).toBeGreaterThan(1000);
    const want = rockOpenness(f, bin2.pos.slice(3 * from), bin2.nor.slice(3 * from));
    let off = 0;
    for (let i = 0; i < n; i++) if (Math.abs(bin2.uv[2 * (from + i)] - want[i]) > 1e-6) off++;
    expect(off).toBe(0);
    expect(want.filter((o) => o < 0.6).length).toBeGreaterThan(n * 0.05);
  });

  it('bakes the fungi light from nearby clusters only, on faces turned their way', () => {
    const bin = { pos: [0, 0, 0, 0, 0, 0, 3, 0, 0], nor: [0, 0, 1, 0, 0, -1, 0, 0, 1], uv: [0.5, 0, 0.5, 0, 0.5, 0] };
    bakeFungiLight(bin, [{ p: [0, 0, 0], n: [0, 0, 1] }, { p: [0.1, 0, 0], n: [0, 0, 1] }]);
    expect(bin.uv[1]).toBe(1); // two clusters on it: full, clamped
    expect(bin.uv[3]).toBe(0); // the back of the same point: none
    expect(bin.uv[5]).toBeLessThan(1e-6); // 3 m away: none
    expect(bin.uv[0]).toBe(0.5); // the openness is left as it was
  });
});

describe('the carried lantern', () => {
  it('hangs low, ahead and to the right, lit only in the caves', () => {
    const p = lanternAt([0, 1.6, 0], [0, -0.3, -2]); // looking north
    expect(p[0]).toBeGreaterThan(0.1); // east = right
    expect(p[2]).toBeLessThan(0);
    expect(p[1]).toBeCloseTo(1.05, 6);
    expect(lanternAt([0, 0, 0], [0, 1, 0])[1]).toBeCloseTo(-0.55, 6); // straight up: no plan direction, still placed
    const caves = new Set(['cave-hall']);
    expect(lanternLit(['cave-hall'], caves)).toBe(true);
    expect(lanternLit(['N-c1'], caves)).toBe(false);
    expect(CARRIED_LANTERN.kind).toBe('lantern');
    // its near field: the wall at a hand's breadth gets at most ~13× the light 4 m ahead (a flame-sized soft: ~80×)
    const f = lanternFire([0, 0, 0]), near = fireAt([f], [0.55, 0, 0]), far = fireAt([f], [4, 0, 0]);
    expect(near / far).toBeLessThan(15);
    expect(fireAt([{ ...f, soft: 0.15 }], [0.55, 0, 0]) / fireAt([{ ...f, soft: 0.15 }], [4, 0, 0])).toBeGreaterThan(50);
    expect(f.range).toBeGreaterThanOrEqual(8); expect(f.seed).toBe(lanternFire([5, 1, 2]).seed);
  });
});

describe('cave stone: ledges, fallen blocks, stalactites and stalagmites, fungi', () => {
  // the walks through a chamber: from each passage mouth on it to its centre (what keypaths.test.ts walks)
  const walkSegs = (k: CavePlan['chambers'][number]) => C.passages.flatMap((p) => p.ends.flatMap((e, i) => (e === k.id ? [[i === 0 ? [p.from[0], p.from[2]] : [p.to[0], p.to[2]], k.c] as [V2, V2]] : [])));
  const segDist = (q: V2, [a, b]: [V2, V2]) => {
    const d = [b[0] - a[0], b[1] - a[1]], L2 = d[0] * d[0] + d[1] * d[1];
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1]) / L2));
    return Math.hypot(q[0] - a[0] - d[0] * t, q[1] - a[1] - d[1] * t);
  };
  const chamberOf = (q: V2) => C.chambers.find((k) => Math.hypot(q[0] - k.c[0], q[1] - k.c[1]) < ellipseRadius(k, norm2([q[0] - k.c[0], q[1] - k.c[1]])))!;
  const norm2 = (v: V2): V2 => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };

  it('drops blocks along the chamber walls, on the floor and clear of every walk, the same for the same seed', () => {
    const B = fallenBlocks(C, P.seed);
    expect(B.length).toBeGreaterThanOrEqual(8);
    expect(fallenBlocks(C, P.seed)).toEqual(B);
    for (const b of B) {
      const q: V2 = [b.c[0], b.c[2]], k = chamberOf(q);
      expect(k).toBeTruthy();
      expect(b.c[1] - b.size[1] / 2).toBeLessThan(k.y); // sunk in the floor
      for (const s of walkSegs(k)) expect(segDist(q, s)).toBeGreaterThan(b.size[0] / 2 + 0.5);
    }
  });

  it('hangs stalactites no lower than the clearance over the floor, and stands stalagmites clear of the walks', () => {
    const S = speleothems(caveRock(C, P.seed), C, P.seed);
    const down = S.filter((s) => s.dir === -1), up = S.filter((s) => s.dir === 1);
    expect(down.length).toBeGreaterThan(20); expect(up.length).toBeGreaterThan(10);
    for (const s of down) {
      const k = chamberOf([s.base[0], s.base[2]]);
      expect(s.base[1] - s.len).toBeGreaterThanOrEqual(k.y + TIP_CLEAR - 0.13); // the tip; 0.12 m of the cone is in the rock
    }
    for (const s of up) {
      const q: V2 = [s.base[0], s.base[2]], k = chamberOf(q);
      for (const g of walkSegs(k)) expect(segDist(q, g)).toBeGreaterThan(1.1);
    }
  });

  it('builds them into the rock, and bakes the fungi\'s light into the rock round every cluster (no quads of its own)', () => {
    const B = new Builder();
    buildCaves(B, C, P.seed, []);
    const R = caveRock(C, P.seed), spots = fungiSpots(R, C, P.seed), rk = B.bins.rock;
    expect(spots.length).toBeGreaterThan(20);
    // uv: u the openness, v the fungi light, both 0..1
    for (let i = 0; i < rk.uv.length; i++) { expect(rk.uv[i]).toBeGreaterThanOrEqual(0); expect(rk.uv[i]).toBeLessThanOrEqual(1); }
    const glowAt = (p: V3, r: number) => { let m = 0; for (let v = 0; v < rk.pos.length / 3; v++) if (Math.hypot(rk.pos[3 * v] - p[0], rk.pos[3 * v + 1] - p[1], rk.pos[3 * v + 2] - p[2]) < r) m = Math.max(m, rk.uv[2 * v + 1]); return m; };
    for (const s of spots.slice(0, 12)) expect(glowAt(s.p, 0.05)).toBeGreaterThan(0.5); // lit at each cluster
    // and dark well away from all of them: the light fades to nothing, so nothing has an edge
    let far = 0;
    for (let v = 0; v < rk.pos.length / 3; v += 7) {
      const d = Math.min(...spots.map((s) => Math.hypot(rk.pos[3 * v] - s.p[0], rk.pos[3 * v + 1] - s.p[1], rk.pos[3 * v + 2] - s.p[2])));
      if (d > 4 * FUNGI_REACH) { far++; expect(rk.uv[2 * v + 1]).toBeLessThan(1e-3); }
    }
    expect(far).toBeGreaterThan(1000);
    expect(B.bins.rock.pos.length / 9).toBeGreaterThan(R.tris.length / 3 + 20 * fallenBlocks(C, P.seed).length);
    expect(B.bins.rock.pos.length / 9).toBeLessThan(90_000); // a budget: ~40k of surface, blocks and cones
    for (let i = 0; i < B.bins.glow.uv.length; i += 2) expect(B.bins.glow.uv[i + 1]).toBeGreaterThanOrEqual(0);
  });

  it('meshes the rock in a worker and primes the cache, or inline without one', async () => {
    const R = caveRock(C, P.seed), warn: string[] = [];
    let disposed = 0;
    const fake = (fail: boolean): CaveWorker => ({ run: (plan, seed) => (fail ? Promise.reject(new Error('x')) : Promise.resolve(packCaveRock(caveRock(plan, seed)))), dispose: () => { disposed++; } });
    const Q = { ...C, chambers: C.chambers.map((k) => ({ ...k })) };
    Q.chambers[0].noise += 1e-9; // another plan: a cache miss
    const packed = packCaveRock(R);
    primeCaveRock(Q, P.seed, packed);
    expect(caveRock(Q, P.seed)).toBe(packed);
    await caveRockOffThread(C, P.seed, () => fake(false), (m) => warn.push(m));
    await caveRockOffThread(C, P.seed, () => fake(true), (m) => warn.push(m));
    await caveRockOffThread(C, P.seed, () => { throw new Error('no workers'); }, (m) => warn.push(m));
    await caveRockOffThread(C, P.seed, null);
    expect(disposed).toBe(2);
    expect(warn).toEqual(['cave worker failed, meshing inline', 'cave worker unavailable, meshing inline']);
    expect(Array.from(caveRock(C, P.seed).tris)).toEqual(Array.from(R.tris));
  });
});
