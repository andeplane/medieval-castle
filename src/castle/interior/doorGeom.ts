// Door maths with no three.js in it, so tests can check it directly: how a DoorSpec becomes leaves
// (hinge side, swing direction, where in the wall thickness the leaf sits), the head outlines, size
// classes for shared geometry and the leaf transform at a swing angle.
//
// Conventions (in addition to types.ts):
// - "right" of a door is the right hand of someone in spaces[0] looking along +normal: [-n.z, n.x].
// - Leaf local coordinates: x from the hinge edge toward the latch edge, y up from the leaf bottom,
//   z toward the space the leaf swings into. The pintle (pivot) axis is the local y axis at x = z = 0.
//   The leaf body is z in [zBack, zFront] (zFront faces the swing space); ledges, braces and strap
//   hinges stand on the front face, up to z = 0.
// - The closed leaf's back face sits `rebate` in from the swing-side face of the wall (the stop).
// - Head rise above the springing (`height`): round w/2, pointed HEAD_RISE.pointed·w, segmental
//   HEAD_RISE.segmental·w, flat 0. `openingOutline` gives the clear outline the shell should cut.
import type { DoorSpec, V3 } from './types';
import type { V2 } from '../../core/math2d';

export const CLEAR = 0.015;       // leaf to jamb and head clearance (per side)
export const MEET = 0.006;        // gap between the two gate leaves (each side of the centre line)
export const HEAD_RISE = { pointed: 0.42, segmental: 0.2 } as const; // pointed matches the gate arch in castle.ts (1.6 / 3.8)
export const OPEN_ANGLE = (100 * Math.PI) / 180;

export type LeafKind = 'plank' | 'gate' | 'postern' | 'grille' | 'wicket';
/** Board thickness t, ledge depth (0 = none), gap under the leaf. */
export const KIND: Record<LeafKind, { t: number; ledge: number; sill: number }> = {
  plank: { t: 0.07, ledge: 0.035, sill: 0.02 },
  postern: { t: 0.09, ledge: 0.045, sill: 0.02 },
  gate: { t: 0.09, ledge: 0.06, sill: 0.03 },
  wicket: { t: 0.09, ledge: 0.06, sill: 0 },
  grille: { t: 0.035, ledge: 0.035, sill: 0.03 },
};
/** Pintle axis stands this far proud of the ledges / strap hinges. */
export const PIVOT_STANDOFF = 0.012;
export const leafDepth = (k: LeafKind) => ({ zFront: -(KIND[k].ledge + PIVOT_STANDOFF), zBack: -(KIND[k].ledge + PIVOT_STANDOFF + KIND[k].t) });

export function headRise(head: DoorSpec['head'], w: number) {
  return head === 'round' ? w / 2 : head === 'pointed' ? HEAD_RISE.pointed * w : head === 'segmental' ? HEAD_RISE.segmental * w : 0;
}

/** Top of the opening (c = 0) or of a leaf inset by c, at s across the opening (s = 0 on the centre line). */
export function headTop(head: DoorSpec['head'], w: number, h: number, c = 0): (s: number) => number {
  const rise = headRise(head, w);
  if (head === 'flat') return () => h - c;
  if (head === 'round') { const R = w / 2 - c; return (s) => h + Math.sqrt(Math.max(0, R * R - s * s)); }
  if (head === 'pointed') {
    const R = (w * w / 4 + rise * rise) / w, cc = w / 2 - R, Rc = R - c;
    return (s) => { const d = Math.abs(s) - cc; return h + Math.sqrt(Math.max(0, Rc * Rc - d * d)); };
  }
  const R = (w * w / 4 + rise * rise) / (2 * rise), yc = h + rise - R, Rc = R - c;
  return (s) => yc + Math.sqrt(Math.max(0, Rc * Rc - s * s));
}

/**
 * Clear opening outline in (s, y), y from the sill, counter-clockwise, `seg` points per head half.
 * `grow` > 0 offsets it outward (same arc centres): the rebate recess around the leaf.
 */
export function openingOutline(head: DoorSpec['head'], w: number, h: number, seg = 12, grow = 0): V2[] {
  const top = headTop(head, w, h, -grow), W = w + 2 * grow;
  const pts: V2[] = [[-W / 2, 0], [W / 2, 0]];
  if (head === 'flat') return [...pts, [W / 2, h + grow], [-W / 2, h + grow]];
  for (let i = 0; i <= seg * 2; i++) { const s = W / 2 - (W * i) / (seg * 2); pts.push([s, top(s)]); }
  return pts;
}

// ------------------------------------------------------------------------------------- frames

export interface DoorFrame {
  right: V2;          // across the opening, spaces[0]'s right hand
  eV: V2;             // into the swing space
  swingFace: V2;      // a point on the swing-side wall face, on the opening centre line
  pivotDepth: number; // pivot axis distance inside the swing face
}

export function doorFrame(d: DoorSpec, kind: LeafKind): DoorFrame {
  const n = d.normal, right: V2 = [-n[1], n[0]];
  const s = d.swingInto === 1 ? 1 : -1, eV: V2 = [n[0] * s, n[1] * s];
  const swingFace: V2 = [d.centre[0] + eV[0] * d.wall / 2, d.centre[2] + eV[1] * d.wall / 2];
  const back = -leafDepth(kind).zBack; // pivot to back face
  // back face against the stop at `rebate`, but keep the whole leaf (and its knuckles) inside the wall
  const pivotDepth = Math.min(Math.max(d.rebate - back, 0.03), Math.max(0.03, d.wall - back - 0.01));
  return { right, eV, swingFace, pivotDepth };
}

/** One swinging leaf of a door: where its pivot is and which way it faces. */
export interface LeafPlace {
  door: string;
  kind: LeafKind;
  classKey: string;
  width: number;        // along the leaf, hinge edge to latch edge
  height: number;       // tallest point
  sOff: number;         // s of the hinge edge in the opening (hinge edge = pivot axis)
  sDir: 1 | -1;         // s grows (+1) or shrinks (-1) going from the hinge to the latch
  pivot: V3;            // world, at the leaf bottom
  eU: V2;               // hinge → latch (closed), world
  eV: V2;               // into the swing space
  mirrored: boolean;    // (eU, up, eV) is left-handed: use the mirrored geometry
  maxAngle: number;
  wicket?: boolean;     // gate leaf that carries the wicket door
}

/**
 * Past 90° the leaf's front edge swings back toward the jamb it hangs on. Inside the wall (the pivot is
 * pivotDepth in from the face) that would cut into the reveal, so the swing stops where the leaf
 * would come within CLEAR of the jamb: about 100° for a door near the face, ~90° deep in a passage.
 */
export function maxSwing(pivotDepth: number) {
  return Math.min(OPEN_ANGLE, Math.PI / 2 + Math.atan(CLEAR / Math.max(pivotDepth, 1e-3)));
}

/** Class: leaves that share one geometry. Widths/heights are binned down so every member keeps ≥ CLEAR. */
export interface LeafClass {
  key: string; kind: LeafKind; head: DoorSpec['head'];
  ow: number; oh: number;       // opening width/height the geometry was cut for
  width: number; sOff: number; sDir: 1 | -1; // leaf in opening coordinates (for the unmirrored hinge-at-left case)
}

const BIN = 0.04;
export function leafClassFor(d: DoorSpec, kind: LeafKind, part: 'single' | 'gate' = kind === 'gate' ? 'gate' : 'single'): LeafClass {
  const ow = Math.floor(d.width / BIN) * BIN, oh = Math.floor(d.height / BIN) * BIN;
  const width = part === 'gate' ? ow / 2 - CLEAR - MEET : ow - 2 * CLEAR;
  const key = `${kind}:${d.head}:${ow.toFixed(2)}x${oh.toFixed(2)}`;
  // hinge edge at the left jamb (s = -ow/2 + CLEAR), latch toward +s
  return { key, kind, head: d.head, ow, oh, width, sOff: -ow / 2 + CLEAR, sDir: 1 };
}

/** The leaves a door needs (none for an open arch). Gate: two leaves; hinge 'left' = leaf 0 hinged left. */
export function placeLeaves(d: DoorSpec): LeafPlace[] {
  if (!d.leaf) return [];
  const kind: LeafKind = d.kind;
  const f = doorFrame(d, kind);
  const cls = leafClassFor(d, kind);
  const sides: (1 | -1)[] = kind === 'gate' ? [d.hinge === 'right' ? 1 : -1, d.hinge === 'right' ? -1 : 1] : [d.hinge === 'right' ? 1 : -1];
  const sill = KIND[kind].sill;
  return sides.map((hs, i) => {
    // hinge edge at s = hs·(ow/2 − CLEAR) (class geometry centred in the opening); latch toward the centre
    const sHinge = hs * (cls.ow / 2 - CLEAR);
    const eU: V2 = [-hs * f.right[0], -hs * f.right[1]];
    const base: V2 = [f.swingFace[0] - f.eV[0] * f.pivotDepth, f.swingFace[1] - f.eV[1] * f.pivotDepth];
    const pivot: V3 = [base[0] + f.right[0] * sHinge, d.centre[1] + sill, base[1] + f.right[1] * sHinge];
    // right-handed when eU × up = eV, i.e. eV = (−eU.z, eU.x)
    const mirrored = f.eV[0] * -eU[1] + f.eV[1] * eU[0] < 0;
    const top = headTop(d.head, cls.ow, cls.oh, CLEAR);
    return {
      door: d.id, kind, classKey: cls.key + (kind === 'gate' ? (i === 0 ? ':w' : ':g') : ''), width: cls.width,
      height: top(0) - sill, sOff: sHinge, sDir: (hs > 0 ? -1 : 1) as 1 | -1,
      pivot, eU, eV: f.eV, mirrored, maxAngle: maxSwing(f.pivotDepth) - (i ? 0.03 : 0), wicket: kind === 'gate' && i === 0,
    };
  });
}

// ------------------------------------------------------------------------------------- matrices

/** Column-major 4×4 (three.js Matrix4.elements order). */
export type M4 = number[];
export const m4mul = (a: M4, b: M4): M4 => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; }
  return o;
};
export const m4apply = (m: M4, p: V3): V3 => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
export const m4translate = (x: number, y: number, z: number): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
/** Swing by a: local +x turns toward local +z. */
export const m4swing = (a: number): M4 => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]; };
/** In-plane droop by a: local +x turns toward −y (sagging latch end). */
export const m4droop = (a: number): M4 => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
const MIRROR: M4 = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * World matrix of a leaf for local transform `local` (in unmirrored leaf space, e.g. swing · droop).
 * Mirrored leaves use the x-mirrored geometry and the conjugated transform, so every matrix keeps
 * det = +1 and front faces stay front faces.
 */
export function leafMatrix(L: Pick<LeafPlace, 'pivot' | 'eU' | 'eV' | 'mirrored'>, local: M4): M4 {
  const ux = L.mirrored ? -L.eU[0] : L.eU[0], uz = L.mirrored ? -L.eU[1] : L.eU[1];
  const basis: M4 = [ux, 0, uz, 0, 0, 1, 0, 0, L.eV[0], 0, L.eV[1], 0, L.pivot[0], L.pivot[1], L.pivot[2], 1];
  return m4mul(basis, L.mirrored ? m4mul(MIRROR, m4mul(local, MIRROR)) : local);
}

/** World position of an unmirrored-local point at a local transform (handy for tests and hit boxes). */
export function leafPoint(L: LeafPlace, local: M4, p: V3): V3 {
  return m4apply(leafMatrix(L, local), L.mirrored ? [-p[0], p[1], p[2]] : p);
}

/** Easing helpers. */
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
