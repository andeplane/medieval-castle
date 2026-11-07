import { describe, it, expect } from 'vitest';
import { woodTex, ironTex, clothTex, strawTex, ceramicTex, brassTex, stoneTex, paintAtlas, normalFromHeight } from '../src/props/textures';
import { ATLAS } from '../src/props/geom';

const gens = { wood: woodTex, iron: ironTex, cloth: clothTex, straw: strawTex, ceramic: ceramicTex, brass: brassTex, stone: stoneTex };

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
  it('paints the atlas: deterministic, every design where ATLAS says, dark old canvases, red carpets', () => {
    const N = 256, a = paintAtlas(N), b = paintAtlas(N);
    expect(a.albedo).toEqual(b.albedo);
    for (const t of [a.albedo, a.normal, a.rough]) expect(t.length).toBe(N * N * 4);
    // mean colour of a rectangle of the atlas
    const mean = (r: number[]) => {
      const s = [0, 0, 0]; let n = 0;
      for (let y = Math.floor(r[1] * N); y < Math.floor(r[3] * N); y++) for (let x = Math.floor(r[0] * N); x < Math.floor(r[2] * N); x++) { for (let k = 0; k < 3; k++) s[k] += a.albedo[(y * N + x) * 4 + k]; n++; }
      return s.map((v) => v / n);
    };
    const carpet = mean(ATLAS.carpet), tartan = mean(ATLAS.tartan), runner = mean(ATLAS.runner);
    for (const c of [carpet, tartan, runner]) expect(c[0]).toBeGreaterThan(c[2]); // red dominated
    for (const r of [...ATLAS.portraits, ...ATLAS.scenes]) { const c = mean(r); expect(c[0] + c[1] + c[2]).toBeLessThan(carpet[0] + carpet[1] + carpet[2]); expect(c[0]).toBeGreaterThanOrEqual(c[2]); } // varnished: warm and dark
    const fur = mean(ATLAS.fur); expect(fur[0]).toBeGreaterThan(fur[2]);
    // the portraits differ from each other
    expect(mean(ATLAS.portraits[0])).not.toEqual(mean(ATLAS.portraits[1]));
    expect(Math.min(...[...a.rough].filter((_, i) => i % 4 === 0))).toBeLessThan(140); // varnish is glossier than pile
  });
  it('flat height gives straight-up normals', () => {
    const n = normalFromHeight(new Float32Array(16).fill(0.5), 4, 5);
    expect([n[0], n[1], n[2]]).toEqual([127, 127, 255]);
  });
});
