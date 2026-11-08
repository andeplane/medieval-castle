// Which rooms are drawn: a graph of every space (rooms, 'courtyard', 'outside'), walked from the space
// the camera is in (Anders, 2026-11-07: "build a graph of all rooms ... when we enter a room, we load the
// rooms next to it, or the next 2").
// - Nodes: every room of the plan (cellars, tunnels, stair rooms, the gate passage), 'courtyard' and
//   'outside' (the far bank counts as outside).
// - Edges: every door (with or without a leaf), every stair, and every window or slit (the one opening
//   model's apertures). An edge is `open` when nothing can shut it (a doorway without a leaf, a grille,
//   the gate, a window, a slit, a stair) and leafed otherwise. Windows and slits run one way, from the room
//   out: from inside you see out, from outside a window shows its dark fallback pane (render/windowGlass.ts)
//   and draws nothing behind it (an assumption for Anders, 2026-11-07: two-way windows drew most of the
//   castle from anywhere outdoors, 1298 draw calls at the hero view).
// - The camera's spaces: the room it is in; both spaces of a doorway it stands in; else 'courtyard' in
//   the courtyard outline and 'outside' elsewhere; above the roofs both.
// - Drawn: every space within two steps of the camera's spaces; then on through every doorway that is open
//   (one with no leaf, or whose leaf stands open now), as far as such doorways lead; then one step through
//   the windows. A group is drawn when one of its rooms is. No distance and no facing test: the same space
//   draws the same rooms from 1 m or 150 m (tests/world.test.ts checks every opening seen from every pose).
// The outdoors (terrain, water, castle, vegetation …) is hidden when neither 'courtyard' nor 'outside' is
// drawn (`deep`), the vegetation alone when deep above ground, everything outdoor when deep below it.
// No three.js at runtime here, so the decision is unit-tested (tests/visibility.test.ts).
import type { InteriorGroup, InteriorPlan, SpaceId, V3 } from '../castle/interior/types';
import type { Aperture } from '../render/interiorMath';
import { roomAt } from '../render/interiorMath';
import { waterInView, type Opening } from './waterView';

export const COURT = 'courtyard', OUTSIDE = 'outside';
/** The plan's outdoor space ids, as graph nodes ('farbank', beyond the moat, is outside). */
export const spaceNode = (s: SpaceId): SpaceId => (s === 'farbank' ? OUTSIDE : s);
const outdoor = (s: SpaceId) => s === COURT || s === OUTSIDE;

/** An edge: `open` when nothing can shut it; `leaves` the doors whose open leaf opens it; `window` through glass or a slit. */
export interface Link { to: SpaceId; open: boolean; leaves: string[]; window: boolean }
export type RoomGraph = Map<SpaceId, Link[]>;
/** A window or slit: the room behind it and the space in front ('courtyard' or 'outside'). */
export interface WindowLink { room: SpaceId; side: SpaceId }

/** The graph of every space: doors, stairs and windows as edges (several edges between two spaces: open if any is). */
export function roomGraph(plan: InteriorPlan, windows: WindowLink[] = []): RoomGraph {
  const g: RoomGraph = new Map([[COURT, []], [OUTSIDE, []], ...plan.rooms.map((r) => [r.id, []] as [SpaceId, Link[]])]);
  const link = (a: SpaceId, b: SpaceId, open: boolean, leaf?: string, window = false) => {
    a = spaceNode(a); b = spaceNode(b);
    if (a === b || !g.has(a) || !g.has(b)) return;
    for (const [x, y] of window ? [[a, b]] : [[a, b], [b, a]]) {
      let l = g.get(x)!.find((e) => e.to === y && e.window === window);
      if (!l) g.get(x)!.push(l = { to: y, open, leaves: [], window });
      l.open ||= open;
      if (leaf && !l.leaves.includes(leaf)) l.leaves.push(leaf);
    }
  };
  for (const d of plan.doors) {
    const open = !d.leaf || d.kind === 'gate' || d.kind === 'grille';
    link(d.spaces[0], d.spaces[1], open, open ? undefined : d.id);
  }
  const rooms = new Set(plan.rooms.map((r) => r.id));
  for (const s of plan.stairs) {
    // a stair with its own room (a stair tower, a straight flight) opens onto each landing without a door;
    // one without (a spiral serving the floors of its tower) joins its landings to each other
    if (rooms.has(s.id)) s.spaces.forEach((sp, i) => { if (!s.landings[i]?.door) link(s.id, sp, true); });
    else for (let i = 0; i + 1 < s.spaces.length; i++) link(s.spaces[i], s.spaces[i + 1], true);
  }
  for (const w of windows) link(w.room, w.side, true, undefined, true);
  return g;
}

/**
 * Every space within `depth` steps of `from`; then on through open doorways (no leaf, or `isOpen(leaf)`)
 * as far as they lead; then one step through the windows of everything so far.
 */
export function drawnSpaces(g: RoomGraph, from: SpaceId[], depth = 2, isOpen: (door: string) => boolean = () => false): Set<SpaceId> {
  const seen = new Set(from.map(spaceNode).filter((s) => g.has(s)));
  let front = [...seen];
  for (let k = 0; k < depth && front.length; k++) {
    const next: SpaceId[] = [];
    for (const s of front) for (const e of g.get(s)!) if (!seen.has(e.to)) { seen.add(e.to); next.push(e.to); }
    front = next;
  }
  const passable = (e: Link) => !e.window && (e.open || e.leaves.some(isOpen));
  const stack = [...seen];
  while (stack.length) for (const e of g.get(stack.pop()!)!) if (!seen.has(e.to) && passable(e)) { seen.add(e.to); stack.push(e.to); }
  for (const s of [...seen]) for (const e of g.get(s)!) if (e.window) seen.add(e.to);
  return seen;
}

/**
 * Spaces on either side of the doorway the camera stands in (the wall's thickness, where it is in
 * neither room), so walking through a door never hides the room ahead or behind. Empty when not in one.
 */
export function doorwaySpaces(plan: InteriorPlan, p: V3, margin = 0.3): SpaceId[] {
  for (const d of plan.doors) {
    const dx = p[0] - d.centre[0], dz = p[2] - d.centre[2];
    if (p[1] < d.centre[1] - 0.5 || p[1] > d.centre[1] + d.height + 1) continue;
    if (Math.abs(dx * d.along[0] + dz * d.along[1]) > d.width / 2 + margin) continue;
    if (Math.abs(dx * d.normal[0] + dz * d.normal[1]) > d.wall / 2 + margin) continue;
    return d.spaces.map(spaceNode);
  }
  return [];
}

export interface VisOpts {
  /** Is (x, z) in the courtyard's outline? Default: never. */
  court?: (x: number, z: number) => boolean;
  /** Above this height, out of every room, the camera sees into the courtyard and out over the walls. */
  roofs?: number;
  /** Terrain height, for `underground` and for whether the water can be seen. */
  ground?: (x: number, z: number) => number;
  /** The camera's frustum (planes, and directions to its far corners): with it, the water is drawn only
   * when it can be on screen (world/waterView.ts). */
  frustum?: () => { planes: PlaneLike[]; corners: V3[] };
}

/** The camera's spaces: its room, both sides of a doorway, or the courtyard / outside it stands in. */
export function cameraSpaces(plan: InteriorPlan, cam: V3, o: VisOpts = {}): { room: number; spaces: SpaceId[] } {
  const door = doorwaySpaces(plan, cam);
  let room = roomAt(plan.rooms, cam, 0);
  if (room < 0 && !door.length) room = roomAt(plan.rooms, cam, 0.9); // in an embrasure
  const spaces = [...new Set([...(room >= 0 ? [plan.rooms[room].id] : []), ...door])];
  if (!spaces.length) {
    if (o.roofs !== undefined && cam[1] > o.roofs) spaces.push(COURT, OUTSIDE);
    else spaces.push(o.court?.(cam[0], cam[2]) ? COURT : OUTSIDE);
  }
  if (room < 0) room = plan.rooms.findIndex((r) => r.id === spaces.find((s) => !outdoor(s)));
  return { room, spaces };
}

export interface GroupInfo { key: string; rooms: SpaceId[] }
export interface VisContext { plan: InteriorPlan; graph: RoomGraph; groups: GroupInfo[] }
export interface VisResult {
  room: number; inside: boolean;
  /** the camera's spaces, and every space the graph draws from them */
  from: SpaceId[]; drawn: Set<SpaceId>;
  /** every space whose geometry is on screen: the drawn ones and the other rooms of their groups */
  shown: Set<SpaceId>;
  /** neither the courtyard nor the outside is drawn; underground: and the camera is below the terrain */
  deep: boolean; underground: boolean;
  visible: boolean[];
}

export function visibleSet(ctx: VisContext, cam: V3, o: VisOpts = {}, isOpen?: (door: string) => boolean): VisResult {
  const { room, spaces } = cameraSpaces(ctx.plan, cam, o);
  const drawn = drawnSpaces(ctx.graph, spaces, 2, isOpen);
  const deep = !drawn.has(COURT) && !drawn.has(OUTSIDE);
  const underground = deep && !!o.ground && cam[1] < o.ground(cam[0], cam[2]) - 1;
  const visible = ctx.groups.map((g) => !g.rooms.length || g.rooms.some((r) => drawn.has(r)));
  // a group draws all its rooms: what stands in them (leaves, NPCs, props) is shown with them
  const shown = new Set(drawn);
  ctx.groups.forEach((g, i) => { if (visible[i]) for (const r of g.rooms) shown.add(r); });
  return { room, inside: room >= 0, from: spaces, drawn, shown, deep, underground, visible };
}

/** Is space `id` (a room, 'courtyard', 'outside'; null = anywhere outdoors) on screen in this result? */
export function spaceShown(v: VisResult, id: SpaceId | null) {
  if (id === null) return v.shown.has(COURT) || v.shown.has(OUTSIDE);
  return v.shown.has(spaceNode(id));
}

/** Windows and slits from the interior light's apertures: each joins its room to the space in front of it. */
export function windowLinks(plan: InteriorPlan, apertures: Aperture[], court: (x: number, z: number) => boolean): WindowLink[] {
  return apertures.filter((a) => a.door === undefined && a.kind !== 'portal' && plan.rooms[a.room]).map((a) => ({
    room: plan.rooms[a.room].id, side: court(a.c[0] + a.n[0], a.c[2] + a.n[2]) ? COURT : OUTSIDE,
  }));
}

/** The openings onto the outside of the drawn spaces: windows (the interior light's apertures, the ones
 * whose front is not the courtyard) and doorways between a drawn space and the outside. */
/**
 * The spaces a line of sight from `from` can reach now: through doorways that are open (no leaf, or its
 * leaf open) and stairs, as far as they lead, and into the rooms whose windows look onto `from` (from the
 * courtyard, through a window into the room behind it); not through a shut leaf. (A line out of one window,
 * across the courtyard, in at another and out of that room's far side is not followed; the whole-castle
 * test in tests/world.test.ts checks that no such view of the water is missed.)
 */
export function sightSpaces(g: RoomGraph, from: SpaceId[], isOpen: (door: string) => boolean = () => false): Set<SpaceId> {
  const start = new Set(from.map(spaceNode).filter((s) => g.has(s)));
  for (const [s, es] of g) if (es.some((e) => e.window && start.has(e.to))) start.add(s);
  const seen = new Set(start), stack = [...seen];
  while (stack.length) for (const e of g.get(stack.pop()!)!) if (!seen.has(e.to) && !e.window && (e.open || e.leaves.some(isOpen))) { seen.add(e.to); stack.push(e.to); }
  return seen;
}

/** The openings onto the outside that a line of sight from `seen` (sightSpaces) can pass: the windows of
 * its rooms (the interior light's apertures whose front is not the courtyard) and its doorways onto the
 * outside that are open (no leaf, the gate, a grille, or its leaf open). */
export function outsideOpenings(plan: InteriorPlan, apertures: Aperture[], court: (x: number, z: number) => boolean, seen: Set<SpaceId>, isOpen: (door: string) => boolean = () => false): Opening[] {
  const out: Opening[] = [];
  for (const a of apertures) {
    const r = plan.rooms[a.room];
    if (a.door !== undefined || a.kind === 'portal' || !r || !seen.has(r.id) || court(a.c[0] + a.n[0], a.c[2] + a.n[2])) continue;
    out.push({ c: a.c, n: a.n, w: a.w, h: a.h, ahead: a.outer });
  }
  for (const d of plan.doors) {
    const k = d.spaces.findIndex((s) => spaceNode(s) === OUTSIDE);
    if (k < 0 || !d.spaces.some((s) => seen.has(spaceNode(s)))) continue;
    if (d.leaf && d.kind !== 'gate' && d.kind !== 'grille' && !isOpen(d.id)) continue; // a shut leaf
    const sg = k === 1 ? 1 : -1;
    const h = d.height + d.width / 2; // up to the crown of any arch
    out.push({ c: [d.centre[0], d.centre[1] + h / 2, d.centre[2]], n: [d.normal[0] * sg, 0, d.normal[1] * sg], w: d.width, h, ahead: d.wall / 2 });
  }
  return out;
}

export const HIDE_UNDERGROUND = ['water', 'terrain', 'vegetation', 'castle', 'stones', 'doors', 'trees', 'ground-cover', 'rocks', 'far-forest'];
export const HIDE_DEEP = ['vegetation', 'trees', 'ground-cover', 'far-forest'];

interface Obj { visible: boolean; name: string }
interface SceneLike { getObjectByName(n: string): Obj | undefined }
interface CamLike { position: { x: number; y: number; z: number } }

/**
 * Per-frame visibility for the shell's InteriorGroups. `apertures` (from bakeInteriorLight) give the
 * windows; `court` tells which of them face the courtyard. Outdoor objects are looked up by name in `scene`.
 */
export function createVisibility(camera: CamLike, groups: InteriorGroup[], plan: InteriorPlan, opts: VisOpts & { scene?: SceneLike; apertures?: Aperture[] } = {}) {
  const graph = roomGraph(plan, windowLinks(plan, opts.apertures ?? [], opts.court ?? (() => false)));
  const ctx: VisContext = { plan, graph, groups: groups.map((g) => ({ key: g.key, rooms: g.rooms })) };
  const water = opts.scene?.getObjectByName('water');
  const outdoorObjs = [...new Set([...HIDE_UNDERGROUND, ...HIDE_DEEP])].map((n) => [n, opts.scene?.getObjectByName(n)] as const).filter((x): x is readonly [string, Obj] => !!x[1]);
  const base = new Map(outdoorObjs.map(([, obj]) => [obj, obj.visible]));
  let last: VisResult = { room: -1, inside: false, from: [], drawn: new Set([COURT, OUTSIDE, ...plan.rooms.map((r) => r.id)]), shown: new Set([COURT, OUTSIDE, ...plan.rooms.map((r) => r.id)]), deep: false, underground: false, visible: groups.map(() => true) };
  const dynamic = new Set<{ obj: { visible: boolean }; roomOf: () => SpaceId | null }>();
  const opened = new Set<string>(), isOpen = (id: string) => opened.has(id);
  return {
    graph,
    /** A leaf swung open (any bit) opens its doorway in the graph; shut, it closes it again. */
    setDoorOpen(id: string, open: boolean) { if (open) opened.add(id); else opened.delete(id); },
    get state() { return last; },
    get roomId() { return last.room >= 0 ? plan.rooms[last.room].id : null; },
    /** Is this space drawn? (null: anywhere outdoors.) Door leaves, NPCs and props follow it. */
    isRoomVisible(id: SpaceId | null) { return spaceShown(last, id); },
    /**
     * Dynamic things (NPCs, door leaves, dropped props) follow the graph: shown when the space they are
     * in is drawn. `roomOf` returns a space id, or null when anywhere outdoors. Returns an unregister function.
     */
    register(obj: { visible: boolean }, roomOf: () => SpaceId | null) {
      const e = { obj, roomOf };
      dynamic.add(e);
      obj.visible = spaceShown(last, roomOf());
      return () => { dynamic.delete(e); };
    },
    update() {
      const p = camera.position;
      last = visibleSet(ctx, [p.x, p.y, p.z], opts, isOpen);
      groups.forEach((g, i) => { g.object.visible = last.visible[i]; });
      for (const [name, obj] of outdoorObjs) {
        const hide = last.underground ? HIDE_UNDERGROUND.includes(name) : last.deep && HIDE_DEEP.includes(name);
        obj.visible = (base.get(obj) ?? true) && !hide;
      }
      // the water (and its reflection, a second render of the scene) only when a line of sight can reach it
      if (water?.visible && opts.frustum) {
        water.visible = waterInView({ eye: [p.x, p.y, p.z], ...opts.frustum(), outdoors: last.from.includes(OUTSIDE), openings: outsideOpenings(plan, opts.apertures ?? [], opts.court ?? (() => false), sightSpaces(graph, last.from, isOpen), isOpen) }, opts.ground ?? (() => -Infinity));
      }
      for (const e of dynamic) e.obj.visible = spaceShown(last, e.roomOf());
      return last;
    },
  };
}

/** A frustum plane as three.js keeps it: a point p is inside when normal · p + constant ≥ 0. */
export interface PlaneLike { normal: { x: number; y: number; z: number }; constant: number }

/**
 * Can a sun shadow caster inside the sphere (c, r) darken anything the camera sees? Its shadow falls along
 * the sun's rays from it, away from the sun, and nothing it can darken is lower than `floor` (the moat's
 * water, y 0, is the lowest sunlit surface), so the sphere swept from c down to that height must reach into
 * the view frustum. Frustum culling of shadow casters, not distance: a caster whose shadow can land on
 * screen always casts. `sun` points towards the sun; at or under the horizon nothing is culled.
 */
export function shadowInView(planes: PlaneLike[], c: V3, r: number, sun: V3, floor = 0): boolean {
  if (sun[1] <= 0.02) return true;
  const t = Math.max(0, c[1] + r - floor) / sun[1];
  const e: V3 = [c[0] - sun[0] * t, c[1] - sun[1] * t, c[2] - sun[2] * t];
  for (const p of planes) {
    const n = p.normal, dc = n.x * c[0] + n.y * c[1] + n.z * c[2] + p.constant, de = n.x * e[0] + n.y * e[1] + n.z * e[2] + p.constant;
    if (Math.max(dc, de) < -r) return false;
  }
  return true;
}

/** An axis-aligned box. */
export interface Box { min: V3; max: V3 }

/**
 * The bounds of a merged mesh's vertices, one box per room tag (`tag[i]` for vertex i: the interior light's
 * `interiorRoom`, -1 untagged; no tags: one box). A group's mesh spans a whole wing floor, and three culls it
 * by one sphere round all of it, so every camera (view, AO pre-pass, reflection) drew all of a floor's rooms
 * whenever any part of that sphere was in view. Tested per room box, a mesh is drawn when one of its rooms'
 * triangles can be: frustum culling with tighter bounds, never a distance or facing test.
 */
export function tagBoxes(pos: ArrayLike<number>, tag: ArrayLike<number> | null): Box[] {
  const boxes = new Map<number, Box>();
  for (let i = 0; 3 * i < pos.length; i++) {
    const k = tag ? Math.round(tag[i]) : -1;
    let b = boxes.get(k);
    if (!b) boxes.set(k, b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
    for (let a = 0; a < 3; a++) {
      const v = pos[3 * i + a];
      if (v < b.min[a]) b.min[a] = v;
      if (v > b.max[a]) b.max[a] = v;
    }
  }
  return [...boxes.values()];
}
