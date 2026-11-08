// Interior fire sources for the shared light system (src/light) without furniture: a few plain wall
// torches in the halls, gate rooms, undercrofts and tunnels so the dark rooms still have firelight
// (with ?furniture=1 the streamed rooms bring their own fires, light/roomFires.ts). Pure; main.ts puts each torch in its room's row of the
// fire table (light/roomLight.ts) and
// makeFlameSprites(linkFlames(flames, emitters)).
import type { InteriorPlan, RoomSpec, SpaceId } from '../castle/interior/types';
import type { Flame, LightEmitter, V3 } from '../light/types';
import type { TunnelSpec } from '../castle/interior/plan';
import { FLAME_OUT, type TorchHolder } from '../castle/interior/torch';
import { inPoly } from './interiorMath';

export interface FireSources {
  emitters: LightEmitter[];
  flames: Flame[];
  /** Visibility group key of each emitter (windows of rooms with fire glow at night). */
  group: string[];
  /** Each wall torch's holder (shaft and bracket), one per flame, for the shell to build; none for furniture. */
  holders: TorchHolder[];
}

const TORCH_ROOMS = new Set(['hall', 'gate', 'undercroft']);

/** Flame base above the floor: rooms 2 m; tunnels lower, under the vault's springing (1.75 m) so the bracket is on the upright wall. */
const ROOM_Y = 2.0, TUNNEL_Y = 1.55;

/**
 * One torch per lit room on the room edge (≥ 2.5 m) farthest from its doors, 2 m up; tunnels get one
 * every ~10 m along that wall, over the tunnel's own floor there. `groupOf(room)` names the visibility
 * group; rooms without a group are skipped. At most `max`. Each torch has a holder (castle/interior/torch.ts)
 * for the shell to build in its room.
 */
export function wallTorches(plan: InteriorPlan & { tunnels?: TunnelSpec[] }, groupOf: (room: SpaceId) => string | undefined, max = 64): FireSources {
  const out: FireSources = { emitters: [], flames: [], group: [], holders: [] };
  for (const r of plan.rooms) {
    if (out.emitters.length >= max) break;
    // and any room with a way into the caves (the great tower's cellar), so the opening is lit and found
    if (!TORCH_ROOMS.has(r.kind) && r.zone !== 'tunnel' && !intoCaves(plan, r)) continue;
    const g = groupOf(r.id);
    const spot = g === undefined ? null : torchSpot(plan, r);
    if (!spot) continue;
    const { n, a, b } = spot, L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const tunnel = r.zone === 'tunnel' ? plan.tunnels?.find((t) => t.room === r.id) : undefined;
    const count = r.zone === 'tunnel' ? Math.max(1, Math.round(L / 10)) : 1;
    for (let k = 0; k < count && out.emitters.length < max; k++) {
      const t = (k + 0.5) / count, p: P2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const y = tunnel ? floorAlong(tunnel.path, p) + TUNNEL_Y : Math.min(r.y0 + ROOM_Y, r.y1 - 0.5);
      const at = (d: number, h: number): V3 => [p[0] + n[0] * d, h, p[1] + n[1] * d];
      out.flames.push({ kind: 'torch', base: at(FLAME_OUT, y), height: 0.24 });
      out.emitters.push({ kind: 'torch', position: at(0.4, y + 0.3), colour: [1, 0.96, 0.92], intensity: 3, flicker: 0.25 });
      out.group.push(g!);
      out.holders.push({ room: r.id, wall: at(0, y), n, base: at(FLAME_OUT, y) });
    }
  }
  return out;
}

/** The floor line of a tunnel path (x, y, z points) at the plan point p, by its distance along the path. */
export function floorAlong(path: V3[], p: P2): number {
  const a = path[0], z = path[path.length - 1], L = Math.hypot(z[0] - a[0], z[2] - a[2]), d: P2 = [(z[0] - a[0]) / L, (z[2] - a[2]) / L];
  const along = (x: number, zz: number) => (x - a[0]) * d[0] + (zz - a[2]) * d[1], sp = along(p[0], p[1]);
  let k = 0;
  while (k < path.length - 2 && sp > along(path[k + 1][0], path[k + 1][2])) k++;
  const s0 = along(path[k][0], path[k][2]), s1 = along(path[k + 1][0], path[k + 1][2]);
  return path[k][1] + (path[k + 1][1] - path[k][1]) * Math.max(0, Math.min(1, (sp - s0) / (s1 - s0)));
}

type P2 = [number, number];
/**
 * The best wall for a torch: its midpoint m, inward normal n and ends a, b; null if no edge is long enough.
 * A room with a way down (a door into a room whose floor is a metre or more lower: the cellar stair, the
 * breach into the caves) has its torch beside that door, so the way down is lit and easy to find (Anders,
 * 2026-11-08: "i never found the basements").
 */
const intoCaves = (plan: InteriorPlan, r: RoomSpec) => r.zone !== 'cave' && plan.doors.some((d) => d.spaces.includes(r.id) && d.spaces.some((s) => plan.rooms.find((x) => x.id === s)?.zone === 'cave'));

export function torchSpot(plan: InteriorPlan, r: RoomSpec): { m: P2; n: P2; a: P2; b: P2 } | null {
  const down = besideWayDown(plan, r);
  if (down) return down;
  const doors = plan.doors.filter((d) => d.spaces.includes(r.id)).map((d) => [d.centre[0], d.centre[2]]);
  let best: { m: P2; n: P2; a: P2; b: P2 } | null = null, bd = -1;
  for (let i = 0; i < r.poly.length; i++) {
    const a = r.poly[i], b = r.poly[(i + 1) % r.poly.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 2.5) continue;
    const m: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let n: [number, number] = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
    if (!inPoly(r.poly, m[0] + n[0] * 0.3, m[1] + n[1] * 0.3)) n = [-n[0], -n[1]];
    const clear = doors.length ? Math.min(...doors.map((d) => Math.hypot(d[0] - m[0], d[1] - m[1]))) : Infinity;
    if (clear > bd) { bd = clear; best = { m, n, a, b }; }
  }
  return best;
}

/** A torch spot on the wall beside a door down out of the room, 0.65 m clear of its opening; null if none fits. */
export function besideWayDown(plan: InteriorPlan, r: RoomSpec): { m: P2; n: P2; a: P2; b: P2 } | null {
  // a way into the caves first: it is the one to find (the great tower's cellar also has a tunnel down)
  const cave = (d: InteriorPlan['doors'][number]) => d.spaces.some((s) => plan.rooms.find((x) => x.id === s)?.zone === 'cave') ? 0 : 1;
  for (const d of [...plan.doors].sort((x, y) => cave(x) - cave(y))) {
    const k = d.spaces.indexOf(r.id);
    if (k < 0) continue;
    const o = plan.rooms.find((x) => x.id === d.spaces[1 - k]);
    if (!o || o.y0 > r.y0 - 1) continue;
    const c: P2 = [d.centre[0], d.centre[2]];
    for (let i = 0; i < r.poly.length; i++) {
      const a = r.poly[i], b = r.poly[(i + 1) % r.poly.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 1e-6) continue;
      const e: P2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
      if (Math.abs(e[0] * d.along[0] + e[1] * d.along[1]) < 0.95) continue; // the wall the door is in runs along it
      const t = (c[0] - a[0]) * e[0] + (c[1] - a[1]) * e[1], off = Math.abs((c[0] - a[0]) * e[1] - (c[1] - a[1]) * e[0]);
      if (off > d.wall / 2 + 0.3 || t < 0 || t > L) continue;
      let n: P2 = [-e[1], e[0]];
      const m0: P2 = [a[0] + e[0] * t, a[1] + e[1] * t];
      if (!inPoly(r.poly, m0[0] + n[0] * 0.3, m0[1] + n[1] * 0.3)) n = [-n[0], -n[1]];
      for (const side of [1, -1]) {
        const tt = t + side * (d.width / 2 + 0.65);
        if (tt < 0.5 || tt > L - 0.5) continue;
        const m: P2 = [a[0] + e[0] * tt, a[1] + e[1] * tt];
        return { m, n, a: [m[0] - e[0] * 0.3, m[1] - e[1] * 0.3], b: [m[0] + e[0] * 0.3, m[1] + e[1] * 0.3] };
      }
    }
  }
  return null;
}
