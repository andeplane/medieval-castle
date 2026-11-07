// Door geometry, swing state machine, blocking, pathfinding queries and interaction targeting.
// Pure maths and injected fakes (batches, physics, sound, characters); nothing renders.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import type { DoorSpec, V3 } from '../src/castle/interior/types';
import {
  placeLeaves, seatsOf, seatAwayFrom, hingeOf, twoWayFits, stopPlane, headTop, headRise, openingOutline, leafClassFor, leafMatrix, leafPoint, m4swing, m4mul, m4apply, m4translate, m4scale, m4rotX, maxSwing, doorFrame,
  OPEN_ANGLE, LIP, GROW, STOP_GAP, BIN, stopDepth, KIND, leafDepth,
} from '../src/castle/interior/doorGeom';
import { leafGeometry, mirrorX, slab, type PartBin } from '../src/castle/interior/doorParts';
import { buildDoors, m4quat, rayBox, rayEnters, REACH_NPC } from '../src/castle/interior/doors';
import { pickTarget } from '../src/game/interact';
import { planInterior } from '../src/castle/interior/plan';
import { playDoors } from '../src/player/setup';
import { threeBatch } from '../src/castle/interior/doorBatch';
import { fakeBatch, fakePhysics, fakeSound, M, run } from './helpers/doorFakes';
import { mulberry32 } from '../src/core/rng';

const HEADS: DoorSpec['head'][] = ['round', 'pointed', 'segmental', 'flat'];
const KINDS: DoorSpec['kind'][] = ['plank', 'postern', 'plank', 'grille'];

function spec(o: Partial<DoorSpec> = {}): DoorSpec {
  return {
    id: 'd', spaces: ['a', 'b'], centre: [10, 3, -4], along: [1, 0], normal: [0, 1], width: 1.1, height: 2.0, wall: 1.2,
    head: 'round', leaf: true, hinge: 'left', swingInto: 1, rebate: 0.15, kind: 'plank', ...o,
  };
}
/** A world point in door coordinates: s along spaces[0]'s right hand, y above the sill, n along +normal. */
function doorCoords(d: DoorSpec, p: V3) {
  const dx = p[0] - d.centre[0], dz = p[2] - d.centre[2];
  return { s: dx * -d.normal[1] + dz * d.normal[0], y: p[1] - d.centre[1], n: dx * d.normal[0] + dz * d.normal[1] };
}
const randomSpecs = (n: number, seed = 7): DoorSpec[] => {
  const r = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const kind = KINDS[i % 4], head = HEADS[Math.floor(i / 4) % 4];
    const a = r() * Math.PI * 2;
    const width = kind === 'postern' ? 0.75 + r() * 0.2 : 0.85 + r() * 0.6;
    const wall = 0.6 + r() * 1.8;
    return spec({
      id: `r${i}`, kind, head, width, height: kind === 'postern' ? 1.5 + r() * 0.2 : 1.9 + r() * 0.4,
      wall, rebate: 0.08 + r() * Math.min(0.5, wall * 0.5), hinge: r() < 0.5 ? 'left' : 'right', swingInto: r() < 0.5 ? 0 : 1,
      normal: [Math.cos(a), Math.sin(a)], along: [-Math.sin(a), Math.cos(a)], centre: [r() * 40 - 20, 2.6 + r() * 20, r() * 40 - 20],
    });
  }).map((d) => {
    // most hang two-way where the wall leaves room for both rebates, some on the other jamb when swung back
    const k = r();
    return twoWayFits(d) && k < 0.7 ? { ...d, otherHinge: k < 0.35 ? d.hinge : d.hinge === 'left' ? 'right' as const : 'left' as const } : d;
  });
};
/** Every leaf of a door in every seat it can hang in. */
const allSeats = (d: DoorSpec) => seatsOf(d).flatMap((k) => placeLeaves(d, k));
const verts = (b: PartBin) => { const o: V3[] = []; for (let i = 0; i < b.pos.length; i += 3) o.push([b.pos[i], b.pos[i + 1], b.pos[i + 2]]); return o; };
const det3 = (m: number[]) => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

// --------------------------------------------------------------------------- geometry

describe('door heads and outlines', () => {
  it('springs at the given height and rises by the head type', () => {
    for (const head of HEADS) {
      const top = headTop(head, 1.2, 2.0);
      expect(top(0)).toBeCloseTo(2.0 + headRise(head, 1.2), 5);
      if (head !== 'segmental' && head !== 'flat') expect(top(0.6)).toBeCloseTo(2.0, 5);
      const o = openingOutline(head, 1.2, 2.0, 8);
      expect(o[0]).toEqual([-0.6, 0]);
      // castle.ts's two-centred 'pointed' arch (rise 0.42 w) bulges a hair above its apex
      expect(Math.max(...o.map((p) => p[1]))).toBeCloseTo(2.0 + headRise(head, 1.2), head === 'pointed' ? 1 : 3);
      const g = openingOutline(head, 1.2, 2.0, 8, 0.06);
      expect(Math.min(...g.map((p) => p[0]))).toBeCloseTo(-0.66, 5);
      expect(top(0) + 0.06).toBeCloseTo(headTop(head, 1.2, 2.0, -0.06)(0), 2);
      expect(Math.max(...g.map((p) => p[1]))).toBeGreaterThan(Math.max(...o.map((p) => p[1])));
    }
    expect(headRise('round', 2)).toBe(1);
  });
});

describe('leaf placement', () => {
  const specs = randomSpecs(40);

  it('laps the stop all round, keeps 2 cm off the rebate and stands just in front of the stop', () => {
    const geomCache = new Map<string, ReturnType<typeof leafGeometry>>();
    for (const d of specs) {
      const top = headTop(d.head, d.width, d.height), reb = headTop(d.head, d.width, d.height, -LIP);
      const outline = openingOutline(d.head, d.width, d.height, 60, LIP).filter((p) => p[1] > d.height - 0.1);
      for (const pl of allSeats(d)) {
        const sgn = pl.seat === 1 ? 1 : -1;
        const cls = leafClassFor(d, pl.kind), g = geomCache.get(pl.classKey) ?? leafGeometry(cls, mulberry32(1));
        geomCache.set(pl.classKey, g);
        const m = leafMatrix(pl, m4swing(0));
        // the grille's bars (not its hinge knuckles, which wrap the pintle in the clearance)
        const body = pl.kind === 'grille' ? verts(g.iron).filter((v) => v[0] > 0.018) : verts(g.wood);
        let deepest = -Infinity, side = Infinity, foot = Infinity, head = Infinity, round = Infinity, thick = Infinity, s0 = Infinity, s1 = -Infinity;
        for (const v of body) {
          const { s, y, n } = doorCoords(d, m4apply(m, pl.mirrored ? [-v[0], v[1], v[2]] : v));
          side = Math.min(side, d.width / 2 + LIP - Math.abs(s));
          s0 = Math.min(s0, s); s1 = Math.max(s1, s);
          foot = Math.min(foot, y);
          head = Math.min(head, reb(s) - y);
          // Euclidean clearance to the (densely sampled) rebate head outline
          if (y > d.height - 0.05) for (const [os, oy] of outline) round = Math.min(round, Math.hypot(os - s, oy - y));
          thick = Math.min(thick, d.wall / 2 - Math.abs(n));
          deepest = Math.max(deepest, d.wall / 2 - n * sgn);
        }
        const what = `${d.id} ${d.kind} ${d.head}`;
        // inside the rebate recess
        expect(side, what).toBeGreaterThanOrEqual(0.02 - 1e-9);
        expect(foot, what).toBeGreaterThanOrEqual(0.01);
        expect(head, what).toBeGreaterThanOrEqual(0.02 - 1e-9);
        expect(round, what).toBeGreaterThanOrEqual(0.0199);
        expect(thick, what).toBeGreaterThanOrEqual(-1e-6); // inside the wall thickness
        // over the clear opening: past both jambs and above the head everywhere across it
        expect(Math.min(-d.width / 2 - s0, s1 - d.width / 2), what).toBeGreaterThanOrEqual(pl.kind === 'grille' ? 0.005 : 0.03);
        const lt = headTop(cls.head, cls.ow, cls.oh, -GROW);
        for (let s = -d.width / 2; s <= d.width / 2; s += d.width / 50) expect(lt(s) - top(s), what).toBeGreaterThanOrEqual(0.015);
        // the back face sits at `rebate` (unless the leaf would stick out of the wall), STOP_GAP before the stop
        const back = KIND[pl.kind].t + KIND[pl.kind].ledge + 0.012;
        if (d.rebate - back >= 0.03 && d.rebate < d.wall - 0.01) expect(deepest).toBeCloseTo(d.rebate, 3);
        expect(stopDepth(d, pl.kind) - deepest, what).toBeCloseTo(STOP_GAP, 3);
      }
    }
  });

  it('puts the hinge on the side named, seen from spaces[0] along +normal', () => {
    for (const d of specs) for (const k of seatsOf(d)) {
      const pls = placeLeaves(d, k);
      const s = doorCoords(d, pls[0].pivot).s;
      expect(Math.sign(s)).toBe(hingeOf(d, k) === 'right' ? 1 : -1);
      expect(pls).toHaveLength(1); // one whole leaf
      // the latch edge is at the other jamb
      const latch = doorCoords(d, leafPoint(pls[0], m4swing(0), [pls[0].width, 1, -0.05])).s;
      expect(Math.sign(latch)).toBe(-Math.sign(s));
    }
  });

  it('swings into spaces[seat] (spaces[swingInto] first), past the wall face', () => {
    expect(specs.filter((d) => d.otherHinge).length).toBeGreaterThan(10);
    for (const d of specs) {
      expect(placeLeaves(d)[0].seat).toBe(d.swingInto);
      for (const pl of allSeats(d)) {
        const sgn = pl.seat === 1 ? 1 : -1;
        const p = doorCoords(d, leafPoint(pl, m4swing(pl.maxAngle), [pl.width, 1, -0.05]));
        expect(p.n * sgn).toBeGreaterThan(0);
        expect(p.n * sgn).toBeGreaterThan(Math.min(d.wall / 2, pl.width * 0.9 - d.wall / 2));
        // and a little opening goes the same way
        expect(doorCoords(d, leafPoint(pl, m4swing(0.2), [pl.width, 1, -0.05])).n * sgn).toBeGreaterThan(doorCoords(d, leafPoint(pl, m4swing(0), [pl.width, 1, -0.05])).n * sgn);
      }
    }
  });

  it('keeps every leaf matrix a rotation (det +1) for both hands and any angle', () => {
    for (const d of specs.slice(0, 24)) for (const pl of allSeats(d)) for (const a of [0, 0.7, pl.maxAngle]) {
      expect(det3(leafMatrix(pl, m4swing(a)))).toBeCloseTo(1, 9);
    }
    const hands = new Set(specs.flatMap((d) => placeLeaves(d).map((p) => p.mirrored)));
    expect(hands).toEqual(new Set([true, false]));
  });

  it('limits the swing so the leaf stays clear of the wall face past the rebate jamb', () => {
    expect(maxSwing(0.03)).toBeCloseTo(OPEN_ANGLE, 9);
    expect(maxSwing(0.4)).toBeCloseTo(Math.PI / 2 + Math.atan((LIP - GROW) / 0.4), 9);
    expect(maxSwing(4)).toBeGreaterThan(Math.PI / 2);
    expect(maxSwing(4)).toBeLessThan(Math.PI / 2 + 0.01);
    expect(maxSwing(0)).toBeLessThanOrEqual(OPEN_ANGLE);
    // deep in a thick wall the pivot is clamped inside it
    const f = doorFrame(spec({ rebate: 0.01, wall: 0.4 }), 'plank');
    expect(f.pivotDepth).toBeGreaterThanOrEqual(0.03);
  });

  it('opens away from whoever opens it: the seat on the far side, the door default in its plane', () => {
    const d = spec({ otherHinge: 'right' }), at = (t: number) => [d.centre[0] + d.normal[0] * t, d.centre[2] + d.normal[1] * t] as const;
    expect(seatAwayFrom(d, ...at(-1))).toBe(1);
    expect(seatAwayFrom(d, ...at(1))).toBe(0);
    expect(seatAwayFrom(d, ...at(0.01))).toBeNull();
    // in the plane: toward the side they look away from (behind them)
    expect(seatAwayFrom(d, ...at(0), { x: d.normal[0], z: d.normal[1] })).toBe(0);
    expect(seatAwayFrom(d, ...at(0), { x: -d.normal[0], z: -d.normal[1] })).toBe(1);
    expect(seatAwayFrom(d, ...at(0), { x: d.along[0], z: d.along[1] })).toBeNull();
    expect(seatsOf(d)).toEqual([1, 0]);
    expect(seatsOf(spec())).toEqual([1]);
    expect(seatsOf(spec({ leaf: false, otherHinge: 'left' }))).toEqual([]);
    expect([hingeOf(d, 1), hingeOf(d, 0), hingeOf(spec(), 0)]).toEqual(['left', 'right', 'left']);
    // a wall too thin for two rebates and a stop between them
    expect(twoWayFits(spec({ wall: 0.3 }))).toBe(false);
    expect(twoWayFits(d)).toBe(true);
    expect(twoWayFits(spec({ kind: 'gate', leaf: false }))).toBe(false);
  });

  it('keeps every castle leaf, in either seat and all through its swing, in its rebate and off the stops', () => {
    // inside the wall a leaf stays in the rebated outline (clear of the jambs, the head and the arch over it)
    // and on its own face's side of its stop, so it never reaches the stop or the other seat's rebate. The
    // room beyond each face is world.test.ts's (rule 7): walls, ceiling, steps and every other leaf's sweep.
    // the doors that open (the locked sally-port grille never swings: its sweep is not checked)
    const doors = playDoors([], planInterior().doors).active;
    expect(doors.filter((d) => d.otherHinge).length).toBeGreaterThan(doors.length * 0.7); // stair doors stay one-way
    const bad = new Set<string>();
    for (const d of doors) {
      const reb = headTop(d.head, d.width, d.height, -LIP), stop = stopPlane(d);
      for (const pl of allSeats(d)) {
        const sgn = pl.seat === 1 ? 1 : -1, { zBack } = leafDepth(pl.kind), cls = leafClassFor(d, pl.kind);
        // the leaf's top edge at x along it (the head it is shaped to)
        const top = (x: number) => headTop(cls.head, cls.ow, cls.oh, -GROW)(pl.sOff + pl.sDir * x) - cls.sill;
        for (let i = 0; i <= 24; i++) for (let k = 0; k <= 10; k++) for (const f of [0, 0.5, 1]) for (const z of [zBack, 0]) {
          const x = (pl.width * k) / 10, p = doorCoords(d, leafPoint(pl, m4swing((pl.maxAngle * i) / 24), [x, f * top(x), z]));
          if (p.n * sgn < stop + STOP_GAP - 1e-3) bad.add(`${d.id} seat ${pl.seat}: reaches its stop`);
          if (Math.abs(p.n) > d.wall / 2) continue; // out of the wall: the room's (world.test.ts)
          if (Math.abs(p.s) > d.width / 2 + LIP - 0.01) bad.add(`${d.id} seat ${pl.seat}: into a jamb`);
          if (p.y > reb(p.s) - 0.01) bad.add(`${d.id} seat ${pl.seat}: into the head`);
        }
      }
    }
    expect([...bad]).toEqual([]);
  });

  it('has no leaves for an open archway or a gate (its portcullis closes it)', () => {
    expect(placeLeaves(spec({ leaf: false }))).toEqual([]);
    expect(placeLeaves(spec({ kind: 'gate', width: 3.8, height: 4 }))).toEqual([]);
  });

  it('bins sizes into shared classes without losing the lap', () => {
    const a = leafClassFor(spec({ width: 1.101 }), 'plank'), b = leafClassFor(spec({ width: 1.119 }), 'plank');
    expect(a.key).toBe(b.key);
    expect(a.width).toBeCloseTo(a.ow + 2 * GROW, 9);
    expect(leafClassFor(spec({ width: 1.2 }), 'plank').ow).toBeCloseTo(1.2, 9);
    expect(GROW - BIN).toBeGreaterThan(0.02);
    expect(LIP - GROW).toBeGreaterThanOrEqual(0.02);
  });
});

describe('leaf geometry', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const cls = leafClassFor(spec(), 'plank');
    const a = leafGeometry(cls, mulberry32(5)), b = leafGeometry(cls, mulberry32(5)), c = leafGeometry(cls, mulberry32(6));
    expect(a.wood.pos).toEqual(b.wood.pos);
    expect(a.iron.pos).toEqual(b.iron.pos);
    expect(a.wood.pos).not.toEqual(c.wood.pos);
  });

  it('makes real joinery: 6–9 cm boards, ledges on the swing side, iron on both faces', () => {
    for (const kind of ['plank', 'postern'] as const) {
      const g = leafGeometry(leafClassFor(spec({ kind, width: 1.1, height: 2 }), kind), mulberry32(2));
      expect(KIND[kind].t).toBeGreaterThanOrEqual(0.06); expect(KIND[kind].t).toBeLessThanOrEqual(0.09);
      const zs = verts(g.wood).map((v) => v[2]);
      expect(Math.min(...zs)).toBeCloseTo(-(KIND[kind].t + KIND[kind].ledge + 0.012), 5);
      expect(Math.max(...zs)).toBeLessThanOrEqual(-0.012 + 1e-9);
      const iz = verts(g.iron).map((v) => v[2]);
      expect(Math.min(...iz)).toBeLessThan(Math.min(...zs)); // studs / ring proud of the show face
      for (const n of g.wood.nor) expect(Number.isFinite(n)).toBe(true);
      expect(g.wood.pos.length / 9).toBeLessThan(1200);
    }
  });

  it('lets no light through any plank leaf of the castle: every joint between boards is backed', () => {
    // Anders, 2026-11-06: "some white line split here?" (4 mm see-through joints showing daylight)
    const covered = (tris: number[][], x: number, y: number) => tris.some(([ax, ay, bx, by, cx, cy]) => {
      const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by), d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy), d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
    });
    const seen = new Set<string>();
    let holes = 0, checked = 0;
    const where: string[] = [];
    for (const d of planInterior().doors) for (const pl of placeLeaves(d)) {
      if (pl.kind === 'grille' || seen.has(pl.classKey)) continue;
      seen.add(pl.classKey);
      const cls = leafClassFor(d, pl.kind), g = leafGeometry(cls, mulberry32(1));
      // faces a ray straight through the leaf can meet (not the edge-on sides)
      const tris: number[][] = [];
      for (let i = 0; i < g.wood.pos.length; i += 9) if (Math.abs(g.wood.nor[i + 2]) > 0.3) tris.push([0, 1, 3, 4, 6, 7].map((k) => g.wood.pos[i + k]));
      const topO = headTop(cls.head, cls.ow, cls.oh, -GROW), top = (x: number) => topO(cls.sOff + x) - cls.sill;
      for (let x = 0.03; x < g.width - 0.03; x += 0.0013) for (let y = 0.05; y < Math.min(top(x - 0.03), top(x), top(x + 0.03)) - 0.03; y += 0.37) {
        checked++;
        if (!covered(tris, x, y)) { holes++; if (where.length < 5) where.push(`${pl.classKey} x=${x.toFixed(3)} y=${y.toFixed(2)}`); }
      }
    }
    expect(seen.size).toBeGreaterThan(3);
    expect(checked).toBeGreaterThan(10000);
    expect(holes, where.join('\n')).toBe(0);
  }, 60_000);

  it('makes a grille of iron bars under the head', () => {
    const cls = leafClassFor(spec({ kind: 'grille', head: 'round' }), 'grille');
    const g = leafGeometry(cls, mulberry32(1));
    expect(g.wood.pos).toHaveLength(0);
    expect(g.iron.pos.length).toBeGreaterThan(1000);
    expect(g.fixed.pos.length).toBeGreaterThan(0);
  });

  it('mirrors geometry in x with flipped winding', () => {
    const b: PartBin = { pos: [], nor: [], uv: [] };
    slab(b, [[0, 0], [1, 0], [1, 1], [0, 1]], -0.1, 0, 0.01, (p) => [p[0], p[1]]);
    const m = mirrorX(b);
    expect(m.pos.length).toBe(b.pos.length);
    expect(m.uv.length).toBe(b.uv.length);
    // first triangle: x negated, vertex order 0,2,1
    expect(m.pos.slice(0, 3)).toEqual([-b.pos[0], b.pos[1], b.pos[2]]);
    expect(m.pos.slice(3, 6)).toEqual([-b.pos[6], b.pos[7], b.pos[8]]);
    expect(m.nor[0]).toBe(-b.nor[0]);
    // every face's winding agrees with its normal
    for (let i = 0; i < m.pos.length; i += 9) {
      const p = [0, 1, 2].map((k) => new THREE.Vector3(m.pos[i + k * 3], m.pos[i + k * 3 + 1], m.pos[i + k * 3 + 2]));
      const n = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0]));
      expect(n.dot(new THREE.Vector3(m.nor[i], m.nor[i + 1], m.nor[i + 2]))).toBeGreaterThan(0);
    }
    // degenerate polygons are skipped
    const e: PartBin = { pos: [], nor: [], uv: [] };
    slab(e, [[0, 0], [1, 0]], 0, 1, 0);
    expect(e.pos).toHaveLength(0);
  });
});

describe('matrix helpers', () => {
  it('converts rotations to quaternions like three.js', () => {
    for (const [ax, a] of [[[0, 1, 0], 0.4], [[1, 0, 0], 2.8], [[0, 0, 1], -2.9], [[0, 1, 0], 3.1], [[1, 1, 0], 2.5], [[0, 1, 1], 3.0]] as [V3, number][]) {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...ax).normalize(), a);
      const m = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
      const r = m4quat(m);
      const same = Math.abs(r[0] * q.x + r[1] * q.y + r[2] * q.z + r[3] * q.w);
      expect(same).toBeCloseTo(1, 6);
    }
  });
  it('tests rays against boxes', () => {
    const b = { min: [0, 0, 0] as V3, max: [1, 1, 1] as V3 };
    expect(rayBox([-1, 0.5, 0.5], [1, 0, 0], b, 0)).toBeCloseTo(1);
    expect(rayBox([0.5, 0.5, 0.5], [1, 0, 0], b, 0)).toBe(0);
    expect(rayBox([-1, 2, 0.5], [1, 0, 0], b, 0)).toBeNull();
    expect(rayBox([-1, 0.5, 0.5], [-1, 0, 0], b, 0)).toBeNull();
    expect(rayBox([-1, -1, 0.5], [1, 0.2, 0], b, 0)).toBeNull();
    // what the crosshair aims at: only a ray that enters the box from outside
    expect(rayEnters([-1, 0.5, 0.5], [1, 0, 0], b, 0)).toBeCloseTo(1);
    expect(rayEnters([-1, 0.5, 0.5], [1, 0, 0], b, 0.1)).toBeCloseTo(0.9);
    expect(rayEnters([0.5, 0.5, 0.5], [1, 0, 0], b, 0)).toBeNull();
    expect(rayEnters([1.05, 0.5, 0.5], [0, -1, 0], b, 0.1)).toBeNull(); // inside the padding
    expect(rayEnters([-1, 2, 0.5], [1, 0, 0], b, 0)).toBeNull();
  });
  it('applies and composes matrices', () => {
    expect(m4apply(m4mul(m4translate(1, 2, 3), m4swing(Math.PI / 2)), [1, 0, 0])).toEqual([expect.closeTo(1, 9), 2, expect.closeTo(4, 9)]);
    expect(m4apply(m4scale(2, 3, 4), [1, 1, 1])).toEqual([2, 3, 4]);
    // +y turns toward +z
    expect(m4apply(m4rotX(Math.PI / 2), [0, 1, 0])).toEqual([0, expect.closeTo(0, 9), expect.closeTo(1, 9)]);
  });
});

// --------------------------------------------------------------------------- the door system

describe('door system', () => {
  const single = (o: Partial<DoorSpec> = {}) => spec({ id: 'door', ...o });
  // a point in front of a door on its swing side, at eye height
  const front = (d: DoorSpec, dist: number, side: 0 | 1 = d.swingInto): THREE.Vector3 => {
    const s = side === 1 ? 1 : -1;
    return new THREE.Vector3(d.centre[0] + d.normal[0] * s * (d.wall / 2 + dist), d.centre[1] + 1.6, d.centre[2] + d.normal[1] * s * (d.wall / 2 + dist));
  };

  it('batches every door into one wood and one iron draw call, ~1k triangles a leaf', () => {
    const fb = fakeBatch();
    const doors = randomSpecs(150, 11);
    const sys = buildDoors(doors, M, undefined, { batch: fb.factory });
    expect(fb.made.map((m) => m.name)).toEqual(['doors-wood', 'doors-iron']);
    expect(sys.object.children).toHaveLength(2);
    const leaves = doors.reduce((n, d) => n + placeLeaves(d).length, 0);
    // one instance per seat (a two-way leaf has one hung in each, only one shown)
    expect(fb.made[0].inst.length).toBe(doors.filter((d) => d.kind !== 'grille').reduce((n, d) => n + seatsOf(d).length, 0));
    expect(fb.made[0].inst.length - fb.made[0].hidden.size).toBe(leaves - doors.filter((d) => d.kind === 'grille').length);
    expect(sys.triangles / leaves).toBeLessThan(2500);
    // geometry is shared by class: far fewer geometries than leaves
    expect(fb.made[0].geoms.length).toBeLessThan(fb.made[0].inst.length);
    for (const m of fb.made[1].mats.values()) expect(det3(m)).toBeCloseTo(1, 6);
    for (const c of fb.made[0].cols.values()) for (const k of c) { expect(k).toBeGreaterThan(0.4); expect(k).toBeLessThan(1.1); }
    // cell visibility: one door's instances hide and show together; unknown ids are ignored
    const d0 = doors.find((d) => d.leaf && d.kind !== 'grille')!;
    const hidden0 = [fb.made[0].hidden.size, fb.made[1].hidden.size];
    sys.setVisible(d0.id, false);
    expect(fb.made[0].hidden.size - hidden0[0]).toBe(placeLeaves(d0).length);
    expect(fb.made[1].hidden.size).toBeGreaterThan(hidden0[1]);
    sys.setVisible(d0.id, true); sys.setVisible('nope', false);
    expect([fb.made[0].hidden.size, fb.made[1].hidden.size]).toEqual(hidden0);
  });

  it('builds real BatchedMeshes by default', () => {
    const sys = buildDoors([single()], M);
    expect(sys.object.children.map((c) => (c as THREE.BatchedMesh).isBatchedMesh)).toEqual([true, true]);
    const b = threeBatch('x', M.wood, 1, 3);
    const g = b.addGeometry({ pos: [0, 0, 0, 1, 0, 0, 0, 1, 0], nor: [0, 0, 1, 0, 0, 1, 0, 0, 1], uv: [0, 0, 1, 0, 0, 1] });
    const i = b.addInstance(g);
    b.setMatrixAt(i, m4translate(1, 2, 3)); b.setColorAt(i, [1, 0.5, 0.2]);
    b.setVisibleAt(i, false);
    expect((b.object as THREE.BatchedMesh).getVisibleAt(i)).toBe(false);
    const m = new THREE.Matrix4(); (b.object as THREE.BatchedMesh).getMatrixAt(i, m);
    expect(m.elements[13]).toBe(2);
    // untagged for the interior light: no room's daylight (render/interiorShader.ts reads row −1 as none)
    expect((b.object as THREE.BatchedMesh).geometry.getAttribute('interiorRoom').getX(0)).toBe(-1);
  });

  it('draws the same leaves for every camera: no per-pass culling of a table every pass shares', () => {
    // three.js keeps one instance-id table per batch but records draw ranges per pass; with per-instance
    // culling the shadow camera's table was read by the view's pass (WebGPU), so leaves took other leaves' places
    const b = threeBatch('x', M.wood, 3, 9), mesh = b.object as THREE.BatchedMesh;
    const tri = { pos: [0, 0, 0, 1, 0, 0, 0, 1, 0], nor: [0, 0, 1, 0, 0, 1, 0, 0, 1], uv: [0, 0, 1, 0, 0, 1] };
    const g0 = b.addGeometry(tri), g1 = b.addGeometry({ ...tri, pos: [0, 0, 0, 2, 0, 0, 0, 2, 0] });
    const ids = [b.addInstance(g0), b.addInstance(g1), b.addInstance(g0)];
    ids.forEach((i, k) => b.setMatrixAt(i, m4translate([0, 50, -50][k], 0, [-50, 0, 50][k])));
    b.setVisibleAt(ids[2], false);
    const look = (x: number, z: number) => { const c = new THREE.PerspectiveCamera(30, 1, 0.1, 500); c.lookAt(x, 0, z); c.updateMatrixWorld(); return c; };
    type Drawn = { _updateDrawParameters(c: THREE.Camera, g: THREE.BufferGeometry, m: THREE.Material, f: string): void; _indirectTexture: THREE.DataTexture; _multiDrawCount: number };
    const drawn = (c: THREE.Camera, f: string) => {
      const m = mesh as unknown as Drawn;
      m._updateDrawParameters(c, mesh.geometry, mesh.material as THREE.Material, f);
      return [...(m._indirectTexture.image.data as Uint32Array).slice(0, m._multiDrawCount)];
    };
    for (const f of ['merged', 'multiDraw']) {
      expect(drawn(look(0, -50), f)).toEqual([0, 1]);   // looking at instance 0 only: 1 is still drawn
      expect(drawn(look(50, 0), f)).toEqual([0, 1]);    // the sun's view of the other side: the same table
    }
    expect(mesh.perObjectFrustumCulled).toBe(false);
  });

  it('opens fast, settles slowly, and shuts with a thud and a latch', () => {
    const snd = fakeSound();
    const sys = buildDoors([single()], M, undefined, { sound: snd.sink, batch: fakeBatch().factory });
    expect(sys.state().door).toBe(0);
    sys.setOpen('door', true);
    expect(snd.log.map((l) => l.s)).toEqual(['latch', 'creak']);
    run(sys, 0.25);
    const early = sys.state().door;
    expect(early).toBeGreaterThan(0.35);
    run(sys, 0.25);
    expect(sys.state().door - early).toBeLessThan(early); // decelerating
    run(sys, 4);
    expect(sys.state().door).toBe(1);
    expect(sys.isOpen('door')).toBe(true);
    expect(sys.isPassable('door')).toBe(true);
    sys.setOpen('door', true); // already open: nothing
    expect(snd.log).toHaveLength(2);
    sys.setOpen('door', false);
    run(sys, 0.2);
    expect(sys.isPassable('door')).toBe(true);
    run(sys, 3);
    expect(sys.state().door).toBe(0);
    expect(sys.isOpen('door')).toBe(false);
    expect(sys.isPassable('door')).toBe(false);
    expect(snd.log.map((l) => l.s).slice(-2)).toEqual(['thud', 'latch']);
  });

  it('toggles through its interactable and reverses mid-swing', () => {
    const d = single();
    const sys = buildDoors([d], M, undefined, { batch: fakeBatch().factory });
    const it = sys.interactables[0];
    expect(it.label()).toBe('Open door');
    it.use();
    expect(it.label()).toBe('Close door');
    run(sys, 0.2);
    it.use(); // reverse while moving
    expect(it.label()).toBe('Open door');
    run(sys, 3);
    expect(sys.state().door).toBe(0);
  });

  it('is aimed at along a ray within reach', () => {
    const d = single();
    const sys = buildDoors([d], M, undefined, { batch: fakeBatch().factory });
    const it = sys.interactables[0];
    const eye = front(d, 1.0);
    const toward = new THREE.Vector3(d.centre[0], d.centre[1] + 1.2, d.centre[2]).sub(eye).normalize();
    const t = it.hit(new THREE.Ray(eye, toward), 2.2);
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThan(0.9); expect(t!).toBeLessThan(1.4);
    expect(it.hit(new THREE.Ray(eye, toward.clone().negate()), 2.2)).toBeNull();
    expect(it.hit(new THREE.Ray(front(d, 4), toward), 2.2)).toBeNull();
    // from the other (show) side too, and on the mirrored hand
    const other = buildDoors([single({ hinge: 'right' })], M, undefined, { batch: fakeBatch().factory });
    const back = front(d, 0.8, 0);
    expect(other.interactables[0].hit(new THREE.Ray(back, new THREE.Vector3(d.centre[0], d.centre[1] + 1.2, d.centre[2]).sub(back).normalize()), 2.2)).not.toBeNull();
  });

  // Anders, "what door?": in a doorway, looking at the floor about 1.5 m ahead, the HUD said "E Open door".
  // A camera inside the shut leaf (flying through it) was "aiming" at it at distance 0 whatever it looked at.
  const floorRay = (d: DoorSpec, through: number, across: number, dir: 1 | -1, yaw: number) => {
    const n = d.normal, a = d.along;
    const eye = new THREE.Vector3(d.centre[0] + a[0] * across + n[0] * through, d.centre[1] + 1.62, d.centre[2] + a[1] * across + n[1] * through);
    const hx = n[0] * dir * Math.cos(yaw) - n[1] * dir * Math.sin(yaw), hz = n[1] * dir * Math.cos(yaw) + n[0] * dir * Math.sin(yaw);
    const floor = new THREE.Vector3(eye.x + hx * 1.5, d.centre[1], eye.z + hz * 1.5);
    return { ray: new THREE.Ray(eye, floor.sub(eye).normalize()), toward: through + dir * 1.5 * Math.cos(yaw) };
  };
  it('never aims at the floor by a doorway, leaf open or shut, not even from inside the shut leaf', () => {
    const { zBack, zFront } = leafDepth('plank');
    const bad: string[] = [];
    for (const hinge of ['left', 'right'] as const) for (const swingInto of [0, 1] as const) for (const initial of [0, 1]) {
      const d = single({ hinge, swingInto, wall: 2.0 });
      const sys = buildDoors([d], M, undefined, { batch: fakeBatch().factory, initial, ajar: 0 });
      const [pl] = placeLeaves(d), shut = leafPoint(pl, m4swing(0), [pl.width / 2, 1, (zBack + zFront) / 2]);
      const leafT = (shut[0] - d.centre[0]) * d.normal[0] + (shut[2] - d.centre[2]) * d.normal[1]; // shut leaf's mid plane, along +normal
      for (const through of [leafT, 0, d.wall / 2 + 0.4, -d.wall / 2 - 0.4]) for (const across of [-0.2, 0, 0.2]) for (const dir of [-1, 1] as const) for (const yaw of [-0.1, 0, 0.1]) {
        const { ray, toward } = floorRay(d, through, across, dir, yaw);
        // a shut leaf between the eye and the floor it looks at is really in the way: leave those rays out
        const inLeaf = Math.abs(through - leafT) < 0.03;
        if (initial === 0 && !inLeaf && Math.sign(through - leafT) !== Math.sign(toward - leafT)) continue;
        if (pickTarget(ray, sys.interactables)) bad.push(`${hinge} into ${swingInto} ${initial ? 'open' : 'shut'}: eye at ${through.toFixed(2)}, ${across} looking ${dir}`);
      }
    }
    expect(bad).toEqual([]);
    // and in the castle: every leaf, from inside it shut and from where it shuts when open, looking at the floor either way
    const plan = planInterior();
    for (const initial of [0, 1]) {
      const doors = plan.doors.filter((d) => placeLeaves(d).length);
      const sys = buildDoors(doors, M, undefined, { batch: fakeBatch().factory, initial, ajar: 0 }), own = new Map(sys.interactables.map((i) => [i.id, i]));
      for (const d of doors) {
        const [pl] = placeLeaves(d), shut = leafPoint(pl, m4swing(0), [pl.width / 2, 1, (leafDepth(pl.kind).zBack + leafDepth(pl.kind).zFront) / 2]);
        const leafT = (shut[0] - d.centre[0]) * d.normal[0] + (shut[2] - d.centre[2]) * d.normal[1];
        for (const dir of [-1, 1] as const) expect(own.get(d.id)!.hit(floorRay(d, leafT, 0, dir, 0).ray, 2.2), `${d.id} ${initial ? 'open' : 'shut'}`).toBeNull();
      }
    }
  });

  it('stops short of a character in the swing arc and carries on when they move', () => {
    const d = single();
    const snd = fakeSound();
    const npc = new THREE.Vector3();
    const sys = buildDoors([d], M, undefined, { sound: snd.sink, batch: fakeBatch().factory, characters: () => [npc] });
    // stand 0.6 m in from the face, in the middle of the arc
    const pl = placeLeaves(d)[0];
    const mid = leafPoint(pl, m4swing(0.9), [pl.width * 0.6, 1, 0]);
    npc.set(mid[0], d.centre[1] + 0.9, mid[2]);
    sys.setOpen('door', true);
    run(sys, 3);
    const stuck = sys.state().door;
    expect(stuck).toBeGreaterThan(0.1);
    expect(stuck).toBeLessThan(0.75);
    expect(snd.log.filter((l) => l.s === 'bump')).toHaveLength(1);
    expect(sys.blocksPlayer(npc)).toBe(false);
    npc.set(1000, 0, 1000);
    run(sys, 4);
    expect(sys.state().door).toBe(1);
    // the player blocks a closing door the same way (passed to update)
    const player = new THREE.Vector3(mid[0], d.centre[1] + 1.6, mid[2]);
    sys.setOpen('door', false);
    run(sys, 3, player);
    expect(sys.state().door).toBeGreaterThan(0.2);
    expect(sys.state().door).toBeLessThan(1);
    // someone far above or below does not count
    run(sys, 3, new THREE.Vector3(mid[0], d.centre[1] + 6, mid[2]));
    expect(sys.state().door).toBe(0);
    const onLeaf = leafPoint(pl, m4swing(0), [pl.width / 2, 1, -0.1]);
    expect(sys.blocksPlayer(new THREE.Vector3(onLeaf[0], onLeaf[1], onLeaf[2]))).toBe(true);
  });

  it('lets any agent request a door within reach, and reports passability', () => {
    const d = single();
    const sys = buildDoors([d, single({ id: 'arch', leaf: false, centre: [20, 3, 0] })], M, undefined, { batch: fakeBatch().factory });
    expect(sys.request('door', true, { pos: { x: d.centre[0] + 10, y: 3, z: d.centre[2] } })).toBe(false);
    expect(sys.request('nope', true, { pos: { x: 0, y: 0, z: 0 } })).toBe(false);
    expect(sys.request('door', true, { pos: front(d, 1) })).toBe(true);
    expect(REACH_NPC).toBeGreaterThan(2);
    run(sys, 4);
    expect(sys.isOpen('door')).toBe(true);
    expect(sys.isOpen('arch')).toBe(true);
    expect(sys.isPassable('arch')).toBe(true);
    expect(sys.isOpen('nope')).toBe(false);
    expect(sys.isPassable('nope')).toBe(false);
    sys.setOpen('nope', true); // unknown ids are ignored
  });

  it('opens every castle door away from whoever opens it, from either side (player and NPC alike)', () => {
    // Anders, 2026-11-07: "doors should always open away from player". Each door, shut, is asked open by a
    // character standing 1 m off the doorway on one side, then the other: the leaf (its collider, as the
    // physics sees it) ends wide open on the far side, without touching the opener on the way.
    const doors = playDoors([], planInterior().doors).active, ph = fakePhysics();
    const sys = buildDoors(doors, M, ph.api, { batch: fakeBatch().factory, ajar: 0 });
    const body = new Map(doors.map((d) => [d.id, ph.bodies.find((b) => b.tag === 'door:' + d.id)!]));
    const bad: string[] = [];
    let cases = 0;
    for (const d of doors.filter((x) => x.otherHinge)) for (const side of [0, 1] as const) {
      const sg = side === 1 ? 1 : -1, t = d.wall / 2 + 1;
      const by = { x: d.centre[0] + d.normal[0] * sg * t, y: d.centre[1] + 0.9, z: d.centre[2] + d.normal[1] * sg * t };
      sys.setOpen(d.id, false, true);
      if (!sys.request(d.id, true, { pos: by })) { bad.push(`${d.id}: out of reach from ${d.spaces[side]}`); continue; }
      for (let i = 0; i < 240 && !sys.isOpen(d.id); i++) sys.update(1 / 60, by);
      const n = doorCoords(d, body.get(d.id)!.pose!.p).n;
      cases++;
      if (!sys.isOpen(d.id)) bad.push(`${d.id} from ${d.spaces[side]}: stuck at ${sys.state()[d.id]}`);
      else if (sys.seat(d.id) !== 1 - side || n * sg > -d.wall / 2) bad.push(`${d.id} from ${d.spaces[side]}: opened toward the opener (n ${n.toFixed(2)})`);
      sys.setOpen(d.id, false, true);
    }
    expect(cases).toBeGreaterThan(300);
    expect(bad).toEqual([]);
    // the one-way doors (stair doors, a wall too thin or a far side too tight for a second seat) keep their way
    const one = doors.filter((x) => !x.otherHinge);
    expect(one.length).toBeLessThan(doors.length * 0.25);
    for (const d of one) {
      const t = d.wall / 2 + 1, sg = d.swingInto === 1 ? -1 : 1;
      sys.request(d.id, true, { pos: { x: d.centre[0] + d.normal[0] * sg * t, y: d.centre[1] + 0.9, z: d.centre[2] + d.normal[1] * sg * t } });
      expect(sys.seat(d.id)).toBe(d.swingInto);
      sys.setOpen(d.id, false, true);
    }
  });

  it('hangs a shut two-way leaf away from whoever heads for it, and never jumps faces while open or near', () => {
    const d = single({ otherHinge: 'left' }), npc = { x: 0, y: d.centre[1] + 0.9, z: 0 };
    const sys = buildDoors([d], M, undefined, { batch: fakeBatch().factory, ajar: 0, characters: () => [npc] });
    const put = (t: number) => { npc.x = d.centre[0] + d.normal[0] * t; npc.z = d.centre[2] + d.normal[1] * t; };
    expect(sys.seat('door')).toBe(1);
    put(6); run(sys, 0.1);                      // heading for it from spaces[1]: it moves to swing into spaces[0]
    expect(sys.seat('door')).toBe(0);
    put(-2); run(sys, 0.1);                     // at the door on the other side: it stays (no jump in front of them)
    expect(sys.seat('door')).toBe(0);
    put(-20); run(sys, 0.1);                    // far away: nobody heading for it
    expect(sys.seat('door')).toBe(0);
    put(-1.5);
    sys.setOpen('door', true, false, { pos: npc }); // E from right there: it hangs away from them, then swings
    expect(sys.seat('door')).toBe(1);
    run(sys, 4);
    expect(sys.isOpen('door')).toBe(true);
    put(6); run(sys, 0.1);                      // open: it keeps its seat
    expect(sys.seat('door')).toBe(1);
    sys.setOpen('door', false, true, { pos: npc });
    expect(sys.seat('door')).toBe(1);           // closing never re-hangs it
    sys.setOpen('door', true, true, { pos: npc }); // instant open from spaces[1]: hung the other way at once
    expect(sys.seat('door')).toBe(0);
    expect(sys.state().door).toBe(1);
    expect(sys.seat('nope')).toBeNull();
    // the player's E through the interactable: from where the camera stands, or in the plane where it looks
    sys.setOpen('door', false, true);
    sys.interactables[0].use({ pos: { x: d.centre[0] - d.normal[0] * 2, y: 4, z: d.centre[2] - d.normal[1] * 2 } });
    expect(sys.seat('door')).toBe(1);
    sys.setOpen('door', false, true);
    sys.interactables[0].use({ pos: { x: d.centre[0], y: 4, z: d.centre[2] }, dir: { x: d.normal[0], y: 0, z: d.normal[1] } });
    expect(sys.seat('door')).toBe(0);
  });

  it('starts closed, with a seeded few ajar, the same every time', () => {
    const doors = randomSpecs(60, 3).map((d) => ({ ...d, kind: 'plank' as const, head: 'flat' as const, width: 1, height: 2 }));
    const a = buildDoors(doors, M, undefined, { batch: fakeBatch().factory }).state();
    const b = buildDoors(doors, M, undefined, { batch: fakeBatch().factory }).state();
    expect(a).toEqual(b);
    const ajar = Object.values(a).filter((v) => v > 0).length;
    expect(ajar).toBeGreaterThan(1); expect(ajar).toBeLessThan(20);
    expect(Object.values(buildDoors(doors, M, undefined, { ajar: 0, batch: fakeBatch().factory }).state()).every((v) => v === 0)).toBe(true);
    expect(Object.values(buildDoors(doors, M, undefined, { initial: 1, batch: fakeBatch().factory }).state()).every((v) => v === 1)).toBe(true);
  });

  it('poses one kinematic box per solid leaf part', () => {
    const ph = fakePhysics();
    const d = single();
    const sys = buildDoors([d, spec({ id: 'g', kind: 'gate', width: 3.6, height: 3.4, centre: [30, 3, 0] })], M, ph.api, { batch: fakeBatch().factory });
    // one box for the door; the gate has no leaves (and here no portcullis)
    expect(ph.bodies).toHaveLength(1);
    expect(sys.isPassable('g')).toBe(true);
    expect(ph.bodies.every((b) => b.pose)).toBe(true);
    const b0 = ph.bodies[0];
    expect(b0.tag).toBe('door:door');
    const before = b0.pose!.p;
    sys.setOpen('door', true, true);
    expect(b0.pose!.p).not.toEqual(before);
    // the box centre is mid-leaf: half the leaf width from the hinge
    const pl = placeLeaves(d)[0];
    const hingeToCentre = Math.hypot(b0.pose!.p[0] - pl.pivot[0], b0.pose!.p[2] - pl.pivot[2]);
    expect(hingeToCentre).toBeGreaterThan(pl.width * 0.45);
    expect(hingeToCentre).toBeLessThan(pl.width * 0.6);
  });
});
