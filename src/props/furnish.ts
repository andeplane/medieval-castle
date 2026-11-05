// Furniture for the real castle: dress the interior plan (pure, src/props/dress.ts), then turn each
// visibility group's props into meshes (one per material) that main parents under that group's object,
// so they show and hide with their rooms. Also returns light emitters and box colliders per group.
import * as THREE from 'three/webgpu';
import type { InteriorPlan } from '../castle/interior/types';
import { dressPlan, type DressDeps, type Dressing } from './dress';
import { mergePlaced, colliderSoup } from './place';
import { meshFromProp, type PropMaterials } from './render';
import type { Emitter } from './kit';
import type { Flame } from '../light/types';

export interface Furniture {
  dressing: Dressing;
  objects: Map<string, THREE.Group>;
  emitters: Map<string, Emitter[]>;
  /** Flames per group for src/light (`makeFlameSprites(linkFlames(flames, emitters))`). */
  flames: Map<string, Flame[]>;
  collision: Map<string, THREE.BufferGeometry>;
  triangles: number; props: number;
}

export function furnish(plan: InteriorPlan, mats: PropMaterials, deps: DressDeps & { dress?: typeof dressPlan } = {}): Furniture {
  const dressing = (deps.dress ?? dressPlan)(plan, deps);
  const objects = new Map<string, THREE.Group>(), emitters = new Map<string, Emitter[]>(), flames = new Map<string, Flame[]>(), collision = new Map<string, THREE.BufferGeometry>();
  let triangles = 0, props = 0;
  for (const [key, placed] of dressing.byGroup) {
    const { mesh, emitters: em } = mergePlaced(placed);
    const g = meshFromProp(mesh, mats, `furniture:${key}`);
    objects.set(key, g); emitters.set(key, em); flames.set(key, mesh.flames);
    const soup = colliderSoup(placed);
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(soup, 3));
    cg.name = `collide-furniture:${key}`;
    collision.set(key, cg);
    triangles += g.userData.triangles; props += placed.length;
  }
  return { dressing, objects, emitters, flames, collision, triangles, props };
}
