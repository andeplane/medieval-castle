// Furnishing the castle: pure function of the interior plan. Every room gets a role from its kind,
// floor and size (hall, chapel, bedchamber, solar, study, guard room, kitchen, store, cellar …) and a
// recipe places props against its walls, in its middle, on table tops and from the ceiling.
// Rules that keep the castle walkable for the player and future NPCs:
// - a clear zone inside every doorway (door swing + a step), and around stair ends;
// - after placing, a flood fill on a 0.2 m grid (agent radius 0.3 m) must still connect every door;
//   props are taken out again, last first, until it does.
// Tall props and wall hangings go on inner walls only (outer walls have windows).
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

class RoomDresser {
  placed: Placed[] = []; blockers: V2[][] = []; walls: Wall[]; poly: V2[];
  wallTaken: { w: Wall; s0: number; s1: number }[] = [];
  private n = 0;
  constructor(public r: RoomSpec, public P: InteriorPlan, public keepOut: V2[][], public rng: Rng, private make: (k: string, s: number) => Prop, private seed: number) {
    this.walls = wallsOf(r, P); this.poly = orient(r.poly);
    // door openings take their stretch of wall
    for (const d of P.doors.filter((x) => x.spaces.includes(r.id))) {
      for (const w of this.walls) {
        const t: V2 = [(w.b[0] - w.a[0]) / w.L, (w.b[1] - w.a[1]) / w.L];
        const rel: V2 = [d.centre[0] - w.a[0], d.centre[2] - w.a[1]];
        const s = rel[0] * t[0] + rel[1] * t[1], off = Math.abs(rel[0] * w.n[0] + rel[1] * w.n[1]);
        if (off < d.wall / 2 + 0.5 && s > -d.width && s < w.L + d.width) this.wallTaken.push({ w, s0: s - d.width / 2 - 0.3, s1: s + d.width / 2 + 0.3 });
      }
    }
  }
  prop(kind: string) { return this.make(kind, hashSeed(`${this.r.id}:${this.n++}`, this.seed)); }

  /** Can this placed prop go here (inside the room, clear of keep-outs and other blockers)? */
  fits(p: Placed): boolean {
    const f = footRect(p);
    if (!insidePoly(this.poly, f)) return false;
    if (this.keepOut.some((k) => convexOverlap(f, k))) return false;
    return !this.blockers.some((b) => convexOverlap(f, b, -0.01));
  }
  add(p: Placed) { this.placed.push(p); if (p.prop.kind.blocksNav || p.prop.kind.placement === 'floor') this.blockers.push(footRect(p, 0.02)); return p; }

  /** Back against a wall. inner: only walls with another room behind (no windows). */
  againstWall(kind: string, o: { inner?: boolean; tries?: number; prefer?: (w: Wall) => number } = {}): Placed | null {
    const prop = this.prop(kind), b = prop.bounds, cx = (b.min[0] + b.max[0]) / 2, width = b.max[0] - b.min[0];
    let walls = this.walls.filter((w) => w.L >= width + 0.1 && (!o.inner || w.inner));
    walls = o.prefer ? [...walls].sort((a, c) => o.prefer!(c) - o.prefer!(a)) : shuffle(walls, this.rng);
    for (const w of walls) {
      const t: V2 = [(w.b[0] - w.a[0]) / w.L, (w.b[1] - w.a[1]) / w.L], yaw = yawFacing(w.n);
      const steps = Math.max(1, Math.floor((w.L - width) / 0.25));
      const start = Math.floor(this.rng() * steps);
      for (let k = 0; k <= steps; k++) {
        const s = width / 2 + 0.05 + (((start + k) % (steps + 1)) / Math.max(1, steps)) * Math.max(0, w.L - width - 0.1);
        const back = 0.04 - b.min[2];
        const at: V2 = [w.a[0] + t[0] * s + w.n[0] * back, w.a[1] + t[1] * s + w.n[1] * back];
        const [ox, oz] = yawXZ(cx, 0, yaw);
        const p: Placed = { prop, at: [at[0] - ox, this.r.y0, at[1] - oz], yaw };
        if (this.fits(p)) return this.add(p);
      }
    }
    return null;
  }

  /** On the wall at mount height (sconces, tapestries); clear of doors and other hangings. */
  onWall(kind: string, inner = true): Placed | null {
    const prop = this.prop(kind), k = KIND[kind], b = prop.bounds, width = b.max[0] - b.min[0];
    const mount = Math.min(k.mount!, this.r.y1 - this.r.y0 - 0.25); // every wall kind has a mount height (kit test)
    if (this.r.y0 + mount + b.min[1] < this.r.y0 + 0.5) return null; // too low a ceiling for it
    for (const w of shuffle(this.walls.filter((x) => x.L >= width + 0.4 && (!inner || x.inner)), this.rng)) {
      const t: V2 = [(w.b[0] - w.a[0]) / w.L, (w.b[1] - w.a[1]) / w.L];
      for (const f of shuffle([0.5, 0.3, 0.7, 0.2, 0.8], this.rng)) {
        const s = Math.min(w.L - width / 2 - 0.2, Math.max(width / 2 + 0.2, f * w.L));
        if (this.wallTaken.some((x) => x.w === w && x.s0 < s + width / 2 && x.s1 > s - width / 2)) continue;
        this.wallTaken.push({ w, s0: s - width / 2 - 0.3, s1: s + width / 2 + 0.3 });
        return this.add({ prop, at: [w.a[0] + t[0] * s + w.n[0] * 0.02, this.r.y0 + mount, w.a[1] + t[1] * s + w.n[1] * 0.02], yaw: yawFacing(w.n) });
      }
    }
    return null;
  }

  /** Free-standing near a point, any of a few yaws, nudged around until it fits. */
  near(kind: string, c: V2, yaw: number, spread = 1.5): Placed | null {
    const prop = this.prop(kind);
    for (let k = 0; k < 24; k++) {
      const rr = k === 0 ? 0 : spread * Math.sqrt(k / 24), a = this.rng() * Math.PI * 2;
      const p: Placed = { prop, at: [c[0] + Math.cos(a) * rr, this.r.y0, c[1] + Math.sin(a) * rr], yaw: yaw + (k % 2 ? Math.PI : 0) };
      if (this.fits(p)) return this.add(p);
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

const RECIPES: Record<Role, (D: RoomDresser) => void> = {
  empty: () => {},
  passage: (D) => { if (D.r.zone === 'tunnel' || D.walls.some((w) => w.L > 6)) for (let i = 0; i < Math.min(3, Math.floor(D.walls.reduce((s, w) => s + w.L, 0) / 16)); i++) D.onWall('sconce', false); },
  gate: (D) => { D.againstWall('weapon-rack'); D.againstWall('bench'); D.onWall('sconce', false); },
  hall: (D) => {
    const { c, u, v } = D.axis();
    // high table with the lord's seat against an inner wall
    const throne = D.againstWall('throne', { inner: true, prefer: (w) => w.L });
    if (throne) {
      const n: V2 = [Math.sin(throne.yaw), Math.cos(throne.yaw)];
      const high = D.near('trestle-table', [throne.at[0] + n[0] * 1.4, throne.at[2] + n[1] * 1.4], throne.yaw, 0.3);
      D.onTop('tableware', high, 0.3, 0); D.onTop('candlestick', high, -0.6, 0);
    }
    // long tables with benches down the hall
    const yaw = yawFacing(v); // table length along u
    for (const off of [-2.2, 2.2, -4.4, 4.4]) {
      const p: V2 = [c[0] + v[0] * off, c[1] + v[1] * off];
      const t = D.near('trestle-table', p, yaw, 0.6);
      if (!t) continue;
      const side: V2 = [Math.sin(t.yaw), Math.cos(t.yaw)]; // the table's local z: across it
      for (const s of [-0.72, 0.72]) D.near('bench', [t.at[0] + side[0] * s, t.at[2] + side[1] * s], t.yaw, 0.15);
      D.onTop('tableware', t, range(D.rng, -0.5, 0.5), 0);
      D.ceiling('chandelier', [t.at[0], t.at[2]]);
    }
    void u;
    D.onWall('tapestry'); D.onWall('tapestry');
    for (let i = 0; i < 4; i++) D.onWall('sconce', false);
    D.near('rug', c, yaw, 1);
    D.againstWall('cupboard', { inner: true });
  },
  chapel: (D) => {
    // altar against the east-most wall (inward normal points west)
    const east = (w: Wall) => -w.n[0];
    const altar = D.againstWall('altar', { prefer: east }) ?? D.againstWall('lectern', { prefer: east });
    if (altar) {
      const n: V2 = [Math.sin(altar.yaw), Math.cos(altar.yaw)];
      for (let i = 0; i < 4; i++) D.near('bench', [altar.at[0] + n[0] * (2.2 + i * 1.1), altar.at[2] + n[1] * (2.2 + i * 1.1)], altar.yaw, 0.2);
      D.near('lectern', [altar.at[0] + n[0] * 1.5 + n[1] * 1.2, altar.at[2] + n[1] * 1.5 - n[0] * 1.2], altar.yaw + Math.PI, 0.3);
    }
    D.onWall('tapestry'); D.onWall('sconce', false);
  },
  bedchamber: (D) => {
    const bed = D.againstWall(D.rng() < 0.45 ? 'four-poster' : 'bed', { inner: true }) ?? D.againstWall('bed');
    if (bed) { const b = bed.prop.bounds; const n: V2 = [Math.sin(bed.yaw), Math.cos(bed.yaw)]; const chest = D.near('chest', [bed.at[0] + n[0] * (b.max[2] + 0.4), bed.at[2] + n[1] * (b.max[2] + 0.4)], bed.yaw + Math.PI / 2, 0.3); D.onTop('candlestick', chest, 0.25, 0); }
    D.againstWall(D.rng() < 0.5 ? 'cupboard' : 'chest', { inner: true });
    D.againstWall(D.rng() < 0.5 ? 'chair' : 'stool');
    D.near('rug', D.axis().c, D.rng() * 3, 1);
    D.onWall('tapestry'); D.onWall('sconce', false);
  },
  solar: (D) => {
    const { c, v } = D.axis();
    const t = D.near('trestle-table', c, yawFacing(v), 0.8);
    D.onTop('tableware', t, 0.2, 0); D.onTop('candlestick', t, -0.5, 0);
    for (let i = 0; i < 2; i++) D.againstWall('chair');
    D.againstWall('cupboard', { inner: true }); D.againstWall('chest');
    D.near('rug', c, D.rng() * 3, 1);
    D.onWall('tapestry'); D.onWall('sconce', false);
  },
  study: (D) => {
    const s = D.againstWall('shelf', { inner: true }); void s;
    D.againstWall('shelf', { inner: true });
    const { c, v } = D.axis();
    const t = D.near('trestle-table', c, yawFacing(v), 1);
    D.onTop('book-stack', t, 0.4, 0); D.onTop('candlestick', t, -0.3, 0.1);
    D.near('lectern', [c[0] + v[0] * 1.6, c[1] + v[1] * 1.6], D.rng() * 6, 1);
    D.againstWall('chair'); D.againstWall('chest');
    D.onWall('sconce', false);
  },
  guard: (D) => {
    const { c, v } = D.axis();
    const t = D.near('trestle-table', c, yawFacing(v), 1);
    D.onTop('tableware', t, 0, 0);
    if (t) for (const s of [-0.72, 0.72]) { const side: V2 = [Math.sin(t.yaw), Math.cos(t.yaw)]; D.near('bench', [t.at[0] + side[0] * s, t.at[2] + side[1] * s], t.yaw, 0.15); }
    D.againstWall('weapon-rack', { inner: true }); D.againstWall('armour-stand');
    D.againstWall('chest'); D.againstWall('stool');
    if (D.rng() < 0.5) D.againstWall('straw-pallet');
    D.onWall('sconce', false); D.onWall('sconce', false);
  },
  kitchen: (D) => {
    const { c, v } = D.axis();
    const t = D.near('trestle-table', c, yawFacing(v), 1);
    D.onTop('tableware', t, 0, 0);
    D.againstWall('cauldron'); D.againstWall('shelf', { inner: true });
    for (let i = 0; i < times(D.rng, 2, 4); i++) D.againstWall('barrel');
    D.againstWall('firewood'); D.againstWall('bucket'); D.againstWall('sack'); D.againstWall('stool');
    D.onWall('sconce', false);
  },
  store: (D) => {
    for (let i = 0; i < times(D.rng, 3, 7); i++) D.againstWall(pick(D.rng, ['barrel', 'barrel', 'crate', 'crate', 'sack', 'sack', 'chest']));
    if (D.rng() < 0.5) D.againstWall('shelf', { inner: true });
    if (D.rng() < 0.4) D.againstWall('firewood');
    D.onWall('sconce', false);
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
