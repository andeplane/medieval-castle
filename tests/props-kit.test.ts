import { describe, it, expect } from 'vitest';
import { KIT, KIND, makeProp, footprint } from '../src/props/kit';
import { checkMesh } from './helpers/mesh';
import { buildShutter } from '../src/props/medieval';
import { PropMesh, ATLAS } from '../src/props/geom';
import { mulberry32 } from '../src/core/rng';

const H = (name: string, seed = 0) => makeProp(name, seed).bounds;
const FIXTURES = ['stone-altar', 'spit-hearth', 'brazier', 'candlestick', 'sconce', 'chandelier', 'altar', 'chimneypiece', 'hooded-hearth', 'candle-sconce', 'oil-lamp', 'candelabrum'];

describe('prop kit', () => {
  it('has the families the brief needs, with unique names', () => {
    expect(new Set(KIT.map((k) => k.name)).size).toBe(KIT.length);
    for (const n of ['trestle-table', 'bench', 'chair', 'bed', 'chest', 'barrel', 'candlestick', 'sconce', 'chandelier', 'tapestry']) expect(KIND[n]).toBeDefined();
    expect(() => makeProp('spaceship')).toThrow(/unknown/);
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

  it('lights and flames come only from fixtures, with a kind, a warm-or-white tint and flicker', () => {
    for (const k of KIT) {
      const p = makeProp(k, 1), e = p.meta.emitters;
      if (FIXTURES.includes(k.name)) {
        expect(e.length).toBeGreaterThan(0);
        expect(p.mesh.flames.length).toBeGreaterThan(0);
        for (const x of e) { expect(x.colour[0]).toBeGreaterThanOrEqual(x.colour[2]); expect(x.intensity).toBeGreaterThan(0); expect(x.flicker).toBeGreaterThan(0); expect(['candle', 'torch', 'lantern', 'hearth', 'brazier']).toContain(x.kind); }
        expect(p.mesh.bins.flame.triangles).toBe(0); // flames are sprites now (src/light)
      } else { expect(e).toEqual([]); expect(p.mesh.flames).toEqual([]); }
    }
    expect(makeProp('sconce', 1).meta.emitters[0].kind).toBe('torch');
    const ch = makeProp('chandelier', 1);
    expect(ch.mesh.flames.length).toBeGreaterThanOrEqual(6); // every candle has a flame
    for (const f of ch.mesh.flames) { expect(f.kind).toBe('candle'); expect(f.up![1]).toBeCloseTo(1); }
    expect(makeProp('chandelier', 1).meta.emitters.length).toBe(1); // one light per ring, not per candle
  });

  it('marks walk-over props as not blocking navigation', () => {
    for (const n of ['rug', 'straw-heap', 'straw-pallet', 'sconce', 'tapestry', 'chandelier']) expect(KIND[n].blocksNav).toBe(false);
    for (const n of ['trestle-table', 'bed', 'chest', 'barrel', 'cupboard']) expect(KIND[n].blocksNav).toBe(true);
  });
});

describe('19th-century pieces', () => {
  const clothMean = (name: string, v: number) => {
    const c = makeProp(name, v).mesh.bins.cloth.col, s = [0, 0, 0];
    for (let i = 0; i < c.length; i += 3) for (let k = 0; k < 3; k++) s[k] += c[i + k];
    return s.map((x) => x / (c.length / 3));
  };
  it('chimneypieces carry a mantel, a point to hang a mirror over, a hearth light and flames', () => {
    for (let v = 0; v < 6; v++) {
      const p = makeProp('chimneypiece', v), m = p.meta.mantel!, a = p.meta.above!;
      expect(m.y).toBeGreaterThan(1.25); expect(m.y).toBeLessThan(1.5); expect(m.w).toBeGreaterThan(1.8);
      expect(a[1]).toBeGreaterThan(m.y); expect(a[2]).toBeLessThan(m.z); // above the shelf, on the breast behind it
      expect(p.meta.emitters[0].kind).toBe('hearth');
      expect(p.mesh.flames.filter((f) => f.kind === 'hearth').length).toBe(3);
      expect(p.bounds.max[1]).toBeLessThan(3.1);
      expect(p.mesh.bins.wax.col.some((c) => c > 1)).toBe(true); // a glowing ember bed
    }
    expect(makeProp('hooded-hearth', 1).meta.emitters[0].intensity).toBeGreaterThan(makeProp('chimneypiece', 1).meta.emitters[0].intensity);
  });
  it('takes the textile colour from the variant seed: v % 3 is crimson, green, leather or blue', () => {
    for (const name of ['armchair', 'sofa', 'footstool']) {
      const [a, b, c] = [0, 1, 2].map((v) => clothMean(name, v));
      expect(a[0]).toBeGreaterThan(a[1] * 2); expect(b[1]).toBeGreaterThan(b[0]); expect(c[0]).toBeGreaterThan(c[2]);
      const a2 = clothMean(name, 3); expect(a2[0]).toBeGreaterThan(a2[1] * 2); // same tone, another variant
    }
    const blue = makeProp('four-poster', 2).mesh.bins.cloth.col;
    expect(blue.filter((_, i) => i % 3 === 2).some((x, i) => x > blue[i * 3] * 2)).toBe(true); // blue hangings
  });
  it('hangs pictures tilted forward in three sizes, canvases from the atlas', () => {
    const w = [0, 1, 2].map((v) => { const b = makeProp('portrait', v).bounds; return Math.max(b.max[0] - b.min[0], 0); });
    expect(new Set(w.map((x) => x.toFixed(2))).size).toBeGreaterThan(1);
    for (let v = 0; v < 6; v++) {
      const p = makeProp('portrait', v), uv = p.mesh.bins.paint.uv;
      expect(p.mesh.bins.paint.triangles).toBe(2);
      expect(Math.min(...uv)).toBeGreaterThanOrEqual(0); expect(Math.max(...uv)).toBeLessThanOrEqual(1);
      expect(p.bounds.max[2]).toBeGreaterThan(0.08); // the top leans out
    }
    expect(makeProp('overmantel-mirror', 1).mesh.bins.brass.triangles).toBeGreaterThan(100);
  });
  it('paints a different canvas on each portrait variant: four sitters upright, two landscapes wide', () => {
    const w = (v: number) => { const b = makeProp('portrait', v).bounds; return b.max[0] - b.min[0]; };
    // a landscape is its size's canvas turned on its side: wider than the sitter of the same size
    expect(w(4)).toBeGreaterThan(w(1) + 0.2); expect(w(5)).toBeGreaterThan(w(2) + 0.3);
    expect(w(3)).toBeCloseTo(w(0), 1);
  });
  it('has period heights and the lights the style guide asks for', () => {
    for (let s = 0; s < 6; s++) {
      expect(H('armchair', s).max[1]).toBeGreaterThan(0.9); expect(H('armchair', s).max[1]).toBeLessThan(1.15);
      expect(H('bookcase', s).max[1]).toBeGreaterThan(2.1); expect(H('bookcase', s).max[1]).toBeLessThan(2.45);
      expect(H('pedestal-desk', s).max[1]).toBeGreaterThan(0.74); expect(H('pedestal-desk', s).max[1]).toBeLessThan(0.8);
      expect(H('four-poster', s).max[1]).toBeGreaterThan(2.3);
      expect(H('armour', s).max[1]).toBeGreaterThan(1.8);
    }
    expect(makeProp('oil-lamp', 1).meta.emitters[0].kind).toBe('lantern');
    expect(makeProp('oil-lamp', 1).mesh.bins.wax.col.some((c) => c > 1)).toBe(true); // the opal globe glows
    expect(makeProp('candle-sconce', 1).meta.emitters[0].kind).toBe('candle');
    expect(makeProp('candelabrum', 1).mesh.flames.length).toBeGreaterThanOrEqual(3);
    for (const n of ['rug', 'carpet', 'runner']) { expect(KIND[n].blocksNav).toBe(false); expect(makeProp(n, 1).bounds.max[1]).toBeLessThan(0.03); }
    for (let s = 0; s < 6; s++) expect(makeProp('skin', s).bounds.max[1]).toBeLessThan(0.3); // a bear's head at most
    let bear = false; for (let s = 0; s < 8; s++) if (makeProp('skin', s).mesh.bins.ceramic.triangles > 0) bear = true;
    expect(bear).toBe(true);
  });
});

describe('glass and canvases face the room', () => {
  it('the mirror glass, the sconce plate and the canvas normals point out of the wall (+z)', () => {
    // share of the vertices on the plane z = z0 (the glass or plate) whose normal points out
    const facing = (name: string, bin: 'brass' | 'paint', v: number, z0?: number) => {
      const p = makeProp(name, v), b = p.mesh.bins[bin];
      let n = 0, out = 0;
      for (let i = 0; i < b.nor.length; i += 3) if (Math.abs(b.nor[i + 2]) > 0.9 && (z0 === undefined || Math.abs(b.pos[i + 2] - z0) < 1e-6)) { n++; if (b.nor[i + 2] > 0) out++; }
      return n ? out / n : -1;
    };
    for (let v = 0; v < 4; v++) {
      expect(facing('overmantel-mirror', 'brass', v, 0.02)).toBe(1);
      expect(facing('candle-sconce', 'brass', v, 0.012)).toBe(1);
      expect(facing('portrait', 'paint', v)).toBe(1);
    }
  });
});

describe('medieval sets', () => {
  it('have real-world sizes', () => {
    for (let s = 0; s < 6; s++) {
      const t = H('refectory-table', s); expect(t.max[1]).toBeGreaterThan(0.74); expect(t.max[1]).toBeLessThan(0.8); expect(t.max[0] - t.min[0]).toBeGreaterThan(2.9);
      const w = H('work-table', s); expect(w.max[1]).toBeGreaterThan(0.84); expect(w.max[0] - w.min[0]).toBeGreaterThan(2);
      expect(H('box-chair', s).max[1]).toBeGreaterThan(1.5);
      expect(H('dresser', s).max[1]).toBeGreaterThan(1.7);
      expect(H('prie-dieu', s).max[1]).toBeLessThan(1);
      const a = H('stone-altar', s); expect(a.max[1]).toBeGreaterThan(1.2); // the cross stands on the mensa
    }
  });
  it('light the altar with two prickets and the kitchen hearth with its fire', () => {
    const a = makeProp('stone-altar', 2);
    expect(a.meta.emitters.filter((e) => e.kind === 'candle')).toHaveLength(2);
    expect(a.mesh.bins.stone.triangles).toBeGreaterThan(0);
    const h = makeProp('spit-hearth', 2);
    expect(h.meta.emitters[0].kind).toBe('hearth');
    expect(h.mesh.bins.iron.triangles).toBeGreaterThan(makeProp('hooded-hearth', 2).mesh.bins.iron.triangles); // spit, crane and cauldron
  });
  it('sizes a shutter leaf to its window and runs the straps from the hinge edge', () => {
    for (const hinge of [1, -1] as const) {
      const m = new PropMesh(), meta = buildShutter(m, mulberry32(3), 0.8, 1.6, hinge), b = m.bounds();
      expect(b.max[0] - b.min[0]).toBeCloseTo(0.8, 1); expect(b.max[1]).toBeCloseTo(1.6, 1); expect(b.min[2]).toBeGreaterThan(0.01);
      const iron = m.bins.iron.pos, xs = iron.filter((_, i) => i % 3 === 0);
      expect(Math.max(...xs.map((x) => x * hinge))).toBeGreaterThan(0.38);
      expect(meta.colliders).toHaveLength(1);
    }
  });
  it('maps the pelt flat: fur UVs proportional to metres, inside the fur rectangle', () => {
    for (let s = 0; s < 6; s++) {
      const p = makeProp('skin', s), pos = p.mesh.bins.paint.pos, uv = p.mesh.bins.paint.uv;
      for (let i = 0; i < uv.length; i += 2) { expect(uv[i]).toBeGreaterThanOrEqual(ATLAS.fur[0] - 1e-6); expect(uv[i]).toBeLessThanOrEqual(ATLAS.fur[2] + 1e-6); }
      // on the flat hide (y < 0.03), u follows x and v follows z linearly
      const flat: number[] = []; for (let i = 0; i < 1512; i++) flat.push(i); // the hide: 72 spokes, 4 rings (the head comes after)
      const a = flat[0], b = flat.find((i) => Math.abs(pos[i * 3] - pos[a * 3]) > 0.3)!;
      const k = (uv[b * 2] - uv[a * 2]) / (pos[b * 3] - pos[a * 3]);
      for (const i of flat) expect(uv[i * 2] - uv[a * 2]).toBeCloseTo(k * (pos[i * 3] - pos[a * 3]), 5);
    }
  });
});
