// three.js side of streamed furniture. A room's colliders and fires go in (and out) at once; its
// arrays (roomFurniture.ts) join its visibility group, whose loaded rooms are merged into one mesh per
// material (one draw call per material per group, as the castle's Builder bins), parented under the
// group so it shows and hides with its rooms. A group whose rooms changed is rebuilt in flush(), which
// the streamer calls inside its frame budget: one room is copied into the new arrays per step, and the
// old mesh stays drawn until the new one is complete and swaps in. Bounding spheres come per room from
// the worker. A merged mesh is frustum culled by its rooms' spheres, not by the one sphere round the
// whole group (a wing floor), so each camera (view, AO pre-pass, reflection, shadow map) skips furniture
// whose rooms it cannot see. Thin glue: shapes, tags and colliders come from the worker.
import * as THREE from 'three/webgpu';
import type { PhysicsApi, SpaceId } from '../castle/interior/types';
import type { Flame, LightEmitter } from '../light/types';
import { PROP_MATS, type PropMat } from './geom';
import { unionSphere, type RoomFurniture, type BinArrays, type Sphere } from './roomFurniture';
import type { RoomSink } from './streamer';

const FIELDS = ['pos', 'nor', 'uv', 'col', 'room'] as const;
type Field = (typeof FIELDS)[number];

/** A merge in progress: arrays sized for every room, filled a slice per step. `next` is the room
 * being copied, `part` its (material, field) pair and `off` how far into that array. */
export interface BinMerge { rooms: RoomFurniture[]; next: number; part: number; off: number; bins: Partial<Record<PropMat, BinArrays>>; spheres: Partial<Record<PropMat, Sphere[]>>; at: Partial<Record<PropMat, Record<Field, number>>>; size: Partial<Record<PropMat, Record<Field, number>>> }

/** Floats copied per step (256 KB; 1 MB took ~10 ms on the loaded headless box, fresh pages): a big room spans several steps. */
export const MERGE_CHUNK = 1 << 16;

export function startMerge(rooms: RoomFurniture[]): BinMerge {
  // only sizes here: each array is allocated by the step that first writes it (a big group's arrays
  // are megabytes, and fresh memory costs time to hand out)
  const bins: Partial<Record<PropMat, BinArrays>> = {}, spheres: BinMerge['spheres'] = {}, at: BinMerge['at'] = {}, size: BinMerge['size'] = {};
  const none = new Float32Array(0);
  for (const k of PROP_MATS) {
    const parts = rooms.map((r) => r.bins[k]).filter((b): b is BinArrays => !!b);
    if (!parts.length) continue;
    const n = (f: Field) => parts.reduce((t, b) => t + b[f].length, 0);
    bins[k] = { pos: none, nor: none, uv: none, col: none, room: none, sphere: parts.map((b) => b.sphere).reduce(unionSphere) };
    spheres[k] = parts.map((b) => b.sphere);
    at[k] = { pos: 0, nor: 0, uv: 0, col: 0, room: 0 };
    size[k] = { pos: n('pos'), nor: n('nor'), uv: n('uv'), col: n('col'), room: n('room') };
  }
  return { rooms, next: 0, part: 0, off: 0, bins, spheres, at, size };
}

const PARTS = PROP_MATS.flatMap((k) => FIELDS.map((f) => [k, f] as const));

/** Copy up to `chunk` floats more. Returns true once every room is in. */
export function stepMerge(m: BinMerge, chunk = MERGE_CHUNK): boolean {
  let left = chunk;
  while (m.next < m.rooms.length && left > 0) {
    const [k, f] = PARTS[m.part], src = m.rooms[m.next].bins[k]?.[f];
    if (src) {
      // allocating counts against the step a quarter as much as copying
      if (m.bins[k]![f].length !== m.size[k]![f]) { m.bins[k]![f] = new Float32Array(m.size[k]![f]); left -= m.size[k]![f] >> 2; if (left <= 0) break; }
      const n = Math.min(left, src.length - m.off);
      m.bins[k]![f].set(src.subarray(m.off, m.off + n), m.at[k]![f]);
      m.at[k]![f] += n; m.off += n; left -= n;
      if (m.off < src.length) break;
    }
    m.off = 0;
    if (++m.part === PARTS.length) { m.part = 0; m.next++; }
  }
  return m.next >= m.rooms.length;
}

/** Concatenate the rooms' bins per material, in the order given (all steps at once). */
export function mergeBins(rooms: RoomFurniture[]): Partial<Record<PropMat, BinArrays>> {
  const m = startMerge(rooms);
  while (!stepMerge(m));
  return m.bins;
}

/** Frustum cull a mesh by a few spheres (its rooms' parts) instead of its one bounding sphere; kept in userData.spheres. */
export function cullBySpheres(m: THREE.Mesh, spheres: Sphere[]) {
  const ss = spheres.map((s) => new THREE.Sphere(new THREE.Vector3(s[0], s[1], s[2]), s[3]));
  m.userData.spheres = ss;
  m.intersectsFrustum = (f: THREE.Frustum) => ss.some((s) => f.intersectsSphere(_s.copy(s).applyMatrix4(m.matrixWorld)));
}
const _s = new THREE.Sphere();

/** One mesh per non-empty bin, with the interior light's room tag (`interiorRoom`) per vertex; `spheres`: its rooms' bounds per bin. */
export function meshesFromBins(name: string, bins: Partial<Record<PropMat, BinArrays>>, mats: Record<PropMat, THREE.Material>, spheres: Partial<Record<PropMat, Sphere[]>> = {}): THREE.Group {
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
    if (spheres[k]) cullBySpheres(m, spheres[k]);
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
      g.object = meshesFromBins(`furniture:${key}`, g.merge.bins, d.matsFor(key), g.merge.spheres);
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
