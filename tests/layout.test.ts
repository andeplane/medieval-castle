// Guards for the requirements in docs/BRIEF.md. If a layout tweak breaks one, this fails.
import { describe, it, expect } from 'vitest';
import { polyArea, cornerAngles, edgeDist, pointInPoly, type V2 } from '../src/core/math2d';
import { outerPoly, courtyard, rooms, islandOutline, moatOuter, footprints, wingQuads } from '../src/castle/layout';
import { FLOOR_HEIGHTS, ROOF_LEVEL, TOWERS } from '../src/castle/spec';

describe('castle layout', () => {
  it('has 7 floors reaching roughly 36 m', () => {
    expect(FLOOR_HEIGHTS.length).toBe(7);
    expect(ROOF_LEVEL).toBeGreaterThan(33);
    expect(ROOF_LEVEL).toBeLessThan(40);
  });

  it('has about 1000 m² usable per floor', () => {
    const gross = polyArea(outerPoly()) - polyArea(courtyard());
    const net = gross * 0.78; // walls, stairs and corridors take ~22%
    expect(gross).toBeGreaterThan(1100);
    expect(gross).toBeLessThan(1600);
    expect(net).toBeGreaterThan(900);
    expect(net).toBeLessThan(1250);
  });

  it('has 20 rooms per floor, none tiny and no two alike', () => {
    const rs = rooms();
    expect(rs.length).toBe(20);
    const areas = rs.map((r) => polyArea(r.poly));
    for (const a of areas) { expect(a).toBeGreaterThan(30); expect(a).toBeLessThan(130); }
    expect(new Set(areas.map((a) => a.toFixed(1))).size).toBe(20);
  });

  it('has no right angles and wings of different depth and height', () => {
    for (const a of cornerAngles(outerPoly())) expect(Math.abs(a - 90)).toBeGreaterThan(0.15);
    const ws = wingQuads();
    expect(new Set(ws.map((w) => w.depth)).size).toBe(4);
    expect(new Set(ws.map((w) => w.top)).size).toBe(4);
    expect(new Set(TOWERS.map((t) => t.top)).size).toBe(TOWERS.length);
  });

  it('leaves a walkable ring between the castle and the moat all the way round', () => {
    const isl = islandOutline();
    let min = 1e9;
    for (const poly of footprints()) for (const p of poly) min = Math.min(min, edgeDist(isl, p[0], p[1]).d);
    expect(min).toBeGreaterThan(5);
    for (const poly of footprints()) for (const p of poly) expect(pointInPoly(isl, p[0], p[1])).toBe(true);
  });

  it('keeps the island modest and the moat irregular', () => {
    const isl = islandOutline(), moat = moatOuter(isl);
    const a = polyArea(isl);
    expect(a).toBeGreaterThan(6000);
    expect(a).toBeLessThan(11000);
    const widths = isl.map((p, i) => Math.hypot(moat[i][0] - p[0], moat[i][1] - p[1]));
    expect(Math.min(...widths)).toBeGreaterThan(10);
    expect(Math.max(...widths) - Math.min(...widths)).toBeGreaterThan(8);
    const radii = isl.map((p: V2) => Math.hypot(p[0], p[1]));
    expect(Math.max(...radii) / Math.min(...radii)).toBeGreaterThan(1.25);
  });
});
