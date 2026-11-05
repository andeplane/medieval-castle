// ?test=stairs: a stair test scene (game-debug-tools). A round stair tower (inner radius 2.4 m,
// newel 0.3 m, landings at 7, 13, 19 and 25 m) with a thick drum wall, doorways, slit windows and a
// slate cap, fed by a mural stair inside a wall block from the ground up to the tower's bottom door.
// Add &cut to drop the south half of the drum and see the whole spiral.
import * as THREE from 'three/webgpu';
import { Builder, type MatKey } from '../castle/builder';
import { buildStair, drumWall, spiralNosingY, spiralTheta, type DrumOpening, type SpiralPlan, type StraightPlan, type StairOpts } from '../castle/interior/stairs';
import type { StairSpec, V3 } from '../castle/interior/types';
import type { View } from '../camera/controls';
import { GROUND } from '../castle/spec';
import type { V2 } from '../core/math2d';

const R = 2.4, WALL = 1.0, C: V2 = [0, 0];
export const TEST_SPIRAL: StairSpec = {
  id: 'test-spiral', kind: 'spiral', zone: 'test', spaces: ['mural', 'room-13', 'room-19', 'room-25'],
  centre: C, radius: R, newel: 0.3, turn: -1, width: R - 0.3,
  landings: [{ y: 7, angle: Math.PI / 2 }, { y: 13, angle: -0.6 }, { y: 19, angle: 2.3 }, { y: 25, angle: 0.8 }],
};
export const TEST_MURAL: StairSpec = {
  id: 'test-mural', kind: 'straight', zone: 'test', spaces: ['outside-wall', 'mural'],
  start: [0, GROUND, 11.6], end: [0, 7, R + WALL + 0.06], width: 1.0, landings: [{ y: GROUND }, { y: 7 }],
};

export interface StairTest { builder: Builder; lights: THREE.Light[]; views: View[]; spiral: SpiralPlan; mural: StraightPlan; opts: StairOpts }

export function buildStairTest(cut = false): StairTest {
  const B = new Builder();
  const ceiling = 25 + 2.5, top = ceiling + 0.6;
  const doorH = 2.1;
  // slit windows a little above the stair, a third of a turn apart
  const slits: DrumOpening[] = [];
  const tmp = buildStair(new Builder(), TEST_SPIRAL) as SpiralPlan;
  const last = tmp.steps[tmp.steps.length - 1];
  for (let q = 1.6; q < last.a1 - 0.5; q += 2.1) {
    if (tmp.landings.some((l) => Math.abs(l.psi - q) < 0.7)) continue;
    const y = spiralNosingY(tmp, q) + 1.25;
    slits.push({ angle: spiralTheta(tmp, q), width: 0.42, y0: y, y1: y + 0.95 });
  }
  const half: DrumOpening[] = cut ? [{ angle: Math.PI / 2, width: Math.PI * (R + 0.02), y0: -10, y1: 100 }] : [];
  const kept = (o: DrumOpening) => !cut || Math.cos(o.angle - Math.PI / 2) < 0;
  const opts: StairOpts = { skin: true, skinOpenings: [...slits, ...half], ceiling, ceilingDisc: true, doorHeight: doorH };
  const spiral = buildStair(B, TEST_SPIRAL, opts) as SpiralPlan;

  // drum: outer face, reveals of the doors and slits (slits splay: narrow outside), top, cap
  const rIn = R + 0.02, rOut = R + WALL;
  const doors: DrumOpening[] = spiral.landings.map((l) => ({ angle: l.angle, width: 1.0, y0: l.y - 0.01, y1: l.y + doorH }));
  const outer = [...doors.map((d) => ({ ...d, width: d.width * (rOut / rIn) })), ...slits.map((s) => ({ ...s, width: 0.12 })), ...half.map((h) => ({ ...h, width: Math.PI * rOut }))];
  drumWall(B, 'new', C, rOut, GROUND - 0.3, top, outer, false);
  const reveal = (o: DrumOpening, wIn: number, wOut: number, mat: MatKey) => {
    const aI = (wIn / 2) / rIn, aO = (wOut / 2) / rOut;
    const P = (r: number, a: number, y: number): V3 => [C[0] + Math.cos(a) * r, y, C[1] + Math.sin(a) * r];
    const quad = (p: V3[], n: V3) => {
      B.bins[mat].tri(p[0], p[1], p[2], n, [0, 0], [1, 0], [1, 1]);
      B.bins[mat].tri(p[0], p[2], p[3], n, [0, 0], [1, 1], [0, 1]);
    };
    const T = 2;
    for (const s of [-1, 1]) {
      const a0 = o.angle + s * aI, a1 = o.angle + s * aO;
      const A = P(rIn, a0, o.y0), Bp = P(rOut, a1, o.y0), Cp = P(rOut, a1, o.y1), D = P(rIn, a0, o.y1);
      const n: V3 = [-Math.sin(o.angle) * -s, 0, Math.cos(o.angle) * -s];
      B.bins[mat].tri(A, Bp, Cp, n, [0, o.y0 / T], [WALL / T, o.y0 / T], [WALL / T, o.y1 / T]);
      B.bins[mat].tri(A, Cp, D, n, [0, o.y0 / T], [WALL / T, o.y1 / T], [0, o.y1 / T]);
    }
    const ring = (y: number, up: boolean) => quad([P(rIn, o.angle - aI, y), P(rOut, o.angle - aO, y), P(rOut, o.angle + aO, y), P(rIn, o.angle + aI, y)], [0, up ? 1 : -1, 0]);
    ring(o.y1, false); ring(o.y0, true);
  };
  for (const d of doors.filter(kept)) reveal(d, 1.0, 1.0 * (rOut / rIn), 'trim');
  for (const s of slits.filter(kept)) reveal(s, s.width, 0.12, 'trim');
  if (!cut) {
    // wall top and a low slate cone over the tower
    const ringTop: V2[] = Array.from({ length: 48 }, (_, i) => [Math.cos((i / 48) * Math.PI * 2) * (rOut + 0.15), Math.sin((i / 48) * Math.PI * 2) * (rOut + 0.15)]);
    B.prism('trim', ringTop, top, top + 0.3);
    B.cone('slate', C[0], C[1], rOut + 0.45, top + 0.3, 5.5, 32, 0.15);
  }
  // solid base under the stair floor, and a ground apron
  B.cyl('old', C[0], C[1], rIn + 0.01, rIn + 0.01, GROUND - 0.3, 7 - 0.01, 32, { top: 'trim' });

  // mural stair in a wall block that runs south from the tower
  const mural = buildStair(B, TEST_MURAL) as StraightPlan;
  const z0 = R + WALL - 0.4, z1 = TEST_MURAL.start![2], hw = 1.7, yTop = 7 + 2.12 + 1.2;
  const firstLintel = mural.ceiling[0].y;
  // south face with the passage mouth, east/west faces, top
  B.planar('old', { o: [-hw, 0, z1], r: [1, 0, 0], u: [0, 1, 0], n: [0, 0, 1] }, [[0, GROUND - 0.3], [2 * hw, GROUND - 0.3], [2 * hw, yTop], [0, yTop]], 0,
    [[[hw - 0.5, GROUND - 0.05], [hw + 0.5, GROUND - 0.05], [hw + 0.5, firstLintel], [hw - 0.5, firstLintel]]]);
  for (const s of [-1, 1]) {
    const n: V3 = [s, 0, 0];
    B.planar('old', { o: [s * hw, 0, s > 0 ? z1 : z0], r: [0, 0, s > 0 ? -1 : 1], u: [0, 1, 0], n }, [[0, GROUND - 0.3], [z1 - z0, GROUND - 0.3], [z1 - z0, yTop], [0, yTop]]);
  }
  B.cap('trim', [[-hw - 0.08, z0], [hw + 0.08, z0], [hw + 0.08, z1 + 0.08], [-hw - 0.08, z1 + 0.08]], yTop, true);
  // where the passage meets the drum, a short floor and the passage walls carried into the doorway
  B.box('trim', [0, 7 - 0.15, (R + WALL + 0.06 + R) / 2], [1.0, 0.3, WALL + 0.06], [1, 0]);

  // light: a few warm lamps inside (no shadows) so the stone reads
  const lights: THREE.Light[] = [];
  for (const [q, dy] of [[0.4, 1.6], [5, 1.8], [11, 1.8], [17, 1.8], [24, 1.8]] as const) {
    const a = spiralTheta(spiral, q), y = spiralNosingY(spiral, q) + dy;
    const l = new THREE.PointLight(0xffb070, 9, 9, 2);
    l.position.set(C[0] + Math.cos(a) * (R - 0.4), y, C[1] + Math.sin(a) * (R - 0.4));
    lights.push(l);
  }
  const lm = new THREE.PointLight(0xffb070, 5, 7, 2); lm.position.set(0, 5.4, 8); lights.push(lm);

  // camera bookmarks along the walking line
  const wl = (q: number, up: number, r = spiral.rWalk): [number, number, number] => {
    const a = spiralTheta(spiral, q);
    return [C[0] + Math.cos(a) * r, Math.max(spiral.yFloor, spiralNosingY(spiral, q)) + up, C[1] + Math.sin(a) * r];
  };
  const L1 = spiral.landings[1], L2 = spiral.landings[2];
  const views: View[] = [
    { name: 'stair-up', label: 'Foot of the stair', mode: 'fly', pos: wl(spiral.entry[0] + 0.15, 1.6, 1.25), target: wl(1.5, 0.7, 1.7) },
    { name: 'stair-climb', label: 'Climbing', mode: 'fly', pos: wl(L1.psi - 3.0, 1.62), target: wl(L1.psi - 1.6, 1.1) },
    { name: 'stair-down', label: 'Looking down', mode: 'fly', pos: wl(L2.psi - 1.0, 1.62), target: wl(L2.psi - 2.6, 0.2) },
    { name: 'stair-landing', label: 'Landing', mode: 'fly', pos: wl(L2.psi - 1.6, 1.6, 1.3), target: wl(L2.psi, 1.0, R) },
    { name: 'stair-soffit', label: 'Soffit', mode: 'fly', pos: wl(L1.psi + 2.2, 1.3, 1.9), target: wl(L1.psi + 3.6, 3.4, 1.1) },
    { name: 'stair-mural', label: 'Mural stair', mode: 'fly', pos: [0, GROUND + 1.6, z1 + 1.6], target: [0, 5.2, 5.5] },
    { name: 'stair-out', label: 'Outside', mode: 'fly', pos: [11, 9, 18], target: [0, 12, 2] },
    { name: 'stair-cut', label: 'Cutaway (&cut)', mode: 'fly', pos: [3, 17, 15], target: [0, 15.5, 0] },
  ];
  return { builder: B, lights, views, spiral, mural, opts };
}
