// Courtyard paving (castle/paving.ts): the plan from the interior doors, the path frame the shader and
// the uvs share, wall distances, the one flat polygon in the `pave` bin, and that the interior's carving
// leaves it whole. The walk onto it is key path 1 (keypaths.test.ts); the cobble texture is in texgen.test.ts.
import { describe, it, expect } from 'vitest';
import { pavingPlan, pathFrame, pavingUV, wallDistance, buildPaving, cutConvex, wellCentre, PAVE_Y, PAVE_TILE, PATH_HALF, WELL_R } from '../src/castle/paving';
import { Builder } from '../src/castle/builder';
import { buildCastle } from '../src/castle/castle';
import { buildInterior } from '../src/castle/interior';
import { planInterior } from '../src/castle/interior/plan';
import { courtyard, stairTowerPoly } from '../src/castle/layout';
import { heightAt, COURT_BED } from '../src/world/terrain';
import { FLAGS, COBBLES } from '../src/render/texgen';
import { pointInPoly, polyArea, type V2 } from '../src/core/math2d';
import { GROUND } from '../src/castle/spec';
import { surfaceAt } from '../src/player/setup';
import { mats } from './world';

const P = pavingPlan();
type Bin = Builder['bins']['pave'];
const area = (b: Bin) => {
  let s = 0;
  for (let i = 0; i < b.pos.length; i += 9) {
    const ax = b.pos[i + 3] - b.pos[i], az = b.pos[i + 5] - b.pos[i + 2], bx = b.pos[i + 6] - b.pos[i], bz = b.pos[i + 8] - b.pos[i + 2];
    s += Math.abs(ax * bz - az * bx) / 2;
  }
  return s;
};

describe('paving plan', () => {
  it('runs the flag path from the gate passage to the N wing door', () => {
    const doors = planInterior().doors, at = (id: string): V2 => { const d = doors.find((x) => x.id === id)!; return [d.centre[0], d.centre[2]]; };
    const gate = at('gate-court'), north = at(doors.find((d) => d.id.startsWith('court>N'))!.id);
    expect(P.path.o).toEqual(gate);
    expect(pathFrame(P.path, ...north)[1]).toBeCloseTo(0, 6); // the N door is on the centre line
    expect(pathFrame(P.path, ...north)[0]).toBeGreaterThan(15);
    expect(Math.hypot(...P.path.dir)).toBeCloseTo(1, 9);
    expect(P.path.hw).toBe(PATH_HALF);
    expect(() => pavingPlan([])).toThrow(/gate-court/);
  });

  it('keeps the path clear of the well and the stair tower', () => {
    for (const c of P.rounds) expect(Math.abs(pathFrame(P.path, ...c.c)[1]) - c.r).toBeGreaterThan(PATH_HALF + 0.3);
  });

  it('puts the well in the courtyard, the same every time', () => {
    const w = wellCentre();
    expect(wellCentre()).toEqual(w);
    expect(pointInPoly(courtyard(), ...w)).toBe(true);
    expect(P.rounds[1]).toEqual({ c: w, r: WELL_R });
  });

  it('measures the distance to the nearest wall foot', () => {
    const [a, b] = P.walls[0], mid: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    expect(wallDistance(P, ...mid)).toBeCloseTo(0, 6);
    const w = wellCentre();
    expect(wallDistance(P, w[0] + WELL_R + 0.5, w[1])).toBeCloseTo(0.5, 6);
    expect(wallDistance(P, w[0], w[1])).toBe(0); // inside an obstacle counts as at its foot
    const c = stairTowerPoly()[0];
    expect(wallDistance(P, ...c)).toBeLessThan(0.25); // the octagon's corner, against its inscribed circle
  });
});

describe('path frame and uvs', () => {
  it('measures along and across the path', () => {
    const { o, dir } = P.path, left: V2 = [-dir[1], dir[0]];
    const q: V2 = [o[0] + dir[0] * 3 + left[0] * 0.4, o[1] + dir[1] * 3 + left[1] * 0.4];
    const [s, t] = pathFrame(P.path, ...q);
    expect(s).toBeCloseTo(3, 9); expect(t).toBeCloseTo(0.4, 9);
  });
  it('maps the path edges onto the flag texture\'s repeat, so flags meet cobbles on a joint', () => {
    const { o, dir } = P.path, k = PAVE_TILE / FLAGS.tile;
    for (const side of [-1, 1]) {
      const q: V2 = [o[0] - dir[1] * side * PATH_HALF, o[1] + dir[0] * side * PATH_HALF];
      expect(pavingUV(P.path, ...q)[1] * k).toBeCloseTo(side > 0 ? 1 : 0, 9);
    }
    expect(FLAGS.tile).toBe(2 * PATH_HALF);
    expect(COBBLES.tile).toBe(PAVE_TILE);
    expect(pavingUV(P.path, o[0] + dir[0] * PAVE_TILE, o[1] + dir[1] * PAVE_TILE)[0]).toBeCloseTo(1, 9);
  });
});

describe('paving geometry', () => {
  it('is one flat, upward polygon over the courtyard with the stair tower and the well left out', () => {
    const B = new Builder(), n = buildPaving(B, P), bin = B.bins.pave;
    expect(n).toBe(bin.pos.length / 9);
    expect(n).toBeLessThan(200);
    for (let i = 1; i < bin.pos.length; i += 3) expect(bin.pos[i]).toBe(PAVE_Y);
    for (let i = 0; i < bin.nor.length; i += 3) expect([bin.nor[i], bin.nor[i + 1], bin.nor[i + 2]]).toEqual([0, 1, 0]);
    // winding faces up (the Bin fixes it to the normal)
    for (let i = 0; i < bin.pos.length; i += 9) {
      const ax = bin.pos[i + 3] - bin.pos[i], az = bin.pos[i + 5] - bin.pos[i + 2], bx = bin.pos[i + 6] - bin.pos[i], bz = bin.pos[i + 8] - bin.pos[i + 2];
      expect(az * bx - ax * bz).toBeGreaterThan(0);
    }
    // every point of the courtyard outside the holes is covered exactly once, and nothing else is
    const tris: V2[][] = [];
    for (let i = 0; i < bin.pos.length; i += 9) tris.push([[bin.pos[i], bin.pos[i + 2]], [bin.pos[i + 3], bin.pos[i + 5]], [bin.pos[i + 6], bin.pos[i + 8]]]);
    const ct = courtyard();
    for (let x = -16; x <= 16; x += 0.37) for (let z = -14; z <= 10; z += 0.41) {
      const want = pointInPoly(ct, x, z) && !P.holes.some((h) => pointInPoly(h, x, z));
      expect(tris.filter((t) => pointInPoly(t, x, z)).length, `${x},${z}`).toBe(want ? 1 : 0);
    }
    expect(area(bin)).toBeLessThan(polyArea(ct) - polyArea(P.holes[1]));
    // uvs are the path frame
    const v = [bin.pos[0], bin.pos[2]] as V2;
    expect([bin.uv[0], bin.uv[1]]).toEqual(pavingUV(P.path, ...v));
    // no other bin is touched
    expect(Object.entries(B.bins).filter(([k, b]) => k !== 'pave' && b.pos.length)).toEqual([]);
  });

  it('cuts a convex hole out of a convex polygon, inside or across its outline', () => {
    const sq: V2[] = [[0, 0], [4, 0], [4, 4], [0, 4]], tot = (ps: V2[][]) => ps.reduce((s, p) => s + polyArea(p), 0);
    const inner: V2[] = [[1, 1], [1, 2], [2, 2], [2, 1]]; // clockwise: either winding is fine
    expect(tot(cutConvex(sq, inner))).toBeCloseTo(15, 9);
    expect(tot(cutConvex(sq, [[3, 3], [5, 3], [5, 5], [3, 5]]))).toBeCloseTo(15, 9);
    expect(tot(cutConvex(sq, [[6, 6], [7, 6], [7, 7]]))).toBeCloseTo(16, 9);
    expect(cutConvex(sq, [[-1, -1], [5, -1], [5, 5], [-1, 5]])).toEqual([]);
  });

  it('sits where the ground was, over the earth lowered below its deepest joint', () => {
    expect(PAVE_Y).toBeCloseTo(GROUND + 0.02, 9);
    const c = courtyard(), m: V2 = [(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2];
    expect(heightAt(...m)).toBeCloseTo(COURT_BED, 6);
    expect(PAVE_Y - 0.045 - COURT_BED).toBeGreaterThan(0.1);
  });

  it('is built with the castle, kept whole by the interior carving, and is one mesh of its own', () => {
    const { builder } = buildCastle(), before = area(builder.bins.pave);
    expect(before).toBeGreaterThan(300);
    buildInterior(mats(), builder, { heightAt });
    expect(area(builder.bins.pave)).toBeCloseTo(before, 3);
    const g = builder.build(mats()), pave = g.getObjectByName('castle-pave')!;
    expect(pave).toBeDefined();
    expect(pave.castShadow).toBe(false);
    expect(pave.receiveShadow).toBe(true);
    // without a pave material (interior builders) the bin is simply not built
    const { pave: _, ...wallMats } = mats();
    expect(builder.build(wallMats).getObjectByName('castle-pave')).toBeUndefined();
  }, 120_000);

  it('sounds like stone underfoot', () => {
    expect(surfaceAt('castle-pave', 0, 0)).toBe('stone');
  });
});
