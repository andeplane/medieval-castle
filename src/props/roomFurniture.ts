// Furniture for one room as plain typed arrays: the pure half of furnishing, run in a worker
// (furnish.worker.ts) or inline (tests). Dress the room (dress.ts), merge its props into one bin per
// material (place.ts), tag every triangle with its interior-light room (render/interiorMath.ts, the
// same rule the shell's meshes get), and list its box colliders, light emitters and flames.
// No three.js and no DOM here: main wraps the arrays into meshes (roomMeshes.ts).
// Each room depends only on the plan and the seed (dress.ts seeds it from its id), so the result
// does not depend on which other rooms were furnished before it, or in which worker.
import type { InteriorPlan, SpaceId } from '../castle/interior/types';
import type { WindowFace } from '../castle/interior/shell';
import type { Flame, LightEmitter } from '../light/types';
import { tagTriangles } from '../render/interiorMath';
import { PROP_MATS, type PropMat } from './geom';
import { dressRoom, groupKey, variantPool, type Role } from './dress';
import { mergePlaced, placedFires, yawXZ, type Placed } from './place';
import type { Prop } from './kit';

/** A bounding sphere: centre xyz, radius. */
export type Sphere = [number, number, number, number];

/** One material's triangles: non-indexed xyz, normals, uv, vertex colour, the room index per vertex,
 * and their bounding sphere (so the page can bound a merged group without walking its vertices). */
export interface BinArrays { pos: Float32Array; nor: Float32Array; uv: Float32Array; col: Float32Array; room: Float32Array; sphere: Sphere }

/** Bounding sphere of xyz points: the box centre and the farthest point from it (as three's computeBoundingSphere). */
export function sphereOf(pos: ArrayLike<number>): Sphere {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], pos[i + a]); hi[a] = Math.max(hi[a], pos[i + a]); }
  const c = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2);
  let r2 = 0;
  for (let i = 0; i < pos.length; i += 3) r2 = Math.max(r2, (pos[i] - c[0]) ** 2 + (pos[i + 1] - c[1]) ** 2 + (pos[i + 2] - c[2]) ** 2);
  return [c[0], c[1], c[2], Math.sqrt(r2)];
}

/** The smallest sphere holding both. */
export function unionSphere(a: Sphere, b: Sphere): Sphere {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (d + b[3] <= a[3]) return a;
  if (d + a[3] <= b[3]) return b;
  const r = (d + a[3] + b[3]) / 2, t = (r - a[3]) / d;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, r];
}

export interface RoomFurniture {
  room: SpaceId;
  /** Visibility group of the room (dress.ts groupKey, as the shell's). */
  key: string;
  role: Role;
  props: number; triangles: number;
  bins: Partial<Record<PropMat, BinArrays>>;
  /** Box colliders of the props that block, 7 floats each: centre xyz, half size xyz, yaw. */
  boxes: Float32Array;
  emitters: LightEmitter[];
  flames: Flame[];
}

export const BOX_FLOATS = 7;

/** World boxes (centre, half, yaw) of the colliders of placed props that block navigation. */
export function colliderBoxes(items: Placed[]): Float32Array {
  const out: number[] = [];
  for (const it of items) {
    if (!it.prop.kind.blocksNav) continue;
    for (const c of it.prop.meta.colliders) {
      const [x, z] = yawXZ(c.centre[0], c.centre[2], it.yaw);
      out.push(it.at[0] + x, it.at[1] + c.centre[1], it.at[2] + z, c.half[0], c.half[1], c.half[2], it.yaw);
    }
  }
  return new Float32Array(out);
}

export interface FurnisherOptions {
  seed?: number;
  /** Rooms the interior light table holds (InteriorLight.maxRooms); tags index plan.rooms below it. */
  maxRooms: number;
  /** Prop factory (tests inject a cheap one); a variant pool over the kit by default. */
  make?: (kind: string, seed: number) => Prop;
  /** Wall distance for the room tags, as bakeInteriorLight's (4.5 m). */
  maxWall?: number;
  /** Where the windows open into the rooms (buildInterior().windows). */
  windows?: readonly WindowFace[];
}

/** A function that furnishes rooms of `plan` by id. Keeps one prop variant pool across its rooms. */
export function createFurnisher(plan: InteriorPlan, o: FurnisherOptions): (room: SpaceId) => RoomFurniture {
  const make = o.make ?? variantPool();
  const rooms = plan.rooms.slice(0, o.maxRooms);
  const index = new Map(rooms.map((r, i) => [r.id, i] as [SpaceId, number]));
  const byId = new Map(plan.rooms.map((r) => [r.id, r]));
  const prefer = new Map<string, Set<number>>();
  for (const r of plan.rooms) {
    const k = groupKey(r);
    if (!prefer.has(k)) prefer.set(k, new Set());
    const i = index.get(r.id);
    if (i !== undefined) prefer.get(k)!.add(i);
  }
  return (id) => {
    const r = byId.get(id);
    if (!r) throw new Error(`no room ${id}`);
    const d = dressRoom(r, plan, { seed: o.seed, make, windows: o.windows });
    const { mesh, emitters } = mergePlaced(d.placed);
    const bins: Partial<Record<PropMat, BinArrays>> = {};
    for (const k of PROP_MATS) {
      const b = mesh.bins[k];
      if (!b.pos.length) continue;
      const pos = new Float32Array(b.pos), nor = new Float32Array(b.nor);
      bins[k] = { pos, nor, uv: new Float32Array(b.uv), col: new Float32Array(b.col), room: tagTriangles(pos, nor, rooms, o.maxWall ?? 4.5, prefer.get(d.key)), sphere: sphereOf(pos) };
    }
    return { room: id, key: d.key, role: d.role, props: d.placed.length, triangles: mesh.triangles, bins, boxes: colliderBoxes(d.placed), emitters, flames: mesh.flames };
  };
}

/** A room's fires: its furniture's emitters and flames, as its RoomFurniture will carry them. */
export interface RoomFireList { room: SpaceId; emitters: LightEmitter[]; flames: Flame[] }

/**
 * Every room's fires without building its furniture (dress only, no triangles): the light system lights
 * every room from the first frame, so a room's fires never wait for its furniture to stream in.
 * Rooms with no fire are left out. Same dressing as createFurnisher (same plan, seed and windows).
 */
export function roomFireLists(plan: InteriorPlan, o: Omit<FurnisherOptions, 'maxRooms' | 'maxWall'> = {}, rooms: readonly SpaceId[] = plan.rooms.map((r) => r.id)): RoomFireList[] {
  const make = o.make ?? variantPool(), byId = new Map(plan.rooms.map((r) => [r.id, r]));
  const out: RoomFireList[] = [];
  for (const id of rooms) {
    const r = byId.get(id);
    if (!r) throw new Error(`no room ${id}`);
    const f = placedFires(dressRoom(r, plan, { seed: o.seed, make, windows: o.windows }).placed);
    if (f.emitters.length || f.flames.length) out.push({ room: id, ...f });
  }
  return out;
}

/** The buffers a room's message can hand over without copying. */
export function transferables(r: RoomFurniture): ArrayBuffer[] {
  const out: ArrayBuffer[] = [r.boxes.buffer as ArrayBuffer];
  for (const b of Object.values(r.bins)) out.push(b.pos.buffer as ArrayBuffer, b.nor.buffer as ArrayBuffer, b.uv.buffer as ArrayBuffer, b.col.buffer as ArrayBuffer, b.room.buffer as ArrayBuffer);
  return out;
}
