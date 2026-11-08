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
/** How far a passage's tube runs on into a chamber, and back into the wall at a castle doorway. */
const EXT_CHAMBER = 1.0, EXT_PORTAL = 0.6;
/** How far a chamber wall's ledges stand out (m). */
const LEDGE = 0.5;
/** How much of a rock triangle's shading normal is its facet's (the rest is the field's smooth normal). */
const FACETED = 0.15;

type Bin = Builder['bins'][BinKey];
interface Prim { lo: V3; hi: V3; f: (x: number, y: number, z: number, n: number) => number }

/** The signed field of the caves: < 0 in the air, > 0 in the rock (roughly metres near the surface). */
export function caveField(P: CavePlan, seed: number) {
  const n3 = createNoise3D(mulberry32(hashSeed('cave-noise', seed))), n2 = createNoise2D(mulberry32(hashSeed('cave-floor', seed)));
  const prims: Prim[] = [];
  for (const k of P.chambers) prims.push(chamberPrim(k, n2));
  for (const p of P.passages) prims.push(passagePrim(p));
  // broad swells, a finer octave and a ridged one (1 - 2|n|): sharp crests of rock between smooth hollows,
  // so the walls read as broken stone rather than as a smooth tube
  const noise = (x: number, y: number, z: number) => n3(x * 0.28, y * 0.34, z * 0.28) * 0.5 + n3(x * 0.95 + 17, y * 0.95, z * 0.95) * 0.22
    + (1 - 2 * Math.abs(n3(x * 0.55 - 31, y * 0.7, z * 0.55))) * 0.28;
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
      // ledges: the wall leans in a little up each bed (~1.2 m, its level warped by the noise) and steps back
      // over the next 0.2 m (continuous, so the surface nets stay on it), so the walls stand in shelves and overhangs like bedded rock
      const bed = (y - k.y) / 1.2 + 0.3 * N, fr = bed - Math.floor(bed), ledge = ((fr < 0.82 ? fr / 0.82 : (1 - fr) / 0.18) - 0.5) * LEDGE * Math.min(1, m / 4) * Math.min(1, Math.max(0, (y - k.y - 0.3) / 0.6));
      return Math.max((rho - 1) * m + k.noise * N + ledge, y - ceil + k.noise * 0.8 * N, floor - y);
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

/**
 * The rock as an indexed soup: positions and normals (3 per vertex), triangles (3 vertex indices each) and
 * each vertex's openness (rockOpenness: 1 in the open, towards 0 deep in a recess).
 */
export interface CaveSoup { pos: ArrayLike<number>; nor: ArrayLike<number>; tris: ArrayLike<number>; open: ArrayLike<number> }
const cache = new Map<string, CaveSoup>();
const keyOf = (P: CavePlan, seed: number) => `${seed}:${JSON.stringify([P.chambers, P.passages])}`;
/** The cave rock as an indexed soup (cached by plan; caveOffThread.ts can make it in a worker and prime the cache). */
export function caveRock(P: CavePlan, seed: number): CaveSoup {
  const key = keyOf(P, seed);
  let r = cache.get(key);
  if (!r) {
    const F = caveField(P, seed), S = surfaceNets(F.f, F.lo, F.hi, CAVE_CELL, behindPortal(P));
    r = { ...S, open: rockOpenness(F.f, S.pos, S.nor) };
    primeCaveRock(P, seed, r);
  }
  return r;
}
/** Sample directions round the normal for rockOpenness: the normal and four 55° off it. */
const OPEN_TILT = Math.sin((55 * Math.PI) / 180), OPEN_UP = Math.cos((55 * Math.PI) / 180), OPEN_D = [0.45, 1.0, 1.9];
/**
 * How open each vertex is, 0..1: the share of points out along the normal and four directions round it, at
 * 0.45, 1 and 1.9 m, that are in the air (soft over ±0.15 m of the field). Shelf undersides, niches, the
 * corners where floor meets wall and narrow passages come out low: baked darkness for the recesses.
 */
export function rockOpenness(f: (x: number, y: number, z: number) => number, pos: ArrayLike<number>, nor: ArrayLike<number>): Float32Array {
  const n = pos.length / 3, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p: V3 = [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]], N: V3 = [nor[3 * i], nor[3 * i + 1], nor[3 * i + 2]];
    const t1 = norm3(Math.abs(N[1]) < 0.9 ? cross3(N, [0, 1, 0]) : cross3(N, [1, 0, 0])), t2 = cross3(N, t1);
    let air = 0, cnt = 0;
    for (let d = 0; d < 5; d++) {
      const [a, b] = d === 0 ? [0, 0] : [[1, 0], [-1, 0], [0, 1], [0, -1]][d - 1];
      const dir: V3 = d === 0 ? N : [N[0] * OPEN_UP + (t1[0] * a + t2[0] * b) * OPEN_TILT, N[1] * OPEN_UP + (t1[1] * a + t2[1] * b) * OPEN_TILT, N[2] * OPEN_UP + (t1[2] * a + t2[2] * b) * OPEN_TILT];
      for (const s of OPEN_D) {
        const v = f(p[0] + dir[0] * s, p[1] + dir[1] * s, p[2] + dir[2] * s);
        air += Math.max(0, Math.min(1, 0.5 - v / 0.3)); cnt++;
      }
    }
    out[i] = air / cnt;
  }
  return out;
}

/** Hand the cache a soup made elsewhere (the worker) for this plan and seed. */
export function primeCaveRock(P: CavePlan, seed: number, soup: CaveSoup) {
  if (cache.size > 4) cache.clear();
  cache.set(keyOf(P, seed), soup);
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
  for (let t = 0; t < R.tris.length; t += 3) {
    const ids = [R.tris[t], R.tris[t + 1], R.tris[t + 2]], p = ids.map(fix), n = ids.map(nrm);
    // face the air: surface nets wind every quad the same way round (into the rock), so reversing all of them
    // is consistent over the whole closed surface. (Winding each triangle by its vertices' normals instead
    // flipped ~150 triangles at sharp creases, where the field's gradient points across the fold: they were
    // culled and showed as slivers of nothing.)
    const e1 = sub3(p[2], p[0]), e2 = sub3(p[1], p[0]), fn = cross3(e1, e2);
    const tri = [0, 2, 1];
    // partly the facet's own normal: crisper broken faces, most of the field's so they do not read as low-poly
    const face = norm3(fn);
    const facet = (v: V3) => norm3([face[0] * FACETED + v[0] * (1 - FACETED), face[1] * FACETED + v[1] * (1 - FACETED), face[2] * FACETED + v[2] * (1 - FACETED)]);
    rock.triN(tri.map((i) => p[i]), tri.map((i) => facet(n[i])), tri.map((i) => [R.open[ids[i]], 0] as [number, number]));
  }
  const rockTris = R.tris.length / 3, part0 = rock.pos.length / 3;
  for (const pt of portals) collar(rock, pt, P);
  for (const p of P.passages) if (p.steps) steps(B, p, seed);
  for (const k of P.chambers) if (k.pool) pool(B.bins.pool, k);
  for (const b of fallenBlocks(P, seed)) boulder(rock, b);
  for (const sp of speleothems(R, P, seed)) cone(rock, sp);
  const spots = fungi(B.bins.glow, R, P, seed);
  for (const f of P.features) feature(B, f, seed);
  bakePartOpenness(rock, part0, caveField(P, seed).f);
  bakeFungiLight(rock, spots);
  return { rock: rockTris };
}

/**
 * The rock that is not the soup (collars, steps, blocks, cones) takes its openness from the same field as
 * the soup round it: with one fixed value a block against a recess wall showed as a lighter, hard-edged
 * patch wherever it came out of the rock.
 */
export function bakePartOpenness(bin: { pos: number[]; nor: number[]; uv: number[] }, from: number, f: (x: number, y: number, z: number) => number) {
  const open = rockOpenness(f, bin.pos.slice(3 * from), bin.nor.slice(3 * from));
  open.forEach((o, i) => { bin.uv[2 * (from + i)] = o; });
}

/** How far the fungi's own light reaches over the rock round a cluster (m, gaussian radius). */
export const FUNGI_REACH = 0.38;
/**
 * The fungi's faint light on the rock round each cluster, baked into the rock's uv v (the rock material
 * reads it as teal light): a gaussian of the distance from each cluster, on faces turned its way. No quads
 * of their own, so nothing to show an edge from any side. Everything in the rock bin gets it (blocks and
 * stalagmites by a cluster too).
 */
export function bakeFungiLight(bin: { pos: number[]; nor: number[]; uv: number[] }, spots: { p: V3; n: V3 }[]) {
  const cell = 2 * FUNGI_REACH, grid = new Map<string, number[]>(), key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  spots.forEach((s, i) => { const k = key(s.p[0], s.p[1], s.p[2]); if (!grid.has(k)) grid.set(k, []); grid.get(k)!.push(i); });
  for (let v = 0; v < bin.pos.length / 3; v++) {
    const x = bin.pos[3 * v], y = bin.pos[3 * v + 1], z = bin.pos[3 * v + 2];
    let g = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      for (const i of grid.get(key(x + a * cell, y + b * cell, z + c * cell)) ?? []) {
        const s = spots[i], dx = x - s.p[0], dy = y - s.p[1], dz = z - s.p[2];
        const facing = bin.nor[3 * v] * s.n[0] + bin.nor[3 * v + 1] * s.n[1] + bin.nor[3 * v + 2] * s.n[2];
        g += Math.exp(-(dx * dx + dy * dy + dz * dz) / (FUNGI_REACH * FUNGI_REACH)) * Math.max(0, Math.min(1, facing + 0.6));
      }
    }
    bin.uv[2 * v + 1] = Math.min(1, g);
  }
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
  for (const [i, j, k] of tris) bin.tri(W(all[i][0], all[i][1]), W(all[j][0], all[j][1]), W(all[k][0], all[k][1]), n, PART, PART, PART);
}
/** The uv of rock not from the soup (collars, steps, blocks, cones) until bakePartOpenness and bakeFungiLight. */
const PART: [number, number] = [0.8, 0];

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
    const quad = (a: V3, b: V3, e: V3, f: V3, nn: V3) => { bin.tri(a, b, e, nn, PART, PART, PART); bin.tri(a, e, f, nn, PART, PART, PART); };
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
export function fungiSpots(R: { pos: ArrayLike<number>; nor: ArrayLike<number> }, P: CavePlan, seed: number): { p: V3; n: V3 }[] {
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
    if (Math.abs(ny) > 0.55 || r() > 0.035) continue;
    const p: V3 = [R.pos[3 * i], R.pos[3 * i + 1], R.pos[3 * i + 2]];
    if (!near(p[0], p[2], p[1])) continue;
    out.push({ p, n: [R.nor[3 * i], ny, R.nor[3 * i + 2]] });
  }
  return out;
}
/**
 * Each spot: a cluster of tiny stalked caps (uv v = 1 on the cap's crown, 0 at its rim and stem, so the glow
 * shader brightens the crowns). Their light on the rock round them is baked into the rock (bakeFungiLight).
 * Returns the spots.
 */
function fungi(bin: Bin, R: CaveSoup, P: CavePlan, seed: number) {
  const r = mulberry32(hashSeed('cave-fungi-caps', seed)), spots = fungiSpots(R, P, seed);
  for (const s of spots) {
    const n = norm3(s.n), t1 = norm3(cross3(n, [0, 1, 0])), t2 = cross3(n, t1);
    const at = (u: number, v: number, w: number): V3 => [s.p[0] + t1[0] * u + t2[0] * v + n[0] * w, s.p[1] + t1[1] * u + t2[1] * v + n[1] * w, s.p[2] + t1[2] * u + t2[2] * v + n[2] * w];
    const caps = 6 + Math.floor(r() * 9);
    for (let c = 0; c < caps; c++) {
      const u = (r() - 0.5) * 0.24, v = (r() - 0.5) * 0.2, rad = 0.01 + r() * r() * 0.03, stem = rad * (1.2 + r() * 1.5);
      const root = at(u, v, 0.005), up = norm3([n[0] * 0.7, 1, n[2] * 0.7]);
      const top: V3 = [root[0] + up[0] * stem, root[1] + up[1] * stem, root[2] + up[2] * stem];
      const a1 = norm3(cross3(up, t1)), a2 = cross3(up, a1);
      const ring = (o: V3, rr: number) => Array.from({ length: 6 }, (_, i) => { const t = (i / 6) * Math.PI * 2; return [o[0] + (a1[0] * Math.cos(t) + a2[0] * Math.sin(t)) * rr, o[1] + (a1[1] * Math.cos(t) + a2[1] * Math.sin(t)) * rr, o[2] + (a1[2] * Math.cos(t) + a2[2] * Math.sin(t)) * rr] as V3; });
      const sr = ring(root, rad * 0.25), st = ring(top, rad * 0.25), cr = ring(top, rad);
      const crown: V3 = [top[0] + up[0] * rad * 0.6, top[1] + up[1] * rad * 0.6, top[2] + up[2] * rad * 0.6];
      for (let i = 0; i < 6; i++) {
        const j = (i + 1) % 6, out = norm3(sub3(cr[i], top));
        bin.tri(sr[i], sr[j], st[j], out, [0, 0], [0, 0], [0, 0]); bin.tri(sr[i], st[j], st[i], out, [0, 0], [0, 0], [0, 0]); // stem
        bin.tri(crown, cr[i], cr[j], up, [0.5, 1], [0, 0.2], [1, 0.2]); // cap
        bin.tri(top, cr[j], cr[i], [-up[0], -up[1], -up[2]], [0.5, 0], [0, 0.1], [1, 0.1]); // gills
      }
    }
  }
  return spots;
}

// ---------------------------------------------------------------- broken stone

/** Chambers that get fallen blocks and stalactites / stalagmites. */
const STONE_ROOMS = new Set(['cave-cavern', 'cave-hall', 'cave-well', 'cave-ossuary']);
/** Clear of a chamber's walks (from each of its passage mouths to its centre), its pool and its finds by `m` m. */
function clearOfWalks(P: CavePlan, k: CaveChamber, q: V2, m: number) {
  const segDist = (a: V2, b: V2) => {
    const d: V2 = [b[0] - a[0], b[1] - a[1]], L2 = d[0] * d[0] + d[1] * d[1] || 1;
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1]) / L2));
    return Math.hypot(q[0] - a[0] - d[0] * t, q[1] - a[1] - d[1] * t);
  };
  for (const p of P.passages) for (const e of [0, 1] as const) if (p.ends[e] === k.id) {
    const end = e === 0 ? p.from : p.to;
    if (segDist([end[0], end[2]], k.c) < m) return false;
  }
  if (k.pool && Math.hypot(q[0] - k.pool.c[0], q[1] - k.pool.c[1]) < k.pool.r + m) return false;
  return !P.features.some((f) => Math.hypot(q[0] - f.at[0], q[1] - f.at[2]) < 1.6 + m);
}
/** Where a point lies in a chamber's plan: 0 at the centre, 1 on the ellipse. */
function rhoOf(k: CaveChamber, q: V2) {
  const dx = q[0] - k.c[0], dz = q[1] - k.c[1];
  return Math.hypot((dx * k.axis[0] + dz * k.axis[1]) / k.a, (-dx * k.axis[1] + dz * k.axis[0]) / k.b);
}

export interface Boulder { c: V3; size: V3; yaw: number; seed: number }
/** Blocks fallen from the roof along a chamber's walls, clear of its walks: rough lumps half sunk in the floor. */
export function fallenBlocks(P: CavePlan, seed: number): Boulder[] {
  const r = mulberry32(hashSeed('cave-blocks', seed)), out: Boulder[] = [];
  for (const k of P.chambers) if (STONE_ROOMS.has(k.id)) {
    const want = Math.round((k.a * k.b) / 9);
    for (let i = 0, tries = 0; i < want && tries < 200; tries++) {
      const t = r() * Math.PI * 2, rho = 0.5 + r() * 0.36, s = 0.35 + r() * r() * 1.0;
      const q: V2 = [k.c[0] + (k.axis[0] * Math.cos(t) * k.a - k.axis[1] * Math.sin(t) * k.b) * rho, k.c[1] + (k.axis[1] * Math.cos(t) * k.a + k.axis[0] * Math.sin(t) * k.b) * rho];
      if (!clearOfWalks(P, k, q, 1.0 + s)) continue;
      if (out.some((o) => Math.hypot(o.c[0] - q[0], o.c[2] - q[1]) < (o.size[0] + s) * 0.9)) continue;
      const sy = s * (0.5 + r() * 0.4);
      out.push({ c: [q[0], k.y + sy * 0.25, q[1]], size: [s, sy, s * (0.6 + r() * 0.5)], yaw: r() * Math.PI, seed: Math.floor(r() * 1e9) });
      i++;
    }
  }
  return out;
}
// an icosahedron, the blocks' template
const ICO_V: V3[] = (() => { const t = (1 + Math.sqrt(5)) / 2; return ([[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]] as V3[]).map((v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l] as V3; }); })();
const ICO_F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
function boulder(bin: Bin, b: Boulder) {
  const r = mulberry32(b.seed), cy = Math.cos(b.yaw), sy = Math.sin(b.yaw);
  const v = ICO_V.map((p): V3 => {
    const j = 0.75 + r() * 0.45, x = p[0] * b.size[0] * 0.5 * j, y = p[1] * b.size[1] * 0.5 * j, z = p[2] * b.size[2] * 0.5 * j;
    return [b.c[0] + x * cy - z * sy, b.c[1] + y, b.c[2] + x * sy + z * cy];
  });
  for (const [i, j, k] of ICO_F) {
    const m: V3 = [(v[i][0] + v[j][0] + v[k][0]) / 3 - b.c[0], (v[i][1] + v[j][1] + v[k][1]) / 3 - b.c[1], (v[i][2] + v[j][2] + v[k][2]) / 3 - b.c[2]];
    bin.tri(v[i], v[j], v[k], norm3(m), PART, PART, PART);
  }
}

export interface Speleothem { base: V3; dir: 1 | -1; len: number; r: number; lean: V2 }
/** The lowest a stalactite's tip comes over a chamber's floor (the walks keep their headroom everywhere). */
export const TIP_CLEAR = 2.4;
/**
 * Stalactites from the chambers' roofs (on the rock's downward-facing vertices, their tips never lower than
 * TIP_CLEAR over the floor) and stalagmites on the floor near the walls, clear of the walks.
 */
export function speleothems(R: { pos: ArrayLike<number>; nor: ArrayLike<number> }, P: CavePlan, seed: number): Speleothem[] {
  const r = mulberry32(hashSeed('cave-speleothems', seed)), out: Speleothem[] = [];
  const ks = P.chambers.filter((k) => STONE_ROOMS.has(k.id));
  for (let i = 0; i < R.pos.length / 3; i++) {
    if (R.nor[3 * i + 1] > -0.8 || r() > 0.09) continue;
    const p: V3 = [R.pos[3 * i], R.pos[3 * i + 1], R.pos[3 * i + 2]];
    const k = ks.find((c) => rhoOf(c, [p[0], p[2]]) < 0.95 && p[1] > c.y + TIP_CLEAR + 0.3);
    if (!k) continue;
    const room = p[1] - (k.y + TIP_CLEAR), len = Math.min(room, 0.25 + r() * r() * 1.4);
    if (len < 0.2) continue;
    out.push({ base: [p[0], p[1] + 0.12, p[2]], dir: -1, len: len + 0.12, r: 0.04 + len * (0.08 + r() * 0.06), lean: [(r() - 0.5) * 0.08, (r() - 0.5) * 0.08] });
  }
  for (const k of ks) {
    const want = Math.round((k.a * k.b) / 5);
    for (let i = 0, tries = 0; i < want && tries < 200; tries++) {
      const t = r() * Math.PI * 2, rho = 0.62 + r() * 0.3;
      const q: V2 = [k.c[0] + (k.axis[0] * Math.cos(t) * k.a - k.axis[1] * Math.sin(t) * k.b) * rho, k.c[1] + (k.axis[1] * Math.cos(t) * k.a + k.axis[0] * Math.sin(t) * k.b) * rho];
      if (!clearOfWalks(P, k, q, 1.2)) continue;
      const len = 0.2 + r() * r() * 0.9;
      out.push({ base: [q[0], k.y - 0.1, q[1]], dir: 1, len: len + 0.1, r: 0.05 + len * (0.1 + r() * 0.08), lean: [(r() - 0.5) * 0.06, (r() - 0.5) * 0.06] });
      i++;
    }
  }
  return out;
}
function cone(bin: Bin, s: Speleothem) {
  const tip: V3 = [s.base[0] + s.lean[0] * s.len, s.base[1] + s.dir * s.len, s.base[2] + s.lean[1] * s.len], n = 7;
  const ring = Array.from({ length: n }, (_, i) => { const t = (i / n) * Math.PI * 2 + s.base[0]; return [s.base[0] + Math.cos(t) * s.r, s.base[1], s.base[2] + Math.sin(t) * s.r] as V3; });
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n], m: V3 = [(a[0] + b[0]) / 2 - s.base[0], 0, (a[2] + b[2]) / 2 - s.base[2]];
    bin.tri(a, b, tip, norm3([m[0], s.dir * s.r * 0.3 / s.len, m[2]]), PART, PART, PART);
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
  } else if (f.kind === 'fire') {
    // the smugglers' fire: a ring of stones, charred logs crossed in it (the flame and its light: caveFires)
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + r() * 0.3, s = 0.17 + r() * 0.08;
      boulder(B.bins.rock, { c: P(Math.cos(a) * 0.5, Math.sin(a) * 0.5, s * 0.15), size: [s, s * 0.7, s * 0.9], yaw: r() * Math.PI, seed: Math.floor(r() * 1e9) });
    }
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI + r() * 0.4;
      B.box('wood', P(0, 0, 0.05 + i * 0.07), [0.75, 0.08, 0.09], [Math.cos(a), Math.sin(a)], { bottom: false });
    }
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

/** The caves' fires for src/light: the smugglers' lantern, still burning on its crate, and their fire in the great cavern. */
export function caveFires(P: CavePlan, group: string): { emitters: LightEmitter[]; flames: Flame[]; group: string[] } {
  const out = { emitters: [] as LightEmitter[], flames: [] as Flame[], group: [] as string[] };
  for (const f of P.features) if (f.kind === 'lantern') {
    const b = cacheLayout(f.at, f.dir).lantern, base: V3 = [b[0], b[1] + 0.06, b[2]];
    out.flames.push({ kind: 'lantern', base, height: 0.09 });
    out.emitters.push({ kind: 'lantern', position: [base[0], base[1] + 0.08, base[2]], colour: [1, 0.93, 0.82], intensity: 0.6, flicker: 0.35 });
    out.group.push(group);
  }
  for (const f of P.features) if (f.kind === 'fire') {
    out.flames.push({ kind: 'brazier', base: [f.at[0], f.at[1] + 0.12, f.at[2]], height: 0.4 });
    out.emitters.push(fireEmitter(f.at));
    out.group.push(group);
  }
  return out;
}
/** The cavern fire's light: low and broad, a little above the logs. */
export const fireEmitter = (at: V3): LightEmitter => ({ kind: 'brazier', position: [at[0], at[1] + 0.5, at[2]], colour: [1, 0.86, 0.7], intensity: 1.3, flicker: 0.4 });

/**
 * What the cave shaders need of the plan: the pool's still water (centre, level and radius; r 0 if none),
 * for the wet rim and the water, and the cavern fire (position and candela-ish strength; 0 if none), for the
 * glints on wet rock and water. Uniforms in render/materials.ts caveMaterials.
 */
export function caveShading(P: CavePlan): { pool: [number, number, number, number]; fire: [number, number, number, number] } {
  const k = P.chambers.find((c) => c.pool), f = P.features.find((x) => x.kind === 'fire');
  const pool: [number, number, number, number] = k ? [k.pool!.c[0], poolDisc(k).y, k.pool!.c[1], k.pool!.r] : [0, -1e4, 0, 0];
  const e = f && fireEmitter(f.at);
  return { pool, fire: e ? [e.position[0], e.position[1], e.position[2], e.intensity] : [0, -1e4, 0, 0] };
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
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
