// The whole-castle checks' ray index (tests/helpers/rays.ts) gives the same hit or miss as testing every
// triangle with three's Ray.intersectTriangle, over a soup with the castle's hard cases (flat floors and
// walls on the axes, shared edges and corners, rays aimed at vertices and edges, along the axes, ending just
// short of a face) as well as random triangles; and the same as three-mesh-bvh's raycastFirst, which it
// replaces, for every ray not aimed exactly at an edge on the boundary of a BVH box (three-mesh-bvh can miss
// those: its boxes are not padded).
import { describe, it, expect } from 'vitest';
import * as T3 from 'three';
import { MeshBVH, SAH } from 'three-mesh-bvh';
import { rayIndex } from './helpers/rays';
import { mulberry32 } from '../src/core/rng';

type V3 = [number, number, number];
const r = mulberry32(7), u = (a: number, b: number) => a + (b - a) * r();

function soup(): { a: V3; b: V3; c: V3 }[] {
  const t: { a: V3; b: V3; c: V3 }[] = [];
  // a floor of 1 m quads at y 0 and a wall at x 5, two triangles each, sharing their edges
  for (let i = -5; i < 5; i++) for (let k = -5; k < 5; k++) t.push({ a: [i, 0, k], b: [i + 1, 0, k], c: [i + 1, 0, k + 1] }, { a: [i, 0, k], b: [i + 1, 0, k + 1], c: [i, 0, k + 1] });
  for (let y = 0; y < 4; y++) for (let k = -5; k < 5; k++) t.push({ a: [5, y, k], b: [5, y + 1, k], c: [5, y + 1, k + 1] }, { a: [5, y, k], b: [5, y + 1, k + 1], c: [5, y, k + 1] });
  for (let i = 0; i < 400; i++) { const c: V3 = [u(-6, 6), u(-1, 5), u(-6, 6)]; t.push({ a: c, b: [c[0] + u(-1, 1), c[1] + u(-1, 1), c[2] + u(-1, 1)], c: [c[0] + u(-1, 1), c[1] + u(-1, 1), c[2] + u(-1, 1)] }); }
  // stored as float32, as the castle's bins and both indexes keep them
  return t.map(({ a, b, c }) => ({ a: a.map(Math.fround) as V3, b: b.map(Math.fround) as V3, c: c.map(Math.fround) as V3 }));
}

describe('ray index', () => {
  it('hits what three-mesh-bvh raycastFirst hits, ray for ray', () => {
    const tris = soup(), idx = rayIndex(tris);
    const a = new Float32Array(tris.length * 9);
    tris.forEach((t, i) => { a.set(t.a, i * 9); a.set(t.b, i * 9 + 3); a.set(t.c, i * 9 + 6); });
    const g = new T3.BufferGeometry(); g.setAttribute('position', new T3.BufferAttribute(a, 3));
    const bvh = new MeshBVH(g, { strategy: SAH }), ray = new T3.Ray();
    let n = 0, hits = 0;
    const check = (o: V3, to: V3, near: number, far: number) => {
      const d = new T3.Vector3(to[0] - o[0], to[1] - o[1], to[2] - o[2]);
      if (d.length() < 1e-9) return;
      ray.origin.set(...o); ray.direction.copy(d.normalize());
      const want = tris.some((t) => {
        A.set(...t.a); B.set(...t.b); C.set(...t.c);
        if (!ray.intersectTriangle(A, B, C, false, P)) return false;
        const dd = ray.origin.distanceTo(P);
        return dd >= near && dd <= far;
      });
      expect(idx.hits(ray, near, far), `${o} → ${to} [${near}, ${far}]`).toBe(want);
      if (generic) expect(bvh.raycastFirst(ray, T3.DoubleSide, near, far) !== null, `three-mesh-bvh ${o} → ${to}`).toBe(want);
      n++; if (want) hits++;
    };
    const A = new T3.Vector3(), B = new T3.Vector3(), C = new T3.Vector3(), P = new T3.Vector3();
    let generic = false;
    const verts = tris.flatMap((t) => [t.a, t.b, t.c]);
    for (let i = 0; i < 2000; i++) {
      const o: V3 = [u(-7, 7), u(-0.5, 6), u(-7, 7)];
      const kind = i % 5, v = verts[Math.floor(r() * verts.length)], w = verts[Math.floor(r() * verts.length)];
      const to: V3 = kind === 0 ? v // a vertex
        : kind === 1 ? [(v[0] + w[0]) / 2, (v[1] + w[1]) / 2, (v[2] + w[2]) / 2] // between two vertices (often an edge)
          : kind === 2 ? [Math.round(o[0]), 0, Math.round(o[2])] // a floor corner, straight-ish down
            : kind === 3 ? [o[0] + (i % 2 ? 1 : 0), o[1] - (i % 2 ? 0 : 1), o[2]] // along an axis
              : [u(-7, 7), u(-1, 6), u(-7, 7)];
      const dist = Math.hypot(to[0] - o[0], to[1] - o[1], to[2] - o[2]);
      generic = kind === 4;
      check(o, to, 0, 1e9);
      check(o, to, 0, dist - 0.02); // ends just short of what it aims at
      check(o, to, 0, dist + 1e-7);
      check(o, to, dist * 0.5, dist + 3);
    }
    expect(n).toBeGreaterThan(7_500);
    expect(hits).toBeGreaterThan(n / 4);
    expect(n - hits).toBeGreaterThan(n / 10);
    expect(rayIndex([]).hits(ray, 0, 1e9)).toBe(false);
  });
});
