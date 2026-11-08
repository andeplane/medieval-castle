// The skin rug (period.ts skin): Anders saw an orange blob ("wtf is this"). These guard what makes it read
// as a hide lying on the floor: an outline with a head, legs and tail; every vertex just above the floor
// and the fur rising from a thin edge; fur mapped unstretched; and, over the whole dressed castle, no
// skin lying on or under another floor textile or a hearth (props-dress.test.ts).
import { describe, it, expect } from 'vitest';
import { makeProp } from '../src/props/kit';
import { hideShape, FUR_TILE, HIDE_STEP, type HideKind } from '../src/props/period';
import { ATLAS } from '../src/props/geom';
import { mulberry32 } from '../src/core/rng';
import { flat } from '../src/props/dress';

// Seed 234 is a deer hide with a marching-squares saddle cell (two opposite grid corners inside the outline, the
// other two outside), which the first 16 seeds never produce; it keeps that branch of the mesh builder covered.
const SEEDS = [...Array.from({ length: 16 }, (_, i) => i), 234];

describe('the skin rug', () => {
  it('lies flat on the floor: a thin edge, a little fur, nothing floating or below the floor', () => {
    for (const s of SEEDS) {
      const p = makeProp('skin', s), pos = p.mesh.bins.paint.pos, nor = p.mesh.bins.paint.nor;
      expect(flat(p)).toBe(true); // walked over and laid under furniture like the other textiles
      let lo = Infinity, hi = 0;
      for (let i = 1; i < pos.length; i += 3) { lo = Math.min(lo, pos[i]); hi = Math.max(hi, pos[i]); }
      expect(lo).toBeGreaterThan(0.002); expect(lo).toBeLessThan(0.006);   // the cut edge on the floor, not in it
      expect(hi).toBeGreaterThan(0.01); expect(p.bounds.max[1]).toBeLessThan(0.06); // fur, not a slab
      for (let i = 1; i < nor.length; i += 3) expect(nor[i]).toBeGreaterThan(0.5); // a height field: nothing folds over
      // every triangle faces up (no flipped or folded faces)
      for (let t = 0; t < pos.length; t += 9) {
        const ux = pos[t + 3] - pos[t], uz = pos[t + 5] - pos[t + 2], vx = pos[t + 6] - pos[t], vz = pos[t + 8] - pos[t + 2];
        expect(uz * vx - ux * vz).toBeGreaterThan(0);
      }
    }
  });

  it('has the outline of an animal, not a blob: legs and a head reach out from the body', () => {
    for (const kind of ['bear', 'deer', 'sheep'] as HideKind[]) for (const s of [1, 2, 3]) {
      const L = 1.8, { d, nose } = hideShape(kind, L, mulberry32(s));
      expect(d(0, 0)).toBeLessThan(0);                       // the body
      expect(d(nose[0], nose[1] - 0.04)).toBeLessThan(0);    // the head reaches the nose
      // round a circle of 0.42 L the outline is cut in and out: legs, head and tail with gaps between
      let runs = 0, prev = d(L * 0.42, 0) < 0;
      for (let i = 1; i <= 360; i++) { const a = (i / 360) * Math.PI * 2, inside = d(Math.sin(a) * L * 0.42, Math.cos(a) * L * 0.42) < 0; if (inside && !prev) runs++; prev = inside; }
      expect(runs).toBeGreaterThanOrEqual(kind === 'sheep' ? 4 : 5); // four legs and a head (a sheepskin's flaps may not reach)
    }
    const kinds = new Set(SEEDS.map((s) => makeProp('skin', s).mesh.bins.ceramic.triangles > 0)); // a bear has glass eyes
    expect(kinds.size).toBe(2);
  });

  it('maps the fur unstretched: the same pixels per metre across and along, inside the fur rectangle', () => {
    expect(FUR_TILE[0] / HIDE_STEP % 1).toBeCloseTo(0); expect(FUR_TILE[1] / HIDE_STEP % 1).toBeCloseTo(0);
    const F = ATLAS.fur;
    for (const s of SEEDS) {
      const p = makeProp('skin', s), pos = p.mesh.bins.paint.pos, uv = p.mesh.bins.paint.uv;
      for (let i = 0; i < uv.length; i += 2) {
        expect(uv[i]).toBeGreaterThanOrEqual(F[0]); expect(uv[i]).toBeLessThanOrEqual(F[2]);
        expect(uv[i + 1]).toBeGreaterThanOrEqual(F[1]); expect(uv[i + 1]).toBeLessThanOrEqual(F[3]);
      }
      // per triangle: du/dx and dv/dz in atlas units per metre are equal (the atlas is square), no shear
      for (let t = 0; t < pos.length / 9; t++) {
        const P = (k: number) => [pos[t * 9 + k * 3], pos[t * 9 + k * 3 + 2]], U = (k: number) => [uv[t * 6 + k * 2], uv[t * 6 + k * 2 + 1]];
        const [a, b, c] = [P(0), P(1), P(2)], [ua, ub, uc] = [U(0), U(1), U(2)];
        const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
        if (Math.abs(det) < 1e-7) continue;
        const dudx = ((ub[0] - ua[0]) * (c[1] - a[1]) - (uc[0] - ua[0]) * (b[1] - a[1])) / det;
        const dvdz = ((uc[1] - ua[1]) * (b[0] - a[0]) - (ub[1] - ua[1]) * (c[0] - a[0])) / det;
        const dudz = ((uc[0] - ua[0]) * (b[0] - a[0]) - (ub[0] - ua[0]) * (c[0] - a[0])) / det;
        expect(dudx / dvdz).toBeCloseTo(1, 2); expect(Math.abs(dudz)).toBeLessThan(1e-6);
      }
    }
  });
});
