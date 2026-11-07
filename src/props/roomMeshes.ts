// three.js side of streamed furniture. A room's colliders and fires go in (and out) at once; its
// arrays (roomFurniture.ts) join its visibility group, whose loaded rooms are merged into one mesh per
// material (one draw call per material per group, as the castle's Builder bins), parented under the
// group so it shows and hides with its rooms. A group whose rooms changed is rebuilt in flush(), which
// the streamer calls inside its frame budget: one room is copied into the new arrays per step, and the
// old mesh stays drawn until the new one is complete and swaps in. Bounding spheres come per room from
// the worker. Thin glue: shapes, tags and colliders come from the worker.
import * as THREE from 'three/webgpu';
import type { PhysicsApi, SpaceId } from '../castle/interior/types';
import type { Flame, LightEmitter } from '../light/types';
import { PROP_MATS, type PropMat } from './geom';
import { unionSphere, type RoomFurniture, type BinArrays, type Sphere } from './roomFurniture';
import type { RoomSink } from './streamer';

const FIELDS = ['pos', 'nor', 'uv', 'col', 'room'] as const;
type Field = (typeof FIELDS)[number];

/** A merge in progress: arrays sized for every room, filled one room per step. */
export interface BinMerge { rooms: RoomFurniture[]; next: number; bins: Partial<Record<PropMat, BinArrays>>; at: Partial<Record<PropMat, Record<Field, number>>> }

export function startMerge(rooms: RoomFurniture[]): BinMerge {
  const bins: Partial<Record<PropMat, BinArrays>> = {}, at: BinMerge['at'] = {};
  for (const k of PROP_MATS) {
    const parts = rooms.map((r) => r.bins[k]).filter((b): b is BinArrays => !!b);
    if (!parts.length) continue;
    const size = (f: Field) => new Float32Array(parts.reduce((n, b) => n + b[f].length, 0));
    bins[k] = { pos: size('pos'), nor: size('nor'), uv: size('uv'), col: size('col'), room: size('room'), sphere: parts.map((b) => b.sphere).reduce(unionSphere) };
    at[k] = { pos: 0, nor: 0, uv: 0, col: 0, room: 0 };
  }
  return { rooms, next: 0, bins, at };
}

/** Copy the next room in. Returns true once every room is in. */
export function stepMerge(m: BinMerge): boolean {
  const r = m.rooms[m.next++];
  if (r) for (const k of PROP_MATS) {
    const b = r.bins[k];
    if (!b) continue;
    for (const f of FIELDS) { m.bins[k]![f].set(b[f], m.at[k]![f]); m.at[k]![f] += b[f].length; }
  }
  return m.next >= m.rooms.length;
}

/** Concatenate the rooms' bins per material, in the order given (all steps at once). */
export function mergeBins(rooms: RoomFurniture[]): Partial<Record<PropMat, BinArrays>> {
  const m = startMerge(rooms);
  while (!stepMerge(m));
  return m.bins;
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
    const s: Sphere = b.sphere;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(s[0], s[1], s[2]), s[3]);
    const m = new THREE.Mesh(g, mats[k]);
    m.name = `${name}-${k}`;
    m.castShadow = k !== 'flame' && k !== 'cloth' && k !== 'paint'; // as render.ts meshFromProp
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
  const groups = new Map<string, { rooms: Map<SpaceId, RoomFurniture>; object?: THREE.Group; merge?: BinMerge }>();
  const dirty = new Set<string>();
  const changed = (key: string) => { groups.get(key)!.merge = undefined; dirty.add(key); };
  /** One step of a group's rebuild; the new mesh replaces the old only when it is complete. */
  const step = (key: string) => {
    const g = groups.get(key)!;
    if (g.rooms.size && !g.merge) { g.merge = startMerge([...g.rooms.values()].sort((a, b) => d.order(a.room) - d.order(b.room))); return; }
    if (g.merge && !stepMerge(g.merge)) return;
    if (g.object) { g.object.removeFromParent(); g.object.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); }); g.object = undefined; }
    if (g.merge) {
      g.object = meshesFromBins(`furniture:${key}`, g.merge.bins, d.matsFor(key));
      d.parentOf(key)?.add(g.object);
      g.merge = undefined;
    } else groups.delete(key);
    dirty.delete(key);
  };
  return {
    add(r) {
      if (!groups.has(r.key)) groups.set(r.key, { rooms: new Map() });
      groups.get(r.key)!.rooms.set(r.room, r);
      changed(r.key);
      const colliders = d.physics.addStaticBoxes(r.boxes, `furniture:${r.room}`);
      if (r.emitters.length || r.flames.length) d.fire.set(r.room, r.emitters, r.flames);
      return { room: r.room, key: r.key, colliders };
    },
    remove(h) {
      groups.get(h.key)!.rooms.delete(h.room);
      changed(h.key);
      h.colliders.remove();
      d.fire.clear(h.room);
    },
    flush(over) {
      do { const key = dirty.values().next().value; if (key === undefined) break; step(key); } while (!over());
      return dirty.size > 0;
    },
    objectOf: (key) => groups.get(key)?.object,
  };
}
