// Door geometry, swing state machine, blocking, pathfinding queries and interaction targeting.
// Pure maths and injected fakes (batches, physics, sound, characters); nothing renders.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import type { DoorSpec, V3, Quat } from '../src/castle/interior/types';
import {
  placeLeaves, headTop, headRise, openingOutline, leafClassFor, leafMatrix, leafPoint, m4swing, m4mul, m4droop, m4apply, m4translate, maxSwing, doorFrame,
  OPEN_ANGLE, CLEAR, KIND, easeOutCubic,
} from '../src/castle/interior/doorGeom';
import { leafGeometry, wicketGeometry, mirrorX, slab, type PartBin } from '../src/castle/interior/doorParts';
import { buildDoors, gateDoorSpecs, gatePortcullisSpec, inDoorway, m4quat, rayBox, portcullisGeometry, REACH_NPC, type DoorSound, type PortcullisSpec, type Vec3Like } from '../src/castle/interior/doors';
import { threeBatch, type BatchFactory } from '../src/castle/interior/doorBatch';
import { mulberry32 } from '../src/core/rng';
import { gatehouseFrame } from '../src/castle/layout';

const HEADS: DoorSpec['head'][] = ['round', 'pointed', 'segmental', 'flat'];
const KINDS: DoorSpec['kind'][] = ['plank', 'postern', 'gate', 'grille'];

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
    const width = kind === 'gate' ? 2.6 + r() * 1.4 : kind === 'postern' ? 0.75 + r() * 0.2 : 0.85 + r() * 0.6;
    const wall = 0.6 + r() * 1.8;
    return spec({
      id: `r${i}`, kind, head, width, height: kind === 'gate' ? 3 + r() : kind === 'postern' ? 1.5 + r() * 0.2 : 1.9 + r() * 0.4,
      wall, rebate: 0.08 + r() * Math.min(0.5, wall * 0.5), hinge: r() < 0.5 ? 'left' : 'right', swingInto: r() < 0.5 ? 0 : 1,
      normal: [Math.cos(a), Math.sin(a)], along: [-Math.sin(a), Math.cos(a)], centre: [r() * 40 - 20, 2.6 + r() * 20, r() * 40 - 20],
    });
  });
};
const verts = (b: PartBin) => { const o: V3[] = []; for (let i = 0; i < b.pos.length; i += 3) o.push([b.pos[i], b.pos[i + 1], b.pos[i + 2]]); return o; };
const det3 = (m: number[]) => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

// --------------------------------------------------------------------------- fakes

function fakeBatch() {
  const made: { name: string; geoms: PartBin[]; inst: number[]; mats: Map<number, number[]>; cols: Map<number, V3>; hidden: Set<number> }[] = [];
  const factory: BatchFactory = (name) => {
    const b = { name, geoms: [] as PartBin[], inst: [] as number[], mats: new Map<number, number[]>(), cols: new Map<number, V3>(), hidden: new Set<number>() };
    made.push(b);
    return {
      object: new THREE.Object3D(),
      addGeometry: (g) => b.geoms.push(g) - 1,
      addInstance: (g) => b.inst.push(g) - 1,
      setMatrixAt: (i, m) => { b.mats.set(i, [...m]); },
      setColorAt: (i, c) => { b.cols.set(i, c); },
      setVisibleAt: (i, v) => { if (v) b.hidden.delete(i); else b.hidden.add(i); },
    };
  };
  return { factory, made };
}
function fakePhysics() {
  const bodies: { half: V3; tag?: string; pose?: { p: V3; q: Quat }; removed: boolean }[] = [];
  return {
    bodies,
    api: {
      addStaticMesh() {},
      addKinematicBox(half: V3, tag?: string) {
        const b = { half, tag, removed: false } as (typeof bodies)[number];
        bodies.push(b);
        return { setPose: (p: V3, q: Quat) => { b.pose = { p, q }; }, remove: () => { b.removed = true; } };
      },
      raycast: () => null,
    },
  };
}
function fakeSound() { const log: { s: DoorSound; w: number }[] = []; return { log, sink: { play: (s: DoorSound, _p: V3, w: number) => { log.push({ s, w }); } } }; }
const M = { wood: new THREE.MeshStandardNodeMaterial(), iron: new THREE.MeshStandardNodeMaterial(), trim: new THREE.MeshStandardNodeMaterial() };
const run = (sys: { update(dt: number, p?: Vec3Like): void }, seconds: number, p?: Vec3Like) => { for (let t = 0; t < seconds; t += 1 / 60) sys.update(1 / 60, p); };

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

  it('fits every leaf inside its opening with at least 1 cm clearance, against the stop', () => {
    const geomCache = new Map<string, ReturnType<typeof leafGeometry>>();
    for (const d of specs) {
      const top = headTop(d.head, d.width, d.height);
      const outline = openingOutline(d.head, d.width, d.height, 60).filter((p) => p[1] > d.height - 0.1);
      const sgn = d.swingInto === 1 ? 1 : -1;
      for (const pl of placeLeaves(d)) {
        const g = geomCache.get(pl.classKey) ?? leafGeometry(leafClassFor(d, pl.kind), mulberry32(1), { wicket: !!pl.wicket });
        geomCache.set(pl.classKey, g);
        const m = leafMatrix(pl, m4swing(0));
        // the grille's bars (not its hinge knuckles, which wrap the pintle in the clearance)
        const body = pl.kind === 'grille' ? verts(g.iron).filter((v) => v[0] > 0.018) : verts(g.wood);
        let deepest = -Infinity, side = Infinity, foot = Infinity, head = Infinity, round = Infinity, thick = Infinity;
        for (const v of body) {
          const { s, y, n } = doorCoords(d, m4apply(m, pl.mirrored ? [-v[0], v[1], v[2]] : v));
          side = Math.min(side, d.width / 2 - Math.abs(s));
          foot = Math.min(foot, y);
          head = Math.min(head, top(s) - y);
          // Euclidean clearance to the (densely sampled) head outline
          if (y > d.height - 0.05) for (const [os, oy] of outline) round = Math.min(round, Math.hypot(os - s, oy - y));
          thick = Math.min(thick, d.wall / 2 - Math.abs(n));
          deepest = Math.max(deepest, d.wall / 2 - n * sgn);
        }
        const what = `${d.id} ${d.kind} ${d.head}`;
        expect(side, what).toBeGreaterThanOrEqual(0.01 - 1e-9);
        expect(foot, what).toBeGreaterThanOrEqual(0.01);
        expect(head, what).toBeGreaterThanOrEqual(0.01 - 1e-9);
        expect(round, what).toBeGreaterThanOrEqual(0.0099);
        expect(thick, what).toBeGreaterThanOrEqual(-1e-6); // inside the wall thickness
        // the back face sits on the stop at `rebate` (unless the leaf would stick out of the wall)
        const back = KIND[pl.kind].t + KIND[pl.kind].ledge + 0.012;
        if (d.rebate - back >= 0.03 && d.rebate < d.wall - 0.01) expect(deepest).toBeCloseTo(d.rebate, 3);
      }
    }
  });

  it('puts the hinge on the side named, seen from spaces[0] along +normal', () => {
    for (const d of specs) {
      const pls = placeLeaves(d);
      const s = doorCoords(d, pls[0].pivot).s;
      expect(Math.sign(s)).toBe(d.hinge === 'right' ? 1 : -1);
      if (d.kind === 'gate') { expect(pls).toHaveLength(2); expect(Math.sign(doorCoords(d, pls[1].pivot).s)).toBe(-Math.sign(s)); expect(pls[0].wicket).toBe(true); }
      else expect(pls).toHaveLength(1);
      // the latch edge is at the other jamb (single) or the middle (gate)
      const latch = doorCoords(d, leafPoint(pls[0], m4swing(0), [pls[0].width, 1, -0.05])).s;
      if (d.kind === 'gate') expect(Math.abs(latch)).toBeLessThan(0.02);
      else expect(Math.sign(latch)).toBe(-Math.sign(s));
    }
  });

  it('swings into spaces[swingInto], past the wall face', () => {
    for (const d of specs) {
      const sgn = d.swingInto === 1 ? 1 : -1;
      for (const pl of placeLeaves(d)) {
        const p = doorCoords(d, leafPoint(pl, m4swing(pl.maxAngle), [pl.width, 1, -0.05]));
        expect(p.n * sgn).toBeGreaterThan(0);
        expect(p.n * sgn).toBeGreaterThan(Math.min(d.wall / 2, pl.width * 0.9 - d.wall / 2));
        // and a little opening goes the same way
        expect(doorCoords(d, leafPoint(pl, m4swing(0.2), [pl.width, 1, -0.05])).n * sgn).toBeGreaterThan(doorCoords(d, leafPoint(pl, m4swing(0), [pl.width, 1, -0.05])).n * sgn);
      }
    }
  });

  it('keeps every leaf matrix a rotation (det +1) for both hands, any angle and droop', () => {
    for (const d of specs.slice(0, 24)) for (const pl of placeLeaves(d)) for (const a of [0, 0.7, pl.maxAngle]) {
      expect(det3(leafMatrix(pl, m4mul(m4swing(a), m4droop(0.01))))).toBeCloseTo(1, 9);
    }
    const hands = new Set(specs.flatMap((d) => placeLeaves(d).map((p) => p.mirrored)));
    expect(hands).toEqual(new Set([true, false]));
  });

  it('limits the swing so the leaf stays clear of the jamb', () => {
    expect(maxSwing(0.03)).toBeCloseTo(OPEN_ANGLE, 9);
    expect(maxSwing(4)).toBeGreaterThan(Math.PI / 2);
    expect(maxSwing(4)).toBeLessThan(Math.PI / 2 + 0.01);
    expect(maxSwing(0)).toBeLessThanOrEqual(OPEN_ANGLE);
    // deep in a thick wall the pivot is clamped inside it
    const f = doorFrame(spec({ rebate: 0.01, wall: 0.4 }), 'plank');
    expect(f.pivotDepth).toBeGreaterThanOrEqual(0.03);
  });

  it('has no leaves for an open archway', () => {
    expect(placeLeaves(spec({ leaf: false }))).toEqual([]);
  });

  it('bins sizes into shared classes without losing clearance', () => {
    const a = leafClassFor(spec({ width: 1.101 }), 'plank'), b = leafClassFor(spec({ width: 1.119 }), 'plank');
    expect(a.key).toBe(b.key);
    expect(a.width).toBeCloseTo(a.ow - 2 * CLEAR, 9);
    expect(leafClassFor(spec({ kind: 'gate', width: 3 }), 'gate').width).toBeCloseTo(1.5 - CLEAR - 0.006, 9);
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
    for (const kind of ['plank', 'postern', 'gate'] as const) {
      const g = leafGeometry(leafClassFor(spec({ kind, width: kind === 'gate' ? 3.4 : 1.1, height: kind === 'gate' ? 3.2 : 2 }), kind), mulberry32(2), { wicket: kind === 'gate' });
      expect(KIND[kind].t).toBeGreaterThanOrEqual(0.06); expect(KIND[kind].t).toBeLessThanOrEqual(0.09);
      const zs = verts(g.wood).map((v) => v[2]);
      expect(Math.min(...zs)).toBeCloseTo(-(KIND[kind].t + KIND[kind].ledge + 0.012), 5);
      expect(Math.max(...zs)).toBeLessThanOrEqual(-0.012 + 1e-9);
      const iz = verts(g.iron).map((v) => v[2]);
      expect(Math.min(...iz)).toBeLessThan(Math.min(...zs)); // studs / ring proud of the show face
      for (const n of g.wood.nor) expect(Number.isFinite(n)).toBe(true);
      expect(g.wood.pos.length / 9).toBeLessThan(kind === 'gate' ? 4000 : 1200);
    }
  });

  it('cuts a wicket into one gate leaf and hangs a wicket door in it', () => {
    const cls = leafClassFor(spec({ kind: 'gate', width: 3.6, height: 3.4, head: 'pointed' }), 'gate');
    const g = leafGeometry(cls, mulberry32(3), { wicket: true });
    expect(g.wicket).toBeDefined();
    const h = g.wicket!;
    expect(h.x1 - h.x0).toBeGreaterThan(0.6);
    expect(h.y1 - h.y0).toBeGreaterThan(1.5);
    // no gate board crosses the hole
    for (let i = 0; i < g.wood.pos.length; i += 9) {
      const cx = (g.wood.pos[i] + g.wood.pos[i + 3] + g.wood.pos[i + 6]) / 3, cy = (g.wood.pos[i + 1] + g.wood.pos[i + 4] + g.wood.pos[i + 7]) / 3;
      const inside = cx > h.x0 + 0.02 && cx < h.x1 - 0.02 && cy > h.y0 + 0.02 && cy < h.y1 - 0.02;
      expect(inside).toBe(false);
    }
    const w = wicketGeometry(h, mulberry32(4));
    for (const v of verts(w.wood)) { expect(v[0]).toBeGreaterThanOrEqual(-1e-9); expect(v[0]).toBeLessThanOrEqual(w.width + 1e-9); expect(v[1]).toBeLessThanOrEqual(w.height + 1e-9); }
    expect(w.fixed.pos).toHaveLength(0);
  });

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
  });
  it('applies and composes matrices', () => {
    expect(m4apply(m4mul(m4translate(1, 2, 3), m4swing(Math.PI / 2)), [1, 0, 0])).toEqual([expect.closeTo(1, 9), 2, expect.closeTo(4, 9)]);
    expect(easeOutCubic(1)).toBe(1);
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
    const leaves = doors.reduce((n, d) => n + placeLeaves(d).length, 0) + doors.filter((d) => d.kind === 'gate').length;
    expect(fb.made[0].inst.length).toBe(leaves - doors.filter((d) => d.kind === 'grille').length);
    expect(sys.triangles / leaves).toBeLessThan(2500);
    // geometry is shared by class: far fewer geometries than leaves
    expect(fb.made[0].geoms.length).toBeLessThan(leaves);
    for (const m of fb.made[1].mats.values()) expect(det3(m)).toBeCloseTo(1, 6);
    for (const c of fb.made[0].cols.values()) for (const k of c) { expect(k).toBeGreaterThan(0.4); expect(k).toBeLessThan(1.1); }
    // cell visibility: one door's instances hide and show together; unknown ids are ignored
    const d0 = doors.find((d) => d.leaf && d.kind !== 'grille')!;
    sys.setVisible(d0.id, false);
    expect(fb.made[0].hidden.size).toBe(placeLeaves(d0).length);
    expect(fb.made[1].hidden.size).toBeGreaterThan(0);
    sys.setVisible(d0.id, true); sys.setVisible('nope', false);
    expect(fb.made[0].hidden.size + fb.made[1].hidden.size).toBe(0);
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
    const sys = buildDoors([d, spec({ id: 'g', kind: 'gate', width: 3.6, height: 3.4, centre: [30, 3, 0] })], M, ph.api, { batch: fakeBatch().factory, portcullis: [port('pc', [30, 3, -0.3])] });
    // door 1 box, gate: wicket leaf 4 boxes + other leaf 1 + wicket 1, portcullis 1
    expect(ph.bodies).toHaveLength(1 + 4 + 1 + 1 + 1);
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

  function port(id: string, c: V3, door?: string): PortcullisSpec {
    return { id, centre: c, along: [1, 0], width: 3.5, height: 5, lift: 2.6, raised: true, reach: { w: 3.6, h: 4.8, head: (s) => 4.8 - Math.abs(s) * 0.3 }, door };
  }

  it('runs a gate: two leaves that sag and judder, a wicket riding in one, and a portcullis', () => {
    const fb = fakeBatch(), snd = fakeSound();
    const g = spec({ id: 'g', kind: 'gate', head: 'pointed', width: 3.6, height: 3.4, wall: 2, rebate: 1.2 });
    const sys = buildDoors([g], M, undefined, { batch: fb.factory, sound: snd.sink, portcullis: [port('pc', [g.centre[0], g.centre[1], g.centre[2] - 0.7], 'g')] });
    const ids = sys.interactables.map((i) => i.id);
    expect(ids).toEqual(['g:wicket', 'g', 'pc']);
    const [wicket, gate, pc] = sys.interactables;
    expect(gate.label()).toBe('Open gate');
    expect(wicket.label()).toBe('Open wicket');
    expect(pc.label()).toBe('Lower portcullis');
    expect(sys.isPassable('g')).toBe(false);
    // wicket alone makes the gate passable
    wicket.use();
    run(sys, 3);
    expect(sys.state()['g:wicket']).toBe(1);
    expect(sys.isPassable('g')).toBe(true);
    sys.setOpen('g:wicket', false, true);
    // the gate: slow, heavy, and the wicket moves with its leaf
    const wInst = fb.made[0].inst.length - 1; // wicket is the last wood instance of leaf 0's pair
    void wInst;
    const wicketBefore = JSON.stringify([...fb.made[0].mats.entries()]);
    gate.use();
    run(sys, 0.5);
    expect(sys.state().g).toBeGreaterThan(0);
    expect(sys.state().g).toBeLessThan(0.6);
    expect(JSON.stringify([...fb.made[0].mats.entries()])).not.toBe(wicketBefore);
    run(sys, 8);
    expect(sys.state().g).toBe(1);
    expect(sys.isPassable('g')).toBe(true);
    expect(sys.isOpen('g')).toBe(true);
    // the portcullis comes down, ratcheting, and then the gate is not passable
    pc.use();
    expect(pc.label()).toBe('Raise portcullis');
    run(sys, 5);
    expect(sys.state().pc).toBe(0);
    expect(sys.isPassable('g')).toBe(false);
    expect(sys.isPassable('pc')).toBe(false);
    expect(sys.isOpen('pc')).toBe(false);
    expect(snd.log.filter((l) => l.s === 'clank').length).toBeGreaterThan(10);
    expect(snd.log.some((l) => l.s === 'chain')).toBe(true);
    // raise: a slow heave-and-catch, not a constant speed
    sys.setOpen('pc', true);
    const steps: number[] = [];
    for (let i = 0; i < 120; i++) { sys.update(1 / 60); steps.push(sys.state().pc); }
    const deltas = steps.slice(1).map((v, i) => v - steps[i]);
    expect(Math.min(...deltas)).toBeLessThan(Math.max(...deltas) * 0.2);
    run(sys, 12);
    expect(sys.state().pc).toBe(1);
    expect(sys.isOpen('pc')).toBe(true);
    expect(sys.isPassable('pc')).toBe(true);
    sys.setOpen('pc', true); // already up
    sys.setOpen('pc', false, true);
    expect(sys.state().pc).toBe(0);
    // instant gate close carries the wicket along
    sys.setOpen('g', false, true);
    expect(sys.state().g).toBe(0);
  });

  it('will not drop the portcullis on someone standing under it', () => {
    const ph = fakePhysics();
    const p = port('pc', [0, 3, 0]);
    const sys = buildDoors([], M, ph.api, { batch: fakeBatch().factory, portcullis: [p] });
    sys.setOpen('pc', false);
    run(sys, 5, new THREE.Vector3(0.5, 4.6, 0.1));
    expect(sys.state().pc).toBeGreaterThan(0.7);
    expect(sys.blocksPlayer(new THREE.Vector3(0.5, 4.6, 0.1))).toBe(false);
    run(sys, 5);
    expect(sys.state().pc).toBe(0);
    expect(sys.blocksPlayer(new THREE.Vector3(0.5, 4.6, 0.1))).toBe(true);
    expect(ph.bodies[0].pose!.p[1]).toBeCloseTo(3 + 2.5, 5);
    expect(sys.request('pc', true, { pos: { x: 1, y: 3, z: 1 } })).toBe(true);
  });

  it('aims at the portcullis only where it shows in the opening', () => {
    const sys = buildDoors([], M, undefined, { batch: fakeBatch().factory, portcullis: [port('pc', [0, 3, 0])] });
    const it = sys.interactables[0];
    const eye = new THREE.Vector3(0, 5.6, 1.5);
    expect(it.hit(new THREE.Ray(eye, new THREE.Vector3(0, 0.1, -1).normalize()), 2.2)).not.toBeNull();
    expect(it.hit(new THREE.Ray(eye, new THREE.Vector3(0, -1, -0.1).normalize()), 2.2)).toBeNull(); // below the raised grid
    expect(it.hit(new THREE.Ray(new THREE.Vector3(1.6, 7.7, 1), new THREE.Vector3(0, 0, -1)), 2.2)).toBeNull(); // above the head
    expect(it.hit(new THREE.Ray(new THREE.Vector3(0, 6, 5), new THREE.Vector3(0, 0, -1)), 2.2)).toBeNull(); // too far
    expect(portcullisGeometry(port('x', [0, 0, 0])).pos.length).toBeGreaterThan(100);
  });
});

describe('main gate (before the shell lands)', () => {
  it('sits in the gatehouse arch, swings inward, with the portcullis in front', () => {
    const [g] = gateDoorSpecs(), p = gatePortcullisSpec(), f = gatehouseFrame();
    expect(g.kind).toBe('gate');
    expect(g.normal[0]).toBeCloseTo(-f.out[0]); expect(g.normal[1]).toBeCloseTo(-f.out[1]);
    expect(g.swingInto).toBe(1);
    // the leaves sit behind (inside) the portcullis groove
    const dot = (a: V3) => (a[0] - g.centre[0]) * g.normal[0] + (a[2] - g.centre[2]) * g.normal[1];
    for (const pl of placeLeaves(g)) expect(dot(pl.pivot)).toBeGreaterThan(dot(p.centre));
    expect(p.door).toBe(g.id);
    expect(p.reach.head!(0)).toBeCloseTo(5.6, 1);
    expect(p.reach.head!(1.9)).toBeCloseTo(4.0, 1);
    expect(inDoorway(g, g.centre[0], g.centre[2])).toBe(true);
    expect(inDoorway(g, g.centre[0] + 50, g.centre[2])).toBe(false);
    const sys = buildDoors(gateDoorSpecs(), M, undefined, { batch: fakeBatch().factory, portcullis: [p] });
    expect(sys.isPassable('main-gate')).toBe(false);
    sys.setOpen('main-gate', true, true);
    expect(sys.isPassable('main-gate')).toBe(true);
    expect(sys.state()['main-portcullis']).toBe(1);
  });
});
