import { describe, expect, test } from 'vitest';
import { cameraSpaces, createVisibility, doorwaySpaces, drawnSpaces, roomGraph, spaceShown, visibleSet, windowLinks, type VisContext } from '../src/world/visibility';
import type { DoorSpec, InteriorGroup, InteriorPlan, RoomSpec, V3 } from '../src/castle/interior/types';
import type { V2 } from '../src/core/math2d';
import type { Aperture } from '../src/render/interiorMath';

const sq = (x0: number, z0: number, x1: number, z1: number): V2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const room = (id: string, zone: string, floor: number, poly: V2[], y0: number): RoomSpec => ({ id, zone, floor, kind: 'chamber', poly, y0, y1: y0 + 4 });
const door = (id: string, spaces: [string, string], centre: V3, o: Partial<DoorSpec> = {}): DoorSpec => ({ id, spaces, centre, along: [0, 1], normal: [1, 0], width: 1, height: 2, wall: 1, head: 'flat', leaf: true, hinge: 'left', swingInto: 1, rebate: 0.1, kind: 'plank', ...o });
// A row of rooms along x (A | B | C | D | E), the courtyard west of A, a cellar under A by a stair, a tower
// room F off E by an open arch, a tunnel off the cellar to the far bank, and a gate from outside into A.
const rooms: RoomSpec[] = [
  room('A', 'N', 0, sq(0, 0, 10, 8), 3), room('B', 'N', 0, sq(11, 0, 20, 8), 3), room('C', 'E', 0, sq(21, 0, 30, 8), 3),
  room('D', 'E', 0, sq(31, 0, 40, 8), 3), room('E', 'E', 0, sq(41, 0, 50, 8), 3), room('F', 'T', 0, sq(51, 0, 60, 8), 3),
  room('cellar', 'N', -1, sq(0, 0, 10, 8), -2), room('tunnel', 'tunnel', -1, sq(0, 10, 4, 40), -6),
];
const plan: InteriorPlan = {
  rooms,
  doors: [
    door('court>A', ['courtyard', 'A'], [-0.5, 3, 4]),
    door('A>B', ['A', 'B'], [10.5, 3, 4]), door('B>C', ['B', 'C'], [20.5, 3, 4], { leaf: false }),
    door('C>D', ['C', 'D'], [30.5, 3, 4]), door('D>E', ['D', 'E'], [40.5, 3, 4], { leaf: false }),
    door('E>F', ['E', 'F'], [50.5, 3, 4], { leaf: false }),
    door('gate', ['outside', 'A'], [5, 3, -0.5], { along: [1, 0], normal: [0, 1], leaf: false, kind: 'gate' }),
    door('grille', ['tunnel', 'farbank'], [2, -6, 40.5], { along: [1, 0], normal: [0, 1], kind: 'grille' }),
    door('cellar>tunnel', ['cellar', 'tunnel'], [2, -2, 9.5], { along: [1, 0], normal: [0, 1] }),
    door('x', ['A', 'ghost'], [0, 3, 4]),
  ],
  stairs: [
    { id: 's', kind: 'straight', zone: 'N', spaces: ['cellar', 'A'], width: 1.2, landings: [{ y: -2 }, { y: 3 }] },
    { id: 'F-stair', kind: 'spiral', zone: 'T', spaces: ['F', 'ghost'], width: 1, landings: [{ y: 3 }, { y: 8 }] },
  ],
};
const graph = roomGraph(plan, [{ room: 'E', side: 'outside' }, { room: 'C', side: 'courtyard' }]);
const graph0 = roomGraph(plan); // doors and stairs only
const ids = (s: Set<string>) => [...s].sort();

describe('the room graph', () => {
  test('doors, stairs and windows are its edges; open unless a leaf can shut it', () => {
    expect(graph.get('A')).toEqual(expect.arrayContaining([{ to: 'courtyard', open: false, leaves: ['court>A'], window: false }, { to: 'B', open: false, leaves: ['A>B'], window: false }, { to: 'outside', open: true, leaves: [], window: false }, { to: 'cellar', open: true, leaves: [], window: false }]));
    expect(graph.get('B')).toContainEqual({ to: 'C', open: true, leaves: [], window: false });
    expect(graph.get('tunnel')).toContainEqual({ to: 'outside', open: true, leaves: [], window: false }); // the grille to the far bank
    expect(graph.get('E')).toContainEqual({ to: 'outside', open: true, leaves: [], window: true });       // a window
    expect(graph.has('ghost')).toBe(false);
    // a stair with its own room opens onto each landing without a door; several edges: open if any is
    const g2 = roomGraph({ rooms: [room('st', 'S', 0, sq(0, 0, 2, 2), 0), room('a', 'S', 0, sq(3, 0, 5, 2), 0), room('b', 'S', 1, sq(3, 0, 5, 2), 4)], doors: [door('st>a', ['st', 'a'], [2.5, 0, 1])], stairs: [{ id: 'st', kind: 'spiral', zone: 'S', spaces: ['a', 'b'], width: 1, landings: [{ y: 0, door: 'st>a' }, { y: 4 }] }] }, [{ room: 'a', side: 'outside' }, { room: 'a', side: 'outside' }]);
    expect(g2.get('st')).toEqual([{ to: 'a', open: false, leaves: ['st>a'], window: false }, { to: 'b', open: true, leaves: [], window: false }]);
    expect(g2.get('a')).toEqual([{ to: 'st', open: false, leaves: ['st>a'], window: false }, { to: 'outside', open: true, leaves: [], window: true }]);
  });
  test('draws two steps from the camera, then on through open doorways, then through the windows', () => {
    // A: courtyard, B, outside, cellar at 1; C, tunnel at 2; nothing open past them (C>D has a leaf)
    expect(ids(drawnSpaces(graph0, ['A']))).toEqual(['A', 'B', 'C', 'cellar', 'courtyard', 'outside', 'tunnel']);
    // C: B, D at 1; A, E at 2; then on through the open ways only: the gate to outside and the grille to the
    // tunnel, the cellar stair, the arch to F; not the courtyard door (shut)
    expect(ids(drawnSpaces(graph0, ['C']))).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'cellar', 'outside', 'tunnel']);
    // a leaf standing open opens its doorway: from A through C>D (and the arches past it) to F
    expect(ids(drawnSpaces(graph0, ['A'], 2, (id) => id === 'C>D'))).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'cellar', 'courtyard', 'outside', 'tunnel']);
    expect(ids(drawnSpaces(graph0, ['A'], 1))).toEqual(['A', 'B', 'C', 'cellar', 'courtyard', 'outside', 'tunnel']);
    expect(ids(drawnSpaces(graph0, ['farbank']))).toEqual(['A', 'B', 'C', 'cellar', 'courtyard', 'outside', 'tunnel']);
    expect(ids(drawnSpaces(graph0, ['ghost']))).toEqual([]);
    // windows: the courtyard sees C, and the outside E, so from A both are a step nearer
    expect(ids(drawnSpaces(graph, ['A']))).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'cellar', 'courtyard', 'outside', 'tunnel']);
  });
  test('the camera: its room, a doorway\'s two spaces, the courtyard, outside, above the roofs', () => {
    const o = { court: (x: number) => x < 0, roofs: 30 };
    expect(cameraSpaces(plan, [5, 4.6, 4], o)).toEqual({ room: 0, spaces: ['A'] });
    expect(cameraSpaces(plan, [10.5, 4.6, 4], o)).toEqual({ room: 0, spaces: ['A', 'B'] });       // in the doorway A>B
    expect(cameraSpaces(plan, [-0.5, 4.6, 4], o)).toEqual({ room: 0, spaces: ['courtyard', 'A'] }); // in the courtyard door
    expect(cameraSpaces(plan, [-0.9, 4.6, 6.5], o)).toEqual({ room: 0, spaces: ['A'] });         // in an embrasure, 0.9 m out
    expect(cameraSpaces(plan, [-20, 4.6, 4], o)).toEqual({ room: -1, spaces: ['courtyard'] });
    expect(cameraSpaces(plan, [100, 4.6, 4], o)).toEqual({ room: -1, spaces: ['outside'] });
    expect(cameraSpaces(plan, [100, 40, 4], o)).toEqual({ room: -1, spaces: ['courtyard', 'outside'] });
    expect(cameraSpaces(plan, [100, 4.6, 4])).toEqual({ room: -1, spaces: ['outside'] });
    expect(doorwaySpaces(plan, [2, -5.5, 40.5])).toEqual(['tunnel', 'outside']);
    expect(doorwaySpaces(plan, [2, 20, 40.5])).toEqual([]);
  });
  test('groups follow their rooms; deep and underground from the graph', () => {
    const groups = [{ key: 'N:0', rooms: ['A', 'B'] }, { key: 'E:0', rooms: ['C', 'D', 'E'] }, { key: 'T:0', rooms: ['F'] }, { key: 'N:-1', rooms: ['cellar'] }, { key: 'tunnel:-1', rooms: ['tunnel'] }, { key: 'reveals', rooms: [] }];
    const ctx: VisContext = { plan, graph: graph0, groups };
    const a = visibleSet(ctx, [5, 4.6, 4]);
    expect(a).toMatchObject({ room: 0, inside: true, from: ['A'], deep: false, underground: false, visible: [true, true, false, true, true, true] });
    // the same space draws the same rooms from anywhere in it: no distance, no facing
    expect(visibleSet(ctx, [-60, 4.6, 4], { court: () => true }).visible).toEqual(visibleSet(ctx, [-1.5, 4.6, 4], { court: () => true }).visible);
    // in the tunnel's far end: two steps reach the far bank (outside) through the grille
    const t = visibleSet(ctx, [2, -4.6, 30], { ground: () => 2.6 });
    expect(t).toMatchObject({ deep: false, underground: false });
    // a closed-off pair of rooms: nothing outdoors drawn, so deep, and underground below the ground
    const shut: InteriorPlan = { rooms: [room('p', 'P', -1, sq(0, 0, 4, 4), -5), room('q', 'P', -1, sq(5, 0, 9, 4), -5), room('r', 'P', -1, sq(10, 0, 14, 4), -5), room('s', 'P', -1, sq(15, 0, 19, 4), -5)], doors: [door('pq', ['p', 'q'], [4.5, -5, 2]), door('qr', ['q', 'r'], [9.5, -5, 2]), door('rs', ['r', 's'], [14.5, -5, 2]), door('so', ['s', 'outside'], [19.5, -5, 2], { leaf: false })], stairs: [] };
    const c2: VisContext = { plan: shut, graph: roomGraph(shut), groups: [] };
    expect(visibleSet(c2, [2, -3.4, 2], { ground: () => 2.6 })).toMatchObject({ deep: true, underground: true });
    expect(visibleSet(c2, [2, -3.4, 2], { ground: () => -10 })).toMatchObject({ deep: true, underground: false });
    expect(visibleSet(c2, [2, -3.4, 2])).toMatchObject({ deep: true, underground: false });
    expect(visibleSet(c2, [7, -3.4, 2])).toMatchObject({ deep: false });
    const r = visibleSet(c2, [2, -3.4, 2]);
    expect(spaceShown(r, 'q')).toBe(true);
    expect(spaceShown(r, 's')).toBe(false);
    expect(spaceShown(r, null)).toBe(false);
    expect(spaceShown(visibleSet(c2, [7, -3.4, 2]), null)).toBe(true);
    expect(spaceShown(visibleSet(c2, [7, -3.4, 2]), 'farbank')).toBe(true);
  });
  test('windows from the interior light\'s apertures: the courtyard or outside in front of each', () => {
    const aps = [
      { id: 'win0', kind: 'glass', c: [-0.5, 5, 4], n: [-1, 0, 0], room: 0 },
      { id: 'win1', kind: 'open', c: [50.5, 5, 4], n: [1, 0, 0], room: 4 },
      { id: 'door:A>B:0', kind: 'portal', c: [10, 5, 4], n: [1, 0, 0], room: 0, door: 'A>B' },
      { id: 'door:gate:0', kind: 'open', c: [5, 5, -1], n: [0, 0, -1], room: 0, door: 'gate' },
      { id: 'win9', kind: 'glass', c: [0, 0, 0], n: [1, 0, 0], room: 99 },
    ] as unknown as Aperture[];
    expect(windowLinks(plan, aps, (x) => x < 0)).toEqual([{ room: 'A', side: 'courtyard' }, { room: 'E', side: 'outside' }]);
  });
});

describe('createVisibility', () => {
  const mkGroups = (): InteriorGroup[] => [['N:0', ['A', 'B']], ['E:0', ['C', 'D', 'E']], ['T:0', ['F']], ['N:-1', ['cellar']], ['tunnel:-1', ['tunnel']]].map(([key, r]) => ({
    key: key as string, zone: '', floor: 0, rooms: r as string[], bounds: {} as never, object: { visible: true } as never,
  }));
  test('toggles groups, outdoor objects by name and registered dynamic objects', () => {
    const camera = { position: { x: 5, y: 4.6, z: 4 } };
    const named: Record<string, { name: string; visible: boolean }> = {
      water: { name: 'water', visible: true }, trees: { name: 'trees', visible: true }, 'terrain-far': { name: 'terrain-far', visible: true },
    };
    const scene = { getObjectByName: (n: string) => named[n] };
    const ig = mkGroups();
    const apertures = [{ id: 'win0', kind: 'glass', c: [-0.5, 5, 6], n: [-1, 0, 0], room: 0 }] as unknown as Aperture[];
    const vis = createVisibility(camera, ig, plan, { scene, apertures, ground: () => 2.6, court: (x) => x < 0 });
    expect(vis.graph.get('A')).toContainEqual({ to: 'courtyard', open: true, leaves: [], window: true }); // its window, beside its door
    expect(vis.roomId).toBe(null);
    const npc = { visible: false }, outsider = { visible: false };
    let npcRoom: string | null = 'F';
    const off = vis.register(npc, () => npcRoom);
    vis.register(outsider, () => null);
    expect(outsider.visible).toBe(true);
    vis.update();
    expect(vis.roomId).toBe('A');
    expect(vis.isRoomVisible('C')).toBe(true);
    expect(vis.isRoomVisible('F')).toBe(false);
    expect(vis.isRoomVisible(null)).toBe(true);
    expect(ig.map((g) => g.object.visible)).toEqual([true, true, false, true, true]);
    expect(npc.visible).toBe(false);
    npcRoom = 'B'; vis.update();
    expect(npc.visible).toBe(true);
    off(); npcRoom = 'F'; vis.update();
    expect(npc.visible).toBe(true);                       // no longer managed
    vis.setDoorOpen('C>D', true); vis.update();
    expect(vis.isRoomVisible('F')).toBe(true);           // through the open door and the arches past it
    vis.setDoorOpen('C>D', false); vis.update();
    expect(vis.isRoomVisible('F')).toBe(false);
  });
  test('deep and underground hide the outdoors', () => {
    const shut: InteriorPlan = { rooms: [room('p', 'P', -1, sq(0, 0, 4, 4), -5), room('q', 'P', -1, sq(5, 0, 9, 4), -5), room('r', 'P', -1, sq(10, 0, 14, 4), -5), room('s', 'P', -1, sq(15, 0, 19, 4), 20)], doors: [door('pq', ['p', 'q'], [4.5, -5, 2]), door('qr', ['q', 'r'], [9.5, -5, 2]), door('rs', ['r', 's'], [14.5, -5, 2]), door('so', ['s', 'outside'], [19.5, 20, 2], { leaf: false })], stairs: [] };
    const named: Record<string, { name: string; visible: boolean }> = { water: { name: 'water', visible: true }, trees: { name: 'trees', visible: true } };
    const camera = { position: { x: 2, y: -3.4, z: 2 } };
    const vis = createVisibility(camera, [], shut, { scene: { getObjectByName: (n: string) => named[n] }, ground: (x) => (x > 14 ? 0 : 2.6) });
    vis.update();
    expect(vis.state).toMatchObject({ deep: true, underground: true });
    expect([named.water.visible, named.trees.visible]).toEqual([false, false]);
    camera.position = { x: 7, y: -3.4, z: 2 }; vis.update();
    expect([named.water.visible, named.trees.visible]).toEqual([true, true]);
    // deep above the ground: only the vegetation goes
    const high = createVisibility({ position: { x: 2, y: -3.4, z: 2 } }, [], shut, { scene: { getObjectByName: (n: string) => named[n] }, ground: () => -10 });
    expect(high.update()).toMatchObject({ deep: true, underground: false });
    expect([named.water.visible, named.trees.visible]).toEqual([true, false]);
  });
  test('works without scene or apertures', () => {
    const vis = createVisibility({ position: { x: 100, y: 4, z: 30 } }, mkGroups(), plan, { apertures: [{ id: 'w', kind: 'glass', c: [-0.5, 5, 6], n: [-1, 0, 0], room: 0 }] as unknown as Aperture[] });
    expect(vis.graph.get('A')).toContainEqual({ to: 'outside', open: true, leaves: [], window: true }); // no courtyard outline given: outside
    expect(vis.state.inside).toBe(false);
    expect(vis.update()).toMatchObject({ inside: false, from: ['outside'] });
    expect(vis.isRoomVisible('A')).toBe(true);
  });
});
