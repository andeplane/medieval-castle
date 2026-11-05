export type V2 = [number, number];

export const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
export const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
export const scale = (a: V2, s: number): V2 => [a[0] * s, a[1] * s];
export const len = (v: V2) => Math.hypot(v[0], v[1]);
export const norm = (v: V2): V2 => { const l = len(v) || 1; return [v[0] / l, v[1] / l]; };
export const lerp2 = (a: V2, b: V2, t: number): V2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
export const cross = (a: V2, b: V2) => a[0] * b[1] - a[1] * b[0];
export const rot = (v: V2, a: number): V2 => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];

/** Line p + r t meets line q + s u. */
export function intersect(p: V2, r: V2, q: V2, s: V2): V2 {
  const rxs = cross(r, s);
  const t = cross(sub(q, p), s) / rxs;
  return [p[0] + r[0] * t, p[1] + r[1] * t];
}

export function polyArea(p: V2[]) {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += cross(p[i], p[(i + 1) % p.length]);
  return Math.abs(s) / 2;
}

/** Signed area; positive = counter-clockwise in (x, z) maths orientation. */
export function signedArea(p: V2[]) {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += cross(p[i], p[(i + 1) % p.length]);
  return s / 2;
}

export function centroid(p: V2[]): V2 {
  let x = 0, z = 0;
  for (const q of p) { x += q[0]; z += q[1]; }
  return [x / p.length, z / p.length];
}

export function pointInPoly(poly: V2[], x: number, z: number) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/** Distance from a point to a closed polygon outline, with the closest point. */
export function edgeDist(poly: V2[], x: number, z: number): { d: number; p: V2 } {
  let best = 1e9, bp: V2 = [x, z];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const abx = b[0] - a[0], abz = b[1] - a[1];
    let t = ((x - a[0]) * abx + (z - a[1]) * abz) / (abx * abx + abz * abz);
    t = Math.max(0, Math.min(1, t));
    const px = a[0] + abx * t, pz = a[1] + abz * t, d = Math.hypot(x - px, z - pz);
    if (d < best) { best = d; bp = [px, pz]; }
  }
  return { d: best, p: bp };
}

/** Interior angle at each vertex in degrees. */
export function cornerAngles(p: V2[]) {
  return p.map((c, i) => {
    const a = p[(i + p.length - 1) % p.length], b = p[(i + 1) % p.length];
    const u = norm(sub(a, c)), v = norm(sub(b, c));
    return (Math.acos(Math.max(-1, Math.min(1, dot(u, v)))) * 180) / Math.PI;
  });
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
