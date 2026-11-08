// The caves under the north moat (castle/interior/caves.ts plan, caveGeom.ts rock): a pure function of the
// seed, rooms and openings of the interior plan, deep under the moat, with walkable floors and headroom
// along every walk. The walk itself, through every chamber with the player's motor, is in keypaths.test.ts.
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three/webgpu';
import * as T3 from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { planInterior, validatePlan, type PlanX } from '../src/castle/interior/plan';
import { buildInterior, type InteriorResult } from '../src/castle/interior/index';
import { caveSpan, caveWalk, passageFrame, passageFloor, ellipseRadius, poolDepth, isCave, CAVE_ZONE, type CavePlan } from '../src/castle/interior/caves';
import { caveField, caveRock, behindPortal, surfaceNets, poolDisc, stepBlocks, caveFires, caveRampSoups, cacheLayout, fungiSpots, CAVE_CELL } from '../src/castle/interior/caveGeom';
import { navGraph, findPath } from '../src/castle/interior/nav';
import { roomGraph, drawnSpaces } from '../src/world/visibility';
import { islandOutline, moatOuter } from '../src/castle/layout';
import { pointInPoly, type V2 } from '../src/core/math2d';
import { heightAt } from '../src/world/terrain';
import { buildCastle } from '../src/castle/castle';
import { CARRIED_LANTERN, lanternAt, lanternLit } from '../src/player/lantern';
import { mats } from './world';

type V3 = [number, number, number];
/** A vertex of an open edge sits within a cell of where its quads were left out. */
let portalB: ReturnType<typeof behindPortal> | null = null;
const closeBehind = (pos: number[], i: number) => {
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
    expect(C.features.map((f) => f.kind).sort()).toEqual(['bones', 'bones', 'cache', 'lantern', 'lost-lantern', 'shrine']);
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
    expect(f.emitters).toHaveLength(1);
    expect(f.group).toEqual(['cave:-1']);
    expect(f.flames[0].base[1]).toBeGreaterThan(cacheLayout(lantern.at, lantern.dir).lantern[1]);
  });
});

describe('the carried lantern', () => {
  it('hangs low, ahead and to the right, lit only in the caves', () => {
    const p = lanternAt([0, 1.6, 0], [0, -0.3, -2]); // looking north
    expect(p[0]).toBeGreaterThan(0.1); // east = right
    expect(p[2]).toBeLessThan(0);
    expect(p[1]).toBeCloseTo(1.15, 6);
    expect(lanternAt([0, 0, 0], [0, 1, 0])[1]).toBeCloseTo(-0.45, 6); // straight up: no plan direction, still placed
    const caves = new Set(['cave-hall']);
    expect(lanternLit(['cave-hall'], caves)).toBe(true);
    expect(lanternLit(['N-c1'], caves)).toBe(false);
    expect(CARRIED_LANTERN.kind).toBe('lantern');
  });
});
