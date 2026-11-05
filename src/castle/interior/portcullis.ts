// The main gate's portcullis and the windlass that lifts it, with no three.js in it so tests can check
// it directly: where the grille sits (from the gate's DoorSpec), the state machine any agent drives
// (heavy, uneven ratcheting rise; quicker drop that seats the spikes in the sill and will not come down
// on anyone), when it blocks, how the drum turns and the ropes wind, and the geometry as plain arrays.
//
// Local frame (`portFrame`): x across the opening (DoorSpec.along), y up from the sill, z outward (toward
// spaces[0], the outside). The groove plane is z = 0. The grille's own y starts at its spike tips.
import type { DoorSpec, RoomSpec, V3 } from './types';
import { pointInPoly, type V2 } from '../../core/math2d';
import { headRise, headTop, type M4 } from './doorGeom';
import { slab, tri, type PartBin } from './doorParts';

export const GROOVE_IN = 0.5;   // groove centre from the inner face of the gate wall (under the winch room)
export const SEAT = 0.12;       // spike tips sit this far down in the sill sockets when lowered
export const HEAD = 2.0;        // tips this far above the sill: people pass under, the collider is off
export const BAR = 0.08;        // square bar section
export const JAMB = 0.1;        // grille ends run this far into the jamb grooves
export const TEETH = 16;        // ratchet teeth; one tooth per TOOTH of lift
export const TOOTH = 0.09;
export const DRUM_R = (TEETH * TOOTH) / (2 * Math.PI); // rope length = DRUM_R × drum angle
export const ROPE_D = 0.045, BASE_TURNS = 2;
const RISE = 0.95, HEAVE = 1.6, DROP_A = 5, DROP_V = 2.6, R = 0.3;

/** Where the grid is cut from, in groove-plane terms. `centre` is on the groove plane at sill height. */
export interface PortcullisSpec {
  id: string;            // the DoorSpec it closes
  centre: V3;
  along: V2;             // across the opening
  inward: V2;            // toward spaces[1]
  ow: number;            // opening width
  head: (s: number) => number; // opening top above the sill at s across
  width: number;         // grid width (into both jamb grooves)
  height: number;        // grid height, spike tips to the top rail
  lift: number;          // travel from seated to raised
  winch: WinchSpec | null;
}
/** The windlass in the room above, in the port frame (y above the sill). */
export interface WinchSpec { floor: number; drumY: number; ropeAt: number; frameAt: number }

/** Distance of the groove from the outer (spaces[0]) face. */
export const grooveFromFront = (d: Pick<DoorSpec, 'wall'>) => d.wall - GROOVE_IN;

export function portcullisFor(d: DoorSpec, floorAbove: number | null): PortcullisSpec {
  const t = grooveFromFront(d) - d.wall / 2, n = d.normal;
  const top = d.height + headRise(d.head, d.width);
  const width = d.width + 2 * JAMB, ropeAt = Math.min(1.2, width / 2 - 0.5);
  return {
    id: d.id, centre: [d.centre[0] + n[0] * t, d.centre[1], d.centre[2] + n[1] * t], along: d.along, inward: n,
    ow: d.width, head: headTop(d.head, d.width, d.height), width, height: top + SEAT + 0.45, lift: HEAD + 0.75 + SEAT,
    winch: floorAbove === null ? null : { floor: floorAbove - d.centre[1], drumY: floorAbove - d.centre[1] + 1.0, ropeAt, frameAt: ropeAt + 0.42 },
  };
}

/** The lowest room whose floor is above `minY` and whose plan holds the groove: the winch room. */
export function roomAbove(rooms: RoomSpec[], p: V3, minY: number): RoomSpec | null {
  let best: RoomSpec | null = null;
  for (const r of rooms) if (r.y0 >= minY && pointInPoly(r.poly, p[0], p[2]) && (!best || r.y0 < best.y0)) best = r;
  return best;
}

// ------------------------------------------------------------------------- state machine

export interface PortState { lift: number; up: boolean; moving: boolean; v: number; phase: number; held: boolean }
export type PortEvent = 'start-up' | 'start-down' | 'tooth' | 'top' | 'seat' | 'held';

export const portAt = (lift: number, L: number): PortState => ({ lift, up: lift > L / 2, moving: false, v: 0, phase: 0, held: false });
/** What a use does next: reverse while moving, otherwise raise a low grille and lower a high one. */
export const willRaise = (s: PortState, L: number) => (s.moving ? !s.up : s.lift < L / 2);
/** Grille low enough to stop a character: the collider is on and the gate is not passable. */
export const blocking = (lift: number) => lift < HEAD + SEAT;
/** Per-tooth effort, seeded by the tooth index: some heaves go better than others. */
export const uneven = (k: number) => { const x = Math.sin(k * 127.1 + 311.7) * 43758.5453; return 0.75 + 0.5 * (x - Math.floor(x)); };

export function portCommand(s: PortState, up: boolean, L: number): { s: PortState; ev: PortEvent[] } {
  if (s.moving ? s.up === up : s.lift === (up ? L : 0)) return { s, ev: [] };
  return { s: { ...s, up, moving: true, v: 0, phase: 0, held: false }, ev: [up ? 'start-up' : 'start-down'] };
}

/** Advance dt seconds. `under`: a character stands in the grille's footprint (it will not drop on them). */
export function portStep(s: PortState, L: number, dt: number, under: boolean): { s: PortState; ev: PortEvent[] } {
  if (!s.moving) return { s, ev: [] };
  const ev: PortEvent[] = [];
  if (s.up) {
    // windlass: each heave on the spokes lifts a few teeth, then the pawl catches
    const phase = s.phase + dt * HEAVE, k = Math.floor(s.lift / TOOTH);
    const lift = Math.min(L, s.lift + RISE * uneven(k) * Math.sin(phase * Math.PI) ** 2 * dt);
    if (Math.floor(lift / TOOTH) !== k) ev.push('tooth');
    if (lift >= L) { ev.push('top'); return { s: portAt(L, L), ev }; }
    return { s: { ...s, lift, phase }, ev };
  }
  // pawl knocked off: it runs down on the brake, faster, and seats with a thud
  const v = Math.min(DROP_V, s.v + DROP_A * dt), next = Math.max(0, s.lift - v * dt);
  if (under && (s.held || blocking(next))) { if (!s.held) ev.push('held'); return { s: { ...s, v: 0, held: true }, ev }; }
  if (next <= 0) { ev.push('seat'); return { s: portAt(0, L), ev }; }
  return { s: { ...s, lift: next, v, held: false }, ev };
}

// ------------------------------------------------------------------------- frame, footprint, winch pose

/** Column-major frame at height y: x along, y up, z outward (= along × up), origin on the groove plane. */
export function portFrame(p: Pick<PortcullisSpec, 'centre' | 'along'>, y = 0): M4 {
  const a = p.along;
  return [a[0], 0, a[1], 0, 0, 1, 0, 0, -a[1], 0, a[0], 0, p.centre[0], p.centre[1] + y, p.centre[2], 1];
}
/** World point into the port frame (y above the sill). */
export function toPort(p: Pick<PortcullisSpec, 'centre' | 'along'>, x: number, y: number, z: number): V3 {
  const dx = x - p.centre[0], dz = z - p.centre[2], a = p.along;
  return [dx * a[0] + dz * a[1], y - p.centre[1], dx * -a[1] + dz * a[0]];
}
/** A character (eye or body point) inside the grille's footprint, within reach of its bars. */
export function underGrille(p: PortcullisSpec, x: number, y: number, z: number) {
  const [lx, ly, lz] = toPort(p, x, y, z);
  return Math.abs(lx) < p.width / 2 + R && Math.abs(lz) < R + BAR / 2 + 0.02 && ly < 3.2 && ly > -1;
}
/** Drum angle about +x for a lift: the groove side of the drum turns up as the ropes wind on. */
export const drumAngle = (lift: number) => -lift / DRUM_R;
/** Rope from the drum's groove-side tangent down to the eyes on the grille's top rail. */
export const ropeLength = (p: PortcullisSpec, lift: number) => p.winch!.drumY - (lift - SEAT + p.height);
/** Axial width of the rope coiled on the drum. */
export const coilWidth = (lift: number) => (BASE_TURNS + lift / (2 * Math.PI * DRUM_R)) * ROPE_D;

// ------------------------------------------------------------------------- geometry

const bin = (): PartBin => ({ pos: [], nor: [], uv: [] });
const ngon = (n: number, r: number, cx = 0, cy = 0, a0 = 0): V2[] => Array.from({ length: n }, (_, i) => [cx + Math.cos(a0 + (i / n) * Math.PI * 2) * r, cy + Math.sin(a0 + (i / n) * Math.PI * 2) * r]);
const uvw = (p: V3): V2 => [(p[0] + p[2]) / 2, p[1] / 2];
type Map3 = (u: number, v: number, w: number) => V3;
function remapInto(out: PartBin, src: PartBin, f: Map3) {
  for (let i = 0; i < src.pos.length; i += 3) { out.pos.push(...f(src.pos[i], src.pos[i + 1], src.pos[i + 2])); out.nor.push(...f(src.nor[i], src.nor[i + 1], src.nor[i + 2])); }
  out.uv.push(...src.uv);
}
/** Box from min to max. */
export function box(b: PartBin, min: V3, max: V3, bev = 0.004) { slab(b, [[min[0], min[1]], [max[0], min[1]], [max[0], max[1]], [min[0], max[1]]], min[2], max[2], bev, uvw); }
/** Convex (z, y) polygon extruded along x from x0 to x1 (timbers in the y-z plane, discs on an x axis). */
export function slabYZ(b: PartBin, zy: V2[], x0: number, x1: number, bev = 0.004) {
  const t = bin(); slab(t, zy.map(([z, y]) => [-z, y] as V2), x0, x1, bev, uvw);
  remapInto(b, t, (u, v, w) => [w, v, -u]);
}
/** Convex (x, z) polygon extruded along y from y0 to y1 (ropes). */
export function slabXZ(b: PartBin, xz: V2[], y0: number, y1: number) {
  const t = bin(); slab(t, xz.map(([x, z]) => [x, -z] as V2), y0, y1, 0, (p) => [p[0] * 4, p[2] / 2]);
  remapInto(b, t, (u, v, w) => [u, w, -v]);
}
/** Domed rivet head on a face at z, pointing along dir (±1). */
function rivet(b: PartBin, x: number, y: number, z: number, dir: 1 | -1, r = 0.022, h = 0.014) {
  const ring = ngon(6, r, x, y), tip: V3 = [x, y, z + dir * h];
  for (let i = 0; i < 6; i++) {
    const p = ring[i], q = ring[(i + 1) % 6];
    tri(b, [p[0], p[1], z], [q[0], q[1], z], tip, [(p[0] + q[0]) / 2 - x, (p[1] + q[1]) / 2 - y, dir * r], () => [0, 0]);
  }
}

/** Bar positions across the grid (centres). */
export function barXs(p: Pick<PortcullisSpec, 'width'>): number[] {
  const n = Math.max(3, Math.round(p.width / 0.3)), h = BAR / 2;
  return Array.from({ length: n + 1 }, (_, i) => -p.width / 2 + h + ((p.width - BAR) * i) / n);
}
/** Rail heights (centres) above the spike tips; the last one is the heavy top rail with the lifting eyes. */
export function railYs(p: Pick<PortcullisSpec, 'height'>): number[] {
  const ys: number[] = [];
  for (let y = 0.34; y < p.height - 0.3; y += 0.42) ys.push(y);
  return [...ys, p.height - 0.07];
}

/**
 * The grid: square bars, flush half-lapped crossings with a rivet head on each face, a spiked foot on
 * every upright, and a heavy top rail with two lifting eyes for the ropes. Local: y from the spike tips.
 */
export function grilleGeometry(p: PortcullisSpec): PartBin {
  const b = bin(), h = BAR / 2, spike = 0.22, xs = barXs(p), ys = railYs(p);
  for (const x of xs) {
    slab(b, [[x - h, spike], [x + h, spike], [x + h, p.height], [x - h, p.height]], -h, h, 0.006);
    // spike: a square bar drawn down to a point
    const base: V3[] = [[x - h, spike, -h], [x + h, spike, -h], [x + h, spike, h], [x - h, spike, h]], tip: V3 = [x, 0, 0];
    for (let i = 0; i < 4; i++) { const a = base[i], c = base[(i + 1) % 4]; tri(b, a, c, tip, [(a[0] + c[0]) / 2 - x, -0.05, (a[2] + c[2]) / 2], () => [0, 0]); }
  }
  ys.forEach((y, k) => {
    const top = k === ys.length - 1, hy = top ? 0.07 : h, hz = top ? h + 0.015 : h;
    // rail segments between the uprights, flush with them (the half-lap), riveted through each crossing
    for (let i = 0; i < xs.length - 1; i++) slab(b, [[xs[i] + h, y - hy], [xs[i + 1] - h, y - hy], [xs[i + 1] - h, y + hy], [xs[i] + h, y + hy]], -hz, hz, k === ys.length - 1 ? 0.004 : 0);
    for (const x of xs) for (const s of [1, -1] as const) rivet(b, x, y, s * hz, s);
  });
  // lifting eyes: an iron staple on the top rail under each rope
  if (p.winch) for (const s of [-1, 1]) {
    const x = s * p.winch.ropeAt, y = p.height;
    box(b, [x - 0.07, y, -0.012], [x - 0.04, y + 0.1, 0.012], 0.002);
    box(b, [x + 0.04, y, -0.012], [x + 0.07, y + 0.1, 0.012], 0.002);
    box(b, [x - 0.07, y + 0.1, -0.012], [x + 0.07, y + 0.13, 0.012], 0.002);
  }
  return b;
}

/** Fixed parts in the port frame (y from the sill): timber of the windlass, its iron, and dark holes. */
export function gateFixtures(p: PortcullisSpec): { wood: PartBin; iron: PartBin; dark: PartBin } {
  const wood = bin(), iron = bin(), dark = bin(), h = BAR / 2;
  // sill sockets under the spikes, and the slot the grid rises into above the arch
  for (const x of barXs(p)) if (Math.abs(x) < p.ow / 2) box(dark, [x - 0.06, 0, -0.06], [x + 0.06, 0.004, 0.06], 0);
  const K = 24;
  for (let i = 0; i < K; i++) {
    const xa = -p.ow / 2 + (p.ow * i) / K, xb = -p.ow / 2 + (p.ow * (i + 1)) / K;
    slab(dark, [[xa, p.head(xa) - 0.006], [xb, p.head(xb) - 0.006], [xb, p.head(xb) + 0.05], [xa, p.head(xa) + 0.05]], -h - 0.03, h + 0.03, 0);
  }
  const w = p.winch;
  if (!w) return { wood, iron, dark };
  const f = w.floor, zc = -DRUM_R, yd = w.drumY;
  // the slot in the winch-room floor, with a timber kerb each side
  box(dark, [-p.width / 2 - 0.04, f, -h - 0.05], [p.width / 2 + 0.04, f + 0.006, h + 0.05], 0);
  for (const s of [-1, 1]) box(wood, [-p.width / 2 - 0.14, f, s > 0 ? h + 0.05 : -h - 0.17], [p.width / 2 + 0.14, f + 0.08, s > 0 ? h + 0.17 : -h - 0.05]);
  for (const s of [-1, 1]) {
    const x = s * w.frameAt, x0 = x - 0.07, x1 = x + 0.07;
    // A-frame: two raking legs from the sole plate to under the bearing, a collar tie, a bearing block
    for (const side of [-1, 1]) {
      const foot: V2 = [zc + side * 0.62, f + 0.12], apex: V2 = [zc + side * 0.06, yd - 0.12];
      slabYZ(wood, [[foot[0] - 0.07, foot[1]], [foot[0] + 0.07, foot[1]], [apex[0] + 0.07, apex[1]], [apex[0] - 0.07, apex[1]]], x0, x1);
    }
    slabYZ(wood, [[zc - 0.5, f + 0.5], [zc + 0.5, f + 0.5], [zc + 0.5, f + 0.62], [zc - 0.5, f + 0.62]], x0 + 0.01, x1 - 0.01);
    box(wood, [x0 - 0.01, yd - 0.18, zc - 0.15], [x1 + 0.01, yd - 0.04, zc + 0.15]);
    box(wood, [x0 - 0.01, f, zc - 0.68], [x1 + 0.01, f + 0.12, zc + 0.68]); // sole plate
    // iron strap holding the axle down in its bearing
    slabYZ(iron, [[zc - 0.16, yd - 0.06], [zc + 0.16, yd - 0.06], [zc + 0.16, yd + 0.05], [zc - 0.16, yd + 0.05]], x - 0.03, x + 0.03, 0.002);
  }
  // runners on the floor tying the two frames
  for (const side of [-1, 1]) box(wood, [-w.frameAt - 0.08, f, zc + side * 0.62 - 0.07], [w.frameAt + 0.08, f + 0.1, zc + side * 0.62 + 0.07]);
  // the pawl, pivoted on a bracket off the frame, its nose on the ratchet
  const xr = w.ropeAt + 0.33, rw = DRUM_R + 0.08;
  slabYZ(iron, [[zc - 0.34, yd + 0.17], [zc - 0.3, yd + 0.21], [zc + 0.01, yd + rw + 0.012], [zc - 0.01, yd + rw - 0.02]], xr - 0.015, xr + 0.015, 0.002);
  box(iron, [xr - 0.015, yd + 0.12, zc - 0.36], [w.frameAt - 0.06, yd + 0.22, zc - 0.29], 0.002);
  return { wood, iron, dark };
}

/** The drum and everything turning with it, about its own axis (x), origin on the axis. */
export function drumGeometry(p: PortcullisSpec): { wood: PartBin; iron: PartBin } {
  const w = p.winch!, wood = bin(), iron = bin(), L = w.ropeAt + 0.3, r = DRUM_R;
  slabYZ(wood, ngon(14, r), -L, L);
  for (const x of [-L, 0, L - 0.05]) slabYZ(iron, ngon(14, r + 0.012), x, x + 0.05, 0.002); // hoops
  slabYZ(iron, ngon(8, 0.035), -w.frameAt - 0.24, w.frameAt + 0.24, 0); // axle
  // ratchet wheel just inside one frame: a disc and sawtooth teeth, one per TOOTH of rope
  const xr = w.ropeAt + 0.33, r0 = r + 0.03, da = (Math.PI * 2) / TEETH;
  slabYZ(iron, ngon(TEETH, r0), xr - 0.022, xr + 0.022, 0.002);
  for (let k = 0; k < TEETH; k++) {
    const a = k * da, P = (rr: number, t: number): V2 => [Math.cos(t) * rr, Math.sin(t) * rr];
    slabYZ(iron, [P(r0 - 0.005, a), P(r0 - 0.005, a + da * 0.95), P(r0 + 0.05, a)], xr - 0.02, xr + 0.02, 0);
  }
  // capstan heads outside the frames: a hub and six handspikes each
  for (const s of [-1, 1]) {
    const x0 = s * (w.frameAt + 0.1), x1 = s * (w.frameAt + 0.2), lo = Math.min(x0, x1), hi = Math.max(x0, x1);
    slabYZ(wood, ngon(10, 0.14), lo, hi);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + 0.26, c = Math.cos(a), sn = Math.sin(a), t = 0.028;
      slabYZ(wood, [[c * 0.1 - sn * t, sn * 0.1 + c * t], [c * 0.1 + sn * t, sn * 0.1 - c * t], [c * 0.6 + sn * t, sn * 0.6 - c * t], [c * 0.6 - sn * t, sn * 0.6 + c * t]], lo + 0.015, hi - 0.015);
    }
  }
  return { wood, iron };
}

/** One rope, 1 m long, hanging from its top at the origin (scaled to length in y). */
export function ropeGeometry(): PartBin { const b = bin(); slabXZ(b, ngon(6, ROPE_D / 2), -1, 0); return b; }
/** The rope coiled on the drum: 1 m wide on the drum axis (scaled to the coil width in x). */
export function coilGeometry(): PartBin { const b = bin(); slabYZ(b, ngon(14, DRUM_R + ROPE_D / 2), -0.5, 0.5, 0.01); return b; }

/** The portcullis for a gate in a plan: the windlass goes in the lowest room over the raised grid, if any. */
export function portcullisInPlan(d: DoorSpec, rooms: RoomSpec[]): PortcullisSpec {
  const p = portcullisFor(d, null), r = roomAbove(rooms, p.centre, d.centre[1] - SEAT + p.height + p.lift);
  return r ? portcullisFor(d, r.y0) : p;
}
