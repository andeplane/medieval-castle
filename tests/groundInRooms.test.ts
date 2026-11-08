// No outdoor surface inside a room (Anders, 2026-11-07: the cellar stair looked like "one flat, very pale
// strip" from its top landing). The near terrain grid ran on at ground level straight through the stair
// well (y 2.55, under every building) and the moat's water plane ran under the whole island at y 0, so
// from the landing you saw the outdoor-lit ground and, under it, the water's sky reflection, never a step.
// Over the whole castle: vertical rays through every room, from just under its ceiling to just over its
// floor, may not meet the rendered terrain, the water or the courtyard paving. A tunnel's room is the box
// round its whole sloping run, so there the rays run from its own crown down to its own floor; so do the
// caves' (castle/interior/caves.ts caveSpan: a chamber's dome, a passage's floor line), which run under the moat.
import { describe, expect, test } from 'vitest';
import * as THREE from 'three/webgpu';
import { MeshBVH } from 'three-mesh-bvh';
import * as T3 from 'three';
import { buildTerrain, heightAt, ISLAND } from '../src/world/terrain';
import { waterGeometry } from '../src/world/water';
import { buildCastle } from '../src/castle/castle';
import { buildInterior } from '../src/castle/interior/index';
import { pointInPoly, edgeDist, type V2 } from '../src/core/math2d';
import { floorAlong } from '../src/render/interiorFire';
import { caveSpan } from '../src/castle/interior/caves';
import { mats } from './world';

/** World-space triangle soup of a mesh as a BVH (position only). */
function bvhOf(mesh: THREE.Mesh) {
  mesh.updateMatrixWorld(true);
  const g = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()).applyMatrix4(mesh.matrixWorld);
  const geo = new T3.BufferGeometry();
  geo.setAttribute('position', new T3.BufferAttribute(g.attributes.position.array as Float32Array, 3));
  return new MeshBVH(geo);
}

/** Points on a `step` grid inside the polygon, at least `inset` from its edges. */
function samples(poly: V2[], step: number, inset: number): V2[] {
  const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]), out: V2[] = [];
  for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step) for (let z = Math.min(...zs) + step / 2; z < Math.max(...zs); z += step) {
    if (pointInPoly(poly, x, z) && edgeDist(poly, x, z).d >= inset) out.push([x, z]);
  }
  return out;
}

describe('outdoor surfaces stay out of the rooms', () => {
  test('no terrain, water or paving inside any room', () => {
    // as main.ts builds them: the interior first (it carves the castle and hands over its ground holes)
    const { builder } = buildCastle();
    const { plan, groundHoles } = buildInterior(mats(), builder, { heightAt });
    const castle = builder.build(mats());
    const terrain = buildTerrain(new THREE.MeshBasicMaterial(), undefined, { holes: groundHoles.terrain });
    const water = new THREE.Mesh(waterGeometry(9000, ISLAND, groundHoles.water), new THREE.MeshBasicMaterial());
    water.rotation.x = -Math.PI / 2;
    const surfaces: [string, MeshBVH][] = [
      ['terrain', bvhOf(terrain.getObjectByName('terrain-near') as THREE.Mesh)],
      ['water', bvhOf(water)],
      ['paving', bvhOf(castle.children.find((c) => (c as THREE.Mesh).isMesh && c.name === 'castle-pave') as THREE.Mesh)],
    ];
    const ray = new T3.Ray(), down = new T3.Vector3(0, -1, 0);
    const bad: string[] = [];
    let rays = 0;
    for (const r of plan.rooms) {
      const hits = new Map<string, number>();
      const tunnel = plan.tunnels.find((t) => t.room === r.id);
      for (const [x, z] of samples(r.poly, 0.2, 0.03)) {
        rays++;
        const cave = plan.caves ? caveSpan(plan.caves, r.id, [x, z]) : null;
        const y0 = tunnel ? floorAlong(tunnel.path, [x, z]) : cave ? cave.floor : r.y0, y1 = tunnel ? y0 + tunnel.crown : cave ? cave.ceil : r.y1;
        ray.origin.set(x, y1 - 0.02, z); ray.direction.copy(down);
        for (const [name, bvh] of surfaces) {
          const h = bvh.raycastFirst(ray, T3.DoubleSide, 0, y1 - y0 - 0.04);
          if (h) hits.set(name, (hits.get(name) ?? 0) + 1);
        }
      }
      for (const [name, n] of hits) bad.push(`${r.id} (y ${r.y0.toFixed(2)}..${r.y1.toFixed(2)}): ${n} rays meet the ${name}`);
    }
    console.info(`ground in rooms: ${plan.rooms.length} rooms, ${rays} rays, ${bad.length} failures`);
    expect(rays).toBeGreaterThan(10_000);
    expect(bad).toEqual([]);
  }, 120_000);
});
