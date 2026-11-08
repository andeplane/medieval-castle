// Furnishing the castle: pure function of the interior plan. Every room gets a role from its kind,
// floor and size (hall, chapel, bedchamber, solar, study, guard room, kitchen, store, cellar …) and a
// recipe places props against its walls, in its middle, on table tops and from the ceiling.
// Rules that keep the castle walkable for the player and future NPCs:
// - a clear zone inside every doorway (door swing + a step), and around stair ends;
// - after placing, a flood fill on a 0.2 m grid (agent radius 0.3 m) must still connect every door;
//   props are taken out again, last first, until it does.
// Tall props and wall hangings go on solid walls only: walls with a room behind, or with no window cut in
// them (the shell's embrasures, castle/interior/shell.ts WindowFace, when the caller passes them).
// Every room also has a character (characterOf): a palette of textiles, a tier (servants' plain, the
// household's, the lord's rich) and a layout (which of its role's arrangements it takes), so that rooms of
// one role do not read as copies. After its recipe a room gets wall dressing, small things on its tables
// and chests, and a piece in every quarter of its floor that is still empty.
import type { V2 } from '../core/math2d';
import { pointInPoly } from '../core/math2d';
import { mulberry32, hashSeed, range, pick, type Rng } from '../core/rng';
import type { InteriorPlan, RoomSpec, DoorSpec, SpaceId } from '../castle/interior/types';
import { portcullisInPlan, DRUM_R } from '../castle/interior/portcullis';
import { orient, convexOverlap, centroidOf } from '../castle/interior/geom';
import type { WindowFace } from '../castle/interior/shell';
import { KIND, makeProp, type Prop } from './kit';
import { shutter, buildShutter } from './medieval';
import { PALETTES } from './period';
import { yawXZ, type Placed } from './place';

export type Role = 'hall' | 'chapel' | 'bedchamber' | 'solar' | 'study' | 'guard' | 'kitchen' | 'store' | 'cellar' | 'gate' | 'passage' | 'empty'
  // service rooms on the ground floor
  | 'buttery' | 'pantry' | 'brewhouse' | 'bakehouse' | 'laundry' | 'armoury'
  // under the ground
  | 'wine-cellar' | 'dungeon' | 'well-room'
  // chambers above
  | 'lord' | 'lady' | 'wardrobe' | 'garderobe' | 'nursery' | 'library' | 'steward' | 'treasury' | 'sewing' | 'physician'
  // towers
  | 'mews' | 'watch';

/** Props come from a small pool of seeded variants per kind, so 1000+ placements build a few hundred meshes. */
export const VARIANTS = 6;
/** Room palettes (period.ts PALETTES): a toned prop's variant seed ≡ its room's palette (mod NT). */
export const NT = PALETTES.length;
/** Toned kinds keep two shapes in every palette. */
const TONED_VARIANTS = NT * 2;
export function variantPool(make: (kind: string, seed: number) => Prop = makeProp) {
  const cache = new Map<string, Prop>();
  return (kind: string, seed: number) => {
    const v = seed % (TONED.has(kind) ? TONED_VARIANTS : VARIANTS), key = `${kind}:${v}`;
    let p = cache.get(key);
    if (!p) { p = make(kind, v); cache.set(key, p); }
    return p;
  };
}

export interface DressDeps {
  /** Prop factory; tests inject a cheap one. */
  make?: (kind: string, seed: number) => Prop;
  seed?: number;
  /** Where the windows open into the rooms (the shell's embrasures, castle/interior/shell.ts WindowFace):
   * hangings keep off them, nothing stands in a niche that comes down to the floor, shutters hang there. */
  windows?: readonly WindowFace[];
}

export interface RoomDressing {
  room: SpaceId; key: string; role: Role; placed: Placed[];
  /** Areas that must stay clear (door zones, walkways, stair ends), world x/z polygons. */
  keepOut: V2[][];
  /** Footprints of the props that block navigation (navmesh obstacles). */
  obstacles: V2[][];
  /** Props the walkability check removed. */
  dropped: string[];
}

export interface Dressing { rooms: RoomDressing[]; byGroup: Map<string, Placed[]> }

/** Same key as the interior shell's visibility groups. */
export const groupKey = (r: RoomSpec) => (r.kind === 'stair' ? `stairs:${r.id}` : `${r.zone}:${r.floor}`);

// ------------------------------------------------------------------ 2D helpers

/** World corners of a placed prop's footprint (oriented rectangle), inflated by pad. */
export function footRect(p: Placed, pad = 0): V2[] {
  const b = p.prop.bounds;
  const pts: V2[] = [[b.min[0] - pad, b.min[2] - pad], [b.max[0] + pad, b.min[2] - pad], [b.max[0] + pad, b.max[2] + pad], [b.min[0] - pad, b.max[2] + pad]];
  return pts.map(([x, z]) => { const [a, c] = yawXZ(x, z, p.yaw); return [p.at[0] + a, p.at[2] + c] as V2; });
}

/** Oriented rectangle from a centre line a→b with half width w (a walkway or a door zone). */
export function strip(a: V2, b: V2, w: number): V2[] {
  const d = [b[0] - a[0], b[1] - a[1]], L = Math.hypot(d[0], d[1]) || 1, n: V2 = [-d[1] / L * w, d[0] / L * w];
  return [[a[0] + n[0], a[1] + n[1]], [b[0] + n[0], b[1] + n[1]], [b[0] - n[0], b[1] - n[1]], [a[0] - n[0], a[1] - n[1]]];
}

const insidePoly = (poly: V2[], rect: V2[]) => rect.every((q) => pointInPoly(poly, q[0], q[1])) && !poly.some((q) => pointInPoly(rect, q[0], q[1]));

/** Yaw that turns a prop's local +z (its front) to the 2D direction n. */
export const yawFacing = (n: V2) => Math.atan2(n[0], n[1]);

interface Wall { a: V2; b: V2; n: V2; L: number; inner: boolean }

/** Room edges with inward normals; `inner` when another room lies right behind the wall. */
export function wallsOf(r: RoomSpec, P: InteriorPlan): Wall[] {
  const p = orient(r.poly);
  const out: Wall[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.3) continue;
    const t: V2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], mid: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const n: V2 = [-t[1], t[0]]; // left of the edge is inside for a positively wound polygon
    const back: V2 = [mid[0] - n[0] * 1.4, mid[1] - n[1] * 1.4];
    const inner = P.rooms.some((o) => o.id !== r.id && o.y0 < r.y0 + 2 && o.y1 > r.y0 + 0.5 && pointInPoly(o.poly, back[0], back[1]));
    out.push({ a, b, n, L, inner });
  }
  return out;
}

/** Where a door meets this room: the point 0.4 m inside the room face, and the inward normal. */
export function doorEntry(d: DoorSpec, room: SpaceId): { at: V2; n: V2; face: V2 } {
  const s = d.spaces[0] === room ? -1 : 1;
  const n: V2 = [d.normal[0] * s, d.normal[1] * s];
  const face: V2 = [d.centre[0] + n[0] * d.wall / 2, d.centre[2] + n[1] * d.wall / 2];
  return { at: [face[0] + n[0] * 0.4, face[1] + n[1] * 0.4], n, face };
}

/** Clear zones for one room: inside each doorway and around stair ends. Walkways between doors are
 * left to the flood fill in dressRoom, which is the real guarantee. */
export function keepOutFor(r: RoomSpec, P: InteriorPlan): V2[][] {
  const zones: V2[][] = [];
  const doors = P.doors.filter((d) => d.spaces.includes(r.id));
  const entries = doors.map((d) => ({ d, ...doorEntry(d, r.id) }));
  for (const e of entries) {
    const depth = Math.max(1.3, e.d.width + 0.5);
    const far: V2 = [e.face[0] + e.n[0] * depth, e.face[1] + e.n[1] * depth];
    zones.push(strip([e.face[0] - e.n[0] * 0.3, e.face[1] - e.n[1] * 0.3], far, e.d.width / 2 + 0.35));
  }
  for (const s of P.stairs) {
    if (s.kind !== 'straight' || !s.start || !s.end) continue;
    const a: V2 = [s.start[0], s.start[2]], b: V2 = [s.end[0], s.end[2]];
    if (pointInPoly(r.poly, a[0], a[1]) || pointInPoly(r.poly, b[0], b[1])) {
      const d = [b[0] - a[0], b[1] - a[1]], L = Math.hypot(d[0], d[1]) || 1, u: V2 = [d[0] / L, d[1] / L];
      zones.push(strip([a[0] - u[0] * 1.2, a[1] - u[1] * 1.2], [b[0] + u[0] * 1.2, b[1] + u[1] * 1.2], s.width / 2 + 0.4));
    }
  }
  // the portcullis windlass in the room over a gate: its frames, slot and room to heave the spokes
  for (const d of P.doors) {
    if (d.kind !== 'gate') continue;
    const w = portcullisInPlan(d, P.rooms);
    if (w.winch?.room !== r.id) continue;
    const half = Math.max(w.width / 2 + 0.2, w.winch.frameAt + 0.9), c: V2 = [w.centre[0] - w.inward[0] * DRUM_R, w.centre[2] - w.inward[1] * DRUM_R];
    zones.push(strip([c[0] - w.along[0] * half, c[1] - w.along[1] * half], [c[0] + w.along[0] * half, c[1] + w.along[1] * half], 1.4));
  }
  return zones;
}

/**
 * Do all door entries of a room stay connected for an agent of radius `radius`? Grid flood fill over
 * the room polygon minus the obstacle footprints. Rooms with fewer than two doors only need their door
 * cell to stay free and at least half the floor to be reachable from it.
 */
export function walkable(poly: V2[], obstacles: V2[][], entries: V2[], radius = 0.3, cell = 0.2): boolean {
  const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
  const x0 = Math.min(...xs), z0 = Math.min(...zs), nx = Math.ceil((Math.max(...xs) - x0) / cell), nz = Math.ceil((Math.max(...zs) - z0) / cell);
  const grown = obstacles.map((o) => grow(o, radius));
  const free = new Uint8Array(nx * nz);
  let total = 0;
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const x = x0 + (i + 0.5) * cell, z = z0 + (j + 0.5) * cell;
    if (!pointInPoly(poly, x, z) || grown.some((g) => pointInPoly(g, x, z)) || edgeDist(poly, x, z) < radius * 0.8) continue;
    free[i * nz + j] = 1; total++;
  }
  const idx = (p: V2) => { const i = Math.floor((p[0] - x0) / cell), j = Math.floor((p[1] - z0) / cell); return i >= 0 && j >= 0 && i < nx && j < nz ? i * nz + j : -1; };
  const starts = entries.map(idx);
  if (!starts.length) return true;
  if (starts.some((s) => s < 0)) return false;
  // door cells may hug a jamb: they only need to be clear of furniture
  for (const [k, e] of entries.entries()) if (!free[starts[k]] && pointInPoly(poly, e[0], e[1]) && !grown.some((g) => pointInPoly(g, e[0], e[1]))) { free[starts[k]] = 1; total++; }
  if (starts.some((s) => !free[s])) return false;
  const seen = new Uint8Array(nx * nz), stack = [starts[0]];
  seen[starts[0]] = 1;
  let reached = 0;
  while (stack.length) {
    const c = stack.pop()!; reached++;
    const i = Math.floor(c / nz), j = c % nz;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      const k = a * nz + b;
      if (free[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
    }
  }
  return starts.every((s) => seen[s]) && reached >= total * 0.5;
}

/** Distance from a point to a segment (a round room's window facet lies off its polygon's edges). */
function segDist(a: V2, b: V2, p: V2) {
  const dx = b[0] - a[0], dz = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}

/** Distance from a point to the nearest polygon edge. */
function edgeDist(p: V2[], x: number, z: number) {
  let best = Infinity;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length], dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2));
    best = Math.min(best, Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz));
  }
  return best;
}

/** Grow a convex polygon outward by d (each edge pushed out, mitred corners). Either winding. */
export function grow(p: V2[], d: number): V2[] {
  let A = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; A += a[0] * b[1] - b[0] * a[1]; }
  const sg = A >= 0 ? 1 : -1, n = p.length;
  const out = (i: number): V2 => { const a = p[i], b = p[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [((b[1] - a[1]) / L) * sg, (-(b[0] - a[0]) / L) * sg]; };
  return p.map((q, i) => {
    const n0 = out((i + n - 1) % n), n1 = out(i), m: V2 = [n0[0] + n1[0], n0[1] + n1[1]];
    const ml = Math.hypot(m[0], m[1]) || 1, cos = (m[0] * n1[0] + m[1] * n1[1]) / ml || 1;
    return [q[0] + (m[0] / ml) * (d / cos), q[1] + (m[1] / ml) * (d / cos)] as V2;
  });
}

// ------------------------------------------------------------------ roles

const AREA = (r: RoomSpec) => { const p = r.poly; let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };

/** The role a room's kind fixes (hall, chapel, gate, passage, stairs), or null when the castle's plan
 * deals it one (roleTable). */
export function fixedRole(r: RoomSpec): Role | null {
  if (r.kind === 'stair' || r.kind === 'wallwalk' || r.zone === 'cave') return 'empty'; // the caves bring their own finds (castle/interior/caveGeom.ts)
  if (r.kind === 'hall') return 'hall';
  if (r.kind === 'chapel') return 'chapel';
  if (r.kind === 'gate') return 'gate';
  if (r.kind === 'passage') return 'passage';
  return null;
}

/** Roles dealt round, by where a room is. One of each single, the rest from these pools (seeded). */
export const POOLS = {
  /** under the ground */
  deep: ['well-room', 'wine-cellar', 'dungeon', 'cellar', 'wine-cellar', 'cellar', 'dungeon'] as Role[],
  /** ground floor, after the two kitchens (the largest rooms) */
  ground: ['buttery', 'pantry', 'brewhouse', 'bakehouse', 'laundry', 'armoury', 'guard', 'store', 'cellar', 'guard', 'buttery', 'armoury', 'pantry', 'store', 'laundry', 'cellar', 'brewhouse', 'guard'] as Role[],
  /** first and second floors */
  low: ['guard', 'study', 'library', 'steward', 'sewing', 'store', 'wardrobe', 'bedchamber', 'physician', 'guard', 'solar', 'bedchamber', 'sewing', 'wardrobe', 'study'] as Role[],
  /** third floor and up */
  high: ['bedchamber', 'solar', 'study', 'library', 'nursery', 'sewing', 'physician', 'wardrobe', 'bedchamber', 'solar', 'garderobe', 'study', 'bedchamber', 'library', 'solar'] as Role[],
  /** rooms under 9 m² above the ground */
  small: ['wardrobe', 'garderobe', 'study', 'store', 'physician', 'garderobe'] as Role[],
};
const TOWER_ZONES = ['ne', 'se', 'sw', 'great', 'eturret'];

/** A room's role and its number among the rooms of that role (recipes vary their layout and pieces by it). */
export interface RoleSlot { role: Role; k: number }
const tables = new WeakMap<InteriorPlan, Map<number, Map<SpaceId, RoleSlot>>>();

/**
 * Deal every room of the castle a role (pure, seeded, cached per plan): the fixed ones by kind; under
 * the ground wells, wine cellars, dungeons and stores; on the ground floor two kitchens (the largest
 * rooms) and the service rooms; above, the top room of every tower is a watch room, then one lord's and
 * one lady's chamber (the largest rooms on floors 2-4), a treasury (in the great tower when it can be),
 * a steward's room, two mews in tower rooms, and the rest from the pools by floor and size.
 */
export function roleTable(P: InteriorPlan, seed = 0): Map<SpaceId, RoleSlot> {
  let bySeed = tables.get(P);
  if (!bySeed) { bySeed = new Map(); tables.set(P, bySeed); }
  const hit = bySeed.get(seed);
  if (hit) return hit;
  const rng = mulberry32(hashSeed('roles', seed));
  const role = new Map<SpaceId, Role>();
  const free = P.rooms.filter((r) => { const f = fixedRole(r); if (f) role.set(r.id, f); return !f; });
  const deal = (rooms: RoomSpec[], pool: Role[]) => { const sh = shuffle(rooms, rng); sh.forEach((r, i) => role.set(r.id, pool[i % pool.length])); };
  const take = (rooms: RoomSpec[], r: RoomSpec | undefined, as: Role) => { if (r) { role.set(r.id, as); rooms.splice(rooms.indexOf(r), 1); } };
  const byArea = (rs: RoomSpec[]) => [...rs].sort((a, b) => AREA(b) - AREA(a) || (a.id < b.id ? -1 : 1));
  const deep = free.filter((r) => r.floor < 0), ground = free.filter((r) => r.floor === 0), upper = free.filter((r) => r.floor > 0);
  deal(deep, POOLS.deep);
  // ground floor: the two largest rooms (in different zones) are kitchens; tiny ones stores
  const g = byArea(ground);
  const k1 = g[0];
  take(g, k1, 'kitchen'); take(g, g.find((r) => r.zone !== k1?.zone && AREA(r) >= 20), 'kitchen');
  for (const r of g.filter((x) => AREA(x) < 7)) take(g, r, 'store');
  deal(g, POOLS.ground);
  // above: watch rooms at the top of every tower, then the singles, then the pools
  const u = [...upper];
  for (const z of TOWER_ZONES) { const top = byArea(u.filter((r) => r.zone === z)).sort((a, b) => b.floor - a.floor)[0]; take(u, top, 'watch'); }
  const big = byArea(u.filter((r) => r.floor >= 2 && r.floor <= 4 && !TOWER_ZONES.includes(r.zone)));
  const lord = big[0];
  take(u, lord, 'lord');
  take(u, big.find((r) => r !== lord && r.zone !== lord?.zone), 'lady');
  take(u, byArea(u.filter((r) => r.zone === 'great' && r.floor >= 1)).reverse()[0] ?? byArea(u.filter((r) => r.floor <= 2)).reverse()[0], 'treasury');
  take(u, byArea(u.filter((r) => r.floor === 1 && AREA(r) >= 12))[0], 'steward');
  for (let i = 0; i < 2; i++) take(u, byArea(u.filter((r) => TOWER_ZONES.includes(r.zone) && r.floor >= 3 && AREA(r) >= 9))[0], 'mews');
  deal(u.filter((r) => AREA(r) < 9), POOLS.small);
  deal(u.filter((r) => AREA(r) >= 9 && r.floor <= 2), POOLS.low);
  deal(u.filter((r) => AREA(r) >= 9 && r.floor > 2), POOLS.high);
  const count = new Map<Role, number>(), out = new Map<SpaceId, RoleSlot>();
  for (const r of P.rooms) { const ro = role.get(r.id)!, k = count.get(ro) ?? 0; count.set(ro, k + 1); out.set(r.id, { role: ro, k }); }
  bySeed.set(seed, out);
  return out;
}

/** A room's role on its own (no plan to deal from): by kind, floor and size. */
export function roleOf(r: RoomSpec, rng: Rng): Role {
  const f = fixedRole(r);
  if (f) return f;
  if (r.kind === 'undercroft' || r.floor < 0) return r.floor < 0 ? pick(rng, POOLS.deep) : pick(rng, POOLS.ground);
  if (AREA(r) < 7) return pick(rng, ['store', 'garderobe'] as Role[]);
  if (r.floor === 0) return pick(rng, ['kitchen', ...POOLS.ground]);
  return pick(rng, r.floor <= 2 ? POOLS.low : POOLS.high);
}

// ------------------------------------------------------------------ character

/** How well a room is kept: 0 the servants' and the garrison's (plain wood, wool, pegs and baskets),
 * 1 the household's (a hanging, a chair, a rug), 2 the lord's and the best rooms (tapestries, carpets,
 * upholstered seats, more candles). */
export type Tier = 0 | 1 | 2;
export interface Character { tier: Tier; /** period.ts PALETTES */ palette: number; /** which of its role's arrangements */ layout: number }
/** Roles whose rooms are always the best kept, and the working rooms that are always plain. */
const RICH: readonly Role[] = ['lord', 'lady', 'treasury', 'hall', 'chapel'];
const SERVICE: readonly Role[] = ['guard', 'store', 'cellar', 'laundry', 'brewhouse', 'bakehouse', 'garderobe', 'dungeon', 'mews', 'watch', 'buttery', 'pantry', 'wine-cellar', 'well-room', 'armoury', 'kitchen', 'gate', 'passage', 'empty'];
/** Arrangements per role (RECIPES branch on D.layout); other roles have one. */
export const LAYOUTS: Partial<Record<Role, number>> = { bedchamber: 3, solar: 3, study: 3, library: 2, sewing: 2, guard: 2, nursery: 2, physician: 2, wardrobe: 2 };

/** The household's working rooms: plain, but kept well in the lord's wing. */
const WORKING: readonly Role[] = ['wardrobe', 'sewing', 'physician', 'steward'];

/**
 * A room's character, from the seed and its place. Tier: by role; among the rooms of one of the family's
 * roles, ranked by floor area (half again in the lord's wing, his zone above the ground; less in a tower
 * garret, floor 5 and up), the top third is rich and the bottom quarter poor, and one in five is nudged a
 * step either way; the working rooms are plain, or rich in the lord's wing. Palette and layout: the rooms
 * of one role take the palettes in turn from a seeded start, and their layouts in a different order, so no
 * two rooms of a role up to NT × layouts share both.
 */
export function characterOf(r: RoomSpec, P: InteriorPlan, slot: RoleSlot, seed = 0): Character {
  const { role, k } = slot, rng = mulberry32(hashSeed(`character:${r.id}`, seed));
  const n = LAYOUTS[role] ?? 1;
  const palette = (k + (hashSeed(`palette:${role}`, seed) % NT)) % NT;
  const layout = (k + Math.floor(k / NT) + (hashSeed(`layout:${role}`, seed) % n)) % n;
  let tier: Tier;
  if (RICH.includes(role)) tier = 2;
  else if (SERVICE.includes(role)) tier = 0;
  else {
    const T = roleTable(P, seed), lord = P.rooms.find((x) => T.get(x.id)?.role === 'lord');
    const wing = (x: RoomSpec) => !!lord && x.zone === lord.zone && x.floor >= 1;
    if (WORKING.includes(role)) tier = wing(r) ? 2 : 1;
    else {
      const score = (x: RoomSpec) => AREA(x) * (wing(x) ? 1.5 : 1) * (TOWER_ZONES.includes(x.zone) && x.floor >= 5 ? 0.6 : 1);
      const peers = P.rooms.filter((x) => T.get(x.id)?.role === role).sort((a, b) => score(b) - score(a) || (a.id < b.id ? -1 : 1));
      const i = Math.max(0, peers.indexOf(r)), m = peers.length;
      tier = i < m / 3 ? 2 : i >= m * 0.75 ? 0 : 1;
    }
    const x = rng();
    if (x < 0.1) tier = Math.max(0, tier - 1) as Tier; else if (x < 0.2) tier = Math.min(2, tier + 1) as Tier;
  }
  return { tier, palette, layout };
}

// ------------------------------------------------------------------ placing

export class RoomDresser {
  placed: Placed[] = []; blockers: V2[][] = []; walls: Wall[]; poly: V2[];
  /** Stretches of wall in use, along the wall (s) and up it (y above the floor): doors, tall furniture
   * against it and hangings, so a portrait never hangs behind a bookcase. */
  wallTaken: { w: Wall; s0: number; s1: number; y0: number; y1: number }[] = [];
  /** The room's palette (period.ts PALETTES): every toned prop takes a variant seed ≡ tone (mod NT). */
  tone: number;
  /** How well kept the room is (characterOf) and which of its role's arrangements it takes. */
  tier: Tier = 1;
  layout = 0;
  private n = 0;
  private pictures = 0;
  /** The room's number among the rooms of its role (roleTable): recipes vary by it. */
  k = 0;
  role: Role = 'empty';
  /** This room's windows (WindowFace), from the shell. */
  windows: readonly WindowFace[];
  /** Whether the castle's windows were given: then any wall without a window hole is solid. */
  private known = false;
  constructor(public r: RoomSpec, public P: InteriorPlan, public keepOut: V2[][], public rng: Rng, private make: (k: string, s: number) => Prop, private seed: number, windows: readonly WindowFace[] = []) {
    this.walls = wallsOf(r, P); this.poly = orient(r.poly);
    this.tone = Math.floor(rng() * NT);
    this.windows = windows.filter((w) => w.room === r.id);
    this.known = windows.length > 0;
    // window holes take their stretch of wall at their height; a niche that comes down to the floor keeps
    // its mouth clear of standing furniture
    for (const w of this.windows) {
      const wall = this.wallAt(w);
      if (wall) { const s = this.along(wall, w.c); this.wallTaken.push({ w: wall, s0: s - w.w / 2 - 0.1, s1: s + w.w / 2 + 0.1, y0: w.y0 - r.y0 - 0.1, y1: w.y1 - r.y0 + 0.1 }); }
      if (w.y0 - r.y0 < 0.6) this.blockers.push(strip([w.c[0] - w.n[0] * 0.2, w.c[1] - w.n[1] * 0.2], [w.c[0] + w.n[0] * 0.6, w.c[1] + w.n[1] * 0.6], w.w / 2 - 0.02));
    }
    // door openings take their stretch of wall
    for (const d of P.doors.filter((x) => x.spaces.includes(r.id))) {
      for (const w of this.walls) {
        const t: V2 = [(w.b[0] - w.a[0]) / w.L, (w.b[1] - w.a[1]) / w.L];
        const rel: V2 = [d.centre[0] - w.a[0], d.centre[2] - w.a[1]];
        const s = rel[0] * t[0] + rel[1] * t[1], off = Math.abs(rel[0] * w.n[0] + rel[1] * w.n[1]);
        if (off < d.wall / 2 + 0.5 && s > -d.width && s < w.L + d.width) this.wallTaken.push({ w, s0: s - d.width / 2 - 0.3, s1: s + d.width / 2 + 0.3, y0: -1, y1: 99 });
      }
    }
  }
  /** A wall with nothing cut in it but doors: another room behind it, or (windows known) no window in it.
   * Tall furniture and hangings go there. */
  solid(w: Wall): boolean { return w.inner || (this.known && !this.windows.some((x) => this.wallAt(x) === w || (x.n[0] * w.n[0] + x.n[1] * w.n[1] > 0.8 && segDist(w.a, w.b, x.c) < 0.8))); }
  /** The room wall a window face lies on (null on a round room's window facet). */
  wallAt(w: WindowFace): Wall | null {
    return this.walls.find((x) => x.n[0] * w.n[0] + x.n[1] * w.n[1] > 0.99 && Math.abs((w.c[0] - x.a[0]) * x.n[0] + (w.c[1] - x.a[1]) * x.n[1]) < 0.05) ?? null;
  }
  /** Distance of a point along a wall from its start. */
  along(w: Wall, p: V2) { return ((p[0] - w.a[0]) * (w.b[0] - w.a[0]) + (p[1] - w.a[1]) * (w.b[1] - w.a[1])) / w.L; }

  /**
   * Wooden shutters at every window (not slits): two board leaves (one for a narrow window), hinged at
   * the jambs of the hole in the room face and standing open flat against the wall either side, from
   * 0.45 m above the floor (or the sill) up to where the head springs. A leaf that would run into a
   * corner, a doorway or its clear zone is left off. Placed first, so the furniture keeps off them.
   */
  shutters(): Placed[] {
    const out: Placed[] = [];
    for (const [k, w] of this.windows.entries()) {
      if (w.slit) continue;
      const yb = Math.max(w.y0, this.r.y0 + 0.45), h = w.ys - yb;
      if (h < 0.5) continue;
      const two = w.w >= 0.7, lw = two ? w.w / 2 : w.w, yaw = yawFacing(w.n), xdir = yawXZ(1, 0, yaw), wall = this.wallAt(w);
      for (const sx of two ? [-1, 1] : [this.rng() < 0.5 ? -1 : 1]) {
        const s = sx * (w.w / 2 + lw / 2 + 0.02), c: V2 = [w.c[0] + w.t[0] * s + w.n[0] * 0.01, w.c[1] + w.t[1] * s + w.n[1] * 0.01];
        const hinge = xdir[0] * -sx * w.t[0] + xdir[1] * -sx * w.t[1] > 0 ? 1 : -1;
        const seed = hashSeed(`${this.r.id}:shutter:${k}`, this.seed);
        const prop = makeProp({ ...shutter, build: (m, r) => buildShutter(m, r, lw, h, hinge) }, seed);
        const p: Placed = { prop, at: [c[0], yb, c[1]], yaw };
        const f = footRect(p);
        if (!insidePoly(this.poly, f) || this.keepOut.some((z) => convexOverlap(f, z)) || this.blockers.some((b) => convexOverlap(f, b, -0.01))) continue;
        if (wall) {
          const sw = this.along(wall, c);
          if (this.wallTaken.some((x) => x.w === wall && x.y0 < 0 && x.s0 < sw + lw / 2 && x.s1 > sw - lw / 2)) continue; // a doorway
          this.wallTaken.push({ w: wall, s0: sw - lw / 2, s1: sw + lw / 2, y0: yb - this.r.y0, y1: w.ys - this.r.y0 });
        }
        this.placed.push(p); this.blockers.push(footRect(p, 0.02)); out.push(p);
      }
    }
    return out;
  }

  /** A prop for this room; toned props take a variant seed in the room's colour. */
  prop(kind: string) {
    const h = hashSeed(`${this.r.id}:${this.n++}`, this.seed);
    // pictures in one room take consecutive variants from a seeded start: never the same canvas twice
    if (kind === 'portrait') return this.make(kind, (hashSeed(`${this.r.id}:pictures`, this.seed) % VARIANTS) + this.pictures++);
    return this.make(kind, TONED.has(kind) ? this.tone + NT * (h % 0x2aaaaaa) : h);
  }

  /** Can this placed prop go here (inside the room, clear of keep-outs and other blockers)? */
  fits(p: Placed): boolean {
    const f = footRect(p);
    if (!insidePoly(this.poly, f)) return false;
    if (this.keepOut.some((k) => convexOverlap(f, k))) return false;
    return flat(p.prop) || !this.blockers.some((b) => convexOverlap(f, b, -0.01));
  }
  /** Flat floor textiles (carpets, rugs, skins, runners) lie under furniture and over each other. */
  add(p: Placed, pad = 0.02) { this.placed.push(p); if (p.prop.kind.blocksNav || (p.prop.kind.placement === 'floor' && !flat(p.prop))) this.blockers.push(footRect(p, pad)); return p; }
  fitsFloor(p: Placed): boolean {
    return this.fits(p) && (p.at[1] - this.r.y0) + p.prop.bounds.max[1] < this.r.y1 - this.r.y0 - 0.05;
  }

  /** Back against a wall. inner: only walls with another room behind (no windows). toward: the wall
   * nearest that point first, and the spot along it nearest it, within `within` m of it. */
  againstWall(kind: string, o: { inner?: boolean; tries?: number; prefer?: (w: Wall) => number; centre?: boolean; corner?: boolean; toward?: V2; within?: number } = {}): Placed | null {
    const prop = this.prop(kind), b = prop.bounds, cx = (b.min[0] + b.max[0]) / 2, width = b.max[0] - b.min[0];
    let walls = this.walls.filter((w) => w.L >= width + 0.1 && (!o.inner || this.solid(w)));
    const T = o.toward, within = o.within ?? Infinity;
    walls = T ? walls.filter((w) => segDist(w.a, w.b, T) <= within).sort((a, c) => segDist(a.a, a.b, T) - segDist(c.a, c.b, T)) : o.prefer ? [...walls].sort((a, c) => o.prefer!(c) - o.prefer!(a)) : shuffle(walls, this.rng);
    for (const w of walls) {
      const t: V2 = [(w.b[0] - w.a[0]) / w.L, (w.b[1] - w.a[1]) / w.L], yaw = yawFacing(w.n);
      const steps = Math.max(1, Math.floor((w.L - width) / 0.25));
      const start = Math.floor(this.rng() * steps);
      const sOf = (k: number) => width / 2 + 0.05 + (k / Math.max(1, steps)) * Math.max(0, w.L - width - 0.1);
      // centred: from the middle of the wall outwards; corner: from both ends inwards; toward: nearest the
      // point first; otherwise from a random point along it
      const all = Array.from({ length: steps + 1 }, (_, k) => k);
      const order = T ? all.sort((a, c) => Math.abs(sOf(a) - this.along(w, T)) - Math.abs(sOf(c) - this.along(w, T))) : o.corner ? all.map((k) => (k % 2 ? steps - (k >> 1) : k >> 1)) : o.centre ? all.map((k) => Math.round(steps / 2 + (k % 2 ? 1 : -1) * Math.ceil(k / 2))).filter((k) => k >= 0 && k <= steps) : all.map((k) => (start + k) % (steps + 1));
      for (const k of order) {
        const s = sOf(k);
        const back = 0.04 - b.min[2];
        const at: V2 = [w.a[0] + t[0] * s + w.n[0] * back, w.a[1] + t[1] * s + w.n[1] * back];
        if (T && Math.hypot(at[0] - T[0], at[1] - T[1]) > within) continue;
        const [ox, oz] = yawXZ(cx, 0, yaw);
        const p: Placed = { prop, at: [at[0] - ox, this.r.y0, at[1] - oz], yaw };
        if (this.fitsFloor(p)) {
          this.wallTaken.push({ w, s0: s - width / 2, s1: s + width / 2, y0: 0, y1: b.max[1] + 0.05 });
          return this.add(p);
        }
      }
    }
    return null;
  }

  /** Free-standing at exactly this spot and yaw (or nudged up to `spread` m), never turned around;
   * `gap`: clear space it keeps from every other standing piece (seats round a fire must not touch). */
  at(kind: string, c: V2, yaw: number, spread = 0.25, gap = 0): Placed | null {
    const prop = this.prop(kind);
    for (let k = 0; k < 12; k++) {
      const rr = k === 0 ? 0 : spread * Math.sqrt(k / 12), a = this.rng() * Math.PI * 2;
      const p: Placed = { prop, at: [c[0] + Math.cos(a) * rr, this.r.y0, c[1] + Math.sin(a) * rr], yaw: yaw + (k ? (this.rng() - 0.5) * 0.12 : 0) };
      if (this.fitsFloor(p) && (!gap || !this.blockers.some((b) => convexOverlap(footRect(p, gap), b)))) return this.add(p, Math.max(0.02, gap));
    }
    return null;
  }

  /** On the wall at mount height (sconces, tapestries); clear of doors and other hangings. toward: on the
   * wall nearest that point, as near it as there is room. */
  onWall(kind: string, inner = true, o: { fractions?: number[]; walls?: Wall[]; toward?: V2; within?: number } = {}): Placed | null {
    const prop = this.prop(kind), k = KIND[kind], b = prop.bounds, width = b.max[0] - b.min[0];
    // every wall kind has a mount height (kit test); hang lower under a low ceiling
    const mount = Math.min(k.mount!, this.r.y1 - this.r.y0 - 0.12 - b.max[1]);
    if (mount + b.min[1] < 0.5) return null; // too low a ceiling for it
    const y0 = mount + b.min[1] - 0.05, y1 = mount + b.max[1] + 0.05, T = o.toward;
    let walls = (o.walls ?? this.walls).filter((x) => x.L >= width + 0.4 && (!inner || this.solid(x)));
    walls = T ? walls.filter((w) => segDist(w.a, w.b, T) <= (o.within ?? Infinity)).sort((a, c) => segDist(a.a, a.b, T) - segDist(c.a, c.b, T)) : shuffle(walls, this.rng);
    for (const w of walls) {
      const t: V2 = [(w.b[0] - w.a[0]) / w.L, (w.b[1] - w.a[1]) / w.L];
      const f0 = T ? this.along(w, T) / w.L : 0;
      for (const f of T ? [0, -0.08, 0.08, -0.16, 0.16, -0.25, 0.25].map((d) => f0 + d).filter((f) => f > 0 && f < 1) : o.fractions ?? shuffle([0.5, 0.3, 0.7, 0.2, 0.8], this.rng)) {
        const s = Math.min(w.L - width / 2 - 0.2, Math.max(width / 2 + 0.2, f * w.L));
        if (this.wallTaken.some((x) => x.w === w && x.s0 < s + width / 2 + 0.25 && x.s1 > s - width / 2 - 0.25 && x.y0 < y1 && x.y1 > y0)) continue;
        this.wallTaken.push({ w, s0: s - width / 2, s1: s + width / 2, y0, y1 });
        return this.add({ prop, at: [w.a[0] + t[0] * s + w.n[0] * 0.02, this.r.y0 + mount, w.a[1] + t[1] * s + w.n[1] * 0.02], yaw: yawFacing(w.n) });
      }
    }
    return null;
  }

  /** Hang a wall piece over a floor prop's `above` point (an overmantel mirror or portrait), clear of the
   * ceiling. Its bottom sits at that point. */
  over(kind: string, base: Placed | null): Placed | null {
    const a = base?.prop.meta.above;
    if (!a) return null;
    const prop = this.prop(kind), b = prop.bounds;
    const y = a[1] - b.min[1];
    if (base!.at[1] + y + b.max[1] > this.r.y1 - 0.05) return null;
    const [ox, oz] = yawXZ(a[0], a[2], base!.yaw);
    const p: Placed = { prop, at: [base!.at[0] + ox, base!.at[1] + y, base!.at[2] + oz], yaw: base!.yaw };
    this.placed.push(p);
    return p;
  }

  /** A pair (or one) of things on a chimneypiece's mantel shelf, symmetric about its middle. */
  onMantel(kind: string, base: Placed | null, xs: number[]) {
    const mt = base?.prop.meta.mantel;
    if (!mt) return;
    const prop = this.prop(kind);
    for (const x of xs) {
      const [ox, oz] = yawXZ(x * mt.w / 2, mt.z, base!.yaw);
      this.placed.push({ prop, at: [base!.at[0] + ox, base!.at[1] + mt.y, base!.at[2] + oz], yaw: base!.yaw });
    }
  }

  /** Free-standing near a point, any of a few yaws, nudged around until it fits. */
  near(kind: string, c: V2, yaw: number, spread = 1.5): Placed | null {
    const prop = this.prop(kind);
    for (let k = 0; k < 24; k++) {
      const rr = k === 0 ? 0 : spread * Math.sqrt(k / 24), a = this.rng() * Math.PI * 2;
      const p: Placed = { prop, at: [c[0] + Math.cos(a) * rr, this.r.y0, c[1] + Math.sin(a) * rr], yaw: yaw + (k % 2 ? Math.PI : 0) };
      if (this.fitsFloor(p)) return this.add(p);
    }
    return null;
  }

  /** On top of another prop (candles on chests, jugs on tables). Does not block. */
  onTop(kind: string, base: Placed | null, dx = 0, dz = 0): Placed | null {
    if (!base) return null;
    const prop = this.prop(kind), top = base.prop.bounds.max[1];
    const [ox, oz] = yawXZ(dx, dz, base.yaw);
    const p: Placed = { prop, at: [base.at[0] + ox, base.at[1] + top, base.at[2] + oz], yaw: base.yaw };
    this.placed.push(p);
    return p;
  }

  ceiling(kind: string, c: V2): Placed { const p: Placed = { prop: this.prop(kind), at: [c[0], this.r.y1, c[1]], yaw: 0 }; this.placed.push(p); return p; }

  /** Put a piece where its kind goes: a wall piece on a solid wall, a floor piece against a wall, or
   * (when no wall has room) free-standing near the middle. */
  place(kind: string): Placed | null {
    if (kind === 'tapestry' && this.tier < 2) kind = this.hangingKind(); // a tapestry is for the best rooms
    const k = KIND[kind];
    if (k.placement === 'wall') return this.onWall(kind, kind !== 'candle-sconce' && kind !== 'sconce');
    return this.againstWall(kind) ?? this.near(kind, this.axis().c, this.rng() * 6, 1.5);
  }
  /** A room's focal piece: free-standing near the middle, else against any wall, else anywhere it fits. */
  focal(kind: string, yaw = 0): Placed | null {
    const { c } = this.axis();
    return this.near(kind, c, yaw, 1.2) ?? this.againstWall(kind) ?? this.near(kind, c, yaw + Math.PI / 2, 3);
  }
  /** The room's own choice of extra pieces: the ones whose bit is set in k + 1, so two rooms of one role
   * never pick the same set (k is unique within a role). */
  extras(list: readonly string[]) {
    const bits = this.k + 1;
    list.forEach((kind, i) => { if ((bits >> i) & 1) this.place(kind); });
  }
  /**
   * Under a window: its back to the window wall, centred on the hole, for a piece low enough to stand under
   * the sill (a chest or bench as a window seat, a table as a desk in the light). The window with the most
   * room in front of it first.
   */
  underWindow(kind: string): Placed | null {
    const prop = this.prop(kind), b = prop.bounds, cx = (b.min[0] + b.max[0]) / 2;
    const ws = this.windows.filter((w) => !w.slit && w.y0 - this.r.y0 >= b.max[1] + 0.03 && w.w >= 0.6);
    for (const w of shuffle(ws, this.rng)) {
      const yaw = yawFacing(w.n), back = 0.04 - b.min[2], [ox, oz] = yawXZ(cx, 0, yaw);
      for (const s of [0, 0.25, -0.25, 0.5, -0.5]) {
        const p: Placed = { prop, at: [w.c[0] + w.n[0] * back + w.t[0] * s - ox, this.r.y0, w.c[1] + w.n[1] * back + w.t[1] * s - oz], yaw };
        if (this.fitsFloor(p)) return this.add(p);
      }
    }
    return null;
  }

  /** What the room has in it so far, as points on the floor: the centres of all pieces but the shutters,
   * and the corners of standing ones. */
  marks(): V2[] {
    const out: V2[] = [];
    for (const p of this.placed) {
      if (p.prop.kind.name === 'shutter') continue;
      out.push([p.at[0], p.at[2]]);
      if (p.prop.kind.placement === 'floor' && !flat(p.prop)) out.push(...footRect(p));
    }
    return out;
  }

  /**
   * The quarters of the floor (split at the centroid along the longest wall and across it) with nothing
   * in them or within `reach` of them, each as its floor points (0.25 m grid), the farthest from the
   * middle first. Quarters under `minArea` m² are left out.
   */
  emptyQuarters(reach = 0.6, minArea = 1.5): V2[][] {
    const { c, u, v } = this.axis(), xs = this.poly.map((p) => p[0]), zs = this.poly.map((p) => p[1]), cell = 0.25;
    const quarter = (p: V2) => ((p[0] - c[0]) * u[0] + (p[1] - c[1]) * u[1] >= 0 ? 1 : 0) + ((p[0] - c[0]) * v[0] + (p[1] - c[1]) * v[1] >= 0 ? 2 : 0);
    const cells: V2[][] = [[], [], [], []];
    for (let x = Math.min(...xs) + cell / 2; x < Math.max(...xs); x += cell) for (let z = Math.min(...zs) + cell / 2; z < Math.max(...zs); z += cell) if (pointInPoly(this.poly, x, z)) cells[quarter([x, z])].push([x, z]);
    const m = this.marks(), d = (p: V2) => Math.hypot(p[0] - c[0], p[1] - c[1]);
    return cells.filter((q) => q.length * cell * cell >= minArea && !q.some((g) => m.some((k) => Math.hypot(k[0] - g[0], k[1] - g[1]) <= reach))).map((q) => [...q].sort((a, b) => d(b) - d(a)));
  }

  /** Where the room's first doorway comes in (null for a room with none). */
  door(): V2 | null { const d = this.P.doors.find((x) => x.spaces.includes(this.r.id)); return d ? doorEntry(d, this.r.id).at : null; }
  /** A wall hanging by the room's tier: pegs for cloaks, a dyed hanging or a painted shield, a tapestry. */
  hangingKind(): string { return this.tier === 2 ? 'tapestry' : this.tier === 1 ? (this.rng() < 0.7 ? 'hanging' : 'shield') : 'peg-rail'; }
  /** The kind of a piece by the room's tier: [poor, plain, rich]. */
  byTier<T>(kinds: readonly [T, T, T]): T { return kinds[this.tier]; }

  /** A long axis through the room (direction of its longest wall) and the centroid. */
  axis(): { c: V2; u: V2; v: V2 } {
    const w = [...this.walls].sort((a, b) => b.L - a.L)[0];
    const u: V2 = [(w.b[0] - w.a[0]) / w.L, (w.b[1] - w.a[1]) / w.L];
    return { c: centroidOf(this.poly), u, v: [-u[1], u[0]] };
  }
}

function shuffle<T>(xs: T[], r: Rng): T[] { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const times = (r: Rng, a: number, b: number) => a + Math.floor(r() * (b - a + 1));
/** Lies flat on the floor (a carpet, rug, runner or skin): walked over, under furniture, layered. */
export const flat = (p: Prop) => p.kind.placement === 'floor' && p.bounds.max[1] < 0.06;
/** Kinds whose textiles follow the room's tone (their variant seed ≡ tone mod 3). */
export const TONED = new Set(['four-poster', 'armchair', 'sofa', 'footstool', 'round-table', 'carpet', 'pedestal-desk', 'tapestry', 'bed', 'rug', 'peg-rail', 'shield', 'hanging']);
/** Roles with no floor to furnish: stairs, passages and the gate passages (all floor is a way through). */
export const UNFLOORED: readonly Role[] = ['empty', 'passage', 'gate'];
/** Every other room has at least this many pieces. */
export const MIN_PROPS = 6;
/** Plain pieces that suit any room, to bring a bare one up to MIN_PROPS. */
const FILL = ['chest', 'stool', 'candle-sconce', 'bucket', 'crate', 'bench', 'tapestry', 'wall-shelf', 'sack', 'stool', 'candle-sconce'];
/** Roles where people live: a hearth, candles not torches, carpets, pictures. */
export const FAMILY: readonly Role[] = ['hall', 'solar', 'bedchamber', 'study'];
/** Roles that may burn torches (style guide: tunnels, cellars, gate rooms and passages). */
export const TORCH_ROLES: readonly Role[] = ['passage', 'cellar', 'gate', 'wine-cellar', 'dungeon', 'well-room', 'watch'];

const longest = (w: Wall) => w.L;
/** Prefer walls whose middle is far from a point (the bed away from the door). */
const farFrom = (p: V2 | null) => (w: Wall) => (p ? Math.hypot((w.a[0] + w.b[0]) / 2 - p[0], (w.a[1] + w.b[1]) / 2 - p[1]) : w.L);
/** Clear space round the fireside seats and their lamp table: room to sit down, and they read as separate pieces. */
export const SEAT_GAP = 0.25;
const frontOf = (p: Placed): V2 => [Math.sin(p.yaw), Math.cos(p.yaw)];

/**
 * The hearth first, on the longest inner wall it fits (centred), then what gathers round it: an
 * overmantel mirror or portrait, a garniture on the mantel, a rug or skin before it, armchairs angled
 * to the fire (and a sofa facing it), a side table with a lamp. Returns the hearth, or null.
 */
export function hearthGroup(D: RoomDresser, o: { kind?: string; chairs?: 0 | 1 | 2; sofa?: boolean; lamp?: boolean; stool?: boolean; seat?: string } = {}): Placed | null {
  const h = D.againstWall(o.kind ?? 'chimneypiece', { inner: true, centre: true, prefer: longest });
  if (!h) return null;
  const n = frontOf(h), t: V2 = [n[1], -n[0]], b = h.prop.bounds, front = b.max[2];
  const P = (d: number, s: number): V2 => [h.at[0] + n[0] * d + t[0] * s, h.at[2] + n[1] * d + t[1] * s];
  const fire = P(front - 0.35, 0);
  if (h.prop.meta.above) D.over(D.rng() < 0.6 ? 'overmantel-mirror' : 'portrait', h);
  if (h.prop.meta.mantel) D.onMantel(D.tier === 2 && D.rng() < 0.5 ? 'candelabrum' : 'candlestick', h, [-0.72, 0.72]);
  if (D.tier > 0 || D.rng() < 0.3) D.at(D.rng() < 0.5 ? 'skin' : 'rug', P(front + 0.85, 0), h.yaw + Math.PI / 2, 0.15);
  const chairs = o.chairs ?? 2;
  if (chairs) {
    for (const sx of chairs === 2 ? [-1, 1] : [D.rng() < 0.5 ? -1 : 1]) {
      const c = P(front + 1.3, sx * range(D.rng, 0.95, 1.1));
      D.at(o.seat ?? 'armchair', c, yawFacing([fire[0] - c[0], fire[1] - c[1]]), 0.2, SEAT_GAP);
    }
    if (o.sofa) D.at('sofa', P(front + 2.9, 0), h.yaw + Math.PI, 0.3, SEAT_GAP);
    if (o.lamp !== false) { const st = D.at('side-table', P(front + 1.4, (D.rng() < 0.5 ? -1 : 1) * 1.75), h.yaw, 0.2, SEAT_GAP); D.onTop(D.tier === 2 ? 'oil-lamp' : 'candlestick', st); }
    if (o.stool !== false) D.at('footstool', P(front + 0.75, (D.rng() < 0.5 ? -1 : 1) * 0.6), h.yaw + 0.3, 0.1);
  }
  return h;
}

/** Suits of armour standing against the wall either side of a prop (a hearth, a door). */
function flank(D: RoomDresser, base: Placed | null, kind: string) {
  if (!base) return;
  const n = frontOf(base), t: V2 = [n[1], -n[0]], b = base.prop.bounds, wall = b.min[2] - 0.04;
  for (const sx of [-1, 1]) {
    const k = D.prop(kind), back = 0.04 - k.bounds.min[2], s = sx * ((b.max[0] - b.min[0]) / 2 + 0.55);
    D.at(kind, [base.at[0] + n[0] * (wall + back) + t[0] * s, base.at[2] + n[1] * (wall + back) + t[1] * s], base.yaw, 0.1);
  }
}

const RECIPES: Record<Role, (D: RoomDresser) => void> = {
  empty: () => {},
  passage: (D) => {
    const len = D.walls.reduce((s, w) => s + w.L, 0);
    if (D.r.zone === 'tunnel') { for (let i = 0; i < Math.min(3, Math.floor(len / 16)); i++) D.onWall('sconce', false); return; } // tunnels stay medieval
    if (!D.walls.some((w) => w.L > 6)) return;
    // a Victorian gallery: a runner down the middle, a feature every ~3.5 m along one wall, sconces
    const { c, u } = D.axis(), wall = [...D.walls].sort((a, b) => b.L - a.L)[0];
    D.at('runner', c, yawFacing(u), 0.3);
    const features = ['armour', 'hall-chair', 'armour', 'hall-chair'];
    for (let i = 0; i < Math.floor(wall.L / 3.5); i++) D.againstWall(features[i % features.length], { prefer: (w) => (w === wall ? 1 : 0) });
    for (const kind of ['stag-head', 'portrait', 'stag-head']) D.onWall(kind, false, { walls: [wall] });
    for (let i = 0; i < Math.max(1, Math.floor(len / 12)); i++) D.onWall('candle-sconce', false);
  },
  gate: (D) => {
    // the gate's guard: racks of arms, a bench, a chest and a barrel along the walls, torches
    D.againstWall('weapon-rack'); D.againstWall('bench'); D.againstWall('chest');
    D.onWall('sconce', false); D.onWall('sconce', false); D.onWall('weapon-trophy', false);
    D.extras(['shackles', 'barrel', 'weapon-trophy', 'armour-stand', 'bucket', 'stool']);
  },
  hall: (D) => {
    const { c, v } = D.axis();
    // the hearth on the long inner wall, suits of armour either side, a skin or rug before it
    const hearth = hearthGroup(D, { kind: 'hooded-hearth', chairs: 0 });
    flank(D, hearth, 'armour');
    // the high table: the lord's box chair against an inner wall and a laid refectory table before it,
    // a bench on its far side for the household; the lord's candles and plate on it
    const lord = D.againstWall('box-chair', { inner: true, prefer: longest });
    if (lord) {
      const n = frontOf(lord), d = lord.prop.bounds.max[2] + 0.55;
      const high = D.at('refectory-table', [lord.at[0] + n[0] * d, lord.at[2] + n[1] * d], lord.yaw + Math.PI / 2, 0.25);
      if (high) { D.onTop('candelabrum', high, 0.6, 0); D.onTop('tableware', high, -0.5, 0); D.onTop('candlestick', high, -1.2, 0); }
    }
    // long trestle tables down the hall with benches either side; the middle stays open
    const yaw = yawFacing(v);
    for (const off of [-2.2, 2.2]) {
      const t = D.near('refectory-table', [c[0] + v[0] * off, c[1] + v[1] * off], yaw, 0.6);
      if (!t) continue;
      const side = frontOf(t);
      for (const s of [-0.75, 0.75]) D.near('bench', [t.at[0] + side[0] * s, t.at[2] + side[1] * s], t.yaw, 0.15);
      D.onTop('tableware', t, range(D.rng, -0.8, 0.8), 0);
      D.ceiling('chandelier', [t.at[0], t.at[2]]);
    }
    // the dresser with the household's pewter against an inner wall
    const dr = D.againstWall('dresser', { inner: true });
    D.onTop('candlestick', dr, -0.4, 0.1);
    // the walls carry the clutter: heads in a row, trophies, a tapestry, portraits hung high
    for (const kind of ['stag-head', 'stag-head', 'weapon-trophy', 'tapestry', 'stag-head', 'portrait', 'weapon-trophy', 'portrait']) D.onWall(kind);
    for (let i = 0; i < 4; i++) D.onWall('candle-sconce', false);
  },
  chapel: (D) => {
    // the stone altar against the wall with the most room before it, a prie-dieu facing it, benches
    // behind for the household, a lectern and a vestment chest if they fit, a tapestry and candles
    const depth = (w: Wall) => Math.max(...D.poly.map((p) => (p[0] - w.a[0]) * w.n[0] + (p[1] - w.a[1]) * w.n[1])) - w.n[0] * 0.3;
    const altar = D.againstWall('stone-altar', { prefer: depth, centre: true }) ?? D.againstWall('altar', { prefer: depth });
    if (altar) {
      const n = frontOf(altar), d0 = altar.prop.bounds.max[2], P = (d: number): V2 => [altar.at[0] + n[0] * d, altar.at[2] + n[1] * d];
      // down the room from the altar: the first free spot for the prie-dieu, then the benches behind it
      // (a doorway's clear zone may lie between)
      const far = Math.max(...D.poly.map((q) => (q[0] - altar.at[0]) * n[0] + (q[1] - altar.at[2]) * n[1]));
      const along = (kind: string, from: number, yaw: number) => { for (let d = from; d < far; d += 0.2) { const p = D.at(kind, P(d), yaw, 0.35, 0.05); if (p) return d; } return null; };
      const pd = along('prie-dieu', d0 + 0.4, altar.yaw + Math.PI);
      let d: number | null = pd === null ? d0 + 0.6 : pd + 0.65;
      for (let i = 0; i < 3 && d !== null; i++) d = along('bench', d, altar.yaw), d = d === null ? null : d + 0.85;
      if (pd !== null && !D.placed.some((p) => p.prop.kind.name === 'bench')) along('bench', pd - 0.6, altar.yaw); // beside it, in a small chapel
      D.near('lectern', P(d0 + 1.0), altar.yaw + Math.PI, 1.5);
    }
    D.againstWall('chest');
    D.onWall('tapestry'); D.onWall('candle-sconce', false); D.onWall('candle-sconce', false);
  },
  bedchamber: (D) => {
    // three arrangements: the bed's head in a corner of an inner wall (the rest of the wall left for the
    // hearth), the bed's head in the middle of the longest solid wall between two bedside tables, or the
    // bed in the corner farthest from the door with a window seat; a chest at its foot. The bed by tier:
    // a plain bed with a wool coverlet, a curtained bed for the best rooms.
    const kind = D.byTier(['bed', D.rng() < 0.35 ? 'four-poster' : 'bed', 'four-poster'] as const);
    const bed = D.layout === 1 ? D.againstWall(kind, { inner: true, centre: true, prefer: longest }) ?? D.againstWall(kind, { centre: true })
      : D.layout === 2 ? D.againstWall(kind, { corner: true, prefer: farFrom(D.door()) }) ?? D.againstWall(kind)
      : D.againstWall(kind, { inner: true, corner: true }) ?? D.againstWall(kind);
    if (bed) {
      const b = bed.prop.bounds, n = frontOf(bed), t: V2 = [n[1], -n[0]], P = (d: number, s: number): V2 => [bed.at[0] + n[0] * d + t[0] * s, bed.at[2] + n[1] * d + t[1] * s];
      if (D.layout !== 0 || D.rng() < 0.5) D.at(D.tier === 0 ? 'basket' : 'chest', P(b.max[2] + 0.4, 0), bed.yaw + Math.PI / 2, 0.3);
      const sides = D.layout === 1 ? [-1, 1] : [D.rng() < 0.5 ? -1 : 1];
      for (const sx of sides) D.onTop(D.tier === 2 && D.rng() < 0.4 ? 'candelabrum' : 'candlestick', D.at(D.tier === 0 ? 'stool' : 'side-table', P(b.min[2] + 0.35, sx * (b.max[0] + 0.35)), bed.yaw, 0.1));
      if (D.tier > 0) D.at('rug', P((b.min[2] + b.max[2]) / 2, -sides[0] * (b.max[0] + 0.55)), bed.yaw, 0.2);
    }
    const hearth = D.tier > 0 ? hearthGroup(D, { chairs: D.tier === 2 ? 1 : 0, lamp: false, stool: false, seat: D.layout === 0 ? 'armchair' : 'box-chair' }) : null;
    if (!hearth && D.tier === 2) D.near('carpet', D.axis().c, D.rng() * 3, 0.6);
    if (D.layout === 2) D.underWindow(D.tier === 0 ? 'bench' : 'chest');
    D.againstWall(D.byTier(['chest', 'cupboard', 'cupboard'] as const), { inner: true });
    if (D.tier === 2) D.onWall('portrait');
    D.onWall(D.hangingKind());
    D.onWall(D.tier === 0 ? 'peg-rail' : 'candle-sconce', D.tier === 0);
    D.extras(['chest', 'stool', 'prie-dieu', 'writing-desk', 'drying-rack', 'box-chair']);
  },
  solar: (D) => {
    // the family's day room, in one of three arrangements: the hearth with seats round it and a table in
    // the middle; a table in the window's light with chairs and a window seat; or a long board with
    // benches down the room and a cupboard of plate, the hearth left bare
    const { c, u, v } = D.axis(), seat = D.byTier(['stool', 'chair', 'box-chair'] as const);
    if (D.layout === 0) {
      if (D.tier > 0) D.near(D.tier === 2 ? 'carpet' : 'rug', c, yawFacing(v), 0.4);
      hearthGroup(D, { sofa: D.tier === 2, seat: D.tier === 2 ? 'armchair' : seat, chairs: D.tier === 0 ? 1 : 2 });
      const t = D.near('round-table', c, D.rng() * 6, 1.4);
      D.onTop(D.tier === 2 ? 'oil-lamp' : 'candlestick', t, 0.15, 0.1); D.onTop('book-stack', t, -0.25, -0.1);
      if (t) for (const a of [0.5, 2.6]) { const yaw = t.yaw + a; D.at('hall-chair', [t.at[0] + Math.sin(yaw) * 0.85, t.at[2] + Math.cos(yaw) * 0.85], yaw + Math.PI, 0.15); }
    } else if (D.layout === 1) {
      const t = D.underWindow('trestle-table') ?? D.near('trestle-table', c, yawFacing(u), 1.2);
      if (t) {
        const n = frontOf(t), d = t.prop.bounds.max[2] + 0.35;
        for (const s of D.tier === 0 ? [0] : [-0.5, 0.5]) D.at(seat, [t.at[0] + n[0] * d + n[1] * s, t.at[2] + n[1] * d - n[0] * s], t.yaw + Math.PI, 0.15);
        D.onTop('book-stack', t, -0.4, 0); D.onTop(D.tier === 2 ? 'candelabrum' : 'tableware', t, 0.4, 0);
      }
      hearthGroup(D, { chairs: D.tier === 0 ? 0 : 1, lamp: false, stool: false, seat });
      D.underWindow('chest') ?? D.againstWall('chest');
      D.againstWall(D.k % 2 ? 'loom' : 'lectern');
      if (D.tier > 0) D.near('rug', c, yawFacing(v), 1);
    } else {
      const t = D.near('trestle-table', c, yawFacing(u), 1);
      if (t) {
        const side = frontOf(t);
        for (const s of [-0.75, 0.75]) D.near('bench', [t.at[0] + side[0] * s, t.at[2] + side[1] * s], t.yaw, 0.15);
        D.onTop('tableware', t, range(D.rng, -0.6, 0.6), 0);
        if (D.tier === 2) D.ceiling('chandelier', [t.at[0], t.at[2]]);
      }
      hearthGroup(D, { chairs: 0, lamp: false, stool: false });
      const cab = D.againstWall(D.tier === 2 ? 'dresser' : 'cupboard', { inner: true });
      D.onTop(D.tier === 2 ? 'candelabrum' : 'candlestick', cab, 0, 0.05);
    }
    for (const kind of D.tier === 2 ? ['portrait', 'portrait', D.hangingKind()] : [D.hangingKind(), 'shield']) D.onWall(kind);
    D.onWall('candle-sconce', false);
    D.extras(['loom', 'chest', 'box-chair', 'tapestry', 'stool', 'side-table']);
  },
  study: (D) => {
    // a scholar's room in three arrangements: bookcases on the inner walls, the hearth with one seat and a
    // desk in the room; a table in the window's light with books and a lectern in the middle; or a sloped
    // desk in a corner, shelves and a press of books, a chest of rolls
    const { c, v } = D.axis(), seat = D.byTier(['stool', 'chair', 'box-chair'] as const);
    if (D.layout === 0) {
      const h = hearthGroup(D, { chairs: 1, stool: false, lamp: D.tier === 2, seat: D.tier === 2 ? 'armchair' : seat });
      for (let i = 0; i < 2; i++) D.againstWall('bookcase', { inner: true });
      if (D.tier > 0) D.near(D.tier === 2 ? 'carpet' : 'rug', c, yawFacing(v), 0.6);
      const desk = D.near(D.tier === 2 ? 'pedestal-desk' : 'trestle-table', [c[0] + v[0] * 0.8, c[1] + v[1] * 0.8], yawFacing(v), 1.0);
      if (desk) {
        const n = frontOf(desk);
        D.at(seat, [desk.at[0] - n[0] * 0.75, desk.at[2] - n[1] * 0.75], desk.yaw, 0.1);
        D.onTop(D.tier === 2 ? 'oil-lamp' : 'candlestick', desk, -0.5, -0.15); D.onTop('book-stack', desk, 0.4, 0);
      }
      if (!h) D.againstWall('bookcase');
    } else if (D.layout === 1) {
      const t = D.underWindow('trestle-table');
      if (t) { const n = frontOf(t), d = t.prop.bounds.max[2] + 0.35; D.at(seat, [t.at[0] + n[0] * d, t.at[2] + n[1] * d], t.yaw + Math.PI, 0.15); D.onTop('book-stack', t, -0.5, 0); D.onTop('candlestick', t, 0.3, 0); }
      else D.againstWall('writing-desk');
      D.againstWall('bookcase', { inner: true });
      D.near('lectern', c, D.rng() * 6, 1);
      hearthGroup(D, { chairs: D.tier === 0 ? 0 : 1, lamp: false, stool: false, seat });
      D.onTop('book-stack', D.againstWall('chest'));
      D.onWall('wall-shelf');
    } else {
      const desk = D.againstWall('writing-desk', { corner: true, prefer: farFrom(D.door()) });
      if (desk) { const n = frontOf(desk); D.at('stool', [desk.at[0] + n[0] * 0.55, desk.at[2] + n[1] * 0.55], 0, 0.15); }
      D.againstWall(D.tier === 0 ? 'chest' : 'bookcase', { inner: true });
      hearthGroup(D, { chairs: D.tier === 0 ? 0 : 1, lamp: false, stool: false, seat });
      D.onWall('wall-shelf'); D.onWall('wall-shelf');
      D.near(D.tier === 0 ? 'basket' : 'skin', c, D.rng() * 6, 1);
    }
    for (const kind of D.tier === 2 ? ['stag-head', 'portrait'] : [D.hangingKind()]) D.onWall(kind);
    D.onWall('candle-sconce', false);
    D.extras(['writing-desk', 'lectern', 'chest', 'stool', 'book-stack', 'tapestry']);
  },
  guard: (D) => {
    // kept plain: a deal table and benches in the middle, or against the wall with the men's pallets down
    // the room and a brazier; arms racked and in trophies, the garrison's shield, pegs for cloaks
    const { c, v } = D.axis();
    if (D.layout === 0) {
      const t = D.near('trestle-table', c, yawFacing(v), 1);
      D.onTop('tableware', t, 0, 0); D.onTop('candlestick', t, 0.5, 0);
      if (t) for (const s of [-0.72, 0.72]) { const side = frontOf(t); D.near('bench', [t.at[0] + side[0] * s, t.at[2] + side[1] * s], t.yaw, 0.15); }
      D.againstWall('weapon-rack', { inner: true }); D.againstWall('armour');
      D.againstWall('chest'); D.againstWall('stool');
      if (D.rng() < 0.5) D.againstWall('straw-pallet');
      if (t) D.ceiling('chandelier', [t.at[0], t.at[2]]);
    } else {
      const t = D.againstWall('trestle-table', { inner: true });
      if (t) { const n = frontOf(t); D.at('bench', [t.at[0] + n[0] * (t.prop.bounds.max[2] + 0.3), t.at[2] + n[1] * (t.prop.bounds.max[2] + 0.3)], t.yaw, 0.15); D.onTop('tableware', t, -0.3, 0); D.onTop('candlestick', t, 0.4, 0); }
      for (let i = 0; i < 2; i++) D.againstWall('straw-pallet', { corner: true });
      D.focal('brazier');
      D.againstWall('weapon-rack');
    }
    D.onWall('weapon-trophy'); D.onWall('shield'); D.onWall('peg-rail');
    D.onWall('candle-sconce', false);
    D.extras(['brazier', 'stool', 'barrel', 'crate', 'bucket', 'armour-stand']);
  },
  kitchen: (D) => {
    // the open hearth dominates the longest inner wall: a spit on its dogs and a cauldron on the crane
    // over the fire; logs stacked beside it, the big work table in the middle, the dresser, shelves and
    // stores round the walls
    const h = D.againstWall('spit-hearth', { inner: true, centre: true, prefer: longest });
    if (h) { const n = frontOf(h), t: V2 = [n[1], -n[0]], hw = h.prop.bounds.max[0]; D.at('firewood', [h.at[0] + n[0] * 0.2 + t[0] * (hw + 0.5), h.at[2] + n[1] * 0.2 + t[1] * (hw + 0.5)], h.yaw + Math.PI / 2, 0.2); D.at('bucket', [h.at[0] + n[0] * 0.2 - t[0] * (hw + 0.4), h.at[2] + n[1] * 0.2 - t[1] * (hw + 0.4)], h.yaw, 0.2); }
    const { c, v } = D.axis();
    const t = D.near('work-table', c, yawFacing(v), 1);
    if (t) { const side = frontOf(t); D.near('stool', [t.at[0] + side[0] * 0.8, t.at[2] + side[1] * 0.8], 0, 0.3); }
    if (!h) D.againstWall('cauldron');
    D.againstWall('shelf', { inner: true }); D.againstWall('cupboard', { inner: true });
    for (let i = 0; i < times(D.rng, 2, 4); i++) D.againstWall('barrel');
    D.againstWall('sack'); D.againstWall('sack');
    D.onWall('stag-head'); D.onWall('candle-sconce', false);
    D.extras(['dresser', 'chest', 'bucket', 'barrel', 'crate', 'stool']);
  },
  buttery: (D) => {
    // drink: casks on stillages, barrels, jugs and cups on a table, a dresser of pewter
    for (let i = 0; i < 1 + (D.k % 2); i++) D.againstWall('cask-rack');
    for (let i = 0; i < 2 + (D.k % 3); i++) D.againstWall('barrel');
    const t = D.near('trestle-table', D.axis().c, yawFacing(D.axis().v), 1);
    D.onTop('tableware', t, 0, 0); D.onTop('candlestick', t, 0.6, 0);
    D.onWall('candle-sconce', false);
    D.extras(['crate', 'stool', 'chest', 'sack', 'dresser', 'bucket']);
  },
  pantry: (D) => {
    // food: shelves of crocks, crates and sacks, a scrubbed table with bowls
    D.againstWall('shelf', { inner: true }); if (D.k % 2) D.againstWall('shelf');
    const t = D.near('work-table', D.axis().c, yawFacing(D.axis().v), 1);
    if (!t) D.againstWall('trestle-table');
    for (let i = 0; i < 2 + (D.k % 3); i++) D.againstWall(pick(D.rng, ['crate', 'sack']));
    D.onWall('candle-sconce', false);
    D.extras(['barrel', 'bucket', 'stool', 'cupboard', 'firewood', 'chest']);
  },
  brewhouse: (D) => {
    // the mash tun in the middle, malt in sacks, barrels of ale, a cask on its stillage
    const { c, v } = D.axis();
    D.near('mash-tun', c, yawFacing(v), 1.2) ?? D.againstWall('mash-tun');
    for (let i = 0; i < 2 + (D.k % 2); i++) D.againstWall('barrel');
    for (let i = 0; i < 2; i++) D.againstWall('sack');
    D.againstWall('bucket');
    D.onWall('candle-sconce', false);
    D.extras(['cask-rack', 'crate', 'stool', 'wall-shelf', 'firewood', 'chest']);
  },
  bakehouse: (D) => {
    // the oven against a solid wall, a kneading table, flour sacks, the faggots to fire it
    const oven = D.againstWall('bread-oven', { inner: true, centre: true, prefer: longest }) ?? D.againstWall('bread-oven');
    if (oven) { const n = frontOf(oven), t: V2 = [n[1], -n[0]], hw = oven.prop.bounds.max[0]; D.at('firewood', [oven.at[0] + n[0] * 0.2 + t[0] * (hw + 0.5), oven.at[2] + n[1] * 0.2 + t[1] * (hw + 0.5)], oven.yaw, 0.3); }
    const tb = D.near('work-table', D.axis().c, yawFacing(D.axis().v), 1);
    for (let i = 0; i < 2 + (D.k % 2); i++) D.againstWall('sack');
    D.againstWall('shelf', { inner: true });
    if (!tb) D.againstWall('trestle-table');
    D.onWall('candle-sconce', false);
    D.extras(['barrel', 'stool', 'crate', 'bucket', 'cupboard', 'chest']);
  },
  laundry: (D) => {
    // tubs and a copper, linen drying on racks, baskets and chests of clean linen
    const { c, v } = D.axis();
    D.near('wash-tub', c, yawFacing(v), 1.2);
    D.againstWall('wash-tub');
    for (let i = 0; i < 1 + (D.k % 2); i++) D.near('drying-rack', [c[0] + v[0] * 1.5, c[1] + v[1] * 1.5], yawFacing(v) + Math.PI / 2, 1.5) ?? D.againstWall('drying-rack');
    D.againstWall('bucket'); D.againstWall('chest');
    D.onWall('candle-sconce', false);
    D.extras(['cauldron', 'bucket', 'stool', 'wall-shelf', 'firewood', 'barrel']);
  },
  armoury: (D) => {
    // racks of weapons, harness on its stand, a grindstone to keep the edges, trophies on the walls
    D.againstWall('weapon-rack', { inner: true }); D.againstWall('weapon-rack');
    D.againstWall('armour-stand');
    D.near('grindstone', D.axis().c, D.rng() * 6, 1.2);
    D.againstWall('chest');
    D.onWall('weapon-trophy'); D.onWall('candle-sconce', false);
    D.extras(['armour', 'bench', 'crate', 'barrel', 'stool', 'weapon-rack']);
  },
  'wine-cellar': (D) => {
    // casks on stillages down the walls, a candle on a barrel head
    for (let i = 0; i < 2 + (D.k % 2); i++) D.againstWall('cask-rack');
    for (let i = 0; i < 2; i++) D.againstWall('barrel');
    const b = D.againstWall('barrel'); D.onTop('candlestick', b);
    D.onWall('sconce', false);
    D.extras(['crate', 'wall-shelf', 'stool', 'sack', 'chest', 'cask-rack']);
  },
  dungeon: (D) => {
    // chains on the walls, straw on the floor, a bucket, the gaoler's bench and a torch
    D.onWall('shackles'); D.onWall('shackles');
    D.near('straw-heap', D.axis().c, D.rng() * 6, 1.2);
    D.againstWall('straw-pallet'); D.againstWall('bucket'); D.againstWall('bench');
    D.onWall('sconce', false);
    D.extras(['stool', 'shackles', 'barrel', 'crate', 'chest', 'straw-heap']);
  },
  'well-room': (D) => {
    // the well head in the middle with its windlass, buckets and casks of water round the walls
    D.focal('well', D.rng() * 6);
    D.againstWall('bucket'); D.againstWall('bucket');
    for (let i = 0; i < 2; i++) D.againstWall('barrel');
    D.againstWall('bench');
    D.onWall('sconce', false);
    D.extras(['crate', 'sack', 'stool', 'wash-tub', 'chest', 'cask-rack']);
  },
  lord: (D) => {
    // the lord's chamber: the great bed, the hearth with his box chair by it, a chest at the bed's foot,
    // tapestries, a cupboard of plate
    const bed = D.againstWall('four-poster', { inner: true, corner: true }) ?? D.againstWall('four-poster');
    if (bed) { const n = frontOf(bed), b = bed.prop.bounds; D.near('chest', [bed.at[0] + n[0] * (b.max[2] + 0.4), bed.at[2] + n[1] * (b.max[2] + 0.4)], bed.yaw + Math.PI / 2, 0.3); }
    const h = hearthGroup(D, { chairs: 0 });
    if (h) { const n = frontOf(h), t: V2 = [n[1], -n[0]], f = h.prop.bounds.max[2]; D.at('box-chair', [h.at[0] + n[0] * (f + 1.3) + t[0] * 1.0, h.at[2] + n[1] * (f + 1.3) + t[1] * 1.0], h.yaw + Math.PI - 0.5, 0.3, SEAT_GAP); } else D.againstWall('box-chair');
    D.againstWall('cupboard', { inner: true });
    D.onWall('tapestry'); D.onWall('tapestry'); D.onWall('candle-sconce', false);
    D.extras(['writing-desk', 'prie-dieu', 'stool', 'weapon-trophy', 'stag-head', 'side-table']);
  },
  lady: (D) => {
    // the lady's chamber: the bed, her prie-dieu, a loom or a chest of linen, the hearth, tapestries
    const bed = D.againstWall('four-poster', { inner: true, corner: true }) ?? D.againstWall('four-poster');
    if (bed) { const n = frontOf(bed), t: V2 = [n[1], -n[0]], b = bed.prop.bounds; const st = D.at('side-table', [bed.at[0] + t[0] * (b.max[0] + 0.35) + n[0] * (b.min[2] + 0.35), bed.at[2] + t[1] * (b.max[0] + 0.35) + n[1] * (b.min[2] + 0.35)], bed.yaw, 0.1); D.onTop('candlestick', st); }
    hearthGroup(D, { chairs: 0, lamp: false, stool: false });
    D.againstWall('prie-dieu'); D.againstWall(D.k % 2 ? 'loom' : 'chest');
    D.onWall('tapestry'); D.onWall('tapestry'); D.onWall('candle-sconce', false);
    D.extras(['stool', 'loom', 'drying-rack', 'chest', 'cupboard', 'rug']);
  },
  wardrobe: (D) => {
    // the wardrobe: gowns on a rail and presses of clothes, or cloaks on pegs round the walls over chests
    // of stuffs and baskets of linen
    if (D.layout === 0) {
      D.againstWall('drying-rack') ?? D.near('drying-rack', D.axis().c, 0, 1);
      D.againstWall('cupboard', { inner: true });
    } else {
      D.onWall('peg-rail'); D.onWall('peg-rail');
      D.againstWall('basket', { corner: true });
    }
    for (let i = 0; i < 2 + (D.k % 2); i++) D.againstWall('chest');
    if (D.tier > 0) D.onWall(D.hangingKind());
    D.onWall('candle-sconce', false);
    D.extras(['tapestry', 'stool', 'candle-sconce', 'wall-shelf', 'crate', 'sack']);
  },
  garderobe: (D) => {
    // the privy on its wall, water, a candle, a shelf; small rooms keep small things
    D.againstWall('privy', { inner: true }) ?? D.againstWall('privy');
    D.againstWall('bucket'); D.againstWall('stool');
    D.onWall('candle-sconce', false); D.onWall('candle-sconce', false);
    D.extras(['chest', 'sack', 'crate', 'drying-rack', 'wall-shelf', 'bucket']);
  },
  nursery: (D) => {
    // the cradle by the fire, or at the foot of the nurse's bed; a chest of swaddling, a basket, a rug
    const h = hearthGroup(D, { chairs: 0, lamp: false, stool: false });
    if (D.layout === 0) {
      if (h) { const n = frontOf(h), t: V2 = [n[1], -n[0]], f = h.prop.bounds.max[2]; D.at('cradle', [h.at[0] + n[0] * (f + 1.4) + t[0] * 0.9, h.at[2] + n[1] * (f + 1.4) + t[1] * 0.9], h.yaw + Math.PI / 2, 0.4); }
      D.againstWall('bed');
    } else {
      const bed = D.againstWall('bed', { corner: true, prefer: farFrom(D.door()) });
      if (bed) { const n = frontOf(bed), d = bed.prop.bounds.max[2] + 0.55; D.at('cradle', [bed.at[0] + n[0] * d, bed.at[2] + n[1] * d], bed.yaw + Math.PI / 2, 0.4); }
      D.againstWall('basket');
    }
    if (!D.placed.some((p) => p.prop.kind.name === 'cradle')) D.focal('cradle');
    D.againstWall('chest'); D.againstWall('stool');
    D.onWall(D.hangingKind()); D.onWall('candle-sconce', false);
    D.extras(['rug', 'stool', 'cupboard', 'chair', 'drying-rack', 'chest']);
  },
  library: (D) => {
    // the library and scriptorium: presses of books, a scribe's desk in the middle or a reading table in
    // the window's light, a lectern with a great book
    for (let i = 0; i < 2 + (D.k % 2); i++) D.againstWall('bookcase', { inner: true });
    const { c, v } = D.axis();
    const desk = D.layout === 0 ? D.near('writing-desk', [c[0] + v[0] * 0.6, c[1] + v[1] * 0.6], yawFacing(v), 1) : D.underWindow('trestle-table') ?? D.near('writing-desk', c, yawFacing(v), 1);
    if (desk) { const n = frontOf(desk), d = desk.prop.kind.name === 'trestle-table' ? desk.prop.bounds.max[2] + 0.3 : 0.55; D.at('stool', [desk.at[0] + n[0] * d, desk.at[2] + n[1] * d], 0, 0.15); D.onTop('book-stack', desk.prop.kind.name === 'trestle-table' ? desk : null, 0.3, 0); }
    D.near('lectern', D.layout === 0 ? [c[0] - v[0] * 1.2, c[1] - v[1] * 1.2] : c, yawFacing(v), 1);
    const ch = D.againstWall('chest'); D.onTop('book-stack', ch);
    if (D.layout === 1) D.onWall('wall-shelf');
    // by tier: a carpet and a portrait, a rug and a hanging, or a basket of rolls and pegs
    if (D.tier > 0) D.near(D.tier === 2 ? 'carpet' : 'rug', c, yawFacing(v), 1);
    D.onWall(D.tier === 2 ? 'portrait' : D.hangingKind());
    if (D.tier === 0) D.againstWall('basket');
    D.onWall('candle-sconce', false);
    D.extras(['chair', 'wall-shelf', 'rug', 'portrait', 'candle-sconce', 'book-stack']);
  },
  steward: (D) => {
    // the counting room: the chequered table with its coin and scales, the steward's chair, chests and rolls
    const { c, v } = D.axis();
    const t = D.near('counting-table', c, yawFacing(v), 1);
    if (t) { const n = frontOf(t); D.at(D.k % 2 ? 'box-chair' : 'chair', [t.at[0] - n[0] * 0.75, t.at[2] - n[1] * 0.75], t.yaw, 0.15); }
    for (let i = 0; i < 2; i++) D.againstWall('chest');
    D.onWall('wall-shelf');
    D.againstWall('writing-desk');
    D.onWall('candle-sconce', false);
    D.extras(['cupboard', 'stool', 'tapestry', 'crate', 'book-stack', 'chest']);
  },
  treasury: (D) => {
    // the strong room: iron-bound chests, the counting table, arms to guard it
    for (let i = 0; i < 3 + (D.k % 2); i++) D.againstWall('chest');
    D.near('counting-table', D.axis().c, yawFacing(D.axis().v), 1);
    D.againstWall('weapon-rack');
    D.onWall('candle-sconce', false); D.onWall('weapon-trophy');
    D.extras(['armour', 'stool', 'crate', 'wall-shelf', 'cupboard', 'chest']);
  },
  sewing: (D) => {
    // the women's work room: a loom against the wall, a table of cloth in the middle or in the window's
    // light, stools, baskets of wool, a chest of thread
    D.againstWall('loom', { inner: true }) ?? D.againstWall('loom');
    const t = D.layout === 1 ? D.underWindow('trestle-table') ?? D.near('trestle-table', D.axis().c, yawFacing(D.axis().v), 1) : D.near('trestle-table', D.axis().c, yawFacing(D.axis().v), 1);
    if (t) { const n = frontOf(t); for (const s of D.layout === 1 ? [t.prop.bounds.max[2] + 0.3] : [-0.7, 0.7]) D.at('stool', [t.at[0] + n[0] * s, t.at[2] + n[1] * s], 0, 0.2); D.onTop('basket', t, 0.5, 0); }
    D.againstWall('chest'); D.againstWall(D.layout === 1 ? 'basket' : 'drying-rack');
    if (D.layout === 1) D.onWall('peg-rail');
    D.onWall('candle-sconce', false);
    D.extras(['wall-shelf', 'sack', 'tapestry', 'bench', 'rug', 'cupboard']);
  },
  physician: (D) => {
    // the physician's room: a bed for the sick (by the wall, or in the corner farthest from the door), a
    // table of jars and bowls in the middle or in the window's light, simples on shelves, his desk
    D.layout === 1 ? D.againstWall('bed', { corner: true, prefer: farFrom(D.door()) }) : D.againstWall('bed');
    const t = D.layout === 1 ? D.underWindow('trestle-table') : D.near('work-table', D.axis().c, yawFacing(D.axis().v), 1);
    D.onTop('tableware', t, 0, 0);
    if (!t) D.againstWall('trestle-table');
    D.onWall('wall-shelf'); D.onWall('wall-shelf'); D.againstWall('writing-desk'); D.againstWall('stool');
    if (D.layout === 1) D.againstWall('basket');
    D.onWall('candle-sconce', false);
    D.extras(['chest', 'cupboard', 'bucket', 'drying-rack', 'lectern', 'wall-shelf']);
  },
  mews: (D) => {
    // the falconer's mews: hawks hooded on their perches, straw, water, the falconer's chest
    const { c, v } = D.axis();
    D.near('perch', c, yawFacing(v), 1);
    D.againstWall('perch');
    D.near('straw-heap', [c[0] + v[0] * 1.2, c[1] + v[1] * 1.2], 0, 1);
    D.againstWall('bucket'); D.againstWall('chest'); D.againstWall('stool');
    D.onWall('candle-sconce', false);
    D.extras(['bench', 'barrel', 'sack', 'crate', 'weapon-rack', 'wall-shelf']);
  },
  watch: (D) => {
    // the watch room at the top of a tower: a brazier to keep warm, a bench under the slits, arms
    D.focal('brazier');
    D.againstWall('bench'); D.againstWall('weapon-rack');
    D.againstWall('chest'); D.againstWall('stool');
    D.onWall('sconce', false);
    D.extras(['barrel', 'armour-stand', 'crate', 'bucket', 'straw-pallet', 'bench']);
  },
  store: (D) => {
    for (let i = 0; i < times(D.rng, 3, 7); i++) D.againstWall(pick(D.rng, ['barrel', 'barrel', 'crate', 'crate', 'sack', 'sack', 'chest']));
    if (D.rng() < 0.5) D.againstWall('shelf', { inner: true });
    if (D.rng() < 0.4) D.againstWall('firewood');
    D.onWall('candle-sconce', false);
    D.extras(['cask-rack', 'stool', 'bucket', 'wall-shelf', 'firewood', 'chest']);
  },
  cellar: (D) => {
    for (let i = 0; i < times(D.rng, 4, 9); i++) D.againstWall(pick(D.rng, ['barrel', 'barrel', 'barrel', 'crate', 'sack', 'firewood']));
    if (D.rng() < 0.5) D.near('straw-heap', D.axis().c, D.rng() * 6, 1.5);
    D.onWall('sconce', false);
    D.extras(['cask-rack', 'crate', 'straw-heap', 'bucket', 'chest', 'stool']);
  },
};

/** Wall pieces that dress a room (not its lights, not its shutters). */
export const DECOR: ReadonlySet<string> = new Set(['tapestry', 'hanging', 'shield', 'peg-rail', 'wall-shelf', 'portrait', 'stag-head', 'weapon-trophy', 'shackles', 'overmantel-mirror']);
/** Pieces with a top that small things stand on. */
const TOPS: ReadonlySet<string> = new Set(['chest', 'cupboard', 'trestle-table', 'work-table', 'side-table', 'counting-table', 'round-table', 'pedestal-desk']);
/** What fills an empty quarter of the floor, by tier, and what hangs there when nothing stands. */
const CLUTTER: readonly (readonly string[])[] = [['sack', 'basket', 'bucket', 'crate', 'firewood', 'barrel'], ['basket', 'chest', 'stool', 'bucket', 'sack'], ['chest', 'basket', 'stool', 'side-table']];
const WALL_FILL: readonly (readonly string[])[] = [['peg-rail', 'wall-shelf'], ['wall-shelf', 'peg-rail', 'shield'], ['wall-shelf', 'shield', 'hanging']];
const GARRISON: readonly Role[] = ['guard', 'armoury', 'watch', 'gate'];

/**
 * After a room's recipe: wall dressing up to what its size and tier call for (a hanging, a shelf, pegs
 * with cloaks; the garrison's shields), small things on the bare tops of its tables and chests (books, a
 * jug and bowls, a basket; a candle when the room has none), and a piece in or by every quarter of the
 * floor that is still empty: something that suits the tier against the nearest wall, else on that wall.
 */
export function finish(D: RoomDresser) {
  const want = 1 + (AREA(D.r) > 20 ? 1 : 0) + (D.tier === 2 ? 1 : 0), decor = () => D.placed.filter((p) => DECOR.has(p.prop.kind.name)).length;
  const living = !SERVICE.includes(D.role);
  for (const kind of GARRISON.includes(D.role) ? ['shield', 'peg-rail', 'wall-shelf'] : living ? [D.hangingKind(), 'wall-shelf', 'peg-rail'] : ['peg-rail', 'wall-shelf']) { if (decor() >= want) break; D.onWall(kind); }
  let lit = D.placed.some((p) => p.prop.meta.emitters.some((e) => e.kind === 'candle'));
  const y0 = D.r.y0;
  for (const base of [...D.placed]) {
    if (!TOPS.has(base.prop.kind.name) || base.at[1] > y0 + 0.05 || D.rng() < 0.4) continue;
    if (D.placed.some((p) => p !== base && p.at[1] > y0 + 0.05 && p.prop.kind.placement === 'floor' && Math.hypot(p.at[0] - base.at[0], p.at[2] - base.at[2]) < 0.6)) continue;
    const w = base.prop.bounds.max[0] - base.prop.bounds.min[0];
    const kind = !lit && living ? 'candlestick' : living ? pick(D.rng, ['book-stack', 'tableware', 'book-stack']) : pick(D.rng, ['tableware', 'basket']);
    if (kind === 'candlestick') lit = true;
    D.onTop(kind, base, range(D.rng, -w / 4, w / 4), 0);
  }
  for (const q of D.emptyQuarters()) {
    const targets = [q[0], q[Math.floor(q.length / 3)], q[Math.floor((q.length * 2) / 3)]];
    let ok = false;
    for (const target of targets) {
      for (const kind of shuffle([...CLUTTER[D.tier]], D.rng)) if (D.againstWall(kind, { toward: target, within: 0.9 })) { ok = true; break; }
      for (const kind of ok ? [] : WALL_FILL[D.tier]) if (D.onWall(kind, true, { toward: target, within: 0.9 })) { ok = true; break; }
      if (!ok) ok = !!D.at(pick(D.rng, CLUTTER[D.tier]), target, D.rng() * 6, 0.4);
      if (ok) break;
    }
  }
}

/** Dress one room. */
export function dressRoom(r: RoomSpec, P: InteriorPlan, deps: DressDeps = {}): RoomDressing {
  const seed = deps.seed ?? 0, make = deps.make ?? variantPool();
  const rng = mulberry32(hashSeed(`dress:${r.id}`, seed));
  const fixed = fixedRole(r), dealt = roleTable(P, seed).get(r.id);
  // a room the plan does not hold as given (tests): its kind's role, or one of its own
  const slot = dealt && (!fixed || dealt.role === fixed) ? dealt : { role: fixed ?? roleOf(r, rng), k: 0 };
  const role = slot.role;
  const keepOut = keepOutFor(r, P);
  const D = new RoomDresser(r, P, keepOut, rng, make, seed, deps.windows);
  D.k = slot.k; D.role = role;
  const ch = characterOf(r, P, slot, seed);
  D.tier = ch.tier; D.layout = ch.layout; D.tone = ch.palette;
  if (role !== 'empty') D.shutters();
  RECIPES[role](D);
  if (!UNFLOORED.includes(role)) finish(D);
  // a floor on how bare a room may be: top it up with plain things that suit any room
  if (!UNFLOORED.includes(role)) for (const kind of FILL) { if (D.placed.length >= MIN_PROPS) break; D.place(kind); }
  // every family room gets something soft underfoot: a rug laid along the room where a carpet would not fit
  if (FAMILY.includes(role) && !D.placed.some((p) => flat(p.prop))) {
    const { c, u, v } = D.axis();
    for (const [k, yaw] of [[0, 0], [1.6, 0], [-1.6, 0], [0, Math.PI / 2], [2.6, 0], [-2.6, 0]]) if (D.near('rug', [c[0] + u[0] * k, c[1] + u[1] * k], yawFacing(v) + yaw, 1.2)) break;
  }
  // walkability: take props out, last first, until every door is reachable from every other
  const entries = P.doors.filter((d) => d.spaces.includes(r.id)).map((d) => doorEntry(d, r.id).at).filter((e) => pointInPoly(r.poly, e[0], e[1]));
  const dropped: string[] = [];
  const obstacles = () => D.placed.filter((p) => p.prop.kind.blocksNav && p.prop.kind.placement === 'floor').map((p) => footRect(p));
  while (!walkable(D.poly, obstacles(), entries)) {
    const i = D.placed.map((p) => p.prop.kind.blocksNav && p.prop.kind.placement === 'floor').lastIndexOf(true);
    if (i < 0) break;
    const base = D.placed[i];
    dropped.push(base.prop.kind.name);
    // things standing on it go too
    D.placed = D.placed.filter((p, j) => j !== i && !(p.at[1] > r.y0 + 0.05 && p.prop.kind.placement === 'floor' && Math.hypot(p.at[0] - base.at[0], p.at[2] - base.at[2]) < 1.6));
  }
  return { room: r.id, key: groupKey(r), role, placed: D.placed, keepOut, obstacles: obstacles(), dropped };
}

/** Dress every room of the plan; placed props grouped by interior visibility group. */
export function dressPlan(P: InteriorPlan, deps: DressDeps = {}): Dressing {
  const make = deps.make ?? variantPool();
  const rooms = P.rooms.map((r) => dressRoom(r, P, { ...deps, make }));
  const byGroup = new Map<string, Placed[]>();
  for (const d of rooms) { if (!d.placed.length) continue; if (!byGroup.has(d.key)) byGroup.set(d.key, []); byGroup.get(d.key)!.push(...d.placed); }
  return { rooms, byGroup };
}
