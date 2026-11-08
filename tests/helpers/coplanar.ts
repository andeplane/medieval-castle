// Finds z-fighting: pairs of triangles that lie on the same plane (within eps) and overlap. Each
// triangle is sampled at a few interior points; a sample that lies within eps of another triangle's
// plane, with parallel normals, and strictly inside it is a fault. Pure, for tests.
import { PROP_MATS, type PropMesh, type PropMat, type V3 } from '../../src/props/geom';

export interface Tri { a: V3; b: V3; c: V3; n: V3; d: number; mat: string }
export interface Fight { i: number; j: number; same: boolean; at: V3; mats: [string, string] }

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function makeTri(a: V3, b: V3, c: V3, mat: string): Tri | null {
  const x = cross(sub(b, a), sub(c, a)), l = Math.hypot(...x);
  if (l < 1e-9) return null; // degenerate (area < 5e-10 m²)
  const n: V3 = [x[0] / l, x[1] / l, x[2] / l];
  return { a, b, c, n, d: dot(n, a), mat };
}

/** Every triangle of a prop mesh (flames left out: they are markers, not drawn). */
export function trisOf(m: PropMesh, skip: PropMat[] = ['flame']): Tri[] {
  const out: Tri[] = [];
  for (const k of PROP_MATS) {
    if (skip.includes(k)) continue;
    const p = m.bins[k].pos;
    for (let i = 0; i < p.length; i += 9) {
      const t = makeTri([p[i], p[i + 1], p[i + 2]], [p[i + 3], p[i + 4], p[i + 5]], [p[i + 6], p[i + 7], p[i + 8]], k);
      if (t) out.push(t);
    }
  }
  return out;
}

/** p strictly inside triangle t (barycentric > margin), after projecting on t's plane. */
function inside(t: Tri, p: V3, margin: number) {
  const v0 = sub(t.b, t.a), v1 = sub(t.c, t.a), v2 = sub(p, t.a);
  const d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1);
  const den = d00 * d11 - d01 * d01;
  const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den, u = 1 - v - w;
  return u > margin && v > margin && w > margin;
}

const SAMPLES: V3[] = [[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]];

/**
 * Pairs of triangles from `A` and `B` (the same list for a prop on its own) that are coplanar within
 * `eps` metres and overlap. `same` is true when they face the same way. One entry per pair.
 */
export function coplanarFights(A: Tri[], B: Tri[] = A, eps = 1e-3, cell = 0.05): Fight[] {
  const self = A === B;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  B.forEach((t, j) => {
    const lo = [0, 1, 2].map((k) => Math.floor((Math.min(t.a[k], t.b[k], t.c[k]) - eps) / cell));
    const hi = [0, 1, 2].map((k) => Math.floor((Math.max(t.a[k], t.b[k], t.c[k]) + eps) / cell));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const s = key(x, y, z); let l = grid.get(s); if (!l) grid.set(s, (l = [])); l.push(j);
    }
  });
  const seen = new Set<string>(), out: Fight[] = [];
  A.forEach((t, i) => {
    for (const [wa, wb, wc] of SAMPLES) {
      const p: V3 = [0, 1, 2].map((k) => t.a[k] * wa + t.b[k] * wb + t.c[k] * wc) as V3;
      for (const j of grid.get(key(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell))) ?? []) {
        if (self && j === i) continue;
        const u = B[j], c = dot(t.n, u.n);
        if (Math.abs(c) < 0.9995 || Math.abs(dot(u.n, p) - u.d) > eps || !inside(u, p, 1e-4)) continue;
        const id = self ? `${Math.min(i, j)}:${Math.max(i, j)}` : `${i}:${j}`;
        if (seen.has(id)) continue;
        seen.add(id); out.push({ i, j, same: c > 0, at: p, mats: [t.mat, u.mat] });
      }
    }
  });
  return out;
}

/** A room shell face as the interior shell builds it: the floor at y0 (facing up), the ceiling at y1
 * (facing down) and each wall on an edge of the clear floor polygon (facing into the room). */
export interface ShellRoom { poly: [number, number][]; y0: number; y1: number }

/**
 * Prop triangles (world space) that lie within `eps` of a shell face of `room`, parallel to it and over
 * it. `same`: the prop face looks the same way as the shell face (both seen from the room: they fight);
 * otherwise it faces into the shell (a back against a wall, a bottom on the floor) and is hidden.
 */
export function shellFights(tris: Tri[], room: ShellRoom, eps = 1e-3): { same: Tri[]; opposite: Tri[] } {
  const p = signed(room.poly) < 0 ? [...room.poly].reverse() : room.poly;
  const same: Tri[] = [], opposite: Tri[] = [];
  const inPoly = (x: number, z: number) => {
    let c = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) if ((p[i][1] > z) !== (p[j][1] > z) && x < ((p[j][0] - p[i][0]) * (z - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
    return c;
  };
  for (const t of tris) {
    let hit = 0; // +1 same, -1 opposite
    for (const [wa, wb, wc] of SAMPLES) {
      const q: V3 = [0, 1, 2].map((k) => t.a[k] * wa + t.b[k] * wb + t.c[k] * wc) as V3;
      if (Math.abs(t.n[1]) > 0.9995 && inPoly(q[0], q[2])) {
        if (Math.abs(q[1] - room.y0) < eps) hit = t.n[1] > 0 ? 1 : -1;
        if (Math.abs(q[1] - room.y1) < eps) hit = t.n[1] < 0 ? 1 : -1;
      }
      for (let i = 0; i < p.length && !hit; i++) {
        const a = p[i], b = p[(i + 1) % p.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < 1e-6) continue;
        const u: [number, number] = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n: [number, number] = [-u[1], u[0]]; // inward
        const c = t.n[0] * n[0] + t.n[2] * n[1], s = (q[0] - a[0]) * u[0] + (q[2] - a[1]) * u[1], d = (q[0] - a[0]) * n[0] + (q[2] - a[1]) * n[1];
        if (Math.abs(c) > 0.9995 && Math.abs(d) < eps && s > 0 && s < L && q[1] > room.y0 && q[1] < room.y1) hit = c > 0 ? 1 : -1;
      }
      if (hit) break;
    }
    if (hit > 0) same.push(t); else if (hit < 0) opposite.push(t);
  }
  return { same, opposite };
}

const signed = (p: [number, number][]) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
