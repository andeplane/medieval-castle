// Unit tests for the interior's geometric helpers: half-plane clipping, door/niche head outlines, convex
// carving of the exterior bins, and the barrel-vaulted tunnel builder.
import { describe, it, expect } from 'vitest';
import { clip, clipAll, dedupe, area, orient, leftN, circlePoly, convexOverlap, centroidOf, local, archOutline, headRise, HEAD_SEG } from '../src/castle/interior/geom';
import { prismVolume, extrudeVolume, carve, type TriBin } from '../src/castle/interior/carve';
import { buildTunnel, tunnelSection } from '../src/castle/interior/tunnel';
import { Builder } from '../src/castle/builder';
import type { V2 } from '../src/core/math2d';

const sq = (x: number, z: number, s = 2): V2[] => [[x, z], [x + s, z], [x + s, z + s], [x, z + s]];

describe('2D helpers', () => {
  it('clips convex polygons by half-planes', () => {
    const p = sq(0, 0);
    expect(area(clip(p, { n: [1, 0], c: 1 }))).toBeCloseTo(2);
    expect(clip(p, { n: [1, 0], c: 5 })).toEqual([]);
    expect(clipAll(p, [{ n: [1, 0], c: 5 }, { n: [0, 1], c: 1 }])).toEqual([]);
    expect(area(clipAll(p, [{ n: [1, 0], c: 1 }, { n: [0, 1], c: 1 }]))).toBeCloseTo(1);
  });
  it('dedupes, orients, measures', () => {
    expect(dedupe([[0, 0], [0, 0], [1, 0], [1, 1], [0, 0]])).toEqual([[0, 0], [1, 0], [1, 1]]);
    expect(area([[0, 0], [1, 0]])).toBe(0);
    const cw = [...sq(0, 0)].reverse();
    expect(orient(cw)).toEqual(sq(0, 0));
    const p0 = sq(0, 0);
    expect(orient(p0)).toBe(p0);
    expect(leftN([0, 0], [2, 0])).toEqual([-0, 1]);
    expect(area(circlePoly([0, 0], 1, 256))).toBeCloseTo(Math.PI, 2);
    expect(centroidOf(sq(2, 4))).toEqual([3, 5]);
    expect(centroidOf([[1, 1], [1, 1], [1, 1]])).toEqual([1, 1]);
    expect(local([1, 1], [1, 0], [0, 1], 2, 3)).toEqual([3, 4]);
  });
  it('tests convex overlap with a tolerance', () => {
    expect(convexOverlap(sq(0, 0), sq(1, 1))).toBe(true);
    expect(convexOverlap(sq(0, 0), sq(2, 0))).toBe(false);       // touching
    expect(convexOverlap(sq(0, 0), sq(5, 5))).toBe(false);
    expect(convexOverlap([[0, 0], [0, 0], [2, 0], [2, 2]], sq(1, 0.5))).toBe(true); // degenerate edge skipped
  });
  it('draws door heads with a fixed vertex count', () => {
    for (const head of ['round', 'pointed', 'flat', 'segmental'] as const) {
      const o = archOutline(0, 0, 1.2, 2, head);
      expect(o.length).toBe(HEAD_SEG + 3);
      const top = Math.max(...o.map((p) => p[1]));
      expect(top).toBeCloseTo(2 + headRise(head, 1.2), 5);
      expect(Math.min(...o.map((p) => p[0]))).toBeCloseTo(-0.6);
    }
    expect(headRise('flat', 1)).toBe(0);
    expect(headRise('round', 1)).toBe(0.5);
    // a low pointed head (rise below half the width) is still two-centred and symmetric
    // (the same curve as the leaves' headTop and builder.pointedArch: the apex on the centre line at h + rise)
    const p = archOutline(1, 0, 2, 2, 'pointed', 0.4);
    expect(p[2 + HEAD_SEG / 2][0]).toBeCloseTo(1, 9);
    expect(p[2 + HEAD_SEG / 2][1]).toBeCloseTo(2.4, 9);
    for (let i = 1; i < HEAD_SEG; i++) {
      const [a, b] = [p[2 + i], p[2 + HEAD_SEG - i]];
      expect(a[0] - 1).toBeCloseTo(1 - b[0], 9);
      expect(a[1]).toBeCloseTo(b[1], 9);
    }
    // gate-inner: 3.4 m wide, 1.4 m rise (2026-11-06: was lopsided, its apex 0.55 m off the centre line)
    const g = archOutline(0, 0, 3.4, 2.8, 'pointed', 1.4);
    expect(g[2 + HEAD_SEG / 2][0]).toBeCloseTo(0, 9);
  });
});

describe('carve', () => {
  const bin = (): TriBin => ({ pos: [], nor: [], uv: [] });
  const tri = (b: TriBin, a: number[], c: number[], d: number[]) => { b.pos.push(...a, ...c, ...d); b.nor.push(0, 0, 1, 0, 0, 1, 0, 0, 1); b.uv.push(0, 0, 1, 0, 0, 1); };
  const quadZ = (b: TriBin, z: number) => { tri(b, [0, 0, z], [4, 0, z], [4, 4, z]); tri(b, [0, 0, z], [4, 4, z], [0, 4, z]); };
  const areaOf = (b: TriBin) => { let s = 0; for (let i = 0; i < b.pos.length; i += 9) { const P = b.pos; const u = [P[i + 3] - P[i], P[i + 4] - P[i + 1], P[i + 5] - P[i + 2]], v = [P[i + 6] - P[i], P[i + 7] - P[i + 1], P[i + 8] - P[i + 2]]; s += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2; } return s; };

  it('removes the part of a wall inside a prism and keeps the rest', () => {
    const b = bin(); quadZ(b, 1);
    const cw = [...sq(1, 0)].reverse(); // any winding
    const r = carve([b], [prismVolume(cw, 1, 3)]);
    expect(r.removed).toBe(2);
    expect(areaOf(b)).toBeCloseTo(16 - 4, 1); // the cut keeps a 1 mm skin (coplanar tolerance)
    expect(b.uv.length / 2).toBe(b.pos.length / 3);
  });
  it('keeps faces lying on a volume boundary and ignores far volumes', () => {
    const b = bin(); quadZ(b, 0);
    carve([b], [prismVolume(sq(1, 0), 1, 3), prismVolume(sq(50, 50), 0, 9)]);
    expect(areaOf(b)).toBeCloseTo(16, 5);
    const e = bin(); quadZ(e, 1);
    expect(carve([e], [])).toEqual({ removed: 0, added: 0 });
  });
  it('grows a prism outward, so a face just outside its side is carved too', () => {
    const v = prismVolume([...sq(1, 0)].reverse(), 1, 3, 0.1); // the 2 m square x 1..3, z 0..2
    expect(Math.min(...v.pts.map((p) => p[0]))).toBeCloseTo(0.9); expect(Math.max(...v.pts.map((p) => p[2]))).toBeCloseTo(2.1);
    const face = () => { const b = bin(); tri(b, [0, 1.5, 2.05], [4, 1.5, 2.05], [4, 2.5, 2.05]); return b; }; // 5 cm outside z = 2
    const kept = face(); carve([kept], [prismVolume(sq(1, 0), 1, 3)]);
    expect(areaOf(kept)).toBeCloseTo(2, 5);
    const cut = face(); carve([cut], [v]);
    expect(areaOf(cut)).toBeLessThan(1.5);
  });
  it('extrudes outlines through a wall', () => {
    const b = bin(); quadZ(b, 1);
    const v = extrudeVolume([2, 1], [1, 0], [0, 1], archOutline(0, 0.5, 1, 1.5, 'round'), -0.5, 0.5);
    expect(v.min[2]).toBeCloseTo(0.5); expect(v.max[2]).toBeCloseTo(1.5);
    const cwOutline = [...archOutline(0, 0.5, 1, 1.5, 'round')].reverse();
    carve([b], [extrudeVolume([2, 1], [1, 0], [0, 1], cwOutline, -0.5, 0.5)]);
    expect(areaOf(b)).toBeCloseTo(16 - (1 * 1.5 + Math.PI * 0.125), 1);
  });
});

describe('buildTunnel', () => {
  it('sections a wall plus semicircular vault', () => {
    const s = tunnelSection(2, 2.6, 8, 0.3);
    expect(s[0]).toEqual([-1, -0.3]);
    expect(Math.max(...s.map((p) => p[1]))).toBeCloseTo(2.6, 1);
  });
  it('builds level runs, stepped descents and ascents, end caps with holes, ribs', () => {
    const B = new Builder();
    const path: [number, number, number][] = [[0, 0, 0], [4, 0, 0], [8, -2, 0], [12, -2, 0], [16, 0, 0], [20, 0, 0]];
    const hole: [number, number, number][] = [[20, 0.1, -0.4], [20, 0.1, 0.4], [20, 1.8, 0.4], [20, 1.8, -0.4]];
    const r = buildTunnel(B, path, { width: 1.9, crown: 2.7, caps: { end: [hole] } });
    expect(r.triangles).toBeGreaterThan(200);
    const ys = B.bins.trim.pos.filter((_, i) => i % 3 === 1);
    expect(Math.min(...ys)).toBeCloseTo(-2, 3);
    for (const k of Object.keys(B.bins) as (keyof typeof B.bins)[]) expect(B.bins[k].pos.every(Number.isFinite)).toBe(true);
    // no ribs, other materials, steeper steps allowed
    const C = new Builder();
    const r2 = buildTunnel(C, path, { width: 1.9, crown: 2.7, rib: null, wall: 'new', floor: 'old', maxRise: 0.4, arcSeg: 6 });
    expect(r2.triangles).toBeLessThan(r.triangles);
    expect(C.bins.trim.pos.length).toBe(0);
  });
});
