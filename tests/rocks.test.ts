// Rock placement against a fake world: a round island (r < 60 m) in a round moat (r < 80 m) with
// rising fields outside, so every placement rule can be checked by radius.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { placeRocks, buildRocks, rockGeometry, rockLevel, islandObstacles, ROCK_SHAPES, ROCK_LOD, type RockEnv, type RockLod } from '../src/world/rocks';
import { UNDRAWN_LAYER } from '../src/render/passLayers';
import type { V2 } from '../src/core/math2d';
import { fakeDeps } from './fakes';

const ISL = 60, MOAT = 80;
const groundAt = (x: number, z: number) => {
  const r = Math.hypot(x, z);
  return r < ISL ? 2.6 : r < MOAT ? -1 : 0.5 + (r - MOAT) * 0.1;
};
const env: RockEnv = {
  sample: (x, z) => {
    const r = Math.hypot(x, z), h = groundAt(x, z);
    return r < ISL ? { h, zone: 'island', dEdge: ISL - r } : r < MOAT ? { h, zone: 'moat', dEdge: Math.min(r - ISL, MOAT - r) } : { h, zone: 'outer', dEdge: r - MOAT };
  },
  moatOuter: Array.from({ length: 96 }, (_, k): V2 => [MOAT * Math.cos((k / 96) * 2 * Math.PI), MOAT * Math.sin((k / 96) * 2 * Math.PI)]),
  footDist: (x, z) => Math.hypot(x + 10, z + 10) - 8, // one round building
  hedges: Array.from({ length: 40 }, (_, k) => ({ a: [150 + k * 12, -300] as V2, b: [150 + k * 12, 300] as V2, lane: k % 10 === 0 })),
  fieldAt: (x) => ({ field: x > 0 ? 1 : 2, crop: x > 0 ? 'rough' : 'ploughed' }),
  farmland: (x, z) => (Math.hypot(x, z) > 120 ? 1 : 0),
};

describe('rock placement', () => {
  const deps = fakeDeps();
  const { near, far } = placeRocks(env, deps);
  const all = [...near, ...far];

  it('is a pure function of the env and deps', () => {
    expect(placeRocks(env, fakeDeps())).toEqual({ near, far });
  });

  it('lines the outer waterline with stones, some of them boulders', () => {
    const shore = near.filter((s) => Math.abs(Math.hypot(s.x, s.z) - MOAT) < 3.5);
    expect(shore.length).toBeGreaterThan(200);
    expect(shore.some((s) => s.s > 1)).toBe(true);
    expect(shore.every((s) => s.s <= 2.2 && s.s >= 0.25)).toBe(true);
  });

  it('puts bedrock slabs on the island outcrop, clear of the buildings and the edge', () => {
    const outcrop = near.filter((s) => Math.hypot(s.x + 40, s.z + 24) < 13);
    expect(outcrop.filter((s) => s.s >= 1.4).length).toBe(14);
    for (const s of outcrop) {
      expect(env.footDist(s.x, s.z)).toBeGreaterThanOrEqual(1.2);
      expect(ISL - Math.hypot(s.x, s.z)).toBeGreaterThanOrEqual(1.6);
    }
  });

  it('scatters erratics in rough fields but none in ploughland, and clearance stones by hedges', () => {
    const fieldRocks = all.filter((s) => Math.hypot(s.x, s.z) > 120 && Math.hypot(s.x, s.z) < 1100);
    expect(fieldRocks.length).toBeGreaterThan(0);
    // ploughed (x < 0) gets no erratics; clearance stones only come from hedges at x ≥ 150
    expect(fieldRocks.filter((s) => s.x < -2).length).toBe(0);
    expect(fieldRocks.some((s) => s.x >= 148 && s.x <= 150 + 39 * 12 + 4)).toBe(true);
    expect(far.length).toBeGreaterThan(0);
    expect(far.every((s) => Math.hypot(s.x, s.z) >= 400)).toBe(true);
  });

  it('seats every rock in the ground', () => {
    for (const s of all) {
      expect(Number.isFinite(s.y)).toBe(true);
      expect(s.y).toBeLessThan(groundAt(s.x, s.z) + 0.01);
      expect(s.shape).toBeGreaterThanOrEqual(0);
      expect(s.shape).toBeLessThan(ROCK_SHAPES);
    }
  });

  it('reports island rocks that stand proud of the turf as obstacles', () => {
    const obs = islandObstacles(near, env);
    expect(obs.length).toBeGreaterThan(0);
    for (const [x, z, r] of obs) { expect(Math.hypot(x, z)).toBeLessThan(ISL); expect(r).toBeGreaterThan(0); }
    expect(islandObstacles(near, env, 100)).toHaveLength(0);
  });
});

describe('rock meshes', () => {
  it('generates closed, creased rock shapes with uvs', () => {
    const g = rockGeometry(fakeDeps(), 'rock-shape-0', 1);
    expect(g.attributes.uv.count).toBe(g.attributes.position.count);
    expect(g.attributes.normal).toBeDefined();
    g.computeBoundingBox();
    expect(g.boundingBox!.max.length()).toBeLessThan(2);
    expect(g.boundingBox!.min.y).toBeGreaterThan(-0.6);
  });

  it('keeps the near rocks whole for the physics, undrawn', () => {
    const group = buildRocks(new THREE.MeshBasicMaterial(), env, fakeDeps());
    const near = (group.children as THREE.InstancedMesh[]).filter((m) => m.name.startsWith('rocks-near'));
    expect(near.length).toBe(ROCK_SHAPES);
    expect(near.reduce((n, m) => n + m.count, 0)).toBe(group.userData.near);
    expect(near.every((m) => m.castShadow && m.layers.isEnabled(UNDRAWN_LAYER) && !m.layers.isEnabled(0))).toBe(true);
    expect(group.userData.triangles).toBeGreaterThan(0);
    expect(group.userData.obstacles.length).toBeGreaterThan(0);
  });

  it('draws every rock once, at the level its size and distance give, wherever the eye goes', () => {
    const { near, far } = placeRocks(env, fakeDeps());
    const all = [...near, ...far];
    const group = buildRocks(new THREE.MeshBasicMaterial(), env, fakeDeps());
    const lod = group.userData.lod as RockLod;
    const levels = (group.children as THREE.InstancedMesh[]).filter((m) => m.name.startsWith('rocks-lod'));
    expect(levels.length).toBe(ROCK_SHAPES * ROCK_LOD.length);
    const detail = (li: number) => rockGeometry(fakeDeps(), 'rock-shape-0', ROCK_LOD[li].detail).attributes.position.count / 3;
    expect(detail(0)).toBeGreaterThan(detail(1));
    expect(detail(1)).toBeGreaterThan(detail(2));
    const at = new THREE.Vector3(), m = new THREE.Matrix4();
    for (const eye of [{ x: 0, y: 60, z: 0 }, { x: 81, y: 3, z: 0 }, { x: -300, y: 20, z: 50 }, { x: 81.4, y: 3, z: 0.3 }]) {
      lod.update(eye);
      const counts = lod.counts();
      expect(counts.reduce((a, b) => a + b, 0)).toBe(all.length);
      // each drawn instance is a placed rock, in the level rockLevel gives it, and each rock is drawn once
      const seen = new Set<number>();
      for (const im of levels) {
        const li = Number(im.name.slice('rocks-lod'.length, im.name.lastIndexOf('-'))), sh = Number(im.name.slice(im.name.lastIndexOf('-') + 1));
        expect(im.visible).toBe(im.count > 0);
        expect(im.castShadow).toBe(true);
        expect(im.layers.mask).toBe(1); // every pass
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, m); at.setFromMatrixPosition(m);
          const k = all.findIndex((s, j) => !seen.has(j) && s.shape === sh && Math.hypot(s.x - at.x, s.y - at.y, s.z - at.z) < 1e-4);
          expect(k).toBeGreaterThanOrEqual(0);
          seen.add(k);
          expect(rockLevel(all[k].s, Math.hypot(all[k].x - eye.x, all[k].y - eye.y, all[k].z - eye.z))).toBe(li);
          // three culls the mesh by bounds that hold every instance it draws
          expect(im.boundingSphere!.distanceToPoint(at)).toBeLessThanOrEqual(0);
        }
      }
      expect(seen.size).toBe(all.length);
    }
    // from the shore the nearest rocks are detailed, from far off none are
    lod.update({ x: 81, y: 3, z: 0 });
    expect(lod.counts()[0]).toBeGreaterThan(0);
    lod.update({ x: 2000, y: 300, z: 0 });
    expect(lod.counts()).toEqual([0, 0, all.length]);
  });

  it('picks a level by how big a rock looks', () => {
    expect(rockLevel(1, 10)).toBe(0);
    expect(rockLevel(1, 100)).toBe(1);
    expect(rockLevel(1, 1000)).toBe(2);
    expect(rockLevel(2, 80)).toBe(0); // twice the size, twice as far
    expect(rockLevel(1, 0)).toBe(0);
  });
});
