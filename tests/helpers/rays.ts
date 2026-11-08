// Any-hit ray queries over a triangle soup, for the whole-castle checks that cast hundreds of thousands of
// rays (tests/world.test.ts and others). The same answer as three-mesh-bvh's `raycastFirst(ray, side, near,
// far) !== null`: each candidate triangle is tested with three's own Ray.intersectTriangle (culling back
// faces for FrontSide, front faces for BackSide, as three-mesh-bvh does) and kept when the distance from the
// ray's origin to the hit is within [near, far].
// Only the tree is ours: one flat loop with the box tests inline, which v8 coverage slows far less than the
// library's many small calls (4× slower under coverage, against ~1.3× here). Boxes are padded by EPS, so a
// box test never drops a triangle the exact test would hit.
import * as T3 from 'three';

const EPS = 1e-6, LEAF = 8;
type V3 = ArrayLike<number>;

/** A flat position soup (x, y, z per vertex, three vertices per triangle) as triangles for rayIndex. */
export const soupTris = (pos: ArrayLike<number>) => Array.from({ length: Math.floor(pos.length / 9) }, (_, i) => ({
  a: [pos[i * 9], pos[i * 9 + 1], pos[i * 9 + 2]], b: [pos[i * 9 + 3], pos[i * 9 + 4], pos[i * 9 + 5]], c: [pos[i * 9 + 6], pos[i * 9 + 7], pos[i * 9 + 8]],
}));

export function rayIndex(tris: { a: V3; b: V3; c: V3 }[]) {
  const n = tris.length, pos = new Float32Array(n * 9), cen = new Float64Array(n * 3);
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) { pos[i * 9 + k] = t.a[k]; pos[i * 9 + 3 + k] = t.b[k]; pos[i * 9 + 6 + k] = t.c[k]; }
  });
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) cen[i * 3 + k] = (pos[i * 9 + k] + pos[i * 9 + 3 + k] + pos[i * 9 + 6 + k]) / 3;
  const order = new Uint32Array(n).map((_, i) => i);
  // nodes: box (6), then either [first, count] of a leaf (count > 0) or [right child, 0] of an inner node (its left child follows it)
  const box: number[] = [], info: number[] = [];
  const build = (s: number, e: number): void => {
    const me = info.length / 2;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let i = s; i < e; i++) {
      const t = order[i];
      for (let v = 0; v < 3; v++) {
        const x = pos[t * 9 + v * 3], y = pos[t * 9 + v * 3 + 1], z = pos[t * 9 + v * 3 + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      const x = cen[t * 3], y = cen[t * 3 + 1], z = cen[t * 3 + 2];
      if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y; if (z < cz0) cz0 = z; if (z > cz1) cz1 = z;
    }
    box.push(x0 - EPS, y0 - EPS, z0 - EPS, x1 + EPS, y1 + EPS, z1 + EPS);
    info.push(s, e - s);
    if (e - s <= LEAF) return;
    // split at the middle of the centres' box, along its longest side (half each when they all share it)
    const ex = cx1 - cx0, ey = cy1 - cy0, ez = cz1 - cz0, ax = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const mid = ax === 0 ? (cx0 + cx1) / 2 : ax === 1 ? (cy0 + cy1) / 2 : (cz0 + cz1) / 2;
    let m = s;
    for (let i = s; i < e; i++) if (cen[order[i] * 3 + ax] < mid) { const t = order[i]; order[i] = order[m]; order[m] = t; m++; }
    if (m === s || m === e) m = (s + e) >> 1;
    build(s, m);
    info[me * 2] = info.length / 2; info[me * 2 + 1] = 0;
    build(m, e);
  };
  if (n) build(0, n);
  const B = Float64Array.from(box), I = Int32Array.from(info), stack = new Int32Array(1 << 16);
  const a = new T3.Vector3(), b = new T3.Vector3(), c = new T3.Vector3(), hit = new T3.Vector3();
  return {
    /** Does the ray meet a triangle (from `side`: its front, its back or either) at a distance in [near, far]? */
    hits(ray: T3.Ray, near: number, far: number, side: T3.Side = T3.DoubleSide): boolean {
      if (!n) return false;
      const ox = ray.origin.x, oy = ray.origin.y, oz = ray.origin.z, dx = ray.direction.x, dy = ray.direction.y, dz = ray.direction.z;
      const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz, lo = near - EPS, hi = far + EPS;
      let sp = 0;
      stack[sp++] = 0;
      while (sp) {
        const k = stack[--sp], o = k * 6;
        // slab test, an axis the ray runs parallel to holds it only if the origin is between its planes
        let t0 = lo, t1 = hi;
        if (dx === 0) { if (ox < B[o] || ox > B[o + 3]) continue; } else {
          const u = (B[o] - ox) * ix, v = (B[o + 3] - ox) * ix;
          if (u < v) { if (u > t0) t0 = u; if (v < t1) t1 = v; } else { if (v > t0) t0 = v; if (u < t1) t1 = u; }
          if (t0 > t1) continue;
        }
        if (dy === 0) { if (oy < B[o + 1] || oy > B[o + 4]) continue; } else {
          const u = (B[o + 1] - oy) * iy, v = (B[o + 4] - oy) * iy;
          if (u < v) { if (u > t0) t0 = u; if (v < t1) t1 = v; } else { if (v > t0) t0 = v; if (u < t1) t1 = u; }
          if (t0 > t1) continue;
        }
        if (dz === 0) { if (oz < B[o + 2] || oz > B[o + 5]) continue; } else {
          const u = (B[o + 2] - oz) * iz, v = (B[o + 5] - oz) * iz;
          if (u < v) { if (u > t0) t0 = u; if (v < t1) t1 = v; } else { if (v > t0) t0 = v; if (u < t1) t1 = u; }
          if (t0 > t1) continue;
        }
        const first = I[k * 2], count = I[k * 2 + 1];
        if (count === 0) { stack[sp++] = first; stack[sp++] = k + 1; continue; }
        for (let i = first; i < first + count; i++) {
          const p = order[i] * 9;
          a.set(pos[p], pos[p + 1], pos[p + 2]); b.set(pos[p + 3], pos[p + 4], pos[p + 5]); c.set(pos[p + 6], pos[p + 7], pos[p + 8]);
          if ((side === T3.BackSide ? ray.intersectTriangle(c, b, a, true, hit) : ray.intersectTriangle(a, b, c, side !== T3.DoubleSide, hit)) === null) continue;
          const d = ray.origin.distanceTo(hit);
          if (d >= near && d <= far) return true;
        }
      }
      return false;
    },
  };
}
