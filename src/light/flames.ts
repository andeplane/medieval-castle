// Flame instances for the sprite renderer: per-kind look parameters and the per-frame brightness of
// every flame, linked to the light it belongs to so a torch's flame and its light gutter together.
// Pure data; src/light/three.ts turns it into instanced buffers.
import type { Flame, FlameKind, LightEmitter, V3 } from './types';
import { PROFILES, flicker, flickerAmount, seedOf } from './flicker';

/** How a kind of flame looks: ragged edges, speed, HDR brightness, blue base, halo and smoke. */
export interface FlameLook { width: number; ragged: number; speed: number; bright: number; blue: number; halo: number; haloSize: number; smoke: number }
export const LOOKS: Record<FlameKind, FlameLook> = {
  candle: { width: 0.38, ragged: 0.12, speed: 0.9, bright: 3.2, blue: 1, halo: 0.22, haloSize: 7, smoke: 0 },
  torch: { width: 0.85, ragged: 0.7, speed: 1.35, bright: 4.2, blue: 0, halo: 0.16, haloSize: 3.4, smoke: 1 },
  lantern: { width: 0.4, ragged: 0.08, speed: 0.7, bright: 3.2, blue: 0.6, halo: 0.3, haloSize: 6, smoke: 0 },
  brazier: { width: 0.9, ragged: 0.5, speed: 1.1, bright: 2.6, blue: 0, halo: 0.14, haloSize: 3, smoke: 0.8 },
  hearth: { width: 1.1, ragged: 0.45, speed: 0.9, bright: 2.6, blue: 0.2, halo: 0.1, haloSize: 2.4, smoke: 0.6 },
};
export const KIND_INDEX: Record<FlameKind, number> = { candle: 0, torch: 1, lantern: 2, brazier: 3, hearth: 4 };

/** `amount` is the linked light's flicker amount (0..1), so the flame and its light move together. */
export interface FlameInstance { flame: Flame; seed: number; amount: number; up: V3; look: FlameLook }

const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/**
 * Give every flame a seed. A flame within `reach` of an emitter of the same kind takes that emitter's
 * seed, so it wavers with its light; others (a chandelier's candles share one light) get their own.
 */
export function linkFlames(flames: Flame[], emitters: LightEmitter[], reach = 0.45): FlameInstance[] {
  return flames.map((f) => {
    let best = -1, bd = reach * reach;
    emitters.forEach((e, i) => {
      if (e.kind !== f.kind) return;
      const d = (e.position[0] - f.base[0]) ** 2 + (e.position[1] - f.base[1]) ** 2 + (e.position[2] - f.base[2]) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    const seed = best >= 0 ? emitters[best].seed ?? seedOf(emitters[best].position) : seedOf(f.base);
    const amount = best >= 0 ? flickerAmount(emitters[best].flicker) : 0.5;
    // a real flame rises: a tilted torch's flame leans only a little with the stick
    const up = norm(f.up ? [f.up[0] * 0.3, 1, f.up[2] * 0.3] : [0, 1, 0]);
    return { flame: f, seed, amount, up, look: LOOKS[f.kind] };
  });
}

/** Brightness of every flame at time t into `out` (reused buffer). `motion` 0 holds them steady. */
export function flameBrightness(fs: FlameInstance[], t: number, motion: number, out = new Float32Array(fs.length)): Float32Array {
  fs.forEach((f, i) => { out[i] = flicker(PROFILES[f.flame.kind], f.seed, t, f.amount * motion).k; });
  return out;
}

/** Packed instance attributes: base xyz, up xyz, (height, width, seed, kind), look (ragged, speed, bright, blue), (halo, haloSize, smoke, 0). */
export function packFlames(fs: FlameInstance[]) {
  const n = fs.length;
  const base = new Float32Array(n * 3), up = new Float32Array(n * 3), shape = new Float32Array(n * 4), look = new Float32Array(n * 4), glow = new Float32Array(n * 4);
  fs.forEach((f, i) => {
    base.set(f.flame.base, i * 3); up.set(f.up, i * 3);
    shape.set([f.flame.height, f.flame.height * f.look.width, (f.seed % 9973) / 9973, KIND_INDEX[f.flame.kind]], i * 4);
    look.set([f.look.ragged, f.look.speed, f.look.bright, f.look.blue], i * 4);
    glow.set([f.look.halo, f.look.haloSize, f.look.smoke, 0], i * 4);
  });
  return { count: n, base, up, shape, look, glow, smokers: fs.filter((f) => f.look.smoke > 0).length };
}
