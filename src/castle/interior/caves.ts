// Natural caves under the north moat (Anders, 2026-11-08: "caves that go under the moat etc. make it
// exciting and interesting"). The interior plan owns them like every other space: each chamber and each
// passage is a RoomSpec (zone 'cave'), each opening between two of them a DoorSpec without a leaf, so the
// room graph (world/visibility.ts), the nav graph (nav.ts) and the interior light see them as rooms and
// doorways. This module is the plan only (pure, seeded); caveGeom.ts turns it into rock.
//
// The route, from the N cellar's outer wall (N-c1) out under the island and the moat and back:
//   breach (sloping fissure) → fissure hall ─┬─ bone crawl → ossuary (dead end: bones, an old shrine)
//                                            └─ squeeze → ledge → the drop (rough steps, 4 m) → great cavern (pool)
//   great cavern ─┬─ smugglers' crawl → cache (dead end: casks, crates and a lit lantern)
//                 └─ the rise → well chamber → slope → sump → the climb → a crack in the great tower's
//                    foundations (great-c): the second way out, so the caves are a loop, not a cul-de-sac.
import type { V2 } from '../../core/math2d';
import type { DoorSpec, RoomSpec, SpaceId, V3 } from './types';
import { add, sub, scale, dot, norm, orient, clip } from './geom';

export const CAVE_ZONE = 'cave';
/** The strip of rock between two cave rooms where their natural opening is (the DoorSpec's wall). */
export const CAVE_GAP = 0.2;

export interface CaveChamber {
  id: SpaceId; name: string;
  c: V2; y: number;            // centre and floor height
  axis: V2; a: number; b: number; // plan ellipse: semi-axis a along `axis`, b across
  h: number;                   // dome height above the floor at the centre
  noise: number;               // wall roughness amplitude (m)
  pool?: { c: V2; r: number; depth: number };
}
export interface CavePassage {
  id: SpaceId; name: string;
  from: V3; to: V3;            // floor centre line: start and end (on the facets of its rooms or the castle face)
  w: number; h: number;        // floor width and clear height above the floor (above the nosings for steps)
  noise: number;
  /** Rough steps all the way: their count (the floor is the line of their nosings). */
  steps?: number;
  /** Its two spaces, `from` end first. */
  ends: [SpaceId, SpaceId];
  /** Whether each end meets the castle's wall (a doorway with a collar of rock round it) rather than a chamber. */
  portal: [boolean, boolean];
}
export type CaveFeatureKind = 'bones' | 'shrine' | 'cache' | 'lantern' | 'lost-lantern';
export interface CaveFeature { kind: CaveFeatureKind; room: SpaceId; at: V3; dir: V2 }

export interface CavePlan {
  chambers: CaveChamber[];
  passages: CavePassage[];
  features: CaveFeature[];
  /** Natural openings (DoorSpec ids) between two cave rooms; the castle doorways are ordinary doors. */
  openings: string[];
  /** The cave rooms entered from the castle: [entrance passage, exit passage]. */
  entrance: SpaceId; exit: SpaceId;
}

/** Where the caves meet the castle: a point on a cellar's outer wall face, its outward normal, its room. */
export interface CaveAnchor { room: SpaceId; at: V2; out: V2; y: number }

const side = (d: V2): V2 => [-d[1], d[0]];
/** Radius of a chamber's plan ellipse in the unit direction u. */
export function ellipseRadius(c: CaveChamber, u: V2): number {
  const cu = dot(u, c.axis), cv = dot(u, side(c.axis));
  return 1 / Math.sqrt((cu / c.a) ** 2 + (cv / c.b) ** 2);
}
/** Where a passage leaves a chamber: this fraction of the ellipse radius out, cut flat (the facet). */
export const FACET = 0.78;

/**
 * The caves as a pure function of the seed and two anchors on the castle (the entrance cellar's and the
 * exit cellar's outer wall). Small seeded jitter on every chamber; the route and the sizes are fixed.
 */
export function planCaves(rng: () => number, ent: CaveAnchor, ext: CaveAnchor): { plan: CavePlan; rooms: RoomSpec[]; doors: DoorSpec[] } {
  const j = (s: number) => (rng() - 0.5) * 2 * s;
  const oE = ent.out, sE = side(oE), oX = ext.out;
  const at = (d: number, s: number): V2 => add(add(ent.at, scale(oE, d)), scale(sE, s));
  const chambers: CaveChamber[] = [];
  const ch = (id: string, name: string, c: V2, y: number, a: number, b: number, h: number, noise: number, turn = 0, pool?: CaveChamber['pool']): CaveChamber => {
    const ang = Math.atan2(oE[1], oE[0]) + turn + j(0.25);
    const k: CaveChamber = { id, name, c, y, axis: [Math.cos(ang), Math.sin(ang)], a: a * (1 + j(0.06)), b: b * (1 + j(0.06)), h, noise, pool };
    chambers.push(k); return k;
  };
  // entrance side, along the N cellar's outward normal
  const C1 = ch('cave-hall', 'Fissure hall', at(12.5, j(0.3)), -4.6, 3.6, 3.0, 3.4, 0.4);
  const C3 = ch('cave-ossuary', 'Ossuary', at(14 + j(0.5), -9.5), -5.0, 2.6, 2.4, 3.0, 0.35, 1.2);
  const C5 = ch('cave-ledge', 'Ledge', at(27.5, 0.8 + j(0.4)), -6.4, 3.0, 2.7, 3.0, 0.35, 0.4);
  const C7c = at(44, -2.5);
  const C7 = ch('cave-cavern', 'Great cavern', C7c, -10.6, 10.5, 8.0, 6.2, 0.75, 0.15,
    { c: add(add(C7c, scale(oE, 5.5)), scale(sE, -1.0)), r: 3.3, depth: 0.6 }); // at the far end, off every walk
  const C9 = ch('cave-cache', 'Smugglers\' cache', at(46.5, 15.5), -9.6, 2.6, 2.3, 2.8, 0.3, 1.4);
  const C11 = ch('cave-well', 'Well chamber', at(30.5, -17.5), -8.6, 2.8, 2.5, 3.2, 0.35, -0.5);
  // exit side, along the great tower's outward normal from its cellar
  const C13 = ch('cave-sump', 'Sump', add(ext.at, scale(oX, 13)), -6.4, 2.3, 2.2, 2.7, 0.3, -0.3);

  const passages: CavePassage[] = [];
  const rooms: RoomSpec[] = [], doors: DoorSpec[] = [], openings: string[] = [];
  const facets = new Map<string, { n: V2; c: number }[]>();
  const facet = (k: CaveChamber, u: V2) => {
    const f = ellipseRadius(k, u) * FACET;
    if (!facets.has(k.id)) facets.set(k.id, []);
    facets.get(k.id)!.push({ n: scale(u, -1), c: -(dot(u, k.c) + f) }); // keep dot(u, q) <= dot(u, c) + f
    return f;
  };
  const opening = (id: string, a: SpaceId, b: SpaceId, c: V2, y: number, n: V2, w: number) => {
    doors.push({ id, spaces: [a, b], centre: [c[0], y, c[1]], along: [-n[1], n[0]], normal: n, width: w, height: 2.0, wall: CAVE_GAP, head: 'flat', leaf: false, hinge: 'left', swingInto: 1, rebate: 0, kind: 'plank' });
    openings.push(id);
  };
  type End = CaveChamber | CaveAnchor;
  const isCh = (e: End): e is CaveChamber => 'axis' in e;
  const pass = (id: string, name: string, A: End, B: End, w: number, h: number, noise: number, steps?: number) => {
    const ca = isCh(A) ? A.c : A.at, cb = isCh(B) ? B.c : B.at;
    const u = norm(sub(cb, ca));
    const s0 = isCh(A) ? add(A.c, scale(u, facet(A, u) + CAVE_GAP)) : A.at;
    const s1 = isCh(B) ? sub(B.c, scale(u, facet(B, scale(u, -1)) + CAVE_GAP)) : B.at;
    const p: CavePassage = { id, name, from: [s0[0], A.y, s0[1]], to: [s1[0], B.y, s1[1]], w, h, noise, steps, ends: [isCh(A) ? A.id : A.room, isCh(B) ? B.id : B.room], portal: [!isCh(A), !isCh(B)] };
    passages.push(p);
    if (isCh(A)) opening(`${A.id}>${id}`, A.id, id, add(s0, scale(u, -CAVE_GAP / 2)), A.y, u, Math.min(w, 1.4));
    if (isCh(B)) opening(`${id}>${B.id}`, id, B.id, add(s1, scale(u, CAVE_GAP / 2)), B.y, u, Math.min(w, 1.4));
    return p;
  };
  pass('cave-breach', 'Breach', ent, C1, 1.7, 2.8, 0.22);
  pass('cave-crawl', 'Bone crawl', C1, C3, 1.3, 2.4, 0.2);
  pass('cave-squeeze', 'Squeeze', C1, C5, 1.1, 2.25, 0.08);
  pass('cave-drop', 'The drop', C5, C7, 1.6, 2.5, 0.2, 17);
  pass('cave-smugglers', 'Smugglers\' crawl', C7, C9, 1.4, 2.4, 0.2);
  pass('cave-rise', 'The rise', C7, C11, 1.6, 2.6, 0.25);
  pass('cave-slope', 'Slope', C11, C13, 1.4, 2.5, 0.2);
  pass('cave-climb', 'The climb', C13, ext, 1.6, 2.8, 0.2);

  for (const k of chambers) {
    let poly: V2[] = Array.from({ length: 20 }, (_, i) => {
      const t = (i / 20) * Math.PI * 2, u = Math.cos(t) * k.a, v = Math.sin(t) * k.b;
      return add(add(k.c, scale(k.axis, u)), scale(side(k.axis), v));
    });
    for (const f of facets.get(k.id) ?? []) poly = clip(poly, f);
    rooms.push({ id: k.id, zone: CAVE_ZONE, floor: -1, kind: 'chamber', poly: orient(poly), y0: k.y, y1: k.y + k.h });
  }
  for (const p of passages) {
    const a: V2 = [p.from[0], p.from[2]], b: V2 = [p.to[0], p.to[2]], u = norm(sub(b, a)), s = side(u), hw = p.w / 2 + 0.25;
    const poly: V2[] = [add(a, scale(s, -hw)), add(b, scale(s, -hw)), add(b, scale(s, hw)), add(a, scale(s, hw))];
    rooms.push({ id: p.id, zone: CAVE_ZONE, floor: -1, kind: 'passage', poly: orient(poly), y0: Math.min(p.from[1], p.to[1]), y1: Math.max(p.from[1], p.to[1]) + p.h });
  }

  // what there is to find
  const features: CaveFeature[] = [];
  const toward = (k: CaveChamber, u: V2, f = 0.62): V3 => { const q = add(k.c, scale(u, ellipseRadius(k, u) * f)); return [q[0], k.y, q[1]]; };
  const away = (k: CaveChamber, from: V2): V2 => norm(sub(k.c, from));
  const uC3 = away(C3, C1.c);
  features.push({ kind: 'shrine', room: C3.id, at: toward(C3, uC3, 0.6), dir: scale(uC3, -1) });
  features.push({ kind: 'bones', room: C3.id, at: toward(C3, side(uC3), 0.25), dir: uC3 });
  const uC9 = away(C9, C7.c);
  features.push({ kind: 'cache', room: C9.id, at: toward(C9, uC9, 0.55), dir: scale(uC9, -1) });
  features.push({ kind: 'lantern', room: C9.id, at: toward(C9, uC9, 0.55), dir: scale(uC9, -1) });
  const uC11 = side(away(C11, C7.c));
  features.push({ kind: 'lost-lantern', room: C11.id, at: toward(C11, uC11, 0.45), dir: uC11 });
  features.push({ kind: 'bones', room: C7.id, at: toward(C7, scale(side(C7.axis), -1), 0.55), dir: C7.axis });

  return { plan: { chambers, passages, features, openings, entrance: 'cave-breach', exit: 'cave-climb' }, rooms, doors };
}

/** Is this space a cave room? */
export const isCave = (r: Pick<RoomSpec, 'zone'> | undefined) => r?.zone === CAVE_ZONE;

/** A passage's frame: start, unit direction, length in plan. */
export function passageFrame(p: CavePassage) {
  const a: V2 = [p.from[0], p.from[2]], b: V2 = [p.to[0], p.to[2]], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return { a, u: [(b[0] - a[0]) / L, (b[1] - a[1]) / L] as V2, L };
}

/**
 * The walking line's height along a passage at distance t from its start. Steps: the line of their nosings
 * (n risers of equal rise and going over the whole length, the last tread level with the floor below).
 */
export function passageFloor(p: CavePassage, t: number): number {
  const { L } = passageFrame(p);
  return p.from[1] + (p.to[1] - p.from[1]) * Math.max(0, Math.min(1, t / L));
}

/** Nominal floor (walking surface) and ceiling over a plan point of a cave room (no wall noise): null outside. */
export function caveSpan(P: CavePlan, room: SpaceId, q: V2): { floor: number; ceil: number } | null {
  const k = P.chambers.find((c) => c.id === room);
  if (k) {
    const d = sub(q, k.c), u = dot(d, k.axis), v = dot(d, side(k.axis)), rho = Math.hypot(u / k.a, v / k.b);
    return { floor: k.y - poolDepth(k, q), ceil: k.y + domeAt(k, rho) };
  }
  const p = P.passages.find((x) => x.id === room);
  if (!p) return null;
  const { a, u } = passageFrame(p), t = dot(sub(q, a), u), f = passageFloor(p, t);
  return { floor: p.steps ? f - (p.from[1] - p.to[1]) / p.steps : f, ceil: f + p.h };
}

/** A chamber's ceiling above its floor at normalised plan radius rho (1 = the ellipse). */
export const domeAt = (k: CaveChamber, rho: number) => k.h * (1 - 0.5 * Math.min(1.2, rho) ** 2);
/** How far a chamber's pool basin lowers its floor at q (0 off the pool). */
export function poolDepth(k: CaveChamber, q: V2): number {
  if (!k.pool) return 0;
  const d = Math.hypot(q[0] - k.pool.c[0], q[1] - k.pool.c[1]) / k.pool.r;
  if (d >= 1) return 0;
  const s = Math.min(1, (1 - d) / 0.5);
  return k.pool.depth * s * s * (3 - 2 * s);
}
/** The pool's still water: this far under the chamber floor. */
export const POOL_LEVEL = 0.14;

/** Points to walk through a cave room, in order from its `from` end (passages) or its centre (chambers). */
export function caveWalk(P: CavePlan, room: SpaceId): V3[] {
  const k = P.chambers.find((c) => c.id === room);
  if (k) return [[k.c[0], k.y, k.c[1]]];
  const p = P.passages.find((x) => x.id === room)!;
  const { a, u, L } = passageFrame(p), out: V3[] = [];
  const n = Math.max(1, Math.ceil(L / 1.5));
  for (let i = 0; i <= n; i++) { const t = (i / n) * L, q = add(a, scale(u, t)); out.push([q[0], passageFloor(p, t), q[1]]); }
  return out;
}
