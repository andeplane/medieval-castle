// Pure geometry for props: no three.js, so generators run in tests and workers. Every primitive
// appends triangles to the bin of its material (one draw call per material per cell, as the castle
// Builder does). UVs are metres / tile so wood grain and weave stay the same size on every piece.
// Each vertex also carries a colour that tints the shared material (oak vs. dark oak, red vs. blue wool).

import type { Flame, FlameKind } from '../light/types';

export type V3 = [number, number, number];
export type RGB = [number, number, number];
/**
 * Material bins. brass: polished metal (brass, gilt, copper, steel, mirror by tint); stone: dressed
 * stone and marble (chimneypieces, plinths); paint: one non-tiling atlas (carpets, runners, canvases),
 * mapped with atlasSheet, never with metres / tile.
 */
export type PropMat = 'wood' | 'iron' | 'cloth' | 'straw' | 'ceramic' | 'wax' | 'flame' | 'brass' | 'stone' | 'paint';
export const PROP_MATS: readonly PropMat[] = ['wood', 'iron', 'cloth', 'straw', 'ceramic', 'wax', 'flame', 'brass', 'stone', 'paint'];
/** Metres per texture tile. Wood grain runs along u. */
export const PROP_TILE: Record<PropMat, number> = { wood: 1, iron: 0.5, cloth: 0.5, straw: 0.5, ceramic: 0.5, wax: 0.25, flame: 0.25, brass: 0.5, stone: 1, paint: 1 };
/** A rectangle of the paint atlas, [u0, v0, u1, v1]. */
export type AtlasRect = [number, number, number, number];
/** Where each design sits in the paint atlas (textures.ts paints it, kit.ts maps sheets onto it). */
export const ATLAS = {
  carpet: [0, 0, 0.5, 0.5] as AtlasRect,          // Turkey carpet: red field, medallion, navy border
  tartan: [0.5, 0, 1, 0.5] as AtlasRect,          // Royal Stuart tartan carpet
  runner: [0, 0.5, 0.125, 1] as AtlasRect,        // corridor runner, u across, v along
  portraits: [0, 1, 2, 3].map((i) => [0.125 + i * 0.1875, 0.5, 0.3125 + i * 0.1875, 0.75] as AtlasRect),
  scenes: [0, 1].map((i) => [0.125 + i * 0.375, 0.75, 0.5 + i * 0.375, 1] as AtlasRect),
  fur: [0.875, 0.5, 1, 1] as AtlasRect,           // pelt: hair streaks along v
};

export const v3 = {
  add: (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a: V3) => Math.hypot(a[0], a[1], a[2]),
  norm: (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};

/** Affine transform as a row-major 3×4 matrix [r00 r01 r02 tx, r10 … ty, r20 … tz]. */
export type Xf = number[];
export const IDENTITY: Xf = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
export function compose(a: Xf, b: Xf): Xf {
  const o: Xf = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0);
    }
  }
  return o;
}
export const translate = (x: number, y: number, z: number): Xf => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
/** Rotation about +y (yaw), right-handed: +x turns toward -z. */
export const rotY = (a: number): Xf => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0]; };
export const rotX = (a: number): Xf => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0]; };
export const rotZ = (a: number): Xf => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0]; };
export const applyP = (m: Xf, p: V3): V3 => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];
/** Direction transform (rotation part only; our transforms have no non-uniform scale). */
export const applyD = (m: Xf, d: V3): V3 => [m[0] * d[0] + m[1] * d[1] + m[2] * d[2], m[4] * d[0] + m[5] * d[1] + m[6] * d[2], m[8] * d[0] + m[9] * d[1] + m[10] * d[2]];

export class PropBin {
  pos: number[] = []; nor: number[] = []; uv: number[] = []; col: number[] = [];
  get triangles() { return this.pos.length / 9; }
}

export interface BoxOpts {
  /** Chamfer on every edge in metres (0 = sharp box, 12 triangles). Worn edges catch the light. */
  bevel?: number;
  /** Axis the wood grain runs along (0 x, 1 y, 2 z). Defaults to the longest axis. */
  grain?: 0 | 1 | 2;
  /** Skip the bottom face (it sits on something and is never seen). */
  noBottom?: boolean;
  /** Hand-made warp: the top face shifts by (dx, dz) and shrinks by taper (fraction). */
  skew?: [number, number]; taper?: number;
}

/** Triangle mesh accumulator with a transform stack. */
export class PropMesh {
  bins: Record<PropMat, PropBin> = Object.fromEntries(PROP_MATS.map((k) => [k, new PropBin()])) as Record<PropMat, PropBin>;
  private stack: Xf[] = [IDENTITY];
  tint: RGB = [1, 1, 1];
  /** Flames drawn by the shared flame renderer (src/light), in this mesh's space. */
  flames: Flame[] = [];

  get xf() { return this.stack[this.stack.length - 1]; }
  /** Run fn with an extra local transform applied on top of the current one. */
  with<T>(m: Xf, fn: () => T): T {
    this.stack.push(compose(this.xf, m));
    try { return fn(); } finally { this.stack.pop(); }
  }
  /** Run fn with a vertex tint. */
  tinted<T>(c: RGB, fn: () => T): T {
    const prev = this.tint; this.tint = c;
    try { return fn(); } finally { this.tint = prev; }
  }
  /** Mark a flame of `kind` rising `height` metres from local `at` (follows the transform stack). */
  addFlame(kind: FlameKind, at: V3, height: number) {
    const m = this.xf, up = v3.norm(applyD(m, [0, 1, 0]));
    this.flames.push({ kind, base: applyP(m, at), height: height * Math.hypot(...applyD(m, [0, 1, 0])), up });
  }
  get triangles() { return PROP_MATS.reduce((s, k) => s + this.bins[k].triangles, 0); }

  /** One triangle in local space with per-vertex normals; winding is made to agree with the normals. */
  tri(mat: PropMat, p: [V3, V3, V3], n: [V3, V3, V3], t: [[number, number], [number, number], [number, number]]) {
    const m = this.xf, b = this.bins[mat];
    const P = p.map((q) => applyP(m, q)) as [V3, V3, V3];
    const N = n.map((q) => v3.norm(applyD(m, q))) as [V3, V3, V3];
    const fn = v3.cross(v3.sub(P[1], P[0]), v3.sub(P[2], P[0]));
    const order = v3.dot(fn, v3.add(v3.add(N[0], N[1]), N[2])) < 0 ? [0, 2, 1] : [0, 1, 2];
    for (const i of order) { b.pos.push(...P[i]); b.nor.push(...N[i]); b.uv.push(...t[i]); b.col.push(...this.tint); }
  }
  /** Flat quad a b c d (any winding) facing n. */
  quad(mat: PropMat, a: V3, b: V3, c: V3, d: V3, n: V3, ua: [number, number], ub: [number, number], uc: [number, number], ud: [number, number]) {
    this.tri(mat, [a, b, c], [n, n, n], [ua, ub, uc]);
    this.tri(mat, [a, c, d], [n, n, n], [ua, uc, ud]);
  }

  /** Box centred at c with full size s, chamfered edges and optional hand-made skew/taper. */
  box(mat: PropMat, c: V3, s: V3, o: BoxOpts = {}) {
    const h: V3 = [s[0] / 2, s[1] / 2, s[2] / 2];
    const b = Math.min(o.bevel ?? 0, h[0] * 0.45, h[1] * 0.45, h[2] * 0.45);
    const grain = o.grain ?? (s[0] >= s[1] && s[0] >= s[2] ? 0 : s[1] >= s[2] ? 1 : 2);
    const T = PROP_TILE[mat];
    const sk = o.skew ?? [0, 0], tp = o.taper ?? 0;
    // warp: y from -h to +h maps the xz offset and taper linearly, so shared vertices stay shared
    const warp = (p: V3): V3 => { const t = (p[1] + h[1]) / (2 * h[1] || 1); const k = 1 - tp * t; return [c[0] + p[0] * k + sk[0] * t, c[1] + p[1], c[2] + p[2] * k + sk[1] * t]; };
    // texture coordinates: project on the face plane, u along the grain where the face contains it
    const uvOf = (p: V3, n: V3): [number, number] => {
      const k = Math.abs(n[0]) > 0.7 ? 0 : Math.abs(n[1]) > 0.7 ? 1 : 2; // dominant normal axis
      const axes = [0, 1, 2].filter((a) => a !== k);
      const ua = axes.includes(grain) ? grain : axes[0], va = axes.find((a) => a !== ua)!;
      return [(p[ua] + c[ua] * 0.37) / T, (p[va] + c[va] * 0.61) / T];
    };
    const emit = (pts: V3[], n: V3) => {
      const W = pts.map(warp);
      for (let i = 1; i < pts.length - 1; i++) this.tri(mat, [W[0], W[i], W[i + 1]], [n, n, n], [uvOf(pts[0], n), uvOf(pts[i], n), uvOf(pts[i + 1], n)]);
    };
    const S = [-1, 1];
    // faces
    for (let k = 0; k < 3; k++) for (const sg of S) {
      if (k === 1 && sg < 0 && o.noBottom) continue;
      const [i, j] = [0, 1, 2].filter((a) => a !== k);
      const n: V3 = [0, 0, 0]; n[k] = sg;
      const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, bb]) => { const p: V3 = [0, 0, 0]; p[k] = sg * h[k]; p[i] = a * (h[i] - b); p[j] = bb * (h[j] - b); return p; });
      emit(pts, n);
    }
    if (b <= 0) return;
    // edge chamfers
    for (let k1 = 0; k1 < 3; k1++) for (let k2 = k1 + 1; k2 < 3; k2++) for (const s1 of S) for (const s2 of S) {
      if (o.noBottom && ((k1 === 1 && s1 < 0) || (k2 === 1 && s2 < 0))) continue;
      const j = 3 - k1 - k2;
      const n: V3 = [0, 0, 0]; n[k1] = s1; n[k2] = s2;
      const pt = (fromK1: boolean, sj: number): V3 => {
        const p: V3 = [0, 0, 0];
        p[k1] = s1 * (fromK1 ? h[k1] : h[k1] - b); p[k2] = s2 * (fromK1 ? h[k2] - b : h[k2]); p[j] = sj * (h[j] - b); return p;
      };
      emit([pt(true, -1), pt(true, 1), pt(false, 1), pt(false, -1)], v3.norm(n));
    }
    // corners
    for (const sx of S) for (const sy of S) for (const sz of S) {
      if (o.noBottom && sy < 0) continue;
      const sg: V3 = [sx, sy, sz];
      const pts = [0, 1, 2].map((k) => { const p: V3 = [0, 0, 0]; for (let a = 0; a < 3; a++) p[a] = sg[a] * (a === k ? h[a] : h[a] - b); return p; });
      emit(pts, v3.norm(sg));
    }
  }

  /**
   * Tube along a path of points with radius per point (smooth normals). Used for legs, posts, poles,
   * logs, rods, chains of rings. u runs along the length (wood grain), v around.
   */
  tube(mat: PropMat, path: V3[], radius: number | number[], seg = 8, caps: [boolean, boolean] = [true, true]) {
    const T = PROP_TILE[mat], R = (i: number) => (Array.isArray(radius) ? radius[i] : radius);
    const n = path.length;
    const frames: { t: V3; a: V3; b: V3 }[] = [];
    for (let i = 0; i < n; i++) {
      const t = v3.norm(v3.sub(path[Math.min(n - 1, i + 1)], path[Math.max(0, i - 1)]));
      const ref: V3 = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const a = v3.norm(v3.cross(t, ref)), bb = v3.cross(a, t);
      frames.push({ t, a, b: bb });
    }
    let along = 0;
    const ring = (i: number) => Array.from({ length: seg + 1 }, (_, k) => {
      const th = (k / seg) * Math.PI * 2, f = frames[i];
      const d = v3.add(v3.mul(f.a, Math.cos(th)), v3.mul(f.b, Math.sin(th)));
      return { p: v3.add(path[i], v3.mul(d, R(i))), n: d, v: (th * Math.max(R(i), 0.02)) / T };
    });
    let prev = ring(0), prevU = 0;
    for (let i = 1; i < n; i++) {
      along += v3.len(v3.sub(path[i], path[i - 1]));
      const cur = ring(i), u = along / T;
      for (let k = 0; k < seg; k++) {
        const A = prev[k], B = prev[k + 1], C = cur[k + 1], D = cur[k];
        this.tri(mat, [A.p, B.p, C.p], [A.n, B.n, C.n], [[prevU, A.v], [prevU, B.v], [u, C.v]]);
        this.tri(mat, [A.p, C.p, D.p], [A.n, C.n, D.n], [[prevU, A.v], [u, C.v], [u, D.v]]);
      }
      prev = cur; prevU = u;
    }
    const cap = (i: number, sign: number) => {
      const r = ring(i), nn = v3.mul(frames[i].t, sign);
      for (let k = 0; k < seg; k++) this.tri(mat, [path[i], r[k].p, r[k + 1].p], [nn, nn, nn], [[0, 0], [r[k].n[0] * R(i) / T, r[k].n[2] * R(i) / T], [r[k + 1].n[0] * R(i) / T, r[k + 1].n[2] * R(i) / T]]);
    };
    if (caps[0]) cap(0, -1);
    if (caps[1]) cap(n - 1, 1);
  }

  /**
   * Surface of revolution about +y from a profile of [radius, y] points, bottom to top. Smooth normals.
   * grainUp: texture u runs up the profile (barrel staves); otherwise u runs around.
   * wobble(theta, y) returns a radius factor, for hand-thrown pots and bulging staves.
   */
  lathe(mat: PropMat, profile: [number, number][], seg = 16, o: { grainUp?: boolean; wobble?: (th: number, y: number) => number; capTop?: boolean; capBottom?: boolean } = {}) {
    const T = PROP_TILE[mat], w = o.wobble ?? (() => 1);
    const m = profile.length;
    // profile normals (outward), from neighbouring segments
    const pn = profile.map((_, i) => {
      const a = profile[Math.max(0, i - 1)], b = profile[Math.min(m - 1, i + 1)];
      const dr = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dr, dy) || 1;
      return [dy / l, -dr / l] as [number, number];
    });
    const arc = [0]; for (let i = 1; i < m; i++) arc.push(arc[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
    const P = (i: number, k: number): V3 => { const th = (k / seg) * Math.PI * 2, r = profile[i][0] * w(th, profile[i][1]); return [Math.cos(th) * r, profile[i][1], Math.sin(th) * r]; };
    const N = (i: number, k: number): V3 => { const th = (k / seg) * Math.PI * 2; return v3.norm([Math.cos(th) * pn[i][0], pn[i][1], Math.sin(th) * pn[i][0]]); };
    const UV = (i: number, k: number): [number, number] => {
      const around = ((k / seg) * Math.PI * 2 * Math.max(profile[i][0], 0.01)) / T, up = arc[i] / T;
      return o.grainUp ? [up, around] : [around, up];
    };
    for (let i = 0; i < m - 1; i++) for (let k = 0; k < seg; k++) {
      if (profile[i][0] < 1e-5 && profile[i + 1][0] < 1e-5) continue;
      this.tri(mat, [P(i, k), P(i, k + 1), P(i + 1, k + 1)], [N(i, k), N(i, k + 1), N(i + 1, k + 1)], [UV(i, k), UV(i, k + 1), UV(i + 1, k + 1)]);
      this.tri(mat, [P(i, k), P(i + 1, k + 1), P(i + 1, k)], [N(i, k), N(i + 1, k + 1), N(i + 1, k)], [UV(i, k), UV(i + 1, k + 1), UV(i + 1, k)]);
    }
    const disc = (i: number, up: boolean) => {
      const y = profile[i][1], n: V3 = [0, up ? 1 : -1, 0];
      for (let k = 0; k < seg; k++) {
        const a = P(i, k), b = P(i, k + 1);
        this.tri(mat, [[0, y, 0], a, b], [n, n, n], [[0, 0], [a[0] / T, a[2] / T], [b[0] / T, b[2] / T]]);
      }
    };
    if (o.capTop) disc(m - 1, true);
    if (o.capBottom) disc(0, false);
  }

  /**
   * Parametric sheet f(s, t) for s, t in [0, 1] (cloth, rugs, tapestries, sacks, straw heaps).
   * Normals by finite differences; size gives metres for UVs. flip reverses the facing.
   */
  sheet(mat: PropMat, f: (s: number, t: number) => V3, nu: number, nv: number, size: [number, number], flip = false) {
    const T = PROP_TILE[mat];
    // finite differences; where the surface is pinched or clamped flat, widen the step, then fall back to up
    const nrm = (s: number, t: number): V3 => {
      for (const e of [1e-3, 2e-2, 1e-1]) {
        const ds = v3.sub(f(Math.min(1, s + e), t), f(Math.max(0, s - e), t));
        const dt = v3.sub(f(s, Math.min(1, t + e)), f(s, Math.max(0, t - e)));
        const c = v3.cross(ds, dt);
        if (v3.len(c) > 1e-12) { const n = v3.norm(c); return flip ? v3.mul(n, -1) : n; }
      }
      return [0, 1, 0];
    };
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const s0 = i / nu, s1 = (i + 1) / nu, t0 = j / nv, t1 = (j + 1) / nv;
      const uv = (s: number, t: number): [number, number] => [(s * size[0]) / T, (t * size[1]) / T];
      this.tri(mat, [f(s0, t0), f(s1, t0), f(s1, t1)], [nrm(s0, t0), nrm(s1, t0), nrm(s1, t1)], [uv(s0, t0), uv(s1, t0), uv(s1, t1)]);
      this.tri(mat, [f(s0, t0), f(s1, t1), f(s0, t1)], [nrm(s0, t0), nrm(s1, t1), nrm(s0, t1)], [uv(s0, t0), uv(s1, t1), uv(s0, t1)]);
    }
  }

  /**
   * Parametric sheet in the paint atlas: (s, t) in [0, 1] maps to the rectangle `rect` of the atlas
   * (s along u, t along v), so a carpet or a canvas shows its whole design once.
   */
  atlasSheet(f: (s: number, t: number) => V3, nu: number, nv: number, rect: AtlasRect, flip = false) {
    const before = this.bins.paint.uv.length;
    this.sheet('paint', f, nu, nv, [1, 1], flip);
    const uv = this.bins.paint.uv;
    for (let i = before; i < uv.length; i += 2) { uv[i] = rect[0] + (rect[2] - rect[0]) * uv[i]; uv[i + 1] = rect[1] + (rect[3] - rect[1]) * uv[i + 1]; }
  }

  /** Append another mesh (already in its own local space) under the current transform. */
  append(other: PropMesh) {
    this.appendFlames(other);
    for (const k of PROP_MATS) {
      const b = other.bins[k];
      for (let i = 0; i < b.pos.length; i += 9) {
        const p = [0, 1, 2].map((v) => [b.pos[i + v * 3], b.pos[i + v * 3 + 1], b.pos[i + v * 3 + 2]] as V3) as [V3, V3, V3];
        const n = [0, 1, 2].map((v) => [b.nor[i + v * 3], b.nor[i + v * 3 + 1], b.nor[i + v * 3 + 2]] as V3) as [V3, V3, V3];
        const j = (i / 9) * 6;
        const t = [0, 1, 2].map((v) => [b.uv[j + v * 2], b.uv[j + v * 2 + 1]] as [number, number]) as [[number, number], [number, number], [number, number]];
        const c = (i / 9) * 9;
        const prev = this.tint;
        this.tint = [b.col[c], b.col[c + 1], b.col[c + 2]];
        this.tri(k, p, n, t);
        this.tint = prev;
      }
    }
  }

  /** Another mesh's flames only, under the current transform (append without the triangles). */
  appendFlames(other: PropMesh) {
    const m = this.xf;
    for (const f of other.flames) this.flames.push({ kind: f.kind, base: applyP(m, f.base), height: f.height, up: v3.norm(applyD(m, f.up ?? [0, 1, 0])) });
  }

  /** Axis-aligned bounds of everything emitted so far (world of this mesh). */
  bounds(): { min: V3; max: V3 } {
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const k of PROP_MATS) {
      const p = this.bins[k].pos;
      for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[i + a]); max[a] = Math.max(max[a], p[i + a]); }
    }
    return { min, max };
  }
}
