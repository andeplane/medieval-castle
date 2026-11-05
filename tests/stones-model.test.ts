// Stone model units with injected fakes: face geometry, exclusions, the course layout on a toy
// masonry spec, stone geometry (all LODs), the queryable stone set, and LOD selection.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  type StoneFace, type MasonrySpec, type Exclusion, type V3, type Stone,
  faceToWorld, worldToFace, faceNormal, faceBounds, bandRange, ExclusionIndex, exclusionShapes, rectShape, hull, layoutFace,
  makeMasonrySpec, masonrySpec, F_CUT_L, F_CUT_R, F_EXT_L, F_EXT_R, F_SIL,
} from '../src/castle/stones/layout';
import { GeoBuf, writeStone } from '../src/castle/stones/mesh';
import { StoneSet } from '../src/castle/stones/set';
import { StoneField, LOD, pickLevel, facingAway, boxDistance, makeChunks, type LodParams } from '../src/castle/stones/field';
import { RUBBLE } from '../src/render/texgen';
import { mulberry32 } from '../src/core/rng';

// A toy masonry: 1 m tile, two 0.5 m courses of two 0.5 m stones; the upper-left stone is split.
const toy: MasonrySpec = {
  opts: RUBBLE, tile: 1, joint: 0.02, bevel: 0.03, warp: 0, warpAt: () => [0, 0], depth: [0.05, 0.08], ext: 0.1,
  courses: [
    { y0: 0, y1: 0.5, stones: [{ x0: 0, x1: 0.5, split: 0, id: 0.1, bulge: 1, tilt: 0 }, { x0: 0.5, x1: 1, split: 0, id: 0.2, bulge: 0.5, tilt: 0.2 }] },
    { y0: 0.5, y1: 1, stones: [{ x0: 0.25, x1: 0.75, split: 0.5, id: 0.3, bulge: 1, tilt: -0.2 }, { x0: 0.75, x1: 1.25, split: 0, id: 0.4, bulge: 1, tilt: 0 }] },
  ],
};
const specFor = () => toy;
const plane = (over: Partial<StoneFace> = {}): StoneFace => ({
  mat: 'old', geom: { kind: 'plane', o: [0, 0, 0], r: [1, 0, 0], n: [0, 0, 1] },
  s0: 0, s1: 3, y0: 0, y1: 2, u0: 0, holes: [], ends: [false, false], sil: false, owner: -1, ...over,
});
const cyl = (over: Partial<StoneFace> = {}): StoneFace => plane({ geom: { kind: 'cyl', cx: 10, cz: 5, R: 3 }, s0: 0, s1: 3 * Math.PI * 2, ...over });
const battered = (over: Partial<StoneFace> = {}): StoneFace => {
  const run = 0.5, H = 2, l = Math.hypot(H, run);
  return plane({ geom: { kind: 'plane', o: [0, 0, 0], r: [1, 0, 0], n: [0, 0, 1], bat: { y0: 0, H, run, ns: [0, run / l, H / l] } }, ...over });
};
const close = (a: V3, b: V3, eps = 1e-9) => a.forEach((v, k) => expect(v).toBeCloseTo(b[k], -Math.log10(eps)));

describe('face geometry', () => {
  it('plane, battered and cylinder faces round-trip world ↔ face coordinates', () => {
    for (const f of [plane(), battered(), cyl(), plane({ geom: { kind: 'plane', o: [2, 0, 1], r: [0, 0, 1], n: [1, 0, 0] } })]) {
      for (const [s, y, d] of [[0.3, 0.2, 0], [1.7, 1.1, 0.05], [2.5, 1.9, -0.02]] as V3[]) {
        const p = faceToWorld(f, s, y, f.geom.kind === 'plane' && f.geom.bat ? 0 : d);
        close(worldToFace(f, p).slice(0, 2) as V3, [s, y, 0].slice(0, 2) as V3, 1e-6);
      }
    }
    // a cylinder far from its middle angle unwraps to the nearest turn
    const c = cyl({ s0: 0, s1: 1 });
    expect(worldToFace(c, faceToWorld(c, -12, 1, 0))[0]).toBeCloseTo(-12 + 3 * Math.PI * 2, 6);
    expect(worldToFace(cyl({ s0: 30, s1: 31 }), faceToWorld(c, 1, 1, 0))[0]).toBeCloseTo(1 + 3 * Math.PI * 2 * 2, 6);
  });
  it('normals and bounds', () => {
    expect(faceNormal(plane(), 1)).toEqual([0, 0, 1]);
    expect(faceNormal(battered(), 1)[1]).toBeGreaterThan(0);
    close(faceNormal(cyl(), 0), [1, 0, 0]);
    const [lo, hi] = faceBounds(plane(), 0.25);
    expect(lo[0]).toBeCloseTo(-0.25); expect(hi[0]).toBeCloseTo(3.25); expect(lo[1]).toBeCloseTo(-0.25); expect(hi[2]).toBeCloseTo(0.5);
    const [clo, chi] = faceBounds(cyl(), 0);
    expect(clo).toEqual([7, 0, 2]); expect(chi).toEqual([13, 2, 8]);
  });
  it('bandRange clips a polygon to a horizontal band', () => {
    const sq: [number, number][] = [[1, 1], [2, 1], [2, 2], [1, 2]];
    expect(bandRange(sq, 0.5, 1.5)).toEqual([1, 2]);
    expect(bandRange(sq, 3, 4)).toBeNull();
    const tri: [number, number][] = [[0, 0], [2, 0], [1, 2]];
    const r = bandRange(tri, 1.5, 1.6)!;
    expect(r[0]).toBeCloseTo(0.75); expect(r[1]).toBeCloseTo(1.25);
  });
});

describe('exclusions', () => {
  const box = (owner: number, lo: V3, hi: V3): Exclusion => ({ owner, pts: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]] as V3) });
  it('the index finds solids by box and the face keeps only those touching its stone layer', () => {
    const ex = [box(1, [0.5, 0.5, -0.2], [1, 1, 0.1]), box(2, [10, 0, 0], [11, 1, 1]), box(3, [0.5, 0.5, 0.5], [1, 1, 0.8]), box(4, [5, 0, 0], [6, 1, 0.1])];
    const idx = new ExclusionIndex(ex, 2);
    expect(idx.query([0, 0, -1], [2, 2, 1]).map((e) => e.owner).sort()).toEqual([1, 3]);
    expect(idx.query([20, 0, 0], [21, 1, 1])).toEqual([]);
    const shapes = exclusionShapes(plane({ owner: 9 }), ex);
    expect(shapes.length).toBe(1); // 3 floats in front of the stones, 2 and 4 are off the face
    const xs = shapes[0].map((p) => p[0]), ys = shapes[0].map((p) => p[1]);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([0.5, 1, 0.5, 1]);
    expect(exclusionShapes(plane({ owner: 1 }), ex)).toEqual([]); // its own solid never cuts a face
  });
  it('a battered solid crossing the face blocks only the wedge inside the stone layer', () => {
    // a plinth whose foot stands 1 m out at y = 0 and meets the wall at y = 2, running from s = 1 to 3
    const plinth: Exclusion = { owner: 5, pts: [[1, 0, -1], [3, 0, -1], [1, 0, 1], [3, 0, 1], [1, 2, -1], [3, 2, -1], [1, 2, 0], [3, 2, 0]] };
    const side = plane({ geom: { kind: 'plane', o: [0, 0, 0.5], r: [1, 0, 0], n: [0, 0, 1] } }); // a face 0.5 m out
    const [sh] = exclusionShapes(side, [plinth]);
    const ys = sh.map((p) => p[1]);
    expect(Math.max(...ys)).toBeLessThan(1.1); // above y ≈ 1 the plinth is behind the face plane
    expect(Math.min(...ys)).toBeCloseTo(0);
    expect(hull([[0, 0], [1, 0], [0.5, 0.2], [1, 1], [0, 1]])).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
    expect(hull([[0, 0], [1, 1]])).toEqual([[0, 0], [1, 1]]);
  });
});

describe('course layout (toy spec, injected)', () => {
  it('tiles the toy courses, splits, cuts and merges slivers', () => {
    const f = plane({ s0: 0.05, s1: 2.6 });
    const st = layoutFace(f, 0, [], toy, 1);
    // four 0.5 m courses
    expect(new Set(st.map((s) => s.course))).toEqual(new Set([0, 1, 2, 3]));
    // the first course starts with a 0.45 cut stone; the 0.1 sliver at the right end merges into its neighbour
    const c0 = st.filter((s) => s.course === 0).sort((a, b) => a.a - b.a);
    expect(c0[0].a).toBeCloseTo(0.05); expect(c0[0].flags & F_CUT_L).toBeTruthy();
    expect(c0[c0.length - 1].b).toBeCloseTo(2.6); expect(c0[c0.length - 1].b - c0[c0.length - 1].a).toBeCloseTo(0.6);
    expect(c0[c0.length - 1].flags & F_CUT_R).toBeTruthy();
    // split cells become two stones stacked at the half
    const split = st.filter((s) => s.course === 1 && Math.abs(s.a - 0.25) < 1e-9);
    expect(split.map((s) => [s.ya, s.yb])).toEqual([[0.5, 0.75], [0.75, 1]]);
    // a different salt reseeds the stones but not the layout
    const st2 = layoutFace(f, 0, [], toy, 2);
    expect(st2.map((s) => s.a)).toEqual(st.map((s) => s.a));
    expect(st2.map((s) => s.seed)).not.toEqual(st.map((s) => s.seed));
  });
  it('blocked by holes and solids, interlocking ends, silhouette flags', () => {
    const f = plane({ holes: [[[1.1, 0.6], [1.6, 0.6], [1.6, 1.4], [1.1, 1.4]]], ends: [true, true] });
    const st = layoutFace(f, 3, [rectShape(2.2, 2.4, 0, 0.3)], toy, 1);
    for (const s of st) {
      if (s.ya < 1.4 && s.yb > 0.6) expect(s.b <= 1.1 - 0.02 + 1e-9 || s.a >= 1.6 + 0.02 - 1e-9).toBe(true);
      if (s.ya < 0.3) expect(s.b <= 2.2 - 0.01 + 1e-9 || s.a >= 2.4 + 0.01 - 1e-9).toBe(true);
      expect(s.face).toBe(3);
    }
    for (const c of [0, 1, 2, 3]) {
      const row = st.filter((s) => s.course === c).sort((a, b) => a.a - b.a);
      expect(!!(row[0].flags & F_EXT_L)).toBe(c % 2 === 1);
      expect(!!(row[row.length - 1].flags & F_EXT_R)).toBe(c % 2 === 0);
      expect(row[0].flags & F_SIL).toBeTruthy();
      expect(row.slice(1, -1).every((s) => !(s.flags & F_SIL))).toBe(true);
    }
    expect(layoutFace(plane({ sil: true }), 0, [], toy).every((s) => s.flags & F_SIL)).toBe(true);
    // too-short face bands make no course
    expect(layoutFace(plane({ y0: 0, y1: 0.05 }), 0, [], toy)).toEqual([]);
  });
  it('the masonry spec is built from an injected rng', () => {
    const a = makeMasonrySpec('old', mulberry32(7)), b = makeMasonrySpec('old', mulberry32(7)), c = makeMasonrySpec('old', mulberry32(8));
    expect(a.courses).toEqual(b.courses);
    expect(a.courses).not.toEqual(c.courses);
    expect(masonrySpec('old')).toBe(masonrySpec('old')); // the default is cached
    expect(masonrySpec('new').depth[1]).toBeLessThan(masonrySpec('old').depth[1]);
  });
});

describe('stone geometry', () => {
  const faces = [plane({ ends: [true, true] }), cyl(), battered(), plane({ geom: { kind: 'plane', o: [0, 0, 0], r: [-1, 0, 0], n: [0, 0, 1] } }), plane({ mat: 'new', ends: [true, true] })];
  const tris = [10, 22, 84];
  for (const [fi, f] of faces.entries()) {
    it(`face ${fi} (${f.geom.kind}${f.geom.kind === 'plane' && f.geom.bat ? ', battered' : ''}, ${f.mat}): every level is closed toward the face and textured from its stone`, () => {
      const all = layoutFace(f, fi, [], toy), stones = [...all.slice(0, 8), ...all.slice(-4)];
      expect(stones.length).toBeGreaterThan(4);
      for (const st of stones) for (const level of [0, 1, 2] as const) {
        const b = new GeoBuf();
        writeStone(b, f, st, level, toy);
        const K = level === 0 ? 4 : level === 1 ? 8 : 12;
        const ext = st.flags & (F_EXT_L | F_EXT_R) ? K - 2 : 0;
        expect(b.idx.length / 3).toBe(tris[level] + ext);
        expect(b.idx.every((k) => k >= 0 && k < b.verts)).toBe(true);
        for (let v = 0; v < b.verts; v++) expect(Math.hypot(b.nor[v * 3], b.nor[v * 3 + 1], b.nor[v * 3 + 2])).toBeCloseTo(1, 5);
        // the crown (last vertex) faces out of the wall
        const v = b.verts - 1, n = faceNormal(f, (st.a + st.b) / 2);
        if (level === 2) expect(b.nor[v * 3] * n[0] + b.nor[v * 3 + 1] * n[1] + b.nor[v * 3 + 2] * n[2]).toBeGreaterThan(0.5);
        // triangles wind outward: the face triangles' geometric normal agrees with the wall normal
        const t = b.idx.length - 3 * (1 + ext); // the last face triangle (an extended stone ends with its back cap)
        const [i0, i1, i2] = [b.idx[t], b.idx[t + 1], b.idx[t + 2]].map((k) => k * 3);
        const P = b.pos, u = [P[i1] - P[i0], P[i1 + 1] - P[i0 + 1], P[i1 + 2] - P[i0 + 2]], w = [P[i2] - P[i0], P[i2 + 1] - P[i0 + 1], P[i2 + 2] - P[i0 + 2]];
        const cr = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        expect(cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2]).toBeGreaterThan(0);
        // UVs stay inside the stone's own texture cell, clear of its joints
        for (let k = 0; k < b.verts; k++) {
          const s = b.uv[k * 2] * toy.tile - f.u0, y = b.uv[k * 2 + 1] * toy.tile;
          expect(s).toBeGreaterThan(st.a + toy.joint / 2 - 1e-9); expect(s).toBeLessThan(st.b - toy.joint / 2 + 1e-9);
          expect(y).toBeGreaterThan(st.ya + toy.joint / 2 - 1e-9); expect(y).toBeLessThan(st.yb - toy.joint / 2 + 1e-9);
        }
      }
    });
  }
  it('a vanishingly short stone is widened to a minimum, and the default spec is used when none is given', () => {
    const f = plane();
    const st: Stone = { face: 0, a: 1, b: 1.03, ya: 0, yb: 0.5, course: 0, flags: 0, id: 0, bulge: 1, tilt: 0, seed: 0.5 };
    const b = new GeoBuf(); writeStone(b, f, st, 1, toy);
    const xs = Array.from({ length: b.verts }, (_, k) => b.pos[k * 3]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.03);
    const d = new GeoBuf(); writeStone(d, f, { ...st, b: 1.4 }, 2);
    expect(d.verts).toBeGreaterThan(0);
  });
});

describe('stone set', () => {
  const faces = [plane(), plane({ geom: { kind: 'plane', o: [0, 0, 6], r: [1, 0, 0], n: [0, 0, -1] }, sil: true }), cyl({ mat: 'new' })];
  const set = new StoneSet(faces, [], { specFor, cell: 1 });
  it('stonesNear matches a brute-force search, nearest first', () => {
    const p: V3 = [1.2, 0.8, 0.5];
    for (const r of [0.3, 1, 2.5]) {
      const got = set.stonesNear(p, r);
      const want = set.stones.map((_, i) => i).filter((i) => Math.hypot(...set.centre(i).map((c, k) => c - p[k])) <= r);
      expect(got.length).toBe(want.length);
      const ds = got.map((g) => Math.hypot(...g.centre.map((c, k) => c - p[k])));
      expect(ds.every((d, i) => i === 0 || d >= ds[i - 1])).toBe(true);
      for (const g of got) { expect(faces).toContain(g.face); expect(Math.hypot(...g.normal)).toBeCloseTo(1); }
    }
    expect(set.stonesNear([100, 100, 100], 1)).toEqual([]);
  });
  it('lays out the faces with the default spec too', () => {
    const d = new StoneSet([plane({ s1: 2 })], []);
    expect(d.stones.length).toBeGreaterThan(10);
    expect(d.specFor('old')).toBe(masonrySpec('old'));
  });
});

describe('LOD', () => {
  // every stone near the camera (`?stones=all`); the default LOD keeps only silhouette stones
  const L: LodParams = { ...LOD, hi: 2, mid: 5, lo: 8, sil: 12, plain: Infinity, hyst: 0.5, cell: 4, minChunk: 30 };
  it('pickLevel bands with hysteresis and a silhouette-only band', () => {
    const off = { level: 0 as const, silOnly: false };
    expect(pickLevel(1, off, false, L)).toEqual({ level: 3, silOnly: false });
    expect(pickLevel(2.2, off, false, L).level).toBe(2);
    expect(pickLevel(2.2, { level: 3, silOnly: false }, false, L).level).toBe(3); // hysteresis keeps hi
    expect(pickLevel(6, off, false, L).level).toBe(1);
    expect(pickLevel(10, off, false, L)).toEqual({ level: 0, silOnly: false });
    expect(pickLevel(10, off, true, L)).toEqual({ level: 1, silOnly: true });
    expect(pickLevel(12.2, { level: 1, silOnly: true }, true, L)).toEqual({ level: 1, silOnly: true });
    expect(pickLevel(12.2, off, true, L).level).toBe(0);
    expect(pickLevel(1, off, true)).toEqual({ level: 3, silOnly: true }); // default: silhouettes only, depth from parallax
    expect(pickLevel(1, off, false).level).toBe(0);
  });
  it('builds plain stones only within lod.plain', () => {
    const off = { level: 0 as const, silOnly: false }, P = { ...L, plain: 3 };
    expect(pickLevel(1, off, true, P)).toEqual({ level: 3, silOnly: false });
    expect(pickLevel(3.2, { level: 2, silOnly: false }, true, P)).toEqual({ level: 2, silOnly: false }); // hysteresis
    expect(pickLevel(3.2, off, true, P)).toEqual({ level: 2, silOnly: true });
    expect(pickLevel(4, off, false, P)).toEqual({ level: 0, silOnly: false });
  });
  it('facing and distance helpers', () => {
    expect(facingAway({ x: 0, y: 0, z: -10 }, [0, 0, 0], [0, 0, 1], 10)).toBe(true);
    expect(facingAway({ x: 0, y: 0, z: 10 }, [0, 0, 0], [0, 0, 1], 10)).toBe(false);
    expect(facingAway({ x: 0, y: 0, z: -3 }, [0, 0, 0], [0, 0, 1], 3)).toBe(false); // too close to cull
    expect(facingAway({ x: 0, y: 0, z: -10 }, [0, 0, 0], [0, 0, 0], 10)).toBe(false); // mixed chunk
    expect(facingAway({ x: 0, y: 0, z: 0 }, [0, 0, 0], [0, 0, 1], 10)).toBe(false);
    expect(boxDistance({ x: 0, y: 0, z: 0 }, [1, -1, -1], [2, 1, 1])).toBe(1);
    expect(boxDistance({ x: 5, y: 6, z: 0 }, [1, 1, -1], [2, 2, 1])).toBe(5);
    expect(boxDistance({ x: 1.5, y: 0, z: 0 }, [1, -1, -1], [2, 1, 1])).toBe(0);
  });
  // two long walls facing each other 6 m apart, a silhouette parapet, a few loose turret stones
  const faces = [plane({ s1: 12, y1: 3 }), plane({ geom: { kind: 'plane', o: [12, 0, 6], r: [-1, 0, 0], n: [0, 0, -1] }, s1: 12, y1: 3, mat: 'new' }), plane({ s0: 0, s1: 3, y0: 3, y1: 4, sil: true }), cyl({ s1: 2, y1: 1 })];
  const set = () => new StoneSet(faces, [], { specFor, cell: 2 });
  it('chunks hold every stone once, silhouette stones last, small chunks merged without a facing', () => {
    const s = set(), chunks = makeChunks(s, L);
    expect(chunks.reduce((n, c) => n + c.stones.length, 0)).toBe(s.stones.length);
    for (const c of chunks) {
      expect(c.stones.slice(c.silFrom).every((t) => t.flags & F_SIL)).toBe(true);
      expect(c.stones.slice(0, c.silFrom).every((t) => !(t.flags & F_SIL))).toBe(true);
      if (c.stones.length < L.minChunk) expect(c.n).toEqual([0, 0, 0]);
      for (let k = 0; k < 3; k++) expect(c.lo[k]).toBeLessThan(c.hi[k]);
    }
    expect(chunks.some((c) => c.n[0] === 0 && c.n[2] === 0)).toBe(true);
    expect(makeChunks(s).length).toBeGreaterThan(0);
  });
  it('update picks levels from the camera position, honours the build budget and evicts far geometry', () => {
    const s = set(), m = new THREE.MeshBasicMaterial();
    let t = 0;
    const field = new StoneField(s, { old: m, new: m }, L, () => t);
    // right in front of the first wall: near chunks hi, the far side's back faces culled
    field.update({ x: 6, y: 1.5, z: 1 }, Infinity);
    const st1 = field.stats();
    expect(st1.hiChunks).toBeGreaterThan(0);
    expect(st1.visibleChunks).toBeGreaterThan(0);
    expect(st1.stoneTriangles).toBeGreaterThan(0);
    expect(st1.stones).toBe(s.stones.length);
    expect(field.group.children.length).toBe(st1.visibleChunks);
    for (const ch of field.chunks) if (ch.level) expect(ch.mesh!.visible).toBe(true);
    // unchanged camera: nothing to do
    field.update({ x: 6, y: 1.5, z: 1 }, Infinity);
    expect(field.stats()).toEqual(st1);
    // far away: silhouette stones only, through a draw range
    field.update({ x: 6, y: 1.5, z: 10 + 2 }, Infinity);
    const sil = field.chunks.filter((c) => c.silOnly);
    expect(sil.length).toBeGreaterThan(0);
    for (const c of sil) expect(c.mesh!.geometry.drawRange.start).toBe(c.silIndex[0]);
    const vis = field.chunks.filter((c) => c.level);
    expect(field.stats().stoneTriangles).toBe(vis.reduce((n, c) => n + (c.mesh!.geometry.index!.count - (c.silOnly ? c.silIndex[0] : 0)) / 3, 0));
    // very far: all off, and geometry freed
    field.update({ x: 6, y: 1.5, z: 200 }, Infinity);
    expect(field.stats().visibleChunks).toBe(0);
    expect(field.chunks.every((c) => c.geo.every((g) => g === null))).toBe(true);
    expect(field.chunks.some((c) => c.mesh && !c.mesh.visible)).toBe(true);
    // a zero budget with a clock that runs builds one chunk per call
    const f2 = new StoneField(s, { old: m, new: m }, L, () => (t += 1));
    f2.update({ x: 6, y: 1.5, z: 1 }, 0);
    expect(f2.stats().visibleChunks).toBe(1);
    f2.update({ x: 6, y: 1.5, z: 1 }, 0);
    expect(f2.stats().visibleChunks).toBe(2);
    // hidden group: no work at all
    const f3 = new StoneField(s, { old: m, new: m }, L);
    f3.group.visible = false;
    f3.update({ x: 6, y: 1.5, z: 1 });
    expect(f3.stats().visibleChunks).toBe(0);
  });
  it('big chunks get 32-bit indices', () => {
    const big = new StoneSet([plane({ s1: 30, y1: 12 })], [], { specFor });
    const field = new StoneField(big, { old: new THREE.MeshBasicMaterial(), new: new THREE.MeshBasicMaterial() }, { ...L, cell: 1000, minChunk: 1 });
    expect(field.chunks.length).toBe(1);
    const g = field.geometry(field.chunks[0], 3);
    expect(g.index!.array).toBeInstanceOf(Uint32Array);
    expect(field.geometry(field.chunks[0], 3)).toBe(g); // cached
  });
});
