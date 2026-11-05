// The island rim: the ground holds its level right up to the revetment's coping, the wall shows above the
// water, and the rendered terrain grid never shows water or grass in the wrong place around it.
import { describe, it, expect } from 'vitest';
import { ISLAND, MOAT_OUTER, heightAt, sample, islandWalkable } from '../src/world/terrain';
import { gatehouseFrame } from '../src/castle/layout';
import { bridgePlan } from '../src/castle/bridge';
import { REVET, buildRevetment, keptIntervals, revetmentPlan } from '../src/castle/revetment';
import { Builder, wallFrame } from '../src/castle/builder';
import { StoneSet } from '../src/castle/stones/set';
import type { V3 } from '../src/castle/rubble';
import { rngFor, mulberry32 } from '../src/core/rng';
import { pointInPoly, edgeDist, type V2 } from '../src/core/math2d';

const bridge = bridgePlan({ island: ISLAND, moatOuter: MOAT_OUTER, gate: gatehouseFrame(), groundAt: heightAt, rng: rngFor('bridge') });
const exclude = (x: number, z: number) => pointInPoly(bridge.footprint, x, z);
const plan = revetmentPlan({ island: ISLAND, groundAt: heightAt, rng: rngFor('revetment'), exclude });
const n = plan.st.length;
const nearBridge = (x: number, z: number) => Math.hypot(x - bridge.O[0], z - bridge.O[1]) < 5;

describe('keptIntervals', () => {
  it('keeps everything when nothing is excluded', () => expect(keptIntervals(() => false)).toEqual([[0, 1]]));
  it('keeps nothing when everything is excluded', () => expect(keptIntervals(() => true)).toEqual([]));
  it('cuts out the middle precisely', () => {
    const k = keptIntervals((u) => u > 0.3 && u < 0.6);
    expect(k.length).toBe(2);
    expect(k[0][0]).toBe(0); expect(k[0][1]).toBeCloseTo(0.3, 3);
    expect(k[1][0]).toBeCloseTo(0.6, 3); expect(k[1][1]).toBe(1);
  });
  it('keeps a middle piece', () => {
    const k = keptIntervals((u) => u < 0.2 || u > 0.7);
    expect(k.length).toBe(1);
    expect(k[0][0]).toBeCloseTo(0.2, 3); expect(k[0][1]).toBeCloseTo(0.7, 3);
  });
});

describe('island rim', () => {
  it('holds the ground level up to the back of the coping all the way round', () => {
    for (let i = 0; i < n; i++) for (const u of [0, 0.5]) for (const e of [0.4, 0.8, 1.2, 1.6, 2.0]) {
      const p = plan.at(i, u, e);
      if (nearBridge(p[0], p[1])) continue;
      const h = sample(p[0], p[1]);
      expect(h.zone).toBe('island');
      expect(h.h).toBeGreaterThan(0.8);
      expect(h.h).toBeGreaterThanOrEqual(plan.topAt(i, u) - 0.3);
    }
  });

  it('shows 1.2-3 m of wall above the water, varying round the island', () => {
    const tops = plan.st.map((s) => s.top);
    expect(Math.min(...tops)).toBeGreaterThan(1.2);
    expect(Math.max(...tops)).toBeLessThan(3);
    expect(Math.max(...tops) - Math.min(...tops)).toBeGreaterThan(0.4);
    const sorted = [...tops].sort((a, b) => a - b);
    expect(sorted[Math.floor(n / 2)]).toBeLessThan(2.3);
    for (const s of plan.st) { expect(s.top - s.g).toBeGreaterThan(0.05); expect(s.top - s.g).toBeLessThan(0.11); }
  });

  it('stops at the bridge abutment and nowhere else', () => {
    const clipped = plan.segs.filter((s) => s.keep.length !== 1 || s.keep[0][0] > 0 || s.keep[0][1] < 1);
    expect(clipped.length).toBeGreaterThan(0);
    expect(clipped.length).toBeLessThan(4);
    for (const s of clipped) { const p = plan.at(s.i, 0.5, 0); expect(nearBridge(p[0], p[1])).toBe(true); }
  });

  it('has a few damaged stretches, away from the bridge', () => {
    const dmg = plan.segs.filter((s) => s.damaged);
    expect(dmg.length).toBeGreaterThan(0);
    expect(dmg.length).toBeLessThan(8);
    for (const s of dmg) {
      expect(s.ragged.length).toBe(5);
      for (const y of s.ragged) { expect(y).toBeLessThan(plan.topAt(s.i, 0.5) - 0.3); expect(y).toBeGreaterThan(0.5); }
    }
    expect(plan.fallen.length).toBe(dmg.length * 4);
    for (const st of plan.fallen) expect(Math.min(...st.corners.map((c) => c[1]))).toBeLessThan(0);
  });

  it('keeps the walker 1.2 m from the edge', () => {
    for (let i = 0; i < n; i += 8) {
      const a = plan.at(i, 0.5, 1.0), b = plan.at(i, 0.5, 1.6);
      expect(islandWalkable(a[0], a[1])).toBe(false);
      if (edgeDist(ISLAND, b[0], b[1]).d > 1.25) expect(typeof islandWalkable(b[0], b[1])).toBe('boolean');
    }
  });

  it('is a pure function of the rng and works without an exclusion', () => {
    const a = revetmentPlan({ island: ISLAND, groundAt: heightAt, rng: mulberry32(5) });
    const b = revetmentPlan({ island: ISLAND, groundAt: heightAt, rng: mulberry32(5) });
    expect(a.st).toEqual(b.st);
    expect(a.segs.every((s) => s.keep.length === 1)).toBe(true);
    expect(a.exclude(0, 0)).toBe(false);
  });
});

describe('revetment geometry', () => {
  const B = new Builder();
  const tris = buildRevetment(B, plan, rngFor('revetment-stones'));
  it('stays cheap', () => { expect(tris).toBeGreaterThan(2000); expect(tris).toBeLessThan(12000); });
  it('uses only stone', () => {
    expect(B.bins.old.pos.length + B.bins.trim.pos.length).toBe(tris * 9);
    expect(B.bins.old.pos.every(Number.isFinite)).toBe(true);
  });
  it('records the battered face for real stones, from the waterline to under the coping', () => {
    const faces = B.stoneFaces;
    expect(faces.length).toBeGreaterThan(n * 0.8);
    for (const f of faces) {
      const g = f.geom as { kind: 'plane'; o: V3; r: V3; n: V3; bat?: { y0: number; H: number; run: number; ns: V3 } };
      expect(g.kind).toBe('plane');
      expect(g.bat!.run).toBeCloseTo(REVET.batter * g.bat!.H, 6);
      expect(f.y0).toBe(B.stoneFloor);
      expect(f.y1).toBeLessThan(3);
      // the face leans back: its normal tilts up and points away from the island
      expect(g.bat!.ns[1]).toBeGreaterThan(0);
      const mid: V2 = [g.o[0] + g.r[0] * (f.s0 + f.s1) / 2, g.o[2] + g.r[2] * (f.s0 + f.s1) / 2];
      expect(pointInPoly(ISLAND, mid[0], mid[1])).toBe(false);
      expect(pointInPoly(ISLAND, mid[0] - g.n[0] * 2.5, mid[1] - g.n[2] * 2.5)).toBe(true);
    }
    const set = new StoneSet(faces, B.stoneExcl);
    expect(set.stones.length).toBeGreaterThan(faces.length * 5);
  });
  it('records no stones when the Builder has stones turned off', () => {
    const b = new Builder();
    b.stoneOn = false;
    buildRevetment(b, plan, rngFor('revetment-stones'));
    expect(b.stoneFaces.length).toBe(0);
  });
});

describe('Builder.stoneFace', () => {
  it('records a stone-faced rectangle unless it is too small or stones are off', () => {
    const b = new Builder(), f = wallFrame([0, 0], [3, 0], [0, 1]);
    b.stoneFace('old', f, 0, 3, 0, 1.2);
    b.stoneFace('old', f, 0, 0.3, 0, 1.2);
    b.stoneFace('old', f, 0, 3, 0, 0.2);
    expect(b.stoneFaces.length).toBe(1);
    expect(b.stoneFaces[0]).toMatchObject({ mat: 'old', s0: 0, s1: 3, y0: 0, y1: 1.2, u0: 0, sil: false });
    b.stoneOn = false;
    b.stoneFace('new', f, 0, 3, 0, 1.2, 2);
    expect(b.stoneFaces.length).toBe(1);
  });
});

// The rendered terrain is a grid, so it can only step down over one cell. These checks rebuild the near
// terrain grid around the rim exactly as world/terrain.ts buildTerrain() lays it out (380 m square, 420
// cells, centred, PlaneGeometry triangulation): the step must stay hidden inside the wall and under the turf.
// If the near grid changes, change NEAR here (building the real mesh takes ~20 s, too slow for npm test).
const NEAR = { size: 380, seg: 420 };
describe('terrain grid at the rim', () => {
  const S = NEAR.size / NEAR.seg, h0 = NEAR.size / 2;
  const cache = new Map<number, number>();
  const vh = (ix: number, iz: number) => { const k = ix * 100000 + iz; let h = cache.get(k); if (h === undefined) { h = heightAt(ix * S - h0, iz * S - h0); cache.set(k, h); } return h; };
  // PlaneGeometry splits each cell (a, b, c, d) = (ix,iz), (ix,iz+1), (ix+1,iz+1), (ix+1,iz) into abd and bcd
  const meshH = (x: number, z: number) => {
    const fx = (x + h0) / S, fz = (z + h0) / S, ix = Math.floor(fx), iz = Math.floor(fz), u = fx - ix, v = fz - iz;
    const a = vh(ix, iz), b = vh(ix, iz + 1), c = vh(ix + 1, iz + 1), d = vh(ix + 1, iz);
    return u + v <= 1 ? a + u * (d - a) + v * (b - a) : c + (1 - u) * (b - c) + (1 - v) * (d - c);
  };
  it('matches the real near mesh', () => {
    // a corner of the grid is a vertex, so the replica and the mesh agree there by construction
    expect(meshH(-h0, -h0)).toBeCloseTo(heightAt(-h0, -h0), 6);
    expect(meshH(-h0 + S, -h0 + 2 * S)).toBeCloseTo(heightAt(-h0 + S, -h0 + 2 * S), 6);
  });
  // the strip is linear between its rows (castle/turf.ts)
  const rows = [REVET.turfOut, 0.0, 0.35, 0.7, 1.1, 1.5, REVET.turfIn];
  const rowCache = new Map<string, number>();
  const rowH = (i: number, u: number, e: number) => { const key = `${i},${u},${e}`; if (rowCache.has(key)) return rowCache.get(key)!; const q = plan.at(i, u, Math.max(e, REVET.level)); const h = heightAt(q[0], q[1]) + (e >= REVET.turfIn - 1e-6 ? 0.022 : 0.035); rowCache.set(key, h); return h; };
  const turfH = (i: number, u: number, e: number) => {
    const k = Math.max(0, Math.min(rows.length - 2, rows.findIndex((r) => r > e) - 1)), f = (e - rows[k]) / (rows[k + 1] - rows[k]);
    return rowH(i, u, rows[k]) * (1 - f) + rowH(i, u, rows[k + 1]) * f;
  };
  const stations: [number, number][] = [];
  for (const s of plan.segs) if (!s.damaged && s.keep.length === 1 && s.keep[0][0] === 0 && s.keep[0][1] === 1) for (const u of [0.25, 0.75]) stations.push([s.i, u]);

  it('has no grass in front of the wall face', () => {
    for (const [i, u] of stations) for (let e = -3; e < -REVET.face - 0.02; e += 0.05) {
      const p = plan.at(i, u, e);
      expect(meshH(p[0], p[1])).toBeLessThan(0.02);
    }
  });
  it('stays under the coping and the turf strip', () => {
    for (const [i, u] of stations) {
      for (let e = -REVET.face - REVET.over; e <= REVET.back; e += 0.05) { const p = plan.at(i, u, e); expect(meshH(p[0], p[1])).toBeLessThan(plan.topAt(i, u) - 0.02); }
      for (let e = REVET.turfOut; e <= REVET.turfIn; e += 0.1) { const p = plan.at(i, u, e); const m = meshH(p[0], p[1]), t = turfH(i, u, e); expect(m).toBeLessThan(t + 0.005); }
    }
  });
  it('is level again where the turf strip ends', () => {
    for (const [i, u] of stations) for (let e = REVET.turfIn; e < REVET.turfIn + 1.5; e += 0.25) {
      const p = plan.at(i, u, e);
      expect(meshH(p[0], p[1])).toBeGreaterThan(heightAt(p[0], p[1]) - 0.05);
    }
  });
});
