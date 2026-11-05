import { describe, it, expect } from 'vitest';
import { woodTex, ironTex, clothTex, strawTex, ceramicTex, normalFromHeight } from '../src/props/textures';

const gens = { wood: woodTex, iron: ironTex, cloth: clothTex, straw: strawTex, ceramic: ceramicTex };

describe('prop textures', () => {
  for (const [name, gen] of Object.entries(gens)) {
    it(`${name} is the right size, deterministic and tiles without a seam`, () => {
      const t = gen(64), u = gen(64);
      expect(t.size).toBe(64);
      for (const a of [t.albedo, t.normal, t.rough]) expect(a.length).toBe(64 * 64 * 4);
      expect(t.albedo).toEqual(u.albedo);
      // the jump across the wrap edge is no bigger than typical neighbour differences
      const N = 64, A = t.albedo;
      let seam = 0, inner = 0;
      for (let y = 0; y < N; y++) { seam += Math.abs(A[(y * N + N - 1) * 4] - A[y * N * 4]); inner += Math.abs(A[(y * N + 1) * 4] - A[y * N * 4]); }
      expect(seam).toBeLessThan(inner * 3 + N * 8);
    });
  }
  it('flat height gives straight-up normals', () => {
    const n = normalFromHeight(new Float32Array(16).fill(0.5), 4, 5);
    expect([n[0], n[1], n[2]]).toEqual([127, 127, 255]);
  });
});
