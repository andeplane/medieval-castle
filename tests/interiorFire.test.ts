import { describe, expect, test } from 'vitest';
import { floorAlong, torchSpot, wallTorches, besideWayDown } from '../src/render/interiorFire';
import { planInterior } from '../src/castle/interior/plan';
import type { DoorSpec, InteriorPlan, RoomSpec } from '../src/castle/interior/types';
import type { V2 } from '../src/core/math2d';

const sq = (x0: number, z0: number, x1: number, z1: number): V2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const room = (id: string, kind: RoomSpec['kind'], zone = 'N', poly = sq(0, 0, 10, 6)): RoomSpec => ({ id, zone, floor: 0, kind, poly, y0: 0, y1: 5 });
const door = (a: string, x: number, z: number): DoorSpec => ({
  id: `d-${a}`, kind: 'plank', spaces: [a, 'outside'], centre: [x, 0, z], width: 1, height: 2, wall: 1, normal: [0, 1], head: 'round',
  leaf: true, hinge: 'left', swingInto: 0, rebate: 0.1,
} as unknown as DoorSpec);

describe('interior fire sources', () => {
  test('a torch goes on the long wall away from the door, facing into the room', () => {
    const r = room('H', 'hall');
    const plan: InteriorPlan = { rooms: [r], doors: [door('H', 5, 0)], stairs: [] };
    const { m, n } = torchSpot(plan, r)!;
    expect(m).toEqual([5, 6]);                    // the far long wall
    expect(n[0]).toBeCloseTo(0); expect(n[1]).toBeCloseTo(-1);
    expect(torchSpot(plan, room('tiny', 'hall', 'N', sq(0, 0, 2, 2)))).toBeNull();
    // without doors the first long edge wins; its normal points inside
    const { m: m2, n: n2 } = torchSpot({ rooms: [r], doors: [], stairs: [] }, r)!;
    expect(m2).toEqual([5, 0]); expect(n2[1]).toBeCloseTo(1);
    // the other winding: the normal still points inside
    const rev = room('R', 'hall', 'N', sq(0, 0, 10, 6).reverse());
    const { n: n3 } = torchSpot({ rooms: [rev], doors: [], stairs: [] }, rev)!;
    expect(n3[1]).toBeCloseTo(-1);
  });

  test('torches only in halls, gates, undercrofts and tunnels, capped, with a group', () => {
    const rooms = [room('H', 'hall'), room('C', 'chamber'), room('T', 'passage', 'tunnel'), room('U', 'undercroft'), room('G', 'gate'), room('X', 'hall', 'N', sq(0, 0, 1, 1))];
    const plan: InteriorPlan = { rooms, doors: [], stairs: [] };
    const all = wallTorches(plan, (id) => (id === 'G' ? undefined : `${id}:0`));
    expect(all.group).toEqual(['H:0', 'T:0', 'U:0']);
    expect(all.flames.every((f) => f.kind === 'torch')).toBe(true);
    expect(all.emitters[0].position[1]).toBeCloseTo(2.3);
    expect(wallTorches(plan, (id) => `${id}:0`, 2).emitters).toHaveLength(2);
    // a 30 m tunnel gets three torches along its wall
    const long: InteriorPlan = { rooms: [room('L', 'passage', 'tunnel', sq(0, 0, 30, 3))], doors: [], stairs: [] };
    const t = wallTorches(long, () => 'tunnel:-1');
    expect(t.emitters.map((e) => Math.round(e.position[0]))).toEqual([5, 15, 25]);
    expect(wallTorches(long, () => 'tunnel:-1', 2).emitters).toHaveLength(2);
  });

  test('each torch has a holder on its wall under the flame; tunnel torches follow the tunnel floor', () => {
    const plan: InteriorPlan = { rooms: [room('H', 'hall')], doors: [door('H', 5, 0)], stairs: [] };
    const h = wallTorches(plan, () => 'N:0');
    expect(h.holders).toEqual([{ room: 'H', wall: [5, 2, 6], n: h.holders[0].n, base: h.flames[0].base }]);
    expect(h.flames[0].base[2]).toBeCloseTo(6 - 0.22);
    // a 30 m tunnel whose floor drops 3 m in its middle third: torches 1.55 m over the floor where they hang
    const path: [number, number, number][] = [[0, 0, 1.5], [10, 0, 1.5], [20, -3, 1.5], [30, -3, 1.5]];
    const tun = { rooms: [room('L', 'passage', 'tunnel', sq(0, 0, 30, 3))], doors: [], stairs: [], tunnels: [{ id: 'L', room: 'L', path, width: 3, crown: 2.7 }] };
    expect(wallTorches(tun, () => 'tunnel:-1').holders.map((x) => x.base[1])).toEqual([1.55, -1.5 + 1.55, -3 + 1.55]);
    expect(floorAlong(path, [-4, 0])).toBe(0);
    expect(floorAlong(path, [40, 0])).toBe(-3);
  });

  test('a room with a way down has its torch beside that door: the cellar stair, the breach into the caves', () => {
    const P = planInterior();
    const t = wallTorches(P, (id) => id);
    for (const [r, d] of [['N0-3', 'N0-3>N-cellarstair'], ['N-c1', 'N-c1>cave-breach']]) {
      const h = t.holders.find((x) => x.room === r)!, dd = P.doors.find((x) => x.id === d)!;
      const gap = Math.hypot(h.wall[0] - dd.centre[0], h.wall[2] - dd.centre[2]);
      expect(gap).toBeLessThan(dd.wall / 2 + dd.width / 2 + 1);
      expect(gap).toBeGreaterThan(dd.width / 2 + 0.5);
    }
    // a lower room behind a door: beside it on its wall; no room on the far side, a wall too short, or the
    // same floor: no such spot
    const hi = { ...room('U', 'undercroft', 'N', sq(0, 0, 10, 6)), y0: 2 }, lo = room('C', 'undercroft', 'N', sq(0, 7, 10, 12));
    const d = { ...door('U', 5, 6.5), spaces: ['U', 'C'], wall: 1, along: [1, 0] } as DoorSpec;
    const s = besideWayDown({ rooms: [hi, lo], doors: [d], stairs: [] }, hi)!;
    expect(s.m[1]).toBeCloseTo(6, 6);
    expect(Math.abs(s.m[0] - 5)).toBeCloseTo(1.15, 6);
    expect(s.n[0]).toBeCloseTo(0, 9); expect(s.n[1]).toBe(-1);
    expect(besideWayDown({ rooms: [hi], doors: [d], stairs: [] }, hi)).toBeNull();
    expect(besideWayDown({ rooms: [{ ...hi, y0: 0 }, lo], doors: [d], stairs: [] }, { ...hi, y0: 0 })).toBeNull();
    const narrow = { ...hi, poly: sq(4, 0, 6.2, 6) };
    expect(besideWayDown({ rooms: [narrow, lo], doors: [d], stairs: [] }, narrow)).toBeNull();
  });
  test('lights the way into the caves from the great tower cellar: a torch beside the opening, not by its tunnel', () => {
    const P = planInterior(), r = P.rooms.find((x) => x.id === 'great-c')!, d = P.doors.find((x) => x.id === 'great-c>cave-climb')!;
    const s = torchSpot(P, r)!;
    expect(Math.hypot(s.m[0] - d.centre[0], s.m[1] - d.centre[2])).toBeLessThan(d.width / 2 + 0.65 + d.wall / 2 + 0.4);
    expect(wallTorches(P, () => 'g').emitters.some((e) => Math.hypot(e.position[0] - s.m[0], e.position[2] - s.m[1]) < 0.5)).toBe(true);
  });
});
