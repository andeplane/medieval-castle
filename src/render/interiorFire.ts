// Interior fire sources for the shared light system (src/light): the furniture's fixtures when it is
// built (?furniture=1), otherwise a few plain wall torches in the halls, gate rooms, undercrofts and
// tunnels so the dark rooms still have firelight. Pure; main.ts feeds the result to LightRig and
// makeFlameSprites(linkFlames(flames, emitters)).
import type { InteriorPlan, RoomSpec, SpaceId } from '../castle/interior/types';
import type { Flame, LightEmitter, V3 } from '../light/types';
import { inPoly } from './interiorMath';

export interface FireSources {
  emitters: LightEmitter[];
  flames: Flame[];
  /** Visibility group key of each emitter (so the rig only lights shown rooms). */
  group: string[];
}

/** Flatten the furniture's per-group maps. */
export function fromFurniture(emitters: Map<string, LightEmitter[]>, flames: Map<string, Flame[]>): FireSources {
  const out: FireSources = { emitters: [], flames: [], group: [] };
  for (const [k, es] of emitters) for (const e of es) { out.emitters.push(e); out.group.push(k); }
  for (const fs of flames.values()) out.flames.push(...fs);
  return out;
}

const TORCH_ROOMS = new Set(['hall', 'gate', 'undercroft']);

/**
 * One torch per lit room: on the midpoint of the room edge (≥ 2.5 m) farthest from its doors, 2 m up.
 * `groupOf(room)` names the visibility group; rooms without a group are skipped. At most `max`.
 */
export function wallTorches(plan: InteriorPlan, groupOf: (room: SpaceId) => string | undefined, max = 16): FireSources {
  const out: FireSources = { emitters: [], flames: [], group: [] };
  for (const r of plan.rooms) {
    if (out.emitters.length >= max) break;
    if (!TORCH_ROOMS.has(r.kind) && r.zone !== 'tunnel') continue;
    const g = groupOf(r.id);
    const spot = g === undefined ? null : torchSpot(plan, r);
    if (!spot) continue;
    const [p, n] = spot, at = (d: number, y: number): V3 => [p[0] + n[0] * d, y, p[1] + n[1] * d];
    const y = Math.min(r.y0 + 2.0, r.y1 - 0.5);
    out.flames.push({ kind: 'torch', base: at(0.22, y), height: 0.24 });
    out.emitters.push({ kind: 'torch', position: at(0.4, y + 0.3), colour: [1, 0.96, 0.92], intensity: 3, flicker: 0.25 });
    out.group.push(g!);
  }
  return out;
}

/** Edge midpoint and inward normal of the best wall for a torch, or null if no edge is long enough. */
export function torchSpot(plan: InteriorPlan, r: RoomSpec): [[number, number], [number, number]] | null {
  const doors = plan.doors.filter((d) => d.spaces.includes(r.id)).map((d) => [d.centre[0], d.centre[2]]);
  let best: [[number, number], [number, number]] | null = null, bd = -1;
  for (let i = 0; i < r.poly.length; i++) {
    const a = r.poly[i], b = r.poly[(i + 1) % r.poly.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 2.5) continue;
    const m: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let n: [number, number] = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
    if (!inPoly(r.poly, m[0] + n[0] * 0.3, m[1] + n[1] * 0.3)) n = [-n[0], -n[1]];
    const clear = doors.length ? Math.min(...doors.map((d) => Math.hypot(d[0] - m[0], d[1] - m[1]))) : Infinity;
    if (clear > bd) { bd = clear; best = [m, n]; }
  }
  return best;
}
