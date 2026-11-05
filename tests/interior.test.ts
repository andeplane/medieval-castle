// Guards for the interior plan (docs/BRIEF.md I.1/I.2): every room reachable from the courtyard and the
// gate, doors big enough, rooms inside the walls and apart, stairs landing on floors, the moat tunnel
// barred at the far bank, and a navigation graph that reaches every room.
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three/webgpu';
import { planInterior, validatePlan, facings, towerFloorsY, outerFootprint, ceilingAt, doorHeadFits, fitDoorHeads, GATE, type PlanX } from '../src/castle/interior/plan';
import { navGraph, findPath, floorPolys } from '../src/castle/interior/nav';
import { buildShell, type ShellResult } from '../src/castle/interior/shell';
import { buildInterior } from '../src/castle/interior/index';
import { interiorViews } from '../src/camera/interiorViews';
import { buildCastle } from '../src/castle/castle';
import { Builder, type MatKey } from '../src/castle/builder';
import { gatehouseFrame, islandOutline } from '../src/castle/layout';
import { GATEHOUSE } from '../src/castle/spec';
import { pointInPoly, type V2 } from '../src/core/math2d';
import { WORLD_SEED } from '../src/core/rng';

const clone = (P: PlanX): PlanX => structuredClone(P);
const P = planInterior();

describe('interior plan', () => {
  it('is a pure function of the seed', () => {
    expect(planInterior(WORLD_SEED)).toEqual(P);
    expect(planInterior(12345)).toEqual(planInterior(12345));
    expect(planInterior(12345)).not.toEqual(P);
  });

  it('validates and places every door it wanted', () => {
    const rep = validatePlan(P);
    expect(rep.errors).toEqual([]);
    expect(P.unplaced).toEqual([]);
  });

  // 64 seeds, in four batches so each stays well inside the test timeout on a loaded CI machine
  it.each([0, 16, 32, 48])('holds for seeds %i…+15', (from) => {
    const bad: string[] = [];
    for (let s = from; s < from + 16; s++) {
      const Q = planInterior(s * 7919 + 1);
      const rep = validatePlan(Q);
      if (!rep.ok || Q.unplaced.length) bad.push(`seed ${s}: ${[...rep.errors, ...Q.unplaced].slice(0, 3).join('; ')}`);
    }
    expect(bad).toEqual([]);
  });

  it('has the expected inventory', () => {
    const wingFloor = (f: number) => P.rooms.filter((r) => ['N', 'E', 'S', 'W'].includes(r.zone) && r.floor === f && r.kind !== 'stair');
    for (let f = 1; f < 7; f++) expect(wingFloor(f).length).toBe(20);
    expect(P.rooms.some((r) => r.kind === 'hall')).toBe(true);
    expect(P.rooms.some((r) => r.kind === 'chapel')).toBe(true);
    for (const id of ['great', 'ne', 'se', 'sw']) expect(P.rooms.filter((r) => r.zone === id && r.kind === 'tower').length).toBeGreaterThan(3);
    // stairs: spirals in the towers, the courtyard stair tower, a straight cellar stair
    expect(P.stairs.filter((s) => s.kind === 'spiral').length).toBeGreaterThanOrEqual(5);
    expect(P.stairs.some((s) => s.kind === 'straight')).toBe(true);
    const st = P.stairs.find((s) => s.id === 'stairtower')!;
    for (let f = 0; f < 7; f++) expect(st.landings.some((L) => Math.abs(L.y - P.rooms.find((r) => r.id === `N${f}-0`)!.y0) < 0.06)).toBe(true);
  });

  it('opens a walkable gate route: outside → gate passage → courtyard → wings', () => {
    const gm = P.doors.find((d) => d.id === 'gate-main')!;
    expect(gm.kind).toBe('gate');
    expect(gm.leaf).toBe(true);
    expect(gm.spaces).toEqual(['outside', 'gate-0']);
    expect(gm.width).toBeCloseTo(GATE.width);
    // centred on the mid plane of the gatehouse front
    const g = gatehouseFrame(), c: V2 = [gm.centre[0], gm.centre[2]];
    const d = (c[0] - g.base[0]) * g.out[0] + (c[1] - g.base[1]) * g.out[1];
    expect(d).toBeCloseTo(GATEHOUSE.project - gm.wall / 2, 5);
    // room for the portcullis groove and the leaves behind the outer arch
    expect(gm.rebate).toBeGreaterThanOrEqual(0.15 + 0.25);
    const gi = P.doors.find((x) => x.id === 'gate-inner')!, gc = P.doors.find((x) => x.id === 'gate-court')!;
    expect(gi.leaf || gc.leaf).toBe(false);
    expect(gc.spaces).toContain('courtyard');
    const len = Math.hypot(gm.centre[0] - gc.centre[0], gm.centre[2] - gc.centre[2]);
    expect(len).toBeGreaterThan(8);
    expect(len).toBeLessThan(16);
    expect(P.vault['gate-0'].murder).toBe(true);
    for (const w of ['N', 'E', 'W']) expect(P.doors.some((x) => x.spaces[0] === 'courtyard' || x.spaces[1] === 'courtyard' ? x.spaces.some((s) => s.startsWith(`${w}0-`)) : false)).toBe(true);
  });

  it('reaches every room from the courtyard and the gate, never the far bank', () => {
    const rep = validatePlan(P);
    for (const r of P.rooms) expect(rep.reachable.has(r.id)).toBe(true);
    expect(rep.reachable.has('farbank')).toBe(false);
  });

  it('keeps doors at least 0.9 × 2.0 m with heads below the ceilings', () => {
    for (const d of P.doors) {
      expect(d.width).toBeGreaterThanOrEqual(0.9 - 1e-6);
      expect(d.height).toBeGreaterThanOrEqual(2.0 - 1e-6);
      expect(doorHeadFits(P, d)).toBe(true);
      expect(Math.hypot(...d.normal)).toBeCloseTo(1);
      expect(d.along[0]).toBeCloseTo(-d.normal[1]);
    }
    // old work round heads, new work pointed or segmental
    const heads = new Set(P.doors.map((d) => d.head));
    expect(heads.has('round')).toBe(true);
    expect(heads.has('pointed') || heads.has('segmental')).toBe(true);
  });

  it('lowers door heads that would cut a vault', () => {
    const Q = clone(P);
    const d = Q.doors.find((x) => x.spaces.includes('tunnel-x'))!;
    d.height = 3.2; delete Q.rise[d.id];
    expect(doorHeadFits(Q, d)).toBe(false);
    expect(validatePlan(Q).errors.some((e) => e.includes('head cuts'))).toBe(true);
    fitDoorHeads(Q);
    expect(doorHeadFits(Q, d)).toBe(true);
    expect(d.height).toBeGreaterThanOrEqual(2.0);
    // a door that cannot fit stays reported
    const r = Q.rooms.find((x) => x.id === d.spaces[0])!;
    r.y1 = r.y0 + 1.5; Q.vault[r.id] && delete Q.vault[r.id];
    fitDoorHeads(Q);
    expect(doorHeadFits(Q, d)).toBe(false);
  });

  it('keeps rooms inside the footprint and apart', () => {
    const foot = outerFootprint(), isl = islandOutline();
    for (const r of P.rooms) {
      if (r.zone === 'tunnel') continue;
      for (const p of r.poly) {
        expect(foot.some((f) => pointInPoly(f, p[0], p[1]))).toBe(true);
        expect(pointInPoly(isl, p[0], p[1])).toBe(true);
      }
    }
  });

  it('lands every stair on the floor it serves', () => {
    const doorById = new Map(P.doors.map((d) => [d.id, d]));
    for (const s of P.stairs) {
      expect(s.landings.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < s.landings.length; i++) expect(s.landings[i].y).toBeGreaterThanOrEqual(s.landings[i - 1].y); // a landing may serve two doors
      for (const L of s.landings) expect(Math.abs(doorById.get(L.door!)!.centre[1] - L.y)).toBeLessThan(0.06);
      if (s.kind === 'spiral') { expect(s.radius).toBeGreaterThan(0.9); expect(s.newel).toBeGreaterThan(0); }
      else { expect(s.start![1]).toBeLessThan(s.end![1]); }
    }
  });

  it('digs cellars and tunnels, one under the moat ending at a locked grille', () => {
    const tunnels = P.rooms.filter((r) => r.zone === 'tunnel');
    expect(tunnels.length).toBeGreaterThanOrEqual(5);
    for (const t of tunnels) { expect(t.kind).toBe('passage'); expect(t.floor).toBe(-1); expect(t.id.startsWith('tunnel-')).toBe(true); }
    const cellarWings = new Set(P.rooms.filter((r) => r.floor === -1 && ['N', 'W', 'E', 'S'].includes(r.zone) && r.kind !== 'stair').map((r) => r.zone));
    expect(cellarWings.size).toBeGreaterThanOrEqual(2);
    for (const t of P.tunnels) { expect(t.width).toBeGreaterThanOrEqual(1.6); expect(t.width).toBeLessThanOrEqual(2.2); expect(t.crown).toBeGreaterThanOrEqual(2.2); expect(t.crown).toBeLessThanOrEqual(2.8); }
    const sp = P.sallyPort!;
    const moat = P.tunnels.find((t) => t.room === sp.room)!;
    const low = Math.min(...moat.path.map((p) => p[1]));
    expect(low).toBeLessThanOrEqual(-6);
    expect(low + moat.crown).toBeLessThanOrEqual(-2.6 - 1.0 + 1e-6); // ≥ 1 m of rock under the moat bed
    for (let i = 1; i < moat.path.length; i++) { // walkable gradients only (stepped at ≤ 0.2/0.3)
      const a = moat.path[i - 1], b = moat.path[i], run = Math.hypot(b[0] - a[0], b[2] - a[2]);
      expect(Math.abs(b[1] - a[1])).toBeLessThanOrEqual(run * (0.2 / 0.3) + 1e-6);
    }
    const grilles = P.doors.filter((d) => d.kind === 'grille');
    expect(grilles).toHaveLength(1);
    expect(grilles[0].leaf).toBe(true);
    expect(grilles[0].spaces).toContain('farbank');
  });

  it('cuts off everything outside the island except the barred tunnel', () => {
    const Q = clone(P);
    Q.doors.find((d) => d.kind === 'grille')!.kind = 'plank';
    const errs = validatePlan(Q).errors;
    expect(errs.some((e) => e.includes('far bank'))).toBe(true);
    expect(errs.some((e) => e.includes('sally port'))).toBe(true);
  });

  it('reports broken plans', () => {
    const Q = clone(P);
    Q.rooms.push({ ...Q.rooms[0] });                                      // duplicate + overlap
    Q.rooms.push({ id: 'lost', zone: 'N', floor: 0, kind: 'chamber', poly: [[200, 200], [204, 200], [204, 204], [200, 204]], y0: 2.6, y1: 3.6 });
    Q.doors[0].width = 0.5;
    Q.doors.push({ ...Q.doors[1], id: 'ghost', spaces: ['nowhere', 'courtyard'] });
    Q.rooms.push({ id: 'flat', zone: 'N', floor: 0, kind: 'chamber', poly: [[0, 0], [0.1, 0], [0.1, 0.1]], y0: 2.6, y1: 5 });
    const s = Q.stairs[0]; s.landings[0].y += 1; s.landings.push({ y: 99 });
    Q.doors = Q.doors.filter((d) => d.id !== 'court>stairtower');
    const errs = validatePlan(Q).errors.join('\n');
    for (const k of ['duplicate room ids', 'overlap', 'leaves the footprint', 'outside the island', 'too small', 'unknown space', 'degenerate', 'too low', 'landing', 'unreachable']) expect(errs).toContain(k);
  });

  it('helpers', () => {
    expect(towerFloorsY(36).every((y, i, a) => i === 0 || y - a[i - 1] >= 2.4)).toBe(true);
    const sq = (x: number): V2[] => [[x, 0], [x + 2, 0], [x + 2, 2], [x, 2]];
    const f = facings(sq(0), sq(2.6));
    expect(f.length).toBe(1);
    expect(f[0].gapAt(1)).toBeCloseTo(0.6);
    expect(facings(sq(0), sq(10))).toEqual([]);
    const tx = P.rooms.find((r) => r.id === 'tunnel-x')!, top = ceilingAt(P, tx);
    const c = P.round['tunnel-x'].c;
    expect(top(c)).toBeCloseTo(tx.y1);
    expect(top([c[0], c[1] + 1.7])).toBeLessThan(tx.y1);
    const flat = P.rooms.find((r) => r.id === 'N2-0')!;
    expect(ceilingAt(P, flat)([0, 0])).toBe(flat.y1);
  });
});

describe('navigation graph', () => {
  const G = navGraph(P);
  it('connects every room to the gate without the grille', () => {
    for (const r of P.rooms) {
      const path = findPath(G, 'outside', r.id);
      expect(path, r.id).not.toBeNull();
      expect(path!.doors).not.toContain('sallyport-grille');
    }
    expect(findPath(G, 'outside', 'farbank')).toBeNull();
    expect(findPath(G, 'outside', 'farbank', { allowLocked: true })).not.toBeNull();
    expect(findPath(G, 'outside', 'nowhere')).toBeNull();
  });
  it('routes through doors and stairs with sensible costs', () => {
    const top = P.rooms.filter((r) => r.zone === 'great').sort((a, b) => b.y0 - a.y0)[0];
    const p = findPath(G, 'courtyard', top.id)!;
    expect(p.doors.length).toBeGreaterThan(1);
    expect(p.cost).toBeGreaterThan(top.y0 - 2.6);
    expect(p.nodes[0]).toBe('room:courtyard');
    expect(p.nodes[p.nodes.length - 1]).toBe(`room:${top.id}`);
    const gp = findPath(G, 'outside', 'courtyard')!;
    expect(gp.doors).toEqual(['gate-main', 'gate-inner', 'gate-court']);
    expect(findPath(G, 'N2-1', 'N2-1')!.cost).toBe(0);
    for (const e of G.edges) { expect(e.cost).toBeGreaterThan(0); expect(G.nodes.has(e.a) && G.nodes.has(e.b)).toBe(true); }
  });
  it('gives every room a clean walkable floor polygon', () => {
    const fp = floorPolys(P);
    for (const r of P.rooms) {
      const p = fp.get(r.id)!;
      expect(p.length).toBeGreaterThanOrEqual(3);
      let a = 0, per = 0;
      for (let i = 0; i < p.length; i++) { const q = p[i], s = p[(i + 1) % p.length]; a += q[0] * s[1] - s[0] * q[1]; per += Math.hypot(s[0] - q[0], s[1] - q[1]); }
      expect(a / 2).toBeGreaterThan(0);                       // consistent winding
      expect(Math.abs(a / 2) / per, r.id).toBeGreaterThan(0.25); // no slivers
      for (let i = 0; i < p.length; i++) { const q = p[i], s = p[(i + 1) % p.length]; expect(Math.hypot(s[0] - q[0], s[1] - q[1])).toBeGreaterThan(0.05); }
    }
  });
});

describe('interior shell', () => {
  let ext: Builder, sh: ShellResult;
  beforeAll(() => { ext = buildCastle().builder; sh = buildShell(P, ext); }, 60_000);

  it('records exterior walls and curved openings for the embrasures', () => {
    expect(ext.walls.length).toBeGreaterThan(100);
    expect(ext.curved.length).toBeGreaterThan(10);
    const w = ext.walls[0];
    expect(Object.keys(w).sort()).toEqual(['a', 'b', 'frame', 'mat', 'openings', 'out', 'y0', 'y1']);
  });

  it('cuts every door through the room walls and builds embrasures', () => {
    expect(sh.droppedHoles).toEqual([]);
    expect(sh.windows).toBeGreaterThan(120);
    expect(sh.carve.length).toBeGreaterThan(P.rooms.length);
  });

  it('groups geometry by zone and floor, stairs on their own', () => {
    const keys = new Set(sh.groups.map((g) => g.key));
    for (const r of P.rooms) expect(keys.has(r.kind === 'stair' ? `stairs:${r.id}` : `${r.zone}:${r.floor}`)).toBe(true);
    for (const g of sh.groups) {
      const tris = Object.values(g.B.bins).reduce((s, b) => s + b.pos.length / 9, 0);
      expect(tris, g.key).toBeGreaterThan(0);
      for (const b of Object.values(g.B.bins)) { expect(b.pos.length % 9).toBe(0); expect(b.uv.length / 2).toBe(b.pos.length / 3); expect(b.pos.every(Number.isFinite)).toBe(true); }
    }
  });

  it('works without a terrain sampler and on another seed', () => {
    const Q = planInterior(4242);
    const s2 = buildShell(Q, buildCastle().builder, {});
    expect(s2.droppedHoles).toEqual([]);
  }, 60_000);
});

describe('buildInterior', () => {
  it('makes one mesh per material per group, colliders, and stays inside the budget', () => {
    const mats = Object.fromEntries((['old', 'new', 'trim', 'slate', 'lead', 'wood', 'iron', 'void', 'glass'] as MatKey[]).map((k) => [k, new THREE.MeshBasicMaterial()])) as unknown as Record<MatKey, THREE.Material>;
    const ext = buildCastle().builder;
    const res = buildInterior(mats, ext, { plan: P, heightAt: () => 2.6 });
    expect(res.plan).toBe(P);
    expect(res.triangles).toBeGreaterThan(20_000);
    expect(res.triangles).toBeLessThan(400_000);
    const meshes = res.groups.reduce((s, g) => s + g.object.children.length, 0);
    expect(meshes).toBeLessThan(400);
    expect(res.groups.length).toBe(res.collision.length);
    for (const g of res.groups) {
      const names = g.object.children.map((m) => (m as THREE.Mesh).material);
      expect(new Set(names).size).toBe(names.length);
      expect(g.bounds.isEmpty()).toBe(false);
      expect(g.rooms.length).toBeGreaterThan(0);
    }
    for (const c of res.collision) expect(c.getAttribute('position').count % 3).toBe(0);
    expect(res.stats.carved).toBeGreaterThan(0);
  }, 60_000);
});

describe('interior camera bookmarks', () => {
  it('derives the interior views from the plan', () => {
    const v = interiorViews(P);
    const names = v.map((x) => x.name);
    for (const n of ['gatepass', 'hall', 'chamber', 'towerroom', 'undercroft', 'tunnel', 'cellar']) expect(names).toContain(n);
    for (const x of v) { expect(x.mode).toBe('fly'); expect(x.clamp).toBe(false); expect(x.pos.every(Number.isFinite)).toBe(true); }
    expect(interiorViews({ ...P, rooms: [], doors: [], sallyPort: null })).toEqual([]);
  });
});

describe('navigation on stairs', () => {
  it('follows each stair walking line from landing to landing', () => {
    const G = navGraph(P);
    for (const s of P.stairs) {
      const flights = G.edges.filter((e) => e.stair === s.id && e.line);
      expect(flights.length, s.id).toBe(s.landings.length - 1);
      for (const e of flights) {
        const a = G.nodes.get(e.a)!, b = G.nodes.get(e.b)!;
        expect(e.line!.length).toBeGreaterThanOrEqual(2);
        expect(e.line![0][1]).toBeCloseTo(a.pos[1], 1);
        expect(e.line![e.line!.length - 1][1]).toBeCloseTo(b.pos[1], 1);
        expect(e.cost).toBeGreaterThan(Math.abs(b.pos[1] - a.pos[1]));
      }
    }
    // landings without doors still link up
    const bare = { ...P, stairs: P.stairs.map((s) => ({ ...s, landings: s.landings.map((L) => ({ ...L })) })) };
    bare.stairs[0].landings.forEach((L) => { L.door = undefined; });
    expect(navGraph(bare).nodes.size).toBeGreaterThan(P.rooms.length);
  });
});
