// Shared flame and light types. Props (src/props/kit.ts), the castle interiors and the loading screen
// all describe fire with these, and src/light/ turns them into flickering lights and flame sprites.
// Coordinates as everywhere: x east, y up, z south, metres.
export type V3 = [number, number, number];
export type RGB = [number, number, number];

/** What is burning. Picks the flicker, colour temperature, brightness and flame look. */
export type FlameKind = 'candle' | 'torch' | 'lantern' | 'brazier' | 'hearth';
export const FLAME_KINDS: readonly FlameKind[] = ['candle', 'torch', 'lantern', 'brazier', 'hearth'];

/** A visible flame: where its base sits, which way is up (torches lean), how tall it is. */
export interface Flame { kind: FlameKind; base: V3; height: number; up?: V3 }

/**
 * A light that fire casts. `intensity` is in candle units (one candle ≈ 1); the light rig converts it
 * to candela through the kind's profile. `flicker` 0..1 scales how much it wavers. `seed` keeps two
 * neighbouring torches out of step; it defaults to a hash of the position.
 */
export interface LightEmitter {
  kind: FlameKind; position: V3; colour: RGB; intensity: number; flicker: number; seed?: number;
  /** Optional falloff exponent (default 2, physical) and reach in metres (default from the kind and intensity).
   * A carried lantern uses a softer falloff, so the wall beside the eye does not burn out while the
   * passage ahead stays dark (player/lantern.ts). */
  decay?: number; range?: number;
}
