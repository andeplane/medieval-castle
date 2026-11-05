// The light rig: turns fire emitters into a fixed pool of flickering point lights. Engine-free; the
// three.js side is a LightFactory (src/light/three.ts) and tests pass a typed fake. Any number of
// viewers can drive it (`update` takes the eye), and visibility is injected, so room culling and
// NPC-carried torches slot in later without changes here.
import type { LightEmitter, RGB, V3 } from './types';
import { PROFILES, flicker, flickerAmount, seedOf } from './flicker';
import { kelvinToLinear } from './blackbody';
import { assign, emptyPool, type Candidate, type Pools, type Slot } from './budget';

/** One engine light. `set` is called every frame for every slot (intensity 0 = off). */
export interface LightHandle { set(position: V3, colour: RGB, candela: number, range: number): void }
export interface LightFactory { create(castShadow: boolean): LightHandle }

export interface RigOptions {
  /** Shadow-casting lights (each costs six depth passes). */
  shadows: number;
  /** Plain lights. */
  lights: number;
  fadeTime: number;
  keep: number;
  /** 0 = steady lights (prefers-reduced-motion). */
  motion: number;
}
export const DEFAULT_RIG: RigOptions = { shadows: 2, lights: 10, fadeTime: 0.35, keep: 1.25, motion: 1 };

export interface Source { emitter: LightEmitter; seed: number; candela: number; range: number; colour: RGB; mobile: boolean }

/** Resolve an emitter against its profile: candela, range, colour (emitter tint × black body). */
export function toSource(e: LightEmitter): Source {
  const p = PROFILES[e.kind], bb = kelvinToLinear(p.kelvin);
  const colour: RGB = [bb[0] * e.colour[0], bb[1] * e.colour[1], bb[2] * e.colour[2]];
  const m = Math.max(...colour);
  return { emitter: e, seed: e.seed ?? seedOf(e.position), candela: p.candela * e.intensity, range: p.range * Math.min(2, Math.sqrt(Math.max(0.25, e.intensity))), colour: [colour[0] / m, colour[1] / m, colour[2] / m], mobile: false };
}

export interface RigStats { sources: number; lit: number; shadowLit: number; candela: number }

export class LightRig {
  private sources: Source[] = [];
  private pools: Pools;
  private shadowHandles: LightHandle[];
  private plainHandles: LightHandle[];
  readonly options: RigOptions;

  constructor(factory: LightFactory, options: Partial<RigOptions> = {}) {
    this.options = { ...DEFAULT_RIG, ...options };
    this.pools = { shadow: emptyPool(this.options.shadows), plain: emptyPool(this.options.lights) };
    this.shadowHandles = this.pools.shadow.map(() => factory.create(true));
    this.plainHandles = this.pools.plain.map(() => factory.create(false));
  }

  /** Replace all sources (e.g. when a level's fixtures are placed). Returns their ids. */
  setEmitters(es: LightEmitter[]): number[] {
    this.sources = es.map(toSource);
    this.pools = { shadow: emptyPool(this.options.shadows), plain: emptyPool(this.options.lights) };
    return this.sources.map((_, i) => i);
  }
  /** Add one source (a torch an NPC carries, a fire lit later). Returns its id. */
  add(e: LightEmitter, mobile = false): number { this.sources.push({ ...toSource(e), mobile }); return this.sources.length - 1; }
  /** Move a source (carried torches). */
  move(id: number, p: V3) { this.sources[id].emitter = { ...this.sources[id].emitter, position: p }; }
  /** Dim or put out a source (0 = out). */
  setScale(id: number, s: number) { const src = this.sources[id]; src.candela = PROFILES[src.emitter.kind].candela * src.emitter.intensity * s; }
  get count() { return this.sources.length; }

  /** Flicker value of a source at time t, shared with the flame sprites so light and flame agree. */
  flickerOf(id: number, t: number) {
    const s = this.sources[id];
    return flicker(PROFILES[s.emitter.kind], s.seed, t, flickerAmount(s.emitter.flicker) * this.options.motion);
  }

  /** Pick lights for a viewer at `eye` and push this frame's values into the engine lights. */
  update(t: number, dt: number, eye: V3, visible?: (id: number) => boolean) {
    const cands: Candidate[] = this.sources.map((s) => ({ position: s.emitter.position, candela: s.candela, range: s.range }));
    this.pools = assign(this.pools, cands, eye, dt, { keep: this.options.keep, fadeTime: this.options.fadeTime, visible });
    const drive = (slots: Slot[], hs: LightHandle[]) => slots.forEach((slot, i) => {
      if (slot.source < 0 || slot.weight <= 0) { hs[i].set([0, -1000, 0], [0, 0, 0], 0, 1); return; }
      const s = this.sources[slot.source], f = this.flickerOf(slot.source, t), p = s.emitter.position;
      hs[i].set([p[0] + f.offset[0], p[1] + f.offset[1], p[2] + f.offset[2]], s.colour, s.candela * f.k * slot.weight, s.range);
    });
    drive(this.pools.shadow, this.shadowHandles);
    drive(this.pools.plain, this.plainHandles);
  }

  /** Every source at its mean brightness, for baking bounce light (probe grids, lightmaps). */
  meanLights(): { position: V3; colour: RGB; candela: number; range: number }[] {
    return this.sources.map((s) => ({ position: s.emitter.position, colour: s.colour, candela: s.candela, range: s.range }));
  }

  stats(): RigStats {
    const on = (ss: Slot[]) => ss.filter((s) => s.source >= 0 && s.weight > 0).length;
    return { sources: this.sources.length, lit: on(this.pools.shadow) + on(this.pools.plain), shadowLit: on(this.pools.shadow), candela: Math.round(this.sources.reduce((a, s) => a + s.candela, 0)) };
  }
  /** Current pools (read-only copy) for debugging and tests. */
  snapshot(): Pools { return { shadow: this.pools.shadow.map((s) => ({ ...s })), plain: this.pools.plain.map((s) => ({ ...s })) }; }
}
