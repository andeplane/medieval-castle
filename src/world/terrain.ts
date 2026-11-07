// Seeded terrain (game-world-generation): one height function used by the meshes, the walk camera and
// tree placement. The island (the only playable ground) and the moat come from castle/layout.ts. Around
// them: a natural earth bank with exposed soil at the waterline, a field patchwork with hedgerows and
// lanes over low drumlins, a stream running down to the lake, and eroded mountain massifs to the north
// and west. Pipeline (keep the order): analytic fields → relief grid with droplet + thermal erosion →
// stream carved down to the lake → meshes (near grid, polar far mesh, stream corridor) + masks.
//
// Dependencies come in through `createTerrain(deps)` (noise and rng from deps.ts), so tests can pass
// simple fakes. Module scope holds only constants derived from the castle layout; everything seeded or
// cached lives in a terrain's context. `defaultTerrain()` is the game's instance, created on first use.
import * as THREE from 'three/webgpu';
import { WORLD_SEED } from '../core/rng';
import { type V2, pointInPoly, edgeDist, smoothstep, clamp, add, scale, norm } from '../core/math2d';
import { GROUND, MOAT, STAIR_TOWER } from '../castle/spec';
import { islandOutline, moatOuter, footprints, courtyard, castleCentre, gatehouseFrame, stairTowerCentre } from '../castle/layout';
import { offsetPoly } from '../castle/builder';
import { fieldLayout, fieldIndexAt, segDist, LANE_HALF, CROPS, FIELD_EXTENT, type Crop, type FieldLayout } from './fields';
import { buildRocks } from './rocks';
import { makeRelief0, erodeRelief, RN, RX0, RZ0, RSIZE, RCELL } from './relief';
import { seededDeps, type GenDeps, type Noise2D } from './deps';

const fbm = (f: Noise2D, x: number, z: number, o: number, lac = 2.03, g = 0.5) => { let s = 0, a = 1, fr = 1, n = 0; for (let i = 0; i < o; i++) { s += a * f(x * fr, z * fr); n += a; a *= g; fr *= lac; } return s / n; };
const smin = (a: number, b: number, k: number) => { const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1); return b + (a - b) * h - k * h * (1 - h); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const hyp = (a: number, b: number, c = 0) => Math.sqrt(a * a + b * b + c * c);

export const ISLAND = islandOutline();
export const MOAT_OUTER = moatOuter(ISLAND);
const FOOT = footprints();
const COURT = courtyard();
/** Ground under the courtyard paving (castle/paving.ts, top at GROUND + 0.02): low enough that the paving's
 *  parallax joints (4.5 cm deep, written to depth) never meet it. */
export const COURT_BED = GROUND - 0.15;
const CC = castleCentre();
const GATE = gatehouseFrame();

/** Exact distance to a closed outline, accelerated by a grid of candidate segments per 4 m cell. */
export class OutlineField {
  private cand: Uint16Array[] = [];
  private state: Int8Array;
  private n: number;
  constructor(private poly: V2[], private ext: number, private cell = 4) {
    const n = (this.n = Math.ceil((2 * ext) / cell)), hd = cell * Math.SQRT1_2;
    this.state = new Int8Array(n * n);
    const segs = poly.length, d = new Float64Array(segs);
    for (let j = 0; j < n; j++) {
      // scanline crossings for the inside test of this row of cell centres
      const z = -ext + (j + 0.5) * cell, xs: number[] = [];
      for (let k = 0; k < segs; k++) { const a = poly[k], b = poly[(k + 1) % segs]; if ((a[1] > z) !== (b[1] > z)) xs.push(a[0] + ((z - a[1]) * (b[0] - a[0])) / (b[1] - a[1])); }
      for (let i = 0; i < n; i++) {
        const x = -ext + (i + 0.5) * cell;
        let dmin = Infinity;
        for (let k = 0; k < segs; k++) { d[k] = segDist(x, z, poly[k], poly[(k + 1) % segs]); if (d[k] < dmin) dmin = d[k]; }
        const list: number[] = [];
        for (let k = 0; k < segs; k++) if (d[k] <= dmin + 2 * hd) list.push(k);
        this.cand.push(Uint16Array.from(list));
        let cross = 0; for (const xc of xs) if (x < xc) cross++;
        this.state[j * n + i] = dmin > hd ? (cross & 1 ? 1 : -1) : 0;
      }
    }
  }
  /** Signed distance to the outline: negative inside, positive outside (no allocation on this hot path). */
  signed(x: number, z: number): number {
    const n = this.n, i = Math.floor((x + this.ext) / this.cell), j = Math.floor((z + this.ext) / this.cell);
    if (i < 0 || j < 0 || i >= n || j >= n) { const d = edgeDist(this.poly, x, z).d; return pointInPoly(this.poly, x, z) ? -d : d; }
    const c = this.cand[j * n + i], segs = this.poly.length;
    let d = Infinity;
    for (let k = 0; k < c.length; k++) d = Math.min(d, segDist(x, z, this.poly[c[k]], this.poly[(c[k] + 1) % segs]));
    const st = this.state[j * n + i];
    return (st === 0 ? pointInPoly(this.poly, x, z) : st > 0) ? -d : d;
  }
}
const ISL_F = new OutlineField(ISLAND, 160);
const MOAT_F = new OutlineField(MOAT_OUTER, 330);
// moat outer radius by angle, for the cheap distance far out
const MOAT_R = new Float32Array(721);
for (let k = 0; k <= 720; k++) {
  const th = (k / 720) * 2 * Math.PI - Math.PI, dx = Math.cos(th), dz = Math.sin(th);
  let t = 40; while (t < 300 && MOAT_F.signed(dx * t, dz * t) < 0) t += 0.5;
  MOAT_R[k] = t;
}
const moatRadius = (x: number, z: number) => { const f = ((Math.atan2(z, x) + Math.PI) / (2 * Math.PI)) * 720, k = Math.floor(f), t = f - k; return lerp(MOAT_R[k], MOAT_R[Math.min(720, k + 1)], t); };

/** Signed distance from the moat's outer outline, positive on the countryside side. */
function moatSigned(x: number, z: number, r = hyp(x, z)) {
  if (r > 330) return r - moatRadius(x, z);
  const s = MOAT_F.signed(x, z);
  return r < 290 ? s : lerp(s, r - moatRadius(x, z), smoothstep(290, 330, r));
}

const FOOT_F = FOOT.map((p) => new OutlineField(p, 90, 3));
/** Distance to the nearest building footprint (0 inside one). */
function footDist(x: number, z: number) {
  let d = 1e9;
  for (const f of FOOT_F) { const q = f.signed(x, z); if (q < 0) return 0; if (q < d) d = q; }
  return d;
}

/** Point-in-any-polygon with a bounding-box reject first. */
export function inAny(polys: V2[][]) {
  const boxes = polys.map((p) => { let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (const [x, z] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); } return { x0, x1, z0, z1 }; });
  return (x: number, z: number) => polys.some((p, i) => { const b = boxes[i]; return x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && pointInPoly(p, x, z); });
}
const IN_BUILT = inAny(FOOT), COURT_OUT = offsetPoly(COURT, 0.3), HOLE_IN = 0.5;
const STAIR_HOLE = (() => { const c = stairTowerCentre(), r = STAIR_TOWER.r - 0.3; return Array.from({ length: 16 }, (_, i) => [c[0] + Math.cos((i / 16) * 2 * Math.PI) * r, c[1] + Math.sin((i / 16) * 2 * Math.PI) * r] as V2); })();
const RING: V2[] = Array.from({ length: 8 }, (_, i) => [Math.cos((i / 8) * 2 * Math.PI) * HOLE_IN, Math.sin((i / 8) * 2 * Math.PI) * HOLE_IN]);
/**
 * Where there is no ground at ground level: under the buildings, at least HOLE_IN (0.5 m) inside their
 * joined footprints (their own floors take over, and the cellar stairs and stair shafts pass through), but
 * not under the courtyard, which keeps its ground except in the stair tower (its spiral goes down to the
 * cellars). Joined footprints count as one (a gate passage runs across the gatehouse and the wing). The one
 * rule for the rendered near grid and its collider (player/setup.ts): a cell whose centre is in a hole is
 * left out of both.
 */
export function groundHole(x: number, z: number): boolean {
  if (pointInPoly(STAIR_HOLE, x, z)) return true;
  if (!IN_BUILT(x, z) || pointInPoly(COURT_OUT, x, z)) return false;
  return RING.every(([dx, dz]) => IN_BUILT(x + dx, z + dz));
}

// where the broken bridge lands on the outer bank (same march as castle/bridge.ts)
const BRIDGE_END: V2 = (() => {
  const d = norm(add(GATE.out, [0.12, 0]));
  let t = 5; while (t < 400 && pointInPoly(ISLAND, ...add(GATE.centre, scale(d, t)))) t += 0.25;
  t += 2; while (t < 400 && pointInPoly(MOAT_OUTER, ...add(GATE.centre, scale(d, t)))) t += 0.25;
  return add(GATE.centre, scale(d, t + 2.5));
})();

// ───────────────────────── a terrain's context: injected noise, caches ─────────────────────────
export interface ReliefGrid { R: Float32Array; D: Float32Array }
interface Stream { pts: V2[]; W: number[]; w: number[]; cum: number[]; buckets: Map<number, number[]> }
export interface Hedgerow { a: V2; b: V2; lane: boolean }
interface Ctx {
  deps: GenDeps;
  n1: Noise2D; n2: Noise2D; n3: Noise2D; n4: Noise2D; n5: Noise2D;
  relief0: (x: number, z: number) => number;
  grid: ReliefGrid | null;
  fields: FieldLayout;
  /** field grain, for the drumlins */ CG: number; SG: number;
  stream: Stream | null;
  hedges: Hedgerow[] | null;
  timings: Record<string, number>;
}

// ───────────────────────── relief: eroded mountains and far hills (relief.ts) ─────────────────────────
function gridAt(a: Float32Array, x: number, z: number) {
  const fx = (x - RX0) / RCELL, fz = (z - RZ0) / RCELL;
  const ix = clamp(Math.floor(fx), 0, RN - 2), iz = clamp(Math.floor(fz), 0, RN - 2), u = clamp(fx - ix, 0, 1), v = clamp(fz - iz, 0, 1), i = ix + iz * RN;
  return (a[i] * (1 - u) + a[i + 1] * u) * (1 - v) + (a[i + RN] * (1 - u) + a[i + RN + 1] * u) * v;
}
const gridEdge = (x: number, z: number) => Math.min(x - RX0, RX0 + RSIZE - x, z - RZ0, RZ0 + RSIZE - z);
/** Mountains and far hills: eroded grid inside, analytic outside, with a little sub-grid detail. */
function reliefAt(T: Ctx, x: number, z: number) {
  if (x * x + z * z < 1e6) return 0;
  const edge = gridEdge(x, z), G = T.grid;
  let h = !G || edge <= 0 ? T.relief0(x, z) : edge < 500 ? lerp(T.relief0(x, z), gridAt(G.R, x, z), edge / 500) : gridAt(G.R, x, z);
  const rough = clamp(h / 500, 0, 1);
  if (rough > 0) h += rough * (5 * fbm(T.n2, x / 170, z / 170, 2));
  return h;
}
/** Erosion delta in metres (negative: gullies cut, positive: fans and scree deposited). */
const erosionAt = (T: Ctx, x: number, z: number) => (T.grid && gridEdge(x, z) > 0 ? gridAt(T.grid.D, x, z) : 0);

// ───────────────────────── countryside: bank, drumlins, lake ─────────────────────────
interface Bank { h: number; sN: number; face: number }
/** Outer moat bank: an irregular shoreline, a steep earth face 0.4–1.1 m above the water, a rounded shoulder. */
function bank(T: Ctx, x: number, z: number, s: number): Bank {
  const { n1, n2, n3 } = T;
  if (s > 45) return { h: 2.2 + 0.75 * n1(x / 37, z / 37) + (s < 400 ? 0.25 * n2(x / 9, z / 9) + 0.17 * fbm(n3, x / 3.1, z / 3.1, 2) : 0), sN: s, face: 0 };
  const nA = n2(x / 13, z / 13), nB = n1(x / 4.3 + 7, z / 4.3);
  const sN = s + 1.5 * nA + 0.6 * nB + 0.3 * n3(x / 1.6, z / 1.6) - 0.2;
  const bw = 1 - smoothstep(5, 13, hyp(x - BRIDGE_END[0], z - BRIDGE_END[1]));
  const top = lerp(2.2 + 0.75 * n1(x / 37, z / 37) + 0.25 * n2(x / 9, z / 9), 2.75, bw);
  const faceH = lerp(0.6 + 0.85 * (0.5 + 0.5 * n3(x / 17, z / 17)), 1.8, bw);
  const faceW = 0.55 + 1.0 * (0.5 + 0.5 * n2(x / 8 + 3, z / 8));
  let h: number, face = 0;
  if (sN < 0) h = -0.22 + 0.42 * sN + 0.1 * nB;
  else if (sN < faceW) { h = -0.22 + (faceH + 0.22) * smoothstep(0.12, 0.9, sN / faceW); face = 1; }
  else { const u = sN - faceW; h = faceH + (top - faceH) * (1 - Math.exp(-u / 3.0)); face = 1 - smoothstep(0, 1.0, u); }
  // hummocks, tussocks and the odd slump on the bank
  h += (0.22 * fbm(n3, x / 3.1, z / 3.1, 2) + 0.08 * n1(x / 0.9, z / 0.9)) * smoothstep(0.2, 1.8, sN);
  return { h, sN, face };
}

/** Drumlins: low whale-backed ridges aligned with the field grain. */
function drumlins(T: Ctx, x: number, z: number) {
  const u = x * T.CG + z * T.SG, v = -x * T.SG + z * T.CG;
  const d = T.n4(u / 520, v / 175) * 0.7 + T.n5(u / 300, v / 120) * 0.3;
  return 10 * smoothstep(-0.05, 0.75, d);
}

function countryside(T: Ctx, x: number, z: number, s: number, b: Bank) {
  const { n1, n2, n3 } = T;
  let h = b.h + (s < 900 ? 1.1 * smoothstep(5, 40, s) * fbm(n1, x / 70, z / 70, 3) : 0);
  let hills = 15 + 30 * fbm(n1, x / 650, z / 650, 5);
  if (hills < 4) hills = 4 - (4 - hills) * 0.15;
  h += smoothstep(30, 420, s) * hills + s * 0.004;
  h += smoothstep(70, 320, s) * drumlins(T, x, z);
  const lake = hyp((x - 760) / 1.25, z - 330) + 45 * n2(x / 260, z / 260) + 14 * n3(x / 70, z / 70);
  h = smin(h, -5 + 32 * smoothstep(110, 380, lake), 5);
  return h + reliefAt(T, x, z);
}

// ───────────────────────── stream from the northern hills down to the lake ─────────────────────────
const STREAM_CTRL: V2[] = [[-300, -1760], [-80, -1280], [110, -900], [215, -600], [250, -350], [300, -160], [390, 20], [495, 150], [610, 240], [700, 300], [760, 340]];
const SB = 60; // bucket size, metres
const bucketKey = (i: number, j: number) => (i + 512) * 4096 + (j + 512);
const stream = (T: Ctx): Stream => T.stream ?? (T.stream = makeStream(T));
function makeStream(T: Ctx): Stream {
  const t0 = performance.now();
  const cr = (p0: V2, p1: V2, p2: V2, p3: V2, t: number): V2 => {
    const t2 = t * t, t3 = t2 * t;
    const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
    return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
  };
  const raw: V2[] = [];
  const C = STREAM_CTRL;
  for (let k = 0; k < C.length - 1; k++) {
    const p0 = C[Math.max(0, k - 1)], p1 = C[k], p2 = C[k + 1], p3 = C[Math.min(C.length - 1, k + 2)];
    const L = hyp(p2[0] - p1[0], p2[1] - p1[1]), n = Math.ceil(L / 4);
    for (let i = 0; i < n; i++) raw.push(cr(p0, p1, p2, p3, i / n));
  }
  raw.push(C[C.length - 1]);
  // meanders: lateral offset along the arc length
  const nm = T.deps.noise2('stream-meander');
  const pts: V2[] = [], cum: number[] = [];
  let acc = 0;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[Math.max(0, i - 1)], b = raw[Math.min(raw.length - 1, i + 1)];
    const t = norm([b[0] - a[0], b[1] - a[1]]), nrm: V2 = [-t[1], t[0]];
    if (i > 0) acc += hyp(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]);
    const fade = smoothstep(0, 150, acc);
    const off = fade * (26 * nm(acc / 340, 0.5) + 2.5 * nm(acc / 95, 4.2));
    pts.push([raw[i][0] + nrm[0] * off, raw[i][1] + nrm[1] * off]);
  }
  acc = 0;
  for (let i = 0; i < pts.length; i++) { if (i > 0) acc += hyp(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); cum.push(acc); }
  // water surface: follows the land down, never climbs, always a little below the banks
  const W: number[] = [], w: number[] = [];
  let last = Infinity, end = pts.length;
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i], s = moatSigned(x, z);
    const base = countryside(T, x, z, s, bank(T, x, z, s));
    const ds = i ? cum[i] - cum[i - 1] : 0;
    last = Math.min(last - 0.004 * ds, base - 0.5);
    W.push(last); w.push(1.1 + 2.1 * (cum[i] / acc));
    if (last < -0.4) { end = i + 1; break; }
  }
  const P = pts.slice(0, end), Cm = cum.slice(0, end);
  const buckets = new Map<number, number[]>();
  for (let k = 0; k < P.length - 1; k++) {
    const a = P[k], b = P[k + 1], R = 200;
    const i0 = Math.floor((Math.min(a[0], b[0]) - R) / SB), i1 = Math.floor((Math.max(a[0], b[0]) + R) / SB);
    const j0 = Math.floor((Math.min(a[1], b[1]) - R) / SB), j1 = Math.floor((Math.max(a[1], b[1]) + R) / SB);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const key = bucketKey(i, j); let l = buckets.get(key); if (!l) buckets.set(key, (l = [])); l.push(k); }
  }
  T.timings.streamMs = Math.round(performance.now() - t0);
  return { pts: P, W: W.slice(0, end), w: w.slice(0, end), cum: Cm, buckets };
}

/** Nearest point on the stream: distance, water level and half width there. */
function streamNear(T: Ctx, x: number, z: number): { d: number; W: number; w: number } | null {
  const S = stream(T), l = S.buckets.get(bucketKey(Math.floor(x / SB), Math.floor(z / SB)));
  if (!l) return null;
  let best = Infinity, bk = 0, bt = 0;
  const P = S.pts;
  for (const k of l) {
    const a = P[k], b = P[k + 1], abx = b[0] - a[0], abz = b[1] - a[1];
    let t = ((x - a[0]) * abx + (z - a[1]) * abz) / (abx * abx + abz * abz || 1);
    t = clamp(t, 0, 1);
    const d = hyp(x - a[0] - abx * t, z - a[1] - abz * t);
    if (d < best) { best = d; bk = k; bt = t; }
  }
  if (best > 190) return null;
  return { d: best, W: lerp(S.W[bk], S.W[bk + 1], bt), w: lerp(S.w[bk], S.w[bk + 1], bt) };
}

// ───────────────────────── the height function ─────────────────────────
export interface Sample {
  h: number; zone: 'island' | 'moat' | 'outer'; dEdge: number;
  /** outer bank: 1 on the bare earth face at the waterline */ face?: number;
  /** distance to the stream centre line, when within 190 m */ stream?: number;
}

function sampleIn(T: Ctx, x: number, z: number): Sample {
  const { n1, n2 } = T;
  const r = hyp(x, z);
  const sI = r < 160 ? ISL_F.signed(x, z) : 1, eI = Math.abs(sI);
  if (r < 140 && sI < 0) {
    const e = eI;
    const dc = Math.hypot(x - CC[0], z - CC[1]);
    let h = GROUND + 0.35 * fbm(n1, x / 40, z / 40, 3) - 0.75 * smoothstep(28, 60, dc);
    // little rocky rise by the great tower, hollows in the south-east lawn
    h += 1.1 * Math.max(0, 1 - Math.hypot(x + 40, z + 24) / 11) * (0.7 + 0.3 * n2(x / 6, z / 6));
    h -= 0.35 * Math.max(0, n2(x / 25 + 3, z / 25)) * smoothstep(35, 50, dc);
    // flatten the ward next to the walls and the courtyard
    const fd = footDist(x, z);
    h = h + (GROUND - 0.05 - h) * (1 - smoothstep(2, 9, fd));
    if (pointInPoly(COURT, x, z)) h = COURT_BED;
    // the bank is faced with a stone revetment (castle/revetment.ts) whose coping and turf strip cover the
    // outer 1.8 m: the ground holds its level to 0.35 m from the edge, then drops under the wall
    const bank = smoothstep(0.05, 0.35, e);
    h = -1.6 + (h + 1.6) * bank;
    return { h, zone: 'island', dEdge: e };
  }
  const s = moatSigned(x, z, r);
  if (s < 0) {
    const e = Math.min(r < 160 ? eI : Math.abs(ISL_F.signed(x, z)), -s);
    const bed = -0.6 + (MOAT.bed + 0.6) * smoothstep(0, 7, e) + 0.3 * n2(x / 9, z / 9);
    const b = bank(T, x, z, s);
    return { h: Math.max(bed, b.h), zone: 'moat', dEdge: e, face: b.face };
  }
  const b = bank(T, x, z, s);
  let h = countryside(T, x, z, s, b);
  const st = r > 250 ? streamNear(T, x, z) : null;
  if (st) {
    const { d, W, w } = st;
    // a broad valley down to the water, then the channel itself
    h = smin(h, W + 1.4 + 0.05 * d + 0.0011 * d * d, 5);
    const hs = d < w ? W - 0.55 * (1 - (d / w) ** 2) - 0.12 : W + 0.32 + 0.3 * (d - w) + 0.016 * (d - w) ** 2;
    h = smin(h, hs, 1.0);
  }
  return { h, zone: 'outer', dEdge: s, face: b.face, stream: st?.d };
}

/** Slope as 1 − n.y of the surface normal (0 flat, 0.29 at 45°), from central differences ±e metres. */
function slopeIn(T: Ctx, x: number, z: number, e = 4) {
  const H = (px: number, pz: number) => sampleIn(T, px, pz).h;
  const hx = H(x + e, z) - H(x - e, z), hz = H(x, z + e) - H(x, z - e);
  return 1 - (2 * e) / hyp(hx, 2 * e, hz);
}

/** How much a point is farmland (fields, hedges, lanes): 0 near the moat, in the lake, the stream, steep or high ground. */
function farmWeight(x: number, z: number, s: Sample, slope: number) {
  if (s.zone !== 'outer') return 0;
  const r = hyp(x, z);
  let w = smoothstep(18, 45, s.dEdge) * smoothstep(2.5, 6, s.h) * (1 - smoothstep(110, 200, s.h)) * (1 - smoothstep(0.12, 0.25, slope));
  if (s.stream !== undefined) w *= smoothstep(7, 16, s.stream);
  w *= 1 - smoothstep(FIELD_EXTENT - 300, FIELD_EXTENT - 60, Math.max(Math.abs(x), Math.abs(z)));
  return r > 2600 ? w * (1 - smoothstep(2600, 3000, r)) : w;
}
const farmIn = (T: Ctx, x: number, z: number) => farmWeight(x, z, sampleIn(T, x, z), slopeIn(T, x, z));

/** Ground weights for a vertex: mask = (grass, dirt, rock, mud), mask2 = (farmland, moor, scree, wet). */
function masksFor(T: Ctx, x: number, z: number, s: Sample, slope: number, mask: Float32Array, mask2: Float32Array, o: number) {
  const { n1, n2, n3 } = T;
  let grass = 1, dirt = 0, rock = 0, mud = 0, farm = 0, moor = 0, scree = 0, wet = 0;
  const wob = n2(x / 7, z / 7);
  if (s.zone === 'island') {
    const fd = footDist(x, z);
    dirt = clamp(1 - smoothstep(1.5, 4.0 + 1.6 * wob, fd), 0, 1) * 0.85;
    // worn path from the gate toward the south-east lawn
    const g = GATE.centre, gd = Math.abs((x - g[0]) * GATE.dir[0] + (z - g[1]) * GATE.dir[1]);
    const along = (x - g[0]) * GATE.out[0] + (z - g[1]) * GATE.out[1];
    if (along > 0 && along < 30) dirt = Math.max(dirt, (1 - smoothstep(1.6, 3.2 + wob, gd)) * 0.9);
    if (pointInPoly(COURT, x, z)) { dirt = 0.6; rock = 0.4; grass = 0; }
    mud = 1 - smoothstep(0.3, 2.2, s.dEdge);
    rock = Math.max(rock, smoothstep(0.35, 0.7, slope) * 0.8, Math.max(0, 1 - hyp(x + 40, z + 24) / 9) * 0.9);
  } else if (s.zone === 'moat' && s.h < -0.25) {
    mud = 1; grass = 0;
  } else {
    const face = s.face ?? 0;
    // bank: wet mud at the waterline, bare earth and stones on the face, trampled patches above
    const wl = 1 - smoothstep(0.05, 0.45 + 0.2 * wob, s.h);
    mud = wl;
    const bankZone = 1 - smoothstep(6, 14, s.dEdge);
    const scar = smoothstep(0.25, 0.55, n3(x / 5.5, z / 5.5) + 0.4 * n1(x / 1.7, z / 1.7)) * bankZone * (1 - smoothstep(1.5, 5, s.dEdge + 1.5 * wob));
    dirt = Math.max(face * (0.75 + 0.25 * wob), scar * 0.8, smoothstep(0.22, 0.45, slope) * 0.9 * bankZone);
    rock = smoothstep(0.42, 0.75, slope + 0.1 * wob) * (1 - bankZone);
    // countryside
    farm = farmWeight(x, z, s, slope);
    // rough common grazing between the moat and the fields (encoded as negative farmland)
    const rough = smoothstep(1, 5, s.dEdge) * (1 - farm) * (0.55 + 0.35 * smoothstep(-0.2, 0.4, n3(x / 30, z / 30)));
    farm = farm - rough * (1 - farm);
    moor = smoothstep(110, 280, s.h + 90 * n1(x / 900, z / 900) + 30 * wob) * (1 - smoothstep(0.55, 0.8, slope));
    const ero = erosionAt(T, x, z);
    scree = smoothstep(2, 14, ero) * smoothstep(0.12, 0.3, slope) * smoothstep(150, 300, s.h);
    if (s.stream !== undefined) { wet = 1 - smoothstep(2.0, 4.5, s.stream); mud = Math.max(mud, (1 - smoothstep(3.5, 7, s.stream)) * 0.7); }
    if (s.h < 1.2 && s.h > -1 && s.dEdge > 20) mud = Math.max(mud, 0.6);
    dirt = Math.max(dirt, 0.2 * smoothstep(0.3, 0.8, n1(x / 140, z / 140)) * (1 - smoothstep(400, 900, hyp(x, z))) * (1 - farm));
  }
  grass = Math.max(0, grass - dirt - rock - mud);
  const t = grass + dirt + rock + mud || 1;
  mask[o] = grass / t; mask[o + 1] = dirt / t; mask[o + 2] = rock / t; mask[o + 3] = mud / t;
  mask2[o] = farm; mask2[o + 1] = moor; mask2[o + 2] = scree; mask2[o + 3] = wet;
}

// ───────────────────────── queries for other generators (hedges, trees, walls, NPCs) ─────────────────────────
/** Hedgerow centre lines (see Terrain.hedgerowLines). */
function hedgesIn(T: Ctx): Hedgerow[] {
  if (T.hedges) return T.hedges;
  const L = T.fields, out: Hedgerow[] = [];
  for (const h of L.hedges) {
    const a = L.pts[h.a], b = L.pts[h.b];
    if (Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1])) > FIELD_EXTENT - 80) continue;
    const segs: [V2, V2][] = [];
    if (h.lane) {
      const t = norm([b[0] - a[0], b[1] - a[1]]), n: V2 = [-t[1] * LANE_HALF, t[0] * LANE_HALF];
      segs.push([add(a, n), add(b, n)], [add(a, scale(n, -1)), add(b, scale(n, -1))]);
    } else segs.push([a, b]);
    for (const [p, q] of segs) {
      // split where farmland stops, in ~20 m steps
      const L2 = hyp(q[0] - p[0], q[1] - p[1]), n = Math.max(1, Math.ceil(L2 / 20));
      let start = -1;
      for (let i = 0; i <= n; i++) {
        const t = i / n, x = p[0] + (q[0] - p[0]) * t, z = p[1] + (q[1] - p[1]) * t;
        const ok = farmIn(T, x, z) > 0.5;
        if (ok && start < 0) start = i;
        if ((!ok || i === n) && start >= 0) {
          const endI = ok ? i : i - 1;
          if (endI > start) out.push({ a: [p[0] + (q[0] - p[0]) * (start / n), p[1] + (q[1] - p[1]) * (start / n)], b: [p[0] + (q[0] - p[0]) * (endI / n), p[1] + (q[1] - p[1]) * (endI / n)], lane: h.lane });
          start = -1;
        }
      }
    }
  }
  return (T.hedges = out);
}

function fieldIn(T: Ctx, x: number, z: number): { field: number; crop: Crop | null } {
  if (farmIn(T, x, z) < 0.5) return { field: -1, crop: null };
  const f = fieldIndexAt(T.fields, x, z);
  return f < 0 ? { field: -1, crop: null } : { field: f, crop: CROPS[T.fields.fields[f].crop] };
}

/** On the island, clear of the revetment edge and the buildings (no slope test). */
function islandWalkable(x: number, z: number) {
  const s = ISL_F.signed(x, z);
  return s < -1.2 && footDist(x, z) > 0.6;
}

/** Steepest ground an NPC walks on, as 1 − n.y (35°). */
export const MAX_WALK_SLOPE = 1 - Math.cos((35 * Math.PI) / 180);

export interface NavSample { h: number; slope: number; walkable: boolean }
export interface NavGrid { x0: number; z0: number; cell: number; nx: number; nz: number; h: Float32Array; slope: Float32Array; walkable: Uint8Array }

function navIn(T: Ctx, x: number, z: number, obstacles: readonly [number, number, number][] = []): NavSample {
  const h = sampleIn(T, x, z).h, slope = slopeIn(T, x, z, 0.5);
  let walkable = islandWalkable(x, z) && slope <= MAX_WALK_SLOPE;
  for (const [ox, oz, r] of obstacles) if (walkable && hyp(x - ox, z - oz) < r) walkable = false;
  return { h, slope, walkable };
}

/** Cell-centred raster over the island's bounds, ready for navmesh generation. */
function navGridIn(T: Ctx, cell: number, obstacles: readonly [number, number, number][] = []): NavGrid {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of ISLAND) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const nx = Math.ceil((x1 - x0) / cell), nz = Math.ceil((z1 - z0) / cell);
  const h = new Float32Array(nx * nz), slope = new Float32Array(nx * nz), walkable = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = i + j * nx, s = navIn(T, x0 + (i + 0.5) * cell, z0 + (j + 0.5) * cell, obstacles);
    h[k] = s.h; slope[k] = s.slope; walkable[k] = s.walkable ? 1 : 0;
  }
  return { x0, z0, cell, nx, nz, h, slope, walkable };
}

// ───────────────────────── relief texture for the far shader ─────────────────────────
/** RGBA8 over the erosion grid: RG = world normal x/z, B = erosion delta (0.5 = none, ±40 m), A = 1.
 *  Gives per-pixel gullies, ridges and scree on mountains that the far mesh is too coarse to carry. */
export const RELIEF_TEX = { size: RN, x0: RX0, z0: RZ0, extent: RSIZE };
function reliefTextureIn(T: Ctx, N = RN) {
  const t0 = performance.now();
  const out = new Uint8Array(N * N * 4), H = new Float32Array(N * N), cell = RSIZE / (N - 1);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = RX0 + i * cell, z = RZ0 + j * cell;
    H[i + j * N] = x * x + z * z < 49e4 ? 0 : sampleIn(T, x, z).h;
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = i + j * N;
    let hx = (H[Math.min(N - 1, i + 1) + j * N] - H[Math.max(0, i - 1) + j * N]) / (2 * cell);
    let hz = (H[i + Math.min(N - 1, j + 1) * N] - H[i + Math.max(0, j - 1) * N]) / (2 * cell);
    hx *= 2.2; hz *= 2.2;
    const l = hyp(hx, 1, hz);
    out[k * 4] = Math.round((0.5 - (0.5 * hx) / l) * 255);
    out[k * 4 + 1] = Math.round((0.5 - (0.5 * hz) / l) * 255);
    out[k * 4 + 2] = Math.round(clamp(0.5 + erosionAt(T, RX0 + i * cell, RZ0 + j * cell) / 80, 0, 1) * 255);
    out[k * 4 + 3] = 255;
  }
  T.timings.reliefTexMs = Math.round(performance.now() - t0);
  return out;
}

// ───────────────────────── the terrain object ─────────────────────────
export interface Terrain {
  readonly deps: GenDeps;
  /** the world seed when the deps are seededDeps(seed): lets prepareTerrain erode in a worker */
  readonly seed?: number;
  readonly fields: FieldLayout;
  readonly timings: Record<string, number>;
  sample(x: number, z: number): Sample;
  heightAt(x: number, z: number): number;
  /** 1 − n.y of the ground normal, from central differences ±e metres */
  slopeAt(x: number, z: number, e?: number): number;
  erosionAt(x: number, z: number): number;
  /** Is the point on farmland (0..1)? Trees/hedges generators can use it for density. */
  farmland(x: number, z: number): number;
  /** Field under a point: crop and field id (−1 and crop null off the farmland). */
  fieldAt(x: number, z: number): { field: number; crop: Crop | null };
  /** Hedgerow centre lines as straight segments in world x/z (metres), already clipped to farmland: none
   *  in the moat, on the bank, in the lake, by the stream, on steep or high ground. Lane edges come back as
   *  two parallel hedges LANE_HALF either side of the lane (flag `lane`). Same layout the terrain shader
   *  draws, so hedges planted on these lines sit on the darker hedge-base strip. Cached; ~2k segments. */
  hedgerowLines(): Hedgerow[];
  /** Stream centre line (x, z), water level and half width per point, source to lake. */
  streamLine(): { pts: V2[]; level: number[]; halfWidth: number[] };
  /** On the island, clear of the revetment edge and the buildings (no slope test). */
  islandWalkable(x: number, z: number): boolean;
  /** Height, slope (±0.5 m) and walkability for NPC navigation; obstacles are circles (x, z, r). */
  navSample(x: number, z: number, obstacles?: readonly [number, number, number][]): NavSample;
  /** Walkable raster over the island (cell metres), for navmesh generation. */
  islandNavGrid(cell?: number, obstacles?: readonly [number, number, number][]): NavGrid;
  /** Ground blend weights for a mesh vertex (mask, mask2 at offset o). */
  groundMasks(x: number, z: number, s: Sample, slope: number, mask: Float32Array, mask2: Float32Array, o: number): void;
  /** Install the eroded relief (from erodeRelief); resets the stream and hedges that depend on it. */
  setRelief(grid: ReliefGrid): void;
  hasRelief(): boolean;
  reliefTexture(size?: number): Uint8Array;
}

export function createTerrain(deps: GenDeps, opts: { seed?: number; relief?: ReliefGrid } = {}): Terrain {
  const fields = fieldLayout(deps), grain = fields.angle + 0.1;
  const T: Ctx = {
    deps,
    n1: deps.noise2('terrain-a'), n2: deps.noise2('terrain-b'), n3: deps.noise2('terrain-c'), n4: deps.noise2('terrain-d'), n5: deps.noise2('terrain-e'),
    relief0: makeRelief0(deps), grid: opts.relief ?? null, fields, CG: Math.cos(grain), SG: Math.sin(grain),
    stream: null, hedges: null, timings: {},
  };
  return {
    deps, seed: opts.seed, fields, timings: T.timings,
    sample: (x, z) => sampleIn(T, x, z),
    heightAt: (x, z) => sampleIn(T, x, z).h,
    slopeAt: (x, z, e) => slopeIn(T, x, z, e),
    erosionAt: (x, z) => erosionAt(T, x, z),
    farmland: (x, z) => farmIn(T, x, z),
    fieldAt: (x, z) => fieldIn(T, x, z),
    hedgerowLines: () => hedgesIn(T),
    streamLine: () => { const S = stream(T); return { pts: S.pts, level: S.W, halfWidth: S.w }; },
    islandWalkable,
    navSample: (x, z, obstacles) => navIn(T, x, z, obstacles),
    islandNavGrid: (cell = 1, obstacles) => navGridIn(T, cell, obstacles),
    groundMasks: (x, z, s, slope, mask, mask2, o) => masksFor(T, x, z, s, slope, mask, mask2, o),
    setRelief: (grid) => { T.grid = grid; T.stream = null; T.hedges = null; },
    hasRelief: () => T.grid !== null,
    reliefTexture: (size) => reliefTextureIn(T, size),
  };
}

// ───────────────────────── meshes ─────────────────────────
function finish(T: Terrain, g: THREE.BufferGeometry, samples: Sample[]) {
  g.computeVertexNormals();
  const p = g.attributes.position as THREE.BufferAttribute, nrm = g.attributes.normal as THREE.BufferAttribute;
  const mask = new Float32Array(p.count * 4), mask2 = new Float32Array(p.count * 4);
  for (let i = 0; i < p.count; i++) {
    T.groundMasks(p.getX(i), p.getZ(i), samples[i], 1 - nrm.getY(i), mask, mask2, i * 4);
  }
  g.setAttribute('mask', new THREE.BufferAttribute(mask, 4));
  g.setAttribute('mask2', new THREE.BufferAttribute(mask2, 4));
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / 3.7; uv[i * 2 + 1] = -p.getZ(i) / 3.7; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeBoundingSphere();
  return g;
}

function buildGrid(T: Terrain, size: number, seg: number, holes: V2[][] = []) {
  const extra = inAny(holes);
  const g = new THREE.PlaneGeometry(size, size, seg, seg);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  const samples: Sample[] = new Array(p.count);
  for (let i = 0; i < p.count; i++) { const s = T.sample(p.getX(i), p.getZ(i)); samples[i] = s; p.setY(i, s.h); }
  // no ground where groundHole says so (PlaneGeometry: 6 indices per cell, a b d / b c d; a and c are opposite corners)
  const src = g.index!.array, keep: number[] = [];
  for (let o = 0; o < src.length; o += 6) {
    const a = src[o], c = src[o + 4];
    const x = (p.getX(a) + p.getX(c)) / 2, z = (p.getZ(a) + p.getZ(c)) / 2;
    if (!groundHole(x, z) && !extra(x, z)) for (let k = 0; k < 6; k++) keep.push(src[o + k]);
  }
  g.setIndex(keep);
  return finish(T, g, samples);
}

/** Polar far terrain: rings with growing spacing out to the horizon. */
function buildFar(T: Terrain, inner: number, outer: number, rings: number, segs: number, drop: (x: number, z: number, s: Sample) => number) {
  const W = segs + 1, pos = new Float32Array((rings + 1) * W * 3), idx = new Uint32Array(rings * segs * 6), samples: Sample[] = [];
  for (let i = 0, o = 0; i <= rings; i++) {
    const r = inner * Math.pow(outer / inner, i / rings);
    for (let j = 0; j <= segs; j++, o += 3) {
      const a = (j / segs) * Math.PI * 2, x = Math.cos(a) * r, z = Math.sin(a) * r, s = T.sample(x, z);
      samples.push(s); pos[o] = x; pos[o + 1] = s.h - drop(x, z, s); pos[o + 2] = z;
    }
  }
  for (let i = 0, o = 0; i < rings; i++) for (let j = 0; j < segs; j++, o += 6) { const a = i * W + j, b = a + 1, c = a + W, d = c + 1; idx[o] = a; idx[o + 1] = b; idx[o + 2] = c; idx[o + 3] = b; idx[o + 4] = d; idx[o + 5] = c; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return finish(T, g, samples);
}

const CORRIDOR = 46;
/** A ribbon of fine terrain along the stream (the far mesh is too coarse for a 3 m channel), and the water. */
function buildStream(T: Terrain, waterMat: THREE.Material | null) {
  const S = T.streamLine(), P = S.pts, offs = [-CORRIDOR, -34, -25, -18, -13, -9.5, -7, -5, -3.8, -2.8, -1.9, -1.2, -0.5, 0.2, 0.9, 1.6, 2.4, 3.3, 4.4, 6, 8, 11, 15, 21, 29, 38, CORRIDOR];
  const pos: number[] = [], idx: number[] = [], samples: Sample[] = [];
  const wpos: number[] = [], widx: number[] = [];
  const C = offs.length + 2; // + skirts
  let rows = 0;
  for (let k = 0; k < P.length; k++) {
    const a = P[Math.max(0, k - 2)], b = P[Math.min(P.length - 1, k + 2)], t = norm([b[0] - a[0], b[1] - a[1]]), nrm: V2 = [-t[1], t[0]];
    const ring: number[] = [], rs: Sample[] = [];
    for (const o of offs) {
      const x = P[k][0] + nrm[0] * o, z = P[k][1] + nrm[1] * o, s = T.sample(x, z);
      rs.push(s); ring.push(x, s.h, z);
    }
    // skirts at both edges hide the step down to the dropped far mesh
    pos.push(ring[0], ring[1] - 1.5, ring[2], ...ring, ring[ring.length - 3], ring[ring.length - 2] - 1.5, ring[ring.length - 1]);
    samples.push(rs[0], ...rs, rs[rs.length - 1]);
    const ww = S.halfWidth[k] + 0.9;
    wpos.push(P[k][0] - nrm[0] * ww, S.level[k], P[k][1] - nrm[1] * ww, P[k][0] + nrm[0] * ww, S.level[k], P[k][1] + nrm[1] * ww);
    rows++;
  }
  for (let i = 0; i < rows - 1; i++) {
    // columns run along +nrm = (-t.z, t.x), i.e. to the left of travel: (a, b, c) faces up
    for (let j = 0; j < C - 1; j++) { const a = i * C + j, b = a + 1, c = a + C, d = c + 1; idx.push(a, b, c, b, d, c); }
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3; widx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  finish(T, g, samples);
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(wpos, 3));
  wg.setIndex(widx);
  wg.computeVertexNormals();
  const water = waterMat ? new THREE.Mesh(wg, waterMat) : null;
  if (water) { water.name = 'stream-water'; water.receiveShadow = false; }
  return { ground: g, water };
}

export interface TerrainMeshOptions {
  near?: number; nearSeg?: number; farRings?: number; farSegs?: number;
  /** More holes in the near grid besides groundHole (the interior's groundHoles.terrain). */
  holes?: V2[][];
}

/** Meshes for a terrain: near grid, polar far mesh, stream corridor and water, rocks. The material's
 *  userData may carry `stream`, `rock` (materials) and `reliefTex` (filled here). */
export function buildTerrain(material: THREE.Material, T: Terrain = defaultTerrain(), o: TerrainMeshOptions = {}) {
  const t0 = performance.now();
  const NEAR = o.near ?? 380;
  const inside = (x: number, z: number) => NEAR / 2 - Math.max(Math.abs(x), Math.abs(z));
  const group = new THREE.Group();
  group.name = 'terrain';
  const near = new THREE.Mesh(buildGrid(T, NEAR, o.nearSeg ?? 420, o.holes), material);
  near.receiveShadow = true; near.name = 'terrain-near';
  const tNear = performance.now();
  const far = new THREE.Mesh(buildFar(T, 150, 16000, o.farRings ?? 200, o.farSegs ?? 560, (x, z, s) => 4 * smoothstep(0, 25, inside(x, z)) + (s.stream !== undefined ? 9 * (1 - smoothstep(CORRIDOR - 14, CORRIDOR - 2, s.stream)) : 0)), material);
  far.receiveShadow = false; far.name = 'terrain-far';
  const tFar = performance.now();
  const ud = (material as THREE.Material & { userData: { stream?: THREE.Material; rock?: THREE.Material; reliefTex?: THREE.DataTexture } }).userData;
  if (ud.reliefTex) { (ud.reliefTex.image.data as Uint8Array).set(T.reliefTexture(ud.reliefTex.image.width)); ud.reliefTex.needsUpdate = true; }
  const st = buildStream(T, ud.stream ?? null);
  const corridor = new THREE.Mesh(st.ground, material);
  corridor.name = 'terrain-stream';
  group.add(near, far, corridor);
  if (st.water) group.add(st.water);
  const tStream = performance.now();
  const rocks = buildRocks(ud.rock ?? material, { sample: T.sample, moatOuter: MOAT_OUTER, footDist, hedges: T.hedgerowLines(), fieldAt: T.fieldAt, farmland: T.farmland }, T.deps);
  group.add(rocks);
  const tRocks = performance.now();
  Object.assign(T.timings, { nearMs: Math.round(tNear - t0), farMs: Math.round(tFar - tNear), streamMeshMs: Math.round(tStream - tFar), rocksMs: Math.round(tRocks - tStream) });
  let tris = 0;
  group.traverse((m) => { const g = (m as THREE.Mesh).geometry; if (g) tris += ((g.index?.count ?? g.attributes.position.count) / 3) * ((m as THREE.InstancedMesh).count ?? 1); });
  // island rock footprints (x, z, r) for collision / navmesh: group.getObjectByName('rocks').userData.obstacles
  group.userData = { triangles: Math.round(tris), rocks: rocks.userData.count, islandObstacles: rocks.userData.obstacles.length, timings: { ...T.timings } };
  return group;
}

/** Run the mountain erosion (in a worker when the terrain is seeded and workers exist). Await before
 *  building or sampling terrain: until it resolves, heights use the uneroded relief. */
export function prepareTerrain(T: Terrain = defaultTerrain(), o: { droplets?: number; worker?: boolean; erode?: (deps: GenDeps, droplets?: number) => ReliefGrid } = {}): Promise<void> {
  if (T.hasRelief()) return Promise.resolve();
  const t0 = performance.now(), erode = o.erode ?? erodeRelief;
  const done = (g: ReliefGrid) => { T.setRelief(g); T.timings.reliefMs = Math.round(performance.now() - t0); };
  if (typeof Worker === 'undefined' || T.seed === undefined || o.worker === false) { done(erode(T.deps, o.droplets)); return Promise.resolve(); }
  return new Promise((resolve) => {
    const w = new Worker(new URL('./relief.worker.ts', import.meta.url), { type: 'module' });
    const fallback = (e: unknown) => { console.warn('relief worker failed, eroding inline', e); done(erode(T.deps, o.droplets)); w.terminate(); resolve(); };
    w.onmessage = (e: MessageEvent<{ R: Float32Array; D: Float32Array; ms: number }>) => { done(e.data); T.timings.reliefWorkerMs = e.data.ms; w.terminate(); resolve(); };
    w.onerror = fallback;
    w.postMessage({ seed: T.seed });
  });
}

// ───────────────────────── the game's terrain (composition root for existing importers) ─────────────────────────
let DEFAULT: Terrain | null = null;
/** The game's terrain, seeded from the URL (?seed=…). Created on first use, not at import. */
export function defaultTerrain(): Terrain {
  return DEFAULT ?? (DEFAULT = createTerrain(seededDeps(WORLD_SEED), { seed: WORLD_SEED }));
}
export const sample = (x: number, z: number) => defaultTerrain().sample(x, z);
export const heightAt = (x: number, z: number) => defaultTerrain().heightAt(x, z);
export const hedgerowLines = () => defaultTerrain().hedgerowLines();
export const fieldAt = (x: number, z: number) => defaultTerrain().fieldAt(x, z);
export const streamLine = () => defaultTerrain().streamLine();
export const farmland = (x: number, z: number) => defaultTerrain().farmland(x, z);
export { islandWalkable, footDist, BRIDGE_END, moatSigned };
export type { V2 };
