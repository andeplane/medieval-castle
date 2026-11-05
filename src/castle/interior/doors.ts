// Door leaves, the main gate (two leaves and a wicket) and the gate portcullis: swing animation,
// blocking by characters, kinematic colliders, the interactables E / click uses, and a small API for
// NPC pathfinding (request / isOpen / isPassable). Geometry comes from doorParts.ts; rendering goes
// through a BatchLike (doorBatch.ts): one BatchedMesh per material for all doors, one instance per
// leaf whose matrix is rewritten while it moves. Collaborators (physics, materials, batches, sound,
// character positions) are injected; time comes in through update(dt).
import * as THREE from 'three/webgpu';
import type { DoorSpec, Interactable, PhysicsApi, V3, Quat } from './types';
import { rngFor } from '../../core/rng';
import { GROUND, GATEHOUSE } from '../spec';
import { gatehouseFrame } from '../layout';
import { add, scale, type V2 } from '../../core/math2d';
import { placeLeaves, leafClassFor, leafMatrix, leafPoint, m4mul, m4swing, m4droop, m4translate, KIND, type LeafPlace, type M4 } from './doorGeom';
import { leafGeometry, wicketGeometry, mirrorX, slab, WICKET_CLEAR, type PartBin, type Box3, type LeafGeom } from './doorParts';
import { threeBatch, type BatchFactory, type BatchLike } from './doorBatch';

export type DoorSound = 'creak' | 'latch' | 'thud' | 'bump' | 'clank' | 'chain';
export interface Vec3Like { x: number; y: number; z: number }
export interface SoundSink { play(s: DoorSound, pos: V3, weight: number): void }

export interface DoorSystem {
  object: THREE.Group;
  interactables: Interactable[];
  /** Advance by dt seconds. playerPos (if given) and every registered character block swinging leaves. */
  update(dt: number, playerPos?: Vec3Like): void;
  setOpen(id: string, open: boolean, instant?: boolean): void;
  /** Openness 0..1 per id (gate wicket: `<id>:wicket`; portcullis: its id, 1 = raised). */
  state(): Record<string, number>;
  /** For any agent (NPCs too): ask door `id` to open/close from `by.pos`; false if unknown or out of reach. */
  request(id: string, open: boolean, by: { pos: Vec3Like }): boolean;
  /** Fully open (or raised). Archways (no leaf) are always open. */
  isOpen(id: string): boolean;
  /** A character (0.6 m wide) can get through now: enough gap, an open wicket, a raised portcullis. */
  isPassable(id: string): boolean;
  /** Would a character capsule (r 0.3) at p overlap a leaf or a lowered portcullis? (simple walkers) */
  blocksPlayer(p: Vec3Like): boolean;
  /** Triangles in one copy of every leaf placed (for budgets). */
  triangles: number;
  /** Show or hide a door's leaves (and wicket, fixed iron) with its rooms (cell visibility). */
  setVisible(id: string, visible: boolean): void;
}

export interface DoorOptions {
  /** Fraction of ordinary doors left ajar (seeded). Default 0.12. */
  ajar?: number;
  /** Start every door at this openness (captures). */
  initial?: number;
  portcullis?: PortcullisSpec[];
  sound?: SoundSink;
  /** Everyone besides the player whose body should stop a swinging leaf (NPCs). */
  characters?: () => Vec3Like[];
  batch?: BatchFactory;
}

/** A portcullis: an iron grid sliding in a groove across an opening. */
export interface PortcullisSpec {
  id: string;
  centre: V3;      // bottom centre of the grid when lowered (on the sill), on the groove plane
  along: V2;       // unit, across the opening
  width: number;   // grid width
  height: number;  // grid height (taller than the opening: the top stays in the slot above the arch)
  lift: number;    // how far it rises when raised
  raised: boolean; // initial state
  reach: { w: number; h: number; head?: (s: number) => number }; // the opening it shows in (aim box)
  door?: string;   // the door it guards: isPassable(door) also needs it raised
}

/** Inside the opening of a door (through the wall thickness, plus `out` beyond each face), `inset` from the jambs. */
export function inDoorway(d: DoorSpec, x: number, z: number, inset = 0.3, out = 0.9) {
  const dx = x - d.centre[0], dz = z - d.centre[2];
  const across = dx * -d.normal[1] + dz * d.normal[0], through = dx * d.normal[0] + dz * d.normal[1];
  return Math.abs(across) < d.width / 2 - inset && Math.abs(through) < d.wall / 2 + out;
}

// ------------------------------------------------------------------------- the main gate (no shell)

/** Gate and portcullis read from the gatehouse in castle.ts, until the shell emits its own DoorSpecs. */
export function gateDoorSpecs(): DoorSpec[] {
  const g = gatehouseFrame(), P = GATEHOUSE.project, depth = 5.2;
  const front = add(g.base, scale(g.out, P));
  const c = add(front, scale(g.out, -depth / 2));
  return [{
    id: 'main-gate', spaces: ['outside', 'gate'], centre: [c[0], GROUND - 0.1, c[1]], along: g.dir, normal: [-g.out[0], -g.out[1]],
    width: 3.8, height: 4.0, wall: depth, head: 'pointed', leaf: true, hinge: 'left', swingInto: 1,
    rebate: depth - 1.05, kind: 'gate',
  }];
}
export function gatePortcullisSpec(): PortcullisSpec {
  const g = gatehouseFrame(), P = GATEHOUSE.project;
  const p = add(g.base, scale(g.out, P - 0.7));
  const w = 3.8, h = 4.0, rise = 1.6, R = (w * w / 4 + rise * rise) / w, cc = w / 2 - R;
  return {
    id: 'main-portcullis', centre: [p[0], GROUND - 0.1, p[1]], along: g.dir, width: w - 0.1, height: h + rise + 0.4, lift: 2.75, raised: true, door: 'main-gate',
    reach: { w, h: h + rise, head: (s) => h + Math.sqrt(Math.max(0, R * R - (Math.abs(s) - cc) ** 2)) },
  };
}

// ------------------------------------------------------------------------- runtime

type Body = { setPose(p: V3, q: Quat): void; remove(): void };
interface Leaf {
  place: LeafPlace;
  geom: LeafGeom;
  parent?: Leaf;           // the gate leaf a wicket hangs in
  offset?: M4;             // wicket pivot in the parent's (unmirrored) local space
  angle: number; vel: number; max: number;
  droop: number;           // gate sag while moving (radians)
  judder: number;          // phase
  wood: number; iron: number; // instance ids (−1 = none)
  bodies: Body[];
  matrix: M4;
}
interface Unit {
  id: string; kind: DoorSpec['kind'] | 'wicket'; leaves: Leaf[]; open: boolean; moving: boolean; blocked: boolean;
  weight: number; pos: V3; width: number; wicket?: Unit;
}
interface Port { spec: PortcullisSpec; geom: PartBin; offset: number; target: number; phase: number; moving: boolean; iron: number; body: Body | null }

export const REACH_NPC = 2.6;   // how close an agent must be to request a door
export const PASS_WIDTH = 0.62; // clear gap a character (r 0.3) needs
const R = 0.3;                  // character capsule radius

/** Rotation part of a rigid column-major matrix as a quaternion [x, y, z, w]. */
export function m4quat(m: M4): Quat {
  const m11 = m[0], m12 = m[4], m13 = m[8], m21 = m[1], m22 = m[5], m23 = m[9], m31 = m[2], m32 = m[6], m33 = m[10];
  const tr = m11 + m22 + m33;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); return [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s]; }
  if (m11 > m22 && m11 > m33) { const s = 2 * Math.sqrt(1 + m11 - m22 - m33); return [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s]; }
  if (m22 > m33) { const s = 2 * Math.sqrt(1 + m22 - m11 - m33); return [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s]; }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22); return [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
}

/** Slab-method ray / box test; entry distance (0 if inside), null on a miss. */
export function rayBox(o: V3, d: V3, b: Box3, pad: number): number | null {
  let t0 = 0, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    const lo = b.min[i] - pad, hi = b.max[i] + pad;
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < lo || o[i] > hi) return null; continue; }
    let a = (lo - o[i]) / d[i], c = (hi - o[i]) / d[i];
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, c);
    if (t0 > t1) return null;
  }
  return t0;
}

/** World point into a leaf's local (unmirrored) space, given its world matrix. */
function toLocal(m: M4, mirrored: boolean, x: number, y: number, z: number): V3 {
  const dx = x - m[12], dy = y - m[13], dz = z - m[14];
  const lx = m[0] * dx + m[1] * dy + m[2] * dz;
  return [mirrored ? -lx : lx, m[4] * dx + m[5] * dy + m[6] * dz, m[8] * dx + m[9] * dy + m[10] * dz];
}

export function buildDoors(doors: DoorSpec[], M: { wood: THREE.Material; iron: THREE.Material; trim: THREE.Material }, physics?: PhysicsApi, opts: DoorOptions = {}): DoorSystem {
  const object = new THREE.Group(); object.name = 'doors';
  const sound = (s: DoorSound, p: V3, w: number) => opts.sound?.play(s, p, w);
  const ajarRate = opts.ajar ?? 0.12;
  const makeBatch = opts.batch ?? threeBatch;

  // --- geometry per class and hand (mirrored), shared by every leaf of that class
  const classGeom = new Map<string, LeafGeom>();
  const variants = new Map<string, { wood: PartBin; iron: PartBin; fixed: PartBin }>();
  const variant = (key: string, g: LeafGeom, mirrored: boolean) => {
    const k = key + (mirrored ? '|M' : '|R');
    if (!variants.has(k)) variants.set(k, mirrored ? { wood: mirrorX(g.wood), iron: mirrorX(g.iron), fixed: mirrorX(g.fixed) } : { wood: g.wood, iron: g.iron, fixed: g.fixed });
    return k;
  };
  const getGeom = (key: string, make: () => LeafGeom) => { let g = classGeom.get(key); if (!g) { g = make(); classGeom.set(key, g); } return g; };

  const units: Unit[] = [], leaves: Leaf[] = [], open: string[] = [];
  const pending: { leaf: Leaf; vk: string; fixed: boolean }[] = [];
  const newLeaf = (place: LeafPlace, geom: LeafGeom, max: number): Leaf => ({ place, geom, angle: 0, vel: 0, max, droop: 0, judder: 0, wood: -1, iron: -1, bodies: [], matrix: [] });
  for (const d of doors) {
    const places = placeLeaves(d);
    if (!places.length) { open.push(d.id); continue; }
    const unit: Unit = {
      id: d.id, kind: d.kind, leaves: [], open: false, moving: false, blocked: false, width: d.width,
      weight: d.kind === 'gate' ? 2.2 : d.kind === 'postern' ? 1.3 : d.kind === 'grille' ? 1.1 : 1, pos: [d.centre[0], d.centre[1] + 1.2, d.centre[2]],
    };
    for (const pl of places) {
      const g = getGeom(pl.classKey, () => leafGeometry(leafClassFor(d, pl.kind), rngFor('door-class:' + pl.classKey), { wicket: !!pl.wicket }));
      const leaf = newLeaf(pl, g, pl.maxAngle);
      unit.leaves.push(leaf); leaves.push(leaf);
      pending.push({ leaf, vk: variant(pl.classKey, g, pl.mirrored), fixed: true });
      if (pl.wicket && g.wicket) {
        const wk = pl.classKey + ':wicket', hole = g.wicket;
        const wg = getGeom(wk, () => wicketGeometry(hole, rngFor('door-class:' + wk)));
        const wl = newLeaf({ ...pl, door: d.id + ':wicket', kind: 'wicket', classKey: wk, width: wg.width, height: wg.height, wicket: false, maxAngle: Math.PI / 2 }, wg, Math.PI / 2);
        wl.parent = leaf; wl.offset = m4translate(hole.x0 + WICKET_CLEAR, hole.y0 + WICKET_CLEAR, 0);
        leaves.push(wl);
        pending.push({ leaf: wl, vk: variant(wk, wg, pl.mirrored), fixed: false });
        unit.wicket = { id: d.id + ':wicket', kind: 'wicket', leaves: [wl], open: false, moving: false, blocked: false, weight: 1.1, pos: unit.pos, width: hole.x1 - hole.x0 };
        units.push(unit.wicket);
      }
    }
    units.push(unit);
    // a few ordinary doors left ajar, seeded per door
    const r = rngFor('door-ajar:' + d.id);
    if ((d.kind === 'plank' || d.kind === 'postern') && r() < ajarRate) { const a = 0.12 + r() * 0.5; for (const l of unit.leaves) l.angle = l.max * a; }
    if (opts.initial !== undefined) for (const l of unit.leaves) l.angle = l.max * opts.initial;
  }
  const ports: Port[] = (opts.portcullis ?? []).map((p) => ({ spec: p, geom: portcullisGeometry(p), offset: p.raised ? p.lift : 0, target: p.raised ? p.lift : 0, phase: 0, moving: false, iron: -1, body: null }));

  // --- batches: one per material
  let woodV = 0, ironV = 0, tris = 0;
  for (const [, v] of variants) { woodV += v.wood.pos.length / 3; ironV += (v.iron.pos.length + v.fixed.pos.length) / 3; }
  for (const p of ports) ironV += p.geom.pos.length / 3;
  const wood: BatchLike = makeBatch('doors-wood', M.wood, pending.length, woodV);
  const iron: BatchLike = makeBatch('doors-iron', M.iron, pending.length * 2 + ports.length, ironV);
  object.add(wood.object, iron.object);
  const ids = new Map<string, { wood: number; iron: number; fixed: number }>();
  // batch instances per door id, for setVisible
  const inst = new Map<string, { wood: number[]; iron: number[] }>();
  const instOf = (door: string) => inst.get(door) ?? inst.set(door, { wood: [], iron: [] }).get(door)!;
  for (const [k, v] of variants) ids.set(k, { wood: v.wood.pos.length ? wood.addGeometry(v.wood) : -1, iron: v.iron.pos.length ? iron.addGeometry(v.iron) : -1, fixed: v.fixed.pos.length ? iron.addGeometry(v.fixed) : -1 });
  for (const { leaf, vk, fixed } of pending) {
    const id = ids.get(vk)!, v = variants.get(vk)!;
    tris += (v.wood.pos.length + v.iron.pos.length + (fixed ? v.fixed.pos.length : 0)) / 9;
    if (id.wood >= 0) {
      leaf.wood = wood.addInstance(id.wood);
      // oak from fresh honey-brown to grey and weathered
      const r = rngFor('door-tint:' + leaf.place.door), grey = r(), k = 0.62 + r() * 0.3;
      wood.setColorAt(leaf.wood, [k * (1 - grey * 0.12), k * (0.9 - grey * 0.02), k * (0.8 + grey * 0.12)]);
    }
    if (id.iron >= 0) leaf.iron = iron.addInstance(id.iron);
    const own = instOf(leaf.place.door);
    if (leaf.wood >= 0) own.wood.push(leaf.wood);
    if (leaf.iron >= 0) own.iron.push(leaf.iron);
    if (fixed && id.fixed >= 0) { const f = iron.addInstance(id.fixed); own.iron.push(f); iron.setMatrixAt(f, leafMatrix(leaf.place, m4swing(0))); }
  }
  for (const p of ports) { p.iron = iron.addInstance(iron.addGeometry(p.geom)); instOf(p.spec.id).iron.push(p.iron); tris += p.geom.pos.length / 9; }

  // --- physics: one kinematic box per solid part of each leaf
  if (physics) {
    for (const l of leaves) for (const b of l.geom.boxes) l.bodies.push(physics.addKinematicBox([(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2], 'door:' + l.place.door));
    for (const p of ports) p.body = physics.addKinematicBox([p.spec.width / 2, p.spec.height / 2, 0.06], 'door:' + p.spec.id);
  }

  // --- posing
  const localOf = (l: Leaf, angle = l.angle): M4 => (l.droop ? m4mul(m4swing(angle), m4droop(l.droop)) : m4swing(angle));
  const worldOf = (l: Leaf, angle = l.angle): M4 => (l.parent ? leafMatrix(l.parent.place, m4mul(localOf(l.parent), m4mul(l.offset!, localOf(l, angle)))) : leafMatrix(l.place, localOf(l, angle)));
  const leafToWorld = (l: Leaf, p: V3): V3 => (l.parent ? leafPoint(l.parent.place, m4mul(localOf(l.parent), m4mul(l.offset!, localOf(l))), p) : leafPoint(l.place, localOf(l), p));
  const pose = (l: Leaf) => {
    l.matrix = worldOf(l);
    if (l.wood >= 0) wood.setMatrixAt(l.wood, l.matrix);
    if (l.iron >= 0) iron.setMatrixAt(l.iron, l.matrix);
    if (l.bodies.length) {
      const q = m4quat(l.matrix);
      l.geom.boxes.forEach((b, i) => l.bodies[i].setPose(leafToWorld(l, [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]), q));
    }
  };
  const portMatrix = (p: Port): M4 => {
    // x along, y up, z = along × up (det +1)
    const s = p.spec, z: V2 = [-s.along[1], s.along[0]];
    return [s.along[0], 0, s.along[1], 0, 0, 1, 0, 0, z[0], 0, z[1], 0, s.centre[0], s.centre[1] + p.offset, s.centre[2], 1];
  };
  const posePort = (p: Port) => {
    const m = portMatrix(p);
    iron.setMatrixAt(p.iron, m);
    p.body?.setPose([m[12], m[13] + p.spec.height / 2, m[14]], m4quat(m));
  };
  for (const l of leaves) pose(l);
  for (const p of ports) posePort(p);

  // --- blocking: is a character capsule (r 0.3) inside a leaf's boxes at this angle?
  const blocks = (l: Leaf, angle: number, who: Vec3Like[]) => {
    if (!who.length) return false;
    const m = worldOf(l, angle);
    for (const pp of who) {
      const [lx, ly, lz] = toLocal(m, l.place.mirrored, pp.x, pp.y, pp.z);
      if (ly < -0.6 || ly > l.geom.height + 1.9) continue;
      for (const b of l.geom.boxes) {
        const cx = Math.max(b.min[0], Math.min(b.max[0], lx)), cz = Math.max(b.min[2], Math.min(b.max[2], lz));
        if (Math.hypot(lx - cx, lz - cz) < R + 0.02) return true;
      }
    }
    return false;
  };
  const portUnder = (p: Port, pp: Vec3Like) => {
    const s = p.spec, dx = pp.x - s.centre[0], dz = pp.z - s.centre[2];
    const across = dx * s.along[0] + dz * s.along[1], through = dx * -s.along[1] + dz * s.along[0];
    return Math.abs(across) < s.width / 2 + R && Math.abs(through) < R + 0.08 && pp.y - s.centre[1] < 3.2 && pp.y - s.centre[1] > -1;
  };

  // --- animation
  const unitPos = (u: Unit): V3 => (u.leaves[0].parent ? leafToWorld(u.leaves[0], [u.leaves[0].geom.width / 2, 1, 0]) : u.pos);
  const heavy = (u: Unit) => u.kind === 'gate';
  const step = (u: Unit, dt: number, who: Vec3Like[]) => {
    let any = false, blockedNow = false;
    for (const l of u.leaves) {
      const goal = u.open ? l.max : 0;
      let a = l.angle, v = l.vel;
      if (Math.abs(goal - a) < 1e-6) {
        if (l.droop) { l.droop *= Math.exp(-dt * 6); if (Math.abs(l.droop) < 1e-5) l.droop = 0; pose(l); any = true; }
        continue;
      }
      if (u.open) {
        // pushed open: quick start, settles slowly on its hinges
        const k = heavy(u) ? 1.1 : u.kind === 'grille' ? 2.2 : 2.6, minV = heavy(u) ? 0.05 : 0.12;
        a += Math.max((goal - a) * (1 - Math.exp(-k * dt)), Math.min(goal - a, minV * dt));
        if (goal - a < 2e-3) a = goal;
        v = 0;
      } else {
        // pulled shut: accelerates and lands with a thud
        const acc = heavy(u) ? 0.55 : 3.2, vmax = heavy(u) ? 0.75 : 2.6;
        v = Math.min(vmax, v + acc * dt);
        a = Math.max(0, a - v * dt);
      }
      any = true;
      if (blocks(l, a, who)) {
        if (!u.blocked) sound('bump', unitPos(u), u.weight);
        blockedNow = true; l.vel = 0;
        continue;
      }
      if (heavy(u)) {
        // a heavy leaf sags a little on its pintles while it moves, and judders
        l.judder += dt * 9;
        const speed = Math.abs(a - l.angle) / Math.max(dt, 1e-4);
        l.droop = -0.004 * Math.min(1, speed * 4) - 0.0012 * Math.sin(l.judder) * Math.min(1, speed * 6);
      }
      const shut = a === 0;
      l.angle = a; l.vel = shut ? 0 : v;
      if (shut) { l.droop = 0; sound('thud', unitPos(u), u.weight); sound('latch', unitPos(u), u.weight * 0.8); }
      pose(l);
    }
    u.blocked = blockedNow;
    if (!any) u.moving = false;
    // a wicket rides on its gate leaf
    if (u.wicket && any) for (const l of u.wicket.leaves) pose(l);
  };
  const openness = (u: Unit) => u.leaves.reduce((s, l) => s + l.angle / l.max, 0) / u.leaves.length;
  const setUnit = (u: Unit, open: boolean, instant = false) => {
    if (instant) {
      u.open = open; u.moving = false;
      for (const l of u.leaves) { l.angle = open ? l.max : 0; l.vel = 0; l.droop = 0; pose(l); }
      if (u.wicket) for (const l of u.wicket.leaves) pose(l);
      return;
    }
    if (u.open === open && (u.moving || openness(u) === (open ? 1 : 0))) return;
    u.open = open; u.moving = true;
    if (open) { sound('latch', unitPos(u), u.weight * 0.8); sound('creak', unitPos(u), u.weight); } else sound('creak', unitPos(u), u.weight * 0.7);
  };
  /** What a toggle does next: a moving door reverses, a door at rest part-open closes. */
  const willOpen = (u: Unit) => (u.moving ? !u.open : openness(u) <= 0.02);

  const byId = new Map(units.map((u) => [u.id, u]));
  const portById = new Map(ports.map((p) => [p.spec.id, p]));
  const portRaised = (p: Port) => (p.moving ? p.target > p.offset : p.offset > p.spec.lift / 2);
  const setPort = (p: Port, raised: boolean, instant = false) => {
    p.target = raised ? p.spec.lift : 0;
    if (instant) { p.offset = p.target; p.moving = false; posePort(p); return; }
    if (p.offset === p.target) return;
    if (!p.moving) sound('chain', [p.spec.centre[0], p.spec.centre[1] + 3, p.spec.centre[2]], 1.6);
    p.moving = true;
  };
  const TOOTH = 0.09;
  const stepPort = (p: Port, dt: number, who: Vec3Like[]) => {
    const up = p.target > p.offset, before = p.offset;
    if (up) {
      // windlass ratchet: each tooth is a heave, then the pawl catches
      p.phase += dt * 2.6;
      p.offset = Math.min(p.target, p.offset + 0.92 * Math.sin(p.phase * Math.PI) ** 2 * dt);
    } else {
      // let down on the brake: steady, a click per tooth, and it will not come down on anyone
      const next = Math.max(p.target, p.offset - 0.85 * dt);
      if (next < 2.05 && who.some((w) => portUnder(p, w))) return;
      p.offset = next;
    }
    const pos: V3 = [p.spec.centre[0], p.spec.centre[1] + 3, p.spec.centre[2]];
    if (Math.floor(before / TOOTH) !== Math.floor(p.offset / TOOTH)) sound('clank', pos, up ? 1.2 : 0.8);
    if (Math.abs(p.offset - p.target) < 1e-6) { p.offset = p.target; p.moving = false; p.phase = 0; sound(up ? 'clank' : 'thud', pos, 2.4); }
    posePort(p);
  };

  // --- passability (pathfinding)
  const gap = (u: Unit) => {
    // the doorway's clear width left beside the leaves at their current angles
    let used = 0;
    for (const l of u.leaves) { const t = -leafDepthOf(l); used += l.geom.width * Math.cos(l.angle) + t * Math.sin(l.angle) + 0.02; }
    return u.width - used;
  };
  const passable = (u: Unit): boolean => gap(u) >= PASS_WIDTH || (!!u.wicket && passable(u.wicket));

  // --- interactables
  const hitLeaf = (l: Leaf, ray: THREE.Ray, maxDist: number): number | null => {
    const m = l.matrix, o = ray.origin, d = ray.direction;
    const lo = toLocal(m, l.place.mirrored, o.x, o.y, o.z);
    let dx = m[0] * d.x + m[1] * d.y + m[2] * d.z;
    if (l.place.mirrored) dx = -dx;
    const ld: V3 = [dx, m[4] * d.x + m[5] * d.y + m[6] * d.z, m[8] * d.x + m[9] * d.y + m[10] * d.z];
    let best: number | null = null;
    for (const b of l.geom.boxes) { const t = rayBox(lo, ld, b, 0.02); if (t !== null && t <= maxDist && (best === null || t < best)) best = t; }
    return best;
  };
  const labels: Record<Unit['kind'], [string, string]> = { gate: ['Open gate', 'Close gate'], wicket: ['Open wicket', 'Close wicket'], grille: ['Open grille', 'Close grille'], plank: ['Open door', 'Close door'], postern: ['Open door', 'Close door'] };
  const interactables: Interactable[] = units.map((u) => ({
    id: u.id,
    label: () => labels[u.kind][willOpen(u) ? 0 : 1],
    hit: (ray, maxDist) => { let best: number | null = null; for (const l of u.leaves) { const t = hitLeaf(l, ray, maxDist); if (t !== null && (best === null || t < best)) best = t; } return best; },
    use: () => setUnit(u, willOpen(u)),
  }));
  for (const p of ports) {
    interactables.push({
      id: p.spec.id,
      label: () => (portRaised(p) ? 'Lower portcullis' : 'Raise portcullis'),
      hit: (ray, maxDist) => {
        // the part of the grid showing in the opening, as a thin slab on the groove plane
        const s = p.spec, o = ray.origin, d = ray.direction, z: V2 = [-s.along[1], s.along[0]];
        const tx = o.x - s.centre[0], ty = o.y - s.centre[1], tz = o.z - s.centre[2];
        const lo: V3 = [tx * s.along[0] + tz * s.along[1], ty, tx * z[0] + tz * z[1]];
        const ld: V3 = [d.x * s.along[0] + d.z * s.along[1], d.y, d.x * z[0] + d.z * z[1]];
        const t = rayBox(lo, ld, { min: [-s.reach.w / 2, p.offset, -0.15], max: [s.reach.w / 2, s.reach.h, 0.15] }, 0);
        if (t === null || t > maxDist) return null;
        if (s.reach.head && lo[1] + ld[1] * t > s.reach.head(lo[0] + ld[0] * t)) return null;
        return t;
      },
      use: () => setPort(p, !portRaised(p)),
    });
  }

  const posOf = (id: string): V3 | null => { const u = byId.get(id); if (u) return unitPos(u); const p = portById.get(id); return p ? [p.spec.centre[0], p.spec.centre[1] + 1.2, p.spec.centre[2]] : null; };
  const setOpen = (id: string, o: boolean, instant?: boolean) => {
    const u = byId.get(id);
    if (u) return setUnit(u, o, instant);
    const p = portById.get(id);
    if (p) setPort(p, o, instant);
  };

  return {
    object, interactables, triangles: Math.round(tris),
    update(dt, playerPos) {
      dt = Math.min(dt, 0.1);
      const who = [...(playerPos ? [playerPos] : []), ...(opts.characters?.() ?? [])];
      for (const u of units) if (u.moving || u.leaves.some((l) => l.droop)) step(u, dt, who);
      for (const p of ports) if (p.moving) stepPort(p, dt, who);
    },
    setOpen,
    setVisible(id, visible) {
      const own = inst.get(id);
      if (!own) return;
      for (const i of own.wood) wood.setVisibleAt(i, visible);
      for (const i of own.iron) iron.setVisibleAt(i, visible);
    },
    state() {
      const o: Record<string, number> = {};
      for (const u of units) o[u.id] = Math.round(openness(u) * 1000) / 1000;
      for (const p of ports) o[p.spec.id] = Math.round((p.offset / p.spec.lift) * 1000) / 1000;
      return o;
    },
    request(id, o, by) {
      const c = posOf(id);
      if (!c || Math.hypot(by.pos.x - c[0], by.pos.z - c[2]) > REACH_NPC) return false;
      setOpen(id, o);
      return true;
    },
    isOpen(id) {
      if (open.includes(id)) return true;
      const u = byId.get(id);
      if (u) return openness(u) >= 0.95;
      const p = portById.get(id);
      return !!p && p.offset >= p.spec.lift - 1e-3;
    },
    isPassable(id) {
      if (open.includes(id)) return true;
      const guard = ports.find((p) => p.spec.door === id || p.spec.id === id);
      if (guard && guard.offset < 2.0) return false;
      const u = byId.get(id);
      return u ? passable(u) : !!guard;
    },
    blocksPlayer(pp) {
      return leaves.some((l) => blocks(l, l.angle, [pp])) || ports.some((p) => p.offset < 2.0 && portUnder(p, pp));
    },
  };
}

const leafDepthOf = (l: Leaf) => -(KIND[l.place.kind].t + KIND[l.place.kind].ledge);

/** Portcullis grid: square iron bars with spiked feet and cross rails. Local x across, y up, z through. */
export function portcullisGeometry(s: PortcullisSpec): PartBin {
  const b: PartBin = { pos: [], nor: [], uv: [] };
  const n = Math.max(3, Math.round(s.width / 0.32)), bs = 0.075, h = bs / 2;
  for (let i = 0; i <= n; i++) {
    const x = -s.width / 2 + h + ((s.width - bs) * i) / n;
    slab(b, [[x - h, 0.16], [x + h, 0.16], [x + h, s.height], [x - h, s.height]], -h, h, 0.006);
    slab(b, [[x - h, 0.16], [x + h, 0.16], [x, 0]], -h * 0.8, h * 0.8, 0); // spike
  }
  for (let y = 0.45; y < s.height - 0.1; y += 0.45) slab(b, [[-s.width / 2, y - 0.035], [s.width / 2, y - 0.035], [s.width / 2, y + 0.035], [-s.width / 2, y + 0.035]], h, h + 0.06, 0.006);
  return b;
}
