// Interior entry point: plan → shell → carve the exterior → meshes per visibility group.
// Call between buildCastle() and builder.build(): the exterior bins are carved in place.
import * as THREE from 'three/webgpu';
import type { Builder, MatKey } from '../builder';
import type { InteriorGroup } from './types';
import { planInterior, type PlanX } from './plan';
import { buildShell, type ShellDeps } from './shell';
import { carve } from './carve';

export interface InteriorResult {
  plan: PlanX;
  groups: InteriorGroup[];
  /** One triangle soup per group (world space, non-indexed): static colliders for the player. */
  collision: THREE.BufferGeometry[];
  triangles: number;
  stats: { windows: number; windowsSkipped: number; carved: number; carveMs: number };
}

export interface InteriorDeps extends ShellDeps { plan?: PlanX }

export function buildInterior(materials: Record<MatKey, THREE.Material>, ext: Builder, deps: InteriorDeps = {}): InteriorResult {
  const plan = deps.plan ?? planInterior();
  const shell = buildShell(plan, ext, deps);
  const t0 = performance.now();
  const cut = carve(Object.values(ext.bins), shell.carve);
  // the real-stone layer (src/castle/stones) must not lay stones where rooms and doorways now are
  for (const v of shell.carve) ext.exclude(v.pts);
  const carveMs = performance.now() - t0;
  const groups: InteriorGroup[] = [], collision: THREE.BufferGeometry[] = [];
  let triangles = 0;
  for (const g of shell.groups) {
    const object = new THREE.Group();
    object.name = `interior:${g.key}`;
    const all: number[] = [];
    for (const k of Object.keys(g.B.bins) as MatKey[]) {
      const b = g.B.bins[k];
      if (!b.pos.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      geo.computeBoundingSphere();
      const m = new THREE.Mesh(geo, materials[k]);
      m.name = `interior-${g.key}-${k}`;
      m.castShadow = k !== 'glass' && k !== 'void';
      m.receiveShadow = true;
      object.add(m);
      triangles += b.pos.length / 9;
      if (k !== 'glass') for (const v of b.pos) all.push(v);
    }
    const bounds = new THREE.Box3().setFromObject(object);
    groups.push({ key: g.key, zone: g.zone, floor: g.floor, object, bounds, rooms: g.rooms });
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(all, 3));
    cg.name = `collide:${g.key}`;
    collision.push(cg);
  }
  return { plan, groups, collision, triangles, stats: { windows: shell.windows, windowsSkipped: shell.skipped, carved: cut.removed, carveMs: Math.round(carveMs) } };
}

export { planInterior, validatePlan } from './plan';
export type { PlanX } from './plan';
