// D.1 stone course data model: every stone-faced wall surface is a list of courses of real stones.
// The layout is the masonry texture's own layout (src/render/texgen.ts masonryLayout), tiled along
// the wall exactly as the wall's UVs tile the texture, so a geometric stone sits on the texture
// stone it replaces and the near/far switch is invisible. Pure: no three.js, no DOM.
// Physics (phase D.2) will read the same records: a stone rests on the stones it overlaps below.
import type { V2 } from '../../core/math2d';
import { hashSeed, type Rng } from '../../core/rng';
import { masonryLayout, masonryWarp, RUBBLE, ASHLAR, type MasonryOpts } from '../../render/texgen';

export type V3 = [number, number, number];
export type StoneMat = 'old' | 'new';

/** A vertical plane through o along r (horizontal) with outward normal n. With `bat`, a battered (sloped)
 *  face: it leans back by `run` metres between y0 and y0 + H, and stones stand out along `ns`. */
export interface FacePlane { kind: 'plane'; o: V3; r: V3; n: V3; bat?: { y0: number; H: number; run: number; ns: V3 } }
export interface FaceCyl { kind: 'cyl'; cx: number; cz: number; R: number }

/** A stone-faced wall surface, recorded by the Builder. s runs along the face, y is absolute height. */
export interface StoneFace {
  mat: StoneMat;
  geom: FacePlane | FaceCyl;
  s0: number; s1: number; y0: number; y1: number;
  u0: number;               // texture offset along s (the wall's u is (s + u0) / tile)
  holes: V2[][];            // openings (s, y): no stone may overlap them
  ends: [boolean, boolean]; // convex corner at s0 / s1: end stones overlap the corner alternately
  sil: boolean;             // silhouette element (parapets, merlons, buttresses…): real stones further out
  owner: number;            // primitive that made the face; its own exclusion never cuts it
}

/** A solid that stands proud of nearby faces (jambs, sills, buttresses, string courses…), as corner points. */
export interface Exclusion { owner: number; pts: V3[] }

/** One stone, in face coordinates. */
export interface Stone {
  face: number;
  a: number; b: number; ya: number; yb: number; // cell (joint centre lines), metres
  course: number;                               // global course index (same y → same index on every face)
  flags: number;                                // see F_*
  id: number; bulge: number; tilt: number;      // from the texture layout
  seed: number;                                 // per-stone random in [0, 1)
}
export const F_CUT_L = 1, F_CUT_R = 2, F_EXT_L = 4, F_EXT_R = 8, F_SIL = 16;

export interface MasonrySpec {
  opts: MasonryOpts; tile: number;
  courses: { y0: number; y1: number; stones: { x0: number; x1: number; split: number; id: number; bulge: number; tilt: number }[] }[];
  joint: number; bevel: number; warp: number;
  warpAt: (u: number, v: number) => [number, number];
  depth: [number, number];  // stone relief proud of the wall plane, metres
  ext: number;              // corner overlap
}

/** Where a face's masonry comes from (injected; the default is the texture's own layout). */
export type SpecFor = (mat: StoneMat) => MasonrySpec;

/** The masonry of a material, from the texture's layout drawn with `rng` (the texture uses the default). */
export function makeMasonrySpec(mat: StoneMat, rng?: Rng): MasonrySpec {
  const o = mat === 'old' ? RUBBLE : ASHLAR;
  const L = masonryLayout(o, rng), px = L.px;
  return {
    opts: o, tile: o.tile, joint: o.joint, bevel: o.bevel, warp: o.warp, warpAt: warpTable(masonryWarp(o)),
    courses: L.courses.map((c, i) => ({
      y0: L.cy[i] / px, y1: L.cy[i + 1] / px,
      stones: c.stones.map((st) => ({ x0: st.x0 / px, x1: st.x1 / px, split: st.split, id: st.id, bulge: st.bulge, tilt: st.tilt })),
    })),
    depth: mat === 'old' ? [0.05, 0.09] : [0.042, 0.065], // ashlar is laid with chamfered, slightly bossed faces
    ext: mat === 'old' ? 0.1 : 0.075,
  };
}

const specs = new Map<StoneMat, MasonrySpec>();
/** The texture's masonry for a material (cached): the default SpecFor. */
export const masonrySpec: SpecFor = (mat) => {
  let s = specs.get(mat);
  if (!s) specs.set(mat, (s = makeMasonrySpec(mat)));
  return s;
};

/** The joint warp sampled once into a 256² table (1.6 cm per cell on a 4 m tile), bilinear lookups. */
function warpTable(fn: (u: number, v: number) => [number, number], N = 256) {
  const t = new Float32Array(N * N * 2);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const w = fn(x / N, y / N); t[(y * N + x) * 2] = w[0]; t[(y * N + x) * 2 + 1] = w[1]; }
  return (u: number, v: number): [number, number] => {
    const fx = (u - Math.floor(u)) * N, fy = (v - Math.floor(v)) * N;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, x1 = (x0 + 1) % N, y1 = (y0 + 1) % N;
    const at = (x: number, y: number, k: number) => t[(y * N + x) * 2 + k];
    const lerp = (k: number) => (at(x0, y0, k) * (1 - tx) + at(x1, y0, k) * tx) * (1 - ty) + (at(x0, y1, k) * (1 - tx) + at(x1, y1, k) * tx) * ty;
    return [lerp(0), lerp(1)];
  };
}

// ---------------------------------------------------------------- face geometry helpers

export function faceToWorld(f: StoneFace, s: number, y: number, d: number): V3 {
  const g = f.geom;
  if (g.kind === 'plane') {
    if (g.bat) {
      const b = g.bat, k = -b.run * ((y - b.y0) / b.H);
      return [g.o[0] + g.r[0] * s + g.n[0] * k + b.ns[0] * d, y + b.ns[1] * d, g.o[2] + g.r[2] * s + g.n[2] * k + b.ns[2] * d];
    }
    return [g.o[0] + g.r[0] * s + g.n[0] * d, y, g.o[2] + g.r[2] * s + g.n[2] * d];
  }
  const a = s / g.R, rr = g.R + d;
  return [g.cx + Math.cos(a) * rr, y, g.cz + Math.sin(a) * rr];
}
export function faceNormal(f: StoneFace, s: number): V3 {
  const g = f.geom;
  if (g.kind === 'plane') return g.bat ? g.bat.ns : g.n;
  const a = s / g.R;
  return [Math.cos(a), 0, Math.sin(a)];
}
/** World point to face coords (s, y, d). Cylinder angles are taken nearest the face's middle. */
export function worldToFace(f: StoneFace, p: V3): V3 {
  const g = f.geom;
  if (g.kind === 'plane') {
    const dx = p[0] - g.o[0], dz = p[2] - g.o[2];
    const back = g.bat ? g.bat.run * ((p[1] - g.bat.y0) / g.bat.H) : 0;
    return [dx * g.r[0] + dz * g.r[2], p[1], dx * g.n[0] + dz * g.n[2] + back];
  }
  const am = (f.s0 + f.s1) / 2 / g.R;
  let a = Math.atan2(p[2] - g.cz, p[0] - g.cx);
  while (a < am - Math.PI) a += Math.PI * 2;
  while (a > am + Math.PI) a -= Math.PI * 2;
  return [a * g.R, p[1], Math.hypot(p[0] - g.cx, p[2] - g.cz) - g.R];
}
export function faceBounds(f: StoneFace, pad = 0.25): [V3, V3] {
  const g = f.geom;
  if (g.kind === 'cyl') return [[g.cx - g.R - pad, f.y0 - pad, g.cz - g.R - pad], [g.cx + g.R + pad, f.y1 + pad, g.cz + g.R + pad]];
  const ps = [f.y0, f.y1].flatMap((y) => [faceToWorld(f, f.s0, y, -pad), faceToWorld(f, f.s1, y, -pad), faceToWorld(f, f.s0, y, pad), faceToWorld(f, f.s1, y, pad)]);
  const lo: V3 = [Infinity, f.y0 - pad, Infinity], hi: V3 = [-Infinity, f.y1 + pad, -Infinity];
  for (const p of ps) { lo[0] = Math.min(lo[0], p[0] - pad); lo[2] = Math.min(lo[2], p[2] - pad); hi[0] = Math.max(hi[0], p[0] + pad); hi[2] = Math.max(hi[2], p[2] + pad); }
  return [lo, hi];
}

/** s-range of the part of polygon `pts` inside the band ya ≤ y ≤ yb, or null. */
export function bandRange(pts: V2[], ya: number, yb: number): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    if (p[1] >= ya && p[1] <= yb) { lo = Math.min(lo, p[0]); hi = Math.max(hi, p[0]); }
    for (const y of [ya, yb]) {
      if ((p[1] - y) * (q[1] - y) < 0) { const x = p[0] + ((y - p[1]) / (q[1] - p[1])) * (q[0] - p[0]); lo = Math.min(lo, x); hi = Math.max(hi, x); }
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

// ---------------------------------------------------------------- exclusions

/** Uniform-grid index of exclusion solids by world AABB. */
export class ExclusionIndex {
  private cells = new Map<string, number[]>();
  private boxes: [V3, V3][] = [];
  constructor(public list: Exclusion[], private cell = 4) {
    list.forEach((e, i) => {
      const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
      for (const p of e.pts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
      this.boxes.push([lo, hi]);
      this.forCells(lo, hi, (key) => { let c = this.cells.get(key); if (!c) this.cells.set(key, (c = [])); c.push(i); });
    });
  }
  private forCells(lo: V3, hi: V3, fn: (k: string) => void) {
    const c = this.cell;
    for (let x = Math.floor(lo[0] / c); x <= Math.floor(hi[0] / c); x++)
      for (let y = Math.floor(lo[1] / c); y <= Math.floor(hi[1] / c); y++)
        for (let z = Math.floor(lo[2] / c); z <= Math.floor(hi[2] / c); z++) fn(`${x},${y},${z}`);
  }
  query(lo: V3, hi: V3): Exclusion[] {
    const seen = new Set<number>(), out: Exclusion[] = [];
    this.forCells(lo, hi, (k) => {
      for (const i of this.cells.get(k) ?? []) {
        if (seen.has(i)) continue; seen.add(i);
        const [a, b] = this.boxes[i];
        if (a[0] > hi[0] || b[0] < lo[0] || a[1] > hi[1] || b[1] < lo[1] || a[2] > hi[2] || b[2] < lo[2]) continue;
        out.push(this.list[i]);
      }
    });
    return out;
  }
}

/** The outlines (convex polygons in face s, y) where solids pass through the face's stone layer
 *  (dLo ≤ d ≤ dHi). Solids are convex, so their part inside the layer is the hull of the corner
 *  points inside it and the points where corner-to-corner segments cross its two planes: a battered
 *  plinth blocks a wedge, not its whole bounding box. */
export function exclusionShapes(f: StoneFace, ex: Exclusion[], dLo = -0.03, dHi = 0.1): V2[][] {
  const out: V2[][] = [];
  for (const e of ex) {
    if (e.owner === f.owner && e.owner >= 0) continue;
    const qs = e.pts.map((p) => worldToFace(f, p));
    let d0 = Infinity, d1 = -Infinity, a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const q of qs) { d0 = Math.min(d0, q[2]); d1 = Math.max(d1, q[2]); a0 = Math.min(a0, q[0]); a1 = Math.max(a1, q[0]); b0 = Math.min(b0, q[1]); b1 = Math.max(b1, q[1]); }
    if (d1 < dLo || d0 > dHi || a1 < f.s0 || a0 > f.s1 || b1 < f.y0 || b0 > f.y1) continue;
    const pts: V2[] = [];
    for (const q of qs) if (q[2] >= dLo && q[2] <= dHi) pts.push([q[0], q[1]]);
    if (d0 < dLo || d1 > dHi) {
      for (let i = 0; i < qs.length; i++) for (let j = i + 1; j < qs.length; j++) {
        const p = qs[i], q = qs[j];
        for (const d of [dLo, dHi]) if ((p[2] - d) * (q[2] - d) < 0) { const t = (d - p[2]) / (q[2] - p[2]); pts.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
      }
    }
    let s0 = Infinity, s1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [s, y] of pts) { s0 = Math.min(s0, s); s1 = Math.max(s1, s); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (s1 < f.s0 || s0 > f.s1 || y1 < f.y0 || y0 > f.y1) continue;
    out.push(hull(pts));
  }
  return out;
}

/** An axis-aligned rectangle as a block outline. */
export const rectShape = (s0: number, s1: number, y0: number, y1: number): V2[] => [[s0, y0], [s1, y0], [s1, y1], [s0, y1]];

/** Convex hull (monotone chain), counter-clockwise. */
export function hull(pts: V2[]): V2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: V2, a: V2, b: V2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: V2[] = [], up: V2[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}

// ---------------------------------------------------------------- the course layout of one face

const MIN_LEN = 0.12, MIN_H = 0.08, HOLE_PAD = 0.02;

/** Default per-stone seed salt. */
export const STONE_SALT = hashSeed('stones');

/** Lay the face's courses and stones. Deterministic: depends only on the masonry spec, the salt,
 *  the face and what blocks it (`blocks`: solids' outlines on the face, see exclusionShapes). */
export function layoutFace(f: StoneFace, faceIndex: number, blocks: V2[][] = [], M: MasonrySpec = masonrySpec(f.mat), salt = STONE_SALT): Stone[] {
  const T = M.tile, out: Stone[] = [];
  const nc = M.courses.length;
  const k0 = Math.floor(f.y0 / T), k1 = Math.floor(f.y1 / T);
  for (let k = k0; k <= k1; k++) {
    for (let c = 0; c < nc; c++) {
      const C = M.courses[c];
      const ya = Math.max(f.y0, k * T + C.y0), yb = Math.min(f.y1, k * T + C.y1);
      if (yb - ya < MIN_H) continue;
      const course = k * nc + c;
      // blocked s-intervals in this band
      const blocked: [number, number][] = [];
      for (const h of f.holes) { const r = bandRange(h, ya, yb); if (r) blocked.push([r[0] - HOLE_PAD, r[1] + HOLE_PAD]); }
      for (const b of blocks) { const r = yb - ya > 0.04 && bandRange(b, ya + 0.02, yb - 0.02); if (r) blocked.push([r[0] - 0.01, r[1] + 0.01]); }
      blocked.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      // stones of the tiled course, in face s, clipped to the face, slivers merged into neighbours
      const S0 = f.s0 + f.u0, S1 = f.s1 + f.u0; // texture coords
      const off = C.stones[0].x0;
      const cells: { a: number; b: number; st: (typeof C.stones)[number]; cutL: boolean; cutR: boolean }[] = [];
      for (let j = Math.floor((S0 - off) / T) - 1; j * T + off < S1; j++) {
        for (const st of C.stones) {
          const a = st.x0 + j * T, b = st.x1 + j * T;
          if (b <= S0 || a >= S1) continue;
          cells.push({ a: Math.max(a, S0) - f.u0, b: Math.min(b, S1) - f.u0, st, cutL: a < S0, cutR: b > S1 });
        }
      }
      if (cells.length > 1 && cells[0].b - cells[0].a < MIN_LEN) { cells[1].a = cells[0].a; cells[1].cutL = true; cells.shift(); }
      const n = cells.length;
      if (n > 1 && cells[n - 1].b - cells[n - 1].a < MIN_LEN) { cells[n - 2].b = cells[n - 1].b; cells[n - 2].cutR = true; cells.pop(); }
      for (const cell of cells) {
        // subtract blocked intervals
        let pieces: [number, number, boolean, boolean][] = [[cell.a, cell.b, cell.cutL, cell.cutR]];
        for (const [h0, h1] of blocked) {
          const next: typeof pieces = [];
          for (const p of pieces) {
            if (h1 <= p[0] || h0 >= p[1]) { next.push(p); continue; }
            if (h0 > p[0]) next.push([p[0], h0, p[2], true]);
            if (h1 < p[1]) next.push([h1, p[1], true, p[3]]);
          }
          pieces = next;
        }
        for (const [a, b, cutL, cutR] of pieces) {
          if (b - a < MIN_LEN) continue;
          const atL = Math.abs(a - f.s0) < 1e-6, atR = Math.abs(b - f.s1) < 1e-6;
          let flags = (cutL ? F_CUT_L : 0) | (cutR ? F_CUT_R : 0);
          if (atL && f.ends[0] && course % 2 !== 0) flags |= F_EXT_L;
          if (atR && f.ends[1] && course % 2 === 0) flags |= F_EXT_R;
          if (f.sil || (atL && f.ends[0]) || (atR && f.ends[1])) flags |= F_SIL;
          const st = cell.st;
          const seed = hash01(Math.round(a * 1000) ^ Math.imul(Math.round(ya * 1000), 0x27d4eb2d) ^ Math.imul(faceIndex + 1, 0x165667b1) ^ salt);
          // rubble: some cells are two smaller stones stacked (the texture's split)
          const m = Math.min(yb, Math.max(ya, k * T + C.y0 + (C.y1 - C.y0) * st.split));
          if (st.split && m - ya >= MIN_H && yb - m >= MIN_H) {
            out.push({ face: faceIndex, a, b, ya, yb: m, course, flags, id: st.id, bulge: st.bulge, tilt: st.tilt, seed });
            out.push({ face: faceIndex, a, b, ya: m, yb, course, flags, id: (st.id * 7.31) % 1, bulge: st.bulge, tilt: -st.tilt, seed: fract(seed * 7.13 + 0.37) });
          } else out.push({ face: faceIndex, a, b, ya, yb, course, flags, id: st.id, bulge: st.bulge, tilt: st.tilt, seed });
        }
      }
    }
  }
  return out;
}

const fract = (x: number) => x - Math.floor(x);
const hash01 = (x: number) => { let h = Math.imul(x ^ (x >>> 16), 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
