// Generated prop textures (CPU, typed arrays, tileable), like src/render/texgen.ts for the castle.
// Albedos are near-neutral so vertex tints give the colour: one wood texture serves oak, dark oak and
// weathered grey boards; one weave serves linen, wool and leather.
import { TileNoise } from '../render/texgen';
import { hashSeed } from '../core/rng';
import { ATLAS } from './geom';

export interface PropTex { size: number; albedo: Uint8Array; normal: Uint8Array; rough: Uint8Array }

/**
 * The castle's own walls as their shader draws them (render/materials.ts stone(): the texgen albedo × its
 * tint, per-stone shade, mortar, grime, drift and the ambient occlusion), mean linear RGB under a uniform
 * light: rubble (old), ashlar (new) and dressed stone (trim). Measured 2026-11-08 by rendering a 4 × 4 m
 * patch of each at the hall's height with an ambient light of irradiance π, no tone mapping (headless
 * WebGL2). The prop stone is set against these (stoneTex), not against the raw lithology colours
 * (texgen LITH_COL ≈ 0.28), which the wall shader takes down to about 0.17.
 */
export const WALL_STONE = { old: [0.183, 0.172, 0.148], new: [0.204, 0.19, 0.162], trim: [0.24, 0.22, 0.183] } as const satisfies Record<string, readonly [number, number, number]>;

const toByte = (v: number) => Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, v), 1 / 2.2) * 255)));

/** Height field (0..1, wraps) to a tangent-space normal map. Row 0 is v = 0. */
export function normalFromHeight(h: Float32Array, N: number, strength: number) {
  const out = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const l = h[y * N + ((x + N - 1) % N)], r = h[y * N + ((x + 1) % N)];
    const d = h[((y + N - 1) % N) * N + x], u = h[((y + 1) % N) * N + x];
    let nx = (l - r) * strength, ny = (d - u) * strength, nz = 1;
    const il = 1 / Math.hypot(nx, ny, nz); nx *= il; ny *= il; nz *= il;
    const i = (y * N + x) * 4;
    out[i] = (nx * 0.5 + 0.5) * 255; out[i + 1] = (ny * 0.5 + 0.5) * 255; out[i + 2] = (nz * 0.5 + 0.5) * 255; out[i + 3] = 255;
  }
  return out;
}

type Px = (u: number, v: number) => { c: [number, number, number]; h: number; r: number };
function bake(N: number, f: Px, strength: number): PropTex {
  const albedo = new Uint8Array(N * N * 4), rough = new Uint8Array(N * N * 4), h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const p = f(x / N, y / N), i = y * N + x;
    albedo[i * 4] = toByte(p.c[0]); albedo[i * 4 + 1] = toByte(p.c[1]); albedo[i * 4 + 2] = toByte(p.c[2]); albedo[i * 4 + 3] = 255;
    const rr = Math.max(0, Math.min(255, Math.round(p.r * 255)));
    rough[i * 4] = rough[i * 4 + 1] = rough[i * 4 + 2] = rr; rough[i * 4 + 3] = 255;
    h[i] = p.h;
  }
  return { size: N, albedo, normal: normalFromHeight(h, N, strength), rough };
}

/** Oak with the grain along u (1 m tile): rings, rays, open pores, a few knots, darker worn patches. */
export function woodTex(N = 512): PropTex {
  const n = new TileNoise(hashSeed('prop-wood'));
  const knots = Array.from({ length: 5 }, (_, i) => [(n.n(i * 0.13, 0.5, 4) * 0.5 + 0.5), ((i * 0.37) % 1)]);
  return bake(N, (u, v) => {
    let w = 0;
    for (const [ku, kv] of knots) { const du = ((u - ku + 1.5) % 1) - 0.5, dv = ((v - kv + 1.5) % 1) - 0.5; w += Math.exp(-(du * du * 400 + dv * dv * 3000)); }
    // soft, wide growth rings (about 2 cm apart on a quarter-sawn board) and fine pores, low contrast:
    // scrubbed oak at walking distance, not stripes (Anders, WebGPU 2026-11-08: the old 48 rings/m at
    // high contrast and a stepped pore height read as black-and-white zebra on table tops)
    const warp = n.fbm(u, v, 4, 3) * 0.6 + w * 0.8;
    const ring = Math.sin((v * 22 + warp * 0.8) * Math.PI * 2) * 0.5 + 0.5; // nearly straight: quarter-sawn boards
    const lane = (Math.floor(v * 256) + 0.5) / 256, pores = n.n(u, lane, 32) * 0.5 + 0.5; // fine streaks along the grain
    const blot = n.fbm(u + 0.3, v + 0.7, 2, 3) * 0.5 + 0.5;
    const k = (0.84 + 0.1 * ring * ring + 0.06 * pores) * (0.88 + 0.22 * blot) * (1 - w * 0.4);
    return { c: [0.26 * k, 0.18 * k, 0.11 * k], h: 0.5 + ring * 0.08 + pores * 0.05 - w * 0.15, r: 0.66 + 0.2 * blot + 0.04 * (1 - pores) };
  }, 1.5);
}

/** Wrought iron: near-black with hammer dents and rust in blotches (0.5 m tile). */
export function ironTex(N = 256): PropTex {
  const n = new TileNoise(hashSeed('prop-iron'));
  return bake(N, (u, v) => {
    const dent = n.fbm(u, v, 16, 3), rust = Math.max(0, n.fbm(u + 0.4, v, 8, 4) - 0.3) * 1.6, fine = n.n(u, v, 128);
    const k = 0.9 + 0.15 * dent;
    const c: [number, number, number] = [0.05 * k + 0.2 * rust, 0.05 * k + 0.09 * rust, 0.055 * k + 0.04 * rust];
    return { c, h: 0.5 + dent * 0.3 + fine * 0.05, r: Math.min(1, 0.45 + rust * 0.6 + fine * 0.05) };
  }, 3);
}

/** Plain weave (0.5 m tile, ~40 threads per tile), off-white so tints read true. */
export function clothTex(N = 512): PropTex {
  const n = new TileNoise(hashSeed('prop-cloth'));
  const T = 64;
  return bake(N, (u, v) => {
    const a = (u * T) % 1, b = (v * T) % 1, cu = Math.floor(u * T), cv = Math.floor(v * T);
    const over = (cu + cv) % 2 === 0;
    const thread = over ? Math.sin(a * Math.PI) : Math.sin(b * Math.PI);
    const slub = (over ? n.n(u, (cv + 0.5) / T, 16) : n.n(v, (cu + 0.5) / T, 16)) * 0.5 + 0.5; // uneven thread thickness
    const dirt = n.fbm(u, v, 4, 4) * 0.5 + 0.5;
    const k = (0.62 + 0.24 * thread) * (0.88 + 0.15 * slub) * (0.85 + 0.2 * dirt);
    return { c: [k, k * 0.97, k * 0.92], h: thread * 0.6 + slub * 0.2, r: 0.85 + 0.1 * (1 - thread) };
  }, 2);
}

/** Straw and rush: long blades along u, golden to grey. */
export function strawTex(N = 512): PropTex {
  const n = new TileNoise(hashSeed('prop-straw'));
  return bake(N, (u, v) => {
    const lane = (Math.floor(v * 128) + 0.5) / 128, lane2 = (Math.floor(v * 96 + 0.5) % 96 + 0.5) / 96;
    const blade = n.n(u, lane, 8) * 0.5 + 0.5, blade2 = n.n(u + 0.5, lane2, 16) * 0.5 + 0.5, dark = n.fbm(u, v, 8, 3) * 0.5 + 0.5;
    const k = 0.55 + 0.45 * Math.max(blade, blade2 * 0.9);
    const g = 0.7 + 0.3 * dark;
    return { c: [0.52 * k * g, 0.42 * k * g, 0.2 * k * g], h: Math.max(blade, blade2), r: 0.8 };
  }, 4);
}

/** Lead-glazed earthenware: soft mottling and pin holes. */
export function ceramicTex(N = 256): PropTex {
  const n = new TileNoise(hashSeed('prop-ceramic'));
  return bake(N, (u, v) => {
    const m = n.fbm(u, v, 8, 4) * 0.5 + 0.5, pin = n.n(u, v, 128) > 0.75 ? 1 : 0;
    const k = 0.85 + 0.25 * m - pin * 0.3;
    return { c: [0.8 * k, 0.78 * k, 0.74 * k], h: 0.5 + m * 0.1 - pin * 0.2, r: 0.35 + 0.3 * (1 - m) + pin * 0.3 };
  }, 1.5);
}

/** Polished metal, near white so tints give brass, gilt, copper, steel or a foxed mirror: fine hammer
 * dents, tarnish in blotches (darker, rougher), and a soft polish where hands rub. */
export function brassTex(N = 256): PropTex {
  const n = new TileNoise(hashSeed('prop-brass'));
  return bake(N, (u, v) => {
    const dent = n.fbm(u, v, 8, 3), tarn = Math.max(0, n.fbm(u + 0.3, v + 0.6, 4, 4) - 0.15) * 1.8, fine = n.n(u, v, 64);
    const k = (0.82 + 0.08 * dent) * (1 - 0.45 * tarn);
    return { c: [k, k * 0.98, k * 0.95], h: 0.5 + dent * 0.15 + fine * 0.04, r: Math.min(1, 0.26 + tarn * 0.45 + 0.04 * fine) };
  }, 1.5);
}

/** Dressed stone (1 m tile): fine grain, bedding, claw-tool striations, soot and wear; warm so tints give grey
 * limestone, sandstone or a dark polished marble. Its mean (linear ≈ 0.185) is set against the walls as they
 * render (WALL_STONE): a little lighter than the rubble, no lighter than the ashlar, so hearths and altars sit
 * in them. (#73 set it to the raw lithology colours, ≈ 0.3, which the wall shader takes down to ≈ 0.17: the
 * hall's hood rendered 1.6 × its wall on the albedo alone, and twice it lit, near-white.) */
export function stoneTex(N = 512): PropTex {
  const n = new TileNoise(hashSeed('prop-stone'));
  return bake(N, (u, v) => {
    // ashlar blocks: three courses per metre, half-bond, thin lime joints
    const cy = v * 3, row = Math.floor(cy), bx = u * 2 + (row % 2) * 0.5, fy = cy - row, fx = bx - Math.floor(bx);
    const joint = Math.min(fy, 1 - fy) / 3 < 0.004 || Math.min(fx, 1 - fx) / 2 < 0.004;
    const block = n.n((Math.floor(bx) + 0.5) / 2, (row + 0.5) / 3, 2) * 0.5 + 0.5; // each stone a shade apart
    const grain = n.n(u, v, 256) * 0.5 + 0.5, mottle = n.fbm(u, v, 4, 4) * 0.5 + 0.5;
    const claw = Math.sin((u * 3 + v * 2) * 160 + n.n(u, v, 32) * 4) * 0.5 + 0.5; // diagonal tooling
    const k = joint ? 0.5 + 0.1 * grain : (0.6 + 0.1 * mottle + 0.1 * block) * (0.9 + 0.1 * grain) * (0.97 + 0.03 * claw);
    return { c: [k * 0.296, k * 0.284, k * 0.259], h: joint ? 0.1 : 0.55 + grain * 0.15 + claw * 0.1 + mottle * 0.1, r: joint ? 0.95 : 0.8 + 0.1 * grain };
  }, 2.2);
}

// ---------------------------------------------------------------- the paint atlas
type C3 = [number, number, number];
const mixC = (a: C3, b: C3, t: number): C3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mulC = (a: C3, k: number): C3 => [a[0] * k, a[1] * k, a[2] * k];
const smooth = (e0: number, e1: number, x: number) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const RED: C3 = [0.34, 0.045, 0.035], NAVY: C3 = [0.035, 0.05, 0.13], IVORY: C3 = [0.6, 0.52, 0.37], GOLD: C3 = [0.52, 0.34, 0.09], GREEN: C3 = [0.07, 0.17, 0.1], DARK: C3 = [0.05, 0.035, 0.03];
interface Px2 { c: C3; h: number; r: number }

/** Turkey (Ushak-style) carpet in knots: ivory and gold guards, a navy border of rosettes, a red field
 * with a stepped lattice, a stepped navy medallion and corner spandrels. s across, t along, 0..1. */
export function turkeyCarpet(n: TileNoise, s: number, t: number): Px2 {
  const K = 120, ks = (Math.floor(s * K) + 0.5) / K, kt = (Math.floor(t * K) + 0.5) / K; // knot grid
  const e = Math.min(ks, 1 - ks, kt, 1 - kt), along = Math.min(ks, 1 - ks) < Math.min(kt, 1 - kt) ? kt : ks;
  let c: C3;
  if (e < 0.014) c = Math.floor(along * K) % 4 === 0 ? DARK : IVORY;
  else if (e < 0.022) c = DARK;
  else if (e < 0.08) {
    const a = ((along * 14) % 1) - 0.5, b = (e - 0.051) / 0.03, d = Math.abs(a) * 1.6 + Math.abs(b);
    c = d < 0.28 ? GOLD : d < 0.55 ? RED : d < 0.62 ? IVORY : Math.abs(Math.abs(a) - 0.5) * 1.6 + Math.abs(b) < 0.25 ? IVORY : NAVY;
  } else if (e < 0.088) c = DARK;
  else if (e < 0.1) c = GOLD;
  else if (e < 0.106) c = DARK;
  else {
    const x = ks - 0.5, y = kt - 0.5, m = Math.abs(x) / 0.25 + Math.abs(y) / 0.3;
    const star = Math.min(Math.abs(x) / 0.06 + Math.abs(y) / 0.07, Math.max(Math.abs(x) / 0.045, Math.abs(y) / 0.055));
    const hook = Math.abs(((Math.abs(x) * 0.6 + Math.abs(y) * 0.5) * 26) % 1 - 0.5) < 0.18; // stepped hooks on the rim
    const corner = Math.abs(Math.abs(x) - 0.5) / 0.3 + Math.abs(Math.abs(y) - 0.5) / 0.34; // spandrels
    if (m < 1.06 && (m < 1 || hook)) c = star < 1 ? (star < 0.5 ? RED : GOLD) : m < 0.42 ? RED : m < 0.47 ? IVORY : m < 0.93 ? (Math.abs(((Math.abs(x) + Math.abs(y)) * 30) % 1 - 0.5) < 0.1 && m > 0.55 ? GOLD : NAVY) : IVORY;
    else if (corner < 1.05 && (corner < 1 || hook)) c = corner < 0.93 ? (corner < 0.5 && Math.abs(((Math.abs(x) + Math.abs(y)) * 30) % 1 - 0.5) < 0.1 ? GOLD : NAVY) : IVORY;
    else {
      // Lotto lattice: gold stepped octagons and diagonals over the red, a navy cross in each cell
      const gx = ((ks * 8 + 0.5) % 1) - 0.5, gy = ((kt * 10 + 0.5) % 1) - 0.5, ax = Math.abs(gx), ay = Math.abs(gy);
      const oct = Math.max(ax, ay, (ax + ay) * 0.72);
      c = oct > 0.3 && oct < 0.36 ? GOLD : ax + ay < 0.1 && (ax < 0.035 || ay < 0.035) ? NAVY : Math.abs(ax - ay) < 0.035 && oct > 0.36 ? GOLD : ax + ay < 0.16 && oct < 0.3 ? mulC(RED, 0.78) : RED;
    }
  }
  // abrash (dye lots in bands along the length), wear down the middle, pile
  const abr = 1 + 0.1 * n.n(0.3, t * 3, 4), wear = 1 + 0.12 * smooth(0.3, 0, Math.abs(s - 0.5)) * smooth(0.45, 0.2, Math.abs(t - 0.5));
  const pile = n.n(s * 4, t * 4, 128) * 0.5 + 0.5;
  return { c: mulC(mixC(c, [0.45, 0.4, 0.33], (wear - 1) * 1.5), abr * (0.9 + 0.12 * pile)), h: 0.5 + pile * 0.4 - (e < 0.106 ? 0 : 0.05), r: 0.9 };
}

const SETT: [C3, number][] = [[RED, 26], [NAVY, 9], [RED, 4], [[0.62, 0.6, 0.55], 2], [RED, 4], [NAVY, 9], [RED, 8], [GREEN, 16], [[0.6, 0.48, 0.12], 2], [GREEN, 16], [RED, 8], [[0.02, 0.02, 0.02], 5]];
const SETT_LEN = SETT.reduce((a, [, k]) => a + k, 0);
const settAt = (i: number): C3 => { let k = ((i % SETT_LEN) + SETT_LEN) % SETT_LEN; for (const [c, w] of SETT) { if (k < w) return c; k -= w; } /* v8 ignore next */ return RED; };

/** Royal Stuart tartan in a 2/2 twill, about five setts across, with a narrow navy border. */
export function tartanCarpet(n: TileNoise, s: number, t: number): Px2 {
  const T = 512, x = Math.floor(s * T), y = Math.floor(t * T);
  const e = Math.min(s, 1 - s, t, 1 - t);
  const twill = (x + y) % 4 < 2;
  let c = twill ? settAt(x) : settAt(y);
  if (e < 0.03) c = e < 0.008 ? GOLD : NAVY;
  const fuzz = n.n(s * 4, t * 4, 256) * 0.5 + 0.5;
  return { c: mulC(c, 0.92 + 0.15 * fuzz), h: 0.5 + (twill ? 0.25 : -0.05) + fuzz * 0.2, r: 0.88 };
}

/** Corridor runner: s across (0..1), t along (repeats inside); red field, navy borders, gold lines. */
export function runnerCarpet(n: TileNoise, s: number, t: number): Px2 {
  const e = Math.min(s, 1 - s);
  let c: C3;
  if (e < 0.03) c = DARK; else if (e < 0.06) c = GOLD; else if (e < 0.19) {
    const a = ((t * 24) % 1) - 0.5, b = (e - 0.125) / 0.06;
    c = Math.abs(a) * 1.2 + Math.abs(b) < 0.45 ? RED : NAVY;
  } else if (e < 0.22) c = IVORY; else {
    const a = ((t * 8) % 1) - 0.5, b = s - 0.5, d = Math.abs(a) * 1.4 + Math.abs(b) * 1.1;
    c = d < 0.12 ? GOLD : d < 0.2 ? NAVY : d < 0.24 ? IVORY : RED;
  }
  const pile = n.n(s, t * 4, 64) * 0.5 + 0.5, wear = 1 + 0.15 * smooth(0.35, 0.05, Math.abs(s - 0.5));
  return { c: mulC(mixC(c, [0.42, 0.37, 0.3], (wear - 1) * 1.6), 0.9 + 0.12 * pile), h: 0.5 + pile * 0.4, r: 0.9 };
}

const FLESH: C3 = [0.56, 0.36, 0.25];
/** An old oil portrait (dark ground, a lit head and shoulders), x, y in 0..1 with y up. Soft edges and
 * a single light from the upper left, then yellowed varnish, a vignette and craquelure. */
export function portraitPx(n: TileNoise, i: number, x: number, y: number): Px2 {
  const look = [
    { ground: [0.12, 0.1, 0.06] as C3, coat: [0.025, 0.022, 0.02] as C3, collar: [0.62, 0.6, 0.52] as C3, hair: [0.07, 0.045, 0.03] as C3, long: false },
    { ground: [0.05, 0.08, 0.055] as C3, coat: [0.3, 0.035, 0.035] as C3, collar: FLESH, hair: [0.045, 0.028, 0.02] as C3, long: true },
    { ground: [0.07, 0.06, 0.05] as C3, coat: [0.33, 0.05, 0.035] as C3, collar: [0.5, 0.36, 0.1] as C3, hair: [0.3, 0.28, 0.25] as C3, long: false },
    { ground: [0.11, 0.075, 0.04] as C3, coat: [0.08, 0.1, 0.15] as C3, collar: [0.62, 0.6, 0.55] as C3, hair: [0.17, 0.1, 0.045] as C3, long: true },
  ][i % 4];
  const brush = n.fbm(x * 2, y * 2, 8, 3);
  const glow = Math.exp(-((x - 0.4) ** 2 * 5 + (y - 0.62) ** 2 * 4));
  let c = mulC(look.ground, 0.55 + 0.9 * glow + 0.25 * brush);
  // shoulders: sloping from the neck, cut by the frame at the bottom
  const sh = 0.43 - 0.55 * Math.pow(Math.max(0, Math.abs(x - 0.5) - 0.05), 1.4) * 1.4;
  const body = smooth(0.012, -0.012, y - sh);
  const lit = 0.45 + 0.7 * smooth(0.95, 0.15, x) * smooth(-0.2, 0.4, y);
  c = mixC(c, mulC(look.coat, lit * (0.85 + 0.3 * brush)), body);
  const wedge = Math.abs(x - 0.5) * 2.4 + (0.44 - y) * 0.8; // cravat, stock or neckline
  c = mixC(c, mulC(look.collar, 0.55 + 0.4 * smooth(0.7, 0.3, x)), body * smooth(0.34, 0.28, wedge) * smooth(0.2, 0.28, y));
  const neck = smooth(0.06, 0.04, Math.abs(x - 0.5)) * smooth(0.37, 0.4, y) * smooth(0.52, 0.48, y);
  c = mixC(c, mulC(FLESH, 0.45 + 0.3 * smooth(0.55, 0.45, x)), neck);
  // hair mass behind and around the head
  const hairE = ((x - 0.5) / (look.long ? 0.165 : 0.135)) ** 2 + ((y - (look.long ? 0.58 : 0.635)) / (look.long ? 0.21 : 0.15)) ** 2;
  const sides = Math.max(smooth(0.48, 0.52, y), smooth(0.085, 0.11, Math.abs(x - 0.5))); // falls past the cheeks, not under the chin
  c = mixC(c, mulC(look.hair, 0.6 + 0.6 * smooth(0.6, 0.35, x) + 0.2 * brush), smooth(1.08, 0.9, hairE) * sides);
  // the face: an ellipsoid lit from the upper left, with soft features
  const hx = (x - 0.5) / 0.115, hy = (y - 0.6) / 0.15, head = hx * hx + hy * hy;
  const nz = Math.sqrt(Math.max(0, 1 - head)), lam = Math.max(0, -hx * 0.5 + hy * 0.3 + nz * 0.8);
  let face = mulC(FLESH, 0.3 + 0.7 * lam);
  const brow = smooth(0.06, 0, Math.abs(y - 0.632)) * smooth(0.06, 0.02, Math.abs(Math.abs(x - 0.5) - 0.045));
  face = mulC(face, 1 - 0.35 * brow);
  const eyes = smooth(1.4, 0.4, Math.min(((x - 0.456) / 0.02) ** 2 + ((y - 0.612) / 0.009) ** 2, ((x - 0.544) / 0.02) ** 2 + ((y - 0.612) / 0.009) ** 2));
  face = mixC(face, [0.08, 0.05, 0.04], eyes * 0.75);
  face = mulC(face, 1 - 0.3 * smooth(0.012, 0, Math.abs(x - 0.515)) * smooth(0.54, 0.56, y) * smooth(0.6, 0.58, y)); // nose shadow
  face = mixC(face, [0.3, 0.1, 0.08], smooth(0.008, 0.002, Math.abs(y - 0.535)) * smooth(0.035, 0.02, Math.abs(x - 0.5)) * 0.8);
  face = mixC(face, mulC(look.hair, 0.8), smooth(0.25, 0.6, hy) * smooth(0.5, 0.9, head)); // hairline
  c = mixC(c, face, smooth(1.05, 0.92, head));
  // varnish yellowed and darkened, a vignette, craquelure
  const crack = Math.abs(n.fbm(x * 1.3, y * 1.7, 16, 3)) < 0.02 ? 0.82 : 1;
  const vig = 0.6 + 0.4 * smooth(0.75, 0.2, Math.hypot(x - 0.5, (y - 0.55) * 0.8));
  const k = vig * crack * 0.85;
  return { c: [c[0] * 0.95 * k, c[1] * 0.85 * k, c[2] * 0.62 * k], h: 0.5 + (crack < 1 ? -0.3 : 0) + brush * 0.08, r: 0.42 };
}

/** A varnished landscape: 0 a Highland glen with a stag, 1 a castle on a crag at sunset. */
export function scenePx(n: TileNoise, i: number, x: number, y: number): Px2 {
  const sky: C3 = i === 0 ? mixC([0.55, 0.48, 0.32], [0.22, 0.26, 0.3], smooth(0.5, 1, y)) : mixC([0.7, 0.42, 0.15], [0.25, 0.18, 0.2], smooth(0.45, 1, y));
  let c = mulC(sky, 0.9 + 0.15 * n.fbm(x * 2, y * 3, 4, 3));
  const far = 0.5 + 0.12 * n.fbm(x, 0.3, 4, 3) + 0.06 * Math.sin(x * 5 + i);
  if (y < far) c = mixC([0.2, 0.24, 0.3], sky, 0.35);
  const mid = 0.36 + 0.1 * n.fbm(x, 0.7, 3, 3) - 0.05 * Math.cos(x * 4);
  if (y < mid) c = mulC(i === 0 ? [0.16, 0.15, 0.07] : [0.12, 0.08, 0.06], 0.8 + 0.4 * n.fbm(x * 3, y * 3, 8, 3));
  const shore = 0.2 + 0.03 * Math.sin(x * 9) + 0.02 * n.fbm(x * 2, 0.4, 6, 2);
  if (i === 0 && y < shore && y > 0.14 && Math.abs(x - 0.45) < 0.3 + 0.05 * Math.sin(y * 40)) c = mixC(mulC(sky, 0.7), [0.12, 0.13, 0.14], 0.5 + 0.2 * n.n(x * 8, y * 30, 32)); // loch
  if (y < 0.12 + 0.04 * n.fbm(x, 0.1, 6, 3)) c = [0.04, 0.035, 0.02];
  if (i === 0) { // stag on a knoll, side on
    const bx = (x - 0.72) / 0.06, by = (y - 0.3) / 0.03;
    const stag = bx * bx + by * by < 1 || (Math.abs(x - 0.775) < 0.012 && y > 0.3 && y < 0.37) || (Math.abs(x - 0.68 + (y - 0.27) * 0.1) < 0.006 && y > 0.22 && y < 0.3) || (Math.abs(x - 0.76) < 0.006 && y > 0.22 && y < 0.3)
      || (y > 0.37 && y < 0.42 && Math.abs(Math.abs(x - 0.78) - (y - 0.37) * 0.8) < 0.005);
    if (stag) c = [0.05, 0.035, 0.025];
  } else { // castle on the crag
    const crag = 0.1 + 0.33 * smooth(0.42, 0.04, Math.abs(x - 0.63)) + 0.03 * n.fbm(x * 3, 0.2, 8, 3);
    if (y < crag) c = mulC([0.07, 0.055, 0.05], 0.8 + 0.4 * n.fbm(x * 4, y * 4, 8, 3));
    if (x > 0.55 && x < 0.7 && y < 0.53 && y > crag - 0.02) c = (x > 0.63 && y > 0.5) || Math.floor(x * 120) % 3 === 0 && y > 0.51 ? sky : [0.08, 0.06, 0.06];
    if (x > 0.6 && x < 0.63 && y < 0.6 && y > 0.4) c = [0.08, 0.06, 0.06];
  }
  const crack = Math.abs(n.fbm(x * 1.7 + i, y * 1.1, 16, 3)) < 0.022 ? 0.82 : 1;
  return { c: [c[0] * 0.7 * crack, c[1] * 0.62 * crack, c[2] * 0.46 * crack], h: 0.5 + (crack < 1 ? -0.3 : 0), r: 0.42 };
}

/** Pelt: long hair streaks along v, darker roots, mid brown so tints give bear, deer or wolf. */
export function furPx(n: TileNoise, x: number, y: number): Px2 {
  // short fibres: lanes across, each broken every ~1.5 cm along; tufts and a soft clumping on top
  const lane = (Math.floor(x * 96) + 0.5) / 96, fib = n.n(lane, y, 128) * 0.5 + 0.5, tuft = n.n(x, y, 24) * 0.5 + 0.5, clump = n.n(x, y, 8) * 0.5 + 0.5;
  const k = 0.42 + 0.33 * fib * (0.6 + 0.4 * tuft) + 0.25 * clump;
  return { c: [0.36 * k, 0.27 * k, 0.19 * k], h: 0.3 * clump + 0.7 * fib * tuft, r: 0.85 };
}

/** The paint atlas (geom ATLAS): every carpet, runner, canvas and pelt design in one non-tiling texture. */
export function paintAtlas(N = 1024): PropTex {
  const n = new TileNoise(hashSeed('prop-paint'));
  const inR = (u: number, v: number, r: number[]) => u >= r[0] && u < r[2] && v >= r[1] && v < r[3];
  const loc = (u: number, v: number, r: number[]): [number, number] => [(u - r[0]) / (r[2] - r[0]), (v - r[1]) / (r[3] - r[1])];
  return bake(N, (u, v) => {
    if (inR(u, v, ATLAS.carpet)) return turkeyCarpet(n, ...loc(u, v, ATLAS.carpet));
    if (inR(u, v, ATLAS.tartan)) return tartanCarpet(n, ...loc(u, v, ATLAS.tartan));
    if (inR(u, v, ATLAS.runner)) return runnerCarpet(n, ...loc(u, v, ATLAS.runner));
    for (const [i, r] of ATLAS.portraits.entries()) if (inR(u, v, r)) return portraitPx(n, i, ...loc(u, v, r));
    for (const [i, r] of ATLAS.scenes.entries()) if (inR(u, v, r)) return scenePx(n, i, ...loc(u, v, r));
    return furPx(n, ...loc(u, v, ATLAS.fur));
  }, 2);
}

/** Every prop texture (render.ts PropTextures); ~1 s of CPU, so the page has a worker make them. */
export const propTextures = () => ({ wood: woodTex(), iron: ironTex(), cloth: clothTex(), straw: strawTex(), ceramic: ceramicTex(), brass: brassTex(), stone: stoneTex(), paint: paintAtlas() });
