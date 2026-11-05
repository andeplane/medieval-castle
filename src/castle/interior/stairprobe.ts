// Geometry-level stair checks (game-debug-tools): cast vertical rays into the triangles a stair
// actually built and measure what a walker meets along the walking line (spirals: 2/3 of the radius;
// straight flights: the centre line). Used by tests/stairs.test.ts; the shell agent can run it over
// every stair of a plan.
import { type Builder, type MatKey } from '../builder';
import type { StairSpec, V3 } from './types';
import { toPlan, STAIR_RULES, spiralTreadY, type StairOpts, type StairPlan } from './stairs';

export interface ProbeResult {
  samples: number; missing: number;          // samples with no walking surface found
  rises: number[]; goings: number[];          // measured at the walking line
  maxRise: number; minGoing: number; minHeadroom: number; landingErr: number;
  nan: number; degenerate: number; triangles: number;
}

/** Triangles of the given bins, bucketed on an x/z grid for vertical ray casts. */
export class VerticalCaster {
  private cells = new Map<number, number[]>();
  readonly tris: Float64Array;
  constructor(pos: number[], private cell = 0.25) {
    this.tris = Float64Array.from(pos);
    for (let t = 0; t < pos.length / 9; t++) {
      const o = t * 9;
      const x0 = Math.min(pos[o], pos[o + 3], pos[o + 6]), x1 = Math.max(pos[o], pos[o + 3], pos[o + 6]);
      const z0 = Math.min(pos[o + 2], pos[o + 5], pos[o + 8]), z1 = Math.max(pos[o + 2], pos[o + 5], pos[o + 8]);
      for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) for (let k = Math.floor(z0 / cell); k <= Math.floor(z1 / cell); k++) {
        const key = i * 65536 + k; let l = this.cells.get(key); if (!l) this.cells.set(key, (l = [])); l.push(t);
      }
    }
  }
  /** All surfaces crossed by the vertical line at (x, z): height and whether the face looks up. */
  hits(x: number, z: number): { y: number; up: boolean }[] {
    const l = this.cells.get(Math.floor(x / this.cell) * 65536 + Math.floor(z / this.cell)) ?? [];
    const T = this.tris, out: { y: number; up: boolean }[] = [];
    for (const t of l) {
      const o = t * 9;
      const ax = T[o], az = T[o + 2], bx = T[o + 3], bz = T[o + 5], cx = T[o + 6], cz = T[o + 8];
      const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(den) < 1e-12) continue; // vertical face
      const w0 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / den;
      const w1 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / den;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
      const y = w0 * T[o + 1] + w1 * T[o + 4] + w2 * T[o + 7];
      // facing: y component of the geometric normal (winding is the visible side)
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      out.push({ y, up: ny > 0 });
    }
    return out.sort((a, b) => a.y - b.y);
  }
  /** Highest upward face at or below yMax. */
  floor(x: number, z: number, yMax: number) {
    let best = NaN;
    for (const h of this.hits(x, z)) if (h.up && h.y <= yMax) best = h.y;
    return best;
  }
  /** Lowest downward face above y. */
  ceiling(x: number, z: number, y: number) {
    for (const h of this.hits(x, z)) if (!h.up && h.y > y) return h.y;
    return Infinity;
  }
}

export function binTriangles(B: Pick<Builder, 'bins'>, mats: MatKey[]): number[] {
  const out: number[] = [];
  for (const m of mats) { const p = B.bins[m].pos; for (let i = 0; i < p.length; i++) out.push(p[i]); }
  return out;
}

/** NaN coordinates and triangles under 1e-7 m² (with more than a sliver of an edge). */
export function meshHealth(pos: number[]) {
  let nan = 0, degenerate = 0;
  for (let o = 0; o < pos.length; o += 9) {
    for (let k = 0; k < 9; k++) if (!Number.isFinite(pos[o + k])) { nan++; break; }
    const a: V3 = [pos[o + 3] - pos[o], pos[o + 4] - pos[o + 1], pos[o + 5] - pos[o + 2]];
    const b: V3 = [pos[o + 6] - pos[o], pos[o + 7] - pos[o + 1], pos[o + 8] - pos[o + 2]];
    const cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0];
    if (!(Math.hypot(cx, cy, cz) / 2 > 1e-7)) degenerate++;
  }
  return { nan, degenerate, triangles: pos.length / 9 };
}

/**
 * Walk the stair's walking line on the built geometry `B` (only the bins in `mats`) and measure
 * rises, goings, headroom and landing heights.
 */
export function probeStair(B: Pick<Builder, 'bins'>, s: StairSpec | StairPlan, o: StairOpts = {}, mats: MatKey[] = ['trim', 'old']): ProbeResult {
  const p = toPlan(s, o);
  const pos = binTriangles(B, mats);
  const caster = new VerticalCaster(pos);
  const health = meshHealth(pos);
  const STEP = 0.01;
  // sample points along the walking line: [x, z, expected nominal tread y, distance along the line]
  const pts: [number, number, number, number][] = [];
  if (p.kind === 'spiral') {
    const r = p.rWalk, last = p.steps[p.steps.length - 1];
    for (let q = p.entry[0] + 0.02; q < last.a1 - 0.02; q += STEP / r) {
      const a = p.theta0 + p.dir * q;
      pts.push([p.c[0] + Math.cos(a) * r, p.c[1] + Math.sin(a) * r, spiralTreadY(p, q), (q - p.entry[0]) * r]);
    }
  } else {
    const last = p.steps[p.steps.length - 1];
    for (let sc = 0.02; sc < Math.max(last.s1, last.s0) - 0.02; sc += STEP) {
      let y = p.yFloor;
      for (const st of p.steps) if (st.s0 - st.nosing <= sc) y = st.y;
      pts.push([p.o[0] + p.d[0] * sc, p.o[2] + p.d[1] * sc, y, sc]);
    }
  }
  const res: ProbeResult = { samples: pts.length, missing: 0, rises: [], goings: [], maxRise: 0, minGoing: Infinity, minHeadroom: Infinity, landingErr: 0, ...health };
  let prevY = NaN, lastJump = NaN;
  const ys: number[] = [];
  for (const [x, z, yN, dist] of pts) {
    const y = caster.floor(x, z, yN + 0.06);
    ys.push(y);
    if (Number.isNaN(y)) { res.missing++; continue; }
    if (!Number.isNaN(prevY)) {
      const dy = y - prevY;
      if (dy > 0.05) {
        res.rises.push(dy); res.maxRise = Math.max(res.maxRise, dy);
        if (!Number.isNaN(lastJump)) { const g = dist - lastJump; res.goings.push(g); res.minGoing = Math.min(res.minGoing, g); }
        lastJump = dist;
      }
    }
    prevY = y;
    // headroom: start above the next step's nosing so the step itself is not counted
    const ceil = caster.ceiling(x, z, y + STAIR_RULES.riseLimit + 0.06);
    res.minHeadroom = Math.min(res.minHeadroom, ceil - y);
  }
  // landings: walking surface at the door centre, on the walking line
  if (p.kind === 'spiral') {
    for (const l of p.landings) {
      if (!l) continue;
      const a = p.theta0 + p.dir * l.psi;
      const y = caster.floor(p.c[0] + Math.cos(a) * p.rWalk, p.c[1] + Math.sin(a) * p.rWalk, l.y + 0.06);
      res.landingErr = Math.max(res.landingErr, Math.abs(y - l.y));
    }
  } else {
    // landing treads (a 0-length top landing is the shell's floor, nothing to measure)
    for (const st of p.steps) {
      if (st.landing < 0 || st.s1 - st.s0 <= 0.05) continue;
      const sc = (st.s0 + st.s1) / 2;
      const y = caster.floor(p.o[0] + p.d[0] * sc, p.o[2] + p.d[1] * sc, st.y + 0.06);
      res.landingErr = Math.max(res.landingErr, Math.abs(y - st.y));
    }
  }
  return res;
}
