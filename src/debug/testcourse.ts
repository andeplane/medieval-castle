// ?test=walk: a small movement test course on the island lawn (game-physics "KCC test"). Lanes side by
// side, all walked northward (−z) from a common start line on a raised slab:
//   stairs with 0.15 / 0.20 / 0.30 / 0.35 m rises, a 30° and a 55° ramp, a low beam (crouch only),
//   and a stair down through a hole in the ground into a tunnel that runs under the terrain.
// The course is a pure function of the island; scripts/walktest.mjs reads `courseInfo` from __game.
import { Builder } from '../castle/builder';
import { type V2, pointInPoly, edgeDist } from '../core/math2d';
import { heightAt, footDist, ISLAND } from '../world/terrain';

export interface Lane { name: string; x: number; z0: number; top: number; kind: 'stairs' | 'ramp' | 'beam' | 'descent'; rise?: number; run?: number; steps?: number; deg?: number; beamY?: number; beamZ?: [number, number]; endZ: number; floorY?: number }
export interface CourseInfo { origin: V2; slab: number; lanes: Lane[]; holes: V2[][] }

const LANE_W = 2.0, GAP = 0.3, PITCH = LANE_W + GAP, START = 3, LEN = 10;
const LANES: Omit<Lane, 'x' | 'z0' | 'top' | 'endZ'>[] = [
  { name: 'stairs-0.15', kind: 'stairs', rise: 0.15, run: 0.3, steps: 6 },
  { name: 'stairs-0.20', kind: 'stairs', rise: 0.2, run: 0.3, steps: 5 },
  { name: 'stairs-0.30', kind: 'stairs', rise: 0.3, run: 0.4, steps: 3 },
  { name: 'stairs-0.35', kind: 'stairs', rise: 0.35, run: 0.4, steps: 3 },
  { name: 'ramp-30', kind: 'ramp', deg: 30 },
  { name: 'ramp-55', kind: 'ramp', deg: 55 },
  { name: 'beam', kind: 'beam', beamY: 1.3 },
  { name: 'descent', kind: 'descent', rise: 0.2, run: 0.3, steps: 15 },
];

/** A flat, clear patch of lawn big enough for the course (searched on a grid, deterministic). */
export function courseOrigin(): V2 {
  const W = LANES.length * PITCH, D = START + LEN + 10;
  let best: V2 = [40, 20], bestScore = -1e9;
  for (let x = -60; x <= 70; x += 2) for (let z = -60; z <= 70; z += 2) {
    const corners: V2[] = [[x - 1, z + START + 1], [x + W + 1, z + START + 1], [x + W + 1, z - D], [x - 1, z - D], [x + W / 2, z - D / 2]];
    if (!corners.every((c) => pointInPoly(ISLAND, c[0], c[1]) && edgeDist(ISLAND, c[0], c[1]).d > 3 && footDist(c[0], c[1]) > 4)) continue;
    const hs = corners.map((c) => heightAt(c[0], c[1]));
    const score = -(Math.max(...hs) - Math.min(...hs)) * 10 + Math.min(...corners.map((c) => footDist(c[0], c[1]))) * 0.01;
    if (score > bestScore) { bestScore = score; best = [x, z]; }
  }
  return best;
}

export function buildCourse(B: Builder): CourseInfo {
  const [ox, oz] = courseOrigin();
  const W = LANES.length * PITCH;
  // slab top a little above the highest ground under it
  let hMax = -1e9;
  for (let x = ox - 1; x <= ox + W + 1; x += 1) for (let z = oz - START - LEN - 10; z <= oz + START + 1; z += 1) hMax = Math.max(hMax, heightAt(x, z));
  const S = hMax + 0.12;
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: 'trim' | 'old' | 'wood' = 'trim') =>
    B.box(mat, [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [x1 - x0, y1 - y0, z1 - z0], [1, 0], { bottom: true });
  const lanes: Lane[] = [];
  const holes: V2[][] = [];
  const zs = oz + START, zEnd = oz - LEN; // start line (south) and end of the normal lanes (north)
  LANES.forEach((l, i) => {
    const x0 = ox + i * PITCH, x1 = x0 + LANE_W, cx = (x0 + x1) / 2;
    // separators so a walk stays in its lane
    box(x1, x1 + GAP, S - 1, S + 2.6, zEnd, zs, 'old');
    if (i === 0) box(x0 - GAP, x0, S - 1, S + 2.6, zEnd, zs, 'old');
    let top = S, endZ = zEnd;
    if (l.kind === 'descent') {
      // landing, then steps down through a hole in the ground, then a tunnel under the lawn
      const zTop = oz - 1;
      box(x0, x1, S - 1, S, zTop, zs);
      let z = zTop;
      const n = l.steps!, rise = l.rise!, run = l.run!;
      for (let k = 1; k <= n; k++) { box(x0, x1, S - rise * k - 0.3, S - rise * k, z - run, z); z -= run; }
      const floor = S - rise * n, tz = z - 9;
      box(x0, x1, floor - 0.3, floor, tz, z); // tunnel floor
      for (const [a, b] of [[x0 - 0.3, x0], [x1, x1 + 0.3]]) box(a, b, floor - 0.3, S + 0.2, tz, zTop, 'old');
      box(x0 - 0.3, x1 + 0.3, floor - 0.3, S + 0.2, tz - 0.3, tz, 'old');
      // the stairwell walls on the north side cover the hole edge; the tunnel ceiling is the terrain
      holes.push([[x0 - 0.05, zTop + 0.05], [x1 + 0.05, zTop + 0.05], [x1 + 0.05, zTop - n * run - 0.6], [x0 - 0.05, zTop - n * run - 0.6]]);
      lanes.push({ ...l, x: cx, z0: zs - 0.8, top: floor, endZ: tz + 0.6, floorY: floor });
      return;
    }
    box(x0, x1, S - 1, S, zEnd, zs); // lane slab
    if (l.kind === 'stairs') {
      let z = oz, y = S;
      for (let k = 1; k <= l.steps!; k++) { y = S + l.rise! * k; box(x0, x1, S - 0.2, y, zEnd, z); z -= l.run!; }
      top = y; endZ = z - 1.5;
    } else if (l.kind === 'ramp') {
      const a = (l.deg! * Math.PI) / 180, run = l.deg! > 45 ? 1.6 : 3.2, rise = run * Math.tan(a);
      // wedge as a prism in the lane's side profile (x extrusion)
      const prof: V2[] = [[oz, S], [oz - run, S + rise], [oz - run - 2.5, S + rise], [oz - run - 2.5, S]];
      wedge(B, x0, x1, prof);
      top = S + rise; endZ = oz - run - 1.2;
    } else if (l.kind === 'beam') {
      box(x0, x1, S + l.beamY!, S + l.beamY! + 0.35, oz - 2.5, oz, 'wood');
      lanes.push({ ...l, x: cx, z0: zs - 0.8, top: S, endZ: oz - 3.5, beamZ: [oz - 2.5, oz] });
      return;
    }
    lanes.push({ ...l, x: cx, z0: zs - 0.8, top, endZ });
  });
  // south apron: a gentle wedge so you can walk onto the slab from the lawn
  wedge(B, ox - GAP, ox + W, [[zs + 2.5, S - 0.6], [zs, S], [zs, S - 1], [zs + 2.5, S - 1]]);
  return { origin: [ox, oz], slab: S, lanes, holes };
}

/** Prism of a (z, y) profile polygon extruded across x0..x1. */
function wedge(B: Builder, x0: number, x1: number, prof: V2[]) {
  // ensure a consistent winding: Builder.wall picks the outward normal we give it
  const n = prof.length;
  let area = 0; for (let i = 0; i < n; i++) { const a = prof[i], b = prof[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  const P = area > 0 ? prof : [...prof].reverse();
  const T = 2, bin = B.bins.trim;
  for (const [x, nx] of [[x0, -1], [x1, 1]] as [number, number][]) {
    for (let i = 1; i < n - 1; i++) {
      const a = P[0], b = P[i], c = P[i + 1];
      bin.tri([x, a[1], a[0]], [x, b[1], b[0]], [x, c[1], c[0]], [nx, 0, 0], [a[0] / T, a[1] / T], [b[0] / T, b[1] / T], [c[0] / T, c[1] / T]);
    }
  }
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    const dz = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dz, dy) || 1;
    // outward normal of a CCW (z, y) polygon edge is (dy, -dz) in (z, y)
    const nz = dy / l, ny = -dz / l;
    bin.tri([x0, a[1], a[0]], [x1, a[1], a[0]], [x1, b[1], b[0]], [0, ny, nz], [0, 0], [1, 0], [1, 1]);
    bin.tri([x0, a[1], a[0]], [x1, b[1], b[0]], [x0, b[1], b[0]], [0, ny, nz], [0, 0], [1, 1], [0, 1]);
  }
}
