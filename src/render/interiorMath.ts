// Pure parts of the interior light (no three.js): which room a point is in, the apertures (windows,
// open doors, grilles, portals between rooms) that light each room, how bright the sky looks through
// each one, and the split-flux estimate of inter-reflected light per room. The shader in
// interiorLight.ts integrates each aperture's exact form factor per pixel; this module feeds it.
import type { RoomSpec, InteriorPlan, V3, SpaceId, DoorSpec } from '../castle/interior/types';
import type { V2 } from '../core/math2d';
import { headRise } from '../castle/interior/geom';

/**
 * Something daylight comes through. Frame: `c` is the centre of the narrowest section (the glass),
 * `n` points OUT of the room (as castle.ts WindowLight), `u` is up. `depth` is the length of the
 * embrasure from the glass to the room-side face of the wall, where the opening is `wi` × `hi` with
 * its centre `yi` above (negative: below) the glass centre (a plunging sill).
 */
export interface Aperture {
  id: string;
  kind: 'glass' | 'open' | 'grille' | 'portal';
  c: V3; n: V3; w: number; h: number;
  depth: number; wi: number; hi: number; yi: number;
  /** depth of the straight outer reveal in front of the glass (shades low sun), m */
  outer: number;
  room: number;               // index into the plan's rooms
  /** portals: the room on the other side; doors: the door id (for setDoorOpen) */
  other?: number; door?: string;
  /** doors: rise of the head above the springing (top of `h`), m */
  rise?: number;
  open: number;               // 0..1 (doors with leaves start closed)
}

export interface WindowInput { p: V3; n: V3; w: number; h: number; depth?: number; wi?: number; hi?: number; yi?: number; outer?: number; kind?: 'glass' | 'open' | 'grille' }

export const OUTSIDE = new Set<SpaceId>(['outside', 'courtyard']);

// ---------- rooms ----------

export function inPoly(poly: V2[], x: number, z: number) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

export function polyDist(poly: V2[], x: number, z: number) {
  if (inPoly(poly, x, z)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const abx = b[0] - a[0], abz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * abx + (z - a[1]) * abz) / (abx * abx + abz * abz || 1)));
    best = Math.min(best, Math.hypot(x - a[0] - abx * t, z - a[1] - abz * t));
  }
  return best;
}

export const polyArea = (p: V2[]) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };
export const polyPerimeter = (p: V2[]) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += Math.hypot(b[0] - a[0], b[1] - a[1]); } return s; };

/** Index of the room whose volume contains p (with `tol` metres of slack in plan and height), or -1. */
export function roomAt(rooms: RoomSpec[], p: V3, tol = 0): number {
  let best = -1, bd = Infinity;
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i];
    if (p[1] < r.y0 - 0.3 - tol || p[1] > r.y1 + 0.6 + tol) continue;
    const d = polyDist(r.poly, p[0], p[2]);
    if (d <= tol && d < bd) { bd = d; best = i; }
  }
  return best;
}

/** Room a surface belongs to: the nearest room volume within maxDist (embrasures and door reveals sit
 * in the wall thickness, outside every room polygon). `prefer` rooms win ties within 5 cm. */
const boxes = new WeakMap<RoomSpec, [number, number, number, number]>();
function boxOf(r: RoomSpec) {
  let b = boxes.get(r);
  if (!b) {
    b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, z] of r.poly) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], z); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], z); }
    boxes.set(r, b);
  }
  return b;
}

export function nearestRoom(rooms: RoomSpec[], p: V3, maxDist: number, prefer?: Set<number>): number {
  let best = -1, bd = Infinity;
  // fast path: strictly inside one of the preferred rooms (rooms do not overlap)
  if (prefer) for (const i of prefer) {
    const r = rooms[i];
    if (p[1] >= r.y0 - 0.05 && p[1] <= r.y1 + 0.05 && inPoly(r.poly, p[0], p[2])) return i;
  }
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i];
    if (p[1] < r.y0 - 0.5 || p[1] > r.y1 + 1.2) continue;
    // the plan box is a lower bound on the polygon distance: skip rooms that cannot win
    const b = boxOf(r), bx = Math.max(b[0] - p[0], 0, p[0] - b[2]), bz = Math.max(b[1] - p[2], 0, p[2] - b[3]);
    if (Math.hypot(bx, bz) > Math.min(maxDist, bd + 0.05)) continue;
    let d = polyDist(r.poly, p[0], p[2]);
    if (d > maxDist) continue;
    if (prefer?.has(i)) d -= 0.05;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** Distance along a 2D ray until it enters the polygon (0 if it starts inside), or Infinity. */
export function rayEnterPoly(poly: V2[], o: V2, d: V2): number {
  if (inPoly(poly, o[0], o[1])) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const den = d[0] * ez - d[1] * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((a[0] - o[0]) * ez - (a[1] - o[1]) * ex) / den;
    const s = ((a[0] - o[0]) * d[1] - (a[1] - o[1]) * d[0]) / den;
    if (t > 0 && s >= 0 && s <= 1) best = Math.min(best, t);
  }
  return best;
}

// ---------- apertures ----------

const norm3 = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Orthonormal window frame: along `a`, up `u`, into the room `nIn`, with cross(a, u) = nIn. */
export function apertureFrame(ap: Pick<Aperture, 'n'>) {
  const nIn = norm3([-ap.n[0], -ap.n[1], -ap.n[2]]);
  let u: V3 = [0, 1, 0];
  if (Math.abs(nIn[1]) > 0.9) u = [0, 0, -1]; // roof lights
  u = norm3([u[0] - nIn[0] * dot3(u, nIn), u[1] - nIn[1] * dot3(u, nIn), u[2] - nIn[2] * dot3(u, nIn)]);
  const a = cross3(u, nIn);
  return { a, u, nIn };
}

/**
 * Turn castle windows into room apertures: the room is the first one the inward ray from the glass
 * enters; the embrasure depth is how far it travels to get there. Missing splay sizes are guessed
 * (inner opening ~0.45 m per metre of depth wider, the sill plunging a little).
 */
export function windowsToApertures(rooms: RoomSpec[], windows: WindowInput[], maxDepth = 5): Aperture[] {
  const out: Aperture[] = [];
  windows.forEach((w, k) => {
    const n = norm3(w.n), nh: V2 = [-n[0], -n[2]], L = Math.hypot(nh[0], nh[1]);
    let room = -1, depth = Infinity;
    if (L > 1e-3) {
      const d: V2 = [nh[0] / L, nh[1] / L];
      for (let i = 0; i < rooms.length; i++) {
        const r = rooms[i];
        if (w.p[1] < r.y0 - 0.2 || w.p[1] > r.y1 + 0.5) continue;
        const t = rayEnterPoly(r.poly, [w.p[0], w.p[2]], d);
        if (t < depth && t <= maxDepth) { depth = t; room = i; }
      }
    }
    if (room < 0) return;
    const D = w.depth ?? Math.max(0.05, depth);
    out.push({
      id: `win${k}`, kind: w.kind ?? 'glass', c: w.p, n, w: w.w, h: w.h, depth: D,
      wi: w.wi ?? Math.min(w.w + 2, w.w + D * 0.9), hi: w.hi ?? Math.min(w.h + 1.2, w.h + D * 0.45), yi: w.yi ?? -Math.min(0.4, D * 0.12),
      outer: w.outer ?? 0.45, room, open: 1,
    });
  });
  return out;
}

/** Doors become apertures: to the outside/courtyard (daylight) or portals between rooms (bounce). */
export function doorsToApertures(plan: InteriorPlan, index: Map<SpaceId, number>): Aperture[] {
  const out: Aperture[] = [];
  for (const d of plan.doors) {
    const [s0, s1] = d.spaces;
    const i0 = index.get(s0) ?? -1, i1 = index.get(s1) ?? -1;
    const kind = d.kind === 'grille' ? 'grille' : OUTSIDE.has(s0) || OUTSIDE.has(s1) ? 'open' : 'portal';
    const open = d.leaf && d.kind !== 'grille' ? 0 : 1;
    const nrm: V3 = [d.normal[0], 0, d.normal[1]];
    // one aperture per room side: its "glass" is the far face of the door passage
    for (const [room, other, sign] of [[i0, i1, 1], [i1, i0, -1]] as const) {
      if (room < 0) continue;
      if (kind !== 'portal' && other >= 0) continue; // the outside side has no room to light
      const nOut: V3 = [nrm[0] * sign, 0, nrm[2] * sign];
      const half = d.wall / 2;
      out.push({
        id: `door:${d.id}:${room}`, kind: kind === 'grille' && other >= 0 ? 'portal' : kind, door: d.id,
        c: [d.centre[0] + nOut[0] * half, d.centre[1] + d.height / 2, d.centre[2] + nOut[2] * half], n: nOut,
        w: d.width, h: d.height, depth: d.wall, wi: d.width, hi: d.height, yi: 0, outer: 0, room, other: other >= 0 ? other : undefined, open, rise: headRise(d.head, d.width),
      });
    }
  }
  return out;
}

// ---------- daylight ----------

export interface Daylight {
  sunDir: V3;   // unit, towards the sun
  sunE: V3;     // sun colour × intensity (irradiance on a surface facing it)
  skyL: V3;     // sky radiance near the horizon, scene units (π·skyL ≈ the outdoor ambient irradiance)
  groundAlbedo: number;
}

export const TRANSMIT = { glass: 0.72, open: 1, grille: 0.7, portal: 1 } as const;

/** Radiance seen looking out through an aperture: half sky (brighter on the sun side), half lit ground. */
export function apertureRadiance(n: V3, day: Daylight): V3 {
  const nh = Math.hypot(n[0], n[2]) || 1, sh = Math.hypot(day.sunDir[0], day.sunDir[2]) || 1;
  const facing = Math.max(0, (n[0] * day.sunDir[0] + n[2] * day.sunDir[2]) / (nh * sh));
  const lowSun = Math.max(0, 1 - Math.max(0, day.sunDir[1]));
  const skyBoost = 1 + 1.6 * facing * facing * lowSun;
  const up = Math.max(0, day.sunDir[1]);
  const skyW = 0.55 + 0.3 * Math.max(0, n[1]), gW = 1 - skyW;
  return [0, 1, 2].map((k) => {
    const gE = day.sunE[k] * up * 0.8 + Math.PI * day.skyL[k] * 0.85;
    return skyW * day.skyL[k] * skyBoost + gW * (gE * day.groundAlbedo) / Math.PI;
  }) as V3;
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Fraction of the glass area that direct sun reaches the room through (outer reveal + embrasure). */
export function sunThrough(ap: Aperture, sunDir: V3): number {
  const { a, u, nIn } = apertureFrame(ap);
  const s: V3 = [-sunDir[0], -sunDir[1], -sunDir[2]]; // travel direction of sunlight
  const sn = dot3(s, nIn);
  if (sn <= 0.02) return 0;
  const sa = dot3(s, a) / sn, su = dot3(s, u) / sn;
  const hw = ap.w / 2, hh = ap.h / 2;
  // outer reveal: a straight tube of the glass size, `outer` deep, in front of the glass
  const fo = (overlap(-hw - sa * ap.outer, hw - sa * ap.outer, -hw, hw) / ap.w) * (overlap(-hh - su * ap.outer, hh - su * ap.outer, -hh, hh) / ap.h);
  // embrasure: the beam leaves the glass and must pass the room-side opening `depth` further on
  const D = ap.depth;
  const fi = (overlap(-hw + sa * D, hw + sa * D, -ap.wi / 2, ap.wi / 2) / ap.w) * (overlap(-hh + su * D, hh + su * D, ap.yi - ap.hi / 2, ap.yi + ap.hi / 2) / ap.h);
  return fo * fi * sn;
}

export interface RoomLight {
  /** irradiance from inter-reflection (split-flux), uniform over the room, RGB */
  bounce: V3;
  /** mean direct irradiance over the room surfaces */
  direct: V3;
}

/**
 * Split-flux inter-reflection per room: Φ (flux entering through apertures, sky + sun) spread over the
 * room's surface area A with mean reflectance ρ gives E = Φ ρ / (A (1 − ρ)). Portals (open doors,
 * stairs) carry the neighbour's exitance ρ·E/π in; a few iterations settle it. Returns per room light
 * and per aperture radiance.
 */
export function solveRooms(rooms: RoomSpec[], aps: Aperture[], day: Daylight, sunVis: number[], links: { a: number; b: number; area: number }[] = [], rho = 0.32, iters = 4) {
  const area = rooms.map((r) => 2 * polyArea(r.poly) + polyPerimeter(r.poly) * Math.max(1, r.y1 - r.y0));
  const ext = new Map<number, V3>(); // fixed daylight radiance per aperture index
  const flux0 = rooms.map(() => [0, 0, 0] as V3);
  aps.forEach((ap, i) => {
    if (ap.kind === 'portal') return;
    const L = apertureRadiance(ap.n, day).map((v) => v * TRANSMIT[ap.kind] * ap.open) as V3;
    ext.set(i, L);
    const A = ap.w * ap.h * ap.open;
    const sun = A * sunThrough(ap, day.sunDir) * (sunVis[i] ?? 1) * TRANSMIT[ap.kind];
    for (let k = 0; k < 3; k++) flux0[ap.room][k] += Math.PI * L[k] * A + sun * day.sunE[k];
  });
  const light: RoomLight[] = rooms.map(() => ({ bounce: [0, 0, 0], direct: [0, 0, 0] }));
  const radiance: V3[] = aps.map((_, i) => ext.get(i) ?? [0, 0, 0]);
  const exitance = (r: number): V3 => [0, 1, 2].map((k) => (rho * (light[r].direct[k] + light[r].bounce[k])) / Math.PI) as V3;
  for (let it = 0; it < iters; it++) {
    const flux = flux0.map((f) => [...f] as V3);
    aps.forEach((ap, i) => {
      if (ap.kind !== 'portal' || ap.other === undefined) return;
      const L = exitance(ap.other).map((v) => v * ap.open) as V3;
      radiance[i] = L;
      for (let k = 0; k < 3; k++) flux[ap.room][k] += Math.PI * L[k] * ap.w * ap.h * ap.open;
    });
    for (const l of links) {
      const La = exitance(l.a), Lb = exitance(l.b);
      for (let k = 0; k < 3; k++) { flux[l.b][k] += Math.PI * La[k] * l.area; flux[l.a][k] += Math.PI * Lb[k] * l.area; }
    }
    rooms.forEach((_, r) => {
      for (let k = 0; k < 3; k++) {
        light[r].direct[k] = flux[r][k] / area[r];
        light[r].bounce[k] = (flux[r][k] * rho) / (area[r] * (1 - rho));
      }
    });
  }
  return { light, radiance, area };
}

// ---------- eye adaptation ----------

export interface ExposureCfg {
  base: number;        // exposure outdoors (STYLE.md: 0.72)
  refLog2: number;     // log2 of the mean scene luminance that maps to `base`
  strength: number;    // 0..1: how much of a luminance change exposure compensates
  maxStops: number;    // ceiling above base (interiors)
  deepStops: number;   // ceiling underground
  tauDark: number;     // s, adapting to a darker scene (exposure rising)
  tauBright: number;   // s, adapting to a brighter scene
}
export const EXPOSURE: ExposureCfg = { base: 0.72, refLog2: -3.0, strength: 0.85, maxStops: 2.5, deepStops: 3.2, tauDark: 1.4, tauBright: 0.6 };

/** Target exposure in stops above `base` for a measured mean log2 luminance. */
export function targetStops(meanLog2: number, deep: boolean, cfg = EXPOSURE) {
  const s = (cfg.refLog2 - meanLog2) * cfg.strength;
  return Math.max(0, Math.min(deep ? cfg.deepStops : cfg.maxStops, s));
}

/** One step of exponential adaptation in log space; `stops` is the current offset above base. */
export function adaptStops(stops: number, target: number, dt: number, cfg = EXPOSURE) {
  const tau = target > stops ? cfg.tauDark : cfg.tauBright;
  return stops + (target - stops) * (1 - Math.exp(-dt / tau));
}

/** Weighted mean of log-encoded luminance texels (v = (log2 L + 14) / 18), centre-weighted. */
export function meanLog2(px: ArrayLike<number>, w: number, h: number, stride = 4) {
  let s = 0, ws = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (x + 0.5) / w - 0.5, dy = (y + 0.5) / h - 0.5;
    const wt = 1 - 1.2 * (dx * dx + dy * dy);
    s += ((px[(y * w + x) * stride] / 255) * 18 - 14) * wt; ws += wt;
  }
  return s / ws;
}

// ---------- bake helpers (pure, on plain arrays) ----------

/** Room index per vertex for a non-indexed, world-space triangle soup: each triangle steps 0.25 m off
 * its face along its normal and takes the nearest room within maxWall; all three vertices share it. */
export function tagTriangles(pos: ArrayLike<number>, nor: ArrayLike<number> | null, rooms: RoomSpec[], maxWall: number, prefer?: Set<number>) {
  const n = Math.floor(pos.length / 3), out = new Float32Array(n).fill(-1);
  for (let t = 0; t + 2 < n; t += 3) {
    const p: V3 = [0, 0, 0];
    let q: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) { p[j] += pos[(t + k) * 3 + j] / 3; if (nor) q[j] += nor[(t + k) * 3 + j]; }
    if (!nor) {
      const e1: V3 = [0, 1, 2].map((j) => pos[(t + 1) * 3 + j] - pos[t * 3 + j]) as V3, e2: V3 = [0, 1, 2].map((j) => pos[(t + 2) * 3 + j] - pos[t * 3 + j]) as V3;
      q = cross3(e1, e2);
    }
    q = norm3(q);
    const room = nearestRoom(rooms, [p[0] + q[0] * 0.25, p[1] + q[1] * 0.25, p[2] + q[2] * 0.25], maxWall, prefer);
    out[t] = out[t + 1] = out[t + 2] = room;
  }
  return out;
}

/** Texels per aperture in the shader table, and the table layout: row = room, texel 0 = (count, bounce
 * rgb), then per aperture (c, depth) (a, w/2) (u, h/2) (L, wi/2) (hi/2, yi, 0, 0). */
export const AP_TEXELS = 5;

export function packTable(data: Float32Array, texW: number, maxAp: number, roomCount: number, aps: Aperture[], solved: { light: RoomLight[]; radiance: V3[] }) {
  data.fill(0);
  const per = Array.from({ length: roomCount }, () => [] as number[]);
  aps.forEach((a, i) => { if (a.room >= 0 && a.room < roomCount) per[a.room].push(i); });
  for (let r = 0; r < roomCount; r++) {
    const sum = (i: number) => solved.radiance[i][0] + solved.radiance[i][1] + solved.radiance[i][2];
    // brightest (radiance × area) first; the shader integrates maxAp of them
    const list = per[r].filter((i) => sum(i) > 1e-5).sort((p, q) => sum(q) * aps[q].w * aps[q].h - sum(p) * aps[p].w * aps[p].h).slice(0, maxAp);
    const base = r * texW * 4, b = solved.light[r].bounce;
    data.set([list.length, b[0], b[1], b[2]], base);
    list.forEach((i, k) => {
      const ap = aps[i], { a, u } = apertureFrame(ap), L = solved.radiance[i];
      data.set([ap.c[0], ap.c[1], ap.c[2], ap.depth, a[0], a[1], a[2], ap.w / 2, u[0], u[1], u[2], ap.h / 2, L[0], L[1], L[2], ap.wi / 2, ap.hi / 2, ap.yi, 0, 0], base + (1 + k * AP_TEXELS) * 4);
    });
  }
  return data;
}

export interface SkinQuad { o: V3; r: V3; n: V3; L: number; y0: number; y1: number; holes: [number, number, number, number][] }

/**
 * Shadow skins: a hidden quad `inset` metres inside each room wall, facing the room, with holes where the
 * room's apertures pass. Sun shadow maps render back faces, so without it the shadow of a thick wall
 * starts at its inner face and sunlight leaks in a strip along every floor/wall seam.
 */
export function skinQuads(rooms: RoomSpec[], aps: Aperture[], inset = 0.22): SkinQuad[] {
  const out: SkinQuad[] = [];
  rooms.forEach((room, ri) => {
    const poly = room.poly, y0 = room.y0 - 0.6, y1 = room.y1 + 0.7;
    for (let i = 0; i < poly.length; i++) {
      const A = poly[i], B = poly[(i + 1) % poly.length], L = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (L < 0.05) continue;
      const r: V3 = [(B[0] - A[0]) / L, 0, (B[1] - A[1]) / L];
      let n: V3 = [-r[2], 0, r[0]];
      const mx = (A[0] + B[0]) / 2, mz = (A[1] + B[1]) / 2;
      if (!inPoly(poly, mx + n[0] * 0.02, mz + n[2] * 0.02)) n = [-n[0], 0, -n[2]];
      const o: V3 = [A[0] - n[0] * inset - r[0] * inset, 0, A[1] - n[2] * inset - r[2] * inset];
      const len = L + 2 * inset;
      const holes: [number, number, number, number][] = [];
      for (const ap of aps) {
        if (ap.room !== ri) continue;
        const { nIn } = apertureFrame(ap);
        if (nIn[0] * n[0] + nIn[2] * n[2] < 0.95) continue;
        const f: V3 = [ap.c[0] + nIn[0] * ap.depth, ap.c[1], ap.c[2] + nIn[2] * ap.depth];
        const off = (f[0] - A[0]) * n[0] + (f[2] - A[1]) * n[2];
        if (Math.abs(off) > 0.35) continue;
        const s = (f[0] - o[0]) * r[0] + (f[2] - o[2]) * r[2];
        const k = ap.depth > inset ? (ap.depth - inset) / ap.depth : 0;
        const w = ap.w + (ap.wi - ap.w) * k + 0.1;
        let lo = ap.c[1] + ap.yi * k - (ap.h + (ap.hi - ap.h) * k) / 2 - 0.05, hi = ap.c[1] + ap.yi * k + (ap.h + (ap.hi - ap.h) * k) / 2 + 0.05;
        if (ap.door) { lo = ap.c[1] - ap.h / 2 - 0.05; hi = ap.c[1] + ap.h / 2 + (ap.rise ?? ap.w * 0.6) + 0.05; } // arched heads
        const h: [number, number, number, number] = [Math.max(0.02, s - w / 2), Math.max(y0 + 0.02, lo), Math.min(len - 0.02, s + w / 2), Math.min(y1 - 0.02, hi)];
        if (h[2] > h[0] && h[3] > h[1] && !holes.some((q) => q[0] < h[2] && h[0] < q[2] && q[1] < h[3] && h[1] < q[3])) holes.push(h);
      }
      out.push({ o, r, n, L: len, y0, y1, holes });
    }
  });
  return out;
}

/** A quad of a shadow skin, corners in order. */
export type SkinFace = [V3, V3, V3, V3];

/** The four sides of a tube whose cross-sections are the rectangles `rings` (each: corners in order). */
function tube(rings: V3[][]): SkinFace[] {
  const out: SkinFace[] = [];
  for (let k = 0; k + 1 < rings.length; k++) for (let i = 0; i < 4; i++) out.push([rings[k][i], rings[k][(i + 1) % 4], rings[k + 1][(i + 1) % 4], rings[k + 1][i]]);
  return out;
}

/**
 * Shadow skins round the passages through the walls: each door passage (sides and lid, from just behind
 * one face of the wall to just behind the other) and each window embrasure (its splay from just behind the
 * room face to the glass, then the straight outer reveal). The wall skins are holed
 * there, the reveals cast no sun shadow and the castle's own faces round a thick wall face the sun (the
 * shadow map draws only faces turned away from it), so without these the sun shone through the wall
 * mass into the passage and laid a strip on the jamb and the floor. Cross-sections match the holes that
 * skinQuads cuts. Doors have no floor: the sun never comes from below.
 */
export function passageSkins(doors: DoorSpec[], isRoom: (id: SpaceId) => boolean, aps: Aperture[]): SkinFace[] {
  const out: SkinFace[] = [];
  for (const d of doors) {
    if (!isRoom(d.spaces[0]) && !isRoom(d.spaces[1])) continue;
    const t1 = Math.max(0.01, d.wall / 2 - 0.02), t0 = -t1; // to just behind both faces, past the wall skins
    const hw = d.width / 2 + 0.05, y0 = d.centre[1] - 0.6, y1 = d.centre[1] + d.height + headRise(d.head, d.width) + 0.05;
    const P = (u: number, y: number, t: number): V3 => [d.centre[0] + d.along[0] * u + d.normal[0] * t, y, d.centre[2] + d.along[1] * u + d.normal[1] * t];
    out.push(...tube([[P(-hw, y0, t0), P(-hw, y1, t0), P(hw, y1, t0), P(hw, y0, t0)], [P(-hw, y0, t1), P(-hw, y1, t1), P(hw, y1, t1), P(hw, y0, t1)]]).slice(0, 3));
  }
  for (const ap of aps) {
    if (ap.door || ap.kind === 'portal') continue;
    const { a, u, nIn } = apertureFrame(ap);
    // t: depth into the wall from the glass; the splay runs from (w, h) at t = 0 to (wi, hi, yi) at `depth`
    const ring = (t: number): V3[] => {
      const k = t > 0 ? t / ap.depth : 0;
      const hw = (ap.w + (ap.wi - ap.w) * k) / 2 + 0.05, hh = (ap.h + (ap.hi - ap.h) * k) / 2 + 0.05, yc = ap.yi * k;
      return [[-hw, -hh], [-hw, hh], [hw, hh], [hw, -hh]].map(([i, j]) => [0, 1, 2].map((q) => ap.c[q] + a[q] * i + u[q] * (yc + j) + nIn[q] * t) as V3);
    };
    // to just behind the room face: past the wall skin, whose hole is cut where that skin crosses the splay
    out.push(...tube([ring(-Math.max(0, ap.outer - 0.02)), ring(0), ring(Math.max(0, ap.depth - 0.02))]));
  }
  return out;
}

/** Horizontal shadow skins just above each room's ceiling (beams and boards touch it from below, so
 * without them sun leaks along the top of every beam). Every side moves out by `grow` (rooms are convex),
 * past the wall skins `inset` behind the faces, so a ray grazing over the top of a wall skin meets the
 * lid (growing the corners towards the centroid left the sides short of the wall skins: N6-0, 12 h).
 * Faces down. */
export function ceilingSkins(rooms: RoomSpec[], lift = 0.55, grow = 0.32): { poly: V2[]; y: number }[] {
  return rooms.map((r) => {
    const q = r.poly.filter((a, i, all) => { const b = all[(i + 1) % all.length]; return Math.hypot(b[0] - a[0], b[1] - a[1]) >= 1e-6; });
    let area = 0; for (let i = 0; i < q.length; i++) { const a = q[i], b = q[(i + 1) % q.length]; area += a[0] * b[1] - b[0] * a[1]; }
    const sg = area < 0 ? -1 : 1;
    // outward normal of side i (vertex i → i + 1)
    const nOf = (i: number): V2 => { const a = q[i], b = q[(i + 1) % q.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(sg * (b[1] - a[1])) / L, (-sg * (b[0] - a[0])) / L]; };
    const poly = q.map((a, i): V2 => { const n0 = nOf((i + q.length - 1) % q.length), n1 = nOf(i), k = grow / (1 + n0[0] * n1[0] + n0[1] * n1[1]); return [a[0] + (n0[0] + n1[0]) * k, a[1] + (n0[1] + n1[1]) * k]; });
    return { poly, y: r.y1 + lift };
  });
}
