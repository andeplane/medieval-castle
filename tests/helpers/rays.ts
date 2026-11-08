// Any-hit ray queries over a triangle soup, for the whole-castle checks that cast hundreds of thousands of
// rays (tests/world.test.ts and others). The same answer as three-mesh-bvh's `raycastFirst(ray, side, near,
// far) !== null`: each candidate triangle is tested with three's own Ray.intersectTriangle (culling back
// faces for FrontSide, front faces for BackSide, as three-mesh-bvh does) and kept when the distance from the
// ray's origin to the hit is within [near, far].
// Only the tree is ours: flat loops with the box tests inline and few branches, which v8 coverage slows far
// less than the library's many small calls. Every box (node and triangle) is padded by EPS, so a box test
// never drops a triangle the exact test would hit (a NaN, from a ray in the plane of a box face, keeps it).
import * as T3 from 'three';

const EPS = 1e-6, LEAF = 8;
type V3 = ArrayLike<number>;

/** A flat position soup (x, y, z per vertex, three vertices per triangle) as triangles for rayIndex. */
export const soupTris = (pos: ArrayLike<number>) => Array.from({ length: Math.floor(pos.length / 9) }, (_, i) => ({
  a: [pos[i * 9], pos[i * 9 + 1], pos[i * 9 + 2]], b: [pos[i * 9 + 3], pos[i * 9 + 4], pos[i * 9 + 5]], c: [pos[i * 9 + 6], pos[i * 9 + 7], pos[i * 9 + 8]],
}));

export function rayIndex(tris: { a: V3; b: V3; c: V3 }[]) {
  const n = tris.length, pos = new Float32Array(n * 9), tb = new Float64Array(n * 6), cen = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const { a, b, c } = tris[i], p = i * 9;
    pos[p] = a[0]; pos[p + 1] = a[1]; pos[p + 2] = a[2]; pos[p + 3] = b[0]; pos[p + 4] = b[1]; pos[p + 5] = b[2]; pos[p + 6] = c[0]; pos[p + 7] = c[1]; pos[p + 8] = c[2];
    for (let k = 0; k < 3; k++) {
      const u = pos[p + k], v = pos[p + 3 + k], w = pos[p + 6 + k];
      tb[i * 6 + k] = Math.min(u, v, w) - EPS; tb[i * 6 + 3 + k] = Math.max(u, v, w) + EPS; cen[i * 3 + k] = (u + v + w) / 3;
    }
  }
  const order = new Uint32Array(n).map((_, i) => i);
  // nodes: box (6), then either [first, count] of a leaf (count > 0) or [right child, 0] of an inner node (its left child follows it)
  const box: number[] = [], info: number[] = [];
  const build = (s: number, e: number): void => {
    const me = info.length / 2;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let i = s; i < e; i++) {
      const t = order[i], o = t * 6, q = t * 3;
      x0 = Math.min(x0, tb[o]); y0 = Math.min(y0, tb[o + 1]); z0 = Math.min(z0, tb[o + 2]);
      x1 = Math.max(x1, tb[o + 3]); y1 = Math.max(y1, tb[o + 4]); z1 = Math.max(z1, tb[o + 5]);
      cx0 = Math.min(cx0, cen[q]); cy0 = Math.min(cy0, cen[q + 1]); cz0 = Math.min(cz0, cen[q + 2]);
      cx1 = Math.max(cx1, cen[q]); cy1 = Math.max(cy1, cen[q + 1]); cz1 = Math.max(cz1, cen[q + 2]);
    }
    box.push(x0, y0, z0, x1, y1, z1);
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
      const ox = ray.origin.x, oy = ray.origin.y, oz = ray.origin.z;
      const ix = 1 / ray.direction.x, iy = 1 / ray.direction.y, iz = 1 / ray.direction.z, lo = near - EPS, hi = far + EPS;
      let sp = 0;
      stack[sp++] = 0;
      while (sp) {
        // the node's box, by slabs, between near and far
        const k = stack[--sp], o = k * 6;
        let u = (B[o] - ox) * ix, v = (B[o + 3] - ox) * ix, t0 = Math.max(lo, Math.min(u, v)), t1 = Math.min(hi, Math.max(u, v));
        u = (B[o + 1] - oy) * iy; v = (B[o + 4] - oy) * iy; t0 = Math.max(t0, Math.min(u, v)); t1 = Math.min(t1, Math.max(u, v));
        u = (B[o + 2] - oz) * iz; v = (B[o + 5] - oz) * iz; t0 = Math.max(t0, Math.min(u, v)); t1 = Math.min(t1, Math.max(u, v));
        if (t0 > t1) continue;
        const first = I[k * 2], count = I[k * 2 + 1];
        if (count === 0) { stack[sp++] = first; stack[sp++] = k + 1; continue; }
        for (let i = first; i < first + count; i++) {
          // each triangle's own box first, the same way
          const t = order[i], q = t * 6;
          u = (tb[q] - ox) * ix; v = (tb[q + 3] - ox) * ix; t0 = Math.max(lo, Math.min(u, v)); t1 = Math.min(hi, Math.max(u, v));
          u = (tb[q + 1] - oy) * iy; v = (tb[q + 4] - oy) * iy; t0 = Math.max(t0, Math.min(u, v)); t1 = Math.min(t1, Math.max(u, v));
          u = (tb[q + 2] - oz) * iz; v = (tb[q + 5] - oz) * iz; t0 = Math.max(t0, Math.min(u, v)); t1 = Math.min(t1, Math.max(u, v));
          if (t0 > t1) continue;
          const p = t * 9;
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
