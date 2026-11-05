// Tree placement (game-world-generation recipe 4), a pure function of the world seed: a few groups on
// the island lawn, copses on the banks and in the fields, hedgerows with standard trees along a jittered
// field grid, and forests with scrubby edges whose spacing grows with distance (far impostors each
// stand for a small clump of crowns). Kept free of three.js so the tests can run it in Node.
import { createNoise2D } from 'simplex-noise';
import { mulberry32, hashSeed, rngFor } from '../core/rng';
import { sample, footDist } from './terrain';
import { gatehouseFrame, castleCentre } from '../castle/layout';

/** A tree: position, variant, scale, rotation, brightness and (far forest only) crown widening. */
export interface Spot { x: number; y: number; z: number; v: number; s: number; rot: number; b: number; w: number }

/** Variant order shared with trees.ts (atlas rows and mesh sets follow it). */
export const VARIANTS = ['oakM', 'oakL', 'ash', 'ashL', 'pine', 'bushA', 'bushB'] as const;
export const OAK_M = 0, OAK_L = 1, ASH = 2, ASH_L = 3, PINE = 4, BUSH_A = 5, BUSH_B = 6;

/** Seeded tree positions (pure function of the world seed). */
export function placeTrees(keepClear: [number, number][]): Spot[] {
  const clear = (x: number, z: number, r = 28) => keepClear.every(([cx, cz]) => Math.hypot(x - cx, z - cz) > r);
  const spots: Spot[] = [];
  const r = rngFor('trees');
  const C = castleCentre();
  const gate = gatehouseFrame();
  const forestN = createNoise2D(mulberry32(hashSeed('forest')));
  const forest = (x: number, z: number) => forestN(x / 700, z / 700) * 0.7 + forestN(x / 160, z / 160) * 0.3;
  const broadleaf = (q: number) => (q < 0.32 ? OAK_M : q < 0.55 ? OAK_L : q < 0.8 ? ASH : ASH_L);
  const push = (x: number, z: number, v: number, s: number, sink = 0.25) => {
    const h = sample(x, z).h;
    spots.push({ x, y: h - sink, z, v, s, rot: r() * Math.PI * 2, b: 0.85 + r() * 0.3, w: 1 });
  };
  const near = (x: number, z: number, d: number) => {
    for (let i = spots.length - 1; i >= 0 && i > spots.length - 400; i--) { const p = spots[i]; if (Math.abs(p.x - x) < d && Math.abs(p.z - z) < d) return true; }
    return false;
  };
  const gatePath = (x: number, z: number, w: number) => {
    const gx = x - gate.centre[0], gz = z - gate.centre[1];
    return Math.abs(gx * gate.dir[0] + gz * gate.dir[1]) < w && gx * gate.out[0] + gz * gate.out[1] > 0;
  };

  // 1. island: three or four loose groups on the lawn, a few shrubs along the revetment
  const groups: [number, number][] = [];
  for (let i = 0; i < 400 && groups.length < 4; i++) {
    const x = C[0] - 70 + r() * 140, z = C[1] - 65 + r() * 140, s = sample(x, z);
    if (s.zone !== 'island' || s.dEdge < 9 || footDist(x, z) < 16 || gatePath(x, z, 9) || !clear(x, z, 22)) continue;
    if (groups.some(([gx, gz]) => Math.hypot(gx - x, gz - z) < 30)) continue;
    groups.push([x, z]);
  }
  for (const [gx, gz] of groups) {
    const n = 2 + Math.floor(r() * 3);
    for (let k = 0, made = 0; k < 40 && made < n; k++) {
      const a = r() * Math.PI * 2, d = r() * 9, x = gx + Math.cos(a) * d, z = gz + Math.sin(a) * d, s = sample(x, z);
      if (s.zone !== 'island' || s.dEdge < 3 || footDist(x, z) < 9 || gatePath(x, z, 5) || !clear(x, z, 16) || near(x, z, 6.5)) continue;
      push(x, z, broadleaf(r()), 0.75 + r() * 0.35); made++;
    }
  }
  for (let k = 0, made = 0; k < 300 && made < 9; k++) {
    const x = C[0] - 75 + r() * 150, z = C[1] - 70 + r() * 150, s = sample(x, z);
    if (s.zone !== 'island' || s.dEdge < 2.4 || s.dEdge > 5 || footDist(x, z) < 7 || gatePath(x, z, 6) || !clear(x, z, 14) || near(x, z, 5)) continue;
    push(x, z, r() < 0.5 ? BUSH_A : BUSH_B, 0.7 + r() * 0.4, 0.1); made++;
  }

  // 2. copses: tight mixed groups with shrubs round the edge, on the banks and out in the fields
  const copseN = 46;
  for (let c = 0, made = 0; c < 600 && made < copseN; c++) {
    const a = r() * Math.PI * 2, rad = 95 + Math.pow(r(), 1.3) * 1000, cx = Math.cos(a) * rad, cz = Math.sin(a) * rad;
    const s = sample(cx, cz);
    if (s.zone !== 'outer' || s.dEdge < 10 || s.h < 2 || forest(cx, cz) > 0.08 || !clear(cx, cz, 45)) continue;
    made++;
    const R = 8 + r() * (rad < 200 ? 12 : 26), n = Math.round(R * R * 0.045 * (0.7 + r() * 0.6));
    const pine = r() < 0.2;
    for (let k = 0; k < n * 3 && n > 0; k++) {
      const aa = r() * Math.PI * 2, d = R * Math.sqrt(r()), x = cx + Math.cos(aa) * d, z = cz + Math.sin(aa) * d, ss = sample(x, z);
      if (ss.zone !== 'outer' || ss.dEdge < 4 || ss.h < 1.5 || !clear(x, z) || near(x, z, 4.5)) continue;
      const edge = d > R * 0.75;
      push(x, z, edge && r() < 0.5 ? (r() < 0.5 ? BUSH_A : BUSH_B) : pine && r() < 0.7 ? PINE : broadleaf(r()), edge ? 0.7 + r() * 0.4 : 0.8 + r() * 0.45);
    }
  }

  // 3. hedgerows along a jittered field grid, with standard trees and field gateways
  const fr = rngFor('fields'), ang = 0.38, ca = Math.cos(ang), sa = Math.sin(ang);
  const GX = 150, GZ = 112, N = 9;
  const jit = (i: number, j: number): [number, number] => {
    const q = mulberry32(hashSeed(`field${i},${j}`));
    const u = i * GX + (q() - 0.5) * 50, w = j * GZ + (q() - 0.5) * 40;
    return [u * ca - w * sa + 40, u * sa + w * ca - 25];
  };
  for (let i = -N; i <= N; i++) for (let j = -N; j <= N; j++) {
    for (const [di, dj] of [[1, 0], [0, 1]]) {
      if (fr() > 0.68) continue;
      const [ax, az] = jit(i, j), [bx, bz] = jit(i + di, j + dj);
      const len = Math.hypot(bx - ax, bz - az), wob = fr() * 10;
      let gapAt = fr() < 0.6 ? fr() * len : -100;
      let nextTree = 12 + fr() * 40;
      for (let d = 0; d < len; d += 2.3 + fr() * 1.4) {
        if (Math.abs(d - gapAt) < 4) continue;
        const t = d / len, side = Math.sin(t * 9 + wob) * 1.2 + (fr() - 0.5) * 1.4;
        const x = ax + (bx - ax) * t - ((bz - az) / len) * side, z = az + (bz - az) * t + ((bx - ax) / len) * side;
        const rr = Math.hypot(x, z);
        if (rr < 115 || rr > 1250) continue;
        const s = sample(x, z);
        if (s.zone !== 'outer' || s.dEdge < 12 || s.h < 2 || s.h > 260 || forest(x, z) > 0.1 || !clear(x, z)) continue;
        if (d > nextTree) { push(x, z, fr() < 0.6 ? OAK_M : fr() < 0.5 ? OAK_L : ASH, 0.75 + fr() * 0.4); nextTree = d + 18 + fr() * 55; continue; }
        push(x, z, fr() < 0.55 ? BUSH_A : BUSH_B, 0.85 + fr() * 0.5, 0.15);
      }
      if (gapAt > 0) gapAt = -100;
    }
  }

  // 4. forests: spacing grows with distance so the far ones are a dense, even canopy
  const fo = rngFor('forests');
  const B = 100;
  for (let bx = -4200; bx < 4200; bx += B) for (let bz = -4200; bz < 4200; bz += B) {
    const rc = Math.hypot(bx + B / 2, bz + B / 2);
    if (rc < 300 || rc > 2700) continue;
    const grow = Math.max(1, rc / 600), cell = 9 * grow, n = Math.max(1, Math.round(B / cell));
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x = bx + (i + fo()) * (B / n), z = bz + (j + fo()) * (B / n), rr = Math.hypot(x, z);
      if (rr < 330) continue;
      const f = forest(x, z), q = fo();
      if (f < 0.07 || (f < 0.15 && q > (f - 0.07) / 0.08)) continue;
      const s = sample(x, z);
      if (s.h < 1.5 || s.h > 240 || !clear(x, z)) continue;
      const edge = f < 0.13;
      const v = edge && fo() < 0.55 ? (fo() < 0.5 ? BUSH_A : BUSH_B) : (s.h > 140 || forestN(x / 300 + 9, z / 300) > 0.35) && fo() < 0.75 ? PINE : broadleaf(fo());
      // far away each impostor stands for a small clump: a little taller, a lot wider
      const sc = (edge ? 1 : Math.pow(grow, 0.4)) * (0.85 + fo() * 0.4) * (v >= BUSH_A ? 1.3 : 1);
      spots.push({ x, y: s.h - 0.4 - rr * 0.0015, z, v, s: sc, rot: fo() * Math.PI * 2, b: 0.8 + fo() * 0.3, w: edge ? 1 : Math.min(2.0, Math.pow(grow, 0.7)) });
    }
  }
  return spots;
}

