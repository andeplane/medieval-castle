import { describe, expect, test } from 'vitest';
import {
  EXPOSURE, adaptStops, apertureFrame, apertureRadiance, ceilingSkins, doorsToApertures, inPoly, meanLog2, nearestRoom, packTable, polyArea, polyDist,
  passageSkins, polyPerimeter, outdoorRevealTest, OUTDOOR_TAG, roomGridFor, fillRoomGrid, gridRoom, rayEnterPoly, roomAt, skinQuads, solveRooms, sunThrough, tagTriangles, targetStops, windowsToApertures, type Aperture, type Daylight,
} from '../src/render/interiorMath';
import type { DoorSpec, InteriorPlan, RoomSpec } from '../src/castle/interior/types';
import type { V2 } from '../src/core/math2d';

const sq = (x0: number, z0: number, x1: number, z1: number): V2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const hall: RoomSpec = { id: 'H', zone: 'T', floor: 0, kind: 'hall', poly: sq(0, 0, 12, 8), y0: 0, y1: 6 };
const ch: RoomSpec = { id: 'C', zone: 'U', floor: 0, kind: 'chamber', poly: sq(13.4, 0, 19.4, 8), y0: 0, y1: 6 };
const up: RoomSpec = { id: 'H1', zone: 'T', floor: 1, kind: 'chamber', poly: sq(0, 0, 12, 8), y0: 7, y1: 12 };
const rooms = [hall, ch, up];
const door = (d: Partial<DoorSpec>): DoorSpec => ({
  id: 'd', spaces: ['H', 'C'], centre: [12.7, 0, 5], along: [0, 1], normal: [1, 0], width: 1.2, height: 2.2, wall: 1.4,
  head: 'round', leaf: false, hinge: 'left', swingInto: 1, rebate: 0.1, kind: 'plank', ...d,
});
const day: Daylight = { sunDir: [-0.4, 0.63, 0.66], sunE: [3, 2.9, 2.7], skyL: [0.27, 0.28, 0.3], groundAlbedo: 0.18 };
// a south window of the hall: glass at z = 9.6, room face at z = 8
const southWin = { p: [6, 3, 9.6] as [number, number, number], n: [0, 0, 1] as [number, number, number], w: 0.8, h: 2, depth: 1.6, wi: 2, hi: 3, yi: -0.25, outer: 0.4 };

describe('polygons and rooms', () => {
  test('point in polygon, distance, area, perimeter', () => {
    expect(inPoly(hall.poly, 1, 1)).toBe(true);
    expect(inPoly(hall.poly, -1, 1)).toBe(false);
    expect(polyDist(hall.poly, 5, 5)).toBe(0);
    expect(polyDist(hall.poly, -2, 4)).toBeCloseTo(2);
    expect(polyDist([[0, 0], [0, 0], [1, 1]], 3, 3)).toBeGreaterThan(0); // degenerate edge
    expect(polyArea(hall.poly)).toBeCloseTo(96);
    expect(polyPerimeter(hall.poly)).toBeCloseTo(40);
  });
  test('roomAt finds the room containing a point, with slack and floors', () => {
    expect(roomAt(rooms, [5, 1.7, 4])).toBe(0);
    expect(roomAt(rooms, [16, 1.7, 4])).toBe(1);
    expect(roomAt(rooms, [5, 9, 4])).toBe(2);
    expect(roomAt(rooms, [12.7, 1.7, 5])).toBe(-1);         // in the door passage
    expect(roomAt(rooms, [12.5, 1.7, 5], 0.9)).toBe(0);     // doorway slack picks the nearer room
    expect(roomAt(rooms, [5, 20, 4])).toBe(-1);
  });
  test('nearestRoom assigns wall-thickness surfaces and prefers the group rooms', () => {
    expect(nearestRoom(rooms, [6, 3, 9.5], 4.5)).toBe(0);   // in a south embrasure
    expect(nearestRoom(rooms, [6, 3, 30], 4.5)).toBe(-1);
    expect(nearestRoom(rooms, [12.7, 1, 4], 4.5, new Set([1]))).toBe(1);
    expect(nearestRoom(rooms, [12.7, 1, 4], 4.5)).toBe(0);
    expect(nearestRoom(rooms, [6, 30, 4], 4.5)).toBe(-1);
  });
  test('rayEnterPoly', () => {
    expect(rayEnterPoly(hall.poly, [6, 9.6], [0, -1])).toBeCloseTo(1.6);
    expect(rayEnterPoly(hall.poly, [6, 4], [0, -1])).toBe(0);
    expect(rayEnterPoly(hall.poly, [6, 9.6], [0, 1])).toBe(Infinity);
  });
});

describe('apertures', () => {
  test('frame is orthonormal with cross(a, u) = nIn', () => {
    const { a, u, nIn } = apertureFrame({ n: [0, 0, 1] });
    expect(nIn).toEqual([-0, -0, -1]);
    expect(a[1] * u[2] - a[2] * u[1]).toBeCloseTo(nIn[0]);
    expect(a[0] * u[1] - a[1] * u[0]).toBeCloseTo(nIn[2]);
    const roof = apertureFrame({ n: [0, 1, 0] });
    expect(Math.abs(roof.u[1])).toBeLessThan(1e-9);
  });
  test('windows find their room and embrasure depth; others are dropped', () => {
    const aps = windowsToApertures(rooms, [
      southWin,
      { p: [6, 3, 9.6], n: [0, 0, 1], w: 0.8, h: 2 },          // depth/splay guessed
      { p: [6, 3, 40], n: [0, 0, 1], w: 0.8, h: 2 },           // too far from any room
      { p: [6, 3, 9.6], n: [0, 1, 0], w: 0.8, h: 2 },          // roof light: no horizontal ray
      { p: [6, 9, 9.6], n: [0, 0, 1], w: 0.8, h: 2, kind: 'open' },
    ]);
    expect(aps.map((a) => a.room)).toEqual([0, 0, 2]);
    expect(aps[0].depth).toBe(1.6);
    expect(aps[1].depth).toBeCloseTo(1.6);
    expect(aps[1].wi).toBeGreaterThan(0.8);
    expect(aps[2].kind).toBe('open');
  });
  test('doors become portals between rooms and daylight apertures to the outside', () => {
    const plan: InteriorPlan = {
      rooms, stairs: [],
      doors: [
        door({}),
        door({ id: 'out', spaces: ['outside', 'H'], centre: [3, 0, -1], along: [1, 0], normal: [0, 1], wall: 2, leaf: true }),
        door({ id: 'grille', spaces: ['H', 'courtyard'], centre: [3, 0, 9], along: [1, 0], normal: [0, 1], wall: 2, kind: 'grille', leaf: true }),
        door({ id: 'g2', spaces: ['H', 'C'], kind: 'grille' }),
        door({ id: 'nowhere', spaces: ['X', 'Y'] }),
      ],
    };
    const idx = new Map(rooms.map((r, i) => [r.id, i]));
    const aps = doorsToApertures(plan, idx);
    const by = (id: string) => aps.filter((a) => a.door === id);
    expect(by('d').map((a) => [a.kind, a.room, a.other])).toEqual([['portal', 0, 1], ['portal', 1, 0]]);
    expect(by('out')).toHaveLength(1);
    expect(by('out')[0]).toMatchObject({ kind: 'open', room: 0, open: 0 });
    expect(by('out')[0].n[2]).toBe(-1);             // points out of the hall, to the north
    expect(by('grille')[0]).toMatchObject({ kind: 'grille', open: 1 });
    expect(by('grille')[0].n[2]).toBe(1);
    expect(by('g2').every((a) => a.kind === 'portal')).toBe(true);
    expect(by('nowhere')).toHaveLength(0);
  });
});

describe('daylight', () => {
  test('sun-side windows look brighter; radiance is positive', () => {
    const s = apertureRadiance([0, 0, 1], day), n = apertureRadiance([0, 0, -1], day);
    expect(s[0]).toBeGreaterThan(n[0]);
    expect(n[0]).toBeGreaterThan(0);
    expect(apertureRadiance([0, 0, 1], { ...day, sunDir: [0, 1, 0] })[0]).toBeGreaterThan(0);
  });
  test('sunThrough: zero from behind, partial through a deep embrasure, more through a shallow one', () => {
    const [ap] = windowsToApertures(rooms, [southWin]);
    expect(sunThrough(ap, [0, 0.5, -0.86])).toBe(0);
    const deep = sunThrough(ap, day.sunDir);
    expect(deep).toBeGreaterThan(0);
    expect(deep).toBeLessThan(0.6);
    expect(sunThrough({ ...ap, depth: 0.2, outer: 0 }, day.sunDir)).toBeGreaterThan(deep);
  });
  test('solveRooms: lit rooms get bounce, portals and stair links carry light on', () => {
    const plan: InteriorPlan = { rooms, doors: [door({})], stairs: [] };
    const idx = new Map(rooms.map((r, i) => [r.id, i]));
    const aps: Aperture[] = [...windowsToApertures(rooms, [southWin]), ...doorsToApertures(plan, idx)];
    const dark = solveRooms(rooms, aps, day, [1]);
    expect(dark.light[0].bounce[0]).toBeGreaterThan(0);
    expect(dark.light[1].bounce[0]).toBeGreaterThan(0);                  // through the doorway
    expect(dark.light[1].bounce[0]).toBeLessThan(dark.light[0].bounce[0]);
    expect(dark.light[2].bounce[0]).toBe(0);
    const linked = solveRooms(rooms, aps, day, [1], [{ a: 0, b: 2, area: 2 }]);
    expect(linked.light[2].bounce[0]).toBeGreaterThan(0);                // up the stair
    const shut = solveRooms(rooms, aps.map((a) => (a.kind === 'portal' ? { ...a, open: 0 } : a)), day, [1]);
    expect(shut.light[1].bounce[0]).toBe(0);
    const shaded = solveRooms(rooms, aps, day, [0]);
    expect(shaded.light[0].bounce[0]).toBeLessThan(dark.light[0].bounce[0]);
  });
});

describe('exposure maths', () => {
  test('target stops: none outdoors, capped in rooms, deeper underground', () => {
    expect(targetStops(0, false)).toBe(0);
    expect(targetStops(EXPOSURE.refLog2, false)).toBe(0);
    expect(targetStops(-20, false)).toBe(EXPOSURE.maxStops);
    expect(targetStops(-20, true)).toBe(EXPOSURE.deepStops);
    const mid = targetStops(EXPOSURE.refLog2 - 1, false);
    expect(mid).toBeCloseTo(EXPOSURE.strength);
    // indoors the eye may also close a little below the exterior's exposure, next to a fire
    expect(targetStops(0, false, EXPOSURE, true)).toBe(EXPOSURE.minInside);
    expect(targetStops(EXPOSURE.refLog2 + 0.5, false, EXPOSURE, true)).toBeCloseTo(-0.5 * EXPOSURE.strength);
    expect(targetStops(0, true, EXPOSURE, false)).toBe(0); // outdoors: never below 0.72
  });
  test('adaptation is exponential, slower into the dark than into the light', () => {
    const up = adaptStops(0, 2, 0.5), down = adaptStops(2, 0, 0.5);
    expect(up).toBeGreaterThan(0); expect(up).toBeLessThan(2);
    expect(2 - down).toBeGreaterThan(up);                                 // brightening is faster
    let s = 0; for (let i = 0; i < 600; i++) s = adaptStops(s, 2, 1 / 60);
    expect(s).toBeGreaterThan(1.9);                                       // ~10 s: fully adapted
  });
  test('meanLog2 decodes the log-luminance grid with centre weighting', () => {
    const px = new Uint8Array(4 * 4 * 4).fill(0);
    for (let i = 0; i < 16; i++) px[i * 4] = Math.round((12 / 18) * 255);  // log2 L = -2
    expect(meanLog2(px, 4, 4)).toBeCloseTo(-2, 1);
  });
});

describe('bake helpers', () => {
  test('tagTriangles: floor, wall and embrasure triangles find their room; normals optional', () => {
    const pos = new Float32Array([
      1, 0, 1, 2, 0, 1, 1, 0, 2,          // floor of the hall
      15, 0, 1, 16, 0, 1, 15, 0, 2,       // floor of the chamber
      50, 0, 50, 51, 0, 50, 50, 0, 51,    // outside everything
    ]);
    const nor = new Float32Array(27); for (let i = 0; i < 9; i++) nor[i * 3 + 1] = 1;
    expect(Array.from(tagTriangles(pos, nor, rooms, 4.5))).toEqual([0, 0, 0, 1, 1, 1, -1, -1, -1]);
    expect(Array.from(tagTriangles(pos, null, rooms, 4.5)).slice(0, 6)).toEqual([0, 0, 0, 1, 1, 1]);
  });
  test('packTable writes count, bounce and the brightest apertures per room', () => {
    const aps = windowsToApertures(rooms, [southWin, { ...southWin, p: [2.5, 3, 9.6] }, { ...southWin, p: [16.4, 3, 9.6] }]);
    aps.push({ ...aps[0], id: 'stray', room: 99 });
    const solved = solveRooms(rooms, aps.slice(0, 3), day, [1, 1, 1]);
    const W = 1 + 2 * 5, data = new Float32Array(W * 3 * 4);
    packTable(data, W, 1, 3, aps, { light: solved.light, radiance: [...solved.radiance, [0, 0, 0]] });
    expect(data[0]).toBe(1);                         // capped at maxAp = 1
    expect(data[1]).toBeCloseTo(solved.light[0].bounce[0]);
    expect(data[4 + 3]).toBeCloseTo(1.6);                  // depth of the first aperture
    expect(data[W * 4]).toBe(1);                     // the chamber has its window
    expect(data[2 * W * 4]).toBe(0);                 // the upper room has none
  });
  test('skinQuads: one quad per wall, holes where the apertures pass, none for strangers', () => {
    const plan: InteriorPlan = { rooms: [hall], doors: [door({ id: 'out', spaces: ['outside', 'H'], centre: [3, 0, -1], along: [1, 0], normal: [0, 1], wall: 2 })], stairs: [] };
    const aps = [...windowsToApertures([hall], [southWin, { ...southWin, p: [6.3, 3, 9.6] }, { ...southWin, p: [6, 3, 9.6], depth: 0.1 }]), ...doorsToApertures(plan, new Map([['H', 0]]))];
    aps.push({ ...aps[0], room: 5 });
    aps.push({ ...aps[0], c: [6, 3, 12], depth: 1.6 });     // off the wall line
    const q = skinQuads([hall], aps, 0.22);
    expect(q).toHaveLength(4);
    const south = q.find((x) => x.n[2] < -0.9)!, north = q.find((x) => x.n[2] > 0.9)!;
    expect(south.holes).toHaveLength(1);                 // overlapping holes are merged away
    expect(north.holes).toHaveLength(1);                 // the door
    expect(south.L).toBeCloseTo(12.44);
    const deg = skinQuads([{ ...hall, poly: [[0, 0], [0, 0], [12, 0], [12, 8], [0, 8]] }], [], 0.22);
    expect(deg).toHaveLength(4);
    // a counter-clockwise polygon gives the same inward normals
    const ccw = skinQuads([{ ...hall, poly: [...hall.poly].reverse() }], [], 0.22);
    expect(ccw.every((x) => inPoly(hall.poly, x.o[0] + x.r[0] * 1 + x.n[0] * 0.5, x.o[2] + x.r[2] * 1 + x.n[2] * 0.5))).toBe(true);
  });
  test('passageSkins: a lidded tube through each door passage, a splayed one round each embrasure', () => {
    const isRoom = (id: string) => id === 'H' || id === 'C';
    const doors = [door({}), door({ id: 'out', spaces: ['outside', 'H'], centre: [3, 0, -0.7], along: [1, 0], normal: [0, 1], head: 'flat' }), door({ id: 'far', spaces: ['outside', 'courtyard'] })];
    const win = windowsToApertures([hall], [southWin]);
    const f = passageSkins(doors, isRoom, [...win, ...doorsToApertures({ rooms: [hall, ch], doors, stairs: [] }, new Map([['H', 0], ['C', 1]]))]);
    expect(f).toHaveLength(3 + 3 + 8); // two doors (sides + lid, no floor), one window (outer reveal + splay)
    const xs = (q: number[][]) => q.map((p) => p[0]);
    // through the wall to just behind both faces (wall 1.4), as wide as the skins' hole
    expect(Math.min(...f.slice(0, 3).flatMap(xs))).toBeCloseTo(12.7 - 0.7 + 0.02);
    expect(Math.max(...f.slice(0, 3).flatMap(xs))).toBeCloseTo(12.7 + 0.7 - 0.02);
    expect(Math.max(...f.slice(0, 3).flatMap((q) => q.map((p) => p[1])))).toBeCloseTo(2.2 + 0.6 + 0.05); // round head
    // to the outside: stops just inside the outer face
    expect(Math.min(...f.slice(3, 6).flatMap((q) => q.map((p) => p[2])))).toBeCloseTo(-0.7 - 0.7 + 0.02);
    expect(passageSkins([door({ wall: 0 })], isRoom, [])).toHaveLength(3);
    // the window tube widens from the glass (w + 0.1) towards the room
    const wz = f.slice(6).flatMap((q) => q.map((p) => p[2])), wx = f.slice(6).flatMap(xs);
    expect(Math.max(...wz)).toBeCloseTo(9.6 + 0.38);
    expect(Math.max(...wx) - 6).toBeGreaterThan(0.45);
    expect(passageSkins([], isRoom, [{ ...win[0], depth: 0.01 }])).toHaveLength(8); // no depth: no splay
  });
  test('ceilingSkins sit above each room and grow its outline', () => {
    const [c] = ceilingSkins([hall], 0.5, 0.2);
    expect(c.y).toBe(6.5);
    expect(c.poly[0][0]).toBeLessThan(0);
  });
});

describe('room grid', () => {
  test('a point in a room finds it; a point in a doorway or reveal finds the room beside it', () => {
    const g = fillRoomGrid(roomGridFor(rooms), rooms);
    expect(gridRoom(g, [5, 3, 4])).toBe(0);
    expect(gridRoom(g, [16, 3, 4])).toBe(1);
    expect(gridRoom(g, [5, 9, 4])).toBe(2);
    // the 1.4 m wall between the hall (x < 12) and the chamber (x > 13.4): its two halves
    expect(gridRoom(g, [12.3, 1, 5])).toBe(0);
    expect(gridRoom(g, [13.2, 1, 5])).toBe(1);
    expect(gridRoom(g, [-40, 1, 5])).toBe(-1); // outside the grid: clamped to its empty edge
    expect(g.size.every((n) => n >= 1)).toBe(true);
    const none = roomGridFor([]);
    expect(none.size).toEqual([1, 1, 1]);
    expect(gridRoom(fillRoomGrid(none, []), [0, 0, 0])).toBe(-1);
  });
});

describe('outdoor doorway reveals', () => {
  test('the outer half of an outdoor doorway is the sky\'s, the inner half its room\'s', () => {
    // a courtyard door in the hall's east wall: the courtyard (spaces[0]) east of it, the normal points west into the hall
    const d = door({ id: 'court>H', spaces: ['courtyard', 'H'], centre: [12.7, 0, 5], normal: [-1, 0], along: [0, 1], wall: 1.4 });
    const out = outdoorRevealTest([d, door({})]);
    expect(out([13.2, 1, 5])).toBe(true);      // courtyard half, jamb height
    expect(out([13.3, 2.6, 5.4])).toBe(true);  // soffit
    expect(out([12.2, 1, 5])).toBe(false);     // hall half
    expect(out([13.2, 1, 9])).toBe(false);     // beside the door, in the wall
    expect(out([13.2, 6, 5])).toBe(false);     // above the head
    // tagging: a jamb triangle facing across the passage, on each half
    const tri = (x: number) => new Float32Array([x, 0.5, 4.4, x + 0.2, 0.5, 4.4, x, 1.5, 4.4]);
    expect(tagTriangles(tri(13.1), null, rooms, 4.5, undefined, out)[0]).toBe(OUTDOOR_TAG);
    expect(tagTriangles(tri(12.1), null, rooms, 4.5, undefined, out)[0]).toBe(0);
    // the other way round (spaces[1] outdoors) and an indoor door: never the sky's
    const d2 = door({ id: 'H>court', spaces: ['H', 'courtyard'], centre: [12.7, 0, 5], normal: [1, 0], along: [0, 1], wall: 1.4 });
    expect(outdoorRevealTest([d2])([13.2, 1, 5])).toBe(true);
    expect(outdoorRevealTest([door({})])([13.2, 1, 5])).toBe(false);
    // a leaf shut against a rebate 0.1 m in from the hall's face: the stone up to the leaf is the courtyard's
    const leafy = outdoorRevealTest([{ ...d, leaf: true, swingInto: 1, rebate: 0.1 }]);
    expect(leafy([12.2, 1, 5])).toBe(true);
    expect(leafy([12.05, 1, 5])).toBe(false);                    // behind the leaf
    expect(leafy([12.12, 1, 5], [1, 0, 0])).toBe(true);          // the stop, facing the courtyard
    expect(leafy([12.12, 1, 5], [-1, 0, 0])).toBe(false);        // facing the hall
  });
});
