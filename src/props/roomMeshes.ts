// three.js side of streamed furniture. A room's colliders and fires go in (and out) at once; its
// arrays (roomFurniture.ts) join its visibility group, whose loaded rooms are merged into one mesh per
// material (one draw call per material per group, as the castle's Builder bins), parented under the
// group so it shows and hides with its rooms. A group whose rooms changed is rebuilt in flush(), which
// the streamer calls inside its frame budget. Thin glue: shapes, tags and colliders come from the worker.
import * as THREE from 'three/webgpu';
import type { PhysicsApi, SpaceId } from '../castle/interior/types';
import type { Flame, LightEmitter } from '../light/types';
import { PROP_MATS, type PropMat } from './geom';
import type { RoomFurniture, BinArrays } from './roomFurniture';
import type { RoomSink } from './streamer';

/** Concatenate the rooms' bins per material, in the order given. */
export function mergeBins(rooms: RoomFurniture[]): Partial<Record<PropMat, BinArrays>> {
  const out: Partial<Record<PropMat, BinArrays>> = {};
  for (const k of PROP_MATS) {
    const parts = rooms.map((r) => r.bins[k]).filter((b): b is BinArrays => !!b);
    if (!parts.length) continue;
    const cat = (f: keyof BinArrays) => {
      const a = new Float32Array(parts.reduce((n, b) => n + b[f].length, 0));
      let o = 0;
      for (const b of parts) { a.set(b[f], o); o += b[f].length; }
      return a;
    };
    out[k] = { pos: cat('pos'), nor: cat('nor'), uv: cat('uv'), col: cat('col'), room: cat('room') };
  }
  return out;
}

/** One mesh per non-empty bin, with the interior light's room tag (`interiorRoom`) per vertex. */
export function meshesFromBins(name: string, bins: Partial<Record<PropMat, BinArrays>>, mats: Record<PropMat, THREE.Material>): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  let triangles = 0;
  for (const k of PROP_MATS) {
    const b = bins[k];
    if (!b) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(b.nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(b.uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(b.col, 3));
    g.setAttribute('interiorRoom', new THREE.BufferAttribute(b.room, 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mats[k]);
    m.name = `${name}-${k}`;
    m.castShadow = k !== 'flame' && k !== 'cloth'; // as render.ts meshFromProp
    m.receiveShadow = k !== 'flame';
    group.add(m);
    triangles += b.pos.length / 9;
  }
  group.userData.triangles = triangles;
  return group;
}

/** Fires per room for the light system (src/light/roomFires.ts). */
export interface RoomFireSink { set(room: SpaceId, emitters: LightEmitter[], flames: Flame[]): void; clear(room: SpaceId): void }

export interface RoomSinkDeps {
  /** The visibility group's object for a group key; groups without one are not drawn. */
  parentOf(key: string): THREE.Object3D | undefined;
  /** Materials for a group's meshes (the interior light's clones, sun or no sun). */
  matsFor(key: string): Record<PropMat, THREE.Material>;
  /** A room's place in the plan: merged meshes list their rooms in this order. */
  order(room: SpaceId): number;
  physics: Pick<PhysicsApi, 'addStaticBoxes'>;
  fire: RoomFireSink;
}

export interface RoomHandle { room: SpaceId; key: string; colliders: { remove(): void } }

export interface GroupSink extends RoomSink<RoomHandle> {
  flush(over: () => boolean): boolean;
  /** The merged object of a group, if it has one now. */
  objectOf(key: string): THREE.Group | undefined;
}

export function createRoomSink(d: RoomSinkDeps): GroupSink {
  const groups = new Map<string, { rooms: Map<SpaceId, RoomFurniture>; object?: THREE.Group }>();
  const dirty = new Set<string>();
  const rebuild = (key: string) => {
    const g = groups.get(key)!;
    if (g.object) { g.object.removeFromParent(); g.object.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); }); g.object = undefined; }
    if (g.rooms.size) {
      const rooms = [...g.rooms.values()].sort((a, b) => d.order(a.room) - d.order(b.room));
      g.object = meshesFromBins(`furniture:${key}`, mergeBins(rooms), d.matsFor(key));
      d.parentOf(key)?.add(g.object);
    } else groups.delete(key);
    dirty.delete(key);
  };
  return {
    add(r) {
      if (!groups.has(r.key)) groups.set(r.key, { rooms: new Map() });
      groups.get(r.key)!.rooms.set(r.room, r);
      dirty.add(r.key);
      const colliders = d.physics.addStaticBoxes(r.boxes, `furniture:${r.room}`);
      if (r.emitters.length || r.flames.length) d.fire.set(r.room, r.emitters, r.flames);
      return { room: r.room, key: r.key, colliders };
    },
    remove(h) {
      groups.get(h.key)!.rooms.delete(h.room);
      dirty.add(h.key);
      h.colliders.remove();
      d.fire.clear(h.room);
    },
    flush(over) {
      for (const key of [...dirty]) { rebuild(key); if (over()) break; }
      return dirty.size > 0;
    },
    objectOf: (key) => groups.get(key)?.object,
  };
}
