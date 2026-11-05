// Stone texture generator: signed-distance joints, per-stone variation and the close-up detail layer.
// Small textures keep this fast; every generator takes its rng/noise and size as parameters.
import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import {
  masonry, layCourses, masonryLayout, masonryWarp, stoneDistance, stoneDetail, voronoi, encodeId, lithOf, TileNoise,
  RUBBLE, ASHLAR, DRESSED, LITHS, LITH_COL, LITH_DETAIL, DETAIL_TILE, rubbleSet, ashlarSet, dressedSet,
  slate, planks, macroNoise, waterNormals, groundLayers, STONE_GREYS, PIN_COL, type MasonryOpts, type TexSet,
  cobbles, cobbleSet, flagSet, COBBLES, FLAGS,
} from '../src/render/texgen';

// 1 m tiles at 256 px: 3.9 mm texels, so joints are several texels wide like the real 2048 px / 4 m set
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const small = (o: MasonryOpts, size = 256): MasonryOpts => ({ ...o, size, tile: 1 });
const sdfPx = (s: TexSet, o: MasonryOpts, i: number) => ((s.data[i * 4 + 3] / 255 - 0.5) * 2 * o.sdfRange * s.size) / o.tile;
const rubble = masonry(small(RUBBLE), mulberry32(1));
const ashlar = masonry(small(ASHLAR), mulberry32(2));

describe('masonry layout', () => {
  it('courses fill the tile exactly and stones wrap around it', () => {
    const o = small(RUBBLE), L = layCourses(o, mulberry32(3));
    expect(L.cy[L.cy.length - 1]).toBeCloseTo(o.size, 6);
    for (const c of L.courses) {
      expect(c.slots[0].x0).toBeCloseTo(c.off, 6);
      expect(c.slots[c.slots.length - 1].x1).toBeCloseTo(c.off + o.size, 6);
      for (const s of c.slots) for (const p of s.parts) expect(p.y1).toBeGreaterThan(p.y0);
    }
  });

  it('splits some rubble slots into two stacked stones', () => {
    const L = layCourses({ ...small(RUBBLE), split: 1 }, mulberry32(4));
    expect(L.courses.every((c) => c.slots.every((s) => s.parts.length === 2))).toBe(true);
  });
});

describe('layout shared with the 3D stones', () => {
  it('exposes one cell per slot, split fraction for stacked stones, nothing shorter than the minimum stone', () => {
    const o = small(RUBBLE, 512), L = masonryLayout(o, mulberry32(21)), C = layCourses(o, mulberry32(21));
    expect(L.courses.length).toBe(C.courses.length);
    let splits = 0;
    L.courses.forEach((c, i) => c.stones.forEach((st, j) => {
      const sl = C.courses[i].slots[j];
      expect(st.x0).toBe(sl.x0); expect(st.x1 - st.x0).toBeGreaterThanOrEqual(o.stone[0] * L.px - 1e-6);
      if (sl.parts.length > 1) { splits++; expect(st.split).toBeCloseTo(sl.parts[0].y1, 9); } else expect(st.split).toBe(0);
    }));
    expect(splits).toBeGreaterThan(0);
  });
  it('the warp field is the one the texture uses, small and smooth', () => {
    const w = masonryWarp(RUBBLE), [a, b] = w(0.3, 0.6), [c, d] = w(0.3001, 0.6);
    expect(Math.abs(a)).toBeLessThan(1); expect(Math.abs(b)).toBeLessThan(1);
    expect(Math.abs(a - c) + Math.abs(b - d)).toBeLessThan(0.01);
  });
});

describe('stone outline distance', () => {
  const L = layCourses(small(ASHLAR), mulberry32(5));
  const slot = L.courses[0].slots[0], st = slot.parts[0], W = slot.x1 - slot.x0, H = L.hs[0];

  it('is positive inside, negative in the joint, and grows towards the centre', () => {
    expect(stoneDistance(st, W / 2, H / 2, W, H)).toBeGreaterThan(0);
    expect(stoneDistance(st, 0, H / 2, W, H)).toBeLessThan(0);
    expect(stoneDistance(st, W / 2, 0, W, H)).toBeLessThan(0);
    expect(stoneDistance(st, W / 2, H / 2, W, H)).toBeGreaterThan(stoneDistance(st, W / 4, H / 2, W, H));
  });

  it('rounds corners and knocks some off', () => {
    const square = { ...st, inset: [2, 2, 2, 2] as [number, number, number, number], slope: [0, 0, 0, 0] as [number, number, number, number], cham: [0, 0, 0, 0] as [number, number, number, number] };
    const sharp = { ...square, rc: 0 }, round = { ...square, rc: 6 }, cut = { ...sharp, cham: [10, 10, 10, 10] as [number, number, number, number] };
    // a point just inside the corner diagonal
    expect(stoneDistance(sharp, 3, 3, 40, 40)).toBeCloseTo(1, 6);
    expect(stoneDistance(round, 3, 3, 40, 40)).toBeLessThan(0);
    expect(stoneDistance(cut, 3, 3, 40, 40)).toBeLessThan(0);
    for (const k of [0, 1, 2, 3]) {
      const one = { ...sharp, cham: [0, 0, 0, 0].map((_, i) => (i === k ? 10 : 0)) as [number, number, number, number] };
      const [x, y] = [[3, 3], [37, 3], [37, 37], [3, 37]][k];
      expect(stoneDistance(one, x, y, 40, 40)).toBeLessThan(0);
    }
  });
});

describe('masonry textures', () => {
  it('is a pure function of its rng and noise', () => {
    const a = masonry(small(DRESSED, 64), mulberry32(9)), b = masonry(small(DRESSED, 64), mulberry32(9)), c = masonry(small(DRESSED, 64), mulberry32(10));
    expect(same(a.albedo, b.albedo)).toBe(true);
    expect(same(a.data, c.data)).toBe(false);
  });

  it('stores a signed distance whose sign matches the mortar coverage', () => {
    for (const [s, o] of [[rubble, small(RUBBLE)], [ashlar, small(ASHLAR)]] as const) {
      let bad = 0;
      for (let i = 0; i < s.size * s.size; i++) {
        const mortar = s.data[i * 4 + 1] > 127, d = sdfPx(s, o, i);
        if (mortar ? d > 0.5 : d < -0.5) bad++;
      }
      expect(bad).toBe(0);
    }
  });

  it('has a continuous distance field (no staircase): neighbours differ by about a texel', () => {
    for (const [s, o] of [[rubble, small(RUBBLE)], [ashlar, small(ASHLAR)]] as const) {
      const N = s.size, range = (o.sdfRange * N) / o.tile;
      let worst = 0;
      for (let y = 0; y < N; y++) for (let x = 0; x < N - 1; x++) {
        const i = y * N + x, a = sdfPx(s, o, i), b = sdfPx(s, o, i + 1);
        // around the outline (where the shader draws the edge); mid-joint the owner of a texel may switch
        if (Math.abs(a) < 2 && Math.abs(b) < 2) worst = Math.max(worst, Math.abs(a - b));
      }
      // edge noise, chips and tilted edges steepen it a little; a thresholded raster would jump by the full range
      expect(range).toBeGreaterThan(4);
      expect(worst).toBeLessThan(2.5);
    }
  });

  it('sets the mortar back from the stone faces, rubble deeper than ashlar', () => {
    const depthOf = (s: TexSet) => {
      let hm = 0, nm = 0, hs = 0, ns = 0;
      for (let i = 0; i < s.size * s.size; i++) { const h = s.data[i * 4] / 255; if (s.data[i * 4 + 1] > 127) { hm += h; nm++; } else { hs += h; ns++; } }
      return { mortar: nm / (nm + ns), drop: hs / ns - hm / nm };
    };
    const r = depthOf(rubble), a = depthOf(ashlar);
    expect(r.drop).toBeGreaterThan(0.35);
    expect(a.drop).toBeGreaterThan(0.12);
    expect(r.drop).toBeGreaterThan(a.drop);
    expect(r.mortar).toBeGreaterThan(0.08); expect(r.mortar).toBeLessThan(0.4);
    expect(a.mortar).toBeGreaterThan(0.02); expect(a.mortar).toBeLessThan(0.2);
  });

  it('bakes AO darker next to the stones than in the middle of a joint', () => {
    let near = 0, nn = 0, stone = 0, ns = 0;
    for (let i = 0; i < rubble.size * rubble.size; i++) {
      const ao = rubble.albedo[i * 4 + 3];
      if (rubble.data[i * 4 + 1] > 127) { near += ao; nn++; } else { stone += ao; ns++; }
    }
    expect(near / nn).toBeLessThan(stone / ns);
  });

  it('varies colour per stone and within a stone, grey overall and never blue', () => {
    const N = rubble.size, perId = new Map<number, number[]>();
    let r = 0, g = 0, b = 0, n = 0;
    const liths = new Set<number>();
    for (let i = 0; i < N * N; i++) {
      if (rubble.data[i * 4 + 1] > 127) continue;
      const id = rubble.data[i * 4 + 2]; liths.add(lithOf(id));
      const l = rubble.albedo[i * 4] + rubble.albedo[i * 4 + 1] + rubble.albedo[i * 4 + 2];
      (perId.get(id) ?? perId.set(id, []).get(id)!).push(l);
      r += rubble.albedo[i * 4]; g += rubble.albedo[i * 4 + 1]; b += rubble.albedo[i * 4 + 2]; n++;
    }
    expect(perId.size).toBeGreaterThan(10);
    expect(liths.size).toBeGreaterThanOrEqual(3);
    const means = [...perId.values()].filter((v) => v.length > 200).map((v) => v.reduce((a, c) => a + c, 0) / v.length);
    expect(Math.max(...means) - Math.min(...means)).toBeGreaterThan(30);
    const big = [...perId.values()].sort((a, c) => c.length - a.length)[0], mu = big.reduce((a, c) => a + c, 0) / big.length;
    const sd = Math.sqrt(big.reduce((a, c) => a + (c - mu) ** 2, 0) / big.length);
    expect(sd).toBeGreaterThan(3);
    expect(r / n).toBeGreaterThanOrEqual(b / n);
    expect(g / n).toBeGreaterThanOrEqual((b / n) * 0.98);
    expect(r / n / 255).toBeGreaterThan(0.4); expect(r / n / 255).toBeLessThan(0.75);
  });

  it('draws veins and cracks as open lines, and stains some stones with iron', () => {
    const all = masonry({ ...small(RUBBLE, 128), veins: 1, cracks: 1, iron: 1 }, mulberry32(11));
    const none = masonry({ ...small(RUBBLE, 128), veins: 0, cracks: 0, iron: 0 }, mulberry32(11));
    let diff = 0;
    for (let i = 0; i < all.albedo.length; i++) diff += Math.abs(all.albedo[i] - none.albedo[i]);
    expect(diff).toBeGreaterThan(0);
  });

  it('puts pinning stones only in mortar-wide areas', () => {
    const o = { ...small(RUBBLE, 128), pinning: 0.5, joint: 0.06 };
    const s = masonry(o, mulberry32(12));
    let pins = 0;
    for (let i = 0; i < 128 * 128; i++) if (s.data[i * 4 + 1] < 128 && lithOf(s.data[i * 4 + 2]) === 3) pins++;
    expect(pins).toBeGreaterThan(0);
  });

  it('keeps the stone centre in the normal map alpha and unit normals', () => {
    const s = rubble;
    for (let i = 0; i < s.size * s.size; i += 97) {
      const x = s.normal[i * 4] / 127.5 - 1, y = s.normal[i * 4 + 1] / 127.5 - 1, z = s.normal[i * 4 + 2] / 127.5 - 1;
      expect(Math.abs(Math.hypot(x, y, z) - 1)).toBeLessThan(0.03);
    }
    const alphas = new Set<number>(); for (let i = 0; i < s.size * s.size; i++) alphas.add(s.normal[i * 4 + 3]);
    expect(alphas.size).toBeGreaterThan(5);
  });
});

describe('stone ids and lithologies', () => {
  it('round-trips the lithology through the id byte', () => {
    for (let l = 0; l < LITHS.length; l++) for (const r of [0, 0.5, 0.999]) { const b = encodeId(l, r); expect(b).toBeLessThan(256); expect(lithOf(b)).toBe(l); }
  });
  it('has a detail entry and a grey, not blue, colour for every lithology', () => {
    expect(LITH_COL.length).toBe(LITHS.length);
    for (const k of ['grain', 'fleck', 'pits'] as const) expect(LITH_DETAIL[k].length).toBe(LITHS.length);
    for (const [r, , b] of LITH_COL) expect(r).toBeGreaterThanOrEqual(b);
  });
});

describe('close-up detail texture', () => {
  const N = 128, d = stoneDetail(N, 77);

  it('is deterministic in its seed', () => {
    expect(same(stoneDetail(N, 77), d)).toBe(true);
    expect(same(stoneDetail(N, 78), d)).toBe(false);
  });

  it('has crystals, dark and bright flecks, pits and tool marks', () => {
    let dark = 0, bright = 0, pits = 0, grooves = 0, gmin = 255, gmax = 0;
    for (let i = 0; i < N * N; i++) {
      const a = d[i * 4 + 3]; if (a < 80) dark++; if (a > 200) bright++;
      if (d[i * 4 + 1] > 128) pits++; if (d[i * 4 + 2] < 128) grooves++;
      gmin = Math.min(gmin, d[i * 4]); gmax = Math.max(gmax, d[i * 4]);
    }
    expect(dark).toBeGreaterThan(N * N * 0.03); expect(bright).toBeGreaterThan(N * N * 0.02);
    expect(pits).toBeGreaterThan(0); expect(grooves).toBeGreaterThan(N * N * 0.05);
    expect(gmax - gmin).toBeGreaterThan(80);
    expect(DETAIL_TILE).toBeGreaterThan(0.4);
  });

  it('voronoi is tileable and orders F1 <= F2', () => {
    for (const [x, y] of [[0.3, 5.2], [17.5, 2.1], [31.9, 31.9]]) {
      const a = voronoi(x, y, 4, 8, 3), b = voronoi(x + 32, y - 32, 4, 8, 3);
      expect(a[0]).toBeLessThanOrEqual(a[1]);
      expect(b[0]).toBeCloseTo(a[0], 9); expect(b[2]).toBe(a[2]);
    }
  });
});

describe('other generated sets', () => {
  it('builds the full-size stone sets with the right sizes', () => {
    expect(rubbleSet(32).size).toBe(32); expect(ashlarSet(32).size).toBe(32); expect(dressedSet(32).size).toBe(32);
  });
  it('builds slate, planks, macro noise and water normals', () => {
    expect(slate(64).albedo.length).toBe(64 * 64 * 4);
    expect(planks(64).data.length).toBe(64 * 64 * 4);
    expect(macroNoise(32).length).toBe(32 * 32 * 4);
    expect(waterNormals(32).length).toBe(32 * 32 * 4);
  });
  it('builds the ground layers', () => {
    const g = groundLayers();
    for (const k of ['grass', 'dirt', 'rock', 'mud', 'normal'] as const) expect(g[k].length).toBe(g.size * g.size * 4);
  }, 120_000); // full-size layers: slow on a loaded machine

  it('exposes weighted wall colours, including the pinning stones', () => {
    expect(STONE_GREYS.rubble.at(-1)!.c).toBe(PIN_COL);
    expect(STONE_GREYS.ashlar.every((g) => g.w > 0)).toBe(true);
  });
  it('tile noise wraps', () => {
    const n = new TileNoise(5);
    expect(n.n(0.25, 0.5, 8)).toBeCloseTo(n.n(1.25, -0.5, 8), 9);
    expect(Math.abs(n.fbm(0.1, 0.2, 4, 3))).toBeLessThanOrEqual(1);
  });
});

describe('courtyard paving textures', () => {
  // 1 m at 256 px (3.9 mm texels) as above: cobbles about 36 px across
  const o = { ...COBBLES, size: 256, tile: 1 }, c = cobbles(o, mulberry32(5)), N = 256;
  const sdf = (i: number) => (c.data[i * 4 + 3] / 255 - 0.5) * 2 * o.sdfRange; // metres, + inside a cobble
  it('is a pure function of its rng and noise', () => {
    const again = cobbles(o, mulberry32(5)), other = cobbles(o, mulberry32(6));
    expect(same(again.data, c.data) && same(again.albedo, c.albedo) && same(again.normal, c.normal)).toBe(true);
    expect(same(other.data, c.data)).toBe(false);
    expect(cobbleSet(32).size).toBe(32);
  });
  it('packs the cobbles with earth joints between them: mostly stone, joints from the SDF', () => {
    let joint = 0;
    for (let i = 0; i < N * N; i++) {
      const isJoint = c.data[i * 4 + 1] === 255;
      if (isJoint) joint++;
      const q = (2 * o.sdfRange) / 255; // one byte of the SDF
      if (isJoint) expect(sdf(i)).toBeLessThanOrEqual(q); else expect(sdf(i)).toBeGreaterThanOrEqual(-q);
    }
    expect(joint / (N * N)).toBeGreaterThan(0.08);
    expect(joint / (N * N)).toBeLessThan(0.35);
  });
  it('domes each cobble above the bed, with ids of the cobble lithologies', () => {
    let crown = 0, bed = 1;
    const ids = new Set<number>();
    for (let i = 0; i < N * N; i++) {
      const h = c.data[i * 4] / 255;
      if (sdf(i) > 0.02) { crown = Math.max(crown, h); ids.add(c.data[i * 4 + 2]); } else if (sdf(i) < -0.004) bed = Math.min(bed, h);
    }
    expect(crown - bed).toBeGreaterThan(0.35);
    expect([...ids].every((id) => id % 51 < 50 && Math.floor(id / 51) < LITHS.length)).toBe(true);
    expect(new Set([...ids].map((id) => Math.floor(id / 51))).size).toBeGreaterThan(3);
  });
  it('tiles: the first and last rows and columns continue each other', () => {
    const h = (x: number, y: number) => c.data[(((y + N) % N) * N + ((x + N) % N)) * 4];
    let seamR = 0, seamC = 0, all = 0;
    for (let k = 0; k < N; k++) { seamR += Math.abs(h(k, 0) - h(k, -1)); seamC += Math.abs(h(0, k) - h(-1, k)); }
    for (let y = 1; y < N; y++) for (let x = 0; x < N; x++) all += Math.abs(h(x, y) - h(x, y - 1));
    const mean = all / (N - 1);
    expect(seamR).toBeLessThan(mean * 2); expect(seamC).toBeLessThan(mean * 2);
  });
  it('lays the path flags in courses along the path, with a joint on both edges', () => {
    const f = masonry({ ...FLAGS, size: 128 }, mulberry32(3));
    let edge = 0;
    for (let x = 0; x < 128; x++) if (f.data[x * 4 + 1] === 255 || f.data[(127 * 128 + x) * 4 + 1] === 255) edge++;
    expect(edge / 128).toBeGreaterThan(0.9);
    expect(flagSet(32).size).toBe(32);
  });
});
