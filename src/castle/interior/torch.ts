// A wall torch's holder: a wooden shaft leaning out from the wall, held by a plain iron bracket (a plate on
// the wall face, a short arm out to a collar round the shaft). The torch is placed by render/interiorFire.ts
// (wallTorches), which gives each one a TorchHolder; the shell builds it into its room's group so it is
// culled with the room. Geometry only, in the group's 'wood' and 'iron' bins.
import type { Builder } from '../builder';
import type { V2 } from '../../core/math2d';
import type { SpaceId } from './types';

type V3 = [number, number, number];
/** Where a torch is: its room, the point on the wall face level with the flame's base, the wall's inward normal and the flame's base. */
export interface TorchHolder { room: SpaceId; wall: V3; n: V2; base: V3 }

/** How far the flame's base stands out from the wall face. */
export const FLAME_OUT = 0.22;
const SHAFT = { len: 0.45, w: 0.04, foot: 0.07, gap: 0.01 }; // foot: shaft bottom's distance from the wall
const COLLAR_T = 0.55;                                        // collar position along the shaft, from its foot
const PLATE = { w: 0.06, h: 0.18, t: 0.012 };

/** The holder's parts in world space: shaft foot and top, collar centre, the plate's centre on the wall. */
export function torchParts(h: TorchHolder) {
  const out = Math.hypot(h.base[0] - h.wall[0], h.base[2] - h.wall[2]);
  const P = (d: number, y: number): V3 => [h.wall[0] + h.n[0] * d, y, h.wall[2] + h.n[1] * d];
  const yTop = h.base[1] - SHAFT.gap, rise = Math.sqrt(SHAFT.len ** 2 - (out - SHAFT.foot) ** 2), yFoot = yTop - rise;
  const cOut = SHAFT.foot + (out - SHAFT.foot) * COLLAR_T, cY = yFoot + rise * COLLAR_T;
  return { top: P(out, yTop), foot: P(SHAFT.foot, yFoot), collar: P(cOut, cY), plate: P(0, cY), cOut };
}

/** Build the holder into B: wood shaft, iron plate, arm and collar. Returns the parts (for tests). */
export function buildTorchHolder(B: Builder, h: TorchHolder) {
  const p = torchParts(h), along: V2 = [-h.n[1], h.n[0]];
  bar(B, p.foot, p.top, h.n, SHAFT.w);
  // Builder.box: size (along dir, up, across dir); dir = n puts the box's length out from the wall
  B.box('iron', [p.plate[0] + h.n[0] * PLATE.t / 2, p.plate[1], p.plate[2] + h.n[1] * PLATE.t / 2], [PLATE.t, PLATE.h, PLATE.w], h.n);
  const arm = p.cOut - SHAFT.w / 2 - PLATE.t;
  B.box('iron', [p.plate[0] + h.n[0] * (PLATE.t + arm / 2), p.plate[1], p.plate[2] + h.n[1] * (PLATE.t + arm / 2)], [arm, 0.02, 0.02], h.n);
  B.box('iron', p.collar, [SHAFT.w + 0.025, 0.03, SHAFT.w + 0.025], along);
  return p;
}

/** A square-section bar from a to b (b above a, leaning along n), all four sides and both ends. */
function bar(B: Builder, a: V3, b: V3, n: V2, w: number) {
  const bin = B.bins.wood, d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
  const s: V3 = [-n[1], 0, n[0]], t = norm(cross(d, s)), hw = w / 2;
  const at = (p: V3, i: number, j: number): V3 => [p[0] + s[0] * i * hw + t[0] * j * hw, p[1] + s[1] * i * hw + t[1] * j * hw, p[2] + s[2] * i * hw + t[2] * j * hw];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 2; // wood tiles at 2 m
  const ring: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let k = 0; k < 4; k++) {
    const [i0, j0] = ring[k], [i1, j1] = ring[(k + 1) % 4], nn = norm([s[0] * (i0 + i1) + t[0] * (j0 + j1), s[1] * (i0 + i1) + t[1] * (j0 + j1), s[2] * (i0 + i1) + t[2] * (j0 + j1)]);
    const A = at(a, i0, j0), Bq = at(a, i1, j1), C = at(b, i1, j1), D = at(b, i0, j0), u = w / 2;
    bin.tri(A, Bq, C, nn, [0, 0], [u, 0], [u, L]);
    bin.tri(A, C, D, nn, [0, 0], [u, L], [0, L]);
  }
  const cap = (p: V3, dir: V3) => { const q = ring.map(([i, j]) => at(p, i, j)); bin.tri(q[0], q[1], q[2], dir, [0, 0], [w, 0], [w, w]); bin.tri(q[0], q[2], q[3], dir, [0, 0], [w, w], [0, w]); };
  cap(b, d); cap(a, [-d[0], -d[1], -d[2]]);
}

const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
