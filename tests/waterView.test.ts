import { describe, expect, test } from 'vitest';
import { reachesWater, openingPoints, waterInView, type Opening, type WaterView } from '../src/world/waterView';
import type { V3 } from '../src/castle/interior/types';

// A wall along z = 0 with a window in it, the moat (ground at -1) from z = -3 outward, a bank (ground 2) nearer.
const moat = (_x: number, z: number) => (z < -3 ? -1 : 2);
const win: Opening = { c: [0, 5, 0], n: [0, 0, -1], w: 1, h: 2, ahead: 0.3 };
const view = (o: Partial<WaterView>): WaterView => ({ eye: [0, 5, 2], planes: [], corners: [], outdoors: false, openings: [win], ...o });

describe('lines to the water', () => {
  test('meet it where the ground is below the water; stop under the ground or rising clear of it', () => {
    expect(reachesWater([0, 5, 0], [0, -0.6, -0.8], moat)).toBe(true);
    expect(reachesWater([0, 5, 0], [0, -0.99, -0.1], moat)).toBe(false);             // into the bank
    expect(reachesWater([0, 5, 0], [0, 0, -1], moat)).toBe(false);                   // level: never down
    expect(reachesWater([0, 5, 0], [0, -0.01, -1], () => 10)).toBe(false);          // under ground at once
    expect(reachesWater([0, 5, 0], [0, -0.0001, -1], moat, 50)).toBe(false);        // out of reach
  });
  test('points across an opening, corners included', () => {
    const p = openingPoints(win);
    expect(p).toHaveLength(16);
    expect(p).toContainEqual([-0.5, 4, 0]);
    expect(p).toContainEqual([0.5, 6, 0]);
    expect(openingPoints({ c: [0, 0, 0], n: [2, 0, 0], w: 2, h: 2 }, 2)).toContainEqual([0, 1, 1] as V3);
    expect(openingPoints({ c: [0, 0, 0], n: [0, 0, 0], w: 2, h: 2 }, 2)).toContainEqual([0, 1, 0] as V3); // no normal: a point
  });
});

describe('waterInView', () => {
  test('outdoors: unless the whole frustum looks level or up', () => {
    expect(waterInView(view({ outdoors: true, corners: [[0, 0.1, -1], [0, -0.1, -1]] }), moat)).toBe(true);
    expect(waterInView(view({ outdoors: true, corners: [[0, 0.1, -1], [0, 0.2, -1]] }), moat)).toBe(false);
    expect(waterInView(view({ outdoors: true, eye: [0, 0, 0], corners: [[0, 1, 0]] }), moat)).toBe(true); // at the water
  });
  test('indoors: through an opening in view whose lines reach the water', () => {
    expect(waterInView(view({}), moat)).toBe(true);
    expect(waterInView(view({ openings: [] }), moat)).toBe(false);
    // out of view (behind a plane), or looked at from outside it, or through a reveal too deep to see down
    expect(waterInView(view({ planes: [{ normal: { x: 0, y: 0, z: 1 }, constant: -5 }] }), moat)).toBe(false);
    expect(waterInView(view({ eye: [0, 5, -2] }), moat)).toBe(false);
    expect(waterInView(view({ openings: [{ ...win, ahead: 3 }], eye: [0, 5, 1] }), moat)).toBe(false);
    expect(waterInView(view({ openings: [{ ...win, ahead: undefined }] }), moat)).toBe(true);
    // standing in it
    expect(waterInView(view({ eye: [0.2, 5.1, 0.1] }), () => 10)).toBe(true);
    expect(waterInView(view({ eye: [0.2, 5.1, 0.1], openings: [{ ...win, ahead: undefined }] }), () => 10)).toBe(true);
    // nothing but bank below
    expect(waterInView(view({}), () => 2)).toBe(false);
  });
});
