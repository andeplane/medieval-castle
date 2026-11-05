// Stairs (game-building-generation): spiral newel stairs for the towers and straight flights (mural
// stairs inside the wall thickness, courtyard steps). Every step is its own stone: a wedge tread with
// a nosing and a worn hollow, its own newel drum, and a helical soffit under it that you see from the
// turn below. A stair is planned first (pure numbers: angles, heights, wear), then built into the
// Builder's material bins. Everything is a pure function of the StairSpec and the seed.
//
// Conventions (src/castle/interior/types.ts): angles use atan2(z, x), so with x east and z south an
// increasing angle runs clockwise seen from above. StairSpec.turn = +1 means counter-clockwise going
// up, so the angle of the n-th step is startAngle + dir * progress with dir = -turn. Default turn is
// -1 (clockwise ascending, the traditional hand). A landing's `angle` is where its door is centred
// on the drum.
//
// Collision: closed risers and solid treads, so the render triangles work as a collider directly
// (rise <= 0.21 m, well inside a 0.3 m autostep). stairCollisionRamp() gives an invisible ramp
// through the nosings that lies on or above every tread, so it can be added *alongside* the render
// triangles for smooth walking; see the note on that function.
import * as THREE from 'three/webgpu';
import { TILE, type Builder, type MatKey } from '../builder';
import { hashSeed, mulberry32, range, type Rng } from '../../core/rng';
import type { V2 } from '../../core/math2d';
import type { StairSpec, V3 } from './types';

/** Design rules. Limits are what the validator enforces; targets are what the planner aims for. */
export const STAIR_RULES = {
  riseMax: 0.198,       // planner's largest rise before the ±3 mm per-step jitter
  riseLimit: 0.21,      // validator: every rise
  goingLimit: 0.22,     // validator: every going at the walking line
  headroomLimit: 2.0,   // validator: clear height along the walking line
  headroom: 2.05,       // planner's target headroom
  goingTarget: 0.4,     // spiral going at the walking line the planner aims for
  waist: 0.13,          // stone left under the back of a tread (soffit sits waist + rise under the nosing line)
  nosing: 0.035,        // nosing overhang
  lip: 0.045,           // nosing thickness
  embed: 0.08,          // tread ends run this far into the drum / passage walls
  doorWidth: 1.0, doorHeight: 2.1,
  landingMargin: 0.25,  // flat landing beyond each door jamb, at the drum
  solidBelow: 1.9,      // first-turn steps whose soffit would be lower than this over the floor are solid
  muralClear: 2.12,     // mural stair: lintel underside over the highest tread it covers
};

export interface StairOpts {
  /** Thin inner drum skin at radius + 0.02, with door gaps at the landings. Only where the shell builds no wall. */
  skin?: boolean;
  /** Extra openings in the skin (slit windows). */
  skinOpenings?: DrumOpening[];
  /** Polygonal stair room (world x, z): tread ends run to this outline instead of the circle. */
  drumPoly?: V2[];
  /** Annular floor at the bottom landing, 4 mm under it so a coplanar shell floor wins. Default true. */
  bottomFloor?: boolean;
  /** Underside of the stairwell ceiling above the top landing (default top landing + 2.4). The newel runs up to it. */
  ceiling?: number;
  /** Build that ceiling as an annulus (default false: it is the shell's). */
  ceilingDisc?: boolean;
  /** Radial wall closing the stairwell behind the top landing (default true). */
  topWall?: boolean;
  /** Rope handrail on iron staples along the drum (default true for round drums). */
  handrail?: boolean;
  doorWidth?: number; doorHeight?: number;
  /** Straight stairs: side walls + stepped lintels. Default: mural unless it serves 'courtyard' or 'outside'. */
  mural?: boolean;
  mat?: Partial<{ step: MatKey; wall: MatKey; rope: MatKey; iron: MatKey }>;
  /**
   * Randomness source (dependency injection). A plan draws one number from it to seed itself, so
   * reuse the plan that buildStair returns rather than planning twice from the same rng. Default:
   * a stream seeded from the world seed and the stair id (rngFor-style).
   */
  rng?: Rng;
}

/** What the stair code needs from a Builder (a small fake works in tests). */
export type StairSink = Pick<Builder, 'bins' | 'box' | 'planar'>;

export interface DrumOpening { angle: number; width: number; y0: number; y1: number }

export interface StairStats {
  steps: number; maxRise: number; minRise: number; minGoing: number; minHeadroom: number;
  landingErr: number; perTurn?: number; problems: string[]; ok: boolean;
}

export interface SpiralStep {
  a0: number; a1: number;  // progress angle (radians from startAngle, growing upward) of the riser line and the back edge
  y: number; rise: number; // tread height and rise from the previous tread
  landing: number;         // index into the spec's landings, -1 for an ordinary step
  solid: boolean;          // first-turn steps that are built solid down to the floor
  wear: number; wearF: number; tilt: number; nosing: number; soffitJit: number; drumJit: number; uOff: number; vOff: number;
}

export interface SpiralPlan {
  kind: 'spiral'; id: string; seed: number;
  c: V2; R: number; rn: number; dir: 1 | -1; theta0: number;
  yFloor: number; yTop: number; rWalk: number; T: number; perTurn: number;
  entry: [number, number];  // progress range of the bottom landing (floor) in front of the first step
  steps: SpiralStep[];
  landings: { y: number; psi: number; angle: number; step: number; clear: number }[]; // door centre; step = -1 for the floor
  stats: StairStats;
}

export interface StraightStep {
  s0: number; s1: number; y: number; rise: number; landing: number;
  wear: number; wearF: number; tilt: number; nosing: number; uOff: number; vOff: number;
}

export interface StraightPlan {
  kind: 'straight'; id: string; seed: number;
  o: V3; d: V2; side: V2; run: number; width: number; mural: boolean;
  yFloor: number; yTop: number; lead: number;   // flat floor before the first riser
  steps: StraightStep[];                        // the last one is the top landing (may be 0 long)
  ceiling: { s0: number; s1: number; y: number }[];
  stats: StairStats;
}

export type StairPlan = SpiralPlan | StraightPlan;

// ---------------------------------------------------------------------------------------------
// small vector helpers

type UV = [number, number];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a: V3): V3 => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const TAU = Math.PI * 2;
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;
const MIN_AREA2 = 2e-6; // |cross| below this (1 mm² triangles) is skipped as degenerate

/** One triangle with per-vertex normals; the winding is fixed to agree with them. */
function tri(B: StairSink, mat: MatKey, p: V3[], n: V3[], t: UV[]) {
  const fn = cross3(sub3(p[1], p[0]), sub3(p[2], p[0]));
  if (!(len3(fn) > MIN_AREA2)) return;
  if (dot3(fn, add3(add3(n[0], n[1]), n[2])) < 0) { p = [p[0], p[2], p[1]]; n = [n[0], n[2], n[1]]; t = [t[0], t[2], t[1]]; }
  B.bins[mat].triN(p, n, t);
}

/** A grid surface P[row][col] with smooth normals oriented toward `hint`. */
function surface(B: StairSink, mat: MatKey, P: V3[][], U: UV[][], hint: V3 | ((j: number, k: number) => V3)) {
  const R = P.length, C = P[0].length;
  const N: V3[][] = [];
  for (let j = 0; j < R; j++) {
    N.push([]);
    for (let k = 0; k < C; k++) {
      const h = typeof hint === 'function' ? hint(j, k) : hint;
      const dj = sub3(P[Math.min(j + 1, R - 1)][k], P[Math.max(j - 1, 0)][k]);
      const dk = sub3(P[j][Math.min(k + 1, C - 1)], P[j][Math.max(k - 1, 0)]);
      let n = cross3(dj, dk);
      if (len3(n) < 1e-9) n = h;
      n = norm3(n);
      if (dot3(n, h) < 0) n = mul3(n, -1);
      N[j].push(n);
    }
  }
  for (let j = 0; j < R - 1; j++) for (let k = 0; k < C - 1; k++) {
    const a: [number, number] = [j, k], b: [number, number] = [j, k + 1], c: [number, number] = [j + 1, k + 1], d: [number, number] = [j + 1, k];
    for (const q of [[a, b, c], [a, c, d]]) tri(B, mat, q.map(([x, y]) => P[x][y]), q.map(([x, y]) => N[x][y]), q.map(([x, y]) => U[x][y]));
  }
}

/** A vertical cylinder band (smooth normals). u wraps an integer number of tiles. */
function band(B: StairSink, mat: MatKey, c: V2, r: number, y0: number, y1: number, seg: number, inward: boolean, uOff = 0, vOff = 0, a0 = 0, a1 = TAU) {
  const T = TILE[mat], k = Math.max(1, Math.round((TAU * r) / T));
  const P: V3[][] = [[], []], U: UV[][] = [[], []];
  for (let i = 0; i <= seg; i++) {
    const a = a0 + ((a1 - a0) * i) / seg;
    for (const [row, y] of [[0, y0], [1, y1]] as const) {
      P[row].push([c[0] + Math.cos(a) * r, y, c[1] + Math.sin(a) * r]);
      U[row].push([(a / TAU) * k + uOff, y / T + vOff]);
    }
  }
  surface(B, mat, P, U, (_j, i) => { const a = a0 + ((a1 - a0) * i) / seg, s = inward ? -1 : 1; return [Math.cos(a) * s, 0, Math.sin(a) * s]; });
}

/** Flat horizontal annulus between r0 and r1(angle) at height y. */
function annulus(B: StairSink, mat: MatKey, c: V2, r0: number, r1: (a: number) => number, y: number, up: boolean, seg = 48) {
  const T = TILE[mat], P: V3[][] = [], U: UV[][] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (TAU * i) / seg, row: V3[] = [], urow: UV[] = [];
    for (const r of [r0, r1(a)]) { const p: V3 = [c[0] + Math.cos(a) * r, y, c[1] + Math.sin(a) * r]; row.push(p); urow.push([p[0] / T, p[2] / T]); }
    P.push(row); U.push(urow);
  }
  surface(B, mat, P, U, [0, up ? 1 : -1, 0]);
}

/**
 * Cylindrical wall face of radius r from y0 to y1 with rectangular holes (doors, slits). `inward`
 * faces the axis (a drum seen from inside). Opening widths are arc lengths at this radius.
 */
export function drumWall(B: StairSink, mat: MatKey, c: V2, r: number, y0: number, y1: number, openings: DrumOpening[] = [], inward = true) {
  const seg = Math.max(24, Math.ceil((TAU * r) / 0.35));
  const cuts = new Set<number>();
  for (let i = 0; i < seg; i++) cuts.add((TAU * i) / seg);
  for (const o of openings) { const h = Math.min(Math.PI - 1e-4, o.width / 2 / r); cuts.add(wrap(o.angle - h)); cuts.add(wrap(o.angle + h)); }
  const as = [...cuts].sort((a, b) => a - b);
  const T = TILE[mat], k = Math.max(1, Math.round((TAU * r) / T)), s = inward ? -1 : 1;
  for (let i = 0; i < as.length; i++) {
    const a = as[i], b = i + 1 < as.length ? as[i + 1] : as[0] + TAU, m = (a + b) / 2;
    if (b - a < 1e-6) continue;
    let spans: [number, number][] = [[y0, y1]];
    for (const o of openings) {
      let da = wrap(m - o.angle); if (da > Math.PI) da -= TAU;
      if (Math.abs(da) * r > o.width / 2) continue;
      spans = spans.flatMap(([p, q]): [number, number][] => {
        if (o.y1 <= p || o.y0 >= q) return [[p, q]];
        const out: [number, number][] = [];
        if (o.y0 > p) out.push([p, o.y0]);
        if (o.y1 < q) out.push([o.y1, q]);
        return out;
      });
    }
    for (const [p, q] of spans) {
      if (q - p < 1e-4) continue;
      const P: V3[][] = [[], []], U: UV[][] = [[], []];
      for (const [col, ang] of [[0, a], [1, b]] as const) {
        P[0][col] = [c[0] + Math.cos(ang) * r, p, c[1] + Math.sin(ang) * r]; U[0][col] = [(ang / TAU) * k, p / T];
        P[1][col] = [c[0] + Math.cos(ang) * r, q, c[1] + Math.sin(ang) * r]; U[1][col] = [(ang / TAU) * k, q / T];
      }
      surface(B, mat, P, U, (_j, col) => { const ang = col ? b : a; return [Math.cos(ang) * s, 0, Math.sin(ang) * s]; });
    }
  }
}

/** Distance from c along angle a to a polygon outline (for polygonal stair rooms). */
function rayPoly(c: V2, a: number, poly: V2[]) {
  const dx = Math.cos(a), dz = Math.sin(a);
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const ex = q[0] - p[0], ez = q[1] - p[1];
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((p[0] - c[0]) * ez - (p[1] - c[1]) * ex) / den;
    const u = ((p[0] - c[0]) * dz - (p[1] - c[1]) * dx) / den;
    if (t > 0 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// wear profile shared by both kinds: deepest a little behind the nosing on the walking line, nothing at the back

const wearAlong = (t: number) => (Math.pow(1 - Math.min(1, Math.max(0, t)), 1.2) * (0.6 + 1.6 * t)) / 0.71;
const wearAcross = (f: number, centre: number, sigma: number) => Math.exp(-(((f - centre) / sigma) ** 2));

function emptyStats(): StairStats {
  return { steps: 0, maxRise: 0, minRise: Infinity, minGoing: Infinity, minHeadroom: Infinity, landingErr: 0, problems: [], ok: true };
}
function finish(st: StairStats) {
  const R = STAIR_RULES;
  if (st.maxRise > R.riseLimit + 1e-9) st.problems.push(`rise ${st.maxRise.toFixed(3)} > ${R.riseLimit}`);
  if (st.minGoing < R.goingLimit - 1e-9) st.problems.push(`going ${st.minGoing.toFixed(3)} < ${R.goingLimit}`);
  if (st.minHeadroom < R.headroomLimit - 1e-9) st.problems.push(`headroom ${st.minHeadroom.toFixed(3)} < ${R.headroomLimit}`);
  if (st.landingErr > 0.01) st.problems.push(`landing off by ${st.landingErr.toFixed(3)}`);
  st.ok = st.problems.length === 0;
  return st;
}

/** Split [y0, y1] into equal rises no larger than riseMax. */
const risesFor = (dy: number) => { const n = Math.max(1, Math.ceil(dy / STAIR_RULES.riseMax - 1e-9)); return { n, rise: dy / n }; };

// ---------------------------------------------------------------------------------------------
// spiral plan

/** Progress angle → world angle for a plan. */
export const spiralTheta = (p: SpiralPlan, psi: number) => p.theta0 + p.dir * psi;

/** Index of the step covering progress psi, or -1 (entry floor below, or above the top). */
function stepAt(p: SpiralPlan, psi: number) {
  const s = p.steps;
  if (psi < s[0].a0 || psi >= s[s.length - 1].a1) return -1;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m].a0 <= psi) lo = m; else hi = m - 1; }
  return lo;
}

/** The nosing line: piecewise linear through the front edge of every tread. */
export function spiralNosingY(p: SpiralPlan, psi: number) {
  const s = p.steps, i = stepAt(p, psi);
  if (i < 0) {
    if (psi < s[0].a0) return Math.max(p.yFloor, s[0].y - (s[0].rise * (s[0].a0 - psi)) / (s[0].a1 - s[0].a0));
    const l = s[s.length - 1]; return l.y + l.rise;
  }
  const a = s[i], nextY = i + 1 < s.length ? s[i + 1].y : a.y + a.rise;
  return a.y + ((nextY - a.y) * (psi - a.a0)) / (a.a1 - a.a0);
}

/** Walking surface (nominal, before wear) at progress psi: the floor in front of the first step, NaN above the top. */
export function spiralTreadY(p: SpiralPlan, psi: number) {
  const i = stepAt(p, psi);
  if (i >= 0) return p.steps[i].y;
  return psi < p.steps[0].a0 ? p.yFloor : NaN;
}

const soffitY = (p: SpiralPlan, i: number, psi: number) => spiralNosingY(p, psi) - p.T + p.steps[i].soffitJit;

/** Clear height at psi: soffit of the turn above minus the walking surface (Infinity if open above). */
export function spiralHeadroom(p: SpiralPlan, psi: number, ceiling?: number) {
  const y = spiralTreadY(p, psi);
  if (Number.isNaN(y)) return Infinity;
  for (let q = 1; q < 4; q++) {
    const j = stepAt(p, psi + TAU * q);
    if (j >= 0) return soffitY(p, j, psi + TAU * q) - y;
    if (psi + TAU * q >= p.steps[p.steps.length - 1].a1) break;
  }
  return ceiling !== undefined ? ceiling - y : Infinity;
}

export function layoutSpiral(s: StairSpec, o: StairOpts, perTurn: number, seed: number): SpiralPlan {
  const RU = STAIR_RULES;
  const R = s.radius ?? 1.2, rn = s.newel ?? 0.15, turn = s.turn ?? -1, dir = (-turn) as 1 | -1;
  const c: V2 = s.centre ?? [0, 0];
  const L = s.landings.map((l, idx) => ({ ...l, idx })).sort((a, b) => a.y - b.y);
  const rWalk = (2 / 3) * R;
  const doorW = o.doorWidth ?? RU.doorWidth;
  const hw = (doorW / 2 + RU.landingMargin) / R;         // door + margin, half arc (progress units)
  const dStar = TAU / perTurn, dMin = (RU.goingLimit * 1.045) / rWalk;
  const back = spiralBack(perTurn, rWalk, rn);               // extra landing beyond the far jamb, where the ramp rises
  const theta0 = s.startAngle ?? (L[0].angle !== undefined ? L[0].angle + dir * (hw + 0.15 / R) : 0);
  const toPsi = (a: number) => wrap(dir * (a - theta0));
  const rng = mulberry32(seed);
  const steps: SpiralStep[] = [];
  const landings: SpiralPlan['landings'] = new Array(L.length);

  // bottom landing: the floor in front of step 0, at least one door wide
  let entry0 = -2 * hw, door0 = -hw;
  if (L[0].angle !== undefined) { door0 = toPsi(L[0].angle); if (door0 > Math.PI) door0 -= TAU; entry0 = Math.min(entry0, door0 - hw); }
  landings[L[0].idx] = { y: L[0].y, psi: door0, angle: theta0 + dir * door0, step: -1, clear: 0 };

  let psi = 0;
  const problems: string[] = [];
  if (door0 + hw > 1e-6) problems.push('bottom door overlaps the first step (see spiralStartFor)');
  else if (door0 < -hw - 0.6) problems.push(`bottom door is ${(-door0).toFixed(2)} rad before the first step (see spiralStartFor)`);
  for (let k = 0; k + 1 < L.length; k++) {
    const dy = L[k + 1].y - L[k].y;
    if (dy < 0.05) { problems.push(`landings ${k} and ${k + 1} at the same height`); continue; }
    // choose the number of rises (0.17..0.198 m each) and, for a door at a fixed angle, how many
    // turns to the landing, so the goings come out near the target; what is left over lengthens the
    // landing in front of the door
    const nLo = risesFor(dy).n, nHi = Math.max(nLo, Math.floor(dy / 0.17));
    let n = nLo, centre = psi + (nLo - 1) * dStar + hw, slackBest = 0, cost = Infinity;
    for (let nn = nLo; nn <= nHi; nn++) {
      const mm = nn - 1, rr = dy / nn, riseCost = Math.abs(rr - 0.19) * 8;
      if (L[k + 1].angle === undefined) {
        const c0 = riseCost;
        if (c0 < cost) { cost = c0; n = nn; centre = psi + mm * dStar + hw; slackBest = 0; }
        continue;
      }
      const base = toPsi(L[k + 1].angle!);
      for (let j = 0; j < 40; j++) {
        const cc = base + TAU * j, gap = cc - hw - psi;
        if (gap < -1e-9) continue;
        // steepest uniform going that still clears the headroom a turn up
        // (a landing of span wL takes the room of several steps but only one rise)
        const wL = 2 * hw + back;
        const dHi = Math.max(dStar, (TAU - wL) / ((RU.headroom + rr + RU.waist + 0.06) / rr - 1));
        const d = mm > 0 ? Math.min(gap / mm, dHi) : 0;
        if (mm > 0 && d < dMin) continue;
        const slack = gap - mm * d;
        const c0 = slack * rWalk * 4 + mm * Math.abs(d - dStar) * rWalk * 0.5 + riseCost;
        if (c0 < cost) { cost = c0; n = nn; centre = cc; slackBest = slack; }
        if (slack > TAU) break;
      }
    }
    const rise = dy / n, m = n - 1;
    const front = centre - hw - slackBest;
    const dk = m > 0 ? (front - psi) / m : 0;
    // per-step going jitter that sums to zero inside the flight, so the landing stays where it is
    const eps = Array.from({ length: m }, () => range(rng, -0.03, 0.03));
    const mean = eps.reduce((a, b) => a + b, 0) / Math.max(1, m);
    for (let j = 0; j < m; j++) {
      const span = dk * (1 + eps[j] - mean);
      steps.push(mkStep(psi, psi + span, L[k].y + (j + 1) * rise + range(rng, -0.003, 0.003), -1));
      psi += span;
    }
    psi = front;
    steps.push(mkStep(front, centre + hw + back, L[k + 1].y, L[k + 1].idx));
    landings[L[k + 1].idx] = { y: L[k + 1].y, psi: centre, angle: theta0 + dir * centre, step: steps.length - 1, clear: 0 };
    psi = centre + hw + back;
  }

  function mkStep(a0: number, a1: number, y: number, landing: number): SpiralStep {
    const isL = landing >= 0;
    // draw every random number even for landings so later steps don't shift when a landing moves
    const wear = range(rng, 0.012, 0.036), wearF = range(rng, 0.52, 0.66), tilt = range(rng, -0.003, 0.003);
    const nosing = range(rng, 0.025, 0.045), soffitJit = range(rng, 0, 0.012), drumJit = range(rng, -0.003, 0.003);
    const uOff = rng(), vOff = rng();
    return { a0, a1, y, rise: 0, landing, solid: false, wear: isL ? 0 : wear, wearF, tilt: isL ? 0 : tilt, nosing, soffitJit, drumJit, uOff, vOff };
  }

  let prev = L[0].y, maxRise = 0;
  for (const st of steps) { st.rise = st.y - prev; prev = st.y; maxRise = Math.max(maxRise, st.rise); }
  const p: SpiralPlan = {
    kind: 'spiral', id: s.id, seed, c, R, rn, dir, theta0, yFloor: L[0].y, yTop: L[L.length - 1].y, rWalk,
    T: Math.max(maxRise, 0.12) + RU.waist, perTurn, entry: [entry0, 0], steps, landings, stats: emptyStats(),
  };
  if (!steps.length) { p.stats.problems.push('no steps'); p.stats.ok = false; return p; }
  // first-turn steps with no usable room under them are solid down to the floor
  let solid = true;
  for (const st of steps) {
    solid = solid && spiralNosingY(p, st.a1) - p.T + st.soffitJit < p.yFloor + RU.solidBelow;
    st.solid = solid;
  }
  // stats
  const S = p.stats;
  S.problems.push(...problems);
  S.steps = steps.length; S.perTurn = perTurn;
  for (const st of steps) {
    S.maxRise = Math.max(S.maxRise, st.rise); S.minRise = Math.min(S.minRise, st.rise);
    S.minGoing = Math.min(S.minGoing, (st.a1 - st.a0) * rWalk);
  }
  const ceil = o.ceiling ?? p.yTop + 2.4;
  const dpsi = 0.01 / rWalk;
  for (let q = entry0; q < steps[steps.length - 1].a1; q += dpsi) S.minHeadroom = Math.min(S.minHeadroom, spiralHeadroom(p, q, ceil));
  for (const l of landings) {
    if (!l) continue;
    let clear = Infinity;
    for (let q = l.psi - doorW / 2 / R; q <= l.psi + doorW / 2 / R; q += dpsi) clear = Math.min(clear, spiralHeadroom(p, q, ceil));
    l.clear = clear;
    const st = l.step >= 0 ? steps[l.step].y : p.yFloor;
    S.landingErr = Math.max(S.landingErr, Math.abs(st - l.y));
  }
  finish(S);
  return p;
}

/** Plan a spiral stair: picks the steps per turn from the radius, then adds steps per turn until the headroom holds. */
export function planSpiral(s: StairSpec, o: StairOpts = {}): SpiralPlan {
  const RU = STAIR_RULES, seed = seedFor(s, o);
  const R = s.radius ?? 1.2, rWalk = (2 / 3) * R;
  const ys = s.landings.map((l) => l.y).sort((a, b) => a - b);
  let riseAvg = 0, nr = 0;
  for (let k = 0; k + 1 < ys.length; k++) { const r = risesFor(ys[k + 1] - ys[k]); riseAvg += r.rise * r.n; nr += r.n; }
  riseAvg = nr ? riseAvg / nr : 0.19;
  const T = riseAvg + RU.waist;
  const nHead = Math.ceil((RU.headroom + T + 0.03) / riseAvg);
  const nGoing = Math.round((TAU * rWalk) / RU.goingTarget);
  const nMax = Math.floor((TAU * rWalk) / (RU.goingLimit * 1.05));
  let best: SpiralPlan | null = null;
  for (let n = Math.min(nMax, Math.max(nHead, nGoing)); n <= Math.max(nMax, nHead) + 2; n++) {
    const p = layoutSpiral(s, o, n, seed);
    if (!best || (!best.stats.ok && p.stats.minHeadroom > best.stats.minHeadroom)) best = p;
    if (p.stats.ok && p.stats.minHeadroom >= RU.headroom - 1e-9) { best = p; break; }
  }
  return best!;
}

// ---------------------------------------------------------------------------------------------
// straight plan

export function planStraight(s: StairSpec, o: StairOpts = {}): StraightPlan {
  const RU = STAIR_RULES;
  let A = s.start ?? [0, 0, 0], E = s.end ?? [0, 1, 1];
  if (E[1] < A[1]) [A, E] = [E, A];
  const dx = E[0] - A[0], dz = E[2] - A[2], run = Math.hypot(dx, dz) || 1e-6;
  const d: V2 = [dx / run, dz / run], side: V2 = [-d[1], d[0]];
  const mural = o.mural ?? !s.spaces.some((x) => x === 'courtyard' || x === 'outside');
  const ys = (s.landings.length >= 2 ? s.landings.map((l) => l.y) : [A[1], E[1]]).sort((a, b) => a - b);
  const seed = seedFor(s, o), rng = mulberry32(seed);
  const st = emptyStats();
  if (Math.abs(ys[0] - A[1]) > 0.01 || Math.abs(ys[ys.length - 1] - E[1]) > 0.01) st.problems.push('landings do not match start/end heights');
  const segs = ys.slice(1).map((y, k) => risesFor(y - ys[k]));
  const nRise = segs.reduce((a, b) => a + b.n, 0);
  const nMid = ys.length - 2, lMid = Math.max(0.9, s.width);
  const nTread = nRise - 1 - nMid;
  let g = nTread > 0 ? (run - nMid * lMid) / nTread : 0, lead = 0, tail = 0;
  if (g > 0.42) {
    // too long for the rise: flat floor at the ends (an open flight keeps it all at the top, it starts on the ground)
    g = 0.36; const extra = run - nMid * lMid - nTread * g;
    lead = mural ? extra / 2 : 0; tail = extra - lead;
  }
  const steps: StraightStep[] = [];
  let sc = lead, prev = ys[0];
  segs.forEach((sg, k) => {
    for (let j = 0; j < sg.n; j++) {
      const last = j === sg.n - 1, top = last && k === segs.length - 1;
      const y = last ? ys[k + 1] : ys[k] + (j + 1) * sg.rise + range(rng, -0.003, 0.003);
      const len = top ? tail : last ? lMid : g;
      const wear = range(rng, 0.006, 0.026), wearF = range(rng, 0.4, 0.6), tilt = range(rng, -0.003, 0.003), nosing = range(rng, 0.025, 0.04);
      const isL = last;
      steps.push({ s0: sc, s1: top ? run : sc + len, y, rise: y - prev, landing: isL ? k + 1 : -1, wear: isL ? 0 : wear, wearF, tilt: isL ? 0 : tilt, nosing, uOff: rng(), vOff: rng() });
      prev = y; sc += len;
    }
  });
  // stepped lintels over pairs of treads (mural only)
  const ceiling: StraightPlan['ceiling'] = [];
  if (mural) {
    const pieces = [{ s0: 0, s1: lead, y: ys[0] }, ...steps.map((x) => ({ s0: x.s0 - x.nosing, s1: Math.max(x.s1, x.s0), y: x.y }))].filter((x) => x.s1 - x.s0 > 1e-3);
    for (let i = 0; i < pieces.length; i += 2) {
      const grp = pieces.slice(i, i + 2);
      ceiling.push({ s0: grp[0].s0, s1: grp[grp.length - 1].s1, y: Math.max(...grp.map((x) => x.y)) + RU.muralClear });
    }
    // each lintel steps up a little before the riser, so the nosing under it keeps its headroom
    for (let i = 1; i < ceiling.length; i++) { ceiling[i].s0 -= 0.08; ceiling[i - 1].s1 = ceiling[i].s0; }
    if (ceiling.length) { ceiling[0].s0 = 0; ceiling[ceiling.length - 1].s1 = run; }
  }
  const p: StraightPlan = { kind: 'straight', id: s.id, seed, o: A, d, side, run, width: s.width, mural, yFloor: ys[0], yTop: ys[ys.length - 1], lead, steps, ceiling, stats: st };
  st.steps = steps.length;
  for (let i = 0; i < steps.length; i++) {
    const x = steps[i];
    st.maxRise = Math.max(st.maxRise, x.rise); st.minRise = Math.min(st.minRise, x.rise);
    if (i < steps.length - 1) st.minGoing = Math.min(st.minGoing, x.s1 - x.s0);
  }
  if (mural) {
    const floors = [{ s0: 0, s1: lead, y: ys[0] }, ...steps.map((x) => ({ s0: x.s0 - x.nosing, s1: x.s1, y: x.y }))];
    for (const cl of ceiling) for (const x of floors) {
      if (x.s1 <= cl.s0 + 1e-6 || x.s0 >= cl.s1 - 1e-6) continue;
      st.minHeadroom = Math.min(st.minHeadroom, cl.y - x.y);
    }
  }
  for (const l of s.landings) {
    let best = Infinity;
    for (const y of [ys[0], ...steps.filter((x) => x.landing >= 0).map((x) => x.y)]) best = Math.min(best, Math.abs(y - l.y));
    st.landingErr = Math.max(st.landingErr, best);
  }
  finish(st);
  return p;
}

export function planStair(s: StairSpec, o: StairOpts = {}): StairPlan {
  return s.kind === 'spiral' ? planSpiral(s, o) : planStraight(s, o);
}

export const isPlan = (x: StairSpec | StairPlan): x is StairPlan => 'stats' in x;
export const toPlan = (x: StairSpec | StairPlan, o: StairOpts) => (isPlan(x) ? x : planStair(x, o));

/** Seed for a plan: one draw from the injected rng, or the world seed hashed with the stair id. */
function seedFor(s: StairSpec, o: StairOpts) {
  return o.rng ? Math.floor(o.rng() * 4294967296) >>> 0 : hashSeed(`stair:${s.id}`);
}

/** How far ahead of a riser line the ramp starts to rise: clears the nosing everywhere the capsule can stand (r >= 0.3). */
const nosingShift = (rn: number) => Math.atan(0.045 / Math.max(rn, 0.3));

/** Extra flat landing beyond a door's far jamb: room for the ramp to rise at <= 30° on the walking line. */
function spiralBack(perTurn: number, rWalk: number, rn: number) {
  return Math.max(0.6 * (TAU / perTurn), 0.2 / Math.tan(Math.PI / 6) / rWalk + nosingShift(rn));
}

/**
 * Door angles where the landings fall when the stair is free to choose (keeps startAngle and the
 * bottom door). A shell that takes its upper door angles from here always gets a valid stair; any
 * other fixed angle costs going or headroom and may be reported in stats.problems.
 */
export function spiralLandingAngles(s: StairSpec, o: StairOpts = {}): number[] {
  const free = { ...s, landings: s.landings.map((l, k) => (k === 0 ? l : { ...l, angle: undefined })) };
  return planSpiral(free, o).landings.map((l) => l.angle);
}

/**
 * startAngle that puts the first step just past a bottom door at `doorAngle`, for a shell that
 * places the bottom door first.
 */
export function spiralStartFor(doorAngle: number, radius: number, turn: 1 | -1 = -1, doorWidth = STAIR_RULES.doorWidth) {
  return doorAngle + -turn * ((doorWidth / 2 + STAIR_RULES.landingMargin) / radius + 0.15 / radius);
}

/** Plan-level validation: rises, goings at the walking line, headroom, landing heights. */
export function validateStair(s: StairSpec | StairPlan, o: StairOpts = {}): StairStats {
  return toPlan(s, o).stats;
}

// ---------------------------------------------------------------------------------------------
// geometry

/** Append a stair's geometry to the Builder bins. Returns its plan (angles, landings, stats). */
export function buildStair(B: StairSink, s: StairSpec | StairPlan, o: StairOpts = {}): StairPlan {
  const p = toPlan(s, o);
  if (!p.steps.length) return p;
  if (p.kind === 'spiral') buildSpiral(B, p, o); else buildStraight(B, p, o);
  return p;
}

const F_SPIRAL = [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1];

function buildSpiral(B: StairSink, p: SpiralPlan, o: StairOpts) {
  const RU = STAIR_RULES;
  const M = { step: 'trim' as MatKey, wall: 'old' as MatKey, rope: 'wood' as MatKey, iron: 'iron' as MatKey, ...o.mat };
  const T = TILE[M.step], { c, dir, steps } = p;
  const th = (psi: number) => p.theta0 + dir * psi;
  const P = (r: number, a: number, y: number): V3 => [c[0] + Math.cos(a) * r, y, c[1] + Math.sin(a) * r];
  const trav = (a: number): V3 => [-Math.sin(a) * dir, 0, Math.cos(a) * dir];
  const rIn = p.rn - 0.03;
  const rOut = (a: number) => (o.drumPoly ? rayPoly(c, a, o.drumPoly) : p.R) + RU.embed;
  const rad = (a: number, f: number) => rIn + (rOut(a) - rIn) * f;
  const ceil = o.ceiling ?? p.yTop + 2.4;
  const F = F_SPIRAL;
  const h = (st: SpiralStep, f: number, t: number) => st.y - st.wear * wearAlong(t) * wearAcross(f, st.wearF, 0.26) + st.tilt * (f - 0.5);
  const DOWN: V3 = [0, -1, 0], UP: V3 = [0, 1, 0];

  steps.forEach((st, i) => {
    const span = st.a1 - st.a0, a0 = th(st.a0), a1 = th(st.a1);
    const nRows = st.landing >= 0 ? Math.max(4, Math.ceil((span * p.R) / 0.22)) : 3;
    const ts = st.landing >= 0 ? Array.from({ length: nRows + 1 }, (_, j) => j / nRows) : [0.15, 0.42, 0.72, 1];
    const tr = trav(a0);
    // nosing edge: the riser line pushed forward over the step below
    const nose = (f: number, y: number): V3 => add3(P(rad(a0, f), a0, y), mul3(tr, -st.nosing));
    const uvXZ = (q: V3): UV => [q[0] / T + st.uOff, q[2] / T + st.vOff];

    // tread
    {
      const Pp: V3[][] = [F.map((f) => nose(f, h(st, f, 0)))];
      for (const t of ts) { const a = th(st.a0 + span * t); Pp.push(F.map((f) => P(rad(a, f), a, h(st, f, t)))); }
      surface(B, M.step, Pp, Pp.map((r) => r.map(uvXZ)), UP);
    }
    // nosing front and underside
    const yl = st.y - RU.lip;
    {
      const top = F.map((f) => nose(f, h(st, f, 0))), bot = F.map((f) => nose(f, yl));
      const uv = (q: V3, f: number): UV => [(rad(a0, f)) / T + st.uOff, q[1] / T];
      surface(B, M.step, [bot, top], [bot.map((q, k) => uv(q, F[k])), top.map((q, k) => uv(q, F[k]))], mul3(tr, -1));
      const back = F.map((f) => P(rad(a0, f), a0, yl));
      surface(B, M.step, [bot, back], [bot.map(uvXZ), back.map(uvXZ)], DOWN);
    }
    // riser, from the tread below (or the floor) up under the nosing
    {
      const pr = i > 0 ? steps[i - 1] : null;
      const bot = F.map((f) => P(rad(a0, f), a0, pr ? h(pr, f, 1) : p.yFloor - 0.004));
      const top = F.map((f) => P(rad(a0, f), a0, yl));
      const uv = (q: V3, f: number): UV => [rad(a0, f) / T + st.uOff, q[1] / T];
      surface(B, M.step, [bot, top], [bot.map((q, k) => uv(q, F[k])), top.map((q, k) => uv(q, F[k]))], mul3(tr, -1));
    }
    if (!st.solid) {
      // helical soffit
      const nS = st.landing >= 0 ? nRows : 3;
      const Pp: V3[][] = [], U: UV[][] = [];
      for (let j = 0; j <= nS; j++) {
        const q = st.a0 + (span * j) / nS, a = th(q), y = spiralNosingY(p, q) - p.T + st.soffitJit;
        Pp.push(F.map((f) => P(rad(a, f), a, y)));
        U.push(F.map((f) => [rad(a, f) / T + st.uOff, (q * (p.R * 0.6)) / T + st.vOff] as UV));
      }
      surface(B, M.step, Pp, U, DOWN);
      // joint with the step below where their soffits differ
      const pr = i > 0 ? steps[i - 1] : null;
      if (pr && !pr.solid && Math.abs(pr.soffitJit - st.soffitJit) > 5e-4) {
        const yb = spiralNosingY(p, st.a0) - p.T;
        const r0 = F.map((f) => P(rad(a0, f), a0, yb + pr.soffitJit)), r1 = F.map((f) => P(rad(a0, f), a0, yb + st.soffitJit));
        const uv = (q: V3, f: number): UV => [rad(a0, f) / T, q[1] / T];
        surface(B, M.step, [r0, r1], [r0.map((q, k) => uv(q, F[k])), r1.map((q, k) => uv(q, F[k]))], st.soffitJit > pr.soffitJit ? tr : mul3(tr, -1));
      }
    } else if (i + 1 < steps.length && !steps[i + 1].solid) {
      // back face of the solid run, from the floor up to the first soffit
      const nx = steps[i + 1], yt = spiralNosingY(p, st.a1) - p.T + nx.soffitJit;
      const r0 = F.map((f) => P(rad(a1, f), a1, p.yFloor - 0.004)), r1 = F.map((f) => P(rad(a1, f), a1, yt));
      const uv = (q: V3, f: number): UV => [rad(a1, f) / T, q[1] / T];
      surface(B, M.step, [r0, r1], [r0.map((q, k) => uv(q, F[k])), r1.map((q, k) => uv(q, F[k]))], trav(a1));
    }
    // newel drum belonging to this step
    const yb = i > 0 ? steps[i - 1].y : p.yFloor - 0.02;
    band(B, M.step, c, p.rn + st.drumJit, yb, st.y, 18, false, st.uOff, st.vOff);
  });

  // newel above the top landing, in drum-sized courses, up to the ceiling
  {
    const last = steps[steps.length - 1], rng = mulberry32(p.seed ^ 0x5bd1e995);
    const n = Math.max(1, Math.round((ceil - last.y) / Math.max(0.15, last.rise)));
    for (let k = 0; k < n; k++) {
      const y0 = last.y + ((ceil - last.y) * k) / n, y1 = last.y + ((ceil - last.y) * (k + 1)) / n;
      band(B, M.step, c, p.rn + range(rng, -0.003, 0.003), y0, y1, 18, false, rng(), rng());
    }
    if (!o.ceilingDisc) annulus(B, M.step, c, 0.001, () => p.rn, ceil, true, 18);
  }
  if (o.bottomFloor ?? true) annulus(B, M.step, c, rIn, rOut, p.yFloor - 0.004, true);
  if (o.ceilingDisc) annulus(B, M.step, c, rIn, rOut, ceil, false);

  // wall closing the stairwell behind the top landing
  if (o.topWall ?? true) {
    const last = steps[steps.length - 1], a = th(last.a1);
    const yb = spiralNosingY(p, last.a1) - p.T + last.soffitJit;
    const r0 = F.map((f) => P(rad(a, f), a, yb)), r1 = F.map((f) => P(rad(a, f), a, ceil + 0.01));
    const uv = (q: V3, f: number): UV => [rad(a, f) / TILE[M.wall], q[1] / TILE[M.wall]];
    const U = [r0.map((q, k) => uv(q, F[k])), r1.map((q, k) => uv(q, F[k]))];
    surface(B, M.wall, [r0, r1], U, trav(a));
    surface(B, M.wall, [r0, r1], U, mul3(trav(a), -1));
  }

  // inner drum skin with door gaps
  const doorW = o.doorWidth ?? RU.doorWidth, doorH = o.doorHeight ?? RU.doorHeight;
  if (o.skin && !o.drumPoly) {
    const openings: DrumOpening[] = p.landings.filter(Boolean).map((l) => ({ angle: l.angle, width: doorW, y0: l.y - 0.01, y1: l.y + doorH }));
    drumWall(B, M.wall, c, p.R + 0.02, p.yFloor - 0.05, ceil + 0.05, [...openings, ...(o.skinOpenings ?? [])], true);
  }

  // rope handrail on iron staples, broken at the doors
  if (o.handrail ?? !o.drumPoly) {
    const rr = p.R - 0.075, last = steps[steps.length - 1];
    const gaps = p.landings.filter(Boolean).map((l) => [l.psi - (doorW / 2 + 0.12) / p.R, l.psi + (doorW / 2 + 0.12) / p.R] as [number, number]);
    let pieces: [number, number][] = [[steps[0].a0 + 0.35 / p.R, last.a1 - 0.25 / p.R]];
    for (const [g0, g1] of gaps) pieces = pieces.flatMap(([a, b]): [number, number][] => (g1 <= a || g0 >= b ? [[a, b]] : [...(g0 > a ? [[a, g0]] as [number, number][] : []), ...(g1 < b ? [[g1, b]] as [number, number][] : [])]));
    const railY = (q: number) => spiralNosingY(p, q) + 0.88;
    for (const [a, b] of pieces) {
      const lenPath = (b - a) * rr;
      if (lenPath < 0.5) continue;
      const nSpan = Math.max(1, Math.ceil(lenPath / 1.35));
      const path: V3[] = [];
      for (let k = 0; k < nSpan; k++) {
        const qa = a + ((b - a) * k) / nSpan, qb = a + ((b - a) * (k + 1)) / nSpan;
        const sub = Math.max(3, Math.ceil(((qb - qa) * rr) / 0.22));
        for (let j = k === 0 ? 0 : 1; j <= sub; j++) {
          const u = j / sub, q = qa + (qb - qa) * u;
          path.push(P(rr, th(q), railY(q) - 0.035 * 4 * u * (1 - u)));
        }
        // staple at qa (and at the far end of the last span)
        for (const qs of k === nSpan - 1 ? [qa, qb] : [qa]) {
          const as = th(qs), mid = (p.R + 0.03 + rr) / 2;
          B.box(M.iron, P(mid, as, railY(qs) - 0.01), [p.R + 0.05 - rr, 0.022, 0.022], [Math.cos(as), Math.sin(as)]);
        }
      }
      rope(B, M.rope, path, 0.017);
    }
  }
}

/** A tube along a polyline (6 sides). */
function rope(B: StairSink, mat: MatKey, path: V3[], r: number) {
  const SIDES = 6, T = TILE[mat], P: V3[][] = [], U: UV[][] = [], Nh: V3[][] = [];
  let acc = 0;
  for (let k = 0; k < path.length; k++) {
    const tg = norm3(sub3(path[Math.min(k + 1, path.length - 1)], path[Math.max(k - 1, 0)]));
    let nx = cross3(tg, [0, 1, 0]); if (len3(nx) < 1e-6) nx = [1, 0, 0]; nx = norm3(nx);
    const ny = norm3(cross3(nx, tg));
    if (k) acc += len3(sub3(path[k], path[k - 1]));
    const row: V3[] = [], urow: UV[] = [], nrow: V3[] = [];
    for (let s = 0; s <= SIDES; s++) {
      const a = (TAU * s) / SIDES, off = add3(mul3(nx, Math.cos(a)), mul3(ny, Math.sin(a)));
      row.push(add3(path[k], mul3(off, r))); urow.push([(acc * 1.5 + s / SIDES * 0.05) / T, acc / T]); nrow.push(off);
    }
    P.push(row); U.push(urow); Nh.push(nrow);
  }
  surface(B, mat, P, U, (j, k) => Nh[j][k]);
}

const F_STRAIGHT = [0, 0.12, 0.3, 0.5, 0.7, 0.88, 1];

function buildStraight(B: StairSink, p: StraightPlan, o: StairOpts) {
  const RU = STAIR_RULES;
  const M = { step: 'trim' as MatKey, wall: 'old' as MatKey, ...o.mat };
  const T = TILE[M.step], { d, side, o: A, steps } = p;
  const W = p.width + (p.mural ? 2 * RU.embed : 0);
  const P = (s: number, f: number, y: number): V3 => {
    const v = (f - 0.5) * W;
    return [A[0] + d[0] * s + side[0] * v, y, A[2] + d[1] * s + side[1] * v];
  };
  const fwd: V3 = [d[0], 0, d[1]], back: V3 = [-d[0], 0, -d[1]], UP: V3 = [0, 1, 0], DOWN: V3 = [0, -1, 0];
  const yBase = p.mural ? p.yFloor - 0.05 : p.yFloor - 0.25;
  const F = F_STRAIGHT;
  const h = (st: StraightStep, f: number, t: number) => st.y - st.wear * wearAlong(t) * wearAcross(f, st.wearF, 0.22) + st.tilt * (f - 0.5);
  const uvSF = (st: StraightStep) => (q: V3): UV => [q[0] / T + st.uOff, q[2] / T + st.vOff];

  steps.forEach((st, i) => {
    const len = st.s1 - st.s0;
    const pr = i > 0 ? steps[i - 1] : null;
    const yl = st.y - RU.lip;
    const uvW = (q: V3, f: number): UV => [(f * W) / T + st.uOff, q[1] / T];
    const sN = st.s0 - st.nosing;
    if (len > 1e-3) {
      const nL = Math.max(2, Math.ceil(len / 0.3));
      const ts = st.landing >= 0 ? Array.from({ length: nL + 1 }, (_, j) => j / nL) : [0, 0.25, 0.55, 1];
      const rows: V3[][] = [F.map((f) => P(sN, f, h(st, f, 0)))];
      for (const t of ts) rows.push(F.map((f) => P(st.s0 + len * t, f, h(st, f, t))));
      surface(B, M.step, rows, rows.map((r) => r.map(uvSF(st))), UP);
      // nosing front + underside
      const top = rows[0], bot = F.map((f) => P(sN, f, yl)), under = F.map((f) => P(st.s0, f, yl));
      surface(B, M.step, [bot, top], [bot.map((q, k) => uvW(q, F[k])), top.map((q, k) => uvW(q, F[k]))], back);
      surface(B, M.step, [bot, under], [bot.map(uvSF(st)), under.map(uvSF(st))], DOWN);
      // side faces (open flights; a mural stair's sides are inside the passage walls)
      if (!p.mural) {
        for (const [f, n] of [[0, mul3([side[0], 0, side[1]], -1)], [1, [side[0], 0, side[1]] as V3]] as const) {
          const edge = rows.map((r) => r[f === 0 ? 0 : F.length - 1]);
          // nose part: from under the nosing up to the tread
          const pts: V3[][] = [[P(sN, f, yl), P(st.s0, f, yl)], [edge[0], edge[1]]];
          surface(B, M.step, pts, pts.map((r) => r.map((q) => [len3(sub3(q, P(0, f, 0))) / T, q[1] / T] as UV)), n);
          const lower = edge.slice(1).map((q) => [q[0], yBase, q[2]] as V3), upper = edge.slice(1);
          const prof = [lower, upper];
          surface(B, M.step, prof, prof.map((r) => r.map((q) => [len3(sub3([q[0], 0, q[2]], P(0, f, 0))) / T, q[1] / T] as UV)), n);
        }
      }
    }
    // riser
    {
      const bot = F.map((f) => P(st.s0, f, pr ? h(pr, f, 1) : p.yFloor - 0.004)), top = F.map((f) => P(st.s0, f, len > 1e-3 ? yl : st.y));
      surface(B, M.step, [bot, top], [bot.map((q, k) => uvW(q, F[k])), top.map((q, k) => uvW(q, F[k]))], back);
      if (!pr && !p.mural) {
        // first riser of an open flight runs down into the ground
        const g0 = F.map((f) => P(st.s0, f, yBase));
        surface(B, M.step, [g0, bot], [g0.map((q, k) => uvW(q, F[k])), bot.map((q, k) => uvW(q, F[k]))], back);
      }
    }
    if (len > 1e-3 && i === steps.length - 1 && !p.mural) {
      const b0 = F.map((f) => P(st.s1, f, yBase)), b1 = F.map((f) => P(st.s1, f, st.y));
      surface(B, M.step, [b0, b1], [b0.map((q, k) => uvW(q, F[k])), b1.map((q, k) => uvW(q, F[k]))], fwd);
    }
  });

  if (p.mural) {
    // floor in front of the first riser
    if (p.lead > 1e-3) {
      const r0 = F.map((f) => P(0, f, p.yFloor)), r1 = F.map((f) => P(p.lead, f, p.yFloor));
      surface(B, M.step, [r0, r1], [r0, r1].map((r) => r.map((q) => [q[0] / T, q[2] / T] as UV)), UP);
    }
    // stepped lintels: undersides and the risers between them
    const TW = TILE[M.step];
    p.ceiling.forEach((cl, k) => {
      const r0 = F.map((f) => P(cl.s0, f, cl.y)), r1 = F.map((f) => P(cl.s1, f, cl.y));
      surface(B, M.step, [r0, r1], [r0, r1].map((r) => r.map((q) => [q[0] / TW + k * 0.37, q[2] / TW] as UV)), DOWN);
      const nx = p.ceiling[k + 1];
      if (nx) {
        const a = F.map((f) => P(cl.s1, f, cl.y)), b = F.map((f) => P(cl.s1, f, nx.y));
        surface(B, M.step, [a, b], [a, b].map((r) => r.map((q, j) => [(F[j] * W) / TW, q[1] / TW] as UV)), back);
      }
    });
    // passage walls, from below the treads up past the lintels
    for (const sgn of [-1, 1]) {
      const off = (sgn * p.width) / 2;
      const o3: V3 = [A[0] + side[0] * off, 0, A[2] + side[1] * off];
      const frame = { o: o3, r: fwd, u: UP, n: [-side[0] * sgn, 0, -side[1] * sgn] as V3 };
      const pts: V2[] = [[0, yBase], [p.run, yBase]];
      for (let k = p.ceiling.length - 1; k >= 0; k--) { const cl = p.ceiling[k]; pts.push([cl.s1, cl.y + 0.04], [cl.s0, cl.y + 0.04]); }
      const clean = pts.filter((q, k) => k === 0 || Math.hypot(q[0] - pts[k - 1][0], q[1] - pts[k - 1][1]) > 1e-4);
      B.planar(M.wall, frame, clean);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// collision ramp

/**
 * An invisible smooth walking surface for the stair (world space, non-indexed, normals up).
 *
 * Spiral: a helicoid through the front edge of every nosing, flat over each landing until just
 * before the next nosing, starting from the floor one going in front of the first step. Straight:
 * the same idea along the flight. It lies on or above every tread (+4 mm), never below, so it can be
 * added to the physics world *in addition to* the render triangles: the capsule rides the ramp over
 * the steps, while the newel, drum and walls still collide as rendered.
 *
 * Recommendation to the physics agent: add this ramp next to the render-triangle collider. The steps
 * alone also work (closed risers, rise <= 0.21 m < autostep 0.3, snap-to-ground 0.4 handles the way
 * down), but they make the camera stutter on every step, worst going down. The ramp is steeper than
 * 50° within about 0.65 m of the axis on wide stairs; the capsule (r 0.3) can only get there hugging
 * the newel, where it then falls back on autostep.
 */
export function stairCollisionRamp(s: StairSpec | StairPlan, o: StairOpts = {}): THREE.BufferGeometry | null {
  const p = toPlan(s, o);
  if (!p.steps.length) return null;
  const pos: number[] = [];
  const quad = (a: V3, b: V3, c: V3, d: V3) => {
    for (const t of [[a, b, c], [a, c, d]]) {
      const fn = cross3(sub3(t[1], t[0]), sub3(t[2], t[0]));
      if (len3(fn) < 1e-9) continue;
      if (fn[1] < 0) pos.push(...t[0], ...t[2], ...t[1]); else pos.push(...t[0], ...t[1], ...t[2]);
    }
  };
  const LIFT = 0.004;
  if (p.kind === 'spiral') {
    const { c, dir, steps } = p;
    const back = spiralBack(p.perTurn, p.rWalk, p.rn), sh = nosingShift(p.rn);
    // a true helicoid (same control angles at every radius), so its lines run straight from newel to drum
    const nr = Math.max(2, Math.ceil((p.R - p.rn) / 0.3));
    const rs = Array.from({ length: nr + 1 }, (_, k) => p.rn + ((p.R - p.rn) * k) / nr);
    const ctrl: [number, number][] = [[steps[0].a0 - sh - (steps[0].a1 - steps[0].a0), p.yFloor]];
    steps.forEach((st, i) => {
      ctrl.push([st.a0 - sh, st.y + LIFT]);
      if (st.landing >= 0) ctrl.push([i === steps.length - 1 ? st.a1 : st.a1 - back, st.y + LIFT]);
    });
    const C = rs.map(() => ctrl);
    const P = (r: number, q: number, y: number): V3 => { const a = p.theta0 + dir * q; return [c[0] + Math.cos(a) * r, y, c[1] + Math.sin(a) * r]; };
    for (let k = 0; k + 1 < C[0].length; k++) {
      const spanQ = Math.max(...C.map((cc) => cc[k + 1][0] - cc[k][0]));
      const sub = Math.max(1, Math.ceil(spanQ / 0.1));
      for (let j = 0; j < sub; j++) {
        const at = (ri: number, u: number): V3 => {
          const [q0, y0] = C[ri][k], [q1, y1] = C[ri][k + 1];
          return P(rs[ri], q0 + (q1 - q0) * u, y0 + (y1 - y0) * u);
        };
        for (let ri = 0; ri + 1 < rs.length; ri++) quad(at(ri, j / sub), at(ri + 1, j / sub), at(ri + 1, (j + 1) / sub), at(ri, (j + 1) / sub));
      }
    }
  } else {
    const { d, side, o: A, steps } = p;
    const P = (s: number, v: number, y: number): V3 => [A[0] + d[0] * s + side[0] * v, y, A[2] + d[1] * s + side[1] * v];
    const pts: [number, number][] = [[Math.max(0, steps[0].s0 - (steps[0].s1 - steps[0].s0) - steps[0].nosing), p.yFloor]];
    steps.forEach((st, i) => {
      pts.push([st.s0 - st.nosing, st.y + LIFT]);
      if (st.landing >= 0) pts.push([i === steps.length - 1 ? Math.max(st.s1, st.s0) : st.s1 - 0.6 * (steps[i + 1].s1 - steps[i + 1].s0), st.y + LIFT]);
    });
    const w = p.width / 2;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [s0, y0] = pts[k], [s1, y1] = pts[k + 1];
      if (s1 - s0 < 1e-4) continue;
      quad(P(s0, -w, y0), P(s0, w, y0), P(s1, w, y1), P(s1, -w, y1));
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

// ---------------------------------------------------------------------------------------------
// navigation

/**
 * Walking-line polyline for NPCs, bottom landing to top landing (world space, foot height).
 * Spiral: on the walking line (2/3 of the radius), starting at the bottom door, through the front
 * edge of every nosing, and through each landing's door centre, ending at the top door. Straight:
 * the centre line from start to end. The line lies on the treads or up to one rise above them
 * (never below), so a character snapping to the ground follows it smoothly. Each landing is a vertex
 * at exactly its landing height, so a nav graph can link landings through it.
 */
export function stairNavPath(s: StairSpec | StairPlan, o: StairOpts = {}): V3[] {
  const p = toPlan(s, o);
  if (!p.steps.length) return [];
  const pts: [number, number][] = []; // (progress or distance along, y)
  if (p.kind === 'spiral') {
    const r = p.rWalk, back = spiralBack(p.perTurn, r, p.rn), steps = p.steps;
    const shift = (st: SpiralStep) => Math.atan(st.nosing / r);
    const first = steps[0], door0 = p.landings.find((l) => l && l.step === -1)!;
    const foot = first.a0 - shift(first) - (first.a1 - first.a0);
    pts.push([Math.min(door0.psi, foot), p.yFloor]);
    if (door0.psi < foot - 1e-6) pts.push([foot, p.yFloor]);
    steps.forEach((st, i) => {
      pts.push([st.a0 - shift(st), st.y]);
      if (st.landing < 0) return;
      const l = p.landings.find((x) => x && x.step === i)!;
      pts.push([l.psi, st.y]);
      if (i < steps.length - 1) pts.push([st.a1 - back, st.y]);
    });
    const out: V3[] = [];
    for (let k = 0; k < pts.length; k++) {
      const [q1, y1] = pts[k];
      const [q0, y0] = k ? pts[k - 1] : pts[k];
      const n = k ? Math.max(1, Math.ceil((q1 - q0) / 0.12)) : 1;
      for (let j = k ? 1 : 0; j <= n; j++) {
        const q = q0 + ((q1 - q0) * j) / n, y = y0 + ((y1 - y0) * j) / n, a = spiralTheta(p, q);
        out.push([p.c[0] + Math.cos(a) * r, y, p.c[1] + Math.sin(a) * r]);
      }
    }
    return out;
  }
  const steps = p.steps, f = steps[0];
  // start on the bottom floor just in front of the first nosing (the passage floor if there is a lead-in)
  pts.push([p.lead > 1e-3 ? 0 : f.s0 - f.nosing - 0.3, p.yFloor]);
  steps.forEach((st, i) => {
    pts.push([st.s0 - st.nosing, st.y]);
    if (st.landing < 0) return;
    if (i === steps.length - 1) { pts.push([Math.max(st.s1, st.s0), st.y]); return; }
    pts.push([(st.s0 + st.s1) / 2, st.y], [st.s1 - 0.6 * (steps[i + 1].s1 - steps[i + 1].s0), st.y]);
  });
  return pts.filter((q, k) => k === 0 || q[0] - pts[k - 1][0] > 1e-4).map(([sc, y]) => [p.o[0] + p.d[0] * sc, y, p.o[2] + p.d[1] * sc]);
}
