// Generated prop textures (CPU, typed arrays, tileable), like src/render/texgen.ts for the castle.
// Albedos are near-neutral so vertex tints give the colour: one wood texture serves oak, dark oak and
// weathered grey boards; one weave serves linen, wool and leather.
import { TileNoise } from '../render/texgen';
import { hashSeed } from '../core/rng';

export interface PropTex { size: number; albedo: Uint8Array; normal: Uint8Array; rough: Uint8Array }

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
    const warp = n.fbm(u, v, 4, 3) * 0.6 + w * 0.8;
    const ring = Math.sin((v * 48 + warp * 3) * Math.PI * 2) * 0.5 + 0.5;
    const lane = (Math.floor(v * 256) + 0.5) / 256, pores = n.n(u, lane, 32) * 0.5 + 0.5; // streaks along the grain
    const blot = n.fbm(u + 0.3, v + 0.7, 2, 3) * 0.5 + 0.5;
    const k = (0.72 + 0.22 * Math.pow(ring, 3) + 0.08 * pores) * (0.8 + 0.35 * blot) * (1 - w * 0.5);
    return { c: [0.26 * k, 0.18 * k, 0.11 * k], h: 0.5 + ring * 0.25 - (pores < 0.25 ? 0.2 : 0) - w * 0.2, r: 0.62 + 0.25 * blot + (pores < 0.25 ? 0.1 : 0) };
  }, 2.5);
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
