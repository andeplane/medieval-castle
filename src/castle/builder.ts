// Geometry bins: every part of the castle appends triangles to the bin of its material, and each bin
// becomes one mesh (one draw call per material, game-performance-optimization). UVs are in metres
// divided by the material's tile size, so stone courses stay level and the same size everywhere.
import * as THREE from 'three/webgpu';
import { ShapeUtils, Vector2 } from 'three/webgpu';
import type { V2 } from '../core/math2d';
import type { StoneFace, Exclusion } from './stones/layout';

export type MatKey = 'old' | 'new' | 'trim' | 'slate' | 'lead' | 'wood' | 'iron' | 'void' | 'glass';
export const TILE: Record<MatKey, number> = { old: 4, new: 4, trim: 2, slate: 2, lead: 4, wood: 2, iron: 1, void: 1, glass: 1 };

type V3 = [number, number, number];
const v3sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const v3cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const v3dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const v3norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

class Bin {
  pos: number[] = []; nor: number[] = []; uv: number[] = [];
  /** Triangle with an intended facing; winding is fixed up to face along n. */
  tri(p0: V3, p1: V3, p2: V3, n: V3 | null, t0: [number, number], t1: [number, number], t2: [number, number]) {
    const fn = v3norm(v3cross(v3sub(p1, p0), v3sub(p2, p0)));
    if (n && v3dot(fn, n) < 0) { [p1, p2] = [p2, p1]; [t1, t2] = [t2, t1]; }
    const nn = n ?? fn;
    this.pos.push(...p0, ...p1, ...p2);
    this.nor.push(...nn, ...nn, ...nn);
    this.uv.push(...t0, ...t1, ...t2);
  }
  /** Triangle with per-vertex normals (smooth surfaces). Winding must already be correct. */
  triN(p: V3[], n: V3[], t: [number, number][]) {
    for (let i = 0; i < 3; i++) { this.pos.push(...p[i]); this.nor.push(...n[i]); this.uv.push(...t[i]); }
  }
}

/** A local frame on a wall: origin, along (horizontal), up, out (normal). */
export interface Frame { o: V3; r: V3; u: V3; n: V3 }
export const at = (f: Frame, s: number, y: number, d = 0): V3 => [f.o[0] + f.r[0] * s + f.u[0] * y + f.n[0] * d, f.o[1] + f.r[1] * s + f.u[1] * y + f.n[1] * d, f.o[2] + f.r[2] * s + f.u[2] * y + f.n[2] * d];

/** Frame for the vertical face from a to b whose outward normal is `out` (2D). y is absolute. */
export function wallFrame(a: V2, b: V2, out: V2): Frame {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return { o: [a[0], 0, a[1]], r: [(b[0] - a[0]) / L, 0, (b[1] - a[1]) / L], u: [0, 1, 0], n: [out[0], 0, out[1]] };
}

export interface Opening { pts: V2[]; depth: number; fill: 'glass' | 'void' | 'wood' | 'none'; reveal: MatKey }
export interface WallRecord { mat: MatKey; a: V2; b: V2; out: V2; y0: number; y1: number; openings: Opening[]; frame: Frame }

/** Is the polygon corner at i convex (turning more than ~30°)? Polygon must be counter-clockwise. */
const convexAt = (p: V2[], i: number) => {
  const n = p.length, a = p[(i + n - 1) % n], b = p[i], c = p[(i + 1) % n];
  const d0: V2 = [b[0] - a[0], b[1] - a[1]], d1: V2 = [c[0] - b[0], c[1] - b[1]];
  return Math.atan2(d0[0] * d1[1] - d0[1] * d1[0], d0[0] * d1[0] + d0[1] * d1[1]) > 0.5;
};

export class Builder {
  bins: Record<MatKey, Bin> = { old: new Bin(), new: new Bin(), trim: new Bin(), slate: new Bin(), lead: new Bin(), wood: new Bin(), iron: new Bin(), void: new Bin(), glass: new Bin() };
  walls: WallRecord[] = [];

  // Stone records (src/castle/stones): every rubble/ashlar wall face, and every solid that stands proud
  // of faces (so stones are not laid under jambs, sills, buttresses, string courses, plinths…).
  stoneFaces: StoneFace[] = [];
  stoneExcl: Exclusion[] = [];
  /** Tag faces made now as silhouette elements (parapets, merlons, buttresses…). */
  stoneSil = false;
  /** Record stone faces at all (off for rubble debris and the like). */
  stoneOn = true;
  /** No stones below this height (buried or under water). */
  stoneFloor = -0.35;
  private owner = -1;
  private owners = 0;
  /** Run fn as one primitive: its faces are never cut by its own exclusion. */
  private own<T>(fn: (id: number) => T): T {
    if (this.owner >= 0) return fn(this.owner);
    this.owner = this.owners++;
    try { return fn(this.owner); } finally { this.owner = -1; }
  }
  /** Record a stone-faced rectangle of a surface drawn some other way (e.g. planar with a sloped top). */
  stoneFace(mat: 'old' | 'new', f: Frame, s0: number, s1: number, y0: number, y1: number, u0 = 0) {
    if (this.stoneOn && s1 - s0 >= 0.4 && y1 - y0 >= 0.3) this.stoneFaces.push({ mat, geom: { kind: 'plane', o: f.o, r: f.r, n: f.n }, s0, s1, y0, y1, u0, holes: [], ends: [false, false], sil: this.stoneSil, owner: this.owner });
  }
  /** A solid (given by its corner points) that stones must not be laid under. */
  exclude(pts: V3[]) { this.stoneExcl.push({ owner: this.owner, pts }); }
  private extrudedPts(poly: V2[], y0: number, y1: number): V3[] { return [...poly.map((q) => [q[0], y0, q[1]] as V3), ...poly.map((q) => [q[0], y1, q[1]] as V3)]; }

  /** Flat polygon given in a frame's (s, y) coords, facing frame.n, at depth d. */
  planar(mat: MatKey, f: Frame, pts: V2[], d = 0, holes: V2[][] = [], u0 = 0) {
    const T = TILE[mat];
    const contour = pts.map((p) => new Vector2(p[0], p[1]));
    const hs = holes.map((h) => h.map((p) => new Vector2(p[0], p[1])));
    const tris = ShapeUtils.triangulateShape(contour, hs);
    const all = [...pts, ...holes.flat()];
    const b = this.bins[mat];
    for (const [i, j, k] of tris) {
      const P = [all[i], all[j], all[k]];
      b.tri(at(f, P[0][0], P[0][1], d), at(f, P[1][0], P[1][1], d), at(f, P[2][0], P[2][1], d), f.n,
        [(P[0][0] + u0) / T, P[0][1] / T], [(P[1][0] + u0) / T, P[1][1] / T], [(P[2][0] + u0) / T, P[2][1] / T]);
    }
  }

  /** Vertical wall face from a to b (2D), y0..y1, outward normal out, with openings cut through it. */
  wall(mat: MatKey, a: V2, b: V2, out: V2, y0: number, y1: number, openings: Opening[] = [], u0 = 0, ends: [boolean, boolean] = [false, false]) {
    const f = wallFrame(a, b, out), L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    this.walls.push({ mat, a, b, out, y0, y1, openings, frame: f });
    this.planar(mat, f, [[0, y0], [L, y0], [L, y1], [0, y1]], 0, openings.map((o) => o.pts), u0);
    for (const o of openings) this.openingInsides(f, o);
    if (this.stoneOn && (mat === 'old' || mat === 'new') && L >= 0.4 && y1 - Math.max(y0, this.stoneFloor) >= 0.3) {
      this.stoneFaces.push({ mat, geom: { kind: 'plane', o: f.o, r: f.r, n: f.n }, s0: 0, s1: L, y0: Math.max(y0, this.stoneFloor), y1, u0, holes: openings.map((o) => o.pts), ends, sil: this.stoneSil, owner: this.owner });
    }
    return f;
  }

  /** Reveals (the sides of the hole) and what sits at the back of it. */
  openingInsides(f: Frame, o: Opening) {
    const pts = o.pts, n = pts.length, T = TILE[o.reveal];
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n], seg = Math.hypot(q[0] - p[0], q[1] - p[1]);
      // normal of the reveal face points into the hole (toward its centre)
      const cx = pts.reduce((s, v) => s + v[0], 0) / n, cy = pts.reduce((s, v) => s + v[1], 0) / n;
      const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
      const nd = v3norm(v3sub(at(f, cx, cy, 0), at(f, mx, my, 0)));
      const A = at(f, p[0], p[1], 0), B = at(f, q[0], q[1], 0), C = at(f, q[0], q[1], -o.depth), D = at(f, p[0], p[1], -o.depth);
      const bin = this.bins[o.reveal];
      bin.tri(A, B, C, nd, [acc / T, 0], [(acc + seg) / T, 0], [(acc + seg) / T, o.depth / T]);
      bin.tri(A, C, D, nd, [acc / T, 0], [(acc + seg) / T, o.depth / T], [acc / T, o.depth / T]);
      acc += seg;
    }
    if (o.fill !== 'none') this.planar(o.fill, f, pts, -o.depth);
  }

  /** Extrude a polygon (x, z) between y0 and y1. Side faces get u along the perimeter. */
  prism(mat: MatKey, poly: V2[], y0: number, y1: number, opts: { top?: MatKey | null; bottom?: boolean; sideMat?: MatKey } = {}) {
    this.own(() => this.prismInner(mat, poly, y0, y1, opts));
  }
  private prismInner(mat: MatKey, poly: V2[], y0: number, y1: number, opts: { top?: MatKey | null; bottom?: boolean; sideMat?: MatKey }) {
    let p = poly;
    let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
    if (s < 0) p = [...p].reverse();
    this.exclude(this.extrudedPts(p, y0, y1));
    let u = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 1e-6) continue;
      const out: V2 = [(b[1] - a[1]) / L, -(b[0] - a[0]) / L];
      this.wall(opts.sideMat ?? mat, a, b, out, y0, y1, [], u, [convexAt(p, i), convexAt(p, (i + 1) % p.length)]);
      u += L;
    }
    const top = opts.top === undefined ? mat : opts.top;
    if (top) this.cap(top, p, y1, true);
    if (opts.bottom) this.cap(mat, p, y0, false);
  }

  /** Horizontal polygon at height y, facing up or down. UVs are world x, z. */
  cap(mat: MatKey, poly: V2[], y: number, up: boolean) {
    const T = TILE[mat], tris = ShapeUtils.triangulateShape(poly.map((q) => new Vector2(q[0], q[1])), []);
    const n: V3 = [0, up ? 1 : -1, 0];
    for (const [i, j, k] of tris) {
      const P = [poly[i], poly[j], poly[k]];
      this.bins[mat].tri([P[0][0], y, P[0][1]], [P[1][0], y, P[1][1]], [P[2][0], y, P[2][1]], n, [P[0][0] / T, P[0][1] / T], [P[1][0] / T, P[1][1] / T], [P[2][0] / T, P[2][1] / T]);
    }
  }

  /** Ring wall between an outer and inner polygon (parapets, machicolation galleries). */
  ringPrism(mat: MatKey, outer: V2[], inner: V2[], y0: number, y1: number, bottom = true) {
    this.own(() => this.ringPrismInner(mat, outer, inner, y0, y1, bottom));
  }
  private ringPrismInner(mat: MatKey, outer: V2[], inner: V2[], y0: number, y1: number, bottom: boolean) {
    this.exclude([...this.extrudedPts(outer, y0, y1), ...this.extrudedPts(inner, y0, y1)]);
    const ccw = (p: V2[]) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s >= 0 ? p : [...p].reverse(); };
    const o = ccw(outer), inn = ccw(inner);
    let u = 0;
    for (let i = 0; i < o.length; i++) {
      const a = o[i], b = o[(i + 1) % o.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      this.wall(mat, a, b, [(b[1] - a[1]) / L, -(b[0] - a[0]) / L], y0, y1, [], u, [convexAt(o, i), convexAt(o, (i + 1) % o.length)]); u += L;
    }
    u = 0;
    for (let i = 0; i < inn.length; i++) {
      const a = inn[i], b = inn[(i + 1) % inn.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      this.wall(mat, b, a, [-(b[1] - a[1]) / L, (b[0] - a[0]) / L], y0, y1, [], u); u += L;
    }
    const T = TILE[mat];
    const tris = ShapeUtils.triangulateShape(o.map((q) => new Vector2(q[0], q[1])), [inn.map((q) => new Vector2(q[0], q[1]))]);
    const all = [...o, ...inn];
    for (const [i, j, k] of tris) {
      const P = [all[i], all[j], all[k]];
      for (const [y, up] of bottom ? [[y1, 1], [y0, -1]] : [[y1, 1]]) {
        this.bins[mat].tri([P[0][0], y, P[0][1]], [P[1][0], y, P[1][1]], [P[2][0], y, P[2][1]], [0, up, 0], [P[0][0] / T, P[0][1] / T], [P[1][0] / T, P[1][1] / T], [P[2][0] / T, P[2][1] / T]);
      }
    }
  }

  /** Frustum between polygon a at y0 and polygon b at y1 (same vertex count), e.g. a battered plinth. */
  loft(mat: MatKey, a: V2[], y0: number, b: V2[], y1: number) {
    this.own(() => this.loftInner(mat, a, y0, b, y1));
  }
  private loftInner(mat: MatKey, a: V2[], y0: number, b: V2[], y1: number) {
    this.exclude([...a.map((q) => [q[0], y0, q[1]] as V3), ...b.map((q) => [q[0], y1, q[1]] as V3)]);
    const T = TILE[mat], n = a.length, bin = this.bins[mat];
    let u = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const A: V3 = [a[i][0], y0, a[i][1]], B: V3 = [a[j][0], y0, a[j][1]], C: V3 = [b[j][0], y1, b[j][1]], D: V3 = [b[i][0], y1, b[i][1]];
      const L = Math.hypot(a[j][0] - a[i][0], a[j][1] - a[i][1]);
      const mid: V2 = [(a[i][0] + a[j][0]) / 2, (a[i][1] + a[j][1]) / 2];
      const cx = a.reduce((s, v) => s + v[0], 0) / n, cz = a.reduce((s, v) => s + v[1], 0) / n;
      const out = v3norm([mid[0] - cx, 0.2, mid[1] - cz]);
      const fn = v3norm(v3cross(v3sub(B, A), v3sub(D, A)));
      const nn: V3 = v3dot(fn, out) < 0 ? [-fn[0], -fn[1], -fn[2]] : fn;
      // u is projected on the bottom edge (not stretched to the shorter top edge), so courses and the
      // real stones on battered plinths line up with the texture
      const r: V2 = [(a[j][0] - a[i][0]) / L, (a[j][1] - a[i][1]) / L];
      const sC = (b[j][0] - a[i][0]) * r[0] + (b[j][1] - a[i][1]) * r[1], sD = (b[i][0] - a[i][0]) * r[0] + (b[i][1] - a[i][1]) * r[1];
      bin.tri(A, B, C, nn, [u / T, y0 / T], [(u + L) / T, y0 / T], [(u + sC) / T, y1 / T]);
      bin.tri(A, C, D, nn, [u / T, y0 / T], [(u + sC) / T, y1 / T], [(u + sD) / T, y1 / T]);
      // stone faces: battered trapezoids (top edge parallel to the bottom edge)
      const sideOk = Math.abs((b[j][0] - b[i][0]) * r[1] - (b[j][1] - b[i][1]) * r[0]) < 1e-3 * Math.max(1, L);
      if (this.stoneOn && (mat === 'old' || mat === 'new') && sideOk && L >= 0.6 && y1 - y0 >= 0.5) {
        let nh: V2 = [r[1], -r[0]];
        if (nh[0] * (mid[0] - cx) + nh[1] * (mid[1] - cz) < 0) nh = [-nh[0], -nh[1]];
        const run = (a[i][0] - b[i][0]) * nh[0] + (a[i][1] - b[i][1]) * nh[1], H = y1 - y0;
        const ns = v3norm([nh[0] * H, run, nh[1] * H]);
        const sMin = Math.min(0, sD), sMax = Math.max(L, sC);
        const yb = Math.max(y0, this.stoneFloor);
        if (y1 - yb >= 0.5) this.stoneFaces.push({
          mat, geom: { kind: 'plane', o: [a[i][0], 0, a[i][1]], r: [r[0], 0, r[1]], n: [nh[0], 0, nh[1]], bat: { y0, H, run, ns } },
          s0: sMin, s1: sMax, y0: yb, y1, u0: u,
          holes: [[[sMin - 1, y0], [0, y0], [sD, y1], [sMin - 1, y1]], [[L, y0], [sMax + 1, y0], [sMax + 1, y1], [sC, y1]]],
          ends: [false, false], sil: this.stoneSil, owner: this.owner,
        });
      }
      u += L;
    }
  }

  /** Oriented box: centre, size (along, up, out), yaw so that `along` = (cos yaw, -sin yaw)... given as a direction. */
  box(mat: MatKey, c: V3, size: V3, dir: V2 = [1, 0], opts: { top?: boolean; bottom?: boolean } = {}) {
    const [sx, sy, sz] = size, d = dir, n: V2 = [d[1], -d[0]];
    const p = (s: number, t: number): V2 => [c[0] + d[0] * s + n[0] * t, c[2] + d[1] * s + n[1] * t];
    const poly: V2[] = [p(-sx / 2, -sz / 2), p(sx / 2, -sz / 2), p(sx / 2, sz / 2), p(-sx / 2, sz / 2)];
    this.prism(mat, poly, c[1] - sy / 2, c[1] + sy / 2, { top: opts.top === false ? null : mat, bottom: opts.bottom });
  }

  /** Cylinder or frustum with smooth normals; u wraps the circumference in metres. */
  cyl(mat: MatKey, cx: number, cz: number, r0: number, r1: number, y0: number, y1: number, seg = 32, opts: { top?: MatKey | null; a0?: number; a1?: number; inward?: boolean } = {}) {
    const T = TILE[mat], bin = this.bins[mat], a0 = opts.a0 ?? 0, a1 = opts.a1 ?? Math.PI * 2;
    const slope = (r0 - r1) / Math.max(1e-6, y1 - y0);
    this.own((id) => {
      if (!opts.inward) this.exclude(Array.from({ length: 32 }, (_, i) => { const t = a0 + ((a1 - a0) * (i >> 1)) / 15, r = i & 1 ? r1 : r0; return [cx + Math.cos(t) * r, i & 1 ? y1 : y0, cz + Math.sin(t) * r] as V3; }));
      if (this.stoneOn && (mat === 'old' || mat === 'new') && !opts.inward && Math.abs(r0 - r1) < 1e-3 && r0 >= 0.8 && y1 - Math.max(y0, this.stoneFloor) >= 0.5) {
        this.stoneFaces.push({ mat, geom: { kind: 'cyl', cx, cz, R: r0 }, s0: a0 * r0, s1: a1 * r0, y0: Math.max(y0, this.stoneFloor), y1, u0: 0, holes: [], ends: [false, false], sil: this.stoneSil, owner: id });
      }
    });
    const rm = (r0 + r1) / 2;
    const sign = opts.inward ? -1 : 1;
    for (let i = 0; i < seg; i++) {
      const t0 = a0 + ((a1 - a0) * i) / seg, t1 = a0 + ((a1 - a0) * (i + 1)) / seg;
      const P = (t: number, r: number, y: number): V3 => [cx + Math.cos(t) * r, y, cz + Math.sin(t) * r];
      const N = (t: number): V3 => v3norm([Math.cos(t) * sign, slope * sign, Math.sin(t) * sign]);
      const u0 = (t0 * rm) / T, u1 = (t1 * rm) / T;
      const A = P(t0, r0, y0), B = P(t1, r0, y0), C = P(t1, r1, y1), D = P(t0, r1, y1);
      const tris: [V3[], V3[], [number, number][]][] = [
        [[A, C, B], [N(t0), N(t1), N(t1)], [[u0, y0 / T], [u1, y1 / T], [u1, y0 / T]]],
        [[A, D, C], [N(t0), N(t0), N(t1)], [[u0, y0 / T], [u0, y1 / T], [u1, y1 / T]]],
      ];
      for (const [p, nn, uv] of tris) {
        if (opts.inward) bin.triN([p[0], p[2], p[1]], [nn[0], nn[2], nn[1]], [uv[0], uv[2], uv[1]]);
        else bin.triN(p, nn, uv);
      }
    }
    if (opts.top !== null && a1 - a0 >= Math.PI * 2 - 1e-6) {
      const poly: V2[] = Array.from({ length: seg }, (_, i) => [cx + Math.cos((i / seg) * Math.PI * 2) * r1, cz + Math.sin((i / seg) * Math.PI * 2) * r1]);
      this.cap(opts.top ?? mat, poly, y1, true);
    }
  }

  /** Cone (roof) with slate UVs running up the slope. */
  cone(mat: MatKey, cx: number, cz: number, r: number, y0: number, h: number, seg = 32, flare = 0) {
    const T = TILE[mat], bin = this.bins[mat], slant = Math.hypot(r, h);
    const rings = flare > 0 ? 6 : 1;
    const R = (k: number) => { const t = k / rings; const lin = r * (1 - t); return lin + flare * r * Math.pow(1 - t, 3) * t * 2.5; };
    const Y = (k: number) => y0 + (h * k) / rings;
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
      for (let k = 0; k < rings; k++) {
        const ra = R(k), rb = R(k + 1), ya = Y(k), yb = Y(k + 1);
        const P = (t: number, rr: number, y: number): V3 => [cx + Math.cos(t) * rr, y, cz + Math.sin(t) * rr];
        const nrm = (t: number): V3 => v3norm([Math.cos(t) * h, r, Math.sin(t) * h]);
        const va = (slant * k) / rings / T, vb = (slant * (k + 1)) / rings / T;
        const ua0 = (t0 * ra) / T, ua1 = (t1 * ra) / T, ub0 = (t0 * Math.max(rb, 0.001)) / T, ub1 = (t1 * Math.max(rb, 0.001)) / T;
        bin.triN([P(t0, ra, ya), P(t1, rb, yb), P(t1, ra, ya)], [nrm(t0), nrm(t1), nrm(t1)], [[ua0, va], [ub1, vb], [ua1, va]]);
        bin.triN([P(t0, ra, ya), P(t0, rb, yb), P(t1, rb, yb)], [nrm(t0), nrm(t0), nrm(t1)], [[ua0, va], [ub0, vb], [ub1, vb]]);
      }
    }
  }

  /** Sloped roof plane through 3–4 points; slate courses run parallel to the eave (p0→p1). */
  roofPlane(mat: MatKey, pts: V3[], upHint: V3 = [0, 1, 0]) {
    const T = TILE[mat], bin = this.bins[mat];
    const e = v3norm(v3sub(pts[1], pts[0]));
    let n = v3norm(v3cross(v3sub(pts[1], pts[0]), v3sub(pts[pts.length - 1], pts[0])));
    if (v3dot(n, upHint) < 0) n = [-n[0], -n[1], -n[2]];
    const up = v3cross(n, e); // along the slope
    const upn = v3dot(up, [0, 1, 0]) < 0 ? ([-up[0], -up[1], -up[2]] as V3) : up;
    const uvOf = (p: V3): [number, number] => { const d = v3sub(p, pts[0]); return [v3dot(d, e) / T, v3dot(d, upn) / T]; };
    for (let i = 1; i < pts.length - 1; i++) bin.tri(pts[0], pts[i], pts[i + 1], n, uvOf(pts[0]), uvOf(pts[i]), uvOf(pts[i + 1]));
  }

  build(materials: Record<MatKey, THREE.Material>) {
    const group = new THREE.Group();
    group.name = 'castle';
    let tris = 0;
    for (const k of Object.keys(this.bins) as MatKey[]) {
      const b = this.bins[k];
      if (!b.pos.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, materials[k]);
      m.name = `castle-${k}`;
      m.castShadow = k !== 'glass' && k !== 'void';
      m.receiveShadow = true;
      group.add(m);
      tris += b.pos.length / 9;
    }
    group.userData.triangles = tris;
    return group;
  }
}

/** Offset a convex-ish polygon outward by d (miter joins). */
export function offsetPoly(poly: V2[], d: number): V2[] {
  let s = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; }
  const sign = s < 0 ? -1 : 1, n = poly.length;
  const lines = poly.map((a, i) => {
    const b = poly[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const out: V2 = [((b[1] - a[1]) / L) * sign, (-(b[0] - a[0]) / L) * sign];
    return { p: [a[0] + out[0] * d, a[1] + out[1] * d] as V2, r: [b[0] - a[0], b[1] - a[1]] as V2 };
  });
  return poly.map((_, i) => {
    const L0 = lines[(i + n - 1) % n], L1 = lines[i];
    const rxs = L0.r[0] * L1.r[1] - L0.r[1] * L1.r[0];
    if (Math.abs(rxs) < 1e-9) return L1.p;
    const t = ((L1.p[0] - L0.p[0]) * L1.r[1] - (L1.p[1] - L0.p[1]) * L1.r[0]) / rxs;
    return [L0.p[0] + L0.r[0] * t, L0.p[1] + L0.r[1] * t] as V2;
  });
}

/** Pointed (two-centred) arch outline: rectangle w × h with a pointed head of height hh. */
export function pointedArch(cx: number, y0: number, w: number, h: number, hh: number, seg = 6): V2[] {
  const pts: V2[] = [[cx - w / 2, y0], [cx + w / 2, y0], [cx + w / 2, y0 + h]];
  // right arc centred on the left springing point's offset, meeting at apex
  const R = (w * w / 4 + hh * hh) / w; // radius so that both arcs meet at (cx, y0 + h + hh)
  const ccx = cx + w / 2 - R;
  const aEnd = Math.atan2(hh, cx - ccx);
  for (let i = 1; i < seg; i++) { const a = (aEnd * i) / seg; pts.push([ccx + Math.cos(a) * R, y0 + h + Math.sin(a) * R]); }
  pts.push([cx, y0 + h + hh]);
  const lcx = cx - w / 2 + R;
  for (let i = seg - 1; i >= 1; i--) { const a = (aEnd * i) / seg; pts.push([lcx - Math.cos(a) * R, y0 + h + Math.sin(a) * R]); }
  pts.push([cx - w / 2, y0 + h]);
  return pts;
}

/** Round (semicircular) arch outline. */
export function roundArch(cx: number, y0: number, w: number, h: number, seg = 10): V2[] {
  const pts: V2[] = [[cx - w / 2, y0], [cx + w / 2, y0], [cx + w / 2, y0 + h]];
  for (let i = 1; i < seg; i++) { const a = (Math.PI * i) / seg; pts.push([cx + Math.cos(a) * w / 2, y0 + h + Math.sin(a) * w / 2]); }
  pts.push([cx - w / 2, y0 + h]);
  return pts;
}

export const rect = (cx: number, y0: number, w: number, h: number): V2[] => [[cx - w / 2, y0], [cx + w / 2, y0], [cx + w / 2, y0 + h], [cx - w / 2, y0 + h]];
