// Furnishing the castle: pure function of the interior plan. Every room gets a role from its kind,
// floor and size (hall, chapel, bedchamber, solar, study, guard room, kitchen, store, cellar …) and a
// recipe places props against its walls, in its middle, on table tops and from the ceiling.
// Rules that keep the castle walkable for the player and future NPCs:
// - a clear zone inside every doorway (door swing + a step), and around stair ends;
// - after placing, a flood fill on a 0.2 m grid (agent radius 0.3 m) must still connect every door;
//   props are taken out again, last first, until it does.
// Tall props and wall hangings go on inner walls only (outer walls have windows).
// The look is a medieval castle lived in around 1800-1900 (castle-plan/furnishing/style-guide.md): family
// rooms are built round a chimneypiece on an inner wall with a seating group facing it, lit by candles in
// brass sconces, lamps and the fire; torches burn only in tunnels, cellars, gate rooms and passages; one
// textile colour per room (the room's tone, passed to the props as their variant seed).
import type { V2 } from '../core/math2d';
import { pointInPoly } from '../core/math2d';
import { mulberry32, hashSeed, range, pick, type Rng } from '../core/rng';
import type { InteriorPlan, RoomSpec, DoorSpec, SpaceId } from '../castle/interior/types';
import { portcullisInPlan, DRUM_R } from '../castle/interior/portcullis';
import { orient, convexOverlap, centroidOf } from '../castle/interior/geom';
import { KIND, makeProp, type Prop } from './kit';
import { yawXZ, type Placed } from './place';

export type Role = 'hall' | 'chapel' | 'bedchamber' | 'solar' | 'study' | 'guard' | 'kitchen' | 'store' | 'cellar' | 'gate' | 'passage' | 'empty';

/** Props come from a small pool of seeded variants per kind, so 1000+ placements build ~200 meshes. */
export const VARIANTS = 6;
export function variantPool(make: (kind: string, seed: number) => Prop = makeProp) {
  const cache = new Map<string, Prop>();
  return (kind: string, seed: number) => {
    const v = seed % VARIANTS, key = `${kind}:${v}`;
    let p = cache.get(key);
    if (!p) { p = make(kind, v); cache.set(key, p); }
    return p;
  };
}

export interface DressDeps {
  /** Prop factory; tests inject a cheap one. */
  make?: (kind: string, seed: number) => Prop;
  seed?: number;
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

export function roleOf(r: RoomSpec, rng: Rng): Role {
  if (r.kind === 'stair' || r.kind === 'wallwalk') return 'empty';
  if (r.kind === 'hall') return 'hall';
  if (r.kind === 'chapel') return 'chapel';
  if (r.kind === 'gate') return 'gate';
  if (r.kind === 'passage') return 'passage';
  if (r.kind === 'undercroft' || r.floor < 0) return 'cellar';
  const a = AREA(r);
  if (a < 7) return pick(rng, ['store', 'empty'] as Role[]);
  if (r.floor === 0) return pick(rng, ['kitchen', 'store', 'guard', 'store'] as Role[]);
  if (r.floor <= 2) return pick(rng, ['guard', 'study', 'bedchamber', 'store'] as Role[]);
  return pick(rng, ['bedchamber', 'bedchamber', 'solar', 'study'] as Role[]);
}

// ------------------------------------------------------------------ placing

export class RoomDresser {
  placed: Placed[] = []; blockers: V2[][] = []; walls: Wall[]; poly: V2[];
  /** Stretches of wall in use, along the wall (s) and up it (y above the floor): doors, tall furniture
   * against it and hangings, so a portrait never hangs behind a bookcase. */
  wallTaken: { w: Wall; s0: number; s1: number; y0: number; y1: number }[] = [];
  /** The room's textile colour (period.ts TONES): every toned prop takes a variant seed ≡ tone (mod 3). */
  tone: number;
  private n = 0;
  private pictures = 0;
  constructor(public r: RoomSpec, public P: InteriorPlan, public keepOut: V2[][], public rng: Rng, private make: (k: string, s: number) => Prop, private seed: number) {
    this.walls = wallsOf(r, P); this.poly = orient(r.poly);
    this.tone = Math.floor(rng() * 3);
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
  /** A prop for this room; toned props take a variant seed in the room's colour. */
  prop(kind: string) {
    const h = hashSeed(`${this.r.id}:${this.n++}`, this.seed);
    // pictures in one room take consecutive variants from a seeded start: never the same canvas twice
    if (kind === 'portrait') return this.make(kind, (hashSeed(`${this.r.id}:pictures`, this.seed) % VARIANTS) + this.pictures++);
    return this.make(kind, TONED.has(kind) ? this.tone + 3 * (h % 0x5555555) : h);
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

  /** Back against a wall. inner: only walls with another room behind (no windows). */
  againstWall(kind: string, o: { inner?: boolean; tries?: number; prefer?: (w: Wall) => number; centre?: boolean; corner?: boolean } = {}): Placed | null {
    const prop = this.prop(kind), b = prop.bounds, cx = (b.min[0] + b.max[0]) / 2, width = b.max[0] - b.min[0];
    let walls = this.walls.filter((w) => w.L >= width + 0.1 && (!o.inner || w.inner));
    walls = o.prefer ? [...walls].sort((a, c) => o.prefer!(c) - o.prefer!(a)) : shuffle(walls, this.rng);
    for (const w of walls) {
      const t: V2 = [(w.b[0] - w.a[0]) / w.L, (w.b[1] - w.a[1]) / w.L], yaw = yawFacing(w.n);
      const steps = Math.max(1, Math.floor((w.L - width) / 0.25));
      const start = Math.floor(this.rng() * steps);
      // centred: from the middle of the wall outwards; corner: from both ends inwards; otherwise from a
      // random point along it
      const order = o.corner ? Array.from({ length: steps + 1 }, (_, k) => (k % 2 ? steps - (k >> 1) : k >> 1)) : o.centre ? Array.from({ length: steps + 1 }, (_, k) => Math.round(steps / 2 + (k % 2 ? 1 : -1) * Math.ceil(k / 2))).filter((k) => k >= 0 && k <= steps) : Array.from({ length: steps + 1 }, (_, k) => (start + k) % (steps + 1));
      for (const k of order) {
        const s = width / 2 + 0.05 + (k / Math.max(1, steps)) * Math.max(0, w.L - width - 0.1);
        const back = 0.04 - b.min[2];
        const at: V2 = [w.a[0] + t[0] * s + w.n[0] * back, w.a[1] + t[1] * s + w.n[1] * back];
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

  /** On the wall at mount height (sconces, tapestries); clear of doors and other hangings. */
  onWall(kind: string, inner = true, o: { fractions?: number[]; walls?: Wall[] } = {}): Placed | null {
    const prop = this.prop(kind), k = KIND[kind], b = prop.bounds, width = b.max[0] - b.min[0];
    // every wall kind has a mount height (kit test); hang lower under a low ceiling
    const mount = Math.min(k.mount!, this.r.y1 - this.r.y0 - 0.12 - b.max[1]);
    if (mount + b.min[1] < 0.5) return null; // too low a ceiling for it
    const y0 = mount + b.min[1] - 0.05, y1 = mount + b.max[1] + 0.05;
    for (const w of shuffle((o.walls ?? this.walls).filter((x) => x.L >= width + 0.4 && (!inner || x.inner)), this.rng)) {
      const t: V2 = [(w.b[0] - w.a[0]) / w.L, (w.b[1] - w.a[1]) / w.L];
      for (const f of o.fractions ?? shuffle([0.5, 0.3, 0.7, 0.2, 0.8], this.rng)) {
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
export const flat = (p: Prop) => p.bounds.max[1] < 0.06;
/** Kinds whose textiles follow the room's tone (their variant seed ≡ tone mod 3). */
export const TONED = new Set(['four-poster', 'armchair', 'sofa', 'footstool', 'round-table', 'carpet', 'pedestal-desk']);
/** Roles where people live: a hearth, candles not torches, carpets, pictures. */
export const FAMILY: readonly Role[] = ['hall', 'solar', 'bedchamber', 'study'];
/** Roles that may burn torches (style guide: tunnels, cellars, gate rooms and passages). */
export const TORCH_ROLES: readonly Role[] = ['passage', 'cellar', 'gate'];

const longest = (w: Wall) => w.L;
/** Clear space round the fireside seats and their lamp table: room to sit down, and they read as separate pieces. */
export const SEAT_GAP = 0.25;
const frontOf = (p: Placed): V2 => [Math.sin(p.yaw), Math.cos(p.yaw)];

/**
 * The hearth first, on the longest inner wall it fits (centred), then what gathers round it: an
 * overmantel mirror or portrait, a garniture on the mantel, a rug or skin before it, armchairs angled
 * to the fire (and a sofa facing it), a side table with a lamp. Returns the hearth, or null.
 */
export function hearthGroup(D: RoomDresser, o: { kind?: string; chairs?: 0 | 1 | 2; sofa?: boolean; lamp?: boolean; stool?: boolean } = {}): Placed | null {
  const h = D.againstWall(o.kind ?? 'chimneypiece', { inner: true, centre: true, prefer: longest });
  if (!h) return null;
  const n = frontOf(h), t: V2 = [n[1], -n[0]], b = h.prop.bounds, front = b.max[2];
  const P = (d: number, s: number): V2 => [h.at[0] + n[0] * d + t[0] * s, h.at[2] + n[1] * d + t[1] * s];
  const fire = P(front - 0.35, 0);
  if (h.prop.meta.above) D.over(D.rng() < 0.6 ? 'overmantel-mirror' : 'portrait', h);
  if (h.prop.meta.mantel) D.onMantel(D.rng() < 0.25 ? 'candelabrum' : 'candlestick', h, [-0.72, 0.72]);
  D.at(D.rng() < 0.5 ? 'skin' : 'rug', P(front + 0.85, 0), h.yaw + Math.PI / 2, 0.15);
  const chairs = o.chairs ?? 2;
  if (chairs) {
    for (const sx of chairs === 2 ? [-1, 1] : [D.rng() < 0.5 ? -1 : 1]) {
      const c = P(front + 1.3, sx * range(D.rng, 0.95, 1.1));
      D.at('armchair', c, yawFacing([fire[0] - c[0], fire[1] - c[1]]), 0.2, SEAT_GAP);
    }
    if (o.sofa) D.at('sofa', P(front + 2.9, 0), h.yaw + Math.PI, 0.3, SEAT_GAP);
    if (o.lamp !== false) { const st = D.at('side-table', P(front + 1.4, (D.rng() < 0.5 ? -1 : 1) * 1.75), h.yaw, 0.2, SEAT_GAP); D.onTop('oil-lamp', st); }
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
  gate: (D) => { D.againstWall('weapon-rack'); D.againstWall('bench'); D.onWall('sconce', false); },
  hall: (D) => {
    const { c, v } = D.axis();
    // the hearth on the long inner wall, suits of armour either side, a carpet and a skin before it
    const hearth = hearthGroup(D, { kind: 'hooded-hearth', chairs: 0 });
    flank(D, hearth, 'armour');
    // high table with the lord's seat against an inner wall
    const throne = D.againstWall('throne', { inner: true, prefer: longest });
    if (throne) {
      const n = frontOf(throne);
      const high = D.near('trestle-table', [throne.at[0] + n[0] * 1.4, throne.at[2] + n[1] * 1.4], throne.yaw, 0.3);
      D.onTop('tableware', high, 0.3, 0); D.onTop('candelabrum', high, -0.6, 0);
    }
    // long tables with benches down the hall; the middle stays open
    const yaw = yawFacing(v);
    for (const off of [-2.2, 2.2]) {
      const t = D.near('trestle-table', [c[0] + v[0] * off, c[1] + v[1] * off], yaw, 0.6);
      if (!t) continue;
      const side = frontOf(t);
      for (const s of [-0.72, 0.72]) D.near('bench', [t.at[0] + side[0] * s, t.at[2] + side[1] * s], t.yaw, 0.15);
      D.onTop('tableware', t, range(D.rng, -0.5, 0.5), 0);
      D.ceiling('chandelier', [t.at[0], t.at[2]]);
    }
    const cup = D.againstWall('cupboard', { inner: true });
    D.onTop('candelabrum', cup, 0, 0.05);
    // the walls carry the clutter: heads in a row, trophies, a tapestry, portraits hung high
    for (const kind of ['stag-head', 'stag-head', 'weapon-trophy', 'tapestry', 'stag-head', 'portrait', 'weapon-trophy', 'portrait']) D.onWall(kind);
    for (let i = 0; i < 4; i++) D.onWall('candle-sconce', false);
  },
  chapel: (D) => {
    // altar against the east-most wall (inward normal points west)
    const east = (w: Wall) => -w.n[0];
    const altar = D.againstWall('altar', { prefer: east }) ?? D.againstWall('lectern', { prefer: east });
    if (altar) {
      const n = frontOf(altar);
      for (let i = 0; i < 4; i++) D.near('bench', [altar.at[0] + n[0] * (2.2 + i * 1.1), altar.at[2] + n[1] * (2.2 + i * 1.1)], altar.yaw, 0.2);
      D.near('lectern', [altar.at[0] + n[0] * 1.5 + n[1] * 1.2, altar.at[2] + n[1] * 1.5 - n[0] * 1.2], altar.yaw + Math.PI, 0.3);
    }
    D.onWall('tapestry'); D.onWall('candle-sconce', false);
  },
  bedchamber: (D) => {
    // the bed's head against an inner wall, towards a corner so the rest of the wall (or the longest
    // inner wall) is left for the hearth; a chest at its foot
    const bed = D.againstWall(D.rng() < 0.7 ? 'four-poster' : 'bed', { inner: true, corner: true }) ?? D.againstWall('bed');
    if (bed) {
      const b = bed.prop.bounds, n = frontOf(bed), t: V2 = [n[1], -n[0]];
      if (D.rng() < 0.5) D.near('chest', [bed.at[0] + n[0] * (b.max[2] + 0.4), bed.at[2] + n[1] * (b.max[2] + 0.4)], bed.yaw + Math.PI / 2, 0.3);
      const sx = D.rng() < 0.5 ? -1 : 1, st = D.at('side-table', [bed.at[0] + t[0] * sx * (b.max[0] + 0.35) + n[0] * (b.min[2] + 0.35), bed.at[2] + t[1] * sx * (b.max[0] + 0.35) + n[1] * (b.min[2] + 0.35)], bed.yaw, 0.1);
      D.onTop('candlestick', st);
      D.at('rug', [bed.at[0] + t[0] * -sx * (b.max[0] + 0.55), bed.at[2] + t[1] * -sx * (b.max[0] + 0.55)], bed.yaw, 0.2);
    }
    const hearth = hearthGroup(D, { chairs: 1, lamp: false, stool: false });
    if (!hearth) D.near('carpet', D.axis().c, D.rng() * 3, 0.6);
    D.againstWall('cupboard', { inner: true });
    D.onWall('portrait'); D.onWall('tapestry');
    D.onWall('candle-sconce', false);
  },
  solar: (D) => {
    // the drawing room: a carpet, the hearth with a sofa and armchairs facing it, a round table under
    // a lamp in the middle, pictures hung in a row, sconces
    const { c, v } = D.axis();
    D.near('carpet', c, yawFacing(v), 0.4);
    hearthGroup(D, { sofa: true });
    const t = D.near('round-table', c, D.rng() * 6, 1.4);
    D.onTop('oil-lamp', t, 0.15, 0.1); D.onTop('book-stack', t, -0.25, -0.1);
    if (t) for (const a of [0.5, 2.6]) { const yaw = t.yaw + a; D.at('hall-chair', [t.at[0] + Math.sin(yaw) * 0.85, t.at[2] + Math.cos(yaw) * 0.85], yaw + Math.PI, 0.15); }
    const cab = D.againstWall('cupboard', { inner: true });
    D.onTop('candelabrum', cab, 0, 0.05);
    for (const kind of ['portrait', 'portrait', 'stag-head']) D.onWall(kind);
    D.onWall('candle-sconce', false);
  },
  study: (D) => {
    // the library: bookcases on the inner walls, the hearth with a leather armchair, a desk in the room
    const h = hearthGroup(D, { chairs: 1, stool: false });
    for (let i = 0; i < 2; i++) D.againstWall('bookcase', { inner: true });
    const { c, v } = D.axis();
    D.near('carpet', c, yawFacing(v), 0.6);
    const desk = D.near('pedestal-desk', [c[0] + v[0] * 0.8, c[1] + v[1] * 0.8], yawFacing(v), 1.0);
    if (desk) {
      const n = frontOf(desk);
      D.at('hall-chair', [desk.at[0] - n[0] * 0.75, desk.at[2] - n[1] * 0.75], desk.yaw, 0.1);
      D.onTop('oil-lamp', desk, -0.5, -0.15); D.onTop('book-stack', desk, 0.4, 0);
    }
    if (!h) D.againstWall('bookcase');
    for (const kind of ['stag-head', 'portrait', 'portrait']) D.onWall(kind);
    D.onWall('candle-sconce', false);
  },
  guard: (D) => {
    // kept old: a deal table and benches, arms racked and in trophies, a suit of armour, an iron ring of candles
    const { c, v } = D.axis();
    const t = D.near('trestle-table', c, yawFacing(v), 1);
    D.onTop('tableware', t, 0, 0); D.onTop('candlestick', t, 0.5, 0);
    if (t) for (const s of [-0.72, 0.72]) { const side = frontOf(t); D.near('bench', [t.at[0] + side[0] * s, t.at[2] + side[1] * s], t.yaw, 0.15); }
    D.againstWall('weapon-rack', { inner: true }); D.againstWall('armour');
    D.againstWall('chest'); D.againstWall('stool');
    if (D.rng() < 0.5) D.againstWall('straw-pallet');
    if (t) D.ceiling('chandelier', [t.at[0], t.at[2]]);
    D.onWall('weapon-trophy'); D.onWall('candle-sconce', false);
  },
  kitchen: (D) => {
    // the open hearth dominates one wall, the cauldron and firewood by it, a big table in the middle
    const h = D.againstWall('hooded-hearth', { inner: true, centre: true, prefer: longest });
    if (h) { const n = frontOf(h), t: V2 = [n[1], -n[0]], f = h.prop.bounds.max[2], hw = h.prop.bounds.max[0]; D.at('cauldron', [h.at[0] + n[0] * (f + 0.5) + t[0] * 0.6, h.at[2] + n[1] * (f + 0.5) + t[1] * 0.6], h.yaw, 0.2); D.at('firewood', [h.at[0] + n[0] * 0.2 + t[0] * (hw + 0.5), h.at[2] + n[1] * 0.2 + t[1] * (hw + 0.5)], h.yaw + Math.PI / 2, 0.2); }
    const { c, v } = D.axis();
    const t = D.near('trestle-table', c, yawFacing(v), 1);
    D.onTop('tableware', t, 0, 0);
    if (!h) D.againstWall('cauldron');
    D.againstWall('shelf', { inner: true }); D.againstWall('cupboard', { inner: true });
    for (let i = 0; i < times(D.rng, 2, 4); i++) D.againstWall('barrel');
    D.againstWall('bucket'); D.againstWall('sack'); D.againstWall('stool');
    D.onWall('stag-head'); D.onWall('candle-sconce', false);
  },
  store: (D) => {
    for (let i = 0; i < times(D.rng, 3, 7); i++) D.againstWall(pick(D.rng, ['barrel', 'barrel', 'crate', 'crate', 'sack', 'sack', 'chest']));
    if (D.rng() < 0.5) D.againstWall('shelf', { inner: true });
    if (D.rng() < 0.4) D.againstWall('firewood');
    if (D.rng() < 0.5) D.onWall('candle-sconce', false);
  },
  cellar: (D) => {
    for (let i = 0; i < times(D.rng, 4, 9); i++) D.againstWall(pick(D.rng, ['barrel', 'barrel', 'barrel', 'crate', 'sack', 'firewood']));
    if (D.rng() < 0.5) D.near('straw-heap', D.axis().c, D.rng() * 6, 1.5);
    D.onWall('sconce', false);
  },
};

/** Dress one room. */
export function dressRoom(r: RoomSpec, P: InteriorPlan, deps: DressDeps = {}): RoomDressing {
  const seed = deps.seed ?? 0, make = deps.make ?? variantPool();
  const rng = mulberry32(hashSeed(`dress:${r.id}`, seed));
  const role = roleOf(r, rng);
  const keepOut = keepOutFor(r, P);
  const D = new RoomDresser(r, P, keepOut, rng, make, seed);
  RECIPES[role](D);
  // every family room gets something soft underfoot: a rug laid along the room where a carpet would not fit
  if (FAMILY.includes(role) && !D.placed.some((p) => flat(p.prop))) { const { c, v } = D.axis(); D.near('rug', c, yawFacing(v), 1.5); }
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
