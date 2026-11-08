// Is the moat (or the lake beyond it) on screen? The water's planar reflection renders the whole scene a
// second time from below (1.1 M triangles at the hall), so the water is not drawn, and its reflection not
// rendered, when no line of sight from the camera can reach it. Only how the water is drawn: the decision
// is conservative (castle walls are not counted as cover), so wherever water could be seen it is drawn,
// and the reflector renders afresh in the first frame it is drawn again (three's ReflectorNode updates
// before the frame that draws it), so it never shows a stale reflection. tests/world.test.ts checks it
// against rays through every pixel of poses all over the castle.
//
// - Outdoors (the camera's spaces include 'outside', or it is above the roofs): the water lies at y 0, so
//   it is on screen unless the whole frustum looks level or up.
// - Indoors or in the courtyard (the water is outside the walls, never in the courtyard): only through an
//   opening onto the outside of a room the room graph draws. Lines from the eye through points of each
//   such opening that is in view run on outward until they meet water (y ≤ 0 where the ground is below
//   it) or go under the ground.
import type { V3 } from '../castle/interior/types';
import type { PlaneLike } from './visibility';

/** An opening onto the outside: centre, outward normal (level), clear width and height (centred on c), and
 * how far its reveal runs on outward from c with the same outline (`ahead`): a line out through it clears both ends. */
export interface Opening { c: V3; n: V3; w: number; h: number; ahead?: number }

export interface WaterView {
  eye: V3;
  /** the view frustum's planes (inside: normal · p + constant ≥ 0) */
  planes: PlaneLike[];
  /** directions from the eye to the far corners of the frustum */
  corners: V3[];
  /** the camera stands outdoors, outside the walls (or above the roofs) */
  outdoors: boolean;
  /** openings onto the outside of the drawn rooms */
  openings: Opening[];
}

/** Ground height (the moat's bed is below 0 where there is water). */
export type Ground = (x: number, z: number) => number;

const LEVEL = 0;

/** Does the line from p along unit d meet water before the ground (within `reach` m)? Steps grow with distance. */
export function reachesWater(p: V3, d: V3, ground: Ground, reach = 600): boolean {
  for (let t = 0; t <= reach; t += Math.max(0.25, t * 0.04)) {
    const x = p[0] + d[0] * t, y = p[1] + d[1] * t, z = p[2] + d[2] * t, g = ground(x, z);
    if (g > y + 0.3) return false; // under the ground (with a margin: the terrain mesh sags between its vertices)
    if (y <= LEVEL + 0.05 && g < LEVEL) return true;
    if (d[1] >= 0 && y > LEVEL + 0.05) { if (t > 60) return false; } // level or rising, well clear of the water
  }
  return false;
}

const inside = (planes: PlaneLike[], p: V3, slack: number) => planes.every((q) => q.normal.x * p[0] + q.normal.y * p[1] + q.normal.z * p[2] + q.constant >= -slack);

/** Points across an opening, edges and corners included (`k` × `k`). */
export function openingPoints(o: Opening, k = 4): V3[] {
  const l = Math.hypot(o.n[0], o.n[2]) || 1, a: V3 = [-o.n[2] / l, 0, o.n[0] / l], out: V3[] = [];
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
    const u = (i / (k - 1) - 0.5) * o.w, v = (j / (k - 1) - 0.5) * o.h;
    out.push([o.c[0] + a[0] * u, o.c[1] + v, o.c[2] + a[2] * u]);
  }
  return out;
}

/** Is the eye within the opening (its reveal, or half a metre inside it)? */
function standsIn(o: Opening, e: V3) {
  const l = Math.hypot(o.n[0], o.n[2]) || 1, dx = e[0] - o.c[0], dz = e[2] - o.c[2];
  const through = (dx * o.n[0] + dz * o.n[2]) / l, across = (dx * -o.n[2] + dz * o.n[0]) / l;
  return through >= -0.5 && through <= (o.ahead ?? 0) + 0.3 && Math.abs(across) <= o.w / 2 && Math.abs(e[1] - o.c[1]) <= o.h / 2;
}

/** Does the line from p (on the opening's plane) along u, un = u · n, leave by the reveal's outer end? */
function throughReveal(o: Opening, p: V3, u: V3, un: number) {
  const t = o.ahead! / un, q: V3 = [p[0] + u[0] * t - o.n[0] * o.ahead!, p[1] + u[1] * t, p[2] + u[2] * t - o.n[2] * o.ahead!];
  const l = Math.hypot(o.n[0], o.n[2]) || 1, across = ((q[0] - o.c[0]) * -o.n[2] + (q[2] - o.c[2]) * o.n[0]) / l;
  return Math.abs(across) <= o.w / 2 + 0.02 && Math.abs(q[1] - o.c[1]) <= o.h / 2 + 0.02;
}

export function waterInView(v: WaterView, ground: Ground): boolean {
  if (v.outdoors) return v.eye[1] <= LEVEL + 0.05 || v.corners.some((d) => d[1] < 0);
  for (const o of v.openings) {
    // an opening any part of which is in view: every line through it (a sample just out of view may stand
    // for a sliver of it that is in view)
    if (!inside(v.planes, o.c, Math.hypot(o.w, o.h) / 2 + 0.05)) continue;
    if (standsIn(o, v.eye)) return true; // in the opening itself: any line out
    for (const p of openingPoints(o)) {
      const d: V3 = [p[0] - v.eye[0], p[1] - v.eye[1], p[2] - v.eye[2]], L = Math.hypot(...d);
      const u: V3 = [d[0] / L, d[1] / L, d[2] / L];
      const un = u[0] * o.n[0] + u[2] * o.n[2];
      if (un <= 0) continue; // looking back in through it
      if (o.ahead && !throughReveal(o, p, u, un)) continue;
      if (reachesWater(p, u, ground)) return true;
    }
  }
  return false;
}
