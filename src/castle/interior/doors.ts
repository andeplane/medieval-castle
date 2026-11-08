// Door leaves and the gate portcullis with its windlass: swing and lift animation, blocking by
// characters, kinematic colliders, the interactables E / click uses, and a small API for NPC pathfinding
// (request / isOpen / isPassable). Every door is one whole leaf; a gate has none, its portcullis closes
// it (portcullis.ts holds the state machine and geometry). Rendering goes through a BatchLike
// (doorBatch.ts): one BatchedMesh per material for everything here, one instance per moving part whose
// matrix is rewritten while it moves. Collaborators (physics, materials, batches, sound, character
// positions) are injected; time comes in through update(dt).
import * as THREE from 'three/webgpu';
import type { DoorSpec, Interactable, PhysicsApi, V3, Quat } from './types';
import { rngFor } from '../../core/rng';
import { placeLeaves, swingAwayFrom, leafClassFor, leafMatrix, leafPoint, leafSwing, m4mul, m4translate, m4scale, m4rotX, m4apply, KIND, type LeafPlace, type M4 } from './doorGeom';
import { leafGeometry, mirrorX, type PartBin, type Box3, type LeafGeom } from './doorParts';
import { threeBatch, type BatchFactory, type BatchLike } from './doorBatch';
import {
  portAt, portCommand, portStep, willRaise, blocking, underGrille, portFrame, toPort, drumAngle, ropeLength, coilWidth,
  grilleGeometry, gateFixtures, drumGeometry, ropeGeometry, coilGeometry, SEAT, BAR, DRUM_R,
  type PortcullisSpec, type PortState, type PortEvent, type WinchSpec,
} from './portcullis';

export type DoorSound = 'creak' | 'latch' | 'thud' | 'bump' | 'clank' | 'chain';
export interface Vec3Like { x: number; y: number; z: number }
/** Whoever opens or closes a door: where they stand, and optionally where they look (for one in the door's plane). */
export interface Opener { pos: Vec3Like; dir?: Vec3Like }
export interface SoundSink { play(s: DoorSound, pos: V3, weight: number): void }

export interface DoorSystem {
  object: THREE.Group;
  interactables: Interactable[];
  /** Advance by dt seconds. playerPos (if given) and every registered character block moving parts. */
  update(dt: number, playerPos?: Vec3Like): void;
  /** Open or close a door (or raise / lower a portcullis); with `by`, a shut leaf opens away from them where it
   *  can (swingAwayFrom). A leaf never leaves its seat: only the way it swings is chosen, and only here. */
  setOpen(id: string, open: boolean, instant?: boolean, by?: Opener): void;
  /** Openness 0..1 per id (a portcullis: its gate's id, 1 = raised). */
  state(): Record<string, number>;
  /** For any agent (NPCs too): ask door `id` to open/close from `by.pos`; false if unknown or out of reach.
   *  A shut leaf opens away from `by` where it can (swingAwayFrom). */
  request(id: string, open: boolean, by: Opener): boolean;
  /** The space a door's leaf swings into now (index into its spaces), or null for no leaf or an unknown id. */
  swingsInto(id: string): 0 | 1 | null;
  /** A leaf's world matrix now (column-major), or null for no leaf or an unknown id. */
  leafPose(id: string): number[] | null;
  /** Fully open (or raised). Archways (no leaf) are always open. */
  isOpen(id: string): boolean;
  /** A character (0.6 m wide) can get through now: enough gap beside the leaf, or the portcullis up past head height. */
  isPassable(id: string): boolean;
  /** Would a character capsule (r 0.3) at p touch a leaf (within LEAF_CLEAR) or a lowered portcullis? (simple walkers) */
  blocksPlayer(p: Vec3Like): boolean;
  /** Triangles in one copy of every part placed (for budgets). */
  triangles: number;
  /** Show or hide a door's leaf and fixed iron with its rooms (cell visibility); for a portcullis, `id` is
   *  its grille and `id + ':winch'` its windlass, and the fixtures shared by both stay while either is shown. */
  setVisible(id: string, visible: boolean): void;
}

export interface DoorOptions {
  /** Fraction of ordinary doors left ajar (seeded). Default 0.12. */
  ajar?: number;
  /** Start every door (and portcullis) at this openness (captures). Portcullises default to raised. */
  initial?: number;
  /** Doors that start standing wide open (castle/interior/nav.ts doorsOnWayToCaves: the way down is seen). */
  standOpen?: ReadonlySet<string>;
  portcullis?: PortcullisSpec[];
  sound?: SoundSink;
  /** Everyone besides the player whose body should stop a moving leaf or portcullis (NPCs). */
  characters?: () => Vec3Like[];
  batch?: BatchFactory;
  /** Materials for the faces of a leaf that look into the courtyard or outside (sun and sky). Without
   *  them every face takes `M`, the materials of the rooms. */
  outdoor?: DoorMats;
}

export type DoorMats = { wood: THREE.Material; iron: THREE.Material };
/** Courtyard and outside are lit by the sun and sky; every other space is a room, lit as an interior. */
export const isOutdoor = (space: string) => space === 'courtyard' || space === 'outside';
/** Past this swing a leaf's trailing face stands in the space it swings into (and is lit as that space). */
export const BACK_SIDE_SWING = Math.PI / 4;

/**
 * A leaf part's triangles split by the side they face: back (−z, away from the swing space) and front (the
 * rest). The edges (board sides in the joints, the leaf's rim) go with the back when `edgesBack`: whichever
 * side is the room's while the leaf is shut, so a joint seen from a dim room is not lit by the sun.
 */
export function splitBySide(b: PartBin, edgesBack = false): { front: PartBin; back: PartBin } {
  const front: PartBin = { pos: [], nor: [], uv: [] }, back: PartBin = { pos: [], nor: [], uv: [] };
  for (let t = 0; t < b.pos.length / 9; t++) {
    const nz = b.nor[t * 9 + 2], o = nz < -0.2 || (edgesBack && nz <= 0.2) ? back : front;
    o.pos.push(...b.pos.slice(t * 9, t * 9 + 9)); o.nor.push(...b.nor.slice(t * 9, t * 9 + 9)); o.uv.push(...b.uv.slice(t * 6, t * 6 + 6));
  }
  return { front, back };
}

/** Inside the opening of a door (through the wall thickness, plus `out` beyond each face), `inset` from the jambs. */
export function inDoorway(d: DoorSpec, x: number, z: number, inset = 0.3, out = 0.9) {
  const dx = x - d.centre[0], dz = z - d.centre[2];
  const across = dx * -d.normal[1] + dz * d.normal[0], through = dx * d.normal[0] + dz * d.normal[1];
  return Math.abs(across) < d.width / 2 - inset && Math.abs(through) < d.wall / 2 + out;
}

// ------------------------------------------------------------------------- runtime

type Body = { setPose(p: V3, q: Quat): void; remove(): void };
interface Leaf {
  /** Where the leaf hangs: its one seat, which it never leaves. */
  place: LeafPlace;
  geom: LeafGeom;
  /** Which way it swings now (+1 forward on its pintles, −1 back on its back edge) and how far (≥ 0). */
  dir: 1 | -1;
  angle: number; vel: number;
  /** Batch instances drawing the leaf; `moves` follow the swing (else jamb iron, posed shut), and one with
   *  `show` is drawn only while that holds (which side's light a face takes depends on the swing). */
  draws: Draw[];
  bodies: Body[];
  matrix: M4;
}
interface Draw { b: BatchLike; i: number; moves: boolean; show?: (l: Leaf) => boolean; leaf?: Leaf }
/** How far a leaf can swing its current way. */
const maxOf = (l: Leaf) => (l.dir > 0 ? l.place.maxAngle : l.place.backAngle);
/** Open its way past BACK_SIDE_SWING: forward (its back face then stands in the forward space), or back. */
const pastFwd = (l: Leaf) => l.dir > 0 && l.angle >= BACK_SIDE_SWING, pastBack = (l: Leaf) => l.dir < 0 && l.angle >= BACK_SIDE_SWING;
interface Unit { id: string; d: DoorSpec; kind: DoorSpec['kind']; leaf: Leaf; open: boolean; moving: boolean; blocked: boolean; weight: number; pos: V3; width: number }
interface Port {
  spec: PortcullisSpec; s: PortState;
  grille: number; drum: number[]; ropes: number[]; coils: number[]; // instance ids
  body: Body | null;
}

export const REACH_NPC = 2.6;   // how close an agent must be to request a door
export const PASS_WIDTH = 0.62; // clear gap a character (r 0.3) needs
const R = 0.3;                  // character capsule radius
// how close a moving leaf may come to a character's axis: the radius, the walking controller's skin (0.02)
// and 6 cm more. A leaf that reaches into the skin is taken as touching: Rapier's controller nudges the
// capsule out of it, the leaf then has room for its next step, and so it ratcheted the character round the
// arc into the corner behind the door and pinned it there against the wall (2026-11-06)
export const LEAF_CLEAR = R + 0.08;
const HEMP: V3 = [1.25, 1.05, 0.72];

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

/**
 * What the crosshair can aim at: a ray entering the box from outside. A ray that starts inside the box
 * (a fly camera inside a shut leaf) sees none of its faces, so it does not hit it.
 */
export function rayEnters(o: V3, d: V3, b: Box3, pad: number): number | null {
  const inside = [0, 1, 2].every((i) => o[i] > b.min[i] - pad && o[i] < b.max[i] + pad);
  return inside ? null : rayBox(o, d, b, pad);
}

/** The windlass as the crosshair sees it (port frame): the drum, the two capstan heads and the two A-frames. */
export function winchBoxes(w: WinchSpec): Box3[] {
  const zc = -DRUM_R, yd = w.drumY, rd = DRUM_R + 0.06, out: Box3[] = [{ min: [-w.frameAt - 0.24, yd - rd, zc - rd], max: [w.frameAt + 0.24, yd + rd, zc + rd] }];
  for (const s of [-1, 1]) {
    const x0 = s * (w.frameAt + 0.1), x1 = s * (w.frameAt + 0.2);
    out.push({ min: [Math.min(x0, x1), yd - 0.62, zc - 0.62], max: [Math.max(x0, x1), yd + 0.62, zc + 0.62] });
    out.push({ min: [s * w.frameAt - 0.09, w.floor, zc - 0.69], max: [s * w.frameAt + 0.09, yd + 0.06, zc + 0.69] });
  }
  return out;
}

/** World point into a leaf's local (unmirrored) space, given its world matrix. */
function toLocal(m: M4, mirrored: boolean, x: number, y: number, z: number): V3 {
  const dx = x - m[12], dy = y - m[13], dz = z - m[14];
  const lx = m[0] * dx + m[1] * dy + m[2] * dz;
  return [mirrored ? -lx : lx, m[4] * dx + m[5] * dy + m[6] * dz, m[8] * dx + m[9] * dy + m[10] * dz];
}

/** The order to add instances in: by geometry id, stable (leaf order within one geometry). */
export function instancesByGeometry<T extends { g: number }>(items: T[]): T[] {
  return items.map((it, k) => ({ it, k })).sort((a, b) => a.it.g - b.it.g || a.k - b.k).map((x) => x.it);
}

export function buildDoors(doors: DoorSpec[], M: DoorMats, physics?: PhysicsApi, opts: DoorOptions = {}): DoorSystem {
  const object = new THREE.Group(); object.name = 'doors';
  const sound = (s: DoorSound, p: V3, w: number) => opts.sound?.play(s, p, w);
  const ajarRate = opts.ajar ?? 0.12;
  const makeBatch = opts.batch ?? threeBatch;

  // --- geometry per class and hand (mirrored), shared by every leaf of that class; a leaf whose two
  // sides are lit differently (a courtyard door) is drawn as its back faces and the rest, apart
  type Bins = { wood: PartBin; iron: PartBin; fixed: PartBin };
  const variants = new Map<string, { geom: LeafGeom; whole: Bins; split: Map<boolean, { front: Bins; back: Bins }> }>();
  // `split`: the two sides are lit differently; `edgesBack`: the shut leaf's back faces the room (splitBySide)
  const variant = (pl: LeafPlace, d: DoorSpec, split: boolean, edgesBack: boolean) => {
    const k = pl.classKey + (pl.mirrored ? '|M' : '|R');
    if (!variants.has(k)) {
      const unm = variants.get(pl.classKey + (pl.mirrored ? '|R' : '|M'))?.geom;
      const g = unm ?? leafGeometry(leafClassFor(d, pl.kind), rngFor('door-class:' + pl.classKey));
      variants.set(k, { geom: g, whole: pl.mirrored ? { wood: mirrorX(g.wood), iron: mirrorX(g.iron), fixed: mirrorX(g.fixed) } : { wood: g.wood, iron: g.iron, fixed: g.fixed }, split: new Map() });
    }
    const v = variants.get(k)!;
    if (split && !v.split.has(edgesBack)) {
      const w = splitBySide(v.whole.wood, edgesBack), i = splitBySide(v.whole.iron, edgesBack), f = splitBySide(v.whole.fixed, edgesBack);
      v.split.set(edgesBack, { front: { wood: w.front, iron: i.front, fixed: f.front }, back: { wood: w.back, iron: i.back, fixed: f.back } });
    }
    return k;
  };

  // which material set lights each side of a door: the rooms', or the outdoor one for courtyard and outside
  const sideOut = (d: DoorSpec): [boolean, boolean] => (opts.outdoor ? [isOutdoor(d.spaces[0]), isOutdoor(d.spaces[1])] : [false, false]);
  const units: Unit[] = [], open: string[] = [], pending: { leaf: Leaf; vk: string; d: DoorSpec }[] = [];
  for (const d of doors) {
    const [pl] = placeLeaves(d);
    if (!pl) { open.push(d.id); continue; }
    const out = sideOut(d), k = d.swingInto, vk = variant(pl, d, out[0] !== out[1], out[k] && !out[1 - k]), geom = variants.get(vk)!.geom;
    const leaf: Leaf = { place: pl, geom, dir: 1, angle: 0, vel: 0, draws: [], bodies: [], matrix: [] };
    const unit: Unit = { id: d.id, d, kind: d.kind, leaf, open: false, moving: false, blocked: false, width: d.width, weight: d.kind === 'postern' ? 1.3 : d.kind === 'grille' ? 1.1 : 1, pos: [d.centre[0], d.centre[1] + 1.2, d.centre[2]] };
    units.push(unit); pending.push({ leaf, vk, d });
    // a few ordinary doors left ajar, seeded per door
    const r = rngFor('door-ajar:' + d.id);
    if ((d.kind === 'plank' || d.kind === 'postern') && r() < ajarRate) leaf.angle = pl.maxAngle * (0.12 + r() * 0.5);
    if (opts.standOpen?.has(d.id)) leaf.angle = pl.maxAngle * 0.9;
    if (opts.initial !== undefined) leaf.angle = pl.maxAngle * opts.initial;
  }

  // --- portcullis parts: grille, fixtures, drum, ropes and coils
  const portSpecs = opts.portcullis ?? [];
  const portGeom = portSpecs.map((p) => ({ grille: grilleGeometry(p), fixed: gateFixtures(p), drum: p.winch ? drumGeometry(p) : null }));
  const rope = ropeGeometry(), coil = coilGeometry();
  const anyWinch = portSpecs.some((p) => p.winch);

  // --- what each leaf draws: [part, outdoor set?, moves, show]. Shut, a split leaf's front faces look into
  // the forward space and its back faces through the doorway into the other; opened forward past
  // BACK_SIDE_SWING its back faces stand in the forward space, opened back that far its front faces in the other.
  type Want = { part: keyof Bins; bin: PartBin; out: boolean; moves: boolean; show?: (l: Leaf) => boolean };
  const wants = pending.map(({ vk, d }) => {
    const list: Want[] = [];
    const out = sideOut(d), sw = out[d.swingInto], other = out[1 - d.swingInto], v = variants.get(vk)!, sp = v.split.get(sw && !other);
    for (const part of ['wood', 'iron', 'fixed'] as const) {
      const moves = part !== 'fixed';
      if (!sp || sw === other) { list.push({ part, bin: v.whole[part], out: sw, moves }); continue; }
      if (moves && d.swingsBack) list.push({ part, bin: sp.front[part], out: sw, moves, show: (l) => !pastBack(l) }, { part, bin: sp.front[part], out: other, moves, show: pastBack });
      else list.push({ part, bin: sp.front[part], out: sw, moves });
      if (moves) list.push({ part, bin: sp.back[part], out: other, moves, show: (l) => !pastFwd(l) }, { part, bin: sp.back[part], out: sw, moves, show: pastFwd });
      else list.push({ part, bin: sp.back[part], out: other, moves });
    }
    return list.filter((w) => w.bin.pos.length);
  });

  // --- batches: one per material (the outdoor pair only when some face needs it)
  const vcount = (...bs: PartBin[]) => bs.reduce((n, b) => n + b.pos.length / 3, 0);
  const size = { wood: { v: 0, i: 0 }, iron: { v: 0, i: 0 }, woodOut: { v: 0, i: 0 }, ironOut: { v: 0, i: 0 } };
  const slot = (w: { part: keyof Bins; out: boolean }) => (w.part === 'wood' ? (w.out ? 'woodOut' : 'wood') : (w.out ? 'ironOut' : 'iron'));
  const counted = new Map<string, Set<PartBin>>();
  let tris = 0;
  for (const list of wants) for (const w of list) {
    const k = slot(w), seen = counted.get(k) ?? new Set<PartBin>();
    counted.set(k, seen); size[k].i++;
    if (!seen.has(w.bin)) { seen.add(w.bin); size[k].v += vcount(w.bin); }
  }
  for (const g of portGeom) {
    size.wood.v += vcount(g.fixed.wood) + (g.drum ? vcount(g.drum.wood) : 0); size.iron.v += vcount(g.grille, g.fixed.iron, g.fixed.dark) + (g.drum ? vcount(g.drum.iron) : 0);
    size.wood.i += 6; size.iron.i += 4;
  }
  if (anyWinch) size.wood.v += vcount(rope, coil);
  const wood: BatchLike = makeBatch('doors-wood', M.wood, size.wood.i, size.wood.v);
  const iron: BatchLike = makeBatch('doors-iron', M.iron, size.iron.i, size.iron.v);
  object.add(wood.object, iron.object);
  const batches: Record<keyof typeof size, BatchLike> = { wood, iron, woodOut: wood, ironOut: iron };
  for (const k of ['woodOut', 'ironOut'] as const) if (size[k].i) {
    batches[k] = makeBatch(k === 'woodOut' ? 'doors-wood-outdoor' : 'doors-iron-outdoor', opts.outdoor![k === 'woodOut' ? 'wood' : 'iron'], size[k].i, size[k].v);
    object.add(batches[k].object);
  }
  // batch instances by the visibility keys they follow (a door id, or '<portcullis>:winch'), for setVisible;
  // an instance with several keys is shown while any of them is
  const parts = new Map<string, { keys: string[]; draws: Draw[] }[]>(), shown = new Map<string, boolean>();
  const part = (keys: string[]) => { const g = { keys, draws: [] as Draw[] }; for (const k of keys) parts.set(k, [...(parts.get(k) ?? []), g]); return g; };
  const geomIds = new Map<BatchLike, Map<PartBin, number>>();
  const geomOf = (b: BatchLike, bin: PartBin) => {
    const m = geomIds.get(b) ?? new Map<PartBin, number>(); geomIds.set(b, m);
    if (!m.has(bin)) m.set(bin, b.addGeometry(bin));
    return m.get(bin)!;
  };
  // Instances go in grouped by geometry (instancesByGeometry): WebGPU has no multi-draw, so three issues one
  // draw per run of consecutive visible instances that share a geometry; in leaf order nearly every leaf
  // part was its own run (≈ 273 draws per pass at Anders' eye pose). Same instances, same matrices.
  const items = pending.flatMap(({ leaf }, n) => wants[n].map((w) => ({ leaf, w, b: batches[slot(w)], g: geomOf(batches[slot(w)], w.bin), i: -1 })));
  for (const it of instancesByGeometry(items)) it.i = it.b.addInstance(it.g);
  let next = 0;
  pending.forEach(({ leaf, vk }, n) => {
    const v = variants.get(vk)!;
    tris += vcount(v.whole.wood, v.whole.iron, v.whole.fixed) / 3; // one lighting of each face is drawn at a time
    // oak from fresh honey-brown to grey and weathered
    const r = rngFor('door-tint:' + leaf.place.door), grey = r(), k = 0.62 + r() * 0.3;
    const tint: V3 = [k * (1 - grey * 0.12), k * (0.9 - grey * 0.02), k * (0.8 + grey * 0.12)];
    const own = part([leaf.place.door]);
    for (const w of wants[n]) {
      const { b, i } = items[next++];
      if (w.part === 'wood') b.setColorAt(i, tint);
      if (!w.moves) b.setMatrixAt(i, leafMatrix(leaf.place, leafSwing(leaf.place, 0)));
      const dr: Draw = { b, i, moves: w.moves, show: w.show, leaf };
      leaf.draws.push(dr); own.draws.push(dr);
    }
  });
  const ropeId = anyWinch ? wood.addGeometry(rope) : -1, coilId = anyWinch ? wood.addGeometry(coil) : -1;
  const initialLift = (p: PortcullisSpec) => p.lift * (opts.initial ?? 1);
  const ports: Port[] = portSpecs.map((spec, i) => {
    const g = portGeom[i], F0 = portFrame(spec);
    // cell visibility: the grille goes with the gate, the drum and ropes with the windlass room, and the
    // fixtures (sill sockets and soffit slot below, frames and floor slot above) with either
    const gate = part([spec.id]), winch = part([spec.id + ':winch']), both = part([spec.id, spec.id + ':winch']);
    const fixedAt = (b: BatchLike, bin: PartBin, rgb?: V3) => { if (!bin.pos.length) return; const k = b.addInstance(b.addGeometry(bin)); b.setMatrixAt(k, F0); if (rgb) b.setColorAt(k, rgb); both.draws.push({ b, i: k, moves: false }); };
    fixedAt(wood, g.fixed.wood, [0.62, 0.55, 0.48]); fixedAt(iron, g.fixed.iron); fixedAt(iron, g.fixed.dark, [0.03, 0.03, 0.03]);
    tris += vcount(g.grille, g.fixed.wood, g.fixed.iron, g.fixed.dark) / 3;
    const p: Port = { spec, s: portAt(initialLift(spec), spec.lift), grille: iron.addInstance(iron.addGeometry(g.grille)), drum: [], ropes: [], coils: [], body: null };
    gate.draws.push({ b: iron, i: p.grille, moves: true });
    if (g.drum) {
      tris += (vcount(g.drum.wood, g.drum.iron) + 2 * vcount(rope, coil)) / 3;
      p.drum = [wood.addInstance(wood.addGeometry(g.drum.wood)), iron.addInstance(iron.addGeometry(g.drum.iron))];
      wood.setColorAt(p.drum[0], [0.62, 0.55, 0.48]);
      for (let k = 0; k < 2; k++) { p.ropes.push(wood.addInstance(ropeId)); p.coils.push(wood.addInstance(coilId)); }
      for (const j of [...p.ropes, ...p.coils]) wood.setColorAt(j, HEMP);
      for (const i of [p.drum[0], ...p.ropes, ...p.coils]) winch.draws.push({ b: wood, i, moves: true });
      winch.draws.push({ b: iron, i: p.drum[1], moves: true });
    }
    return p;
  });

  // --- physics: one kinematic box per solid leaf part; a portcullis has one only while it is low
  if (physics) for (const u of units) for (const b of u.leaf.geom.boxes) u.leaf.bodies.push(physics.addKinematicBox([(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2], 'door:' + u.id));

  // --- posing
  const swingOf = (l: Leaf, angle = l.angle): M4 => leafSwing(l.place, l.dir * angle);
  const worldOf = (l: Leaf, angle = l.angle): M4 => leafMatrix(l.place, swingOf(l, angle));
  /** Is a draw part of what its leaf shows now (the side each face stands in)? */
  const current = (dr: Draw) => !dr.leaf || !dr.show || dr.show(dr.leaf);
  const pose = (l: Leaf) => {
    l.matrix = worldOf(l);
    const on = shown.get(l.place.door) ?? true;
    for (const dr of l.draws) {
      if (dr.moves) dr.b.setMatrixAt(dr.i, l.matrix);
      dr.b.setVisibleAt(dr.i, on && current(dr));
    }
    if (l.bodies.length) {
      const q = m4quat(l.matrix);
      l.geom.boxes.forEach((b, i) => l.bodies[i].setPose(leafPoint(l.place, swingOf(l), [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]), q));
    }
  };
  const posePort = (p: Port) => {
    const sp = p.spec, lift = p.s.lift, G = portFrame(sp, lift - SEAT);
    iron.setMatrixAt(p.grille, G);
    if (sp.winch) {
      const w = sp.winch, F0 = portFrame(sp);
      const D = m4mul(F0, m4mul(m4translate(0, w.drumY, -DRUM_R), m4rotX(drumAngle(lift))));
      wood.setMatrixAt(p.drum[0], D); iron.setMatrixAt(p.drum[1], D);
      [-1, 1].forEach((s, i) => {
        wood.setMatrixAt(p.coils[i], m4mul(D, m4mul(m4translate(s * w.ropeAt, 0, 0), m4scale(coilWidth(lift), 1, 1))));
        wood.setMatrixAt(p.ropes[i], m4mul(F0, m4mul(m4translate(s * w.ropeAt, w.drumY, 0), m4scale(1, ropeLength(sp, lift), 1))));
      });
    }
    // collider only while the grid is low enough to stop someone
    if (physics && blocking(lift)) {
      p.body ??= physics.addKinematicBox([sp.width / 2, sp.height / 2, BAR / 2 + 0.02], 'door:' + sp.id);
      p.body.setPose(m4apply(G, [0, sp.height / 2, 0]), m4quat(G));
    } else if (p.body) { p.body.remove(); p.body = null; }
  };
  for (const u of units) pose(u.leaf);
  for (const p of ports) posePort(p);

  // --- blocking: would the leaf's boxes at this angle come within LEAF_CLEAR of a character's axis?
  const blocks = (l: Leaf, angle: number, who: Vec3Like[]) => {
    if (!who.length) return false;
    const m = worldOf(l, angle);
    for (const pp of who) {
      const [lx, ly, lz] = toLocal(m, l.place.mirrored, pp.x, pp.y, pp.z);
      if (ly < -0.6 || ly > l.geom.height + 1.9) continue;
      for (const b of l.geom.boxes) {
        const cx = Math.max(b.min[0], Math.min(b.max[0], lx)), cz = Math.max(b.min[2], Math.min(b.max[2], lz));
        if (Math.hypot(lx - cx, lz - cz) < LEAF_CLEAR) return true;
      }
    }
    return false;
  };

  // --- leaf animation
  const step = (u: Unit, dt: number, who: Vec3Like[]) => {
    const l = u.leaf, goal = u.open ? maxOf(l) : 0;
    let a = l.angle, v = l.vel;
    if (u.open) {
      // pushed open: quick start, settles slowly on its hinges
      const k = u.kind === 'grille' ? 2.2 : 2.6;
      a += Math.max((goal - a) * (1 - Math.exp(-k * dt)), Math.min(goal - a, 0.12 * dt));
      if (goal - a < 2e-3) a = goal;
      v = 0;
    } else {
      // pulled shut: accelerates and lands with a thud
      v = Math.min(2.6, v + 3.2 * dt);
      a = Math.max(0, a - v * dt);
    }
    if (blocks(l, a, who)) {
      if (!u.blocked) sound('bump', u.pos, u.weight);
      u.blocked = true; l.vel = 0;
      return;
    }
    u.blocked = false;
    const shut = a === 0;
    l.angle = a; l.vel = shut ? 0 : v;
    if (shut) { sound('thud', u.pos, u.weight); sound('latch', u.pos, u.weight * 0.8); }
    if (a === goal) u.moving = false;
    pose(l);
  };
  const openness = (u: Unit) => u.leaf.angle / maxOf(u.leaf);
  const setUnit = (u: Unit, o: boolean, instant = false, by?: Opener) => {
    // opening a shut leaf: it swings away from whoever opens it, where it can (the only place the way is chosen)
    const l = u.leaf;
    if (o && by && (l.angle === 0 || instant)) {
      const way = swingAwayFrom(u.d, by.pos.x, by.pos.z, by.dir);
      if (way !== null && way !== l.dir) { l.angle = 0; l.dir = way; }
    }
    if (instant) { u.open = o; u.moving = false; l.angle = o ? maxOf(l) : 0; l.vel = 0; pose(l); return; }
    if (u.open === o && (u.moving || openness(u) === (o ? 1 : 0))) return;
    u.open = o; u.moving = true;
    if (o) { sound('latch', u.pos, u.weight * 0.8); sound('creak', u.pos, u.weight); } else sound('creak', u.pos, u.weight * 0.7);
  };
  /** What a toggle does next: a moving door reverses, a door at rest part-open closes. */
  const willOpen = (u: Unit) => (u.moving ? !u.open : openness(u) <= 0.02);

  // --- portcullis: drive the state machine, voice its events
  const grilleAt = (p: Port, y: number): V3 => m4apply(portFrame(p.spec), [0, y, 0]);
  const drumAt = (p: Port): V3 => (p.spec.winch ? m4apply(portFrame(p.spec), [0, p.spec.winch.drumY, -DRUM_R]) : grilleAt(p, 3));
  const voice = (p: Port, ev: PortEvent[]) => {
    for (const e of ev) {
      if (e === 'start-up') sound('chain', drumAt(p), 1.6);
      else if (e === 'start-down') { sound('clank', drumAt(p), 1.4); sound('chain', grilleAt(p, 3), 1.8); }
      else if (e === 'tooth') sound('clank', drumAt(p), 1.2);
      else if (e === 'top') sound('clank', drumAt(p), 2.0);
      else if (e === 'seat') sound('thud', grilleAt(p, 0.5), 2.6);
      else sound('bump', grilleAt(p, 2), 1.4);
    }
  };
  const setPort = (p: Port, up: boolean, instant = false) => {
    if (instant) { p.s = portAt(up ? p.spec.lift : 0, p.spec.lift); posePort(p); return; }
    const r = portCommand(p.s, up, p.spec.lift); p.s = r.s; voice(p, r.ev);
  };

  // --- passability (pathfinding): the doorway's clear width left beside the leaf at its angle
  const gap = (u: Unit) => { const l = u.leaf, t = KIND[l.place.kind].t + KIND[l.place.kind].ledge; return u.width - (l.geom.width * Math.cos(l.angle) + t * Math.sin(l.angle) + 0.02); };

  // --- interactables
  const hitLeaf = (l: Leaf, ray: THREE.Ray, maxDist: number): number | null => {
    const m = l.matrix, o = ray.origin, d = ray.direction;
    const lo = toLocal(m, l.place.mirrored, o.x, o.y, o.z);
    let dx = m[0] * d.x + m[1] * d.y + m[2] * d.z;
    if (l.place.mirrored) dx = -dx;
    const ld: V3 = [dx, m[4] * d.x + m[5] * d.y + m[6] * d.z, m[8] * d.x + m[9] * d.y + m[10] * d.z];
    let best: number | null = null;
    for (const b of l.geom.boxes) { const t = rayEnters(lo, ld, b, 0.02); if (t !== null && t <= maxDist && (best === null || t < best)) best = t; }
    return best;
  };
  const labels: Record<Unit['kind'], [string, string]> = { gate: ['Open gate', 'Close gate'], grille: ['Open grille', 'Close grille'], plank: ['Open door', 'Close door'], postern: ['Open door', 'Close door'] };
  const interactables: Interactable[] = units.map((u) => ({
    id: u.id,
    label: () => labels[u.kind][willOpen(u) ? 0 : 1],
    hit: (ray, maxDist) => hitLeaf(u.leaf, ray, maxDist),
    use: (by) => setUnit(u, willOpen(u), false, by),
  }));
  const portRay = (p: Port, ray: THREE.Ray): [V3, V3] => {
    const o = ray.origin, d = ray.direction, a = p.spec.along;
    return [toPort(p.spec, o.x, o.y, o.z), [d.x * a[0] + d.z * a[1], d.y, d.x * -a[1] + d.z * a[0]]];
  };
  for (const p of ports) {
    const label = () => (willRaise(p.s, p.spec.lift) ? 'Raise portcullis' : 'Lower portcullis');
    const use = () => setPort(p, willRaise(p.s, p.spec.lift));
    interactables.push({
      id: p.spec.id, label, use,
      hit: (ray, maxDist) => {
        // the part of the grid showing in the opening, from either side
        const sp = p.spec, [lo, ld] = portRay(p, ray);
        const t = rayEnters(lo, ld, { min: [-sp.ow / 2, Math.max(0, p.s.lift - SEAT), -0.15], max: [sp.ow / 2, sp.head(0), 0.15] }, 0);
        if (t === null || t > maxDist || lo[1] + ld[1] * t > sp.head(lo[0] + ld[0] * t)) return null;
        return t;
      },
    });
    const w = p.spec.winch;
    if (w) interactables.push({
      id: p.spec.id + ':winch', label, use,
      hit: (ray, maxDist) => {
        const [lo, ld] = portRay(p, ray);
        let best: number | null = null;
        for (const b of winchBoxes(w)) { const t = rayEnters(lo, ld, b, 0.02); if (t !== null && t <= maxDist && (best === null || t < best)) best = t; }
        return best;
      },
    });
  }

  const byId = new Map(units.map((u) => [u.id, u]));
  const portById = new Map(ports.map((p) => [p.spec.id, p]));
  const setOpen = (id: string, o: boolean, instant?: boolean, by?: Opener) => {
    const p = portById.get(id);
    if (p) return setPort(p, o, instant);
    const u = byId.get(id);
    if (u) setUnit(u, o, instant, by);
  };
  const near = (c: V3, by: Vec3Like) => Math.hypot(by.x - c[0], by.z - c[2]) <= REACH_NPC && Math.abs(by.y - c[1]) < 3;

  return {
    object, interactables, triangles: Math.round(tris),
    update(dt, playerPos) {
      dt = Math.min(dt, 0.1);
      const who = [...(playerPos ? [playerPos] : []), ...(opts.characters?.() ?? [])];
      for (const u of units) if (u.moving) step(u, dt, who);
      for (const p of ports) if (p.s.moving) {
        const r = portStep(p.s, p.spec.lift, dt, who.some((c) => underGrille(p.spec, c.x, c.y, c.z)));
        p.s = r.s; voice(p, r.ev); posePort(p);
      }
    },
    setOpen,
    setVisible(id, visible) {
      shown.set(id, visible);
      for (const g of parts.get(id) ?? []) {
        const v = g.keys.some((k) => shown.get(k) ?? true);
        for (const dr of g.draws) dr.b.setVisibleAt(dr.i, v && current(dr));
      }
    },
    swingsInto: (id) => { const u = byId.get(id); return u ? (u.leaf.dir > 0 ? u.d.swingInto : (1 - u.d.swingInto) as 0 | 1) : null; },
    leafPose: (id) => { const u = byId.get(id); return u ? [...u.leaf.matrix] : null; },
    state() {
      const o: Record<string, number> = {};
      for (const u of units) o[u.id] = Math.round(openness(u) * 1000) / 1000;
      for (const p of ports) o[p.spec.id] = Math.round((p.s.lift / p.spec.lift) * 1000) / 1000;
      return o;
    },
    request(id, o, by) {
      const p = portById.get(id), u = byId.get(id);
      const ok = p ? near(grilleAt(p, 1.2), by.pos) || near(drumAt(p), by.pos) : !!u && near(u.pos, by.pos);
      if (ok) setOpen(id, o, false, by);
      return ok;
    },
    isOpen(id) {
      const p = portById.get(id);
      if (p) return p.s.lift >= p.spec.lift - 1e-3;
      const u = byId.get(id);
      return u ? openness(u) >= 0.95 : open.includes(id);
    },
    isPassable(id) {
      const p = portById.get(id);
      if (p) return !blocking(p.s.lift);
      const u = byId.get(id);
      return u ? gap(u) >= PASS_WIDTH : open.includes(id);
    },
    blocksPlayer(pp) {
      return units.some((u) => blocks(u.leaf, u.leaf.angle, [pp])) || ports.some((p) => blocking(p.s.lift) && underGrille(p.spec, pp.x, pp.y, pp.z));
    },
  };
}

/**
 * Several door systems as one, e.g. one per lighting set (a batch has one material: leaves above ground
 * and in cellars take different interior materials). Door ids are unique across them, so calls go to all.
 */
export function joinDoors(systems: DoorSystem[]): DoorSystem {
  const object = new THREE.Group(); object.name = 'doors';
  for (const s of systems) object.add(s.object);
  return {
    object,
    interactables: systems.flatMap((s) => s.interactables),
    update: (dt, p) => { for (const s of systems) s.update(dt, p); },
    setOpen: (id, o, instant, by) => { for (const s of systems) s.setOpen(id, o, instant, by); },
    state: () => Object.assign({}, ...systems.map((s) => s.state())),
    request: (id, o, by) => systems.some((s) => s.request(id, o, by)),
    swingsInto: (id) => systems.reduce<0 | 1 | null>((k, s) => k ?? s.swingsInto(id), null),
    leafPose: (id) => systems.reduce<number[] | null>((m, s) => m ?? s.leafPose(id), null),
    isOpen: (id) => systems.some((s) => s.isOpen(id)),
    isPassable: (id) => systems.some((s) => s.isPassable(id)),
    blocksPlayer: (p) => systems.some((s) => s.blocksPlayer(p)),
    triangles: systems.reduce((n, s) => n + s.triangles, 0),
    setVisible: (id, v) => { for (const s of systems) s.setVisible(id, v); },
  };
}

/**
 * The castle's active leaf doors by lighting set (a batch has one material): leaves above ground take
 * the interior materials `above`, cellar and tunnel leaves `under` (no sun, so they cast no sun shadow:
 * the near shadow map does not draw them), and the portcullis goes with the leaves above ground. A face
 * of a courtyard or outside door that looks out takes `outdoor`; the face toward its room stays in the
 * room's set, so from a dim room it is lit by the room's light, not the sun and sky.
 */
export function buildCastleDoors(doors: DoorSpec[], mats: { above: DoorMats; under: DoorMats; outdoor: DoorMats }, ground: number, physics?: PhysicsApi, opts: DoorOptions = {}): DoorSystem {
  const under = (d: DoorSpec) => d.centre[1] < ground - 1;
  const noSun = (s: DoorSystem) => { s.object.traverse((o) => { o.castShadow = false; }); return s; };
  const { portcullis, ...rest } = opts;
  return joinDoors([
    buildDoors(doors.filter((d) => !under(d)), mats.above, physics, { ...rest, portcullis, outdoor: mats.outdoor }),
    noSun(buildDoors(doors.filter(under), mats.under, physics, { ...rest, outdoor: mats.outdoor })),
  ]);
}
