// How fire wavers. Pure and deterministic in (profile, seed, time), so captures and tests are exact and
// two torches never pulse in step. Real flames have a slow breathing, a faster lick and an occasional
// gutter (a draught pulls the flame down and the room dims for a fraction of a second).
import type { FlameKind, V3 } from './types';

export interface FlameProfile {
  kind: FlameKind;
  kelvin: number;   // colour temperature of the light
  candela: number;  // per candle unit of emitter intensity
  range: number;    // metres where the light is cut off (smoothly)
  speed: number;    // time scale of the wavering
  amp: number;      // relative intensity swing at flicker = 1
  sway: number;     // metres the light centre wanders at flicker = 1
  gutter: number;   // chance per second of a gutter at flicker = 1
  soft: number;     // metres: the flame's size as a light, so nothing near it gets more than candela / soft²
}

// Brightness is tuned for the interior exposure (src/light/look.ts), not photometrically exact: a
// real candle is ~1 cd, but eyes adapt and the scene exposure is set for firelight. `kelvin` is the
// physical flame; the rig shows it as the adapted eye sees it (blackbody.seenKelvin). Fire lights cast
// no shadows, so `range` also bounds how far a torch shines through the walls into the next room:
// keep it about one room (a wall torch, intensity 3, reaches 4 × √3 ≈ 6.9 m).
export const PROFILES: Record<FlameKind, FlameProfile> = {
  candle: { kind: 'candle', kelvin: 1850, candela: 2.5, range: 3.5, speed: 1.0, amp: 0.7, sway: 0.015, gutter: 0.6, soft: 0.12 },
  torch: { kind: 'torch', kelvin: 1800, candela: 7.5, range: 4, speed: 1.25, amp: 0.85, sway: 0.06, gutter: 1.0, soft: 0.25 },
  lantern: { kind: 'lantern', kelvin: 1950, candela: 4, range: 5, speed: 0.8, amp: 0.4, sway: 0.004, gutter: 0.2, soft: 0.15 },
  brazier: { kind: 'brazier', kelvin: 1650, candela: 10, range: 7.5, speed: 0.7, amp: 0.65, sway: 0.08, gutter: 0.5, soft: 0.45 },
  hearth: { kind: 'hearth', kelvin: 1600, candela: 6, range: 6, speed: 0.55, amp: 0.55, sway: 0.15, gutter: 0.35, soft: 0.9 },
};

/** Integer hash → [0, 1). */
export function hash1(n: number): number {
  let h = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 1D value noise in [-1, 1] with integer lattice; `seed` picks the lattice. */
export function noise1(seed: number, x: number): number {
  const i = Math.floor(x), f = x - i, s = f * f * (3 - 2 * f);
  const a = hash1(i * 374761 + seed * 668265), b = hash1((i + 1) * 374761 + seed * 668265);
  return (a + (b - a) * s) * 2 - 1;
}

/** Stable seed for a position (so emitters without a seed still differ). */
export const seedOf = (p: V3) => Math.floor(hash1(Math.round(p[0] * 97) * 73856093 ^ Math.round(p[1] * 89) * 19349663 ^ Math.round(p[2] * 83) * 83492791) * 1e6);

/** How strongly an emitter wavers: its `flicker` (0..~0.25 in the prop kit) mapped to 0..1. */
export const flickerAmount = (emitterFlicker: number) => Math.min(1, Math.max(0, emitterFlicker * 4));

export interface FlickerSample { k: number; offset: V3 }

const GUTTER_WINDOW = 1.3; // seconds; at most one gutter per window

/**
 * Intensity multiplier `k` (mean ≈ 1, never below ~0.35) and light-centre offset at time t (seconds).
 * `flicker` (0..1) is the emitter's own scale; 0 gives a steady light (also used for reduced motion).
 */
export function flicker(p: FlameProfile, seed: number, t: number, amount = 1): FlickerSample {
  if (amount <= 0) return { k: 1, offset: [0, 0, 0] };
  const T = t * p.speed;
  const breathe = noise1(seed, T * 0.9), lick = noise1(seed + 1, T * 4.3), crackle = noise1(seed + 2, T * 13);
  let k = 1 + p.amp * amount * (0.45 * breathe + 0.35 * lick + 0.2 * crackle) * 0.5;
  // gutter: within each window a draught may pull the flame down for ~0.25 s
  const w = Math.floor(T / GUTTER_WINDOW), local = T / GUTTER_WINDOW - w;
  if (hash1(w * 31 + seed * 7) < p.gutter * amount * GUTTER_WINDOW * 0.35) {
    const start = 0.15 + 0.6 * hash1(w * 17 + seed * 3), len = 0.2;
    const u = (local - start) / len;
    if (u > 0 && u < 1) k *= 1 - 0.38 * amount * Math.sin(Math.PI * u) * (0.6 + 0.4 * hash1(w + seed));
  }
  const s = p.sway * amount;
  return { k: Math.max(0.35, k), offset: [s * noise1(seed + 3, T * 1.7), s * 0.5 * noise1(seed + 4, T * 2.3), s * noise1(seed + 5, T * 1.9)] };
}
