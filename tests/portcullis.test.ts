// The main gate's portcullis and windlass: placement from the plan, the state machine any agent drives,
// the winch pose (rope length = drum radius × angle), geometry, and the door-system glue (interaction
// from both sides and from the winch, the collider while low, NPC requests). Fakes only; nothing renders.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import type { DoorSpec, RoomSpec, V3 } from '../src/castle/interior/types';
import { planInterior } from '../src/castle/interior/plan';
import { pointInPoly } from '../src/core/math2d';
import {
  portcullisFor, portcullisInPlan, roomAbove, grooveFromFront, portAt, portCommand, portStep, willRaise, blocking, uneven, portFrame, toPort, underGrille,
  drumAngle, ropeLength, coilWidth, grilleGeometry, gateFixtures, drumGeometry, ropeGeometry, coilGeometry, barXs, railYs,
  GROOVE_IN, SEAT, HEAD, BAR, JAMB, TEETH, TOOTH, DRUM_R, ROPE_D, type PortState, type PortEvent, type PortcullisSpec,
} from '../src/castle/interior/portcullis';
import { m4apply, m4mul, m4translate, m4rotX } from '../src/castle/interior/doorGeom';
import type { PartBin } from '../src/castle/interior/doorParts';
import { buildDoors, joinDoors, inDoorway } from '../src/castle/interior/doors';
import { fakeBatch, fakePhysics, fakeSound, M, run } from './helpers/doorFakes';

const P = planInterior();
const gate = P.doors.find((d) => d.id === 'gate-main')!;
const spec = portcullisInPlan(gate, P.rooms);
const verts = (b: PartBin) => { const o: V3[] = []; for (let i = 0; i < b.pos.length; i += 3) o.push([b.pos[i], b.pos[i + 1], b.pos[i + 2]]); return o; };
const through = (d: DoorSpec, p: V3) => (p[0] - d.centre[0]) * d.normal[0] + (p[2] - d.centre[2]) * d.normal[1];
/** World point at port-frame coordinates (x across, y above the sill, z outward). */
const world = (p: PortcullisSpec, x: number, y: number, z: number) => { const w = m4apply(portFrame(p), [x, y, z]); return new THREE.Vector3(...w); };
function windingAgrees(b: PartBin) {
  for (let i = 0; i < b.pos.length; i += 9) {
    const p = [0, 1, 2].map((k) => new THREE.Vector3(b.pos[i + k * 3], b.pos[i + k * 3 + 1], b.pos[i + k * 3 + 2]));
    const n = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0]));
    if (n.lengthSq() < 1e-14) continue;
    expect(n.dot(new THREE.Vector3(b.nor[i], b.nor[i + 1], b.nor[i + 2]))).toBeGreaterThan(0);
  }
}

describe('portcullis placement (plan gate-main)', () => {
  it('closes the leafless main gate from a groove under the winch room', () => {
    expect(gate.leaf).toBe(false);
    expect(P.doors.filter((d) => d.kind === 'gate').map((d) => d.id)).toEqual(['gate-main']); // one gate, no duplicate
    expect(spec.id).toBe('gate-main');
    // GROOVE_IN from the inner face, on the opening's centre line, at the sill
    expect(through(gate, spec.centre)).toBeCloseTo(gate.wall / 2 - GROOVE_IN, 6);
    expect(grooveFromFront(gate)).toBeCloseTo(gate.wall - GROOVE_IN, 9);
    expect(spec.centre[1]).toBe(gate.centre[1]);
    expect(Math.abs((spec.centre[0] - gate.centre[0]) * gate.along[0] + (spec.centre[2] - gate.centre[2]) * gate.along[1])).toBeLessThan(1e-9);
    // the grid runs into both jamb grooves and up past the pointed head
    expect(spec.width).toBeCloseTo(gate.width + 2 * JAMB, 9);
    expect(spec.head(0)).toBeCloseTo(gate.height + 0.42 * gate.width, 6);
    expect(spec.head(gate.width / 2)).toBeCloseTo(gate.height, 6);
    expect(spec.height - SEAT).toBeGreaterThan(spec.head(0) + 0.3);
    // raised: spike tips clear head height with room to spare
    expect(spec.lift - SEAT).toBeGreaterThan(HEAD + 0.5);
    expect(blocking(spec.lift)).toBe(false);
    expect(blocking(HEAD + SEAT - 0.01)).toBe(true);
  });

  it('puts the windlass in the lowest gatehouse room over the raised grid, and it fits in there', () => {
    const w = spec.winch!;
    const room = roomAbove(P.rooms, spec.centre, gate.centre[1] - SEAT + spec.height + spec.lift)!;
    expect(room.zone).toBe('gate');
    expect(w.room).toBe(room.id);
    expect(w.floor).toBeCloseTo(room.y0 - gate.centre[1], 9);
    expect(gate.centre[1] + w.floor).toBeGreaterThan(gate.centre[1] - SEAT + spec.height + spec.lift); // raised grid stays under the floor
    expect(ropeLength(spec, spec.lift)).toBeGreaterThan(0.5);
    // every vertex of the frames, drum (any angle) and spokes inside the room, clear of its walls and ceiling
    const fx = gateFixtures(spec), dg = drumGeometry(spec), F = portFrame(spec);
    const inRoom = (p: V3) => { expect(pointInPoly(room.poly, p[0], p[2])).toBe(true); expect(p[1]).toBeGreaterThan(room.y0 - 1e-6); expect(p[1]).toBeLessThan(room.y1); };
    for (const v of [...verts(fx.wood), ...verts(fx.iron)]) inRoom(m4apply(F, v));
    for (const a of [0, 1, 2.5]) {
      const D = m4mul(F, m4mul(m4translate(0, w.drumY, -DRUM_R), m4rotX(a)));
      for (const v of [...verts(dg.wood), ...verts(dg.iron)]) inRoom(m4apply(D, v));
    }
    // the floor slot sits in the room floor, over the groove
    const slot = verts(fx.dark).filter((v) => v[1] > w.floor - 0.01);
    expect(slot.length).toBeGreaterThan(0);
    for (const v of slot) inRoom(m4apply(F, v));
  });

  it('has no windlass where there is no room above', () => {
    expect(roomAbove([], spec.centre, 0)).toBeNull();
    const low: RoomSpec = { id: 'x', zone: 'gate', floor: 1, kind: 'chamber', poly: [[-100, -100], [100, -100], [100, 100], [-100, 100]], y0: 3, y1: 6 };
    expect(portcullisInPlan(gate, [low]).winch).toBeNull();
    expect(portcullisFor(gate, null).winch).toBeNull();
    expect(roomAbove([low, { ...low, id: 'y', y0: 9 }, { ...low, id: 'z', y0: 7 }], spec.centre, 4)!.id).toBe('z');
  });

  it('maps world points into its frame and knows who stands under it', () => {
    const p = world(spec, 1.2, 1.7, 0.1);
    const l = toPort(spec, p.x, p.y + spec.centre[1], p.z);
    expect(l[0]).toBeCloseTo(1.2, 9); expect(l[2]).toBeCloseTo(0.1, 9);
    expect(underGrille(spec, p.x, spec.centre[1] + 1.7, p.z)).toBe(true);
    const out = world(spec, 0, 0, 1.0);
    expect(underGrille(spec, out.x, spec.centre[1] + 1.7, out.z)).toBe(false); // a metre outside
    const side = world(spec, spec.width / 2 + 0.5, 0, 0);
    expect(underGrille(spec, side.x, spec.centre[1] + 1.7, side.z)).toBe(false);
    expect(underGrille(spec, p.x, spec.centre[1] + 6, p.z)).toBe(false);
    // the frame's local z is outward (toward spaces[0], the bridge)
    expect(through(gate, [out.x, 0, out.z])).toBeLessThan(through(gate, spec.centre));
  });
});

describe('portcullis state machine', () => {
  const L = spec.lift;
  const drive = (s0: PortState, seconds: number, under = () => false) => {
    let s = s0; const ev: PortEvent[] = []; const lifts: number[] = [];
    for (let t = 0; t < seconds; t += 1 / 60) { const r = portStep(s, L, 1 / 60, under()); s = r.s; ev.push(...r.ev); lifts.push(s.lift); }
    return { s, ev, lifts };
  };

  it('rests until told, and a use reverses or toggles', () => {
    const down = portAt(0, L), up = portAt(L, L);
    expect(down.up).toBe(false); expect(up.up).toBe(true);
    expect(portStep(down, L, 0.1, false)).toEqual({ s: down, ev: [] });
    expect(willRaise(down, L)).toBe(true); expect(willRaise(up, L)).toBe(false);
    expect(portCommand(down, false, L)).toEqual({ s: down, ev: [] }); // already down
    expect(portCommand(up, true, L)).toEqual({ s: up, ev: [] });
    const r = portCommand(down, true, L);
    expect(r.ev).toEqual(['start-up']); expect(r.s.moving).toBe(true);
    expect(willRaise(r.s, L)).toBe(false); // moving up: a use lowers it
    expect(portCommand(r.s, true, L).ev).toEqual([]); // already going up
    expect(portCommand(r.s, false, L).ev).toEqual(['start-down']);
  });

  it('heaves up slowly and unevenly, a clank per ratchet tooth, and stops at the top', () => {
    const { s, ev, lifts } = drive(portCommand(portAt(0, L), true, L).s, 20);
    expect(s).toEqual(portAt(L, L));
    expect(ev.filter((e) => e === 'tooth').length).toBe(Math.floor(L / TOOTH));
    expect(ev[ev.length - 1]).toBe('top');
    const end = lifts.findIndex((x) => x >= L) / 60;
    expect(end).toBeGreaterThan(4); expect(end).toBeLessThan(12);
    // heave and catch: the speed pulses, and not every heave is the same
    const d = lifts.slice(1, 200).map((v, i) => v - lifts[i]);
    expect(Math.min(...d)).toBeLessThan(Math.max(...d) * 0.1);
    const ks = Array.from({ length: 32 }, (_, k) => uneven(k));
    expect(Math.min(...ks)).toBeGreaterThanOrEqual(0.75); expect(Math.max(...ks)).toBeLessThanOrEqual(1.25);
    expect(Math.max(...ks) - Math.min(...ks)).toBeGreaterThan(0.2);
    expect(uneven(5)).toBe(uneven(5));
  });

  it('drops faster than it rises and seats with a thud', () => {
    const { s, ev, lifts } = drive(portCommand(portAt(L, L), false, L).s, 4);
    expect(s).toEqual(portAt(0, L));
    expect(ev).toEqual(['seat']);
    const t = lifts.findIndex((x) => x <= 0) / 60;
    expect(t).toBeGreaterThan(0.8); expect(t).toBeLessThan(2);
  });

  it('will not come down on someone under it, and carries on when they leave', () => {
    let someone = true;
    const a = drive(portCommand(portAt(L, L), false, L).s, 3, () => someone);
    expect(a.s.held).toBe(true); expect(a.s.moving).toBe(true);
    expect(a.ev).toEqual(['held']); // once
    expect(blocking(a.s.lift)).toBe(false);
    someone = false;
    const b = drive(a.s, 3, () => someone);
    expect(b.s.lift).toBe(0); expect(b.ev).toEqual(['seat']);
  });
});

describe('windlass pose', () => {
  it('turns the drum by rope length / radius, groove side up, and winds the rope on', () => {
    const w = spec.winch!;
    for (const lift of [0.3, 1.1, spec.lift]) {
      expect(Math.abs(drumAngle(lift)) * DRUM_R).toBeCloseTo(lift, 9);
      // the point where the ropes leave the drum (groove side, +z) turns upward as it winds
      const p = m4apply(m4rotX(drumAngle(0.05)), [0, 0, DRUM_R]);
      expect(p[1]).toBeGreaterThan(0.04);
      expect(ropeLength(spec, 0) - ropeLength(spec, lift)).toBeCloseTo(lift, 9);
      expect(coilWidth(lift) - coilWidth(0)).toBeCloseTo((lift / (2 * Math.PI * DRUM_R)) * ROPE_D, 9);
    }
    // the rope hangs on the groove plane, from the drum's tangent down to the grid's lifting eyes
    expect(w.drumY - ropeLength(spec, 0)).toBeCloseTo(-SEAT + spec.height, 9);
    expect(TEETH * TOOTH).toBeCloseTo(2 * Math.PI * DRUM_R, 9); // a tooth per TOOTH of rope
  });
});

describe('portcullis geometry', () => {
  it('is a grid of square bars, riveted at every crossing, spiked feet, lifting eyes', () => {
    const g = grilleGeometry(spec), vs = verts(g);
    const xs = barXs(spec), ys = railYs(spec);
    expect(xs.length).toBeGreaterThanOrEqual(12);
    expect(ys.length).toBeGreaterThanOrEqual(12);
    expect(xs[1] - xs[0]).toBeLessThan(0.35);
    // spike tips on y = 0, one per bar; nothing below
    expect(vs.filter((v) => Math.abs(v[1]) < 1e-9).length).toBe(xs.length * 4);
    expect(Math.min(...vs.map((v) => v[1]))).toBeCloseTo(0, 9);
    // rivet heads stand proud of both faces, at each crossing
    const proud = vs.filter((v) => Math.abs(v[2]) > BAR / 2 + 0.005);
    for (const s of [1, -1]) expect(proud.filter((v) => Math.sign(v[2]) === s).length).toBeGreaterThanOrEqual(xs.length * (ys.length - 1));
    // eyes above the top rail for the ropes
    expect(Math.max(...vs.map((v) => v[1]))).toBeCloseTo(spec.height + 0.13, 6);
    expect(vs.every((v) => Math.abs(v[0]) <= spec.width / 2 + 1e-9)).toBe(true);
    windingAgrees(g);
    expect(g.pos.length / 9).toBeLessThan(8000);
    // without a winch, no eyes
    const bare = grilleGeometry(portcullisFor(gate, null));
    expect(Math.max(...verts(bare).map((v) => v[1]))).toBeCloseTo(spec.height, 6);
  });

  it('cuts sill sockets under the spikes and a dark slot in the head and in the winch-room floor', () => {
    const f = gateFixtures(spec), dark = verts(f.dark);
    const sockets = dark.filter((v) => v[1] < 0.01);
    for (const x of barXs(spec).filter((x) => Math.abs(x) < spec.ow / 2)) expect(sockets.some((v) => Math.abs(v[0] - x) < 0.061)).toBe(true);
    const head = dark.filter((v) => v[1] > 1 && v[1] < spec.winch!.floor - 1);
    expect(head.length).toBeGreaterThan(0);
    for (const v of head) expect(Math.abs(v[1] - spec.head(v[0]))).toBeLessThan(0.06);
    windingAgrees(f.wood); windingAgrees(f.iron); windingAgrees(f.dark);
    const bare = gateFixtures(portcullisFor(gate, null));
    expect(bare.wood.pos).toHaveLength(0);
    expect(bare.dark.pos.length).toBeLessThan(f.dark.pos.length);
  });

  it('builds a drum with a ratchet, capstan spokes, a rope and its coil', () => {
    const d = drumGeometry(spec);
    windingAgrees(d.wood); windingAgrees(d.iron);
    const radii = verts(d.wood).map((v) => Math.hypot(v[1], v[2]));
    expect(Math.max(...radii)).toBeCloseTo(0.6, 2); // handspikes
    expect(d.iron.pos.length / 9).toBeGreaterThan(TEETH * 8);
    const r = verts(ropeGeometry());
    expect(Math.min(...r.map((v) => v[1]))).toBeCloseTo(-1, 9); expect(Math.max(...r.map((v) => v[1]))).toBeCloseTo(0, 9);
    expect(Math.max(...r.map((v) => Math.hypot(v[0], v[2])))).toBeCloseTo(ROPE_D / 2, 9);
    windingAgrees(ropeGeometry()); windingAgrees(coilGeometry());
    const c = verts(coilGeometry());
    expect(Math.max(...c.map((v) => Math.abs(v[0])))).toBeCloseTo(0.5, 9);
  });
});

describe('the gate in the door system', () => {
  const build = (o: Parameters<typeof buildDoors>[3] = {}, ph = fakePhysics()) => {
    const fb = fakeBatch(), snd = fakeSound();
    const sys = buildDoors([gate], M, ph.api, { batch: fb.factory, sound: snd.sink, portcullis: [spec], ...o });
    return { sys, fb, snd, ph };
  };
  /** A ray from a point in the port frame toward another. */
  const ray = (a: [number, number, number], b: [number, number, number]) => { const o = world(spec, ...a), t = world(spec, ...b); return new THREE.Ray(o, t.sub(o).normalize()); };

  it('has the portcullis as the gate: raised to start, an interactable at the grille and one at the winch', () => {
    const { sys, fb } = build();
    expect(sys.state()).toEqual({ 'gate-main': 1 });
    expect(sys.interactables.map((i) => i.id)).toEqual(['gate-main', 'gate-main:winch']);
    expect(sys.interactables.every((i) => i.label() === 'Lower portcullis')).toBe(true);
    expect(sys.isOpen('gate-main')).toBe(true); expect(sys.isPassable('gate-main')).toBe(true);
    expect(fb.made.map((m) => m.name)).toEqual(['doors-wood', 'doors-iron']); // still two draw calls
    expect(sys.triangles).toBeGreaterThan(3000); expect(sys.triangles).toBeLessThan(20000);
    expect(build({ initial: 0 }).sys.state()['gate-main']).toBe(0);
  });

  it('is used from outside, from inside and from the winch, within reach only', () => {
    const { sys } = build({ initial: 0 });
    const [grille, winch] = sys.interactables;
    const outside = ray([0.3, 1.7, 1.0], [0, 2.2, 0]), inside = ray([-0.4, 1.7, -1.2], [0, 2.0, 0]);
    expect(grille.hit(outside, 2.2)).toBeCloseTo(outside.origin.distanceTo(world(spec, 0, 2.2, 0)) * (1.0 / 1.0) - 0, 0);
    expect(grille.hit(inside, 2.2)).not.toBeNull();
    expect(grille.hit(ray([0.3, 1.7, 3.5], [0, 2.2, 0]), 2.2)).toBeNull(); // too far
    expect(grille.hit(ray([1.6, 5.4, 1.0], [1.6, 5.4, -1]), 2.2)).toBeNull(); // above the head, at the side
    expect(grille.hit(ray([0, 1.7, 1.0], [0, 1.7, 3]), 2.2)).toBeNull(); // looking away
    const w = spec.winch!;
    const atWinch = ray([0.9, w.floor + 1.6, -2.2], [0, w.drumY, -DRUM_R]);
    expect(winch.hit(atWinch, 2.2)).not.toBeNull();
    expect(winch.hit(ray([0.9, w.floor + 1.6, -4.5], [0, w.drumY, -DRUM_R]), 2.2)).toBeNull();
    expect(winch.hit(ray([0.9, w.floor + 1.6, -2.2], [0.9, w.floor + 1.6, -5]), 2.2)).toBeNull();
    // standing over the rope slot beside the drum: the floor is not the windlass, the drum and a frame are
    const by: [number, number, number] = [0, w.floor + 1.6, 0.25];
    expect(winch.hit(ray(by, [0, w.floor, 1.4]), 2.2)).toBeNull();
    expect(winch.hit(ray(by, [0.8, w.floor, 0.6]), 2.2)).toBeNull();
    expect(winch.hit(ray(by, [0, w.drumY, -DRUM_R]), 2.2)).not.toBeNull();
    expect(winch.hit(ray(by, [w.frameAt, w.floor + 0.6, -DRUM_R]), 2.2)).not.toBeNull();
    // use at the winch raises it; the grille's aim box starts above the raised grid
    winch.use();
    expect(winch.label()).toBe('Lower portcullis');
    run(sys, 12);
    expect(sys.state()['gate-main']).toBe(1);
    expect(grille.hit(ray([0, 1.7, 1.0], [0, 1.0, 0]), 2.2)).toBeNull(); // under the raised grid: nothing to aim at
    grille.use();
    run(sys, 3);
    expect(sys.state()['gate-main']).toBe(0);
  });

  it('has a collider only while the grid is below head height, and blocks walkers under it', () => {
    const { sys, ph } = build();
    expect(ph.bodies).toHaveLength(0); // raised
    const at = world(spec, 0.5, 1.7, 0.1);
    expect(sys.blocksPlayer(at)).toBe(false);
    sys.setOpen('gate-main', false);
    run(sys, 0.1);
    expect(ph.bodies).toHaveLength(0); // still above head height
    run(sys, 3);
    expect(sys.state()['gate-main']).toBe(0);
    expect(ph.bodies).toHaveLength(1);
    const b = ph.bodies[0];
    expect(b.tag).toBe('door:gate-main');
    expect(b.half[0]).toBeCloseTo(spec.width / 2, 9); expect(b.half[2]).toBeLessThan(0.1);
    expect(b.pose!.p[1]).toBeCloseTo(spec.centre[1] - SEAT + spec.height / 2, 6);
    expect(sys.blocksPlayer(at)).toBe(true);
    expect(sys.isPassable('gate-main')).toBe(false); expect(sys.isOpen('gate-main')).toBe(false);
    sys.setOpen('gate-main', true);
    run(sys, 12);
    expect(b.removed).toBe(true);
    expect(sys.isPassable('gate-main')).toBe(true);
    sys.setOpen('gate-main', false, true);
    expect(ph.bodies).toHaveLength(2);
    expect(ph.bodies[1].removed).toBe(false);
  });

  it('voices the ratchet, the run down and the seat; holds over a character', () => {
    const { sys, snd } = build();
    const npc = new THREE.Vector3(...world(spec, 0.2, 1.7, 0).toArray());
    let here = true;
    const sys2 = buildDoors([], M, undefined, { batch: fakeBatch().factory, sound: snd.sink, portcullis: [spec], characters: () => (here ? [npc] : []) });
    sys2.setOpen('gate-main', false);
    run(sys2, 3);
    expect(sys2.state()['gate-main']).toBeGreaterThan(0.6);
    expect(snd.log.filter((l) => l.s === 'bump')).toHaveLength(1);
    here = false;
    run(sys2, 3);
    expect(sys2.state()['gate-main']).toBe(0);
    expect(snd.log.map((l) => l.s)).toContain('thud');
    snd.log.length = 0;
    sys.setOpen('gate-main', false, true);
    sys.setOpen('gate-main', true);
    run(sys, 12);
    const names = snd.log.map((l) => l.s);
    expect(names[0]).toBe('chain');
    expect(names.filter((n) => n === 'clank').length).toBeGreaterThan(20);
  });

  it('turns the drum and shortens the rope as it rises', () => {
    const { sys, fb } = build({ initial: 0 });
    const wood = fb.made[0];
    // instances: fixtures, drum, rope 1, coil 1, rope 2, coil 2 (in that order after the leaves: none here)
    const [, drum, rope1, coil1] = [0, 1, 2, 3];
    const before = { drum: wood.mats.get(drum)!, rope: wood.mats.get(rope1)!, coil: wood.mats.get(coil1)! };
    sys.setOpen('gate-main', true);
    run(sys, 3);
    const lift = sys.state()['gate-main'] * spec.lift;
    const after = { drum: wood.mats.get(drum)!, rope: wood.mats.get(rope1)!, coil: wood.mats.get(coil1)! };
    expect(after.drum).not.toEqual(before.drum);
    const yLen = (m: number[]) => Math.hypot(m[4], m[5], m[6]);
    expect(yLen(before.rope) - yLen(after.rope)).toBeCloseTo(lift, 2);
    const xLen = (m: number[]) => Math.hypot(m[0], m[1], m[2]);
    expect(xLen(after.coil)).toBeGreaterThan(xLen(before.coil));
    // hemp, not oak
    expect(wood.cols.get(rope1)).toEqual(wood.cols.get(coil1));
  });

  it('hides with its cells: the grille with the gate, drum and ropes with the winch room, fixtures with either', () => {
    const { sys, fb } = build();
    const [wood, iron] = fb.made;
    const hidden = () => [[...wood.hidden].sort(), [...iron.hidden].sort()];
    // wood: fixtures 0, drum 1, ropes and coils 2–5; iron: fixtures 0, dark slots 1, grille 2, drum 3
    sys.setVisible('gate-main', false);
    expect(hidden()).toEqual([[], [2]]);
    sys.setVisible('gate-main:winch', false);
    expect(hidden()).toEqual([[0, 1, 2, 3, 4, 5], [0, 1, 2, 3]]);
    sys.setVisible('gate-main', true);
    expect(hidden()).toEqual([[1, 2, 3, 4, 5], [3]]);
  });

  it('lets any agent work it from the gate or the winch, not from afar', () => {
    const { sys } = build();
    const far = world(spec, 0, 0, 8);
    expect(sys.request('gate-main', false, { pos: { x: far.x, y: spec.centre[1] + 1.7, z: far.z } })).toBe(false);
    const w = spec.winch!, up = world(spec, 0.5, w.floor + 1.7, -1.5);
    expect(sys.request('gate-main', false, { pos: up })).toBe(true);
    run(sys, 3);
    expect(sys.isPassable('gate-main')).toBe(false);
    const front = world(spec, 0.5, 1.7, 1.2);
    expect(sys.request('gate-main', true, { pos: front })).toBe(true);
    // someone on the winch-room floor right over the gate is not at the grille (3 m vertical limit)
    const above = world(spec, 0, w.floor + 1.7, 0.2);
    expect(sys.request('gate-main', true, { pos: { x: above.x, y: above.y, z: above.z } })).toBe(true); // but at the drum
    expect(sys.request('nope', true, { pos: front })).toBe(false);
  });

  it('walks only through the doorway it guards (simple walkers)', () => {
    expect(inDoorway(gate, gate.centre[0], gate.centre[2])).toBe(true);
    expect(inDoorway(gate, gate.centre[0] + 50, gate.centre[2])).toBe(false);
    // without a winch (test scene): the grille is the only interactable
    const bare = buildDoors([], M, undefined, { batch: fakeBatch().factory, portcullis: [portcullisFor(gate, null)] });
    expect(bare.interactables.map((i) => i.id)).toEqual(['gate-main']);
  });

  it('joins with the leaf doors (one system per material set) and behaves as one', () => {
    const leaf = P.doors.find((d) => d.id === 'court>W0-2')!, arch = P.doors.find((d) => !d.leaf && d.kind !== 'gate')!;
    const fb = [fakeBatch(), fakeBatch()], ph = fakePhysics();
    const leaves = buildDoors([leaf, arch], M, ph.api, { batch: fb[0].factory, initial: 0 });
    const gateSys = buildDoors([], M, ph.api, { batch: fb[1].factory, portcullis: [spec], initial: 0 });
    const sys = joinDoors([leaves, gateSys]);
    expect(sys.object.children).toEqual([leaves.object, gateSys.object]);
    expect(sys.interactables.map((i) => i.id)).toEqual(['court>W0-2', 'gate-main', 'gate-main:winch']);
    expect(sys.state()).toEqual({ 'court>W0-2': 0, 'gate-main': 0 });
    expect(sys.triangles).toBe(leaves.triangles + gateSys.triangles);
    expect(sys.isOpen(arch.id) && sys.isPassable(arch.id)).toBe(true);
    expect(sys.isOpen('nope') || sys.isPassable('gate-main')).toBe(false);
    const under = world(spec, 0, 1, 0);
    expect(sys.blocksPlayer(under)).toBe(true);
    sys.setOpen('court>W0-2', true, true);
    expect(sys.isOpen('court>W0-2')).toBe(true);
    expect(sys.request('gate-main', true, { pos: under })).toBe(true);
    expect(sys.request('gate-main', true, { pos: world(spec, 0, 1, 60) })).toBe(false);
    run(sys, 10);
    expect(sys.isOpen('gate-main')).toBe(true);
    sys.setVisible('court>W0-2', false);
    expect(fb[0].made[0].hidden.size).toBe(1);
    expect(fb[1].made[0].hidden.size).toBe(0);
  });
});
