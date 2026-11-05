// Seeded randomness. Every generator takes its own sub-seed from hashSeed(name), so changing one
// part of the world never reshuffles another (game-building-generation / game-debug-tools).

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash mixed with the world seed. */
export function hashSeed(name: string, seed = WORLD_SEED): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const WORLD_SEED = Number(
  (typeof location !== 'undefined' && new URLSearchParams(location.search).get('seed')) || 1187,
);

export const rngFor = (name: string) => mulberry32(hashSeed(name));
export const range = (r: Rng, a: number, b: number) => a + (b - a) * r();
export const pick = <T>(r: Rng, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
