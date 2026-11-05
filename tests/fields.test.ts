// The field patchwork is a pure function of the injected deps, fields keep a plausible size, and the
// raster the terrain shader reads agrees with the layout.
import { describe, it, expect } from 'vitest';
import { fieldLayout, bakeFieldMap, fieldIndexAt, segDist, CROPS, FIELD_EXTENT, type FieldLayout } from '../src/world/fields';
import { seededDeps } from '../src/world/deps';
import { polyArea, type V2 } from '../src/core/math2d';
import { fakeDeps } from './fakes';

const quad = (L: FieldLayout, i: number, j: number): V2[] => {
  const P = (a: number, b: number) => L.pts[b * (L.cols + 1) + a];
  return [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)];
};
const centre = (q: V2[]): V2 => [q.reduce((s, p) => s + p[0], 0) / 4, q.reduce((s, p) => s + p[1], 0) / 4];

describe('field patchwork', () => {
  const L = fieldLayout(seededDeps(1187));

  it('is a pure function of the deps', () => {
    expect(bakeFieldMap(fieldLayout(seededDeps(1187)), 128)).toEqual(bakeFieldMap(fieldLayout(seededDeps(1187)), 128));
    expect(fieldLayout(seededDeps(2)).pts[100]).not.toEqual(L.pts[100]);
    expect(fieldLayout(fakeDeps()).pts[100]).toEqual(fieldLayout(fakeDeps()).pts[100]);
  });

  it('has fields of 1–6 ha with every crop present and hedges between them', () => {
    const areas: number[] = [];
    for (let j = 0; j < L.rows; j++) for (let i = 0; i < L.cols; i++) areas.push(Math.abs(polyArea(quad(L, i, j))));
    areas.sort((x, y) => x - y);
    const median = areas[areas.length >> 1];
    expect(median).toBeGreaterThan(10000);
    expect(median).toBeLessThan(60000);
    expect(new Set(L.fields.map((f) => f.crop)).size).toBe(CROPS.length);
    expect(L.hedges.length).toBeGreaterThan(L.fields.length);
    expect(L.hedges.some((h) => h.lane)).toBe(true);
    expect(L.lanes).toHaveLength(2);
  });

  it('finds the field under a point', () => {
    for (const [i, j] of [[L.cols >> 1, L.rows >> 1], [10, 12], [L.cols - 20, 30]]) {
      const [x, z] = centre(quad(L, i, j));
      expect(fieldIndexAt(L, x, z)).toBe(L.quadField[j * L.cols + i]);
    }
    expect(fieldIndexAt(L, 1e6, 1e6)).toBe(-1);
  });

  it('bakes crops, hedge and lane distances into the raster', () => {
    const N = 256, m = bakeFieldMap(L, N), texel = (2 * FIELD_EXTENT) / N;
    const at = (x: number, z: number) => (Math.floor((z + FIELD_EXTENT) / texel) * N + Math.floor((x + FIELD_EXTENT) / texel)) * 4;
    const [x, z] = centre(quad(L, L.cols >> 1, L.rows >> 1)), o = at(x, z);
    expect(Math.floor((m[o] / 255) * 8)).toBe(L.fields[L.quadField[(L.rows >> 1) * L.cols + (L.cols >> 1)]].crop);
    let hedge = 0, lane = 0;
    for (let k = 0; k < N * N; k++) { if (m[k * 4 + 1] < 64) hedge++; if (m[k * 4 + 2] < 64) lane++; }
    expect(hedge).toBeGreaterThan(N * N * 0.05);
    expect(lane).toBeGreaterThan(0);
  });

  it('measures distance to a segment', () => {
    expect(segDist(0, 1, [-1, 0], [1, 0])).toBeCloseTo(1);
    expect(segDist(3, 0, [-1, 0], [1, 0])).toBeCloseTo(2);
    expect(segDist(2, 2, [2, 2], [2, 2])).toBe(0);
  });
});
