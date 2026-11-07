// three.js side of streamed furniture: wrap a room's arrays (roomFurniture.ts) into one mesh per
// material, parent it under the room's visibility group (so it shows and hides with the room), add its
// box colliders to the physics world and its fires to the light system; and take all that out again.
// Thin glue: shapes, tags and colliders were made in the worker.
import * as THREE from 'three/webgpu';
import type { PhysicsApi, SpaceId } from '../castle/interior/types';
import type { Flame, LightEmitter } from '../light/types';
import { PROP_MATS, type PropMat } from './geom';
import type { RoomFurniture } from './roomFurniture';
import type { RoomSink } from './streamer';

/** One mesh per non-empty bin, with the interior light's room tag (`interiorRoom`) per vertex. */
export function meshesFromRoom(r: RoomFurniture, mats: Record<PropMat, THREE.Material>): THREE.Group {
  const group = new THREE.Group();
  group.name = `furniture:${r.room}`;
  for (const k of PROP_MATS) {
    const b = r.bins[k];
    if (!b) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(b.nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(b.uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(b.col, 3));
    g.setAttribute('interiorRoom', new THREE.BufferAttribute(b.room, 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mats[k]);
    m.name = `${group.name}-${k}`;
    m.castShadow = k !== 'flame' && k !== 'cloth'; // as render.ts meshFromProp
    m.receiveShadow = k !== 'flame';
    group.add(m);
  }
  group.userData.triangles = r.triangles;
  return group;
}

/** Fires per room for the light system (src/light/roomFires.ts). */
export interface RoomFireSink { set(room: SpaceId, emitters: LightEmitter[], flames: Flame[]): void; clear(room: SpaceId): void }

export interface RoomSinkDeps {
  /** The visibility group's object for a group key; rooms without one are not drawn. */
  parentOf(key: string): THREE.Object3D | undefined;
  /** Materials for a room's meshes (the interior light's clones, sun or no sun). */
  matsFor(r: RoomFurniture): Record<PropMat, THREE.Material>;
  physics: Pick<PhysicsApi, 'addStaticBoxes'>;
  fire: RoomFireSink;
}

export interface RoomHandle { room: SpaceId; object: THREE.Group; colliders: { remove(): void } }

export function createRoomSink(d: RoomSinkDeps): RoomSink<RoomHandle> {
  return {
    add(r) {
      const object = meshesFromRoom(r, d.matsFor(r));
      d.parentOf(r.key)?.add(object);
      const colliders = d.physics.addStaticBoxes(r.boxes, `furniture:${r.room}`);
      if (r.emitters.length || r.flames.length) d.fire.set(r.room, r.emitters, r.flames);
      return { room: r.room, object, colliders };
    },
    remove(h) {
      h.object.removeFromParent();
      h.object.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
      h.colliders.remove();
      d.fire.clear(h.room);
    },
  };
}
