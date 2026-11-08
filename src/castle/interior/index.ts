// Interior entry point: plan → shell → carve the exterior → meshes per visibility group.
// Call between buildCastle() and builder.build(): the exterior bins are carved in place.
import * as THREE from 'three/webgpu';
import type { Builder, MatKey, BinKey } from '../builder';
import type { InteriorGroup } from './types';
import { planInterior, stairOpts, type PlanX } from './plan';
import { stairCollisionRamp } from './stairs';
import { buildShell, type GroundHoles, type ShellDeps } from './shell';
import { carve } from './carve';
import { caveRampSoups } from './caveGeom';

export interface InteriorResult {
  plan: PlanX;
  groups: InteriorGroup[];
  /**
   * Static colliders for walking characters (world space, non-indexed): one triangle soup per group,
   * then one invisible ramp per stair flight laid over its nosings, so characters glide up and down
   * instead of catching on every riser (the steps stay as rendered for the eye).
   */
  collision: THREE.BufferGeometry[];
  triangles: number;
  /** Outdoor ground to leave out beyond world/terrain.ts groundHole (main.ts: terrain, water, its collider). */
  groundHoles: GroundHoles;
  stats: { windows: number; windowsSkipped: number; carved: number; carveMs: number };
}

export interface InteriorDeps extends ShellDeps { plan?: PlanX }

export function buildInterior(materials: Record<MatKey, THREE.Material> & Partial<Record<BinKey, THREE.Material>>, ext: Builder, deps: InteriorDeps = {}): InteriorResult {
  const plan = deps.plan ?? planInterior();
  const shell = buildShell(plan, ext, deps);
  const t0 = performance.now();
  // the courtyard paving is ground, not shell: the plinth and doorway carves stop at the walls' faces
  const cut = carve(Object.entries(ext.bins).filter(([k]) => k !== 'pave').map(([, b]) => b), shell.carve);
  // the real-stone layer (src/castle/stones) must not lay stones where rooms and doorways now are
  for (const v of shell.carve) ext.exclude(v.pts);
  const carveMs = performance.now() - t0;
  const groups: InteriorGroup[] = [], collision: THREE.BufferGeometry[] = [];
  let triangles = 0;
  for (const g of shell.groups) {
    const object = new THREE.Group();
    object.name = `interior:${g.key}`;
    const all: number[] = [];
    for (const k of Object.keys(g.B.bins) as BinKey[]) {
      const b = g.B.bins[k];
      if (!b.pos.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      geo.computeBoundingSphere();
      const m = new THREE.Mesh(geo, materials[k] ?? materials.old);
      m.name = `interior-${g.key}-${k}`;
      m.castShadow = k !== 'glass' && k !== 'void' && k !== 'pool' && k !== 'glow';
      m.receiveShadow = true;
      object.add(m);
      triangles += b.pos.length / 9;
      if (k !== 'glass' && k !== 'pool' && k !== 'glow') for (const v of b.pos) all.push(v); // walk on the pool's bed, through the fungi
    }
    const bounds = new THREE.Box3().setFromObject(object);
    groups.push({ key: g.key, zone: g.zone, floor: g.floor, object, bounds, rooms: g.rooms });
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(all, 3));
    cg.name = `collide:${g.key}`;
    collision.push(cg);
  }
  for (const s of plan.stairs) {
    const ramp = stairCollisionRamp(s, stairOpts(plan, s));
    if (ramp) { ramp.name = `ramp:${s.id}`; collision.push(ramp); }
  }
  // the caves' rough steps: a walking ramp over their nosings (caveGeom.ts)
  if (plan.caves) caveRampSoups(plan.caves).forEach(({ id, soup }) => {
    const ramp = new THREE.BufferGeometry();
    ramp.setAttribute('position', new THREE.Float32BufferAttribute(soup, 3));
    ramp.name = `ramp:${id}`;
    collision.push(ramp);
  });
  return { plan, groups, collision, triangles, groundHoles: shell.groundHoles, stats: { windows: shell.windows, windowsSkipped: shell.skipped, carved: cut.removed, carveMs: Math.round(carveMs) } };
}

export { planInterior, validatePlan } from './plan';
export type { PlanX } from './plan';
