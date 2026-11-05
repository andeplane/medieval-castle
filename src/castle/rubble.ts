// Single stones for ruins and rubble: a hexahedron (box, wedge or any 8-corner block) whose corners can be
// chipped off, so fallen blocks and broken voussoirs read as dressed stone that has been knocked about
// rather than as clean boxes. Each stone is flat-shaded and appended to a Builder bin.
import type { Builder, MatKey } from './builder';
import { TILE } from './builder';

export type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lenV = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const normV = (a: V3): V3 => { const l = lenV(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * Corner i of a hexahedron sits at bits (x = i & 1, y = i & 2, z = i & 4) of its local box, so corner i and
 * corner i ^ (1 << axis) share an edge. Each face lists its four corners in cyclic order.
 */
export const HEX_FACES: readonly (readonly [number, number, number, number])[] = [
  [0, 2, 6, 4], [1, 5, 7, 3], // x = 0, x = 1
  [0, 4, 5, 1], [2, 3, 7, 6], // y = 0 (bottom), y = 1 (top)
  [0, 1, 3, 2], [4, 6, 7, 5], // z = 0, z = 1
];
export const BOTTOM_FACE = 2;

/** Rotation by yaw (about y), then pitch (about x), then roll (about z), applied as R = Ry · Rx · Rz. */
export function rotate(p: V3, yaw: number, pitch: number, roll: number): V3 {
  const [cz, sz, cx, sx, cy, sy] = [Math.cos(roll), Math.sin(roll), Math.cos(pitch), Math.sin(pitch), Math.cos(yaw), Math.sin(yaw)];
  const a: V3 = [p[0] * cz - p[1] * sz, p[0] * sz + p[1] * cz, p[2]];
  const b: V3 = [a[0], a[1] * cx - a[2] * sx, a[1] * sx + a[2] * cx];
  return [b[0] * cy + b[2] * sy, b[1], -b[0] * sy + b[2] * cy];
}

/** A loose stone ready for addStone: rubble in the moat, fallen coping, broken voussoirs. */
export interface Stone { mat: MatKey; corners: V3[]; chips: number[]; uvOff: [number, number] }

export interface Pose { c: V3; yaw: number; pitch: number; roll: number }

/** Corners of a box of size (x, y, z) centred on the pose. */
export function boxCorners(size: V3, pose: Pose): V3[] {
  return Array.from({ length: 8 }, (_, i) => {
    const l: V3 = [((i & 1 ? 1 : -1) * size[0]) / 2, ((i & 2 ? 1 : -1) * size[1]) / 2, ((i & 4 ? 1 : -1) * size[2]) / 2];
    return add(pose.c, rotate(l, pose.yaw, pose.pitch, pose.roll));
  });
}

/** Corners of a voussoir-like wedge: x is `inner` long at the bottom and `outer` long at the top. */
export function wedgeCorners(inner: number, outer: number, height: number, width: number, pose: Pose): V3[] {
  return Array.from({ length: 8 }, (_, i) => {
    const top = !!(i & 2), half = (top ? outer : inner) / 2;
    const l: V3 = [(i & 1 ? 1 : -1) * half, ((top ? 1 : -1) * height) / 2, ((i & 4 ? 1 : -1) * width) / 2];
    return add(pose.c, rotate(l, pose.yaw, pose.pitch, pose.roll));
  });
}

export interface StoneOpts {
  /** Chip size per corner in metres (0 = sharp). Omit for a plain six-faced block. */
  chips?: number[];
  /** Texture scale: < 1 magnifies the texture so a face shows fewer joints. */
  uvScale?: number;
  uvOff?: [number, number];
  /** Faces to leave out (indices into HEX_FACES), e.g. a bottom that is never seen. */
  skip?: number[];
}

/** Append a (chipped) hexahedron to a bin. Returns the number of triangles added. */
export function addStone(B: Builder, mat: MatKey, corners: V3[], o: StoneOpts = {}): number {
  const bin = B.bins[mat], T = TILE[mat] / (o.uvScale ?? 1), off = o.uvOff ?? [0, 0];
  const centre = mul(corners.reduce((s, c) => add(s, c), [0, 0, 0] as V3), 1 / 8);
  const chips = o.chips;
  const edgePt = (v: number, w: number): V3 => {
    const e = sub(corners[w], corners[v]), L = lenV(e);
    const c = Math.min(chips![v], L * 0.42);
    return add(corners[v], mul(e, c / (L || 1)));
  };
  let tris = 0;
  const poly = (pts: V3[]) => {
    // Newell normal, oriented away from the stone's centre
    let n: V3 = [0, 0, 0];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      n = add(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
    }
    if (lenV(n) < 1e-9) return;
    n = normV(n);
    const fc = mul(pts.reduce((s, c) => add(s, c), [0, 0, 0] as V3), 1 / pts.length);
    if (dot(n, sub(fc, centre)) < 0) n = mul(n, -1);
    const t: V3 = Math.abs(n[1]) < 0.8 ? normV([n[2], 0, -n[0]]) : [1, 0, 0];
    const b: V3 = Math.abs(n[1]) < 0.8 ? [0, 1, 0] : [0, 0, 1];
    const uv = (p: V3): [number, number] => [dot(p, t) / T + off[0], dot(p, b) / T + off[1]];
    for (let i = 1; i < pts.length - 1; i++) {
      const p0 = pts[0], p1 = pts[i], p2 = pts[i + 1];
      if (lenV(sub(p1, p0)) < 1e-6 || lenV(sub(p2, p1)) < 1e-6 || lenV(sub(p2, p0)) < 1e-6) continue;
      bin.tri(p0, p1, p2, n, uv(p0), uv(p1), uv(p2));
      tris++;
    }
  };
  HEX_FACES.forEach((f, fi) => {
    if (o.skip?.includes(fi)) return;
    if (!chips) { poly(f.map((i) => corners[i])); return; }
    const pts: V3[] = [];
    for (let k = 0; k < 4; k++) { const v = f[k], prev = f[(k + 3) % 4], next = f[(k + 1) % 4]; pts.push(edgePt(v, prev), edgePt(v, next)); }
    poly(pts);
  });
  if (chips) for (let v = 0; v < 8; v++) if (chips[v] > 1e-4) poly([edgePt(v, v ^ 1), edgePt(v, v ^ 2), edgePt(v, v ^ 4)]);
  return tris;
}

/** Flat triangle facing roughly along `hint` (its true normal is used). UVs are planar in metres, with
 *  courses level on steep faces. */
export function faceTri(B: Builder, mat: MatKey, a: V3, b: V3, c: V3, hint: V3) {
  let n = cross3(sub(b, a), sub(c, a));
  const l = lenV(n); if (l < 1e-9) return;
  n = mul(n, 1 / l);
  if (dot(n, hint) < 0) n = mul(n, -1);
  const T = TILE[mat], horiz = Math.abs(n[1]) > 0.8;
  const tg: V3 = horiz ? [1, 0, 0] : normV([n[2], 0, -n[0]]);
  const uv = (p: V3): [number, number] => (horiz ? [p[0] / T, p[2] / T] : [dot(p, tg) / T, p[1] / T]);
  B.bins[mat].tri(a, b, c, n, uv(a), uv(b), uv(c));
}

export function faceQuad(B: Builder, mat: MatKey, a: V3, b: V3, c: V3, d: V3, hint: V3) { faceTri(B, mat, a, b, c, hint); faceTri(B, mat, a, c, d, hint); }

const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
