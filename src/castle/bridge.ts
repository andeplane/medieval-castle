// The old three-arch bridge across the south moat, its middle span fallen into the water. It explains why
// the player cannot leave the island, gives the moat view a focal point, and its island half is walkable
// up to the broken edge.
//
// bridgePlan() is pure data (positions, arches, the deck profile, the break, the rubble); buildBridge()
// turns a plan into Builder triangles. Everything random comes from the injected rng.
//
// Coordinates along the bridge: t runs from the island outline crossing (t = 0) toward the far bank, s
// runs across (positive to the right looking outward), y is absolute height.
import type { Rng } from '../core/rng';
import { type V2, add, scale, sub, norm, dot, pointInPoly, edgeDist, smoothstep, clamp } from '../core/math2d';
import { type Builder, type MatKey, wallFrame } from './builder';
import { addStone, boxCorners, wedgeCorners, faceQuad, faceTri, type Stone, type V3 } from './rubble';

export interface BridgeInput {
  island: V2[];
  moatOuter: V2[];
  /** Where the road leaves the gatehouse and which way it points. */
  gate: { centre: V2; out: V2 };
  groundAt: (x: number, z: number) => number;
  rng: Rng;
}

/** Points on each break line, from the ring to the deck; the last one is the deck edge. */
export const BREAK_PTS = 9;
const DK = BREAK_PTS - 1;

export const BRIDGE = {
  width: 4.4,       // outer width between the spandrel faces
  parapet: 0.45,    // parapet thickness
  parapetH: 0.95,   // parapet height above the deck
  ring: 0.5,        // nominal voussoir depth
  spring: -0.25,    // arches spring just below the water
  bed: -3.0,        // foundations
  pier: 1.5,        // pier length along the bridge
  cutwater: 1.5,    // how far the cutwaters project
  approach: 4.5,    // paved approach on the island
  farRun: 4.5,      // far abutment runs this far onto the outer bank
  hump: 0.6,        // the deck rises this much toward the middle
  minGap: 4.0,      // the fallen span leaves at least this much open deck
  rubbleTop: 0.6,   // nothing in the heap stands higher than this above the water
  edgeMargin: 0.3,  // the walkable deck stops this far short of the broken edge
};

/** A segmental arch between a and b (t), springing at BRIDGE.spring. */
export interface Arch { a: number; b: number; rise: number; R: number; cx: number; cy: number; al: number; n: number; intact: boolean }

export function makeArch(a: number, b: number, rise: number, intact: boolean): Arch {
  const L = b - a, R = (L * L / 4 + rise * rise) / (2 * rise), cy = BRIDGE.spring + rise - R, al = Math.asin((R - rise) / R);
  const n = Math.max(7, Math.round((R * (Math.PI - 2 * al)) / 0.42) | 1);
  return { a, b, rise, R, cx: (a + b) / 2, cy, al, n, intact };
}

/** Point on an arch at u (0 = left springing, 1 = right) and radius r: [t, y]. */
export function archPt(A: Arch, u: number, r: number): V2 {
  const th = Math.PI - A.al - u * (Math.PI - 2 * A.al);
  return [A.cx + r * Math.cos(th), A.cy + r * Math.sin(th)];
}

/** Mirror an arch for the far half, where local tau = -t. */
const mirrorArch = (A: Arch): Arch => ({ ...A, a: -A.b, b: -A.a, cx: -A.cx });

export interface Slice { s0: number; s1: number; bounds: number[] }
export interface Break {
  /** Stones left on each slice of the broken ring, counted from the pier. */
  left: number[];
  /** Points (tau, y) up the broken spandrel on the back (s < 0) and front (s > 0) faces, from the ring to the deck. */
  side: [V2[], V2[]];
  /** Core columns across the width: s and (tau, y) points from the ring to the deck. */
  cols: { s: number; pts: V2[] }[];
  /** Parapet ends per side: points from the deck edge up to the parapet top. */
  parapet: [V2[], V2[]];
  /** Coping stones stop here on each side. */
  copingEnd: [number, number];
}

/** One standing half of the bridge in local coordinates (tau = t on the island half, -t on the far half). */
export interface Half {
  sign: 1 | -1;
  tau0: number;           // the approach end
  abut: number;           // abutment face where the first arch springs
  arches: Arch[];         // intact arches, local
  stub: Arch;             // the broken arch, local, springing at its left end
  slices: Slice[];        // ring courses of the stub
  brk: Break;
  parStart: number;       // parapets start here
  /** Deck top at local tau. */
  deck: (tau: number) => number;
}

export interface RubbleStone extends Stone { kind: 'voussoir' | 'block' | 'ashlar' | 'coping' | 'slab'; size: number }

export interface BridgePlan {
  O: V2; d: V2; side: V2;
  M: number;              // moat width along the axis
  tStart: number; tEnd: number; tA: number; tB: number;
  arches: Arch[];         // global, left to right; arches[1] is the fallen one
  piers: [number, number][];
  deck: (t: number) => number;
  halves: [Half, Half];   // island half, far half
  slicesIntact: Slice[][];
  rubble: RubbleStone[];
  /** Walkable deck from the island approach to the broken edge (x, z). */
  walkable: V2[];
  /** Island abutment footprint: the revetment and its turf stop here. */
  footprint: V2[];
  /** Deck height inside the walkable polygon, else null. */
  deckHeightAt: (x: number, z: number) => number | null;
  /** World position of (t, s). */
  P: (t: number, s: number) => V2;
  /** Lowest point of the open gap at deck level: [island edge t, far edge t]. */
  gap: [number, number];
}

/** Unit normal of the polygon edge nearest to p (sign arbitrary). */
export function outlineNormal(poly: V2[], p: V2): V2 {
  let best = 1e9, n: V2 = [1, 0];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], e = edgeDist([a, b], p[0], p[1]).d;
    if (e < best) { best = e; const dd = norm(sub(b, a)); n = [-dd[1], dd[0]]; }
  }
  return n;
}

function hit(poly: V2[], from: V2, d: V2, start: number) {
  for (let t = start; t < 400; t += 0.02) { const p = add(from, scale(d, t)); if (!pointInPoly(poly, p[0], p[1])) return t; }
  return 400;
}

/** Walking that includes the bridge deck: the deck's walkable strip is added to `canWalk`, and its
 *  height replaces the ground there (the water and the moat bed lie under it). */
export function withBridge(plan: Pick<BridgePlan, 'deckHeightAt'>, canWalk: (x: number, z: number) => boolean, groundAt: (x: number, z: number) => number) {
  return {
    canWalk: (x: number, z: number) => canWalk(x, z) || plan.deckHeightAt(x, z) !== null,
    groundAt: (x: number, z: number) => plan.deckHeightAt(x, z) ?? groundAt(x, z),
  };
}

export function bridgePlan(inp: BridgeInput): BridgePlan {
  const r = inp.rng;
  const W = BRIDGE.width, hw = W / 2;
  const d = norm(add(inp.gate.out, [0.12, 0])); // slightly skewed, as old bridges often are
  const side: V2 = [-d[1], d[0]];
  const tIsland = hit(inp.island, inp.gate.centre, d, 5);
  const O = add(inp.gate.centre, scale(d, tIsland));
  const M = hit(inp.moatOuter, O, d, 1) ;
  const P = (t: number, s: number): V2 => add(add(O, scale(d, t)), scale(side, s));

  // the abutment must reach past the revetment face (0.75 m out from the outline) on both sides
  const cosA = clamp(Math.abs(dot(outlineNormal(inp.island, O), d)), 0.5, 1);
  const tA = Math.max(1.2, (0.75 + 0.35) / cosA + hw * Math.sqrt(1 - cosA * cosA) / cosA + 0.2);
  const tB = M - 0.6;
  const tStart = -BRIDGE.approach, tEnd = M + BRIDGE.farRun;

  // spans: a wider middle arch between two narrower ones
  const pw = BRIDGE.pier, clear = tB - tA - 2 * pw, unit = clear / 3.0;
  const spans = [0.85 * unit, 1.3 * unit, 0.85 * unit];
  const piers: [number, number][] = [[tA + spans[0], tA + spans[0] + pw], [tA + spans[0] + pw + spans[1], tA + spans[0] + pw + spans[1] + pw]];

  // deck: paved approach at turf level, then a gentle hump over the water, down to the far bank
  const groundMax = (t: number) => Math.max(...[-hw, 0, hw].map((s) => { const p = P(t, s); return inp.groundAt(p[0], p[1]); }));
  const yI = (groundMax(-0.8) + groundMax(-1.6) + groundMax(-2.4)) / 3 + 0.06;
  const yF = Math.max(groundMax(tEnd), groundMax(tEnd - 1)) + 0.06;
  const approach = (t: number) => (groundMax(t - 0.6) + groundMax(t) + groundMax(t + 0.6)) / 3 + 0.06;
  const L = tEnd - 0.8;
  const deck = (t: number) => {
    if (t < -0.8) { const k = smoothstep(-2.4, -0.8, t); return approach(t) * (1 - k) + yI * k; }
    const u = clamp((t + 0.8) / (L + 0.8), 0, 1);
    return yI + (yF - yI) * smoothstep(0, 1, u) + BRIDGE.hump * Math.sin(Math.PI * u);
  };
  const arches: Arch[] = [[tA, piers[0][0]], [piers[0][1], piers[1][0]], [piers[1][1], tB]].map(([a, b], k) => {
    const Ls = b - a, crown = deck((a + b) / 2);
    const rise = clamp(crown - 0.22 - BRIDGE.ring - BRIDGE.spring, 0.2 * Ls, 0.46 * Ls);
    return makeArch(a, b, rise, k !== 1);
  });

  const mkSlices = (n: number): Slice[] => {
    const b1 = -W / 6 + (r() - 0.5) * 0.3, b2 = W / 6 + (r() - 0.5) * 0.3;
    const ranges: [number, number][] = [[-hw - 0.03 - r() * 0.03, b1], [b1, b2], [b2, hw + 0.03 + r() * 0.03]];
    return ranges.map(([s0, s1], j) => {
      const off = j === 1 ? 0.5 : 0, bounds: number[] = [0];
      for (let k = 1; k <= n; k++) { const u = (k - off) / n; if (u > 1e-6 && u < 1 - 1e-6) bounds.push(u); }
      bounds.push(1);
      return { s0, s1, bounds };
    });
  };
  const slicesIntact = [mkSlices(arches[0].n), mkSlices(arches[2].n)];

  // the two standing halves, each in local coordinates where its broken end faces +tau
  const mkHalf = (sign: 1 | -1): Half => {
    const g = (tau: number) => tau * sign; // local -> global t
    const fallen = arches[1];
    const stub = sign === 1 ? fallen : mirrorArch(fallen);
    const intact = sign === 1 ? [arches[0]] : [mirrorArch(arches[2])];
    const slices = mkSlices(stub.n);
    const pierFace = stub.a;
    // the deck may stand at most this far past the pier face so the gap stays >= minGap
    const reach = Math.max(0.3, ((fallen.b - fallen.a) - BRIDGE.minGap) / 2);
    const half: Half = {
      sign, tau0: sign === 1 ? tStart : -tEnd, abut: sign === 1 ? tA : -tB, arches: intact, stub, slices,
      parStart: sign === 1 ? -1.6 : -(tEnd - 1.4),
      deck: (tau) => deck(g(tau)),
      brk: undefined as unknown as Break,
    };
    const ext = (j: number, k: number) => archPt(stub, slices[j].bounds[Math.min(k, slices[j].bounds.length - 1)], stub.R + 0.45);
    // stones left on each ring course; the ring may stick out past the broken deck, but not far
    const left = slices.map((_, j) => { let m = 3 + Math.floor(r() * 3); while (m > 2 && ext(j, m)[0] > pierFace + reach + 0.6) m--; return m; });
    const lo = pierFace - 0.9, hi = pierFace + reach + 0.25;
    const topTau = (base: number) => clamp(base + (r() - 0.6) * 1.4, pierFace - 0.6, pierFace + reach);
    // the break climbs from the ring to the deck in steps along the masonry courses
    const stair = (j: number, tTop: number, lv: number[], runs: number[]): V2[] => {
      const b = ext(j, left[j] - 1), e = ext(j, left[j]), yTop = half.deck(tTop);
      const y1 = Math.min(Math.max(lv[0], b[1] + 0.12, e[1] + 0.12), yTop - 0.3);
      const y2 = Math.min(Math.max(lv[1], y1 + 0.08), yTop - 0.2), y3 = Math.min(Math.max(lv[2], y2 + 0.08), yTop - 0.1);
      return [b, [b[0], y1], [runs[0], y1], [runs[0], y2], [runs[1], y2], [runs[1], y3], [runs[2], y3], [runs[2], yTop], [tTop, yTop]];
    };
    const plan3 = (j: number, tTop: number) => {
      const yb = ext(j, left[j] - 1)[1], yT = half.deck(tTop), b0 = ext(j, left[j] - 1)[0];
      const lv = [1, 2, 3].map((k) => yb + ((yT - yb) * k) / 4 + (r() - 0.5) * 0.16);
      const runs = [1, 2, 3].map((k) => clamp(b0 + ((tTop - b0) * k) / 3 + (r() - 0.5) * 1.3, lo, hi));
      return { lv, runs };
    };
    const tops = [topTau(ext(0, left[0])[0]), topTau(ext(2, left[2])[0])];
    const pb = plan3(0, tops[0]), pf = plan3(2, tops[1]);
    const sideBack = stair(0, tops[0], pb.lv, pb.runs), sideFront = stair(2, tops[1], pf.lv, pf.runs);
    const ps = BRIDGE.parapet, ph = BRIDGE.parapetH;
    // parapets broke back further than the deck, in a step or two
    const parEnd = (pts: V2[]): V2[] => {
      const tt = pts[DK][0], tpe = tt - 0.3 - r() * 2.0, t1 = Math.max(tpe + 0.05, tt - r() * 0.6), h1 = 0.15 + r() * 0.45;
      return [[t1, half.deck(t1) + h1], [tpe, half.deck(tpe) + h1], [tpe, half.deck(tpe) + ph]];
    };
    const parapet: [V2[], V2[]] = [parEnd(sideBack), parEnd(sideFront)];
    // core columns: the faces, the parapet inner faces, both sides of each slice joint, and the middle
    const inner = (k: number, joints: number[]) => {
      const lv = pb.lv.map((v, i) => v + (pf.lv[i] - v) * k + (r() - 0.5) * 0.12);
      const runs = pb.runs.map((v, i) => clamp(v + (pf.runs[i] - v) * k + (r() - 0.5) * 0.8, lo, hi));
      const tTop = clamp(tops[0] + (tops[1] - tops[0]) * k + (r() - 0.5) * 0.9, pierFace - 0.6, pierFace + reach);
      return joints.map((j) => stair(j, tTop, lv, runs));
    };
    const [c1a, c1b] = inner(0.33, [0, 1]), [c2] = inner(0.5, [1]), [c3a, c3b] = inner(0.67, [1, 2]);
    const s1 = slices[0].s1, s2 = slices[1].s1;
    const cols = [
      { s: -hw, pts: sideBack }, { s: -hw + ps, pts: sideBack },
      { s: s1, pts: c1a }, { s: s1, pts: c1b },
      { s: (s1 + s2) / 2, pts: c2 },
      { s: s2, pts: c3a }, { s: s2, pts: c3b },
      { s: hw - ps, pts: sideFront }, { s: hw, pts: sideFront },
    ];
    half.brk = {
      left, side: [sideBack, sideFront], cols, parapet,
      copingEnd: [parapet[0][2][0] - 0.3 - r() * 1.4, parapet[1][2][0] - 0.3 - r() * 1.4],
    };
    return half;
  };
  const halves: [Half, Half] = [mkHalf(1), mkHalf(-1)];

  // deck edges at the gap, global t
  const edgeIsland = Math.max(...halves[0].brk.cols.map((c) => c.pts[DK][0]));
  const edgeFar = -Math.max(...halves[1].brk.cols.map((c) => c.pts[DK][0]));
  // stop a step short of the lowest point of the ragged edge
  const walkEnd = Math.min(...halves[0].brk.cols.map((c) => c.pts[DK][0])) - BRIDGE.edgeMargin;
  const wi = hw - BRIDGE.parapet;
  const walkable: V2[] = [P(tStart, -wi), P(walkEnd, -wi), P(walkEnd, wi), P(tStart, wi)];
  const footprint: V2[] = [P(tStart, -hw), P(tA, -hw), P(tA, hw), P(tStart, hw)];
  const deckHeightAt = (x: number, z: number) => {
    if (!pointInPoly(walkable, x, z)) return null;
    return deck(dot(sub([x, z], O), d));
  };

  const rubble = planRubble(r, arches[1], P, W);
  return { O, d, side, M, tStart, tEnd, tA, tB, arches, piers, deck, halves, slicesIntact, rubble, walkable, footprint, deckHeightAt, P, gap: [edgeIsland, edgeFar] };
}

/** The fallen span as a heap of tilted, half-sunk stones: voussoirs, fill, ashlar, coping and deck slabs. */
export function planRubble(r: Rng, A: Arch, P: (t: number, s: number) => V2, W: number): RubbleStone[] {
  const out: RubbleStone[] = [];
  const gap = A.b - A.a, tc = (A.a + A.b) / 2 + (r() - 0.5) * 0.6;
  const g2 = () => (r() + r()) / 2 - 0.5; // a soft bell in [-0.5, 0.5]
  const heap = (t: number, s: number) => -2.6 + 3.05 * Math.exp(-(((t - tc) / (0.42 * gap)) ** 2) - ((s / (0.7 * W)) ** 2));
  const kinds: [RubbleStone['kind'], number][] = [['voussoir', 11], ['block', 9], ['ashlar', 18], ['coping', 4], ['slab', 3]];
  for (const [kind, count] of kinds) for (let i = 0; i < count; i++) {
    let t = tc + g2() * gap * 1.1, s = g2() * (W + 4.5);
    if ((kind === 'block' && i < 6) || (kind === 'voussoir' && i < 6)) { t = (i % 2 ? A.b - 0.5 : A.a + 0.5) + (r() - 0.5) * 0.9; s = (r() - 0.5) * (W + 1); } // fallen against the piers
    const big = kind === 'block' ? 0.8 + r() * 0.9 : kind === 'slab' ? 1.0 + r() * 0.5 : 0;
    const size: V3 = kind === 'voussoir' ? [0.46, 0.5 + r() * 0.1, W / 3 * (0.6 + r() * 0.4)]
      : kind === 'block' ? [big, big * (0.55 + r() * 0.3), big * (0.7 + r() * 0.3)]
      : kind === 'ashlar' ? [0.3 + r() * 0.45, 0.22 + r() * 0.15, 0.25 + r() * 0.3]
      : kind === 'coping' ? [0.8 + r() * 0.2, 0.17, 0.56]
      : [big, 0.28 + r() * 0.1, big * (0.7 + r() * 0.2)];
    const tilt = kind === 'block' ? 0.35 : 0.7;
    const pose = { c: [0, 0, 0] as V3, yaw: r() * Math.PI * 2, pitch: (r() - 0.5) * 2 * tilt, roll: (r() - 0.5) * 2 * tilt };
    const p = P(t, s);
    const ySurf = heap(t, s), near = Math.min(Math.abs(t - A.a), Math.abs(t - A.b)) < 1.2;
    pose.c = [p[0], Math.max(ySurf, near ? -0.1 - r() * 0.3 : -9) - size[1] * (0.05 + r() * 0.35), p[1]];
    let corners = kind === 'voussoir' ? wedgeCorners(size[0] * 0.84, size[0] * 1.08, size[1], size[2], pose) : boxCorners(size, pose);
    // nothing in the heap may stand high enough to step across on
    const bottom = Math.min(...corners.map((c) => c[1]));
    if (bottom > -0.05) corners = corners.map((c) => [c[0], c[1] - bottom - 0.05 - r() * 0.1, c[2]] as V3); // every stone sits in the water
    if (Math.max(...corners.map((c) => c[1])) > BRIDGE.rubbleTop) { const top = Math.max(...corners.map((c) => c[1])); corners = corners.map((c) => [c[0], c[1] - (top - BRIDGE.rubbleTop), c[2]] as V3); }
    const chipMax = kind === 'block' ? 0.28 : kind === 'voussoir' ? 0.09 : 0.07;
    const chips = Array.from({ length: 8 }, () => (r() < 0.25 ? 0.4 + r() * 0.6 : 0.1 + r() * 0.3) * chipMax);
    const mat: MatKey = kind === 'block' || kind === 'slab' ? 'old' : 'trim';
    out.push({ kind, mat, corners, chips, uvOff: [r() * 8, r() * 8], size: Math.max(...size) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Geometry

type V3t = V3;
interface Ctx { B: Builder; plan: BridgePlan; r: Rng }

/** Build the whole bridge. Returns the number of triangles added. */
export function buildBridge(B: Builder, plan: BridgePlan, r: Rng): number {
  const before = countTris(B);
  const c: Ctx = { B, plan, r };
  buildPiers(c);
  plan.arches.forEach((A, k) => { if (A.intact) voussoirs(c, A, plan.slicesIntact[k === 0 ? 0 : 1], 1, null); });
  for (const h of plan.halves) buildHalf(c, h);
  for (const s of plan.rubble) addStone(B, s.mat, s.corners, { chips: s.chips, uvScale: 0.6, uvOff: s.uvOff });
  return countTris(B) - before;
}

export function countTris(B: Builder) { return Object.values(B.bins).reduce((s, b) => s + b.pos.length / 9, 0); }

/** World position for (t, s, y) on the plan. */
const W3 = (plan: BridgePlan, t: number, s: number, y: number): V3t => { const p = plan.P(t, s); return [p[0], y, p[1]]; };

function buildPiers({ B, plan, r }: Ctx) {
  const hw = BRIDGE.width / 2;
  for (const [p0, p1] of plan.piers) {
    B.prism('old', [plan.P(p0, -hw - 0.15), plan.P(p1, -hw - 0.15), plan.P(p1, hw + 0.15), plan.P(p0, hw + 0.15)], BRIDGE.bed, BRIDGE.spring, { top: 'trim' });
    const mid = (p0 + p1) / 2;
    for (const sg of [-1, 1]) {
      const yc = 1.0 + r() * 0.25;
      const a = plan.P(p0 + 0.05, sg * hw), b = plan.P(p1 - 0.05, sg * hw), tip = plan.P(mid, sg * (hw + BRIDGE.cutwater));
      B.prism('old', [a, b, tip], BRIDGE.bed, yc, { top: null });
      // a sloping stone hood over the cutwater, leaning back onto the spandrel face
      const apex: V3t = W3(plan, mid, sg * hw, yc + 0.55);
      const A3: V3t = [a[0], yc, a[1]], B3: V3t = [b[0], yc, b[1]], T3: V3t = [tip[0], yc + 0.08, tip[1]];
      const up: V3t = [plan.side[0] * sg, 1, plan.side[1] * sg];
      tri(B, 'trim', A3, T3, apex, up);
      tri(B, 'trim', T3, B3, apex, up);
    }
  }
}

/** Voussoirs of an arch in local tau coordinates; `upTo` limits each slice (stub), null = whole ring. */
function voussoirs({ B, plan, r }: Ctx, A: Arch, slices: Slice[], sign: 1 | -1, upTo: number[] | null) {
  slices.forEach((sl, j) => {
    const last = upTo ? upTo[j] : sl.bounds.length - 1;
    for (let k = 0; k < last; k++) {
      const u0 = sl.bounds[k], u1 = sl.bounds[k + 1];
      const depth = BRIDGE.ring - 0.02 + r() * 0.1;
      const proud = (j === 0 ? -1 : j === 2 ? 1 : 0) * r() * 0.025;
      const s0 = sl.s0 + (j === 0 ? proud : 0), s1 = sl.s1 + (j === 2 ? proud : 0);
      const broken = upTo !== null && k === last - 1;
      const slip = broken ? 0.03 + r() * 0.06 : 0;
      const corners: V3t[] = [];
      for (let i = 0; i < 8; i++) {
        const u = i & 1 ? u1 : u0, rad = A.R + (i & 2 ? depth : 0), s = i & 4 ? s1 : s0;
        const [tau, y] = archPt(A, u, rad);
        corners.push(W3(plan, tau * sign + (broken ? slip * 0.6 * sign : 0), s, y - slip));
      }
      const chip = broken ? 0.06 : 0.025;
      addStone(B, 'trim', corners, { chips: Array.from({ length: 8 }, (_, i) => chip * (0.5 + r()) * (broken && i & 1 ? 2.5 : 1)), uvScale: 0.8, uvOff: [r() * 4, r() * 4] });
    }
  });
}

function buildHalf(c: Ctx, h: Half) {
  const { B, plan, r } = c;
  const W = BRIDGE.width, hw = W / 2, ps = BRIDGE.parapet, ph = BRIDGE.parapetH, sign = h.sign;
  const g = (tau: number) => tau * sign;
  const brk = h.brk;
  const stations = (a: number, b: number, step = 0.5) => { const n = Math.max(1, Math.ceil((b - a) / step)); return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n); };
  const frame = (s: number, out: number) => {
    const a = plan.P(g(0), s), b = plan.P(g(1), s);
    return wallFrame(a, b, scale(plan.side, out));
  };

  voussoirs(c, h.stub, h.slices, sign, brk.left);

  // the side faces: abutment, spandrels over the arches and pier, the break, and the parapet's outer face
  const sides: [number, number][] = [[0, -1], [1, 1]];
  for (const [k, sg] of sides) {
    const climb = brk.side[k], par = brk.parapet[k];
    const pts: V2[] = [[h.tau0, BRIDGE.bed], [h.abut, BRIDGE.bed]];
    for (const A of h.arches) for (let i = 0; i <= 16; i++) pts.push(archPt(A, i / 16, A.R));
    const j = k === 0 ? 0 : 2, uEnd = h.slices[j].bounds[brk.left[j]];
    for (let i = 0; i <= 10; i++) pts.push(archPt(h.stub, (uEnd * i) / 10, h.stub.R));
    pts.push(archPt(h.stub, uEnd, h.stub.R + 0.45));
    pts.push(...climb, ...par);
    const pe = par[par.length - 1][0];
    for (const tau of stations(h.parStart, pe).reverse().slice(1)) pts.push([tau, h.deck(tau) + ph]);
    pts.push([h.parStart, h.deck(h.parStart)]);
    for (const tau of stations(h.tau0, h.parStart).reverse().slice(1)) pts.push([tau, h.deck(tau)]);
    B.planar('old', frame(sg * hw, sg), dedupe(pts));

    // parapet inner face, top and ends
    const sIn = sg * (hw - ps);
    const inner: V2[] = [];
    for (const tau of stations(h.parStart, climb[DK][0])) inner.push([tau, h.deck(tau)]);
    inner.push(...par);
    for (const tau of stations(h.parStart, pe).reverse().slice(1)) inner.push([tau, h.deck(tau) + ph]);
    B.planar('old', frame(sIn, -sg), dedupe(inner));
    for (const [t0, t1] of pairs(stations(h.parStart, pe))) quad(B, 'old', W3(plan, g(t0), sIn, h.deck(t0) + ph), W3(plan, g(t1), sIn, h.deck(t1) + ph), W3(plan, g(t1), sg * hw, h.deck(t1) + ph), W3(plan, g(t0), sg * hw, h.deck(t0) + ph), [0, 1, 0]);
    const endPts: V2[] = [[climb[DK][0], h.deck(climb[DK][0])], ...par];
    for (const [a, b] of pairs(endPts)) quad(B, 'old', W3(plan, g(a[0]), sIn, a[1]), W3(plan, g(b[0]), sIn, b[1]), W3(plan, g(b[0]), sg * hw, b[1]), W3(plan, g(a[0]), sg * hw, a[1]), dirOf(plan, sign, 0.3));
    quad(B, 'old', W3(plan, g(h.parStart), sIn, h.deck(h.parStart)), W3(plan, g(h.parStart), sIn, h.deck(h.parStart) + ph), W3(plan, g(h.parStart), sg * hw, h.deck(h.parStart) + ph), W3(plan, g(h.parStart), sg * hw, h.deck(h.parStart)), dirOf(plan, sign, -1));

    // coping stones on the parapet, the last ones missing or knocked askew near the break
    let tau = h.parStart;
    const end = brk.copingEnd[k];
    while (tau < end - 0.25) {
      const len = Math.min(0.7 + r() * 0.3, end - tau);
      const missing = tau > end - 3.5 && r() < 0.18;
      if (!missing) {
        const t0 = tau + 0.004, t1 = tau + len - 0.004, w0 = sIn - sg * 0.055, w1 = sg * (hw + 0.055);
        const askew = tau > end - 1.6 ? (r() - 0.5) * 0.08 : 0;
        const y0 = h.deck(t0) + ph, y1 = h.deck(t1) + ph, hh = 0.16 + r() * 0.03;
        const cs: V3t[] = [];
        for (let i = 0; i < 8; i++) { const tt = i & 1 ? t1 : t0, ss = i & 4 ? w1 : w0, yb = i & 1 ? y1 : y0; cs.push(W3(plan, g(tt + (i & 4 ? askew : -askew)), ss, yb + (i & 2 ? hh : 0) + (i & 4 ? askew * 0.5 : 0))); }
        addStone(B, 'trim', cs, { chips: Array.from({ length: 8 }, () => 0.015 + r() * 0.035), skip: [2], uvScale: 0.8, uvOff: [r() * 4, r() * 4] });
      }
      tau += len;
    }

    // string course at deck level, ending short of the break
    const scEnd = Math.min(climb[DK][0], pe + 0.4) - 0.15 - r() * 0.3;
    tau = h.tau0 + 0.3;
    while (tau < scEnd - 0.2) {
      const len = Math.min(0.9 + r() * 0.4, scEnd - tau);
      const t0 = tau, t1 = tau + len - 0.005;
      const cs: V3t[] = [];
      for (let i = 0; i < 8; i++) { const tt = i & 1 ? t1 : t0, ss = sg * (i & 4 ? hw + 0.09 : hw - 0.05); cs.push(W3(plan, g(tt), ss, h.deck(tt) - 0.24 + (i & 2 ? 0.2 : 0))); }
      addStone(B, 'trim', cs, { uvScale: 0.8, uvOff: [r() * 4, r() * 4] });
      tau += len;
    }
  }

  // deck surface across the full width, with two worn wheel ruts that fade out near the break
  const cols = brk.cols;
  const tauEndAt = (s: number) => {
    for (let i = 0; i < cols.length - 1; i++) if (s >= cols[i].s - 1e-6 && s <= cols[i + 1].s + 1e-6) {
      const k = cols[i + 1].s - cols[i].s < 1e-6 ? 0 : (s - cols[i].s) / (cols[i + 1].s - cols[i].s);
      return cols[i].pts[DK][0] + (cols[i + 1].pts[DK][0] - cols[i].pts[DK][0]) * k;
    }
    return cols[cols.length - 1].pts[DK][0];
  };
  const deckCols = [-hw, -hw + ps, -1.4, -1.05, -0.8, -0.55, -0.2, 0.2, 0.55, 0.8, 1.05, 1.4, hw - ps, hw, ...cols.map((cc) => cc.s)].sort((a, b) => a - b).filter((v, i, a) => i === 0 || v - a[i - 1] > 1e-3);
  const rut = (tau: number, s: number) => 0.035 * Math.exp(-(((Math.abs(s) - 0.85) / 0.22) ** 2)) * smoothstep(tauEndAt(s) - 0.2, tauEndAt(s) - 1.2, tau) * smoothstep(h.tau0, h.tau0 + 1.5, tau);
  const maxEnd = Math.max(...cols.map((cc) => cc.pts[DK][0]));
  const st = stations(h.tau0, maxEnd, 0.5);
  for (let i = 0; i < deckCols.length - 1; i++) {
    const sa = deckCols[i], sb = deckCols[i + 1], ea = tauEndAt(sa), eb = tauEndAt(sb);
    for (let k = 0; k < st.length - 1; k++) {
      const a0 = Math.min(st[k], ea), a1 = Math.min(st[k + 1], ea), b0 = Math.min(st[k], eb), b1 = Math.min(st[k + 1], eb);
      if (a1 - a0 < 1e-4 && b1 - b0 < 1e-4) continue;
      const v = (tau: number, s: number) => W3(plan, g(tau), s, h.deck(tau) - rut(tau, s));
      quad(B, 'old', v(a0, sa), v(a1, sa), v(b1, sb), v(b0, sb), [0, 1, 0]);
    }
  }

  // the broken core: rough rubble between the columns, from the ring up to the deck
  for (let i = 0; i < cols.length - 1; i++) {
    const A = cols[i], C = cols[i + 1];
    for (let k = 0; k < DK; k++) {
      const p0 = W3(plan, g(A.pts[k][0]), A.s, A.pts[k][1]), p1 = W3(plan, g(A.pts[k + 1][0]), A.s, A.pts[k + 1][1]);
      const q0 = W3(plan, g(C.pts[k][0]), C.s, C.pts[k][1]), q1 = W3(plan, g(C.pts[k + 1][0]), C.s, C.pts[k + 1][1]);
      roughTri(B, plan, sign, p0, p1, q1);
      roughTri(B, plan, sign, p0, q1, q0);
    }
  }
  // a few rubble lumps proud of the broken core
  for (let i = 0; i < 6; i++) {
    const col = cols[1 + Math.floor(r() * (cols.length - 2))], k = 1 + Math.floor(r() * (DK - 1));
    const p = col.pts[k], sz = 0.18 + r() * 0.2;
    addStone(B, 'old', boxCorners([sz * 1.3, sz, sz], { c: W3(plan, g(p[0]), col.s + (r() - 0.5) * 0.4, p[1]), yaw: r() * 6, pitch: r() - 0.5, roll: r() - 0.5 }), { chips: Array.from({ length: 8 }, () => sz * (0.1 + r() * 0.3)), uvScale: 0.6 });
  }

  // ends: the approach lip and the abutment face under the first arch
  const e0 = h.tau0;
  quad(B, 'old', W3(plan, g(e0), -hw, h.deck(e0) - 0.45), W3(plan, g(e0), hw, h.deck(e0) - 0.45), W3(plan, g(e0), hw, h.deck(e0)), W3(plan, g(e0), -hw, h.deck(e0)), dirOf(plan, sign, -1));
}

function dirOf(plan: BridgePlan, sign: number, k: number): V3t { return [plan.d[0] * sign * k, 0, plan.d[1] * sign * k]; }

function pairs<T>(xs: T[]): [T, T][] { const o: [T, T][] = []; for (let i = 0; i < xs.length - 1; i++) o.push([xs[i], xs[i + 1]]); return o; }

function dedupe(pts: V2[]): V2[] {
  const o: V2[] = [];
  for (const p of pts) { const q = o[o.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-4) o.push(p); }
  if (o.length > 1 && Math.hypot(o[0][0] - o[o.length - 1][0], o[0][1] - o[o.length - 1][1]) < 1e-4) o.pop();
  return o;
}

const quad = faceQuad;
const tri = faceTri;

/** Break-face triangle: faces the gap; edge-on pieces (slice steps) get both sides. */
function roughTri(B: Builder, plan: BridgePlan, sign: number, a: V3t, b: V3t, c: V3t) {
  const out = dirOf(plan, sign, 1);
  const u: V3t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v: V3t = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: V3t = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n); if (l < 1e-9) return;
  const facing = (n[0] * out[0] + n[1] * out[1] + n[2] * out[2]) / l;
  if (Math.abs(facing) < 0.25) { tri(B, 'old', a, b, c, n); tri(B, 'old', a, b, c, [-n[0], -n[1], -n[2]]); }
  else tri(B, 'old', a, b, c, out);
}
