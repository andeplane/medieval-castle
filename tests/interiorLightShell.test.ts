// The interior light over the real shell (PR #15): every group tagged, every room solved, bake time.
import { describe, expect, test } from 'vitest';
import * as THREE from 'three/webgpu';
import { bakeInteriorLight, bvhOccluder, createInteriorLight } from '../src/render/interiorLight';
import { buildInterior } from '../src/castle/interior/index';
import { buildCastle } from '../src/castle/castle';
import type { MatKey } from '../src/castle/builder';
import type { WindowInput } from '../src/render/interiorMath';

describe('interior light over the shell', () => {
  test('bakes all rooms of the castle', () => {
    const { builder, lights } = buildCastle();
    const mats = Object.fromEntries(['old', 'new', 'trim', 'slate', 'lead', 'wood', 'iron', 'void', 'glass'].map((k) => [k, new THREE.MeshStandardNodeMaterial()])) as unknown as Record<MatKey, THREE.Material>;
    const res = buildInterior(mats, builder, { heightAt: () => 2.6 });
    const castle = builder.build(mats);
    const t0 = performance.now();
    const occ = bvhOccluder([castle, ...res.groups.map((g) => g.object)]);
    const bvhMs = performance.now() - t0;
    const bake = bakeInteriorLight(res.groups, occ, { plan: res.plan, windows: lights as WindowInput[], sun: () => ({ dir: [-0.4, 0.63, 0.66], irradiance: [3.2, 3.1, 2.9] }), light: createInteriorLight() });
    console.info(`shell bake: ${bake.rooms} rooms, ${bake.apertures.length} apertures, ${bake.triangles} tris, bake ${bake.ms.toFixed(0)} ms ${JSON.stringify(bake.timings)}, BVH ${bvhMs.toFixed(0)} ms`);
    expect(bake.rooms).toBe(res.plan.rooms.length);
    expect(bake.apertures.filter((a) => a.kind === 'glass').length).toBeGreaterThan(50);
    for (const g of res.groups) g.object.traverse((o) => { if ((o as THREE.Mesh).isMesh) expect((o as THREE.Mesh).geometry.attributes.interiorRoom).toBeDefined(); });
    // every room above ground with a window gets some daylight
    const lit = res.plan.rooms.filter((r) => r.floor >= 0 && bake.apertures.some((a) => a.kind === 'glass' && res.plan.rooms[a.room] === r));
    expect(lit.length).toBeGreaterThan(30);
    for (const r of lit) expect(Math.max(...bake.roomLight(r.id)!.bounce)).toBeGreaterThan(0);
  }, 120_000);
});
