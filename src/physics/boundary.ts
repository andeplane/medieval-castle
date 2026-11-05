// The invisible wall that keeps the player on the island (brief: "cannot leave it"). It follows the
// island outline just inside the revetment coping, and where the old bridge leaves the island it
// detours along the bridge parapets to the broken span, so you can walk out and look at the gap.
import { type V2, add, scale, sub, dot } from '../core/math2d';
import { offsetPoly } from '../castle/builder';

export interface BridgeInfo { start: V2; dir: V2; width: number; breakAt: number }

/**
 * The bridge corridor from the bridge plan's walkable deck: [start −w, end −w, end +w, start +w] around
 * its axis `dir` (castle/bridge.ts bridgePlan().walkable and .d).
 */
export function bridgeInfo(walkable: V2[], dir: V2): BridgeInfo {
  const [a, b, , d] = walkable;
  return { start: scale(add(a, d), 0.5), dir, width: Math.hypot(d[0] - a[0], d[1] - a[1]), breakAt: dot(sub(b, a), dir) };
}

/** Distance from the island edge to the wall (the revetment coping is ~0.35–1.1 m in). */
export const BOUNDARY_INSET = 0.75;

export function boundaryOutline(island: V2[], bridge?: BridgeInfo): V2[] {
  const ring = offsetPoly(island, -BOUNDARY_INSET);
  if (!bridge) return ring;
  const { start, dir, width, breakAt } = bridge;
  const side: V2 = [dir[1], -dir[0]];
  const hw = width / 2;
  const t = (p: V2) => dot(sub(p, start), dir), s = (p: V2) => dot(sub(p, start), side);
  // ring vertices inside the bridge corridor (between the parapet lines, ahead of the bridge start)
  const n = ring.length;
  const inCorridor = ring.map((p) => Math.abs(s(p)) < hw + 0.6 && t(p) > -6);
  const first = inCorridor.indexOf(true);
  if (first < 0) return ring;
  // walk to the start of the run of corridor vertices
  let a = first; while (inCorridor[(a - 1 + n) % n]) a = (a - 1 + n) % n;
  let b = a; while (inCorridor[(b + 1) % n]) b = (b + 1) % n;
  const before = ring[(a - 1 + n) % n], after = ring[(b + 1) % n];
  const sb = Math.sign(s(before)) || 1;
  const P = (tt: number, ss: number): V2 => add(add(start, scale(dir, tt)), scale(side, ss));
  const out: V2[] = [];
  for (let i = (b + 1) % n; i !== a; i = (i + 1) % n) out.push(ring[i]);
  // `after` … `before` is the kept ring; close it through the bridge, entering on before's side
  const t0 = Math.min(t(before), t(after));
  const detour = [P(t0, sb * hw), P(breakAt, sb * hw), P(breakAt, -sb * hw), P(t0, -sb * hw)];
  return [...out, ...detour];
}
