// The height and zone function, the stream, farmland queries (hedges, fields), the island navigation
// queries and the meshes, on the game's seeded deps and on fakes.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  createTerrain, defaultTerrain, buildTerrain, prepareTerrain, OutlineField, MAX_WALK_SLOPE, RELIEF_TEX,
  ISLAND, MOAT_OUTER, BRIDGE_END, sample, heightAt, hedgerowLines, fieldAt, streamLine, farmland,
  islandWalkable, footDist, moatSigned, COURT_BED, type Terrain,
} from '../src/world/terrain';
import { seededDeps } from '../src/world/deps';
import { RN, RX0, RZ0, RCELL } from '../src/world/relief';
import { CROPS, LANE_HALF } from '../src/world/fields';
import { GROUND } from '../src/castle/spec';
import { castleCentre, courtyard } from '../src/castle/layout';
import { pointInPoly, edgeDist, type V2 } from '../src/core/math2d';
import { fakeDeps } from './fakes';

const T: Terrain = createTerrain(seededDeps(1187), { seed: 1187 });

/** zones met walking out from the castle centre along a bearing */
function walkOut(t: Terrain, ang: number) {
  const seen: { zone: string; r: number; h: number }[] = [];
  for (let r = 0; r < 260; r += 0.5) {
    const s = t.sample(Math.cos(ang) * r, Math.sin(ang) * r);
    if (!seen.length || seen[seen.length - 1].zone !== s.zone) seen.push({ zone: s.zone, r, h: s.h });
  }
  return seen;
}

describe('height and zones', () => {
  it('goes island → moat → countryside in every direction', () => {
    for (let k = 0; k < 8; k++) expect(walkOut(T, (k / 8) * 2 * Math.PI).map((z) => z.zone)).toEqual(['island', 'moat', 'outer']);
  });

  it('keeps the island at ground level and the moat under water', () => {
    const [cx, cz] = castleCentre();
    expect(T.sample(cx, cz).h).toBeCloseTo(GROUND, 0);
    const court = courtyard(), [qx, qz] = court[0];
    const inside: V2 = [qx * 0.9 + cx * 0.1, qz * 0.9 + cz * 0.1];
    if (pointInPoly(court, ...inside)) expect(T.heightAt(...inside)).toBeCloseTo(COURT_BED, 5);
    let wet = 0, n = 0;
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * 2 * Math.PI, zs = walkOut(T, a), m = zs[1], o = zs[2];
      const r = (m.r + o.r) / 2, s = T.sample(Math.cos(a) * r, Math.sin(a) * r);
      n++; if (s.h < 0) wet++;
      expect(s.zone).toBe('moat');
    }
    expect(wet / n).toBeGreaterThan(0.95);
  });

  it('raises a natural bank out of the water on the far side', () => {
    const faces: number[] = [];
    for (let k = 0; k < 48; k++) {
      // the moat's outer edge along this bearing, from the signed distance
      const a = (k / 48) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
      let r = 60; while (moatSigned(c * r, s * r) < 0) r += 0.25;
      const top = T.sample(c * (r + 12), s * (r + 12));
      expect(top.h).toBeGreaterThan(0.4);
      expect(top.zone).toBe('outer');
      faces.push(T.sample(c * (r + 0.6), s * (r + 0.6)).face ?? 0);
    }
    expect(faces.filter((f) => f > 0.5).length).toBeGreaterThan(10);
  });

  it('puts mountains in the north-west and a lake in the east', () => {
    expect(T.heightAt(-1750, -2650)).toBeGreaterThan(300);
    expect(T.heightAt(760, 330)).toBeLessThan(-2);
    expect(T.slopeAt(-1750, -2400)).toBeGreaterThan(T.slopeAt(400, 600));
  });

  it('is a pure function of the injected deps', () => {
    const a = createTerrain(fakeDeps()), b = createTerrain(fakeDeps());
    for (const [x, z] of [[0, 0], [150, 40], [900, -300], [-3000, -2500]] as V2[]) expect(a.sample(x, z)).toEqual(b.sample(x, z));
    expect(createTerrain(seededDeps(2)).heightAt(600, -500)).not.toBeCloseTo(T.heightAt(600, -500), 3);
  });
});

describe('relief grid', () => {
  it('uses the eroded grid once installed, blending at its edge', () => {
    const t = createTerrain(fakeDeps());
    const x = RX0 + 200 * RCELL, z = RZ0 + 150 * RCELL, before = t.heightAt(x, z);
    expect(t.erosionAt(x, z)).toBe(0);
    expect(t.hasRelief()).toBe(false);
    const R = new Float32Array(RN * RN).fill(321), D = new Float32Array(RN * RN).fill(-4);
    t.setRelief({ R, D });
    expect(t.hasRelief()).toBe(true);
    expect(t.erosionAt(x, z)).toBeCloseTo(-4);
    expect(t.heightAt(x, z)).not.toBeCloseTo(before, 1);
    // near the grid edge the analytic relief blends in; outside it only the analytic relief counts
    expect(t.erosionAt(RX0 - 10, z)).toBe(0);
    expect(Number.isFinite(t.heightAt(RX0 + 100, z))).toBe(true);
  });

  it('bakes a relief normal texture', () => {
    const tex = T.reliefTexture(24);
    expect(tex).toHaveLength(24 * 24 * 4);
    expect(tex[3]).toBe(255);
    expect(RELIEF_TEX.size).toBe(RN);
    expect(T.timings.reliefTexMs).toBeGreaterThanOrEqual(0);
  });

  it('erodes inline when no worker is available', async () => {
    const t = createTerrain(fakeDeps()), grid = { R: new Float32Array(RN * RN), D: new Float32Array(RN * RN) };
    let asked = -1;
    await prepareTerrain(t, { droplets: 200, erode: (_, n) => { asked = n ?? 0; return grid; } });
    expect(asked).toBe(200);
    expect(t.hasRelief()).toBe(true);
    expect(t.timings.reliefMs).toBeGreaterThanOrEqual(0);
    await prepareTerrain(t); // already prepared: no-op
  });
});

describe('stream', () => {
  const S = T.streamLine();
  it('runs downhill from the northern hills into the lake', () => {
    expect(S.pts.length).toBeGreaterThan(100);
    for (let i = 1; i < S.level.length; i++) expect(S.level[i]).toBeLessThanOrEqual(S.level[i - 1]);
    expect(S.level[S.level.length - 1]).toBeLessThan(-0.4);
    expect(S.halfWidth[S.halfWidth.length - 1]).toBeGreaterThan(S.halfWidth[0]);
    expect(Math.hypot(S.pts[0][0] + 300, S.pts[0][1] + 1760)).toBeLessThan(5);
  });
  it('cuts a channel below the water and banks above it', () => {
    for (let i = 60; i < S.pts.length - 30; i += 40) {
      const [x, z] = S.pts[i];
      if (Math.hypot(x, z) < 260) continue;
      const s = T.sample(x, z);
      expect(s.h).toBeLessThan(S.level[i]);
      expect(s.stream).toBeLessThan(1);
    }
  });
});

describe('farmland, hedges and fields', () => {
  const H = T.hedgerowLines();
  it('returns clipped hedgerow lines, cached', () => {
    expect(H.length).toBeGreaterThan(500);
    expect(T.hedgerowLines()).toBe(H);
    for (const h of H.slice(0, 400)) {
      const m: V2 = [(h.a[0] + h.b[0]) / 2, (h.a[1] + h.b[1]) / 2];
      expect(T.farmland(...m)).toBeGreaterThan(0.3);
      expect(T.sample(...m).zone).toBe('outer');
    }
    expect(H.some((h) => h.lane)).toBe(true);
  });
  it('has no farmland on the island, in the moat or the lake', () => {
    expect(T.farmland(0, 0)).toBe(0);
    expect(T.farmland(760, 330)).toBe(0);
    const o = walkOut(T, 1)[1];
    expect(T.farmland(Math.cos(1) * (o.r + 1), Math.sin(1) * (o.r + 1))).toBe(0);
  });
  it('names the field and crop under a point', () => {
    const lane = H.find((h) => !h.lane)!, d = [lane.b[0] - lane.a[0], lane.b[1] - lane.a[1]], l = Math.hypot(d[0], d[1]);
    const p: V2 = [(lane.a[0] + lane.b[0]) / 2 - (d[1] / l) * 20, (lane.a[1] + lane.b[1]) / 2 + (d[0] / l) * 20];
    const f = T.fieldAt(...p);
    if (T.farmland(...p) >= 0.5) { expect(f.field).toBeGreaterThanOrEqual(0); expect(CROPS).toContain(f.crop); }
    expect(T.fieldAt(0, 0)).toEqual({ field: -1, crop: null });
    expect(T.fieldAt(9000, 9000)).toEqual({ field: -1, crop: null });
    expect(LANE_HALF).toBeGreaterThan(0);
  });
});

describe('island navigation', () => {
  it('knows where the island can be walked', () => {
    const [cx, cz] = castleCentre();
    expect(islandWalkable(cx, cz)).toBe(false); // inside the keep
    expect(islandWalkable(500, 500)).toBe(false);
    expect(T.islandWalkable).toBe(islandWalkable);
  });

  it('rasterises a walkable grid with slopes for a navmesh, honouring obstacles', () => {
    const g = T.islandNavGrid(3);
    expect(g.nx * g.nz).toBe(g.walkable.length);
    let open = 0, ok = true, k0 = -1;
    for (let k = 0; k < g.walkable.length; k++) if (g.walkable[k]) { open++; if (g.slope[k] > MAX_WALK_SLOPE) ok = false; if (k0 < 0) k0 = k; }
    expect(open).toBeGreaterThan(100);
    expect(ok).toBe(true);
    const x = g.x0 + ((k0 % g.nx) + 0.5) * g.cell, z = g.z0 + (Math.floor(k0 / g.nx) + 0.5) * g.cell;
    const s = T.navSample(x, z);
    expect(s.walkable).toBe(true);
    expect(s.h).toBeCloseTo(g.h[k0], 5);
    expect(T.navSample(x, z, [[x, z, 1]]).walkable).toBe(false);
    expect(T.islandNavGrid(15, [[x, z, 1]]).walkable.length).toBeGreaterThan(0);
  });
});

describe('outline helpers', () => {
  it('signed distance agrees with the exact polygon tests', () => {
    const f = new OutlineField(ISLAND, 160);
    for (let k = 0; k < 300; k++) {
      const x = Math.sin(k * 12.9898) * 200, z = Math.sin(k * 78.233) * 200, s = f.signed(x, z);
      expect(Math.abs(s)).toBeCloseTo(edgeDist(ISLAND, x, z).d, 4);
      if (Math.abs(s) > 0.01) expect(s < 0).toBe(pointInPoly(ISLAND, x, z));
    }
  });
  it('measures from the moat and the buildings', () => {
    expect(moatSigned(0, 0)).toBeLessThan(0);
    expect(moatSigned(400, 0)).toBeGreaterThan(0);
    expect(moatSigned(310, 0)).toBeGreaterThan(0);
    expect(footDist(...castleCentre())).toBe(0);
    expect(footDist(0, 120)).toBeGreaterThan(0);
    expect(pointInPoly(MOAT_OUTER, ...BRIDGE_END)).toBe(false);
  });
});

describe('meshes', () => {
  it('builds the near, far and stream meshes, water and rocks', () => {
    const stream = new THREE.MeshBasicMaterial(), mat = new THREE.MeshBasicMaterial();
    const reliefTex = new THREE.DataTexture(new Uint8Array(16 * 16 * 4), 16, 16);
    mat.userData = { stream, reliefTex };
    const g = buildTerrain(mat, T, { nearSeg: 40, farRings: 12, farSegs: 48 });
    const names = g.children.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['terrain-near', 'terrain-far', 'terrain-stream', 'stream-water', 'rocks']));
    expect(g.userData.triangles).toBeGreaterThan(10000);
    expect(g.userData.rocks).toBeGreaterThan(100);
    expect(g.getObjectByName('rocks')!.userData.obstacles).toHaveLength(g.userData.islandObstacles);
    expect(reliefTex.version).toBeGreaterThan(0);
    const near = g.getObjectByName('terrain-near') as THREE.Mesh, mask = near.geometry.attributes.mask;
    for (let i = 0; i < mask.count; i += 97) expect(mask.getX(i) + mask.getY(i) + mask.getZ(i) + mask.getW(i)).toBeCloseTo(1, 4);
    // the stream ribbon faces up (all but the two vertical skirt columns of 29 per row)
    const corridor = g.getObjectByName('terrain-stream') as THREE.Mesh;
    let up = 0, tot = 0; const n = corridor.geometry.attributes.normal;
    for (let i = 0; i < n.count; i++) { const col = i % 29; if (col < 2 || col > 26) continue; tot++; if (n.getY(i) > 0.3) up++; }
    expect(up / tot).toBeGreaterThan(0.99);
  });
});

describe('the game terrain', () => {
  it('is created once and backs the module-level queries', () => {
    const t = defaultTerrain();
    expect(defaultTerrain()).toBe(t);
    expect(sample(10, 10)).toEqual(t.sample(10, 10));
    expect(heightAt(300, 0)).toBe(t.heightAt(300, 0));
    expect(farmland(0, 0)).toBe(0);
    expect(streamLine().pts.length).toBe(t.streamLine().pts.length);
    expect(fieldAt(0, 0).field).toBe(-1);
    expect(typeof hedgerowLines).toBe('function'); // same wrapper shape; computing them again is slow
  });
});
