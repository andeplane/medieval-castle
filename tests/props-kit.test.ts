import { describe, it, expect } from 'vitest';
import { KIT, KIND, makeProp, footprint } from '../src/props/kit';
import { checkMesh } from './helpers/mesh';

const H = (name: string, seed = 0) => makeProp(name, seed).bounds;

describe('prop kit', () => {
  it('has the families the brief needs, with unique names', () => {
    expect(new Set(KIT.map((k) => k.name)).size).toBe(KIT.length);
    for (const n of ['trestle-table', 'bench', 'chair', 'bed', 'chest', 'barrel', 'candlestick', 'sconce', 'chandelier', 'tapestry']) expect(KIND[n]).toBeDefined();
    expect(() => makeProp('sofa')).toThrow(/unknown/);
  });

  for (const k of KIT) {
    describe(k.name, () => {
      const seeds = [0, 1, 2, 3, 4, 5];
      it('is deterministic per seed and varies between seeds', () => {
        const a = makeProp(k, 3), b = makeProp(k.name, 3), c = makeProp(k, 4);
        expect(a.mesh.bins).toEqual(b.mesh.bins);
        expect(a.mesh.bins).not.toEqual(c.mesh.bins);
      });
      it('stays inside the triangle budget and is well formed', () => {
        for (const s of seeds) { const p = makeProp(k, s); expect(p.mesh.triangles).toBeGreaterThan(40); expect(p.mesh.triangles).toBeLessThan(4500); }
        checkMesh(makeProp(k, 1).mesh);
      });
      it('sits on its mount: floor props on y = 0, wall props in front of the wall, ceiling props below it', () => {
        for (const s of seeds) {
          const b = makeProp(k, s).bounds;
          if (k.placement === 'floor') { expect(b.min[1]).toBeGreaterThan(-0.02); expect(b.min[1]).toBeLessThan(0.03); }
          if (k.placement === 'wall') { expect(b.min[2]).toBeGreaterThan(-0.005); expect(k.mount).toBeGreaterThan(1); }
          if (k.placement === 'ceiling') expect(b.max[1]).toBeLessThan(0.02);
        }
      });
      it('has colliders that cover its footprint', () => {
        const p = makeProp(k, 2);
        expect(p.meta.colliders.length).toBeGreaterThan(0);
        const [x0, z0, x1, z1] = footprint(p);
        const c = p.meta.colliders[0];
        expect(c.centre[0] - c.half[0]).toBeLessThanOrEqual(x0 + 0.05); expect(c.centre[0] + c.half[0]).toBeGreaterThanOrEqual(x1 - 0.05);
        expect(c.centre[2] - c.half[2]).toBeLessThanOrEqual(z0 + 0.05); expect(c.centre[2] + c.half[2]).toBeGreaterThanOrEqual(z1 - 0.05);
      });
    });
  }

  it('has real-world furniture heights', () => {
    for (let s = 0; s < 8; s++) {
      expect(H('trestle-table', s).max[1]).toBeGreaterThan(0.72); expect(H('trestle-table', s).max[1]).toBeLessThan(0.8);
      expect(H('bench', s).max[1]).toBeGreaterThan(0.42); expect(H('bench', s).max[1]).toBeLessThan(0.5);
      expect(H('stool', s).max[1]).toBeLessThan(0.52);
      expect(H('chair', s).max[1]).toBeGreaterThan(0.95);
      expect(H('four-poster', s).max[1]).toBeGreaterThan(2.1);
      const bed = H('bed', s); expect(bed.max[2] - bed.min[2]).toBeGreaterThan(1.85);
    }
  });

  it('lights come only from fixtures, with a warm colour and flicker', () => {
    for (const k of KIT) {
      const e = makeProp(k, 1).meta.emitters;
      if (['candlestick', 'sconce', 'chandelier', 'altar'].includes(k.name)) {
        expect(e.length).toBeGreaterThan(0);
        for (const x of e) { expect(x.colour[0]).toBeGreaterThan(x.colour[2]); expect(x.intensity).toBeGreaterThan(0); expect(x.flicker).toBeGreaterThan(0); }
      } else expect(e).toEqual([]);
    }
    expect(makeProp('chandelier', 1).meta.emitters.length).toBe(1); // one light per ring, not per candle
  });

  it('marks walk-over props as not blocking navigation', () => {
    for (const n of ['rug', 'straw-heap', 'straw-pallet', 'sconce', 'tapestry', 'chandelier']) expect(KIND[n].blocksNav).toBe(false);
    for (const n of ['trestle-table', 'bed', 'chest', 'barrel', 'cupboard']) expect(KIND[n].blocksNav).toBe(true);
  });
});
