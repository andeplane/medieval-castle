// Injected randomness for the landscape generators. Every generator takes a GenDeps and asks it for
// named streams, so changing one part never reshuffles another and tests can pass simple fakes
// (constant or linear noise, a counting rng). `seededDeps` is the composition root used by the game.
import { createNoise2D, createNoise3D } from 'simplex-noise';
import { mulberry32, hashSeed, WORLD_SEED, type Rng } from '../core/rng';

export type Noise2D = (x: number, y: number) => number;
export type Noise3D = (x: number, y: number, z: number) => number;

export interface GenDeps {
  /** a fresh, independent random stream in [0, 1) for this name */
  rng(name: string): Rng;
  /** a 2-D noise source in [-1, 1] for this name */
  noise2(name: string): Noise2D;
  /** a 3-D noise source in [-1, 1] for this name */
  noise3(name: string): Noise3D;
}

/** Simplex noise and mulberry32 streams, each seeded by hashSeed(name, seed). */
export function seededDeps(seed = WORLD_SEED): GenDeps {
  return {
    rng: (name) => mulberry32(hashSeed(name, seed)),
    noise2: (name) => createNoise2D(mulberry32(hashSeed(name, seed))),
    noise3: (name) => createNoise3D(mulberry32(hashSeed(name, seed))),
  };
}
