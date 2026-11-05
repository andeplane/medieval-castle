// Room/cell visibility for the interior (game-performance-optimization: cells and portals beat generic
// occlusion indoors). Each frame: find the camera's room, then show
//   inside:  its group, the groups of rooms joined to it by a door or stair, stairs within 12 m;
//   outside: groups within 40 m that have a window or door facing the camera (the windows of the
//            others show the dark fallback pane, render/windowGlass.ts).
// Underground (camera below the terrain) everything outdoors is hidden: terrain, water, vegetation,
// the castle exterior, its stones and the gate; deep inside a room with no open way out within 40 m
// the vegetation is hidden too.
// No three.js at runtime here, so the decision is unit-tested (tests/interior.test.ts).
import type { InteriorGroup, InteriorPlan, SpaceId, V3 } from '../castle/interior/types';
import type { Aperture } from '../render/interiorMath';
import { roomAt } from '../render/interiorMath';

export interface GroupInfo { key: string; zone: string; floor: number; min: V3; max: V3; rooms: number[]; apertures: { p: V3; n: V3; open: boolean }[] }

export interface VisOpts { far: number; stairs: number; deepClear: number; ground?: (x: number, z: number) => number }
const DEF: VisOpts = { far: 40, stairs: 12, deepClear: 40 };

const boxDist = (g: GroupInfo, p: V3) => Math.hypot(
  Math.max(g.min[0] - p[0], 0, p[0] - g.max[0]), Math.max(g.min[1] - p[1], 0, p[1] - g.max[1]), Math.max(g.min[2] - p[2], 0, p[2] - g.max[2]));

export interface VisContext { plan: InteriorPlan; groups: GroupInfo[]; doorAdj: Map<number, Set<number>> }

export function visContext(plan: InteriorPlan, groups: GroupInfo[]): VisContext {
  const index = new Map(plan.rooms.map((r, i) => [r.id, i]));
  const doorAdj = new Map<number, Set<number>>();
  const link = <K>(m: Map<K, Set<K>>, a: K, b: K) => { if (a === b) return; (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b); (m.get(b) ?? m.set(b, new Set()).get(b)!).add(a); };
  for (const d of plan.doors) {
    const a = index.get(d.spaces[0]), b = index.get(d.spaces[1]);
    if (a === undefined || b === undefined) continue;
    link(doorAdj, a, b);
  }
  for (const s of plan.stairs) for (let i = 0; i + 1 < s.spaces.length; i++) {
    const a = index.get(s.spaces[i]), b = index.get(s.spaces[i + 1]);
    if (a !== undefined && b !== undefined) link(doorAdj, a, b);
  }
  return { plan, groups, doorAdj };
}

export interface VisResult { room: number; inside: boolean; deep: boolean; underground: boolean; visible: boolean[] }

export function visibleSet(ctx: VisContext, cam: V3, o: VisOpts = DEF): VisResult {
  const { plan, groups } = ctx;
  let room = roomAt(plan.rooms, cam, 0);
  if (room < 0) room = roomAt(plan.rooms, cam, 0.9); // standing in a doorway or embrasure
  const underground = o.ground ? cam[1] < o.ground(cam[0], cam[2]) - 1 : false;
  const visible = groups.map(() => false);
  if (room >= 0) {
    const doors = ctx.doorAdj.get(room);
    groups.forEach((g, i) => {
      if (g.key === 'doors') { visible[i] = true; return; }
      if (g.key.startsWith('stairs:')) { visible[i] = boxDist(g, cam) < o.stairs; return; }
      if (g.rooms.includes(room) || boxDist(g, cam) < 0.3) { visible[i] = true; return; }
      if (doors && g.rooms.some((r) => doors.has(r))) visible[i] = true;
    });
  } else {
    groups.forEach((g, i) => {
      const d = boxDist(g, cam);
      if (d < 1) { visible[i] = true; return; }
      if (g.key === 'doors') { visible[i] = d < o.far; return; }
      if (g.key.startsWith('stairs:')) { visible[i] = d < o.stairs * 0.8; return; }
      if (d > o.far) return;
      visible[i] = g.apertures.some((a) => {
        const dx = cam[0] - a.p[0], dy = cam[1] - a.p[1], dz = cam[2] - a.p[2];
        return dx * a.n[0] + dy * a.n[1] + dz * a.n[2] > 0 && Math.hypot(dx, dy, dz) < o.far;
      });
    });
  }
  // deep inside: no open way out (door, grille) in the visible cells within reach
  let deep = false;
  if (room >= 0) {
    deep = !groups.some((g, i) => visible[i] && g.apertures.some((a) => a.open && Math.hypot(cam[0] - a.p[0], cam[1] - a.p[1], cam[2] - a.p[2]) < o.deepClear));
  }
  return { room, inside: room >= 0, deep: deep || underground, underground, visible };
}

export const HIDE_UNDERGROUND = ['water', 'terrain', 'vegetation', 'castle', 'stones', 'doors', 'trees', 'ground-cover', 'rocks', 'far-forest'];
export const HIDE_DEEP = ['vegetation', 'trees', 'ground-cover', 'far-forest'];

interface Obj { visible: boolean; name: string }
interface SceneLike { getObjectByName(n: string): Obj | undefined }
interface CamLike { position: { x: number; y: number; z: number } }

/**
 * Per-frame visibility for the shell's InteriorGroups. `apertures` (from bakeInteriorLight) tell which
 * way each group's windows and doors face. Outdoor objects are looked up by name in `scene`.
 */
export function createVisibility(camera: CamLike, groups: InteriorGroup[], plan: InteriorPlan, opts: { scene?: SceneLike; apertures?: (Aperture & { group?: string })[]; ground?: (x: number, z: number) => number } = {}) {
  const index = new Map(plan.rooms.map((r, i) => [r.id, i]));
  const info: GroupInfo[] = groups.map((g) => ({
    key: g.key, zone: g.zone, floor: g.floor,
    min: [g.bounds.min.x, g.bounds.min.y, g.bounds.min.z], max: [g.bounds.max.x, g.bounds.max.y, g.bounds.max.z],
    rooms: g.rooms.map((id) => index.get(id)).filter((i): i is number => i !== undefined),
    apertures: (opts.apertures ?? []).filter((a) => a.group === g.key && a.kind !== 'portal').map((a) => ({ p: a.c, n: a.n, open: a.kind !== 'glass' })),
  }));
  const ctx = visContext(plan, info);
  const o: VisOpts = { ...DEF, ground: opts.ground };
  const outdoor = [...new Set([...HIDE_UNDERGROUND, ...HIDE_DEEP])].map((n) => [n, opts.scene?.getObjectByName(n)] as const).filter((x): x is readonly [string, Obj] => !!x[1]);
  const base = new Map(outdoor.map(([, obj]) => [obj, obj.visible]));
  let last: VisResult = { room: -1, inside: false, deep: false, underground: false, visible: groups.map(() => true) };
  const dynamic = new Set<{ obj: { visible: boolean }; roomOf: () => SpaceId | null }>();
  return {
    get state() { return last; },
    get roomId() { return last.room >= 0 ? plan.rooms[last.room].id : null; },
    /**
     * Dynamic things (NPCs, door leaves, dropped props) follow the cells: shown when the room they are
     * in is shown. `roomOf` returns a room id, or 'outside' / 'courtyard' / null when not in a room.
     * Returns an unregister function.
     */
    /** Room-culling hook for other systems (the fire LightRig's `visible(id)`): is this room shown? */
    isRoomVisible(id: SpaceId | null) { return roomShown(ctx, last, index.get(id ?? '') ?? -1); },
    register(obj: { visible: boolean }, roomOf: () => SpaceId | null) {
      const e = { obj, roomOf };
      dynamic.add(e);
      obj.visible = roomShown(ctx, last, index.get(roomOf() ?? '') ?? -1);
      return () => { dynamic.delete(e); };
    },
    update() {
      const p = camera.position;
      last = visibleSet(ctx, [p.x, p.y, p.z], o);
      groups.forEach((g, i) => { g.object.visible = last.visible[i]; });
      for (const [name, obj] of outdoor) {
        const hide = last.underground ? HIDE_UNDERGROUND.includes(name) : last.deep && HIDE_DEEP.includes(name);
        obj.visible = (base.get(obj) ?? true) && !hide;
      }
      for (const e of dynamic) e.obj.visible = roomShown(ctx, last, index.get(e.roomOf() ?? '') ?? -1);
      return last;
    },
  };
}

/** Is room `room` (index, -1 = outside / courtyard) shown in this visibility result? */
export function roomShown(ctx: VisContext, v: VisResult, room: number) {
  if (room < 0) return !v.underground && !(v.inside && v.deep);
  if (room === v.room || ctx.doorAdj.get(v.room)?.has(room)) return true;
  return ctx.groups.some((g, i) => v.visible[i] && g.rooms.includes(room));
}
