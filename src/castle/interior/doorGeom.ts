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
// - The closed leaf's back face sits `rebate` in from the swing-side face of the wall, against the stop:
//   the step where the rebated outline (the clear outline grown by LIP) meets the clear one. The leaf is
//   the clear outline grown by GROW, so it laps the stop all round and stays LIP − GROW off the rebate.
// - A leaf hangs in one seat and never leaves it. A door that swings both ways (DoorSpec.swingsBack) turns
//   forward on its pintles into spaces[swingInto] and back on its back edge (local z = backAxis) toward the
//   other space. It has no stop: its rebate is its own outline (FIT all round) from the face to just behind
//   it, and behind that the doorway is cut out for its sweep (a square-headed recess as tall as the leaf, as
//   far back as the leaf reaches, then the stop for the eye and the clear outline; or through the wall).
//   doorCuts lists the outline at every depth of the doorway; every wall the door passes through is cut by it.
// - Head rise above the springing (`height`): round w/2, pointed HEAD_RISE.pointed·w, segmental
//   HEAD_RISE.segmental·w, flat 0. `openingOutline` gives the clear outline the shell should cut.
import type { DoorSpec, V3 } from './types';
import type { V2 } from '../../core/math2d';
import { archOutline, HEAD_SEG } from './geom';

export const LIP = 0.08;          // rebate recess beyond the clear opening (per side and at the head)
export const GROW = 0.05;         // leaf beyond the clear opening: how far it laps the stop
export const STOP_GAP = 0.005;    // shut leaf's back face to the stop face
export const HEAD_RISE = { pointed: 0.42, segmental: 0.2 } as const; // pointed matches the gate arch in castle.ts (1.6 / 3.8)
export const OPEN_ANGLE = (100 * Math.PI) / 180;

/** Leaf kinds: every DoorSpec kind but 'gate' (gates have no leaves; the portcullis closes them). */
export type LeafKind = Exclude<DoorSpec['kind'], 'gate'>;
/** Board thickness t, ledge depth (0 = none), gap under the leaf. */
export const KIND: Record<LeafKind, { t: number; ledge: number; sill: number }> = {
  plank: { t: 0.07, ledge: 0.035, sill: 0.02 },
  postern: { t: 0.09, ledge: 0.045, sill: 0.02 },
  grille: { t: 0.035, ledge: 0.035, sill: 0.03 },
};
/** Extra gap under the leaf of a courtyard door: opening outward it clears the paving (PAVE_Y, 2 cm above the sill). */
export const COURT_SILL = 0.02;
/** Gap under a door's leaf (its bottom above the sill). */
export const leafSill = (d: Pick<DoorSpec, 'spaces'>, kind: LeafKind) => KIND[kind].sill + (d.spaces.includes('courtyard') ? COURT_SILL : 0);
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

/**
 * The two outlines of a door, in (u across along `DoorSpec.along`, y absolute): the clear opening, and the
 * rebate recess round a leaf (the clear outline grown by LIP with the same arc centres, point for point;
 * the clear outline for a door without a leaf). Every wall the door passes through is cut with one of
 * them, and its reveals follow them: the shell's room faces and reveals, the castle's wall faces
 * (openings.ts doorHoles) and the leaf (inset from the rebate by LIP − GROW).
 * `rise` overrides the head's rise for an open arch (PlanX.rise); leaves always take headRise.
 */
export function doorOutlines(d: DoorSpec, rise?: number): { clear: V2[]; reb: V2[]; sweep: V2[] } {
  const leafy = d.leaf && d.kind !== 'gate', y = d.centre[1];
  const clear = archOutline(0, y, d.width, d.height, d.head, leafy ? headRise(d.head, d.width) : rise ?? headRise(d.head, d.width));
  if (!leafy) return { clear, reb: clear, sweep: clear };
  // a back-swinging leaf fills its rebate: the rebate is the leaf's own outline (its size class, a polygon with
  // the clear outline's vertex count: leafHead) grown by FIT
  const cls = leafClassFor(d, d.kind as LeafKind), back = !!d.swingsBack;
  const grown = headTop(d.head, d.width, d.height, -LIP), k = 1 + (2 * LIP) / d.width;
  const reb = back ? [[-headHalf(cls, GROW + FIT), y], [headHalf(cls, GROW + FIT), y], ...headPoly(cls, GROW + FIT).map(([u, h]): V2 => [u, y + h])] as V2[]
    : clear.map(([u, yy], i): V2 => (i < 2 ? [u * k, yy] : [u * k, y + grown(u * k)]));
  // the back sweep's recess: square-headed, LIP beyond the clear jambs, SWEEP_HEAD over the leaf's top
  const top = y + cls.sill + leafTop(cls) + SWEEP_HEAD, ks = 1 + (2 * LIP) / d.width;
  return { clear, reb, sweep: clear.map(([u, yy], i): V2 => (i < 2 ? [u * ks, yy] : [u * ks, top])) };
}

/** Gap round a back-swinging leaf in its rebate (it has no stop to lap, so it fills the rebate). */
export const FIT = 0.001;
/** Headroom over a back-swinging leaf's top in the recess it sweeps through. */
export const SWEEP_HEAD = 0.015;
/** Furthest a leaf swings back. */
export const BACK_ANGLE = Math.PI / 2;
/** Top of a leaf of class `cls` above its bottom. */
export const leafTop = (cls: LeafClass) => leafHead(cls)(0) - cls.sill;
/** Half the width of a class's head outline grown by g. */
const headHalf = (cls: LeafClass, g: number) => cls.ow / 2 + g;
/**
 * A class's head grown by g (above the sill) as a polygon with the clear outline's vertex count (HEAD_SEG + 1
 * points from the right springing over to the left), its vertices on the curve at even angles (the apex of a
 * pointed head among them). A back-swinging leaf's head follows it at GROW and its rebate at GROW + FIT, so the
 * two run parallel, FIT apart, chord by chord.
 */
export function headPoly(cls: Pick<LeafClass, 'head' | 'ow' | 'oh'>, g: number): V2[] {
  const top = headTop(cls.head, cls.ow, cls.oh, -g), R = cls.ow / 2 + g;
  return Array.from({ length: HEAD_SEG + 1 }, (_, i): V2 => { const u = i === HEAD_SEG / 2 ? 0 : R * Math.cos((Math.PI * i) / HEAD_SEG); return [u, top(u)]; });
}
/** The top of a class's leaf (above the sill) at s across the opening: its head curve, or for a back-swinging
 *  leaf (fit) the chords of headPoly at GROW. */
export function leafHead(cls: LeafClass): (s: number) => number {
  const curve = headTop(cls.head, cls.ow, cls.oh, -GROW);
  if (!cls.fit) return curve;
  const pts = headPoly(cls, GROW).reverse(); // left to right
  return (s) => {
    if (s <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (s <= pts[i][0]) { const [a, b] = [pts[i - 1], pts[i]], t = (s - a[0]) / (b[0] - a[0] || 1); return a[1] + (b[1] - a[1]) * t; }
    return pts[pts.length - 1][1];
  };
}
/** Rebate beyond the clear outline: LIP, or for a back-swinging leaf (which fills it) about GROW + FIT. */
export const lipOf = (d: DoorSpec) => (d.swingsBack ? GROW + FIT : LIP);

/** One stretch of a doorway, by signed depth t along its normal from the wall's mid-plane, and its outline. */
export interface Cut { t0: number; t1: number; o: V2[]; band: 'clear' | 'reb' | 'sweep' }

/**
 * The doorway at every depth, from the spaces[0] side (t0 = −∞) to the spaces[1] side (t1 = +∞): the clear
 * outline only for an arch or a gate; for a leaf the rebate from its swing face to the stop, then the clear
 * outline; for a back-swinging leaf the rebate to just behind its back face (REAR_STEP), the sweep's recess
 * as far back as the leaf reaches, then the clear outline (or the recess runs through the wall).
 */
export function doorCuts(d: DoorSpec, rise?: number): Cut[] {
  const { clear, reb, sweep } = doorOutlines(d, rise);
  if (!d.leaf || d.kind === 'gate') return [{ t0: -Infinity, t1: Infinity, o: clear, band: 'clear' }];
  // stretches from the swing face inward, by depth from that face
  const parts: { to: number; o: V2[]; band: Cut['band'] }[] = [];
  if (!d.swingsBack) parts.push({ to: d.wall / 2 - stopPlane(d), o: reb, band: 'reb' }, { to: Infinity, o: clear, band: 'clear' });
  else {
    const b = backReach(d);
    parts.push({ to: b.rear, o: reb, band: 'reb' }, { to: b.through ? Infinity : b.end, o: sweep, band: 'sweep' });
    if (!b.through) parts.push({ to: Infinity, o: clear, band: 'clear' });
  }
  const sg = d.swingInto === 1 ? 1 : -1, at = (depth: number) => (depth === Infinity ? -sg * Infinity : sg * (d.wall / 2 - depth));
  const cuts = parts.map((p, i) => {
    const a = at(i ? parts[i - 1].to : -Infinity), b = at(p.to);
    return { t0: Math.min(a, b), t1: Math.max(a, b), o: p.o, band: p.band };
  });
  return sg > 0 ? cuts.reverse() : cuts;
}

/** How far behind a back-swinging leaf's back face its rebate runs on before the recess opens out: far enough
 *  that a slanting look through the FIT round the shut leaf meets the rebate, short enough that the leaf's
 *  head, turning back, barely brushes it (doors.test.ts: ≤ 6 mm). */
export const REAR_STEP = 0.02;
/** Room left between the back sweep's reach and the far face for a stop; less, and the recess runs through. */
export const MIN_STOP = 0.06;

/**
 * Depths (from the swing face) of a back-swinging leaf's doorway: the end of its rebate, how far back its
 * sweep reaches, and whether that leaves room for a stop before the far face (else the recess runs through).
 */
export function backReach(d: DoorSpec): { rear: number; end: number; through: boolean } {
  const kind = d.kind as LeafKind, f = doorFrame(d, kind), back = f.pivotDepth - leafDepth(kind).zBack;
  const cls = leafClassFor(d, kind), radius = Math.hypot(cls.width, -leafDepth(kind).zBack);
  const end = back + radius + 0.02;
  return { rear: Math.min(back + REAR_STEP, d.wall), end, through: end > d.wall - MIN_STOP };
}

/**
 * Where the stop is, from the wall's mid-plane toward the swing side (0 for a door without a leaf): just
 * behind the shut leaf's back face. A back-swinging leaf has none there (doorCuts), but sits as deep.
 */
export function stopPlane(d: DoorSpec): number {
  return d.leaf && d.kind !== 'gate' ? d.wall / 2 - stopDepth(d, d.kind) : 0;
}

/**
 * Which way a leaf should swing to open away from someone at (x, z): +1 forward into spaces[swingInto],
 * −1 back toward the other space. Toward the space they are not in; if that is the other space and the leaf
 * cannot swing back, forward. In the door's plane (within 5 cm) the side they look away from when `dir` is
 * given, else null (no preference).
 */
export function swingAwayFrom(d: DoorSpec, x: number, z: number, dir?: { x: number; z: number }): 1 | -1 | null {
  const t = (x - d.centre[0]) * d.normal[0] + (z - d.centre[2]) * d.normal[1];
  let away: 0 | 1;
  if (Math.abs(t) >= 0.05) away = t > 0 ? 0 : 1;
  else {
    const f = dir ? dir.x * d.normal[0] + dir.z * d.normal[1] : 0;
    if (Math.abs(f) < 1e-6) return null;
    away = f > 0 ? 0 : 1;
  }
  return away === d.swingInto || !d.swingsBack ? 1 : -1;
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

/** Depth of the stop (the rebate step) in from the swing-side face: just behind the shut leaf's back face. */
export function stopDepth(d: DoorSpec, kind: LeafKind): number {
  return doorFrame(d, kind).pivotDepth - leafDepth(kind).zBack + STOP_GAP;
}

/** One swinging leaf of a door: where its pivot is and which way it faces. */
export interface LeafPlace {
  door: string;
  seat: 0 | 1;          // the space it swings into forward: spaces[seat] (= swingInto)
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
  maxAngle: number;     // forward swing (on the pintles)
  backAngle: number;    // back swing on its back edge (0: it does not swing back)
  backAxis: number;     // local z of that back edge (the leaf's back face)
}

/**
 * Past 90° the leaf swings back toward the wall face beside its hinge jamb. The pivot is pivotDepth in
 * from that face and the rebate jamb LIP − GROW beyond the hinge edge, so the swing stops where the
 * leaf would reach the face past that jamb: 100° for a door near the face, ~90° deep in a passage.
 */
export function maxSwing(pivotDepth: number, lip = LIP) {
  return Math.min(OPEN_ANGLE, Math.PI / 2 + Math.atan((lip - GROW) / Math.max(pivotDepth, 1e-3)));
}

/** Class: leaves that share one geometry. Widths/heights are binned down by < BIN, which the GROW lap absorbs. */
export interface LeafClass {
  key: string; kind: LeafKind; head: DoorSpec['head'];
  sill: number;                 // gap under the leaf (leafSill)
  ow: number; oh: number;       // opening width/height the geometry was cut for
  width: number; sOff: number; sDir: 1 | -1; // leaf in opening coordinates (for the unmirrored hinge-at-left case)
  fit?: boolean;                // a back-swinging leaf: its head is leafHead's chords, to fill its rebate
}

export const BIN = 0.02;
export function leafClassFor(d: DoorSpec, kind: LeafKind): LeafClass {
  const ow = Math.floor(d.width / BIN + 1e-9) * BIN, oh = Math.floor(d.height / BIN + 1e-9) * BIN;
  const width = ow + 2 * GROW;
  const sill = leafSill(d, kind);
  const fit = !!d.swingsBack;
  const key = `${kind}:${d.head}:${ow.toFixed(2)}x${oh.toFixed(2)}${sill === KIND[kind].sill ? '' : `:s${sill.toFixed(2)}`}${fit ? ':fit' : ''}`;
  // hinge edge in the left rebate (s = -ow/2 - GROW), latch toward +s
  return { key, kind, head: d.head, sill, ow, oh, width, sOff: -ow / 2 - GROW, sDir: 1, ...(fit ? { fit } : {}) };
}

/**
 * The leaves a door needs: one whole leaf, or none for an open arch or a gate (closed by its portcullis),
 * hung in the rebate on the spaces[swingInto] face.
 */
export function placeLeaves(d: DoorSpec): LeafPlace[] {
  if (!d.leaf || d.kind === 'gate') return [];
  const kind: LeafKind = d.kind;
  const f = doorFrame(d, kind);
  const cls = leafClassFor(d, kind);
  const hs = d.hinge === 'right' ? 1 : -1;
  const sill = cls.sill;
  // hinge edge at s = hs·(ow/2 + GROW) (class geometry centred in the opening); latch toward the other jamb
  const sHinge = hs * (cls.ow / 2 + GROW);
  const eU: V2 = [-hs * f.right[0], -hs * f.right[1]];
  const base: V2 = [f.swingFace[0] - f.eV[0] * f.pivotDepth, f.swingFace[1] - f.eV[1] * f.pivotDepth];
  const pivot: V3 = [base[0] + f.right[0] * sHinge, d.centre[1] + sill, base[1] + f.right[1] * sHinge];
  // right-handed when eU × up = eV, i.e. eV = (−eU.z, eU.x)
  const mirrored = f.eV[0] * -eU[1] + f.eV[1] * eU[0] < 0;
  const top = leafHead(cls);
  return [{
    door: d.id, seat: d.swingInto, kind, classKey: cls.key, width: cls.width,
    height: top(0) - sill, sOff: sHinge, sDir: (hs > 0 ? -1 : 1) as 1 | -1,
    pivot, eU, eV: f.eV, mirrored, maxAngle: maxSwing(f.pivotDepth, lipOf(d)),
    backAngle: d.swingsBack ? BACK_ANGLE : 0, backAxis: leafDepth(kind).zBack,
  }];
}

// ------------------------------------------------------------------------------------- matrices

/** Column-major 4×4 (three.js Matrix4.elements order). */
export type M4 = number[];
// unrolled (the plan's hinge fitting multiplies millions of these): each entry summed in the same order, from 0, as the loop it replaces
export const m4mul = (a: M4, b: M4): M4 => {
  const o: M4 = new Array(16);
  for (let c = 0; c < 16; c += 4) {
    const b0 = b[c], b1 = b[c + 1], b2 = b[c + 2], b3 = b[c + 3];
    o[c] = 0 + a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    o[c + 1] = 0 + a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    o[c + 2] = 0 + a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    o[c + 3] = 0 + a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return o;
};
export const m4apply = (m: M4, p: V3): V3 => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
export const m4translate = (x: number, y: number, z: number): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
export const m4scale = (x: number, y: number, z: number): M4 => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
/** Rotation by a about +x: +y turns toward +z. */
export const m4rotX = (a: number): M4 => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
/** Swing by a: local +x turns toward local +z. */
export const m4swing = (a: number): M4 => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]; };
const MIRROR: M4 = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * World matrix of a leaf for local transform `local` (in unmirrored leaf space, e.g. a swing).
 * Mirrored leaves use the x-mirrored geometry and the conjugated transform, so every matrix keeps
 * det = +1 and front faces stay front faces.
 */
export function leafMatrix(L: Pick<LeafPlace, 'pivot' | 'eU' | 'eV' | 'mirrored'>, local: M4): M4 {
  const ux = L.mirrored ? -L.eU[0] : L.eU[0], uz = L.mirrored ? -L.eU[1] : L.eU[1];
  const basis: M4 = [ux, 0, uz, 0, 0, 1, 0, 0, L.eV[0], 0, L.eV[1], 0, L.pivot[0], L.pivot[1], L.pivot[2], 1];
  return m4mul(basis, L.mirrored ? m4mul(MIRROR, m4mul(local, MIRROR)) : local);
}

/**
 * Local transform of a leaf swung by `a`: forward (a > 0) on its pintles, back (a < 0) on its back edge
 * (local z = backAxis), so the shut leaf (a = 0) is the same either way and never leaves its seat.
 */
export function leafSwing(L: Pick<LeafPlace, 'backAxis'>, a: number): M4 {
  if (a >= 0) return m4swing(a);
  return m4mul(m4translate(0, 0, L.backAxis), m4mul(m4swing(a), m4translate(0, 0, -L.backAxis)));
}

/** World position of an unmirrored-local point at a local transform (handy for tests and hit boxes). */
export function leafPoint(L: LeafPlace, local: M4, p: V3): V3 {
  return m4apply(leafMatrix(L, local), L.mirrored ? [-p[0], p[1], p[2]] : p);
}
