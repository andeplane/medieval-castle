import { describe, expect, test } from 'vitest';
import { createVisibility, roomShown, visContext, visibleSet, type GroupInfo } from '../src/world/visibility';
import type { InteriorGroup, InteriorPlan, RoomSpec, V3 } from '../src/castle/interior/types';
import type { V2 } from '../src/core/math2d';
import type { Aperture } from '../src/render/interiorMath';

const sq = (x0: number, z0: number, x1: number, z1: number): V2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const room = (id: string, zone: string, floor: number, poly: V2[], y0: number): RoomSpec => ({ id, zone, floor, kind: 'chamber', poly, y0, y1: y0 + 4 });
// N wing floors 0..3 along x 0..20; E wing next to it (x 20..30); a far tower; a tunnel under the moat
const rooms: RoomSpec[] = [
  room('N0', 'N', 0, sq(0, 0, 20, 8), 3), room('N1', 'N', 1, sq(0, 0, 20, 8), 8), room('N2', 'N', 2, sq(0, 0, 20, 8), 13), room('N3', 'N', 3, sq(0, 0, 20, 8), 18),
  room('E0', 'E', 0, sq(20.5, 0, 30, 8), 3), room('E3', 'E', 3, sq(20.5, 0, 30, 8), 18),
  room('T0', 'great', 0, sq(-80, -80, -70, -70), 3), room('tunnel-1', 'tunnel', -1, sq(0, 10, 4, 40), -6),
];
const plan: InteriorPlan = {
  rooms,
  doors: [
    { id: 'd', spaces: ['N0', 'T0'], centre: [0, 3, 4], along: [0, 1], normal: [-1, 0], width: 1, height: 2, wall: 1, head: 'flat', leaf: true, hinge: 'left', swingInto: 0, rebate: 0.1, kind: 'plank' },
    { id: 'x', spaces: ['N0', 'ghost'], centre: [0, 3, 4], along: [0, 1], normal: [-1, 0], width: 1, height: 2, wall: 1, head: 'flat', leaf: true, hinge: 'left', swingInto: 0, rebate: 0.1, kind: 'plank' },
  ],
  stairs: [{ id: 's', kind: 'straight', zone: 'tunnel', spaces: ['N0', 'tunnel-1', 'ghost'], width: 1.2, landings: [] }],
};
const box = (min: V3, max: V3) => ({ min, max });
const G = (key: string, zone: string, floor: number, b: { min: V3; max: V3 }, r: number[], aps: GroupInfo['apertures'] = []): GroupInfo => ({ key, zone, floor, ...b, rooms: r, apertures: aps });
const groups: GroupInfo[] = [
  G('N:0', 'N', 0, box([-2, 3, -2], [22, 7, 10]), [0], [{ p: [10, 5, 10], n: [0, 0, 1], open: false }]),
  G('N:1', 'N', 1, box([-2, 8, -2], [22, 12, 10]), [1]),
  G('N:2', 'N', 2, box([-2, 13, -2], [22, 17, 10]), [2]),
  G('N:3', 'N', 3, box([-2, 18, -2], [22, 22, 10]), [3], [{ p: [10, 20, -2], n: [0, 0, -1], open: false }]),
  G('E:0', 'E', 0, box([20.5, 3, 0], [30, 7, 8]), [4]),
  G('E:3', 'E', 3, box([20.5, 18, 0], [30, 22, 8]), [5]),
  G('great:0', 'great', 0, box([-80, 3, -80], [-70, 7, -70]), [6], [{ p: [-75, 4, -70], n: [0, 0, 1], open: true }]),
  G('tunnel:-1', 'tunnel', -1, box([0, -6, 10], [4, -2, 40]), [7], [{ p: [2, -4, 40], n: [0, 0, 1], open: true }]),
  G('stairs:s', 'stairs', -1, box([0, -6, 8], [4, 7, 12]), []),
  G('doors', 'doors', -1, box([-80, 0, -80], [30, 22, 40]), []),
];
const ctx = visContext(plan, groups);
const shown = (r: ReturnType<typeof visibleSet>) => groups.filter((_, i) => r.visible[i]).map((g) => g.key);

describe('visibleSet', () => {
  test('zone and door adjacency', () => {
    expect(ctx.zoneAdj.get('N')).toEqual(new Set(['great', 'E']));
    expect(ctx.doorAdj.get(0)).toEqual(new Set([6, 7]));
  });
  test('inside a room: own floor, the floors above and below, adjacent zones at that height, door neighbours, stairs', () => {
    const r = visibleSet(ctx, [10, 4.7, 4]);
    expect(r).toMatchObject({ room: 0, inside: true, underground: false });
    expect(shown(r)).toEqual(['N:0', 'N:1', 'E:0', 'great:0', 'tunnel:-1', 'stairs:s', 'doors']);
    const top = visibleSet(ctx, [10, 19.7, 4]);
    expect(shown(top)).toEqual(['N:2', 'N:3', 'E:3', 'stairs:s', 'doors']);
  });
  test('deep inside: no open way out within reach; doorway slack', () => {
    expect(visibleSet(ctx, [10, 19.7, 4]).deep).toBe(true);
    expect(visibleSet(ctx, [-75, 4.7, -75]).deep).toBe(false);          // next to its open door
    expect(visibleSet(ctx, [20.2, 4.7, 4]).room).toBeGreaterThanOrEqual(0); // in the wall between N and E
  });
  test('outside: only groups within 60 m whose windows face the camera', () => {
    const south = visibleSet(ctx, [10, 4, 30]);
    expect(south.inside).toBe(false);
    expect(shown(south)).toEqual(['N:0', 'stairs:s', 'doors']);
    expect(shown(visibleSet(ctx, [2, 0, 60]))).toEqual(['N:0', 'tunnel:-1', 'doors']); // facing its grille
    const north = visibleSet(ctx, [10, 20, -30]);
    expect(shown(north)).toEqual(['N:3', 'doors']);
    expect(shown(visibleSet(ctx, [500, 4, 500]))).toEqual([]);
    expect(shown(visibleSet(ctx, [2, 0, 10.5]))).toContain('stairs:s');   // close to the stair
  });
  test('underground hides the landscape', () => {
    const r = visibleSet(ctx, [2, -4, 30], { far: 60, stairs: 30, deepClear: 40, ground: () => 2.6 });
    expect(r).toMatchObject({ room: 7, underground: true, deep: true });
    expect(visibleSet(ctx, [10, 4, 30], { far: 60, stairs: 30, deepClear: 40, ground: () => 2.6 }).underground).toBe(false);
  });
  test('roomShown for dynamic objects', () => {
    const r = visibleSet(ctx, [10, 4.7, 4]);
    expect(roomShown(ctx, r, 0)).toBe(true);
    expect(roomShown(ctx, r, 6)).toBe(true);    // door neighbour
    expect(roomShown(ctx, r, 3)).toBe(false);
    expect(roomShown(ctx, r, 1)).toBe(true);    // via its group
    expect(roomShown(ctx, r, -1)).toBe(true);   // outside, not deep
    expect(roomShown(ctx, visibleSet(ctx, [10, 19.7, 4]), -1)).toBe(false);
  });
});

describe('createVisibility', () => {
  const mkGroups = (): InteriorGroup[] => groups.filter((g) => g.key !== 'doors').map((g) => ({
    key: g.key, zone: g.zone, floor: g.floor, rooms: g.rooms.map((i) => rooms[i].id),
    bounds: { min: { x: g.min[0], y: g.min[1], z: g.min[2] }, max: { x: g.max[0], y: g.max[1], z: g.max[2] } } as never,
    object: { visible: true } as never,
  }));
  test('toggles groups, outdoor objects by name and registered dynamic objects', () => {
    const camera = { position: { x: 10, y: 4.7, z: 4 } };
    const named: Record<string, { name: string; visible: boolean }> = {
      water: { name: 'water', visible: true }, trees: { name: 'trees', visible: true }, 'terrain-far': { name: 'terrain-far', visible: true },
    };
    const scene = { getObjectByName: (n: string) => named[n] };
    const ig = mkGroups();
    const apertures = [{ group: 'great:0', kind: 'open', c: [-75, 4, -70], n: [0, 0, 1] }, { group: 'N:0', kind: 'portal', c: [0, 0, 0], n: [1, 0, 0] }] as unknown as Aperture[];
    const vis = createVisibility(camera, ig, plan, { scene, apertures, ground: () => 2.6 });
    expect(vis.roomId).toBe(null);
    const npc = { visible: false }, outsider = { visible: false };
    let npcRoom: string | null = 'N3';
    const off = vis.register(npc, () => npcRoom);
    vis.register(outsider, () => null);
    expect(outsider.visible).toBe(true);
    vis.update();
    expect(vis.roomId).toBe('N0');
    expect(ig.find((g) => g.key === 'N:3')!.object.visible).toBe(false);
    expect(npc.visible).toBe(false);
    npcRoom = 'N1'; vis.update();
    expect(npc.visible).toBe(true);
    off(); npcRoom = 'N3'; vis.update();
    expect(npc.visible).toBe(true);                       // no longer managed
    camera.position = { x: 2, y: -4, z: 30 }; vis.update();
    expect(vis.state.underground).toBe(true);
    expect(named.water.visible).toBe(false); expect(named.trees.visible).toBe(false);
    expect(outsider.visible).toBe(false);
    camera.position = { x: 10, y: 19.7, z: 4 }; vis.update();
    expect(vis.state.deep).toBe(true);
    expect(named.water.visible).toBe(true); expect(named.trees.visible).toBe(false);
    camera.position = { x: 10, y: 4, z: 30 }; vis.update();
    expect(named.trees.visible).toBe(true);
  });
  test('works without scene or apertures', () => {
    const vis = createVisibility({ position: { x: 10, y: 4, z: 30 } }, mkGroups(), plan);
    expect(vis.update().inside).toBe(false);
  });
});
