import { expect } from 'vitest';
import { PROP_MATS, v3, type PropMesh, type V3 } from '../../src/props/geom';

/** Every triangle's winding agrees with its vertex normals and normals are unit length. */
export function checkMesh(m: PropMesh) {
  for (const k of PROP_MATS) {
    const b = m.bins[k];
    expect(b.pos.length % 9).toBe(0);
    expect(b.nor.length).toBe(b.pos.length);
    expect(b.col.length).toBe(b.pos.length);
    expect(b.uv.length).toBe((b.pos.length / 3) * 2);
    for (let i = 0; i < b.pos.length; i += 9) {
      const p = [0, 1, 2].map((j) => b.pos.slice(i + j * 3, i + j * 3 + 3) as V3);
      const n = [0, 1, 2].map((j) => b.nor.slice(i + j * 3, i + j * 3 + 3) as V3);
      for (const q of [...p, ...n]) for (const x of q) expect(Number.isFinite(x)).toBe(true);
      for (const q of n) expect(v3.len(q)).toBeCloseTo(1, 5);
      const fn = v3.cross(v3.sub(p[1], p[0]), v3.sub(p[2], p[0]));
      expect(v3.dot(fn, v3.add(v3.add(n[0], n[1]), n[2]))).toBeGreaterThanOrEqual(-1e-12);
    }
  }
}
