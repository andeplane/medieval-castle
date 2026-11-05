// Which fires get a real light this frame. GPUs shade a handful of point lights well and every
// shadow-casting point light re-renders the scene six times, so the rig keeps two fixed pools (the
// light count never changes, so materials never recompile): a few shadow casters for the fires that
// matter most and more plain lights for the rest. Sources move between pools with a cross-fade, so
// nothing pops when the player walks. Pure: tested without three.js.
import type { V3 } from './types';

export interface Candidate { position: V3; candela: number; range: number }

/** How much a source matters to a viewer at `eye`: brightness over distance, zero beyond its range. */
export function lightScore(c: Candidate, eye: V3): number {
  const dx = c.position[0] - eye[0], dy = c.position[1] - eye[1], dz = c.position[2] - eye[2];
  const d2 = dx * dx + dy * dy + dz * dz, reach = c.range * 1.6;
  if (d2 >= reach * reach) return 0;
  const edge = 1 - d2 / (reach * reach);
  return (c.candela / (d2 + 1)) * edge * edge;
}

/** One light in a pool: which source it shows (-1 none) and its fade weight 0..1. */
export interface Slot { source: number; weight: number }

export const emptyPool = (n: number): Slot[] => Array.from({ length: n }, () => ({ source: -1, weight: 0 }));

/**
 * Move a pool towards showing `wanted` (source ids). Slots showing a wanted source fade in; others
 * fade out and, once dark, take the next wanted source that has no slot yet. `step` is dt / fadeTime.
 * Returns a new pool; the input is not changed.
 */
export function stepPool(pool: Slot[], wanted: number[], step: number): Slot[] {
  const want = new Set(wanted);
  const next = pool.map((s) => ({ ...s }));
  const shown = new Set(next.filter((s) => s.source >= 0 && want.has(s.source)).map((s) => s.source));
  const waiting = wanted.filter((id) => !shown.has(id));
  for (const s of next) {
    if (s.source >= 0 && want.has(s.source)) s.weight = Math.min(1, s.weight + step);
    else if (s.weight > 0) s.weight = Math.max(0, s.weight - step);
    if (s.weight <= 0 && !(s.source >= 0 && want.has(s.source))) {
      const id = waiting.shift();
      s.source = id ?? -1; s.weight = 0;
      if (id !== undefined) s.weight = Math.min(1, step);
    }
  }
  return next;
}

export interface Pools { shadow: Slot[]; plain: Slot[] }
export interface BudgetOptions {
  /** Score bonus for sources already lit, so two similar torches don't trade places every frame. */
  keep: number;
  /** Seconds a light takes to fade in or out. */
  fadeTime: number;
  /** Optional visibility test (rooms and portals); hidden sources get no light. */
  visible?: (id: number) => boolean;
}

/** Rank sources for `eye` and step both pools. The best go to the shadow pool, the next to plain. */
export function assign(pools: Pools, cands: Candidate[], eye: V3, dt: number, o: BudgetOptions): Pools {
  const lit = new Set([...pools.shadow, ...pools.plain].filter((s) => s.source >= 0 && s.weight > 0).map((s) => s.source));
  const inShadow = new Set(pools.shadow.filter((s) => s.source >= 0 && s.weight > 0).map((s) => s.source));
  const ranked: { id: number; score: number }[] = [];
  cands.forEach((c, id) => {
    if (o.visible && !o.visible(id)) return;
    let score = lightScore(c, eye);
    if (score <= 0) return;
    if (lit.has(id)) score *= o.keep;
    if (inShadow.has(id)) score *= o.keep;
    ranked.push({ id, score });
  });
  ranked.sort((a, b) => b.score - a.score || a.id - b.id);
  const ids = ranked.map((r) => r.id);
  const nS = pools.shadow.length, nP = pools.plain.length;
  const step = o.fadeTime > 0 ? dt / o.fadeTime : 1;
  return { shadow: stepPool(pools.shadow, ids.slice(0, nS), step), plain: stepPool(pools.plain, ids.slice(nS, nS + nP), step) };
}
