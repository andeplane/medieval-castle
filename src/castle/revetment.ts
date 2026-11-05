// Stone revetment around the island (as at Gravensteen): a battered rubble wall rising from the moat bed with
// a dressed coping course on top, and a strip of turf (castle/turf.ts) that runs under the coping. A few
// stretches have lost their coping and upper courses, with the stones lying in the water below.
//
// Cross-section, measured inward from the island outline (e > 0 is on the island):
//   e = -0.83 ......... coping front (0.08 proud of the face)
//   e = -0.75 ......... wall face at the top; it leans out by BATTER per metre on the way down
//   e = +0.07 ......... coping back; the turf (ground level) meets it ~5 cm below the coping top
//   e = -0.32 .. 1.9 .. turf strip, hiding the terrain grid where it steps down under the wall
// The terrain (world/terrain.ts) holds full height to e = 0.35 and drops under water outside it, so the
// terrain grid's one-cell step always lands inside this wall.
import type { Rng } from '../core/rng';
import { type V2 } from '../core/math2d';
import { type Builder, offsetPoly } from './builder';
import { addStone, boxCorners, faceQuad, type Stone, type V3 } from './rubble';

export const REVET = {
  face: 0.75,      // wall face (top) outside the island outline
  over: 0.08,      // coping overhang
  back: 0.07,      // coping back edge inside the outline
  copingH: 0.26,   // coping thickness
  rise: 0.08,      // coping top above the turf behind it
  batter: 0.1,     // horizontal lean-out per metre of height
  foot: -1.9,      // wall foot, buried in the moat mud
  turfOut: -0.32,  // turf strip, outer edge (under the coping)
  turfIn: 1.9,     // turf strip, inner edge (terrain is level beyond)
  level: 0.45,     // the turf takes its height from the ground this far in
};

export interface RevetmentInput {
  island: V2[];
  groundAt: (x: number, z: number) => number;
  rng: Rng;
  /** True where the wall must stop (the bridge abutment). */
  exclude?: (x: number, z: number) => boolean;
}

export interface Station { o: V2; n: V2; g: number; top: number }
export interface Segment {
  i: number;
  /** Parts of the segment (0..1) that are built; the rest is inside the exclusion. */
  keep: [number, number][];
  damaged: boolean;
  /** For damaged segments: top of the broken face at 0, 1/4 .. 1. */
  ragged: number[];
}
export interface RevetmentPlan {
  st: Station[];
  segs: Segment[];
  fallen: Stone[];
  /** Point on segment i at u (0..1), e metres inside the outline. */
  at: (i: number, u: number, e: number) => V2;
  /** Coping top on segment i at u. */
  topAt: (i: number, u: number) => number;
  /** Ground level on the island behind the wall at segment i, u. */
  groundAt: (i: number, u: number) => number;
  exclude: (x: number, z: number) => boolean;
  /** Cumulative arc length at each station (for continuous wall UVs). */
  arc: number[];
}

/** Kept sub-intervals of [0, 1] where `out(u)` is false, found by sampling and bisection. */
export function keptIntervals(out: (u: number) => boolean, samples = 24): [number, number][] {
  const res: [number, number][] = [];
  let start: number | null = out(0) ? null : 0;
  let prevU = 0, prevOut = out(0);
  const edge = (a: number, b: number, aOut: boolean) => { for (let k = 0; k < 14; k++) { const m = (a + b) / 2; if (out(m) === aOut) a = m; else b = m; } return (a + b) / 2; };
  for (let k = 1; k <= samples; k++) {
    const u = k / samples, o = out(u);
    if (o !== prevOut) {
      const x = edge(prevU, u, prevOut);
      if (o) { res.push([start!, x]); start = null; } else start = x;
    }
    prevU = u; prevOut = o;
  }
  if (start !== null) res.push([start, 1]);
  return res.filter(([a, b]) => b - a > 1e-3);
}

export function revetmentPlan(inp: RevetmentInput): RevetmentPlan {
  const { island, rng: r } = inp;
  const exclude = inp.exclude ?? (() => false);
  const n = island.length;
  const off = offsetPoly(island, 1);
  const st: Station[] = island.map((o, i) => ({ o, n: [off[i][0] - o[0], off[i][1] - o[1]] as V2, g: 0, top: 0 }));
  const at = (i: number, u: number, e: number): V2 => {
    const A = st[i], B = st[(i + 1) % n];
    const ox = A.o[0] + (B.o[0] - A.o[0]) * u, oz = A.o[1] + (B.o[1] - A.o[1]) * u;
    const nx = A.n[0] + (B.n[0] - A.n[0]) * u, nz = A.n[1] + (B.n[1] - A.n[1]) * u;
    return [ox - nx * e, oz - nz * e];
  };
  for (let i = 0; i < n; i++) {
    const g = Math.max(...[REVET.level, 1.0, 1.6].map((e) => { const p = at(i, 0, e); return inp.groundAt(p[0], p[1]); }));
    st[i].g = g;
    st[i].top = g + REVET.rise + (r() - 0.5) * 0.03;
  }
  const arc = [0];
  for (let i = 0; i < n; i++) { const a = st[i].o, b = st[(i + 1) % n].o; arc.push(arc[i] + Math.hypot(b[0] - a[0], b[1] - a[1])); }

  const segs: Segment[] = Array.from({ length: n }, (_, i) => ({
    i, damaged: false, ragged: [],
    keep: keptIntervals((u) => { const p = at(i, u, -0.4); return exclude(p[0], p[1]); }),
  }));
  // damaged stretches: a few runs of 1-2 segments well away from the bridge
  const fallen: Stone[] = [];
  for (let k = 0; k < 3; k++) {
    const s0 = Math.floor(r() * n), len = 1 + Math.floor(r() * 2);
    for (let j = 0; j < len; j++) {
      const sg = segs[(s0 + j) % n];
      if (sg.keep.length !== 1 || sg.keep[0][0] > 0 || sg.keep[0][1] < 1) continue;
      sg.damaged = true;
      const g = (st[sg.i].g + st[(sg.i + 1) % n].g) / 2;
      sg.ragged = Array.from({ length: 5 }, () => g - 0.35 - r() * 0.55);
      // coping and facing stones lying in the water below, tilted and half sunk
      for (let m = 0; m < 4; m++) {
        const p = at(sg.i, r(), -REVET.face - 0.6 - r() * 1.8), s = 0.3 + r() * 0.35, coping = r() < 0.5;
        const size: V3 = coping ? [0.7 + r() * 0.3, REVET.copingH, 0.8] : [s * 1.3, s, s * 0.9];
        fallen.push({
          mat: coping ? 'trim' : 'old', uvOff: [r() * 8, r() * 8],
          corners: boxCorners(size, { c: [p[0], -0.15 + r() * 0.2, p[1]], yaw: r() * 6.28, pitch: (r() - 0.5) * 1.0, roll: (r() - 0.5) * 1.0 }),
          chips: Array.from({ length: 8 }, () => 0.02 + r() * 0.08),
        });
      }
    }
  }
  const topAt = (i: number, u: number) => st[i].top + (st[(i + 1) % n].top - st[i].top) * u;
  const groundAtSeg = (i: number, u: number) => st[i].g + (st[(i + 1) % n].g - st[i].g) * u;
  return { st, segs, fallen, at, topAt, groundAt: groundAtSeg, exclude, arc };
}

/** Wall face, coping stones, broken tops and fallen stones. Returns triangles added. */
export function buildRevetment(B: Builder, plan: RevetmentPlan, r: Rng): number {
  const before = Object.values(B.bins).reduce((s, b) => s + b.pos.length, 0);
  const n = plan.st.length;
  const P3 = (i: number, u: number, e: number, y: number): V3 => { const p = plan.at(i, u, e); return [p[0], y, p[1]]; };
  const footE = (y: number) => -REVET.face - REVET.batter * (y - REVET.foot);
  const out = (i: number): V3 => { const a = plan.st[i].n, b = plan.st[(i + 1) % n].n; return [a[0] + b[0], 0, a[1] + b[1]]; };
  const T = 4;
  const faceUV = (i: number, u: number, y: number): [number, number] => [(plan.arc[i] + (plan.arc[i + 1] - plan.arc[i]) * u) / T, y / T];
  const faceQ = (i: number, u0: number, u1: number, y0: number, y1: number) => {
    // y0/y1: top of the face at u0/u1; the foot leans out with the batter
    const a = P3(i, u0, footE(y0), REVET.foot), b = P3(i, u1, footE(y1), REVET.foot), c = P3(i, u1, -REVET.face, y1), d = P3(i, u0, -REVET.face, y0);
    const bin = B.bins.old, o = out(i);
    const n3 = norm3([o[0], REVET.batter * 0.9, o[2]]);
    bin.tri(a, b, c, n3, faceUV(i, u0, REVET.foot), faceUV(i, u1, REVET.foot), faceUV(i, u1, y1));
    bin.tri(a, c, d, n3, faceUV(i, u0, REVET.foot), faceUV(i, u1, y1), faceUV(i, u0, y0));
  };
  // real stones (castle/stones) over the battered face, from the waterline to just under the coping
  const stoneRec = (i: number, ua: number, ub: number, tops: number[]) => {
    const yTop = tops.reduce((a, b) => a + b, 0) / tops.length, y1 = Math.min(...tops) - 0.02, y0 = Math.max(REVET.foot, B.stoneFloor);
    const A = plan.at(i, ua, -REVET.face), Z = plan.at(i, ub, -REVET.face), L = Math.hypot(Z[0] - A[0], Z[1] - A[1]);
    if (!B.stoneOn || L < 0.4 || y1 - y0 < 0.3) return;
    const rr: V2 = [(Z[0] - A[0]) / L, (Z[1] - A[1]) / L], o = out(i);
    let nh: V2 = [rr[1], -rr[0]];
    if (nh[0] * o[0] + nh[1] * o[2] < 0) nh = [-nh[0], -nh[1]];
    const H = yTop - REVET.foot, run = REVET.batter * H;
    B.stoneFaces.push({
      mat: 'old', geom: { kind: 'plane', o: [A[0] + nh[0] * run, 0, A[1] + nh[1] * run], r: [rr[0], 0, rr[1]], n: [nh[0], 0, nh[1]], bat: { y0: REVET.foot, H, run, ns: norm3([nh[0] * H, run, nh[1] * H]) } },
      s0: 0, s1: L, y0, y1, u0: plan.arc[i] + (plan.arc[i + 1] - plan.arc[i]) * ua, holes: [], ends: [false, false], sil: false, owner: -1,
    });
  };
  const endCap = (i: number, u: number, yTop: number, yLow: number, dir: number) => {
    // cross-section of the wall where it stops (bridge) or where a damaged stretch begins
    const hint: V3 = (() => { const a = plan.at(i, 0, 0), b = plan.at(i, 1, 0); return [(b[0] - a[0]) * dir, 0, (b[1] - a[1]) * dir]; })();
    faceQuad(B, 'old', P3(i, u, footE(yLow), yLow), P3(i, u, 0, yLow), P3(i, u, 0, yTop), P3(i, u, -REVET.face, yTop), hint);
  };

  for (const sg of plan.segs) {
    const i = sg.i, j = (i + 1) % n;
    if (sg.damaged) {
      const R = sg.ragged;
      for (let k = 0; k < 4; k++) {
        const u0 = k / 4, u1 = (k + 1) / 4;
        faceQ(i, u0, u1, R[k], R[k + 1]);
        // the broken wall top: rough core between the face and the turf
        faceQuad(B, 'old', P3(i, u0, -REVET.face, R[k]), P3(i, u1, -REVET.face, R[k + 1]), P3(i, u1, -0.1, R[k + 1] + 0.05), P3(i, u0, -0.1, R[k] + 0.05), [0, 1, 0]);
      }
      stoneRec(i, 0, 1, R);
      for (const [u, dir, nb] of [[0, 1, (i + n - 1) % n], [1, -1, j]] as [number, number, number][]) {
        if (!plan.segs[nb].damaged) endCap(i, u, plan.topAt(i, u) - REVET.copingH, R[u === 0 ? 0 : 4], dir);
      }
      continue;
    }
    for (const [ua, ub] of sg.keep) {
      faceQ(i, ua, ub, plan.topAt(i, ua) - REVET.copingH, plan.topAt(i, ub) - REVET.copingH);
      stoneRec(i, ua, ub, [plan.topAt(i, ua) - REVET.copingH, plan.topAt(i, ub) - REVET.copingH]);
      if (ua > 0) endCap(i, ua, plan.topAt(i, ua) - REVET.copingH, REVET.foot, -1);
      if (ub < 1) endCap(i, ub, plan.topAt(i, ub) - REVET.copingH, REVET.foot, 1);
      // coping stones, 0.6-1.0 m long, each sitting a little differently
      const Lseg = plan.arc[i + 1] - plan.arc[i];
      let u = ua;
      while (u < ub - 1e-4) {
        let du = (0.6 + r() * 0.4) / Lseg;
        if (ub - (u + du) < 0.3 / Lseg) du = ub - u;
        const u1 = Math.min(ub, u + du), dy = (r() - 0.5) * 0.025, tilt = (r() - 0.5) * 0.02;
        const cs: V3[] = [];
        for (let k = 0; k < 8; k++) {
          const uu = k & 1 ? u1 : u, front = !(k & 4), top = !!(k & 2);
          const y = plan.topAt(i, uu) + dy + (top ? 0 : -REVET.copingH) + (front ? tilt : -tilt);
          cs.push(P3(i, uu, front ? -REVET.face - REVET.over : REVET.back, y));
        }
        addStone(B, 'trim', cs, { skip: [2], uvScale: 0.9, uvOff: [r() * 4, r() * 4] });
        u = u1;
      }
    }
  }
  for (const s of plan.fallen) addStone(B, s.mat, s.corners, { chips: s.chips, uvScale: 0.6, uvOff: s.uvOff });
  return (Object.values(B.bins).reduce((s, b) => s + b.pos.length, 0) - before) / 9;
}

const norm3 = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
