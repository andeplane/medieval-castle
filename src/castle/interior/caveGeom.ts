// Cave geometry (caves.ts is the plan): the rock is the zero surface of a signed field, cave air < 0 < rock.
// Each chamber is a noise-roughened ellipse in plan under a dome, each passage a tube along its floor line;
// the cave is their union, every one cut flat by its own floor (so floors are walkable and the walk line
// keeps its headroom: the noise moves walls and ceilings, never floors). Surface nets on a 0.4 m grid turn
// the field into one triangle soup in the group's 'rock' bin (one draw call); normals from the field's
// gradient, uvs in metres / tile on the dominant axis. Then what is not rock: rough steps cut down the
// drop (rough 'rock'), a collar of rock round each castle doorway, the pool's still water ('pool'), glowing
// fungi ('glow') and the finds (bones, a shrine, a smugglers' cache with its lantern).
// A pure function of the plan and the seed; the soup is cached per plan, since several builders ask for it.
import { ShapeUtils, Vector2 } from 'three/webgpu';
import { createNoise3D, createNoise2D } from 'simplex-noise';
import type { Builder, BinKey } from '../builder';
import type { V2 } from '../../core/math2d';
import type { DoorSpec, V3 } from './types';
import type { Flame, LightEmitter } from '../../light/types';
import { mulberry32, hashSeed } from '../../core/rng';
import { type CavePlan, type CaveChamber, type CavePassage, passageFrame, passageFloor, domeAt, poolDepth, POOL_LEVEL, ellipseRadius } from './caves';

/** Grid step of the surface nets (m). */
export const CAVE_CELL = 0.4;
const ROCK_TILE = 4;
/** How far a passage's tube runs on into a chamber, and back into the wall at a castle doorway. */
const EXT_CHAMBER = 1.0, EXT_PORTAL = 0.6;

type Bin = Builder['bins'][BinKey];
interface Prim { lo: V3; hi: V3; f: (x: number, y: number, z: number, n: number) => number }

/** The signed field of the caves: < 0 in the air, > 0 in the rock (roughly metres near the surface). */
export function caveField(P: CavePlan, seed: number) {
  const n3 = createNoise3D(mulberry32(hashSeed('cave-noise', seed))), n2 = createNoise2D(mulberry32(hashSeed('cave-floor', seed)));
  const prims: Prim[] = [];
  for (const k of P.chambers) prims.push(chamberPrim(k, n2));
  for (const p of P.passages) prims.push(passagePrim(p));
  const noise = (x: number, y: number, z: number) => n3(x * 0.28, y * 0.34, z * 0.28) * 0.7 + n3(x * 0.95 + 17, y * 0.95, z * 0.95) * 0.3;
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p.lo[a]); hi[a] = Math.max(hi[a], p.hi[a]); }
  const f = (x: number, y: number, z: number) => {
    let v = 1, N = NaN;
    for (const p of prims) {
      if (x < p.lo[0] || x > p.hi[0] || y < p.lo[1] || y > p.hi[1] || z < p.lo[2] || z > p.hi[2]) continue;
      if (N !== N) N = noise(x, y, z);
      const d = p.f(x, y, z, N);
      if (d < v) v = d;
    }
    return v;
  };
  return { f, lo, hi };
}

function chamberPrim(k: CaveChamber, n2: (x: number, y: number) => number): Prim {
  const ax = k.axis, m = Math.min(k.a, k.b), pad = k.noise + 0.6;
  const R = Math.max(k.a, k.b) * 1.05 + pad;
  return {
    lo: [k.c[0] - R, k.y - (k.pool?.depth ?? 0) - 0.6, k.c[1] - R], hi: [k.c[0] + R, k.y + k.h + pad, k.c[1] + R],
    f: (x, y, z, N) => {
      const dx = x - k.c[0], dz = z - k.c[1], u = dx * ax[0] + dz * ax[1], v = -dx * ax[1] + dz * ax[0];
      const rho = Math.hypot(u / k.a, v / k.b);
      const floor = k.y + 0.05 * n2(x * 0.5, z * 0.5) - poolDepth(k, [x, z]);
      const ceil = k.y + domeAt(k, rho);
      return Math.max((rho - 1) * m + k.noise * N, y - ceil + k.noise * 0.8 * N, floor - y);
    },
  };
}

function passagePrim(p: CavePassage): Prim {
  const { a, u, L } = passageFrame(p), e0 = p.portal[0] ? EXT_PORTAL : EXT_CHAMBER, e1 = p.portal[1] ? EXT_PORTAL : EXT_CHAMBER;
  const rise = p.steps ? (p.from[1] - p.to[1]) / p.steps : 0;
  const pts = [[a[0] - u[0] * e0, a[1] - u[1] * e0], [a[0] + u[0] * (L + e1), a[1] + u[1] * (L + e1)]];
  const R = p.w + p.noise + 0.8, ylo = Math.min(p.from[1], p.to[1]) - rise - 0.6, yhi = Math.max(p.from[1], p.to[1]) + p.h + p.noise + 0.6;
  return {
    lo: [Math.min(pts[0][0], pts[1][0]) - R, ylo, Math.min(pts[0][1], pts[1][1]) - R], hi: [Math.max(pts[0][0], pts[1][0]) + R, yhi, Math.max(pts[0][1], pts[1][1]) + R],
    f: (x, y, z, N) => {
      const dx = x - a[0], dz = z - a[1], t = dx * u[0] + dz * u[1], s = -dx * u[1] + dz * u[0];
      const line = passageFloor(p, t);
      // steps: the rock under them follows their inside corners (the treads are built on it)
      const floor = rise && t > 0 ? Math.max(Math.min(p.from[1], p.to[1]), line - rise) : line;
      const k = Math.max(0, Math.min(1, (y - floor) / p.h));
      const hw = (p.w / 2) * (1 + 0.22 * Math.sin(Math.PI * k));
      return Math.max(Math.abs(s) - hw + p.noise * N, y - (line + p.h) + p.noise * N, -e0 - t, t - L - e1, floor - y);
    },
  };
}

/**
 * Surface nets: one vertex per grid cell the surface crosses, one quad per grid edge it crosses (none where
 * `skip` holds at the edge's middle).
 */
export function surfaceNets(f: (x: number, y: number, z: number) => number, lo: V3, hi: V3, h: number, skip?: (x: number, y: number, z: number) => boolean) {
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 3, ny = Math.ceil((hi[1] - lo[1]) / h) + 3, nz = Math.ceil((hi[2] - lo[2]) / h) + 3;
  const ox = lo[0] - h, oy = lo[1] - h, oz = lo[2] - h;
  const v = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) v[i + nx * (j + ny * k)] = f(ox + i * h, oy + j * h, oz + k * h);
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cell = new Int32Array(cx * cy * cz).fill(-1);
  const P: number[] = [], Nn: number[] = [];
  const E: [number, number][] = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float64Array(8);
  for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) { const val = v[(i + (c & 1)) + nx * ((j + ((c >> 1) & 1)) + ny * (k + ((c >> 2) & 1)))]; cv[c] = val; if (val < 0) mask |= 1 << c; }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (const [p, q] of E) {
      const a = cv[p], b = cv[q];
      if ((a < 0) === (b < 0)) continue;
      const t = a / (a - b);
      sx += (p & 1) + ((q & 1) - (p & 1)) * t; sy += ((p >> 1) & 1) + (((q >> 1) & 1) - ((p >> 1) & 1)) * t; sz += ((p >> 2) & 1) + (((q >> 2) & 1) - ((p >> 2) & 1)) * t; cnt++;
    }
    cell[i + cx * (j + cy * k)] = P.length / 3;
    P.push(ox + (i + sx / cnt) * h, oy + (j + sy / cnt) * h, oz + (k + sz / cnt) * h);
    // into the air: minus the gradient, from the cell's corner differences
    const gx = cv[1] - cv[0] + cv[3] - cv[2] + cv[5] - cv[4] + cv[7] - cv[6];
    const gy = cv[2] - cv[0] + cv[3] - cv[1] + cv[6] - cv[4] + cv[7] - cv[5];
    const gz = cv[4] - cv[0] + cv[5] - cv[1] + cv[6] - cv[2] + cv[7] - cv[3];
    const l = Math.hypot(gx, gy, gz) || 1;
    Nn.push(-gx / l, -gy / l, -gz / l);
  }
  const tris: number[] = [];
  const C = (i: number, j: number, k: number) => cell[i + cx * (j + cy * k)];
  const quad = (a: number, b: number, c: number, d: number, inside: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (inside) tris.push(a, b, c, a, c, d); else tris.push(a, c, b, a, d, c);
  };
  const keep = (x: number, y: number, z: number) => !skip || !skip(ox + x * h, oy + y * h, oz + z * h);
  for (let k = 1; k < cz; k++) for (let j = 1; j < cy; j++) for (let i = 1; i < cx; i++) {
    const v0 = v[i + nx * (j + ny * k)] < 0;
    if (i < cx && (v[i + 1 + nx * (j + ny * k)] < 0) !== v0 && keep(i + 0.5, j, k)) quad(C(i, j - 1, k - 1), C(i, j, k - 1), C(i, j, k), C(i, j - 1, k), v0);
    if (j < cy && (v[i + nx * (j + 1 + ny * k)] < 0) !== v0 && keep(i, j + 0.5, k)) quad(C(i - 1, j, k - 1), C(i - 1, j, k), C(i, j, k), C(i, j, k - 1), v0);
    if (k < cz && (v[i + nx * (j + ny * (k + 1))] < 0) !== v0 && keep(i, j, k + 0.5)) quad(C(i - 1, j - 1, k), C(i, j - 1, k), C(i, j, k), C(i - 1, j, k), v0);
  }
  return { pos: P, nor: Nn, tris };
}

/**
 * Is a point inside the castle's wall behind a doorway into the caves, more than 0.3 m behind the cave's
 * face? There the passage's tube is left open (its end would close the doorway); the collar round the
 * doorway, in the face, hides the open end.
 */
export function behindPortal(P: CavePlan) {
  const ends = P.passages.flatMap((p) => {
    const { a, u, L } = passageFrame(p), out: { o: V2; u: V2; y: number; p: CavePassage }[] = [];
    if (p.portal[0]) out.push({ o: a, u, y: p.from[1], p });
    if (p.portal[1]) out.push({ o: [a[0] + u[0] * L, a[1] + u[1] * L], u: [-u[0], -u[1]], y: p.to[1], p });
    return out;
  });
  return (x: number, y: number, z: number) => ends.some((e) => {
    const dx = x - e.o[0], dz = z - e.o[1], t = dx * e.u[0] + dz * e.u[1], s = -dx * e.u[1] + dz * e.u[0];
    return t < -0.3 && t > -2 && Math.abs(s) < e.p.w + 1.2 && y > e.y - 1 && y < e.y + e.p.h + 1.5;
  });
}

const cache = new Map<string, ReturnType<typeof surfaceNets>>();
/** The cave rock as an indexed soup (cached by plan). */
export function caveRock(P: CavePlan, seed: number) {
  const key = `${seed}:${JSON.stringify([P.chambers, P.passages])}`;
  let r = cache.get(key);
  if (!r) {
    const F = caveField(P, seed);
    r = surfaceNets(F.f, F.lo, F.hi, CAVE_CELL, behindPortal(P));
    if (cache.size > 4) cache.clear();
    cache.set(key, r);
  }
  return r;
}

/** Each castle doorway into the caves: the door and the side (0 | 1) the cave is on. */
export interface CavePortal { door: DoorSpec; clear: V2[]; cave: 0 | 1 }

/**
 * Build the caves into B: rock, collars, steps, pool, fungi and finds. Returns the rock's triangle count.
 */
export function buildCaves(B: Builder, P: CavePlan, seed: number, portals: CavePortal[]): { rock: number } {
  const R = caveRock(P, seed);
  const rock = B.bins.rock;
  const fix = (i: number): V3 => [R.pos[3 * i], R.pos[3 * i + 1], R.pos[3 * i + 2]];
  const nrm = (i: number): V3 => [R.nor[3 * i], R.nor[3 * i + 1], R.nor[3 * i + 2]];
  const uvOf = (p: V3, n: V3): [number, number] => {
    const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
    if (ay >= ax && ay >= az) return [p[0] / ROCK_TILE, p[2] / ROCK_TILE];
    return ax > az ? [p[2] / ROCK_TILE, p[1] / ROCK_TILE] : [p[0] / ROCK_TILE, p[1] / ROCK_TILE];
  };
  for (let t = 0; t < R.tris.length; t += 3) {
    const ids = [R.tris[t], R.tris[t + 1], R.tris[t + 2]], p = ids.map(fix), n = ids.map(nrm);
    // face the air: wind the triangle along its vertices' normals
    const e1 = sub3(p[1], p[0]), e2 = sub3(p[2], p[0]), fn = cross3(e1, e2);
    const ns: V3 = [n[0][0] + n[1][0] + n[2][0], n[0][1] + n[1][1] + n[2][1], n[0][2] + n[1][2] + n[2][2]];
    const tri = dot3(fn, ns) < 0 ? [0, 2, 1] : [0, 1, 2];
    rock.triN(tri.map((i) => p[i]), tri.map((i) => n[i]), tri.map((i) => uvOf(p[i], ns)));
  }
  const rockTris = R.tris.length / 3;
  for (const pt of portals) collar(rock, pt, P);
  for (const p of P.passages) if (p.steps) steps(B, p, seed);
  for (const k of P.chambers) if (k.pool) pool(B.bins.pool, k);
  fungi(B.bins.glow, R, P, seed);
  for (const f of P.features) feature(B, f, seed);
  return { rock: rockTris };
}

/** Rock round a castle doorway, in the cave room's face: the cave's tube ends in it (behind it, in the wall). */
function collar(bin: Bin, pt: CavePortal, P: CavePlan) {
  const d = pt.door, sgn = pt.cave === 1 ? 1 : -1, t = (sgn * d.wall) / 2;
  const p = P.passages.find((x) => x.id === d.spaces[pt.cave])!;
  const hw = (p.w / 2) * 1.3 + p.noise + 0.9, y0 = d.centre[1] - 0.6, y1 = d.centre[1] + p.h + p.noise + 1.0;
  const outer: V2[] = [[-hw, y0], [hw, y0], [hw, y1], [-hw, y1]];
  const W = (u: number, y: number): V3 => [d.centre[0] + d.along[0] * u + d.normal[0] * t, y, d.centre[2] + d.along[1] * u + d.normal[1] * t];
  const n: V3 = [d.normal[0] * sgn, 0, d.normal[1] * sgn];
  const hole = pt.clear.filter((q, i, a) => { const r = a[(i + 1) % a.length]; return Math.hypot(r[0] - q[0], r[1] - q[1]) > 1e-4; });
  const all = [...outer, ...hole];
  const tris = ShapeUtils.triangulateShape(outer.map((q) => new Vector2(q[0], q[1])), [hole.map((q) => new Vector2(q[0], q[1]))]);
  for (const [i, j, k] of tris) bin.tri(W(all[i][0], all[i][1]), W(all[j][0], all[j][1]), W(all[k][0], all[k][1]), n, uvW(all[i]), uvW(all[j]), uvW(all[k]));
}
const uvW = (q: V2): [number, number] => [q[0] / ROCK_TILE, q[1] / ROCK_TILE];

/** Rough steps down a passage: one block per tread, its top on the riser line, its ends in the rock. */
export function stepBlocks(p: CavePassage, seed: number) {
  const { a, u, L } = passageFrame(p), n = p.steps!, g = L / n, rise = (p.from[1] - p.to[1]) / n, r = mulberry32(hashSeed(`cave-steps-${p.id}`, seed));
  const out: { c: V3; size: V3; dir: V2 }[] = [];
  for (let k = 1; k < n; k++) {
    const top = p.from[1] - k * rise + (r() - 0.5) * 0.03, tc = (k - 0.5) * g, q = [a[0] + u[0] * tc, a[1] + u[1] * tc];
    const off = (r() - 0.5) * 0.12, side: V2 = [-u[1], u[0]], depth = Math.max(0.35, rise + 0.3);
    const yaw = (r() - 0.5) * 0.06, dir: V2 = [u[0] * Math.cos(yaw) - u[1] * Math.sin(yaw), u[0] * Math.sin(yaw) + u[1] * Math.cos(yaw)];
    out.push({ c: [q[0] + side[0] * off, top - depth / 2, q[1] + side[1] * off], size: [g + 0.03, depth, p.w + 0.9], dir });
  }
  return out;
}
/** The steps as rough rock blocks in the rock bin (Builder.box takes only castle materials): five faces, no bottom. */
function steps(B: Builder, p: CavePassage, seed: number) {
  const bin = B.bins.rock;
  for (const { c, size: [sx, sy, sz], dir: d } of stepBlocks(p, seed)) {
    const n: V2 = [d[1], -d[0]], y0 = c[1] - sy / 2, y1 = c[1] + sy / 2;
    const at = (s: number, t: number, y: number): V3 => [c[0] + d[0] * s * sx / 2 + n[0] * t * sz / 2, y, c[2] + d[1] * s * sx / 2 + n[1] * t * sz / 2];
    const quad = (a: V3, b: V3, e: V3, f: V3, nn: V3) => { bin.tri(a, b, e, nn, [0, 0], [1, 0], [1, 1]); bin.tri(a, e, f, nn, [0, 0], [1, 1], [0, 1]); };
    quad(at(-1, -1, y1), at(1, -1, y1), at(1, 1, y1), at(-1, 1, y1), [0, 1, 0]);
    for (const [s0, t0, s1, t1, nn] of [[-1, -1, 1, -1, [-n[0], 0, -n[1]]], [1, -1, 1, 1, [d[0], 0, d[1]]], [1, 1, -1, 1, [n[0], 0, n[1]]], [-1, 1, -1, -1, [-d[0], 0, -d[1]]]] as [number, number, number, number, V3][])
      quad(at(s0, t0, y0), at(s1, t1, y0), at(s1, t1, y1), at(s0, t0, y1), nn);
  }
}

/** The pool's still water: a disc a little under the chamber floor, its rim under the basin's slope. */
export function poolDisc(k: CaveChamber): { y: number; pts: V2[] } {
  const pl = k.pool!, y = k.y - POOL_LEVEL;
  // where the basin is POOL_LEVEL deep, plus a margin that tucks the rim under the rising floor
  let r = pl.r;
  for (let s = 0; s <= 1; s += 0.01) { const q: V2 = [pl.c[0] + s * pl.r, pl.c[1]]; if (poolDepth(k, q) < POOL_LEVEL) { r = s * pl.r; break; } }
  r = Math.min(pl.r, r + 0.3);
  return { y, pts: Array.from({ length: 28 }, (_, i) => [pl.c[0] + Math.cos((i / 28) * Math.PI * 2) * r, pl.c[1] + Math.sin((i / 28) * Math.PI * 2) * r] as V2) };
}
function pool(bin: Bin, k: CaveChamber) {
  const { y, pts } = poolDisc(k), c = k.pool!.c;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    bin.tri([c[0], y, c[1]], [p[0], y, p[1]], [q[0], y, q[1]], [0, 1, 0], [c[0] / 2, c[1] / 2], [p[0] / 2, p[1] / 2], [q[0] / 2, q[1] / 2]);
  }
}

/** Glowing fungi on the lower walls of the deep rooms: clusters of small caps (cheap emissive, no lights). */
const FUNGI_ROOMS = new Set(['cave-cavern', 'cave-well', 'cave-ledge', 'cave-squeeze', 'cave-drop', 'cave-rise']);
export function fungiSpots(R: { pos: number[]; nor: number[] }, P: CavePlan, seed: number): { p: V3; n: V3 }[] {
  const r = mulberry32(hashSeed('cave-fungi', seed)), out: { p: V3; n: V3 }[] = [];
  const near = (x: number, z: number, y: number) => {
    for (const k of P.chambers) if (FUNGI_ROOMS.has(k.id)) {
      const d = Math.hypot(x - k.c[0], z - k.c[1]), rr = ellipseRadius(k, [(x - k.c[0]) / (d || 1), (z - k.c[1]) / (d || 1)]);
      if (d < rr + 1.2 && y > k.y + 0.05 && y < k.y + 1.6) return true;
    }
    for (const p of P.passages) if (FUNGI_ROOMS.has(p.id)) {
      const { a, u, L } = passageFrame(p), t = (x - a[0]) * u[0] + (z - a[1]) * u[1], s = -(x - a[0]) * u[1] + (z - a[1]) * u[0];
      if (t > 0 && t < L && Math.abs(s) < p.w + 0.6 && y > passageFloor(p, t) - 0.3 && y < passageFloor(p, t) + 1.4) return true;
    }
    return false;
  };
  for (let i = 0; i < R.pos.length / 3; i++) {
    const ny = R.nor[3 * i + 1];
    if (Math.abs(ny) > 0.55 || r() > 0.06) continue;
    const p: V3 = [R.pos[3 * i], R.pos[3 * i + 1], R.pos[3 * i + 2]];
    if (!near(p[0], p[2], p[1])) continue;
    out.push({ p, n: [R.nor[3 * i], ny, R.nor[3 * i + 2]] });
  }
  return out;
}
function fungi(bin: Bin, R: { pos: number[]; nor: number[] }, P: CavePlan, seed: number) {
  const r = mulberry32(hashSeed('cave-fungi-caps', seed));
  for (const s of fungiSpots(R, P, seed)) {
    const t1 = norm3(cross3(s.n, [0, 1, 0])), t2 = cross3(s.n, t1);
    const caps = 3 + Math.floor(r() * 5);
    for (let c = 0; c < caps; c++) {
      const u = (r() - 0.5) * 0.35, v = (r() - 0.5) * 0.3, rad = 0.018 + r() * 0.04;
      const o: V3 = [s.p[0] + t1[0] * u + t2[0] * v + s.n[0] * 0.015, s.p[1] + t1[1] * u + t2[1] * v + s.n[1] * 0.015, s.p[2] + t1[2] * u + t2[2] * v + s.n[2] * 0.015];
      // a cap: a small disc tilted up from the wall
      const up = norm3([s.n[0] * 0.6, 1, s.n[2] * 0.6]), a1 = norm3(cross3(up, t2[1] > 0.99 ? t1 : [0, 0, 1])), a2 = cross3(up, a1);
      const ring = Array.from({ length: 6 }, (_, i) => { const t = (i / 6) * Math.PI * 2; return [o[0] + (a1[0] * Math.cos(t) + a2[0] * Math.sin(t)) * rad, o[1] + (a1[1] * Math.cos(t) + a2[1] * Math.sin(t)) * rad, o[2] + (a1[2] * Math.cos(t) + a2[2] * Math.sin(t)) * rad] as V3; });
      const top: V3 = [o[0] + up[0] * rad * 0.5, o[1] + up[1] * rad * 0.5, o[2] + up[2] * rad * 0.5];
      for (let i = 0; i < 6; i++) bin.tri(top, ring[i], ring[(i + 1) % 6], up, [0.5, 0.5], [0, 0], [1, 0]);
    }
  }
}

// ---------------------------------------------------------------- finds

/** The cache's casks and crates and where its lantern stands (on the near crate). */
export function cacheLayout(at: V3, dir: V2) {
  const side: V2 = [-dir[1], dir[0]], P = (f: number, s: number, y = at[1]): V3 => [at[0] - dir[0] * f + side[0] * s, y, at[2] - dir[1] * f + side[1] * s];
  const casks = [P(-0.1, -0.75), P(-0.15, 0.0), P(0.25, -1.25)];
  const crates: { c: V3; s: number }[] = [{ c: P(0.35, 0.85, at[1] + 0.3), s: 0.6 }, { c: P(0.35, 0.85, at[1] + 0.82), s: 0.44 }, { c: P(-0.25, 1.25, at[1] + 0.25), s: 0.5 }];
  const lantern = P(0.3, 0.8, at[1] + 1.04 + 0.01);
  return { casks, crates, lantern, side };
}

function feature(B: Builder, f: CavePlan['features'][number], seed: number) {
  const r = mulberry32(hashSeed(`cave-${f.kind}-${f.room}`, seed)), side: V2 = [-f.dir[1], f.dir[0]];
  const P = (fw: number, s: number, y: number): V3 => [f.at[0] + f.dir[0] * fw + side[0] * s, f.at[1] + y, f.at[2] + f.dir[1] * fw + side[1] * s];
  if (f.kind === 'bones') {
    // a skull and scattered long bones lying on the floor
    B.cyl('trim', ...pick2(P(0, 0, 0)), 0.085, 0.07, f.at[1], f.at[1] + 0.15, 8, { top: 'trim' });
    for (let i = 0; i < 9; i++) {
      const a = r() * Math.PI * 2, d = 0.2 + r() * 0.9, len = 0.22 + r() * 0.24;
      const q = P(Math.cos(a) * d, Math.sin(a) * d, 0.02);
      B.box('trim', q, [len, 0.035, 0.035], [Math.cos(a * 1.7), Math.sin(a * 1.7)], { bottom: false });
    }
    B.box('trim', P(-0.5, 0.4, 0.04), [0.32, 0.08, 0.22], f.dir, { bottom: false }); // a pelvis-ish block
  } else if (f.kind === 'shrine') {
    // an old rough altar against the wall: a block, a slab on it, a stone cross and two candle stubs
    B.box('trim', P(-0.1, 0, 0.45), [0.55, 0.9, 1.0], f.dir, { bottom: false });
    B.box('trim', P(-0.1, 0, 0.94), [0.66, 0.08, 1.15], f.dir, { bottom: false });
    B.box('trim', P(-0.25, 0, 1.28), [0.07, 0.62, 0.07], f.dir, { bottom: false });
    B.box('trim', P(-0.25, 0, 1.42), [0.07, 0.07, 0.36], f.dir, { bottom: false });
    for (const s of [-0.38, 0.38]) B.cyl('trim', ...pick2(P(0.02, s, 0)), 0.03, 0.028, f.at[1] + 0.98, f.at[1] + 1.06, 8, { top: 'trim' });
  } else if (f.kind === 'cache') {
    const L = cacheLayout(f.at, f.dir);
    for (const c of L.casks) {
      B.cyl('wood', c[0], c[2], 0.27, 0.3, c[1], c[1] + 0.4, 14, { top: null });
      B.cyl('wood', c[0], c[2], 0.3, 0.27, c[1] + 0.4, c[1] + 0.8, 14, { top: 'wood' });
      for (const y of [0.12, 0.68]) B.cyl('iron', c[0], c[2], 0.29, 0.295, c[1] + y, c[1] + y + 0.04, 14, { top: null });
    }
    for (const c of L.crates) B.box('wood', c.c, [c.s, c.s * 1.0, c.s * 1.2], f.dir);
  } else if (f.kind === 'lantern') {
    const p = cacheLayout(f.at, f.dir).lantern;
    lanternBody(B, p, f.dir);
  } else {
    // a lost lantern on its side, long cold
    const p = P(0, 0, 0.08);
    B.box('iron', p, [0.24, 0.15, 0.15], side, { bottom: false });
  }
}
function lanternBody(B: Builder, base: V3, dir: V2) {
  B.box('iron', [base[0], base[1] + 0.015, base[2]], [0.15, 0.03, 0.15], dir);
  B.box('iron', [base[0], base[1] + 0.235, base[2]], [0.17, 0.03, 0.17], dir);
  for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) B.box('iron', [base[0] + (dir[0] * a - dir[1] * b) * 0.065, base[1] + 0.125, base[2] + (dir[1] * a + dir[0] * b) * 0.065], [0.015, 0.2, 0.015], dir);
  B.cyl('iron', base[0], base[2], 0.012, 0.012, base[1] + 0.25, base[1] + 0.32, 6, { top: 'iron' });
}
const pick2 = (p: V3): [number, number] => [p[0], p[2]];

/** The caves' fire for src/light: the smugglers' lantern, still burning on its crate. */
export function caveFires(P: CavePlan, group: string): { emitters: LightEmitter[]; flames: Flame[]; group: string[] } {
  const out = { emitters: [] as LightEmitter[], flames: [] as Flame[], group: [] as string[] };
  for (const f of P.features) if (f.kind === 'lantern') {
    const b = cacheLayout(f.at, f.dir).lantern, base: V3 = [b[0], b[1] + 0.06, b[2]];
    out.flames.push({ kind: 'lantern', base, height: 0.09 });
    out.emitters.push({ kind: 'lantern', position: [base[0], base[1] + 0.08, base[2]], colour: [1, 0.93, 0.82], intensity: 1.6, flicker: 0.35 });
    out.group.push(group);
  }
  return out;
}

/**
 * Invisible walking ramps over the steps' nosings (as stairs.ts stairCollisionRamp does for the castle's
 * flights), so characters glide down the drop instead of catching on every tread. World-space positions,
 * non-indexed, two triangles per passage, both faces.
 */
export function caveRampSoups(P: CavePlan): { id: string; soup: number[] }[] {
  const out: { id: string; soup: number[] }[] = [];
  for (const p of P.passages) if (p.steps) {
    const { a, u, L } = passageFrame(p), s: V2 = [-u[1], u[0]], hw = p.w / 2;
    const Q = (t: number, k: number): V3 => [a[0] + u[0] * t + s[0] * k, passageFloor(p, t), a[1] + u[1] * t + s[1] * k];
    const A = Q(0, -hw), Bq = Q(0, hw), C = Q(L, hw), D = Q(L, -hw);
    out.push({ id: p.id, soup: [...A, ...C, ...Bq, ...A, ...D, ...C] });
  }
  return out;
}

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
