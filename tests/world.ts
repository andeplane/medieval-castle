// Shared fixtures for tests that walk the real island: placeholder materials and a coarse stand-in for
// the render terrain (the same grid as buildTerrain's near grid, plus one near and one far rock).
import * as THREE from 'three/webgpu';
import type { BinKey } from '../src/castle/builder';
import { ISLAND, MOAT_OUTER, heightAt } from '../src/world/terrain';
import { pointInPoly, type V2 } from '../src/core/math2d';
import { buildCastle } from '../src/castle/castle';
import { bridgePlan, buildBridge } from '../src/castle/bridge';
import { revetmentPlan, buildRevetment } from '../src/castle/revetment';
import { gatehouseFrame } from '../src/castle/layout';
import { rngFor } from '../src/core/rng';
import { bridgeInfo } from '../src/physics/boundary';

/** The castle, bridge and revetment in one Builder, exactly as main.ts lays them (before the interior). */
export function islandCastle() {
  const { builder } = buildCastle();
  const plan = bridgePlan({ island: ISLAND, moatOuter: MOAT_OUTER, gate: gatehouseFrame(), groundAt: heightAt, rng: rngFor('bridge') });
  buildBridge(builder, plan, rngFor('bridge-stones'));
  buildRevetment(builder, revetmentPlan({ island: ISLAND, groundAt: heightAt, rng: rngFor('revetment'), exclude: (x, z) => pointInPoly(plan.footprint, x, z) }), rngFor('revetment-stones'));
  return { builder, plan, bridge: bridgeInfo(plan.walkable, plan.d) };
}

export const mats = () => { const m = new THREE.MeshBasicMaterial(); return Object.fromEntries((['old', 'new', 'trim', 'slate', 'lead', 'wood', 'iron', 'void', 'glass', 'pave'] as BinKey[]).map((k) => [k, m])) as unknown as Record<BinKey, THREE.Material>; };
export const doorMats = () => ({ wood: new THREE.MeshBasicMaterial(), iron: new THREE.MeshBasicMaterial(), trim: new THREE.MeshBasicMaterial() });

/** Where the test terrain's near rock sits (12 m in from an island outline vertex). */
export const ROCK: V2 = (() => { const e = ISLAND[24], l = Math.hypot(e[0], e[1]); return [e[0] * (1 - 12 / l), e[1] * (1 - 12 / l)]; })();

export function terrainObject(size = 380, seg = 420) { // buildTerrain's near grid (0.9 m cells)
  const g = new THREE.PlaneGeometry(size, size, seg, seg);
  g.rotateX(-Math.PI / 2);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setY(i, heightAt(p.getX(i), p.getZ(i)));
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial()); mesh.name = 'terrain-near';
  // a rock on the lawn (near: collides) and one far away (far detail: ignored), like buildRocks
  const rocks = new THREE.Group(); rocks.name = 'rocks';
  for (const tag of ['near', 'far']) {
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), new THREE.MeshBasicMaterial(), 1);
    im.name = `rocks-${tag}-0`;
    im.setMatrixAt(0, new THREE.Matrix4().makeTranslation(ROCK[0], heightAt(ROCK[0], ROCK[1]) + 0.4, ROCK[1]));
    rocks.add(im);
  }
  const grp = new THREE.Group(); grp.add(mesh, rocks);
  return grp;
}
