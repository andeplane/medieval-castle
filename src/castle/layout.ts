// Plan-level layout derived from the spec: courtyard, wing quads, tower centres, room split,
// island and moat outlines, and the footprints used for walking collision and tests.
import { createNoise2D } from 'simplex-noise';
import { mulberry32, hashSeed } from '../core/rng';
import { type V2, sub, norm, intersect, lerp2, centroid, add, scale, rot } from '../core/math2d';
import { CORNERS, WINGS, TOWERS, GATEHOUSE, EAST_TURRET, STAIR_TOWER, ISLAND, MOAT, type WingSpec, type TowerSpec } from './spec';

const KEYS = ['A', 'B', 'C', 'D'] as const;
export const outerPoly = (): V2[] => KEYS.map((k) => CORNERS[k]);

/** Inward normal for the loop A→B→C→D (clockwise when seen from above with z pointing south). */
export function inward(a: V2, b: V2): V2 { const d = norm(sub(b, a)); return [-d[1], d[0]]; }

export function courtyard(): V2[] {
  const lines = WINGS.map((w) => {
    const a = CORNERS[w.a], b = CORNERS[w.b], n = inward(a, b);
    return { p: add(a, scale(n, w.depth)), r: sub(b, a) };
  });
  return KEYS.map((_, i) => { const L0 = lines[(i + 3) % 4], L1 = lines[i]; return intersect(L0.p, L0.r, L1.p, L1.r); });
}

export interface WingQuad extends WingSpec { quad: [V2, V2, V2, V2]; length: number; dir: V2; out: V2 }
export function wingQuads(): WingQuad[] {
  const inner = courtyard();
  return WINGS.map((w, i) => {
    const a = CORNERS[w.a], b = CORNERS[w.b], d = norm(sub(b, a));
    return { ...w, quad: [a, b, inner[(i + 1) % 4], inner[i]], length: Math.hypot(b[0] - a[0], b[1] - a[1]), dir: d, out: [d[1], -d[0]] };
  });
}

export const castleCentre = (): V2 => centroid(outerPoly());

export function towerCentre(t: TowerSpec): V2 {
  const c = CORNERS[t.at], m = castleCentre();
  return lerp2(c, m, t.pull);
}

/** Rectangle corners for a square tower, rotated by rot. */
export function squareTowerPoly(t: Extract<TowerSpec, { kind: 'square' }>): V2[] {
  const c = towerCentre(t);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as V2[]).map(([sx, sz]) => add(c, rot([sx * t.w / 2, sz * t.d / 2], t.rot)));
}

export function gatehouseFrame() {
  const w = wingQuads().find((q) => q.id === GATEHOUSE.wing)!;
  const base = lerp2(w.quad[0], w.quad[1], GATEHOUSE.t);
  return { wing: w, base, dir: w.dir, out: w.out, centre: add(base, scale(w.out, GATEHOUSE.project / 2)) };
}
export function eastTurretFrame() {
  const w = wingQuads().find((q) => q.id === EAST_TURRET.wing)!;
  const base = lerp2(w.quad[0], w.quad[1], EAST_TURRET.t);
  return { wing: w, base, dir: w.dir, out: w.out };
}
export function stairTowerCentre(): V2 {
  const inner = courtyard(), c = inner[STAIR_TOWER.corner], m = centroid(inner);
  return lerp2(c, m, 0.16);
}
/** The courtyard stair tower's octagon. */
export function stairTowerPoly(): V2[] {
  const c = stairTowerCentre(), n = STAIR_TOWER.sides, R = STAIR_TOWER.r;
  return Array.from({ length: n }, (_, i) => [c[0] + Math.cos((i / n) * Math.PI * 2 + 0.2) * R, c[1] + Math.sin((i / n) * Math.PI * 2 + 0.2) * R] as V2);
}

/** 20 rooms per floor: each wing split along its length, widths jittered so no two rooms match. */
export function rooms(seed = hashSeed('rooms')) {
  const r = mulberry32(seed), out: { wing: string; k: number; poly: V2[] }[] = [];
  for (const w of wingQuads()) {
    const [a, b, ib, ia] = w.quad, n = w.rooms;
    let ws = Array.from({ length: n }, () => 0.75 + r() * 0.5);
    const s = ws.reduce((x, y) => x + y, 0); ws = ws.map((v) => v / s);
    let t = 0;
    for (let k = 0; k < n; k++) {
      const t0 = t, t1 = t + ws[k]; t = t1;
      out.push({ wing: w.id, k, poly: [lerp2(a, b, t0), lerp2(a, b, t1), lerp2(ia, ib, t1), lerp2(ia, ib, t0)] });
    }
  }
  return out;
}

/** Everything the player cannot walk through, as polygons (approximate circles as 16-gons). */
export function footprints(): V2[][] {
  const polys: V2[][] = [outerPoly()];
  const circle = (c: V2, r: number, n = 16): V2[] => Array.from({ length: n }, (_, i) => [c[0] + Math.cos((i / n) * 2 * Math.PI) * r, c[1] + Math.sin((i / n) * 2 * Math.PI) * r] as V2);
  for (const t of TOWERS) polys.push(t.kind === 'square' ? squareTowerPoly(t) : circle(towerCentre(t), t.r + 0.8));
  const g = gatehouseFrame();
  const hw = GATEHOUSE.width / 2;
  polys.push([add(g.base, scale(g.dir, -hw)), add(g.base, scale(g.dir, hw)), add(add(g.base, scale(g.dir, hw)), scale(g.out, GATEHOUSE.project)), add(add(g.base, scale(g.dir, -hw)), scale(g.out, GATEHOUSE.project))]);
  const e = eastTurretFrame(), ew = EAST_TURRET.w / 2;
  polys.push([add(e.base, scale(e.dir, -ew)), add(e.base, scale(e.dir, ew)), add(add(e.base, scale(e.dir, ew)), scale(e.out, EAST_TURRET.project)), add(add(e.base, scale(e.dir, -ew)), scale(e.out, EAST_TURRET.project))]);
  return polys;
}

/** Island outline: noisy ellipse, tight on the north (walls near the water) and roomy to the south-east. */
export function islandOutline(): V2[] {
  const n = createNoise2D(mulberry32(hashSeed('island')));
  const pts: V2[] = [];
  const N = 128;
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2, cx = Math.cos(th), sz = Math.sin(th);
    let rx = ISLAND.rx, rz = ISLAND.rz;
    const north = Math.max(0, -sz), se = Math.max(0, cx * 0.7 + sz * 0.7);
    rz -= north * ISLAND.northSquash; rx += se * ISLAND.seGrow[0]; rz += se * ISLAND.seGrow[1];
    const k = 1 + ISLAND.wobble[0] * n(cx * 1.3, sz * 1.3) + ISLAND.wobble[1] * n(cx * 4 + 9, sz * 4) + 0.012 * n(cx * 9, sz * 9 + 3);
    pts.push([cx * rx * k - 2, sz * rz * k + 1]);
  }
  return pts;
}

export function moatOuter(island: V2[]): V2[] {
  const n = createNoise2D(mulberry32(hashSeed('moat')));
  return island.map(([x, z]) => {
    const th = Math.atan2(z, x);
    const w = MOAT.width + MOAT.widthNoise * n(Math.cos(th) * 1.6, Math.sin(th) * 1.6) + (th < -0.6 && th > -2.2 ? MOAT.northExtra : 0);
    const l = Math.hypot(x, z);
    return [x + (x / l) * w, z + (z / l) * w] as V2;
  });
}
