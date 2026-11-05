// Subtract convex volumes from a triangle soup (the exterior Builder bins). The exterior is built from
// overlapping zero-thickness shells, so wing walls run through tower drums, roofs through tower rooms and
// plinths across doorways. Carving every interior space out of it leaves only what is really outside.
// A triangle is split against each volume's planes: the part outside plane 1, then the part inside 1 but
// outside 2, … (all convex); the part inside every plane is dropped. Faces lying on a volume's boundary
// count as outside, so coplanar faces survive.
import type { V2 } from '../../core/math2d';

export type V3 = [number, number, number];
export interface Plane { n: V3; d: number }       // inside: dot(n, p) < d
export interface Volume { planes: Plane[]; min: V3; max: V3 }
export interface TriBin { pos: number[]; nor: number[]; uv: number[] }

const EPS = 1e-3;

/** Vertical prism over a convex polygon (any winding) between y0 and y1. */
export function prismVolume(poly: V2[], y0: number, y1: number): Volume {
  let s = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; }
  const p = s < 0 ? [...poly].reverse() : poly; // positive (CCW in x,z maths): outward = right normal
  const planes: Plane[] = [{ n: [0, 1, 0], d: y1 }, { n: [0, -1, 0], d: -y0 }];
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-9) continue;
    const n: V3 = [(b[1] - a[1]) / L, 0, -(b[0] - a[0]) / L];
    planes.push({ n, d: n[0] * a[0] + n[2] * a[1] });
  }
  const xs = p.map((q) => q[0]), zs = p.map((q) => q[1]);
  return { planes, min: [Math.min(...xs), y0, Math.min(...zs)], max: [Math.max(...xs), y1, Math.max(...zs)] };
}

/**
 * Prism of a convex outline lying in a vertical plane: outline points are (u, y) with u along `along`,
 * extruded along the horizontal normal `n` from depth t0 to t1 (measured from `origin`).
 */
export function extrudeVolume(origin: V2, along: V2, n: V2, outline: V2[], t0: number, t1: number): Volume {
  const P = (u: number, y: number, t: number): V3 => [origin[0] + along[0] * u + n[0] * t, y, origin[1] + along[1] * u + n[1] * t];
  // outline orientation in (u, y): make it CCW so the outward normal is the right normal
  let s = 0; for (let i = 0; i < outline.length; i++) { const a = outline[i], b = outline[(i + 1) % outline.length]; s += a[0] * b[1] - b[0] * a[1]; }
  const o = s < 0 ? [...outline].reverse() : outline;
  const planes: Plane[] = [];
  const n3: V3 = [n[0], 0, n[1]], o3: V3 = [origin[0], 0, origin[1]];
  planes.push({ n: n3, d: dot3(n3, o3) + t1 }, { n: [-n[0], 0, -n[1]], d: -(dot3(n3, o3) + t0) });
  for (let i = 0; i < o.length; i++) {
    const a = o[i], b = o[(i + 1) % o.length], du = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(du, dy);
    if (L < 1e-9) continue;
    const nu = dy / L, ny = -du / L; // right normal in (u, y)
    const nn: V3 = [along[0] * nu, ny, along[1] * nu];
    planes.push({ n: nn, d: dot3(nn, P(a[0], a[1], 0)) });
  }
  const pts: V3[] = [];
  for (const q of o) for (const t of [t0, t1]) pts.push(P(q[0], q[1], t));
  return { planes, min: [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]))) as V3, max: [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k]))) as V3 };
}

const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function polyArea(p: Vert[]) {
  let x = 0, y = 0, z = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[0].p, b = p[i].p, c = p[i + 1].p;
    const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    x += u[1] * v[2] - u[2] * v[1]; y += u[2] * v[0] - u[0] * v[2]; z += u[0] * v[1] - u[1] * v[0];
  }
  return Math.hypot(x, y, z) / 2;
}

interface Vert { p: V3; n: V3; t: [number, number] }
const lerpV = (a: Vert, b: Vert, s: number): Vert => ({
  p: [a.p[0] + (b.p[0] - a.p[0]) * s, a.p[1] + (b.p[1] - a.p[1]) * s, a.p[2] + (b.p[2] - a.p[2]) * s],
  n: [a.n[0] + (b.n[0] - a.n[0]) * s, a.n[1] + (b.n[1] - a.n[1]) * s, a.n[2] + (b.n[2] - a.n[2]) * s],
  t: [a.t[0] + (b.t[0] - a.t[0]) * s, a.t[1] + (b.t[1] - a.t[1]) * s],
});
/** Keep the part of a convex polygon with sign * (dot(n,p) - d) >= 0. */
function clipPoly(poly: Vert[], pl: Plane, sign: 1 | -1): Vert[] {
  const out: Vert[] = [];
  const f = (v: Vert) => sign * (dot3(pl.n, v.p) - (pl.d - EPS));
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) out.push(lerpV(a, b, fa / (fa - fb)));
  }
  return out;
}

/** Remove everything inside the volumes from the bins (in place). Returns triangles removed and added. */
export function carve(bins: TriBin[], volumes: Volume[], cell = 4): { removed: number; added: number } {
  // spatial hash of volume AABBs in x/z
  const grid = new Map<string, number[]>();
  const key = (i: number, k: number) => `${i},${k}`;
  volumes.forEach((v, vi) => {
    for (let i = Math.floor(v.min[0] / cell); i <= Math.floor(v.max[0] / cell); i++)
      for (let k = Math.floor(v.min[2] / cell); k <= Math.floor(v.max[2] / cell); k++) {
        const kk = key(i, k); if (!grid.has(kk)) grid.set(kk, []); grid.get(kk)!.push(vi);
      }
  });
  let removed = 0, added = 0;
  for (const bin of bins) {
    const P = bin.pos, N = bin.nor, T = bin.uv;
    const np: number[] = [], nn: number[] = [], nt: number[] = [];
    const emit = (vs: Vert[]) => { for (const v of vs) { np.push(...v.p); nn.push(...v.n); nt.push(...v.t); } };
    for (let t = 0; t < P.length / 9; t++) {
      const tri: Vert[] = [0, 1, 2].map((j) => ({ p: [P[t * 9 + j * 3], P[t * 9 + j * 3 + 1], P[t * 9 + j * 3 + 2]] as V3, n: [N[t * 9 + j * 3], N[t * 9 + j * 3 + 1], N[t * 9 + j * 3 + 2]] as V3, t: [T[t * 6 + j * 2], T[t * 6 + j * 2 + 1]] as [number, number] }));
      const mn: V3 = [0, 1, 2].map((k) => Math.min(tri[0].p[k], tri[1].p[k], tri[2].p[k])) as V3;
      const mx: V3 = [0, 1, 2].map((k) => Math.max(tri[0].p[k], tri[1].p[k], tri[2].p[k])) as V3;
      const cand = new Set<number>();
      for (let i = Math.floor(mn[0] / cell); i <= Math.floor(mx[0] / cell); i++)
        for (let k = Math.floor(mn[2] / cell); k <= Math.floor(mx[2] / cell); k++)
          for (const vi of grid.get(key(i, k)) ?? []) {
            const v = volumes[vi];
            if (v.min[0] < mx[0] && v.max[0] > mn[0] && v.min[1] < mx[1] && v.max[1] > mn[1] && v.min[2] < mx[2] && v.max[2] > mn[2]) cand.add(vi);
          }
      if (!cand.size) { emit(tri); continue; }
      let pieces: Vert[][] = [tri];
      for (const vi of [...cand].sort((a, b) => a - b)) {
        const next: Vert[][] = [];
        for (const pc of pieces) {
          // only split pieces that really reach inside the volume
          let inside = pc;
          for (const pl of volumes[vi].planes) { inside = clipPoly(inside, pl, -1); if (inside.length < 3) break; }
          if (inside.length < 3 || polyArea(inside) < 1e-6) { next.push(pc); continue; }
          let rest = pc;
          for (const pl of volumes[vi].planes) {
            const out = clipPoly(rest, pl, 1);
            if (out.length >= 3) next.push(out);
            rest = clipPoly(rest, pl, -1);
            if (rest.length < 3) break;
          }
        }
        pieces = next;
        if (!pieces.length) break;
      }
      const changed = !(pieces.length === 1 && pieces[0] === tri);
      // (pieces[0] === tri when no volume reached inside it)
      if (!changed) { emit(tri); continue; }
      removed++;
      for (const pc of pieces) for (let i = 1; i < pc.length - 1; i++) {
        const a = pc[0], b = pc[i], c = pc[i + 1];
        const ab: V3 = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]], ac: V3 = [c.p[0] - a.p[0], c.p[1] - a.p[1], c.p[2] - a.p[2]];
        const cr = Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]);
        if (cr < 1e-7) continue;
        emit([a, b, c]); added++;
      }
    }
    bin.pos = np; bin.nor = nn; bin.uv = nt;
  }
  return { removed, added };
}
