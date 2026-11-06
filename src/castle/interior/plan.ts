// Interior plan (game-building-generation: plan → layout → geometry → validate). A pure function of the
// seed and spec.ts: rooms (convex polygons), doors between them, spiral and straight stairs, cellars and
// barrel-vaulted tunnels. Nothing here builds geometry; shell.ts turns the plan into meshes.
//
// Layout rules:
// - Each wing is a band between the inner faces of its outer wall (2.2 m old, 1.6 m new) and its courtyard
//   wall (1.2 m), cut where the corner towers stand and split into the spec's number of rooms by cross walls
//   (0.7 m old, 0.6 m new). Rooms on a floor open into each other (enfilade); the end rooms open into the
//   corner towers, so every floor is a ring: stair tower → N → great tower → W → SW tower → S → SE tower → E → NE.
// - Vertical circulation: the octagonal courtyard stair tower serves cellar to floor 6; each corner tower has
//   a spiral in its wall thickness serving all its floors (the towers rise above the wings); a straight stair
//   along the N courtyard wall links the undercroft with the cellars.
// - Ground floor: the gate passage (gatehouse + S wing) links outside to the courtyard; doors from the
//   courtyard into the N, E and W wings and the stair tower.
// - Cellars (y ≈ −1.6) under the N and W wings and the great tower; tunnels link them with the stair tower,
//   and one tunnel dips under the west moat to a sally port on the far bank, barred by a locked grille.
import type { V2 } from '../../core/math2d';
import { mulberry32, hashSeed, WORLD_SEED, type Rng } from '../../core/rng';
import { pointInPoly } from '../../core/math2d';
import { floorBase, FLOOR_HEIGHTS, TOWERS, GATEHOUSE, EAST_TURRET, STAIR_TOWER, GROUND, type Phase, type TowerSpec } from '../spec';
import { wingQuads, towerCentre, squareTowerPoly, gatehouseFrame, eastTurretFrame, stairTowerCentre, castleCentre, islandOutline, moatOuter, outerPoly, type WingQuad } from '../layout';
import type { RoomSpec, DoorSpec, StairSpec, InteriorPlan, RoomKind, SpaceId, V3 } from './types';
import { spiralStartFor, validateStair, planStair, spiralNosingY, spiralStonesAt, type StairOpts, type SpiralPlan } from './stairs';
import { masses, fits, boxOf, STAIR_SLIT, type Face, type DoorHole, type SpiralBehind } from '../openings';
import { placeLeaves, leafPoint, leafMatrix, m4apply, leafDepth, m4swing, LIP, doorOutlines, stopPlane, type LeafPlace } from './doorGeom';
import { type Half, clip, clipAll, area, orient, leftN, circlePoly, convexOverlap, centroidOf, local, add, sub, scale, dot, norm, archOutline, headRise, type Head } from './geom';

// ---------------------------------------------------------------- dimensions

export const CELLAR_Y = -1.8;      // cellar and tunnel floor
export const CELLAR_TOP = 1.9;     // crown of the cellar vaults (undercroft flags at 2.6 above)
export const SLAB = 0.35;          // timber floor build-up under each upper floor
export const T_OUT: Record<Phase, number> = { old: 2.2, new: 1.6 };
export const T_COURT = 1.2;
export const PART: Record<Phase, number> = { old: 0.7, new: 0.6 };
export const TOWER_WALL: Record<string, number> = { great: 2.6, sw: 2.2, ne: 2.4, se: 2.0 };
const TOWER_MARGIN = 0.4;          // wing rooms keep this far from a tower's outer face
const DIAG_INSET = 0.35;           // half the partition on the diagonal joint between two wings
export const TUNNEL_W = 1.9, TUNNEL_CROWN = 2.7;
export const MOAT_TUNNEL_Y = -6.5;
/** Radius of the tower spirals: from 1.75 m a spiral climbs a 4.4–6 m storey in whole turns with 2 m headroom, so every door can sit on the same side of the drum. */
export const SPIRAL_R = 1.9;
/** Clear width of the doors that open off a spiral's landings (the stair plans its landings for this). */
export const STAIR_DOOR_W = 1.0;
/** Distance from a shaft's centre to the flat it gets where its doors open (keeps a 1.6 m chord). */
const chordH = (r: number) => r * Math.cos(Math.asin(Math.min(0.95, 0.8 / r)));
/** Courtyard doors into the wings: clear width, and the rebate either side that must stay on the face too. */
export const COURT_DOOR_W = 1.6, COURT_DOOR_LIP = 0.1;
export const GATE = { width: 3.8, spring: 4.0, rise: 1.6, wall: 2.6, sill: GROUND - 0.1 };

export type ZoneId = string;
export const ZONE_PHASE: Record<ZoneId, Phase> = { N: 'old', W: 'old', E: 'new', S: 'new', great: 'old', sw: 'old', ne: 'new', se: 'new', gate: 'new', eturret: 'new', stairtower: 'new', tunnel: 'old' };

export interface RoundInfo { c: V2; r: number }
export interface VaultInfo { axis: V2; spring: number; ribs: boolean; murder?: boolean }
export interface TunnelSpec { id: string; room: SpaceId; path: V3[]; width: number; crown: number; portal?: boolean }

/** The contract plan plus what the shell needs to build it. */
export interface PlanX extends InteriorPlan {
  seed: number;
  round: Record<SpaceId, RoundInfo>;      // rooms whose walls are curved (tower drums, stair shafts, crossings)
  vault: Record<SpaceId, VaultInfo>;      // rooms with a stone vault instead of a timber ceiling
  tunnels: TunnelSpec[];
  rise: Record<string, number>;           // door head rise overrides (others: headRise(head, width))
  phase: Record<SpaceId, Phase>;
  floorMat: Record<SpaceId, 'flag' | 'board'>;
  /** The moat tunnel's line: distances along it to the island edge and the moat's far edge. */
  unplaced: string[];                     // doors the planner wanted but could not fit (should be empty)
  sallyPort: { islandEdge: number; moatEdge: number; start: V2; dir: V2; len: number; floor: number; room: SpaceId } | null;
}

// ---------------------------------------------------------------- helpers

const rngOf = (name: string, seed: number): Rng => mulberry32(hashSeed(name, seed));
const towerAt = (k: string) => TOWERS.find((t) => t.at === k);
const dirOf = (a: number): V2 => [Math.cos(a), Math.sin(a)];
const angOf = (v: V2) => Math.atan2(v[1], v[0]);
const angDist = (a: number, b: number) => { const d = Math.abs(((a - b) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI); return d; };

/** Keep the part of a convex polygon outside a disc, with the single tangent cut that keeps most area. */
function avoidDisc(poly: V2[], c: V2, r: number, accept?: (h: Half, res: V2[]) => boolean): { poly: V2[]; theta: number | null } {
  if (!poly.some((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) < r) && !segmentsNear(poly, c, r)) return { poly, theta: null };
  let best: V2[] = [], bestA = -1, bestT: number | null = null;
  for (let i = 0; i < 180; i++) {
    const th = (i / 180) * Math.PI * 2, n = dirOf(th);
    const h: Half = { n, c: dot(n, c) + r };
    const res = clip(poly, h);
    const a = area(res);
    if (a > bestA && (!accept || accept(h, res))) { bestA = a; best = res; bestT = th; }
  }
  return { poly: best, theta: bestT };
}
function segmentsNear(poly: V2[], c: V2, r: number) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], ab = sub(b, a);
    const t = Math.max(0, Math.min(1, dot(sub(c, a), ab) / dot(ab, ab)));
    if (Math.hypot(a[0] + ab[0] * t - c[0], a[1] + ab[1] * t - c[1]) < r) return true;
  }
  return false;
}
/** Keep the part of a convex polygon outside a convex obstacle (expanded by m), best single face. */
function avoidPoly(poly: V2[], ob: V2[], m: number): V2[] {
  const o = orient(ob);
  if (!convexOverlap(poly, offsetConvex(o, m), 0)) return poly;
  let best: V2[] = [], bestA = -1;
  for (let i = 0; i < o.length; i++) {
    const a = o[i], b = o[(i + 1) % o.length], out = scale(leftN(a, b), -1);
    const res = clip(poly, { n: out, c: dot(out, a) + m });
    const ar = area(res);
    if (ar > bestA) { bestA = ar; best = res; }
  }
  return best;
}
function offsetConvex(p: V2[], m: number): V2[] {
  const o = orient(p), n = o.length;
  const lines = o.map((a, i) => { const b = o[(i + 1) % n], out = scale(leftN(a, b), -1); return { p: add(a, scale(out, m)), d: sub(b, a) }; });
  return o.map((_, i) => {
    const L0 = lines[(i + n - 1) % n], L1 = lines[i];
    const rxs = L0.d[0] * L1.d[1] - L0.d[1] * L1.d[0];
    if (Math.abs(rxs) < 1e-9) return L1.p;
    const t = ((L1.p[0] - L0.p[0]) * L1.d[1] - (L1.p[1] - L0.p[1]) * L1.d[0]) / rxs;
    return [L0.p[0] + L0.d[0] * t, L0.p[1] + L0.d[1] * t] as V2;
  });
}

/** Facing edges of two rooms: parallel, opposite normals, `gap` apart; overlap interval along A's edge. */
export interface Facing { a: V2; dir: V2; n: V2; gap: number; t0: number; t1: number; gapAt: (t: number) => number }
export function facings(A: V2[], B: V2[], maxGap = 4.2, tolDeg = 15): Facing[] {
  const out: Facing[] = [];
  const cosTol = Math.cos((tolDeg * Math.PI) / 180);
  const pa = orient(A), pb = orient(B);
  for (let i = 0; i < pa.length; i++) {
    const a0 = pa[i], a1 = pa[(i + 1) % pa.length], la = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
    if (la < 0.5) continue;
    const dir = norm(sub(a1, a0)), inA = leftN(a0, a1), n = scale(inA, -1); // n: out of A
    for (let j = 0; j < pb.length; j++) {
      const b0 = pb[j], b1 = pb[(j + 1) % pb.length];
      if (Math.hypot(b1[0] - b0[0], b1[1] - b0[1]) < 0.5) continue;
      const inB = leftN(b0, b1);
      if (dot(inB, n) < cosTol) continue; // B's inward normal must point along n (away from A)
      const eB = sub(b1, b0), den = n[0] * eB[1] - n[1] * eB[0];
      const gapAt = (t: number) => { const P = add(a0, scale(dir, t)), w = sub(b0, P); return (w[0] * eB[1] - w[1] * eB[0]) / den; };
      const tb0 = dot(sub(b0, a0), dir), tb1 = dot(sub(b1, a0), dir);
      const t0 = Math.max(0, Math.min(tb0, tb1)), t1 = Math.min(la, Math.max(tb0, tb1));
      if (t1 - t0 < 0.5) continue;
      const gap = gapAt((t0 + t1) / 2);
      if (gap < 0.15 || gap > maxGap || gapAt(t0) < 0.1 || gapAt(t1) < 0.1) continue;
      out.push({ a: a0, dir, n, gap, t0, t1, gapAt });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the plan

interface WingCtx { w: WingQuad; phase: Phase; o: V2; u: V2; v: V2; tOut: number; dIn: number; band: V2[]; theta: Record<string, number> }
const sOf = (W: WingCtx, p: V2) => dot(sub(p, W.o), W.u);
const dOf = (W: WingCtx, p: V2) => dot(sub(p, W.o), W.v);
const halfS = (W: WingCtx, s: number, keepAbove: boolean): Half => keepAbove ? { n: W.u, c: dot(W.u, W.o) + s } : { n: scale(W.u, -1), c: -(dot(W.u, W.o) + s) };
const halfD = (W: WingCtx, d: number, keepAbove: boolean): Half => keepAbove ? { n: W.v, c: dot(W.v, W.o) + d } : { n: scale(W.v, -1), c: -(dot(W.v, W.o) + d) };
const sRange = (W: WingCtx, p: V2[]) => { const s = p.map((q) => sOf(W, q)); return [Math.min(...s), Math.max(...s)]; };

export function towerFloorsY(top: number): number[] {
  const ys: number[] = [];
  for (let f = 0; f < 7; f++) ys.push(floorBase(f));
  let y = floorBase(7); while (y < top - 4.5) { ys.push(y); y += 4.4; }
  return ys;
}

export function planInterior(seed = WORLD_SEED): PlanX {
  const rooms: RoomSpec[] = [], doors: DoorSpec[] = [], stairs: StairSpec[] = [], tunnels: TunnelSpec[] = [];
  const round: PlanX['round'] = {}, vault: PlanX['vault'] = {}, rise: PlanX['rise'] = {}, phase: PlanX['phase'] = {}, floorMat: PlanX['floorMat'] = {};
  const byId = new Map<SpaceId, RoomSpec>();
  let stairTowerTunnel: V2 = [1, 0];
  let crossing: V2 = [0, 0];
  let stairSpec!: StairSpec;
  let sallyPort: PlanX['sallyPort'] = null;
  const unplaced: string[] = [];
  const addRoom = (r: RoomSpec, ph: Phase, mat: 'flag' | 'board' = r.floor <= 0 ? 'flag' : 'board') => {
    r.poly = orient(r.poly); rooms.push(r); byId.set(r.id, r); phase[r.id] = ph; floorMat[r.id] = mat; return r;
  };
  const rDoor = rngOf('interior-doors', seed);

  /** Door between two rooms through facing walls; `pref` = preferred centre (projected onto the wall). */
  const connect = (id: string, A: SpaceId, B: SpaceId, o: { w?: number; h?: number; pref?: V2; leaf?: boolean; kind?: DoorSpec['kind']; head?: Head; avoid?: (c: V2) => boolean; jitter?: number; margin?: number } = {}): DoorSpec | null => {
    const ra = byId.get(A)!, rb = byId.get(B)!;
    const ph = phase[A] === 'old' || phase[B] === 'old' ? (phase[A] === phase[B] ? phase[A] : 'old') : 'new';
    const w = o.w ?? 1.15 + rDoor() * 0.2, h = o.h ?? 2.15 + rDoor() * 0.15;
    const head: Head = o.head ?? (ph === 'old' ? 'round' : (B === 'courtyard' || A === 'courtyard' ? 'pointed' : 'segmental'));
    const fs = facings(ra.poly, rb.poly).sort((x, y) => x.gap - y.gap);
    for (const f of fs) {
      const m = (o.margin ?? 0.25) + w / 2, lo = f.t0 + m, hi = f.t1 - m;
      if (hi < lo) continue;
      let t = o.pref ? dot(sub(o.pref, f.a), f.dir) : lo + (hi - lo) * (0.5 + (rDoor() - 0.5) * (o.jitter ?? 0.6));
      t = Math.max(lo, Math.min(hi, t));
      const gp = f.gapAt(t), c2 = add(add(f.a, scale(f.dir, t)), scale(f.n, gp / 2));
      if (o.avoid && o.avoid(c2)) continue;
      const d = mkDoor(id, [A, B], c2, Math.max(ra.y0, rb.y0), f.n, w, h, gp, head, o.leaf ?? true, o.kind ?? 'plank');
      doors.push(d); return d;
    }
    unplaced.push(id);
    return null;
  };
  const mkDoor = (id: string, spaces: [SpaceId, SpaceId], c: V2, y: number, n: V2, width: number, height: number, wall: number, head: Head, leaf: boolean, kind: DoorSpec['kind']): DoorSpec => {
    const hinge = rDoor() < 0.5 ? 'left' : 'right';
    return {
      id, spaces, centre: [c[0], y, c[1]], along: [-n[1], n[0]], normal: n, width, height, wall, head, leaf, hinge,
      swingInto: spaces[1] === 'courtyard' || spaces[1] === 'outside' ? 0 : 1,
      rebate: kind === 'gate' ? 1.5 : kind === 'grille' ? 0.2 : 0.15, kind,
    };
  };
  const exteriorDoor = (id: string, inner: SpaceId, outer: SpaceId, c: V2, y: number, nOut: V2, w: number, h: number, wall: number, head: Head, leaf = true, kind: DoorSpec['kind'] = 'plank') => {
    const d = mkDoor(id, [outer, inner], c, y, scale(nOut, -1), w, h, wall, head, leaf, kind);
    doors.push(d); return d;
  };

  // ------------------------------------------------ wings: bands, tower cuts, splits
  const wings: Record<string, WingCtx> = {};
  const shaftC = stairTowerCentre(), shaftR = 2.0;
  const wingTheta: Record<string, Record<string, number>> = {};
  for (const w of wingQuads()) {
    const ph = w.phase, tOut = T_OUT[ph], dIn = w.depth - T_COURT;
    const [a, b, ib, ia] = w.quad;
    const W: WingCtx = { w, phase: ph, o: a, u: w.dir, v: leftN(a, b), tOut, dIn, band: [], theta: {} };
    let band = clipAll(orient([a, b, ib, ia]), [halfD(W, tOut, true), halfD(W, dIn, false),
      { n: leftN(b, ib), c: dot(leftN(b, ib), b) + DIAG_INSET }, { n: leftN(ia, a), c: dot(leftN(ia, a), ia) + DIAG_INSET }]);
    for (const k of [w.a, w.b]) {
      const t = towerAt(k)!; if (!t) continue;
      if (t.kind === 'square') band = avoidPoly(band, squareTowerPoly(t), TOWER_MARGIN);
      else {
        const c = towerCentre(t), R = t.r + TOWER_MARGIN;
        const res = avoidDisc(band, c, R, (h) => {
          const tp = add(c, scale(h.n, R)), d = dOf(W, tp);
          return d > tOut + 1.0 && d < dIn - 1.0;
        });
        band = res.poly; if (res.theta !== null) W.theta[t.id] = res.theta;
      }
    }
    W.band = band; wings[w.id] = W; wingTheta[w.id] = W.theta;
  }

  /** Split a convex band into rooms by cross walls; weights give relative areas. */
  const splitBand = (W: WingCtx, band: V2[], weights: number[], gaps: [number, number][] = [], keepOut: number[] = []): V2[][] => {
    const [s0, s1] = sRange(W, band);
    const segs: [number, number][] = [];
    let cur = s0;
    for (const g of [...gaps].sort((x, y) => x[0] - y[0])) { segs.push([cur, g[0]]); cur = g[1]; }
    segs.push([cur, s1]);
    const per = gaps.length ? weights.length / segs.length : weights.length;
    const out: V2[][] = [];
    let wi = 0;
    segs.forEach(([lo, hi], si) => {
      const n = gaps.length ? (si === segs.length - 1 ? weights.length - wi : Math.round(per)) : weights.length;
      const ws = weights.slice(wi, wi + n); wi += n;
      const piece = clipAll(band, [halfS(W, lo, true), halfS(W, hi, false)]);
      const total = area(piece), sum = ws.reduce((x, y) => x + y, 0);
      const cuts: number[] = [];
      let acc = 0;
      for (let k = 0; k < n - 1; k++) {
        acc += ws[k] / sum;
        let a = lo, b = hi;
        for (let it = 0; it < 40; it++) { const m = (a + b) / 2; if (area(clip(piece, halfS(W, m, false))) < acc * total) a = m; else b = m; }
        let cut = (a + b) / 2;
        // no cross wall in front of a door that must open onto this wing (stair tower, turret)
        for (const k of keepOut) if (Math.abs(cut - k) < 1.5) cut = k + (cut < k ? -1.5 : 1.5);
        cuts.push(cut);
      }
      const P = PART[W.phase] / 2;
      const bounds = [lo - P, ...cuts, hi + P];
      for (let k = 0; k < n; k++) out.push(clipAll(piece, [halfS(W, bounds[k] + P, true), halfS(W, bounds[k + 1] - P, false)]));
    });
    return out;
  };

  const shaftHalf = (poly: V2[]) => avoidDisc(poly, shaftC, shaftR + 0.6).poly;
  const g = gatehouseFrame(), S = wings.S, sGate = sOf(S, g.base);
  const passHalf = 2.1;
  // cellar stair strip along the N courtyard wall, spanning two undercroft rooms
  const N = wings.N;
  const wingRooms: Record<string, Record<number, SpaceId[]>> = {};
  const keepOut: Record<string, number[]> = { N: [sOf(N, shaftC)], E: [sOf(wings.E, shaftC), sOf(wings.E, eastTurretFrame().base)], S: [], W: [] };

  for (const W of Object.values(wings)) {
    const id = W.w.id, n = W.w.rooms;
    wingRooms[id] = {};
    const r = rngOf(`interior-split-${id}`, seed);
    const wts = (boost = -1) => Array.from({ length: n }, (_, k) => (0.8 + r() * 0.4) * (k === boost ? 2.6 : 1));
    const w0 = wts(), w1 = wts(id === 'N' ? 2 : -1), wUp = wts();
    for (let f = 0; f < FLOOR_HEIGHTS.length; f++) {
      const gaps: [number, number][] = id === 'S' && f === 0 ? [[sGate - passHalf - PART.new, sGate + passHalf + PART.new]] : [];
      const polys = splitBand(W, W.band, f === 0 ? w0 : f === 1 ? w1 : wUp, gaps, keepOut[id]);
      const y0 = floorBase(f), y1 = Math.min(floorBase(f + 1) - SLAB, f === 6 ? W.w.top - 0.65 : Infinity);
      const ids: SpaceId[] = [];
      polys.forEach((p, k) => {
        let poly = shaftHalf(p);
        const kind: RoomKind = f === 0 ? 'undercroft' : f === 1 && id === 'N' && k === 2 ? 'hall' : 'chamber';
        const rid = `${id}${f}-${k}`;
        addRoom({ id: rid, zone: id, floor: f, kind, poly, y0, y1 }, W.phase);
        ids.push(rid);
      });
      wingRooms[id][f] = ids;
    }
  }

  // cellar stair: courtyard-side strip of N2+N3 on the ground floor
  const stripW = 1.25, stripPart = 0.5;
  const n2 = byId.get('N0-2')!, n3 = byId.get('N0-3')!;
  const [sa] = sRange(N, n2.poly), [, sb] = sRange(N, n3.poly);
  const stripPoly = clipAll(N.band, [halfS(N, sa, true), halfS(N, sb, false), halfD(N, N.dIn - stripW, true)]);
  for (const rr of [n2, n3]) rr.poly = orient(clip(rr.poly, halfD(N, N.dIn - stripW - stripPart, false)));
  addRoom({ id: 'N-cellarstair', zone: 'N', floor: -1, kind: 'stair', poly: stripPoly, y0: CELLAR_Y, y1: GROUND + 2.5 }, 'old', 'flag');

  // enfilade doors on each wing floor
  for (const W of Object.values(wings)) for (let f = 0; f < 7; f++) {
    const ids = wingRooms[W.w.id][f];
    for (let k = 0; k < ids.length - 1; k++) {
      // prefer the courtyard third so the outer wall keeps its windows clear
      const A = byId.get(ids[k])!;
      const cA = centroidOf(A.poly), pref = add(add(W.o, scale(W.u, sOf(W, cA))), scale(W.v, W.tOut + (W.dIn - W.tOut) * (0.62 + rDoor() * 0.2)));
      if (W.w.id === 'S' && k === 1 && f === 0) continue; // the gate passage lies between these two
      connect(`${ids[k]}>${ids[k + 1]}`, ids[k], ids[k + 1], { pref });
    }
  }

  // ------------------------------------------------ gate passage
  const sP = S;
  const gate0: V2[] = [local(sP.o, sP.u, sP.v, sGate - 2.3, -(GATEHOUSE.project - GATE.wall)), local(sP.o, sP.u, sP.v, sGate + 2.3, -(GATEHOUSE.project - GATE.wall)), local(sP.o, sP.u, sP.v, sGate + 2.3, 0), local(sP.o, sP.u, sP.v, sGate - 2.3, 0)];
  const gate1: V2[] = [local(sP.o, sP.u, sP.v, sGate - passHalf, sP.tOut), local(sP.o, sP.u, sP.v, sGate + passHalf, sP.tOut), local(sP.o, sP.u, sP.v, sGate + passHalf, sP.dIn), local(sP.o, sP.u, sP.v, sGate - passHalf, sP.dIn)];
  addRoom({ id: 'gate-0', zone: 'gate', floor: 0, kind: 'gate', poly: gate0, y0: GATE.sill, y1: GATE.sill + 6.0 }, 'new', 'flag');
  addRoom({ id: 'gate-1', zone: 'gate', floor: 0, kind: 'gate', poly: gate1, y0: GATE.sill, y1: floorBase(1) - SLAB }, 'new', 'flag');
  vault['gate-0'] = { axis: sP.v, spring: GATE.sill + 3.9, ribs: true, murder: true };
  vault['gate-1'] = { axis: sP.v, spring: GATE.sill + 3.0, ribs: true, murder: true };
  {
    const gc = add(g.base, scale(g.out, GATEHOUSE.project - GATE.wall / 2));
    // no leaves: the portcullis (portcullis.ts) closes the gate; head pointed, 0.42 × 3.8 = 1.6 m rise like the exterior arch
    const d = exteriorDoor('gate-main', 'gate-0', 'outside', gc, GATE.sill, g.out, GATE.width, GATE.spring, GATE.wall, 'pointed', false, 'gate');
    d.swingInto = 1;
    const inner = mkDoor('gate-inner', ['gate-0', 'gate-1'], add(g.base, scale(sP.v, sP.tOut / 2)), GATE.sill, sP.v, 3.4, 2.8, sP.tOut, 'pointed', false, 'plank');
    doors.push(inner); rise['gate-inner'] = 1.4;
    const court = mkDoor('gate-court', ['gate-1', 'courtyard'], local(sP.o, sP.u, sP.v, sGate, sP.dIn + T_COURT / 2), GATE.sill, sP.v, 3.4, 2.8, T_COURT, 'pointed', false, 'plank');
    doors.push(court); rise['gate-court'] = 1.4;
    // guard rooms either side of the inner passage
    for (const k of wingRooms.S[0]) {
      const rr = byId.get(k)!;
      if (facings(gate1, rr.poly).length || facings(rr.poly, gate1).length) {
        const left = facings(gate1, rr.poly).length > 0;
        connect(left ? `gate-1>${k}` : `${k}>gate-1`, left ? 'gate-1' : k, left ? k : 'gate-1', { pref: local(sP.o, sP.u, sP.v, sGate, sP.tOut + 1.6), w: 1.05 });
      }
    }
  }

  // ------------------------------------------------ courtyard doors into N, E, W (ground floor)
  // Placed by the windows' rule (openings.ts): the opening and its rebate on the courtyard face, CLEAR from
  // the face's ends and from any other building in front of it (the stair tower stands against N and E).
  const others = masses();
  for (const id of ['N', 'E', 'W']) {
    const W = wings[id], ids = wingRooms[id][0];
    const pickK = id === 'N' ? ids.length - 2 : Math.floor(ids.length / 2);
    const [, , ib, ia] = W.w.quad;
    const face: Face = { owner: W.w.id, a: ia, b: ib, out: W.v, bands: [] }, sFace = sOf(W, ia);
    const w = COURT_DOOR_W, dressing = { hw: w / 2 + COURT_DOOR_LIP, below: 0, above: 3 };
    // the planned room first, then its neighbours outward
    const order = ids.map((_, k) => k).sort((a, b) => Math.abs(a - pickK) - Math.abs(b - pickK) || b - a);
    const r = rDoor();
    let placed = false;
    for (const k of order) {
      const rr = byId.get(ids[k])!;
      // where the room meets the courtyard wall, less a margin either side for its cross walls
      const [s0, s1] = sRange(W, clip(rr.poly, halfD(W, W.dIn - 0.3, true))), m = w / 2 + 0.25;
      if (s1 - s0 < 2 * m) continue;
      const sm = (s0 + s1) / 2 + (r - 0.5) * Math.max(0, s1 - s0 - 3) * 0.5;
      // nearest spot to the planned one, in 5 cm steps, that keeps the rule
      const spots: number[] = [];
      for (let s = s0 + m; s <= s1 - m + 1e-9; s += 0.05) spots.push(s);
      const s = spots.sort((a, b) => Math.abs(a - sm) - Math.abs(b - sm)).find((q) => fits(face, others, [], boxOf(dressing, q - sFace, floorBase(0))));
      if (s === undefined) continue;
      const c = local(W.o, W.u, W.v, s, W.dIn + T_COURT / 2);
      exteriorDoor(`court>${rr.id}`, rr.id, 'courtyard', c, floorBase(0), W.v, w, 2.45, T_COURT, W.phase === 'old' ? 'round' : 'pointed');
      placed = true;
      break;
    }
    if (!placed) unplaced.push(`court>${id}`);
  }

  // ------------------------------------------------ corner towers
  const towerRooms: Record<string, SpaceId[]> = {};
  for (const t of TOWERS) {
    const ys = towerFloorsY(t.top), tw = TOWER_WALL[t.id], ph = t.phase;
    const rS = rngOf(`interior-tower-${t.id}`, seed);
    let base: V2[], stairC: V2, stairR: number, stairDoorDir: V2, clipH: Half, slitFacet: Half | null = null;
    const wingsHere = Object.values(wings).filter((W) => W.w.a === t.at || W.w.b === t.at);
    const facets: { n: V2; h: number }[] = [];
    if (t.kind === 'square') {
      const P = orient(squareTowerPoly(t));
      base = orient(offsetConvex(P, -tw));
      const cc = castleCentre();
      let oi = 0; P.forEach((p, i) => { if (Math.hypot(p[0] - cc[0], p[1] - cc[1]) > Math.hypot(P[oi][0] - cc[0], P[oi][1] - cc[1])) oi = i; });
      const O = P[oi], u1 = norm(sub(P[(oi + 1) % 4], O)), u2 = norm(sub(P[(oi + 3) % 4], O));
      stairR = SPIRAL_R;
      const cdist = stairR + 0.6;
      stairC = add(O, scale(add(u1, u2), cdist));
      const diag = norm(add(u1, u2));
      const Dch = Math.max(tw * Math.SQRT2 + 0.8, cdist * Math.SQRT2 + chordH(stairR) + 0.5);
      clipH = { n: diag, c: dot(diag, O) + Dch };
      stairDoorDir = diag;
    } else {
      const c = towerCentre(t), rin = t.r - tw;
      base = circlePoly(c, rin, 48);
      // door facets toward the wings
      for (const W of wingsHere) {
        const th = W.theta[t.id]; if (th === undefined) continue;
        const n = dirOf(th), hw = 0.9;
        facets.push({ n, h: Math.sqrt(rin * rin - hw * hw) * 0.995 });
      }
      round[`${t.id}`] = { c, r: rin };
      // shaft in the wall thickness, in the widest gap between doors, away from the outward windows
      stairR = SPIRAL_R;
      const out = angOf(sub(c, castleCentre()));
      // keep clear of every wing the tower joins (door facets, or the wing's direction)
      const toWings = wingsHere.map((W) => angOf(sub(centroidOf(W.band), c)));
      let bestA = 0, bestS = -1;
      for (let i = 0; i < 180; i++) {
        const a = (i / 180) * Math.PI * 2;
        let s = Math.min(...facets.map((f) => angDist(a, angOf(f.n))), ...toWings.map((w) => angDist(a, w)));
        s = Math.min(s, angDist(a, out) + 0.25);
        s += rS() * 0.02;
        if (s > bestS) { bestS = s; bestA = a; }
      }
      const cr = t.r - 0.55 - stairR;
      stairC = add(c, scale(dirOf(bestA), cr));
      clipH = { n: scale(dirOf(bestA), -1), c: -(dot(dirOf(bestA), c) + cr - stairR - 0.4) };
      stairDoorDir = scale(dirOf(bestA), -1);
      // the flat strip of the shaft's wall its light slits open from (openings.ts STAIR_SLIT, stairSlits)
      slitFacet = { n: stairDoorDir, c: -(dot(dirOf(bestA), stairC) + Math.sqrt(stairR * stairR - STAIR_SLIT.facet * STAIR_SLIT.facet)) };
    }
    const ids: SpaceId[] = [];
    const levels: { y: number; y1: number; f: number; id: SpaceId }[] = [{ y: CELLAR_Y, y1: CELLAR_TOP, f: -1, id: `${t.id}-c` }];
    ys.forEach((y, f) => {
      const next = ys[f + 1] ?? t.top - 0.3;
      levels.push({ y, y1: f + 1 < ys.length ? next - SLAB : next - 0.45, f, id: `${t.id}-${f}` });
    });
    const withCellar = t.id === 'great';
    for (const L of levels) {
      if (L.f < 0 && !withCellar) continue;
      let poly = clip(base, clipH);
      if (t.kind === 'round' && L.f >= 0 && L.f <= 6) for (const fc of facets) poly = clip(poly, { n: scale(fc.n, -1), c: -(dot(fc.n, round[t.id].c) + fc.h) });
      addRoom({ id: L.id, zone: t.id, floor: L.f, kind: 'tower', poly, y0: L.y, y1: L.y1 }, ph, L.f <= 0 ? 'flag' : 'board');
      if (t.kind === 'round') round[L.id] = round[t.id];
      if (L.f < 0) vault[L.id] = { axis: [1, 0], spring: CELLAR_TOP - 0.9, ribs: false }; // high springing: tunnels enter on all sides
      ids.push(L.id);
    }
    delete round[t.id];
    towerRooms[t.id] = ids;
    // spiral stair shaft
    const sid = `${t.id}-stair`;
    let shaftPoly = clip(circlePoly(stairC, stairR, 32), { n: scale(stairDoorDir, -1), c: -(dot(stairDoorDir, stairC) + chordH(stairR)) });
    if (slitFacet) shaftPoly = clip(shaftPoly, slitFacet);
    const yb = withCellar ? CELLAR_Y : ys[0], yt = ys[ys.length - 1];
    addRoom({ id: sid, zone: t.id, floor: -1, kind: 'stair', poly: shaftPoly, y0: yb, y1: yt + 2.6 }, ph, 'flag');
    round[sid] = { c: stairC, r: stairR };
    const turn: 1 | -1 = rS() < 0.5 ? 1 : -1;
    const st: StairSpec = { id: sid, kind: 'spiral', zone: t.id, spaces: [], centre: stairC, radius: stairR, newel: 0.18, turn, startAngle: spiralStartFor(angOf(stairDoorDir), stairR, turn, STAIR_DOOR_W), width: stairR - 0.18, landings: [] };
    for (const rid of ids) {
      const rr = byId.get(rid)!;
      const d = connect(`${sid}>${rid}`, sid, rid, { w: STAIR_DOOR_W, h: 2.05, pref: add(stairC, scale(stairDoorDir, stairR + 0.3)), head: ph === 'old' ? 'round' : 'pointed' });
      if (d) { st.spaces.push(rid); st.landings.push({ y: rr.y0, angle: angOf(stairDoorDir), at: [stairC[0] + stairDoorDir[0] * stairR * 0.6, rr.y0, stairC[1] + stairDoorDir[1] * stairR * 0.6], door: d.id }); }
    }
    stairs.push(st);
    // doors between tower rooms and the wing end rooms on floors 0..6
    for (let f = 0; f <= 6; f++) for (const W of wingsHere) {
      const tr = `${t.id}-${f}`, ids2 = wingRooms[W.w.id][f];
      const end = W.w.a === t.at ? ids2[0] : ids2[ids2.length - 1];
      const th = W.theta[t.id];
      const pref = th !== undefined ? add(towerCentre(t), scale(dirOf(th), (t as Extract<TowerSpec, { kind: 'round' }>).r)) : undefined;
      connect(`${tr}>${end}`, tr, end, { pref, w: 1.1, h: 2.15 });
    }
  }

  // ------------------------------------------------ courtyard stair tower (octagon)
  const stOct = (() => {
    const n = STAIR_TOWER.sides, R = STAIR_TOWER.r, c = shaftC;
    const a = ((3 + 0.5) / n) * Math.PI * 2 + 0.2;
    return { c, apothem: R * Math.cos(Math.PI / n), doorDir: dirOf(a), faceLen: 2 * R * Math.sin(Math.PI / n) };
  })();
  {
    const dirs: V2[] = [scale(wings.N.v, -1), scale(wings.E.v, -1), stOct.doorDir];
    // the crossing under the courtyard sits in front of the W cellar's courtyard wall
    const Wq = wings.W, wr = wingRooms.W[0];
    const sMid = (sRange(Wq, byId.get(wr[1])!.poly)[0] + sRange(Wq, byId.get(wr[2])!.poly)[1]) / 2;
    const pW = local(Wq.o, Wq.u, Wq.v, sMid, Wq.dIn);
    const tunnelDir = dirOf(angOf(stOct.doorDir) - 0.8);
    // where the line out of the stair tower meets the line square off the W cellar's courtyard wall
    const den = tunnelDir[0] * Wq.v[1] - tunnelDir[1] * Wq.v[0], dd = sub(pW, shaftC);
    const tt = (dd[0] * Wq.v[1] - dd[1] * Wq.v[0]) / den;
    crossing = Math.abs(den) > 0.2 && tt > 6 && tt < 30 ? add(shaftC, scale(tunnelDir, tt)) : add(shaftC, scale(tunnelDir, 15.5));
    dirs.push(tunnelDir);
    let poly = circlePoly(shaftC, shaftR, 48);
    for (const d of dirs) poly = clip(poly, { n: scale(d, -1), c: -(dot(d, shaftC) + shaftR * Math.cos(Math.asin(0.8 / shaftR))) });
    addRoom({ id: 'stairtower', zone: 'stairtower', floor: -1, kind: 'stair', poly, y0: CELLAR_Y, y1: floorBase(6) + 3.0 }, 'new', 'flag');
    round['stairtower'] = { c: shaftC, r: shaftR };
    const st: StairSpec = { id: 'stairtower', kind: 'spiral', zone: 'stairtower', spaces: [], centre: shaftC, radius: shaftR, newel: 0.25, turn: 1, startAngle: spiralStartFor(angOf(tunnelDir), shaftR, 1, STAIR_DOOR_W), width: shaftR - 0.25, landings: [] };
    const land = (d: DoorSpec | null, room: SpaceId, y: number, dir: V2) => { if (!d) return; st.spaces.push(room); st.landings.push({ y, angle: angOf(dir), at: [shaftC[0] + dir[0] * shaftR * 0.55, y, shaftC[1] + dir[1] * shaftR * 0.55], door: d.id }); };
    // courtyard door (the octagon's face 3, as castle.ts cuts it)
    const h = shaftR * Math.cos(Math.asin(0.8 / shaftR));
    const wall = stOct.apothem - h;
    const cd = exteriorDoor('court>stairtower', 'stairtower', 'courtyard', add(shaftC, scale(stOct.doorDir, h + wall / 2)), GROUND, stOct.doorDir, STAIR_DOOR_W, 2.0, wall, 'pointed');
    // one landing per floor (a spiral lands one door at a time): the courtyard door on the ground
    // floor, then the N wing, or the E wing where the N wing has no room against the tower
    land(cd, 'courtyard', GROUND, stOct.doorDir);
    for (let f = 1; f <= 6; f++) for (const id of ['N', 'E']) {
      const W = wings[id], dir = scale(W.v, -1);
      const target = wingRooms[id][f].find((k) => facings(byId.get('stairtower')!.poly, byId.get(k)!.poly).some((fc) => dot(fc.n, dir) > 0.97));
      if (!target) continue;
      const d = connect(`stairtower>${target}`, 'stairtower', target, { w: STAIR_DOOR_W, h: 2.05, pref: add(shaftC, scale(dir, 2.5)), head: 'pointed' });
      if (d) { land(d, target, floorBase(f), dir); break; }
    }
    stairs.push(st);
    stairTowerTunnel = tunnelDir;
    stairSpec = st;
  }

  // ------------------------------------------------ gatehouse rooms over the gate, east turret
  {
    const hw = GATEHOUSE.width / 2, tw = 1.5;
    const P = GATEHOUSE.project;
    for (let f = 2; f <= 6; f++) {
      const poly: V2[] = [local(sP.o, sP.u, sP.v, sGate - hw + tw, -(P - 1.6)), local(sP.o, sP.u, sP.v, sGate + hw - tw, -(P - 1.6)), local(sP.o, sP.u, sP.v, sGate + hw - tw, -0.35), local(sP.o, sP.u, sP.v, sGate - hw + tw, -0.35)];
      const y1 = f === 6 ? GATEHOUSE.top - 0.75 : floorBase(f + 1) - SLAB;
      addRoom({ id: `gate${f}`, zone: 'gate', floor: f, kind: 'chamber', poly, y0: floorBase(f), y1 }, 'new');
      // the S room with the longest stretch of wall facing the gatehouse room
      const span = (k: SpaceId) => Math.max(0, ...facings(byId.get(`gate${f}`)!.poly, byId.get(k)!.poly).map((fc) => fc.t1 - fc.t0));
      const s = [...wingRooms.S[f]].sort((a, b) => span(b) - span(a)).find((k) => span(k) > 0);
      if (s) connect(`gate${f}>${s}`, `gate${f}`, s, { pref: g.base });
    }
    const e = eastTurretFrame(), E = wings.E, sT = sOf(E, e.base), ehw = EAST_TURRET.w / 2 - 0.75;
    for (let f = 1; f <= 6; f++) {
      const poly: V2[] = [local(E.o, E.u, E.v, sT - ehw, -(EAST_TURRET.project - 0.75)), local(E.o, E.u, E.v, sT + ehw, -(EAST_TURRET.project - 0.75)), local(E.o, E.u, E.v, sT + ehw, -0.35), local(E.o, E.u, E.v, sT - ehw, -0.35)];
      const y1 = f === 6 ? EAST_TURRET.top - 4.0 : floorBase(f + 1) - SLAB;
      addRoom({ id: `eturret${f}`, zone: 'eturret', floor: f, kind: f === 3 ? 'chapel' : 'chamber', poly, y0: floorBase(f), y1 }, 'new');
      const s = wingRooms.E[f].find((k) => facings(byId.get(`eturret${f}`)!.poly, byId.get(k)!.poly).length);
      if (s) connect(`eturret${f}>${s}`, `eturret${f}`, s, { pref: e.base, w: 0.95, h: 2.05 });
    }
  }

  // ------------------------------------------------ cellars and tunnels
  const cellar = (W: WingCtx, id: string, sLo: number, sHi: number, extra: Half[] = []) => {
    const poly = clipAll(W.band, [halfS(W, sLo, true), halfS(W, sHi, false), ...extra]);
    addRoom({ id, zone: W.w.id, floor: -1, kind: 'undercroft', poly: shaftHalf(poly), y0: CELLAR_Y, y1: CELLAR_TOP }, W.phase, 'flag');
    vault[id] = { axis: W.u, spring: CELLAR_TOP - 1.3, ribs: false };
    return id;
  };
  const sr = (id: string, W: WingCtx) => sRange(W, byId.get(id)!.poly);
  const PN = PART.old / 2;
  const nIds = wingRooms.N[0], wIds = wingRooms.W[0];
  const nc0 = cellar(N, 'N-c0', sr(nIds[1], N)[0], sr(nIds[1], N)[1]);
  const nc1 = cellar(N, 'N-c1', sa, sb, [halfD(N, N.dIn - stripW - stripPart, false)]);
  const nc2 = cellar(N, 'N-c2', sr(nIds[4], N)[0], sr(nIds[5], N)[1]);
  void PN;
  connect(`${nc0}>${nc1}`, nc0, nc1, { head: 'round' });
  connect(`${nc1}>${nc2}`, nc1, nc2, { head: 'round' });
  const W_ = wings.W;
  const wc0 = cellar(W_, 'W-c0', sr(wIds[1], W_)[0], sr(wIds[2], W_)[1]);
  const wc1 = cellar(W_, 'W-c1', sr(wIds[3], W_)[0], sr(wIds[3], W_)[1]);
  connect(`${wc0}>${wc1}`, wc0, wc1, { head: 'round' });
  // cellar stair (straight, along the N courtyard wall): top at the s-end of N3, bottom at N2's end
  {
    const lo = sa + 0.6, hi = sb - 0.6; // landing centres
    const dMid = N.dIn - stripW / 2;
    const top = connect('N0-3>N-cellarstair', 'N0-3', 'N-cellarstair', { pref: local(N.o, N.u, N.v, hi - 0.1, dMid), w: 0.95, h: 2.05, head: 'round' });
    const bot = connect('N-cellarstair>N-c1', 'N-cellarstair', nc1, { pref: local(N.o, N.u, N.v, lo + 0.1, dMid), w: 0.95, h: 2.05, head: 'round' });
    if (top) top.centre[1] = floorBase(0);
    if (bot) bot.centre[1] = CELLAR_Y;
    const run = (GROUND - CELLAR_Y) / 0.2 * 0.26;
    const sTop = hi - 0.7, sBot = sTop - run;
    const p0 = local(N.o, N.u, N.v, sBot, dMid), p1 = local(N.o, N.u, N.v, sTop, dMid);
    stairs.push({
      id: 'N-cellarstair', kind: 'straight', zone: 'N', spaces: [nc1, 'N0-3'], start: [p0[0], CELLAR_Y, p0[1]], end: [p1[0], GROUND, p1[1]], width: stripW,
      landings: [{ y: CELLAR_Y, at: [...(local(N.o, N.u, N.v, lo, dMid))].splice(0, 1).concat([CELLAR_Y]).concat([local(N.o, N.u, N.v, lo, dMid)[1]]) as V3, door: bot?.id }, { y: GROUND, at: [local(N.o, N.u, N.v, hi, dMid)[0], GROUND, local(N.o, N.u, N.v, hi, dMid)[1]], door: top?.id }],
    });
  }

  let tn = 0;
  const tunnel = (from: V2, dir: V2, len: number, profile: (t: number) => number, opt: { portal?: boolean } = {}) => {
    const id = `tunnel-${++tn}`;
    const steps = Math.max(2, Math.ceil(len / 0.5));
    const path: V3[] = [];
    for (let i = 0; i <= steps; i++) { const t = (i / steps) * len, p = add(from, scale(dir, t)); path.push([p[0], profile(t), p[1]]); }
    // compress the path to its corners (where the slope changes)
    const keep: V3[] = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
      const a = keep[keep.length - 1], b = path[i], c = path[i + 1];
      const s0 = (b[1] - a[1]) / Math.hypot(b[0] - a[0], b[2] - a[2]), s1 = (c[1] - b[1]) / Math.hypot(c[0] - b[0], c[2] - b[2]);
      if (Math.abs(s0 - s1) > 1e-6) keep.push(b);
    }
    keep.push(path[path.length - 1]);
    const side: V2 = [-dir[1], dir[0]], hw = TUNNEL_W / 2;
    const poly = [add(from, scale(side, -hw)), add(from, scale(side, hw)), add(add(from, scale(dir, len)), scale(side, hw)), add(add(from, scale(dir, len)), scale(side, -hw))];
    const ys = keep.map((p) => p[1]);
    addRoom({ id, zone: 'tunnel', floor: -1, kind: 'passage', poly, y0: Math.min(...ys), y1: Math.max(...ys) + TUNNEL_CROWN }, 'old', 'flag');
    vault[id] = { axis: dir, spring: TUNNEL_CROWN - TUNNEL_W / 2, ribs: false };
    tunnels.push({ id, room: id, path: keep, width: TUNNEL_W, crown: TUNNEL_CROWN, portal: opt.portal });
    return id;
  };
  /** Straight tunnel between two rooms along `dir`, leaving `gapA`/`gapB` of wall at each end. */
  const linkTunnel = (A: SpaceId, B: SpaceId, startOnA: V2, dir: V2, gapA: number, gapB: number) => {
    const ra = byId.get(A)!, rb = byId.get(B)!;
    // distance from the start point along dir to B's boundary
    let tB = 1e9;
    const pb = orient(rb.poly);
    for (let i = 0; i < pb.length; i++) {
      const a = pb[i], b = pb[(i + 1) % pb.length], e = sub(b, a);
      const den = dir[0] * e[1] - dir[1] * e[0]; if (Math.abs(den) < 1e-9) continue;
      const w = sub(a, startOnA), t = (w[0] * e[1] - w[1] * e[0]) / den, u = (w[0] * dir[1] - w[1] * dir[0]) / den;
      if (u >= -1e-6 && u <= 1 + 1e-6 && t > 0) tB = Math.min(tB, t);
    }
    const from = add(startOnA, scale(dir, gapA)), len = tB - gapA - gapB;
    if (!(len > 0.8) || tB > 200) return null;
    const id = tunnel(from, dir, len, () => CELLAR_Y);
    connect(`${A}>${id}`, A, id, { w: 1.1, h: 2.0, head: 'round', pref: from, margin: 0.2 });
    connect(`${id}>${B}`, id, B, { w: 1.1, h: 2.0, head: 'round', pref: add(from, scale(dir, len)), margin: 0.2 });
    void ra; return id;
  };
  {
    const gt = TOWERS.find((t) => t.id === 'great')!, gP = orient(squareTowerPoly(gt as Extract<TowerSpec, { kind: 'square' }>));
    const gc = byId.get('great-c')!;
    // tunnel 1: great tower base → N cellar (east), tunnel 2: great tower base → W cellar (south)
    const nc0r = byId.get(nc0)!, wc1r = byId.get(wc1)!;
    const gcC = centroidOf(gc.poly);
    const fromN = facingsFrom(nc0r.poly, scale(N.u, -1), 1.6, gcC);
    if (fromN) linkTunnel(nc0, 'great-c', fromN, scale(N.u, -1), 0.7, 0.6);
    const fromW = facingsFrom(wc1r.poly, W_.u, 1.6, gcC);
    if (fromW) linkTunnel(wc1, 'great-c', fromW, W_.u, 0.7, 0.6);
    // tunnel 3 + crossing: stair tower base → under the courtyard → W cellar
    const jc = crossing;
    const jr = 1.8;
    addRoom({ id: 'tunnel-x', zone: 'tunnel', floor: -1, kind: 'passage', poly: circlePoly(jc, jr, 32), y0: CELLAR_Y, y1: CELLAR_Y + 3.4 }, 'old', 'flag');
    round['tunnel-x'] = { c: jc, r: jr };
    vault['tunnel-x'] = { axis: [1, 0], spring: CELLAR_Y + 2.4, ribs: true };
    // facets on the crossing for its two tunnels
    const toW = scale(W_.v, -1);
    const xr = byId.get('tunnel-x')!;
    for (const d of [scale(stairTowerTunnel, -1), toW]) xr.poly = orient(clip(xr.poly, { n: scale(d, -1), c: -(dot(d, jc) + jr * Math.cos(Math.asin(0.9 / jr))) }));
    const shaftEdge = add(shaftC, scale(stairTowerTunnel, shaftR * Math.cos(Math.asin(0.8 / shaftR))));
    const t3 = linkTunnel('stairtower', 'tunnel-x', shaftEdge, stairTowerTunnel, 0.5, 0.5);
    if (t3) { const d = doors.find((x) => x.id === `stairtower>${t3}`); if (d) { stairSpec.spaces.unshift(t3); stairSpec.landings.unshift({ y: CELLAR_Y, angle: angOf(stairTowerTunnel), door: d.id }); } }
    const xEdge = add(jc, scale(toW, jr * Math.cos(Math.asin(0.9 / jr))));
    // aim the west tunnel at the W cellar
    linkTunnel('tunnel-x', wc0, xEdge, toW, 0.5, 0.6);
    // tunnel 4: under the west moat from the great tower's west face to a sally port on the far bank
    let wi = 0, best = -1e9;
    for (let i = 0; i < 4; i++) { const a = gP[i], b = gP[(i + 1) % 4], out = scale(leftN(a, b), -1); if (-out[0] > best) { best = -out[0]; wi = i; } }
    const wa = gP[wi], wb = gP[(wi + 1) % 4], wOut = scale(leftN(wa, wb), -1);
    // door position: the middle of the west face, nudged away from the stair corner
    const gcPoly = orient(gc.poly);
    const inner = facingsFrom(gcPoly, wOut, 0.5)!;
    const start = add(inner, scale(wOut, TOWER_WALL.great + 0.35));
    const isl = islandOutline(), moat = moatOuter(isl);
    let tIsl = 0, tMoat = 0;
    for (let t = 0; t < 200; t += 0.25) { const p = add(start, scale(wOut, t)); if (!tIsl && !pointInPoly(isl, p[0], p[1])) tIsl = t; if (tIsl && !pointInPoly(moat, p[0], p[1])) { tMoat = t; break; } }
    const rise = 0.2 / 0.3;
    const dDown = 1.6, dDownEnd = dDown + (CELLAR_Y - MOAT_TUNNEL_Y) / rise;
    const upStart = tMoat + 1.5, portalY = 3.0, upEnd = upStart + (portalY - MOAT_TUNNEL_Y) / rise, len = upEnd + 2.6;
    const prof = (t: number) => t < dDown ? CELLAR_Y : t < dDownEnd ? CELLAR_Y - (t - dDown) * rise : t < upStart ? MOAT_TUNNEL_Y : t < upEnd ? MOAT_TUNNEL_Y + (t - upStart) * rise : portalY;
    const mt = tunnel(start, wOut, len, prof, { portal: true });
    connect(`great-c>${mt}`, 'great-c', mt, { w: 1.1, h: 2.0, head: 'round', pref: start });
    const endC = add(start, scale(wOut, len + 0.35));
    const grille = mkDoor('sallyport-grille', [mt, 'farbank'], endC, portalY, wOut, 1.1, 2.0, 0.7, 'round', true, 'grille');
    grille.swingInto = 0; grille.rebate = 0.2;
    doors.push(grille);
    sallyPort = { islandEdge: tIsl, moatEdge: tMoat, start, dir: wOut, len, floor: portalY, room: mt };
  }

  const plan: PlanX = { rooms, doors, stairs, seed, round, vault, tunnels, rise, phase, floorMat, sallyPort, unplaced };
  fitDoorHeads(plan);
  fitHinges(plan);
  return plan;
}

/** The plan's doors as the castle's walls see them: every wall a door passes through is cut with its outline. */
export function doorHoles(P: PlanX): DoorHole[] {
  return P.doors.map((d) => {
    const { clear, reb } = doorOutlines(d, P.rise[d.id]), leafy = d.leaf && d.kind !== 'gate';
    return { id: d.id, c: [d.centre[0], d.centre[2]], along: d.along, normal: d.normal, wall: d.wall, clear, reb, swing: leafy ? (d.swingInto === 1 ? 1 : -1) : 0, stop: stopPlane(d) };
  });
}

/** Whether a door's leaf, swung through its whole arc, stays in its doorway (with the rebate) or the room it swings into. */
export function leafSwingFits(P: Pick<InteriorPlan, 'rooms'>, d: DoorSpec): boolean {
  const [pl] = placeLeaves(d), r = P.rooms.find((x) => x.id === d.spaces[d.swingInto]);
  if (!pl || !r) return true;
  const { zBack } = leafDepth(pl.kind), sx = pl.mirrored ? -1 : 1;
  // a coarser sweep than the test's (the leaf's ends and middle; rooms are convex where doors meet them)
  for (let i = 0; i <= 12; i++) {
    const m = leafMatrix(pl, m4swing((pl.maxAngle * i) / 12));
    for (let k = 0; k <= 2; k++) for (const z of [zBack, 0]) {
      const p = m4apply(m, [(sx * pl.width * k) / 2, 1, z]);
      const dx = p[0] - d.centre[0], dz = p[2] - d.centre[2];
      const across = dx * d.along[0] + dz * d.along[1], through = dx * d.normal[0] + dz * d.normal[1];
      if (Math.abs(across) <= d.width / 2 + LIP && Math.abs(through) <= d.wall / 2 + 0.15) continue;
      if (!pointInPoly(r.poly, p[0], p[2])) return false;
    }
  }
  return true;
}

/** Does a point lie in a leaf's sweep: the sector its board passes through from shut to fully open? */
function inSweep(q: V3, L: LeafPlace): boolean {
  const dx = q[0] - L.pivot[0], dz = q[2] - L.pivot[2];
  const x = dx * L.eU[0] + dz * L.eU[1], z = dx * L.eV[0] + dz * L.eV[1], a = Math.atan2(z, x);
  return q[1] > L.pivot[1] - 0.05 && q[1] < L.pivot[1] + L.height + 0.05 && Math.hypot(x, z) < L.width + 0.05 && a > -0.15 && a < L.maxAngle + 0.15;
}
/** Do two leaves' sweeps cross (one leaf, somewhere in its swing, inside the other's)? */
function sweepsCross(a: LeafPlace, b: LeafPlace): boolean {
  if (Math.hypot(a.pivot[0] - b.pivot[0], a.pivot[2] - b.pivot[2]) > a.width + b.width + 0.2 || Math.abs(a.pivot[1] - b.pivot[1]) > Math.max(a.height, b.height)) return false;
  for (const [p, q] of [[a, b], [b, a]]) for (let i = 0; i <= 12; i++) for (let k = 1; k <= 4; k++) for (const y of [0.1, p.height / 2]) {
    if (inSweep(leafPoint(p, m4swing((p.maxAngle * i) / 12), [(p.width * k) / 4, y, 0]), q)) return true;
  }
  return false;
}

/**
 * Hang each leaf so that it opens: on its other jamb when it would swing into the room's side wall (a door
 * near a corner) or across another leaf's swing; failing both, swing it into the other room.
 */
export function fitHinges(P: Pick<InteriorPlan, 'rooms' | 'doors'>): void {
  const leaf = new Map(P.doors.map((d) => [d, placeLeaves(d)[0]]));
  const ok = (d: DoorSpec) => {
    const pl = leaf.get(d);
    return !pl || (leafSwingFits(P, d) && !P.doors.some((o) => o !== d && leaf.get(o) && sweepsCross(pl, leaf.get(o)!)));
  };
  for (const d of P.doors) {
    if (!leaf.get(d) || ok(d)) continue;
    const was = { hinge: d.hinge, swingInto: d.swingInto };
    const tries: Pick<DoorSpec, 'hinge' | 'swingInto'>[] = [{ hinge: d.hinge === 'left' ? 'right' : 'left', swingInto: d.swingInto }];
    if (P.rooms.some((r) => r.id === d.spaces[1 - d.swingInto])) for (const hinge of ['left', 'right'] as const) tries.push({ hinge, swingInto: d.swingInto === 1 ? 0 : 1 });
    let fixed = false;
    for (const t of tries) {
      Object.assign(d, t); leaf.set(d, placeLeaves(d)[0]);
      if (ok(d)) { fixed = true; break; }
    }
    if (!fixed) { Object.assign(d, was); leaf.set(d, placeLeaves(d)[0]); }
  }
}

/**
 * Ceiling height of a room as a function of plan position: flat rooms give y1, vaulted rooms the barrel
 * (round/segmental for old work and tunnels, two-centred pointed for new work) springing at `spring`.
 */
export function ceilingAt(P: Pick<PlanX, 'vault' | 'phase'>, r: RoomSpec): (q: V2) => number {
  const v = P.vault[r.id];
  if (!v) return () => r.y1;
  const side: V2 = [-v.axis[1], v.axis[0]];
  const bs = r.poly.map((q) => dot(q, side)), b0 = Math.min(...bs), b1 = Math.max(...bs), bc = (b0 + b1) / 2, half = (b1 - b0) / 2;
  const rise = Math.max(0.3, r.y1 - v.spring);
  const pointed = P.phase[r.id] === 'new' && r.zone !== 'tunnel';
  const R = pointed ? (half * half + rise * rise) / (2 * half) : (half * half + rise * rise) / (2 * rise);
  return (q: V2) => {
    const x = Math.min(half, Math.abs(dot(q, side) - bc));
    if (pointed) { const cx = half - R; return v.spring + Math.sqrt(Math.max(0, R * R - (x - cx) * (x - cx))); }
    return v.spring + Math.sqrt(Math.max(0, R * R - x * x)) - (R - rise);
  };
}

const roomIndexCache = new WeakMap<RoomSpec[], Map<SpaceId, RoomSpec>>();
/** Rooms by id (memoised per rooms array; rebuilt when the array grows). */
function roomIndex(rooms: RoomSpec[]): Map<SpaceId, RoomSpec> {
  let m = roomIndexCache.get(rooms);
  if (!m || m.size !== rooms.length) { m = new Map(rooms.map((r) => [r.id, r])); roomIndexCache.set(rooms, m); }
  return m;
}

/** Whether a door's outline (with `rise`) stays HEAD_CLEAR below the ceiling of both rooms at their faces. */
export function doorHeadFits(P: PlanX, d: DoorSpec, rise = P.rise[d.id] ?? headRise(d.head, d.width)): boolean {
  const c: V2 = [d.centre[0], d.centre[2]];
  const tops: ((u: number) => number)[] = [];
  d.spaces.forEach((sp, k) => {
    const r = roomIndex(P.rooms).get(sp); if (!r) return;
    // sample the face and a little into the room: skewed doors meet the room's face deeper on one side
    const f = ceilingAt(P, r);
    for (const extra of [0, 0.3, 0.6]) {
      const off = scale(d.normal, (k === 0 ? -1 : 1) * (d.wall / 2 + extra));
      tops.push((u: number) => f(add(add(c, off), scale(d.along, u))));
    }
  });
  return archOutline(0, d.centre[1], d.width, d.height, d.head, rise).every(([u, y]) => tops.every((t) => y <= t(u) - HEAD_CLEAR + 1e-9));
}

/**
 * Whether a door into a spiral stair, with its rebate (where the leaf's top goes), stays under the steps of the
 * turn above it: in the doorway and 0.6 m into the drum, every point of the outline below their soffits.
 */
export function doorUnderSteps(sp: SpiralPlan, d: DoorSpec, rise = headRise(d.head, d.width)): boolean {
  const T = Math.PI * 2, c: V2 = [d.centre[0], d.centre[2]], k = d.spaces.indexOf(sp.id) === 0 ? -1 : 1;
  const lip = d.leaf && d.kind !== 'gate' ? LIP : 0;
  for (const [u, y] of archOutline(0, d.centre[1], d.width + 2 * lip, d.height + lip, d.head, rise + lip)) for (let t = 0; t <= d.wall / 2 + 0.6; t += 0.1) {
    const p = add(add(c, scale(d.along, u)), scale(d.normal, k * t)), ex = p[0] - sp.c[0], ez = p[1] - sp.c[1], r = Math.hypot(ex, ez);
    if (r < sp.rn || r > sp.R) continue;
    const prog0 = (Math.atan2(ez, ex) - sp.theta0) * sp.dir;
    for (const st of sp.steps) {
      const prog = prog0 + Math.round((st.a0 - prog0) / T) * T;
      if (prog >= st.a0 && prog <= st.a1 && st.y > y && !st.solid && y > spiralNosingY(sp, prog) - sp.T - 0.02) return false;
    }
  }
  return true;
}

/** Options the shell builds a plan's stair with (and the validator checks it with). */
export function stairOpts(P: InteriorPlan, s: StairSpec): StairOpts {
  const r = P.rooms.find((x) => x.id === s.id);
  return { doorWidth: STAIR_DOOR_W, drumPoly: s.kind === 'spiral' ? r?.poly : undefined, ceiling: r ? r.y1 : undefined, mural: false };
}

/** The spiral stairs in the round towers' walls, as their light slits see them (openings.ts stairSlits). */
export function towerSpirals(P: InteriorPlan): SpiralBehind[] {
  return P.stairs.filter((s) => s.kind === 'spiral' && TOWERS.some((t) => t.kind === 'round' && s.id === `${t.id}-stair`)).map((s) => {
    const sp = planStair(s, stairOpts(P, s)) as SpiralPlan, r = P.rooms.find((x) => x.id === s.id)!;
    return { id: s.id, c: sp.c, R: sp.R, floor: sp.yFloor, ceiling: r.y1, doors: sp.landings.filter(Boolean).map((l) => ({ angle: l.angle, hw: STAIR_DOOR_W / 2 + LIP })), stonesAt: (th: number) => spiralStonesAt(sp, th) };
  });
}

/** Clearance kept between a door's head (incl. its rebate) and the ceiling or vault of either room. */
export const HEAD_CLEAR = 0.15;

/**
 * Lower door heads that would cut into a ceiling or vault: first the jamb height (down to 2.0 m),
 * then the head: a flatter head type for leaved doors, a lower rise (stored in `P.rise`) for open
 * arches. Doors still too tall are left for validatePlan to report.
 */
export function fitDoorHeads(P: PlanX): void {
  const flatter: Record<Head, Head | null> = { round: 'segmental', pointed: 'segmental', segmental: 'flat', flat: null };
  const spirals = P.stairs.filter((s) => s.kind === 'spiral').map((s) => planStair(s, stairOpts(P, s)) as SpiralPlan);
  for (const d of P.doors) {
    let rise = P.rise[d.id] ?? headRise(d.head, d.width);
    let changed = false;
    const stairs = spirals.filter((sp) => d.spaces.includes(sp.id));
    const fit = () => doorHeadFits(P, d, rise) && stairs.every((sp) => doorUnderSteps(sp, d, rise));
    for (let it = 0; it < 200 && !fit(); it++) {
      if (d.height > 2.0 + 1e-6) d.height = Math.max(2.0, d.height - 0.05);
      else if (d.leaf) {
        // leaves take their head shape from DoorSpec.head alone, so flatten the head type instead
        const next = flatter[d.head]; if (!next) break;
        d.head = next; rise = headRise(next, d.width); delete P.rise[d.id];
      } else if (rise > 0.1 + 1e-6) { rise = Math.max(0.1, rise - 0.05); changed = true; }
      else break;
    }
    if (changed) P.rise[d.id] = rise;
  }
}

/** A point on the edge of a convex room whose outward normal matches `out`, at the edge's middle. */
function facingsFrom(poly: V2[], out: V2, minLen = 1.6, toward?: V2): V2 | null {
  const p = orient(poly);
  let best: V2 | null = null, bestD = 0.9;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < minLen) continue;
    const o = scale(leftN(a, b), -1), d = dot(o, out);
    if (d > bestD) {
      bestD = d;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), e = norm(sub(b, a));
      const t = toward ? Math.max(1.1, Math.min(L - 1.1, dot(sub(toward, a), e))) : L / 2;
      best = add(a, scale(e, t));
    }
  }
  return best;
}

// ---------------------------------------------------------------- validation

export interface PlanReport { ok: boolean; errors: string[]; reachable: Set<SpaceId> }

/** Graph of spaces through doors (locked grilles excluded) and the checks from docs/BRIEF.md I.1. */
export function validatePlan(P: PlanX): PlanReport {
  const errors: string[] = [];
  const ids = new Set(P.rooms.map((r) => r.id));
  if (ids.size !== P.rooms.length) errors.push('duplicate room ids');
  const adj = new Map<SpaceId, SpaceId[]>();
  const link = (a: SpaceId, b: SpaceId) => { if (!adj.has(a)) adj.set(a, []); adj.get(a)!.push(b); };
  for (const d of P.doors) {
    for (const s of d.spaces) if (s !== 'outside' && s !== 'courtyard' && s !== 'farbank' && !ids.has(s)) errors.push(`door ${d.id} names unknown space ${s}`);
    if (d.width < 0.9 - 1e-6 || d.height < 2.0 - 1e-6) errors.push(`door ${d.id} too small ${d.width.toFixed(2)}×${d.height.toFixed(2)}`);
    if (!doorHeadFits(P, d)) errors.push(`door ${d.id} head cuts the ceiling`);
    if (d.leaf && P.rise[d.id] !== undefined) errors.push(`door ${d.id} has a leaf but a head rise override`);
    if (d.kind === 'grille') continue; // barred for good
    link(d.spaces[0], d.spaces[1]); link(d.spaces[1], d.spaces[0]);
  }
  link('outside', 'outside');
  const seen = new Set<SpaceId>(['outside']), q: SpaceId[] = ['outside'];
  while (q.length) { const s = q.shift()!; for (const t of adj.get(s) ?? []) if (!seen.has(t)) { seen.add(t); q.push(t); } }
  if (!seen.has('courtyard')) errors.push('courtyard not reachable from outside');
  for (const r of P.rooms) if (!seen.has(r.id)) errors.push(`room ${r.id} unreachable`);
  if (seen.has('farbank')) errors.push('the far bank is reachable');
  // nothing reachable leaves the island except the moat tunnel
  const isl = islandOutline();
  for (const r of P.rooms) {
    if (r.zone === 'tunnel') continue;
    for (const p of r.poly) if (!pointInPoly(isl, p[0], p[1])) errors.push(`room ${r.id} outside the island`);
  }
  const grilles = P.doors.filter((d) => d.kind === 'grille');
  if (grilles.length !== 1 || !grilles.every((d) => d.leaf && d.spaces.includes('farbank'))) errors.push('sally port must be one locked grille to the far bank');
  // rooms: convex, positive, inside the footprint, not overlapping in plan where their heights overlap
  const foot = outerFootprint();
  for (const r of P.rooms) {
    if (area(r.poly) < 1) errors.push(`room ${r.id} degenerate`);
    if (r.y1 - r.y0 < 2.0) errors.push(`room ${r.id} too low (${(r.y1 - r.y0).toFixed(2)})`);
    if (r.zone !== 'tunnel') for (const p of r.poly) if (!foot.some((f) => pointInPoly(f, p[0], p[1]))) { errors.push(`room ${r.id} leaves the footprint`); break; }
  }
  const box = P.rooms.map((r) => { const xs = r.poly.map((p) => p[0]), zs = r.poly.map((p) => p[1]); return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]; });
  for (let i = 0; i < P.rooms.length; i++) for (let j = i + 1; j < P.rooms.length; j++) {
    const a = P.rooms[i], b = P.rooms[j], A = box[i], Bb = box[j];
    if (a.y1 <= b.y0 + 0.05 || b.y1 <= a.y0 + 0.05) continue;
    if (A[1] < Bb[0] || Bb[1] < A[0] || A[3] < Bb[2] || Bb[3] < A[2]) continue;
    if (convexOverlap(a.poly, b.poly, 0.05)) errors.push(`rooms ${a.id} and ${b.id} overlap`);
  }
  // stairs: every landing matches the floor of the space its door opens into
  const doorById = new Map(P.doors.map((d) => [d.id, d]));
  const room = new Map(P.rooms.map((r) => [r.id, r]));
  for (const s of P.stairs) for (const L of s.landings) {
    const d = L.door ? doorById.get(L.door) : undefined;
    if (!d) { errors.push(`stair ${s.id} landing without door`); continue; }
    if (Math.abs(d.centre[1] - L.y) > 0.06) errors.push(`stair ${s.id} landing ${L.y} vs door ${d.id} at ${d.centre[1]}`);
    for (const sp of d.spaces) { const r = room.get(sp); if (r && r.kind !== 'stair' && r.zone !== 'tunnel' && Math.abs(r.y0 - L.y) > 0.06) errors.push(`stair ${s.id} landing ${L.y} vs room ${sp} floor ${r.y0}`); }
  }
  // and every stair is buildable: rises, goings and headroom (see stairs.ts)
  for (const s of P.stairs) {
    const st = validateStair(s, stairOpts(P, s));
    if (!st.ok) errors.push(`stair ${s.id}: ${st.problems.slice(0, 2).join('; ')}`);
  }
  return { ok: errors.length === 0, errors, reachable: seen };
}

/** Castle footprint polygons (quadrangle, towers, gatehouse, turret) for the inside-footprint check. */
export function outerFootprint(): V2[][] {
  const polys: V2[][] = [outerPoly()];
  for (const t of TOWERS) polys.push(t.kind === 'square' ? squareTowerPoly(t) : circlePoly(towerCentre(t), t.r, 32));
  const g = gatehouseFrame(), hw = GATEHOUSE.width / 2;
  polys.push([add(g.base, scale(g.dir, -hw)), add(g.base, scale(g.dir, hw)), add(add(g.base, scale(g.dir, hw)), scale(g.out, GATEHOUSE.project)), add(add(g.base, scale(g.dir, -hw)), scale(g.out, GATEHOUSE.project))]);
  const e = eastTurretFrame(), ew = EAST_TURRET.w / 2;
  polys.push([add(e.base, scale(e.dir, -ew)), add(e.base, scale(e.dir, ew)), add(add(e.base, scale(e.dir, ew)), scale(e.out, EAST_TURRET.project)), add(add(e.base, scale(e.dir, -ew)), scale(e.out, EAST_TURRET.project))]);
  return polys;
}
