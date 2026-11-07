import { describe, it, expect, beforeAll } from 'vitest';
import { planInterior } from '../src/castle/interior/plan';
import type { InteriorPlan, RoomSpec, DoorSpec } from '../src/castle/interior/types';
import { convexOverlap } from '../src/castle/interior/geom';
import { pointInPoly, type V2 } from '../src/core/math2d';
import { mulberry32 } from '../src/core/rng';
import { dressPlan, dressRoom, roleOf, walkable, grow, keepOutFor, doorEntry, wallsOf, footRect, strip, groupKey, variantPool, yawFacing, VARIANTS, FAMILY, TORCH_ROLES, TONED, SEAT_GAP, flat, type Dressing, type RoomDressing } from '../src/props/dress';
import { tone } from '../src/props/period';
import type { Placed } from '../src/props/place';
import { makeProp } from '../src/props/kit';
import { portcullisInPlan } from '../src/castle/interior/portcullis';

// a 6 × 5 m room with doors on its west and east walls, and a store room behind the north wall
const room = (id: string, poly: V2[], kind: RoomSpec['kind'] = 'chamber', floor = 3): RoomSpec => ({ id, zone: 'N', floor, kind, poly, y0: 10, y1: 13.5 });
const R = room('A', [[0, 0], [6, 0], [6, 5], [0, 5]]);
const B = room('B', [[0, -6], [6, -6], [6, -1.2], [0, -1.2]], 'chamber');
const door = (id: string, spaces: [string, string], x: number, z: number, n: V2, along: V2): DoorSpec => ({ id, spaces, centre: [x, 10, z], along, normal: n, width: 1.0, height: 2.1, wall: 1.0, head: 'round', leaf: true, hinge: 'left', swingInto: 1, rebate: 0.1, kind: 'plank' });
const plan: InteriorPlan = { rooms: [R, B], doors: [door('w', ['outside', 'A'], -0.5, 2.5, [1, 0], [0, 1]), door('e', ['A', 'courtyard'], 6.5, 2.5, [1, 0], [0, 1])], stairs: [] };

describe('dressing helpers', () => {
  it('group keys match the interior shell', () => {
    expect(groupKey(R)).toBe('N:3');
    expect(groupKey(room('s', R.poly, 'stair'))).toBe('stairs:s');
  });
  it('walls point inward and know which ones have a room behind them', () => {
    const W = wallsOf(R, plan);
    expect(W).toHaveLength(4);
    for (const w of W) { const m: V2 = [(w.a[0] + w.b[0]) / 2 + w.n[0] * 0.2, (w.a[1] + w.b[1]) / 2 + w.n[1] * 0.2]; expect(pointInPoly(R.poly, m[0], m[1])).toBe(true); }
    const inner = W.filter((w) => w.inner); // only the north wall backs onto B
    expect(inner).toHaveLength(1); expect(inner[0].n[1]).toBeCloseTo(1);
    const cw = room('C', [[0, 0], [0, 5], [6, 5], [6, 0], [6, 0.1]]); // clockwise, with a sliver edge
    expect(wallsOf(cw, plan)).toHaveLength(4);
  });
  it('door entries are inside the room on the right side of the wall', () => {
    const w = doorEntry(plan.doors[0], 'A'), e = doorEntry(plan.doors[1], 'A');
    expect(w.n[0]).toBe(1); expect(e.n[0]).toBe(-1);
    expect(w.at[0]).toBeCloseTo(0.4); expect(e.at[0]).toBeCloseTo(5.6);
  });
  it('keep-outs cover the doorways and the ends of straight stairs', () => {
    const P2: InteriorPlan = { ...plan, stairs: [{ id: 'st', kind: 'straight', zone: 'N', spaces: ['A'], start: [3, 10, 1], end: [3, 12, 4], width: 1, landings: [] }, { id: 'sp', kind: 'spiral', zone: 'N', spaces: [], width: 1, landings: [] }] };
    const K = keepOutFor(R, P2);
    expect(K).toHaveLength(3);
    expect(K.some((k) => pointInPoly(k, 0.6, 2.5))).toBe(true);
    expect(K.some((k) => pointInPoly(k, 3, 2.5))).toBe(true);
    expect(keepOutFor(B, plan)).toHaveLength(0);
  });
  it('strip and footRect make the rectangles they say', () => {
    const s = strip([0, 0], [2, 0], 0.5);
    expect(s).toEqual([[0, 0.5], [2, 0.5], [2, -0.5], [0, -0.5]].map(([a, b]) => [a + 0, b + 0]));
    expect(strip([1, 1], [1, 1], 0.5).every((p) => Number.isFinite(p[0]))).toBe(true);
    const p = makeProp('chest', 1), f = footRect({ prop: p, at: [0, 0, 0], yaw: Math.PI / 2 });
    const w = p.bounds.max[0] - p.bounds.min[0];
    expect(Math.max(...f.map((q) => q[1])) - Math.min(...f.map((q) => q[1]))).toBeCloseTo(w);
    expect(yawFacing([0, 1])).toBe(0);
  });
  it('walkable: a wall of obstacles across the room cuts the doors apart, a gap keeps them joined', () => {
    const entries: V2[] = [[0.4, 2.5], [5.6, 2.5]];
    expect(walkable(R.poly, [], entries)).toBe(true);
    expect(walkable(R.poly, [], [])).toBe(true);
    expect(walkable(R.poly, [[[2.8, -1], [3.2, -1], [3.2, 6], [2.8, 6]]], entries)).toBe(false);
    expect(walkable(R.poly, [[[2.8, -1], [3.2, -1], [3.2, 3.6], [2.8, 3.6]]], entries)).toBe(true);
    expect(walkable(R.poly, [], [[9, 9]])).toBe(false); // outside the room
    expect(walkable(R.poly, [[[-1, 1], [7, 1], [7, 2], [-1, 2]]], [[3, 0.3]])).toBe(false); // the door's side is a sliver of the floor
  });
  it('grow pushes every edge out by d, for either winding', () => {
    for (const sq of [[[0, 0], [2, 0], [2, 1], [0, 1]], [[0, 0], [0, 1], [2, 1], [2, 0]]] as V2[][]) {
      const g = grow(sq, 0.5), xs = g.map((p) => p[0]), zs = g.map((p) => p[1]);
      expect(Math.min(...xs)).toBeCloseTo(-0.5); expect(Math.max(...xs)).toBeCloseTo(2.5); expect(Math.min(...zs)).toBeCloseTo(-0.5); expect(Math.max(...zs)).toBeCloseTo(1.5);
    }
  });
  it('variant pool reuses meshes', () => {
    let built = 0;
    const make = variantPool((k, s) => { built++; return makeProp(k, s); });
    const a = make('barrel', 3), b = make('barrel', 3 + VARIANTS), c = make('barrel', 4);
    expect(a).toBe(b); expect(c).not.toBe(a); expect(built).toBe(2);
  });
  it('roles follow room kind, floor and size', () => {
    const r = mulberry32(1);
    expect(roleOf(room('x', R.poly, 'hall'), r)).toBe('hall');
    expect(roleOf(room('x', R.poly, 'chapel'), r)).toBe('chapel');
    expect(roleOf(room('x', R.poly, 'gate'), r)).toBe('gate');
    expect(roleOf(room('x', R.poly, 'passage'), r)).toBe('passage');
    expect(roleOf(room('x', R.poly, 'stair'), r)).toBe('empty');
    expect(roleOf(room('x', R.poly, 'undercroft', 0), r)).toBe('cellar');
    expect(roleOf(room('x', R.poly, 'tower', -1), r)).toBe('cellar');
    expect(['store', 'empty']).toContain(roleOf(room('x', [[0, 0], [2, 0], [2, 2], [0, 2]]), r));
    for (let i = 0; i < 20; i++) {
      expect(['kitchen', 'store', 'guard']).toContain(roleOf(room('x', R.poly, 'chamber', 0), r));
      expect(['guard', 'study', 'bedchamber', 'store']).toContain(roleOf(room('x', R.poly, 'chamber', 1), r));
      expect(['bedchamber', 'solar', 'study']).toContain(roleOf(room('x', R.poly, 'chamber', 5), r));
    }
  });
});

const front = (p: Placed): V2 => [Math.sin(p.yaw), Math.cos(p.yaw)];
const HEARTHS = ['chimneypiece', 'hooded-hearth'];
/** The hearth's back stands on an inner wall of its room, and it faces into the room. */
function hearthOnInnerWall(h: Placed, r: RoomSpec, P: InteriorPlan) {
  const n = front(h), back: V2 = [h.at[0] + n[0] * h.prop.bounds.min[2], h.at[2] + n[1] * h.prop.bounds.min[2]];
  return wallsOf(r, P).some((w) => {
    const d = (back[0] - w.a[0]) * w.n[0] + (back[1] - w.a[1]) * w.n[1], s = ((back[0] - w.a[0]) * (w.b[0] - w.a[0]) + (back[1] - w.a[1]) * (w.b[1] - w.a[1])) / w.L;
    return w.inner && Math.abs(d - 0.04) < 0.02 && s > 0 && s < w.L && n[0] * w.n[0] + n[1] * w.n[1] > 0.999;
  });
}
/** Every armchair and sofa turns to the fire: its front within 50 degrees of the line to the hearth. */
function seatsFaceHearth(d: RoomDressing) {
  const h = d.placed.find((p) => HEARTHS.includes(p.prop.kind.name));
  const seats = d.placed.filter((p) => p.prop.kind.name === 'armchair' || p.prop.kind.name === 'sofa');
  if (!h) return seats.length === 0;
  return seats.every((s) => { const f = front(s), v = [h.at[0] - s.at[0], h.at[2] - s.at[2]], L = Math.hypot(v[0], v[1]); return (f[0] * v[0] + f[1] * v[1]) / L > Math.cos((50 * Math.PI) / 180); });
}

describe('dressing a small plan', () => {
  it('family rooms build round a hearth on the inner wall, seats turned to the fire, no torches', () => {
    const make = variantPool();
    for (const kind of ['chamber', 'hall'] as const) for (let seed = 0; seed < 24; seed++) {
      const r = room('A', R.poly, kind, 5), P = { ...plan, rooms: [r, B] };
      const d = dressRoom(r, P, { seed, make });
      if (!FAMILY.includes(d.role)) continue;
      const h = d.placed.find((p) => HEARTHS.includes(p.prop.kind.name));
      if (h) expect(hearthOnInnerWall(h, r, P), `${kind} ${seed}`).toBe(true);
      expect(seatsFaceHearth(d), `${kind} ${seed}`).toBe(true);
      expect(d.placed.some((p) => p.prop.kind.name === 'sconce')).toBe(false);
    }
  });
  it('a gallery passage gets a runner, a rhythm of features along one wall and candle sconces', () => {
    const G = { ...room('G', [[0, 0], [12, 0], [12, 2.4], [0, 2.4]], 'passage', 2), zone: 'N' };
    const P: InteriorPlan = { rooms: [G], doors: [door('w', ['outside', 'G'], -0.5, 1.2, [1, 0], [0, 1]), door('e', ['G', 'x'], 12.5, 1.2, [1, 0], [0, 1])], stairs: [] };
    const d = dressRoom(G, P, { make: variantPool() });
    const names = d.placed.map((p) => p.prop.kind.name);
    expect(names).toEqual(expect.arrayContaining(['runner', 'candle-sconce']));
    expect(names.filter((n) => n === 'armour' || n === 'hall-chair').length).toBeGreaterThanOrEqual(2);
    expect(names).not.toContain('sconce');
    expect(walkable(G.poly, d.obstacles, P.doors.map((x) => doorEntry(x, 'G').at))).toBe(true);
  });

  const make = variantPool();
  it('every role furnishes the test room without blocking its doors', () => {
    const kinds: RoomSpec['kind'][] = ['hall', 'chapel', 'gate', 'passage', 'undercroft', 'chamber', 'tower'];
    for (const kind of kinds) for (const floor of [0, 1, 4]) for (let seed = 0; seed < 4; seed++) {
      const r = { ...room('A', R.poly, kind, floor), zone: kind === 'passage' ? 'tunnel' : 'N' };
      const P = { ...plan, rooms: [r, B] };
      const d = dressRoom(r, P, { seed, make });
      const entries = P.doors.map((x) => doorEntry(x, 'A').at);
      expect(walkable(r.poly, d.obstacles, entries), `${kind} ${floor} ${seed}`).toBe(true);
      for (const p of d.placed) if (p.prop.kind.placement === 'floor' && p.at[1] < r.y0 + 0.01) for (const k of d.keepOut) expect(convexOverlap(footRect(p), k)).toBe(false);
    }
  });
  it('gives up cleanly when the room itself cannot connect its doors, and skips hangings under low ceilings', () => {
    // two squares joined by a 0.3 m neck: no agent fits through, whatever is placed
    const U = { ...room('A', [[0, 0], [3, 0], [3, 1.35], [4, 1.35], [4, 0], [7, 0], [7, 3], [4, 3], [4, 1.65], [3, 1.65], [3, 3], [0, 3]], 'chamber', 0), y1: 11.2 };
    const P: InteriorPlan = { rooms: [U], doors: [door('w', ['outside', 'A'], -0.5, 1.5, [1, 0], [0, 1]), door('e', ['A', 'x'], 7.5, 1.5, [1, 0], [0, 1])], stairs: [] };
    for (let seed = 0; seed < 6; seed++) {
      const d = dressRoom(U, P, { seed, make });
      expect(d.placed.filter((p) => p.prop.kind.blocksNav)).toHaveLength(0);
      expect(d.placed.some((p) => p.prop.kind.name === 'tapestry')).toBe(false);
    }
    expect(dressRoom({ ...U, kind: 'stair' }, P, { make }).placed).toHaveLength(0);
  });
  it('handles rooms with no inner walls, tiny rooms, short passages and odd geometry', () => {
    const lone = (r: RoomSpec): InteriorPlan => ({ ...plan, rooms: [r] });
    for (const kind of ['hall', 'chapel'] as const) for (let seed = 0; seed < 3; seed++) {
      expect(dressRoom(room('A', R.poly, kind), lone(room('A', R.poly, kind)), { seed, make }).placed.length).toBeGreaterThan(0);
      const tiny = room('T', [[0, 0], [1.25, 0], [1.25, 1.1], [0, 1.1]], kind);
      for (const p of dressRoom(tiny, lone(tiny), { seed, make }).placed) if (p.prop.kind.placement === 'floor' && p.at[1] < tiny.y0 + 0.01) for (const q of footRect(p)) expect(pointInPoly(tiny.poly, q[0], q[1])).toBe(true);
    }
    const shortPassage = room('P', [[0, 0], [3, 0], [3, 2], [0, 2]], 'passage');
    expect(dressRoom(shortPassage, lone(shortPassage), { make }).placed).toHaveLength(0);
    const P2: InteriorPlan = { ...plan, stairs: [{ id: 'z', kind: 'straight', zone: 'N', spaces: ['A'], start: [3, 10, 2], end: [3, 10, 2], width: 1, landings: [] }] };
    expect(keepOutFor(R, P2)).toHaveLength(3);
    expect(walkable([[0, 0], [6, 0], [6, 0], [6, 5], [0, 5]], [], [[0.15, 2.5], [5.85, 2.5]])).toBe(true); // repeated vertex, entries hugging the walls
    expect(walkable(R.poly, [[[3, 4], [3.4, 4], [3.4, 4.4], [3, 4.4]]], [[0.15, 2.5], [5.85, 2.5]])).toBe(true);
    expect(walkable(R.poly, [], [[3, 2.5]], 0)).toBe(true);
    expect(grow([[0, 0], [1, 0], [1, 0], [1, 1], [0, 1]], 0.1).every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true);
  });
  it('drops props (last first) when a recipe would wall a door off', () => {
    // a corridor-like room only 1.4 m wide with doors at both ends: tables in the middle must go
    const C = room('A', [[0, 0], [8, 0], [8, 1.4], [0, 1.4]], 'chamber', 0);
    const P: InteriorPlan = { rooms: [C], doors: [door('w', ['outside', 'A'], -0.5, 0.7, [1, 0], [0, 1]), door('e', ['A', 'x'], 8.5, 0.7, [1, 0], [0, 1])], stairs: [] };
    const fake = (k: string, s: number) => makeProp(k, s);
    let anyDropped = false;
    for (let seed = 0; seed < 30; seed++) {
      const d = dressRoom(C, P, { seed, make: fake });
      if (d.dropped.length) anyDropped = true;
      expect(walkable(C.poly, d.obstacles, P.doors.map((x) => doorEntry(x, 'A').at))).toBe(true);
    }
    expect(anyDropped).toBe(true);
  });
});

describe('dressing the castle plan', () => {
  let P: InteriorPlan, D: Dressing;
  beforeAll(() => { P = planInterior(); D = dressPlan(P); }, 60_000); // slow next to the walking tests on a loaded machine

  it('is deterministic', () => {
    const E = dressPlan(P);
    expect(E.rooms.map((r) => r.placed.map((p) => [p.prop.kind.name, p.at.map((v) => v.toFixed(3)).join()]))).toEqual(D.rooms.map((r) => r.placed.map((p) => [p.prop.kind.name, p.at.map((v) => v.toFixed(3)).join()])));
  });
  it('furnishes most rooms, inside their walls, within budget', () => {
    const furnished = D.rooms.filter((r) => r.placed.length > 0).length;
    expect(furnished).toBeGreaterThan(P.rooms.length * 0.85);
    const tris = D.rooms.reduce((s, r) => s + r.placed.reduce((t, p) => t + p.prop.mesh.triangles, 0), 0);
    expect(tris).toBeLessThan(1_000_000); // 19th-century rooms: ~940k (was ~740k); culling shows a few groups at a time
    for (const [, placed] of D.byGroup) expect(placed.reduce((t, p) => t + p.prop.mesh.triangles, 0)).toBeLessThan(60_000);
    const rooms = new Map(P.rooms.map((r) => [r.id, r]));
    for (const d of D.rooms) {
      const r = rooms.get(d.room)!;
      for (const p of d.placed) {
        expect(pointInPoly(r.poly, p.at[0], p.at[2]), `${d.room} ${p.prop.kind.name}`).toBe(true);
        expect(p.at[1]).toBeGreaterThanOrEqual(r.y0 - 1e-6); expect(p.at[1]).toBeLessThanOrEqual(r.y1 + (p.prop.kind.placement === 'ceiling' ? 0.02 : 1e-6)); // a ceiling hook sinks into the vault
      }
    }
  });
  it('keeps every door reachable from every other door of each room', () => {
    for (const d of D.rooms) {
      const r = P.rooms.find((x) => x.id === d.room)!;
      const entries = P.doors.filter((x) => x.spaces.includes(r.id)).map((x) => doorEntry(x, r.id).at).filter((e) => pointInPoly(r.poly, e[0], e[1]));
      expect(walkable(r.poly, d.obstacles, entries), d.room).toBe(true);
    }
  });
  it('leaves the portcullis windlass and the space to work it clear', () => {
    const w = portcullisInPlan(P.doors.find((d) => d.id === 'gate-main')!, P.rooms);
    const id = w.winch!.room!;
    const zone = keepOutFor(P.rooms.find((r) => r.id === id)!, P).at(-1)!;
    expect(pointInPoly(zone, w.centre[0], w.centre[2])).toBe(true);
    const floor = D.rooms.find((r) => r.room === id)!.placed.filter((p) => p.prop.kind.placement === 'floor');
    for (const p of floor) expect(convexOverlap(footRect(p), zone), p.prop.kind.name).toBe(false);
  });
  it('puts every hearth on an inner wall and turns the seats round it to the fire', () => {
    const rooms = new Map(P.rooms.map((r) => [r.id, r]));
    let withHearth = 0, family = 0;
    for (const d of D.rooms) {
      const r = rooms.get(d.room)!;
      for (const h of d.placed.filter((p) => HEARTHS.includes(p.prop.kind.name))) expect(hearthOnInnerWall(h, r, P), d.room).toBe(true);
      expect(seatsFaceHearth(d), d.room).toBe(true);
      if (FAMILY.includes(d.role)) { family++; if (d.placed.some((p) => HEARTHS.includes(p.prop.kind.name))) withHearth++; }
    }
    expect(withHearth).toBeGreaterThan(family * 0.6);
  });
  it('lights a hearth fire inside its room and burns torches only in tunnels, cellars, gate rooms and passages', () => {
    for (const d of D.rooms) {
      const r = P.rooms.find((x) => x.id === d.room)!;
      if (d.placed.some((p) => p.prop.kind.name === 'sconce')) expect(TORCH_ROLES, d.room).toContain(d.role);
      for (const h of d.placed.filter((p) => HEARTHS.includes(p.prop.kind.name))) {
        const e = h.prop.meta.emitters[0], n = front(h), at: V2 = [h.at[0] + n[0] * e.position[2], h.at[2] + n[1] * e.position[2]];
        expect(e.kind).toBe('hearth'); expect(pointInPoly(r.poly, at[0], at[1]), d.room).toBe(true);
      }
    }
  });
  it('keeps both sides of every doorway clear for a leaf swinging either way', () => {
    for (const door of P.doors) for (const id of door.spaces) {
      const d = D.rooms.find((x) => x.room === id);
      if (!d) continue;
      const e = doorEntry(door, id), w = door.width, a: V2 = [door.along[0], door.along[1]];
      // both quarter circles of the swing (hinge on either jamb) fit in the rectangle width × width
      const swing: V2[] = [[-w / 2, 0], [w / 2, 0], [w / 2, w], [-w / 2, w]].map(([s, t]) => [e.face[0] + a[0] * s + e.n[0] * t, e.face[1] + a[1] * s + e.n[1] * t]);
      for (const p of d.placed) if (p.prop.kind.placement === 'floor' && p.prop.kind.blocksNav && p.at[1] < P.rooms.find((r) => r.id === id)!.y0 + 0.05) expect(convexOverlap(footRect(p), swing), `${door.id} ${id} ${p.prop.kind.name}`).toBe(false);
    }
  });
  it('never puts two floor pieces in the same spot: footprints of standing props do not intersect', () => {
    const bad: string[] = [];
    for (const d of D.rooms) {
      const y0 = P.rooms.find((r) => r.id === d.room)!.y0;
      // standing on the floor, not a textile under them, not something on a table, mantel or shelf
      const stand = d.placed.filter((p) => p.prop.kind.placement === 'floor' && !flat(p.prop) && p.at[1] < y0 + 0.05);
      for (let i = 0; i < stand.length; i++) for (let j = i + 1; j < stand.length; j++) {
        if (convexOverlap(footRect(stand[i]), footRect(stand[j]), -0.01)) bad.push(`${d.room} ${stand[i].prop.kind.name}/${stand[j].prop.kind.name}`);
      }
    }
    expect(bad).toEqual([]);
    // the fireside seats stand clear of every other piece (a footstool goes right up to its chair)
    const crowd: string[] = [];
    for (const d of D.rooms) {
      const y0 = P.rooms.find((r) => r.id === d.room)!.y0;
      const stand = d.placed.filter((p) => p.prop.kind.placement === 'floor' && !flat(p.prop) && p.at[1] < y0 + 0.05);
      for (const s of stand.filter((p) => ['armchair', 'sofa'].includes(p.prop.kind.name))) {
        for (const o of stand) if (o !== s && o.prop.kind.name !== 'footstool' && convexOverlap(footRect(s, SEAT_GAP / 2), footRect(o))) crowd.push(`${d.room} ${s.prop.kind.name}/${o.prop.kind.name}`);
      }
    }
    expect(crowd).toEqual([]);
  });
  it('hangs a different canvas for every picture in a room', () => {
    let rooms = 0;
    for (const d of D.rooms) {
      const v = d.placed.filter((p) => p.prop.kind.name === 'portrait').map((p) => p.prop.seed % VARIANTS);
      if (v.length > 1) rooms++;
      expect(new Set(v).size, d.room).toBe(Math.min(v.length, VARIANTS));
    }
    expect(rooms).toBeGreaterThan(10);
  });
  it('keeps one textile colour per room and hangs pictures inside the room height', () => {
    for (const d of D.rooms) {
      const tones = new Set(d.placed.filter((p) => TONED.has(p.prop.kind.name)).map((p) => tone(p.prop.seed)));
      expect(tones.size, d.room).toBeLessThanOrEqual(1);
      const r = P.rooms.find((x) => x.id === d.room)!;
      for (const p of d.placed) {
        expect(p.at[1] + p.prop.bounds.max[1], `${d.room} ${p.prop.kind.name}`).toBeLessThanOrEqual(r.y1 + (p.prop.kind.placement === 'ceiling' ? 0.02 : 1e-6)); // a ceiling hook sinks into the vault
        if (p.prop.kind.placement === 'wall') expect(p.at[1] + p.prop.bounds.min[1]).toBeGreaterThan(r.y0 + 0.4);
      }
    }
  });
  it('furnishes the family rooms in period: carpets, pictures, candles and lamps', () => {
    const fam = D.rooms.filter((d) => FAMILY.includes(d.role));
    const has = (k: string[]) => fam.filter((d) => d.placed.some((p) => k.includes(p.prop.kind.name))).length / fam.length;
    expect(has(['portrait', 'overmantel-mirror', 'stag-head', 'weapon-trophy'])).toBeGreaterThan(0.8);
    expect(has(['candle-sconce', 'oil-lamp', 'candelabrum', 'candlestick'])).toBeGreaterThan(0.9);
    expect(has(['carpet', 'rug', 'skin'])).toBeGreaterThan(0.8);
    for (const d of fam) for (const p of d.placed) if (flat(p.prop)) expect(p.prop.kind.blocksNav).toBe(false);
  });
  it('has the signature rooms', () => {
    const hall = D.rooms.find((r) => r.role === 'hall')!;
    expect(hall.placed.map((p) => p.prop.kind.name)).toEqual(expect.arrayContaining(['throne', 'trestle-table', 'bench', 'chandelier', 'hooded-hearth', 'armour', 'stag-head']));
    expect(D.rooms.find((r) => r.role === 'chapel')!.placed.map((p) => p.prop.kind.name)).toContain('altar');
    const beds = D.rooms.filter((r) => r.role === 'bedchamber');
    expect(beds.filter((r) => r.placed.some((p) => p.prop.kind.name === 'bed' || p.prop.kind.name === 'four-poster')).length).toBeGreaterThan(beds.length * 0.9);
  });
});
