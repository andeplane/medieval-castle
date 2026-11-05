// Interior shell: turns a PlanX into geometry, one Builder per visibility group (`${zone}:${floor}`,
// 'stairs:<id>', 'tunnel:-1'). Each room is a closed cell (floor, walls facing in, timber ceiling with
// beams or a stone vault); the walls between cells are never drawn, only cut through:
// - doors: reveal tunnels from one room face to the other, with a rebate step where the leaf closes;
// - windows: splayed embrasures from the room face back to every exterior opening that lights it;
// - the exterior shells are carved wherever an interior space or a doorway passes through them.
import type { V2 } from '../../core/math2d';
import { pointInPoly } from '../../core/math2d';
import { Builder, wallFrame, type Frame, type MatKey, type Opening, type WallRecord, type CurvedRecord, at } from '../builder';
import type { DoorSpec, RoomSpec } from './types';
import { ceilingAt, stairOpts, type PlanX } from './plan';
import { orient, leftN, clip, archOutline, headRise, convexOverlap, type Head, add, sub, scale, dot, norm } from './geom';
import { prismVolume, extrudeVolume, type Volume } from './carve';
import { buildTunnel } from './tunnel';
import { buildStair } from './stairs';
import { wingQuads, squareTowerPoly, towerCentre, gatehouseFrame, eastTurretFrame, stairTowerCentre } from '../layout';
import { TOWERS, GATEHOUSE, EAST_TURRET, STAIR_TOWER, GROUND } from '../spec';

type V3 = [number, number, number];
export interface ShellGroup { key: string; zone: string; floor: number; B: Builder; rooms: string[] }
export interface ShellResult {
  groups: ShellGroup[]; carve: Volume[]; windows: number; skipped: number;
  /** Door openings that could not be cut into a room face (`door@room`); empty when the plan is sound. */
  droppedHoles: string[];
  /** The exterior opening behind each embrasure built: room, outward plan normal, centre on the face, sill. */
  embrasures: { room: string; dir: V2; mid: V2; s0: number; s1: number; yb: number }[];
}
export interface ShellDeps { heightAt?: (x: number, z: number) => number }

const VAULT_K = 12, LIP = 0.08, LEAF_T: Record<DoorSpec['kind'], number> = { plank: 0.08, postern: 0.08, gate: 0.25, grille: 0.06 };

interface Hole { pts: V2[]; kind: 'door' | 'window'; id?: string }
interface Edge { a: V2; b: V2; n: V2; L: number; holes: Hole[] }

export function buildShell(P: PlanX, ext: Builder, deps: ShellDeps = {}): ShellResult {
  const groups = new Map<string, ShellGroup>();
  const room = new Map(P.rooms.map((r) => [r.id, r]));
  const carveVols: Volume[] = [], dropped: string[] = [];
  const groupOf = (r: RoomSpec): ShellGroup => {
    const key = r.kind === 'stair' ? `stairs:${r.id}` : `${r.zone}:${r.floor}`;
    let g = groups.get(key);
    if (!g) { g = { key, zone: r.zone, floor: r.kind === 'stair' ? -1 : r.floor, B: new Builder(), rooms: [] }; groups.set(key, g); }
    return g;
  };
  const wallMat = (r: RoomSpec): MatKey => (P.phase[r.id] === 'old' ? 'old' : 'new');

  // ------------------------------------------------ outlines (round rooms get window facets later)
  const outline = new Map<string, V2[]>();
  for (const r of P.rooms) outline.set(r.id, orient(r.poly));
  const edgesOf = new Map<string, Edge[]>();
  const makeEdges = (id: string) => {
    const p = outline.get(id)!;
    const es: Edge[] = p.map((a, i) => { const b = p[(i + 1) % p.length]; return { a, b, n: leftN(a, b), L: Math.hypot(b[0] - a[0], b[1] - a[1]), holes: [] }; });
    edgesOf.set(id, es); return es;
  };

  // ------------------------------------------------ windows: gather exterior openings by room
  const masses = solidMasses();
  type Win = { f: Frame; ops: Opening[]; s0: number; s1: number; yb: number; yt: number; depth: number; curved: boolean; glass: boolean; dir: V2; mid: V2 };
  const wins: Win[] = [];
  for (const w of ext.walls) if (w.openings.length) wins.push(...groupWindows(w));
  for (const c of ext.curved) wins.push(curvedWindow(c));
  const winFor = new Map<string, Win[]>();
  for (const w of wins) {
    if (w.ops.every((o) => o.fill === 'wood' || o.fill === 'none')) continue;
    const outside = add(w.mid, scale(w.dir, 0.45));
    if (masses.some((m) => pointInPoly(m, outside[0], outside[1]))) continue; // enclosed: inside another mass
    // the room behind it: same height band, an edge facing the opening within 3.6 m
    for (const r of P.rooms) {
      if (r.zone === 'tunnel' || w.yb < r.y0 - 0.2 || w.yb > r.y1 - 0.4) continue;
      const inside = add(w.mid, scale(w.dir, -0.6));
      const p = outline.get(r.id)!;
      // quick reject: the room must lie behind the opening
      const behind = p.some((q) => { const d = dot(sub(q, w.mid), scale(w.dir, -1)); return d > 0.2 && d < 4.5; });
      if (!behind) continue;
      if (P.round[r.id]) {
        const c = P.round[r.id].c, d = norm(sub(w.mid, c));
        if (dot(d, w.dir) < 0.97 || Math.hypot(w.mid[0] - c[0], w.mid[1] - c[1]) > P.round[r.id].r + 3.6) continue;
      } else if (!edgeBehind(p, w)) continue;
      void inside;
      if (!winFor.has(r.id)) winFor.set(r.id, []);
      winFor.get(r.id)!.push(w);
      break;
    }
  }
  // facets on round rooms for their windows (skip any that would eat a door facet)
  for (const [id, ws] of winFor) {
    const rd = P.round[id]; if (!rd) continue;
    const doorsHere = P.doors.filter((d) => d.spaces.includes(id)).map((d) => ({ a: Math.atan2(d.centre[2] - rd.c[1], d.centre[0] - rd.c[0]), h: Math.asin(Math.min(0.99, (d.width / 2 + 0.3) / rd.r)) }));
    const taken: { a: number; h: number }[] = [...doorsHere];
    const keep: Win[] = [];
    for (const w of ws) {
      const a = Math.atan2(w.dir[1], w.dir[0]), half = (w.s1 - w.s0) / 2 + nicheSplay(1.5) + 0.25;
      if (half >= rd.r * 0.9) continue;
      const h = Math.asin(half / rd.r);
      if (taken.some((t) => angDist(t.a, a) < t.h + h + 0.03)) continue;
      taken.push({ a, h }); keep.push(w);
      const n = w.dir, hh = rd.r * Math.cos(h);
      outline.set(id, orient(clip(outline.get(id)!, { n: scale(n, -1), c: -(dot(n, rd.c) + hh) })));
    }
    winFor.set(id, keep);
  }
  for (const r of P.rooms) makeEdges(r.id);

  // ------------------------------------------------ doors
  for (const d of P.doors) door(d);

  // ------------------------------------------------ windows → embrasures
  let nWin = 0, skipped = 0;
  const embrasures: ShellResult['embrasures'] = [];
  for (const [id, ws] of winFor) {
    const r = room.get(id)!, g = groupOf(r);
    for (const w of ws) { if (embrasure(g.B, r, w)) { nWin++; embrasures.push({ room: id, dir: w.dir, mid: w.mid, s0: w.s0, s1: w.s1, yb: w.yb }); } else skipped++; }
  }

  // ------------------------------------------------ room cells
  for (const r of P.rooms) {
    const g = groupOf(r); g.rooms.push(r.id);
    if (r.zone === 'tunnel' && !P.round[r.id]) { tunnelRoom(g.B, r); tunnelCarve(r); continue; }
    cell(g.B, r);
    carveVols.push(prismVolume(outline.get(r.id)!, r.y0 - 0.02, r.y1 + (P.vault[r.id] ? 0.02 : 0.02)));
  }
  for (const s of P.stairs) { const r = room.get(s.id); buildStair(r ? groupOf(r).B : groupOf(room.get(s.spaces[0])!).B, s, stairOpts(P, s)); }

  // ------------------------------------------------ exterior clean-up volumes
  courtyardPlinth(carveVols);
  if (P.sallyPort) portal(ext, P, deps, carveVols);

  return { groups: [...groups.values()], carve: carveVols, windows: nWin, skipped, droppedHoles: dropped, embrasures };

  // ================================================ helpers (closures over the plan)

  function edgeBehind(p: V2[], w: Win) {
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length], n = leftN(a, b);
      if (dot(n, w.dir) > -0.985) continue; // room face must look back at the opening
      const T = dot(sub(a, w.mid), scale(w.dir, -1));
      if (T < 0.25 || T > 3.6) continue;
      const e = norm(sub(b, a)), L = Math.hypot(b[0] - a[0], b[1] - a[1]), t = dot(sub(w.mid, a), e);
      if (t > 0.6 && t < L - 0.6) return true;
    }
    return false;
  }

  /** The edge of room `id` on the plane through `p` with outward normal `nOut` (out of the room). */
  function findEdge(id: string, p: V2, nOut: V2): Edge | null {
    let best: Edge | null = null, bd = 0.25;
    for (const e of edgesOf.get(id) ?? []) {
      if (dot(e.n, nOut) > -0.95) continue;
      const dist = Math.abs(dot(sub(p, e.a), e.n));
      const t = dot(sub(p, e.a), norm(sub(e.b, e.a)));
      if (dist < bd && t > -0.05 && t < e.L + 0.05) { bd = dist; best = e; }
    }
    return best;
  }

  /** Edge-local (s, y) of a world point on the edge's plane. */
  function toEdge(e: Edge, p: V3): V2 { return [dot(sub([p[0], p[2]], e.a), norm(sub(e.b, e.a))), p[1]]; }

  function door(d: DoorSpec) {
    const n = d.normal, al = d.along, c: V2 = [d.centre[0], d.centre[2]], y = d.centre[1];
    const head: Head = d.head, rise = P.rise[d.id] ?? headRise(head, d.width);
    const clear = archOutline(0, y, d.width, d.height, head, rise);
    const leafy = d.leaf && d.kind !== 'gate';
    const reb = leafy ? archOutline(0, y, d.width + 2 * LIP, d.height + LIP, head, rise + LIP * 0.5) : clear;
    // faces: for room sides, the room's actual edge (handles skew); for outside/courtyard, the mid-plane ± wall/2
    const sides = d.spaces.map((sp, k) => {
      const sgn = k === 0 ? -1 : 1, r = room.get(sp);
      const p = add(c, scale(n, (sgn * d.wall) / 2));
      const e = r ? findEdge(sp, p, scale(n, -sgn)) : null;
      return { sp, r, e, p };
    });
    // depth (along n from the centre) of each outline point on each face
    const depthOn = (k: number, u: number): number => {
      const s = sides[k];
      if (!s.e) return ((k === 0 ? -1 : 1) * d.wall) / 2;
      const P0 = add(c, scale(al, u)), den = dot(n, s.e.n);
      return dot(sub(s.e.a, P0), s.e.n) / den;
    };
    const W = (u: number, yy: number, t: number): V3 => [c[0] + al[0] * u + n[0] * t, yy, c[1] + al[1] * u + n[1] * t];
    // holes in the room faces: the leaf side shows the rebated outline
    const swing = d.swingInto;
    sides.forEach((s, k) => {
      if (!s.e) return;
      const pts = (leafy && k === swing ? reb : clear).map(([u, yy]) => toEdge(s.e!, W(u, yy, depthOn(k, u))));
      s.e.holes.push({ pts, kind: 'door', id: d.id });
    });
    const owner = sides.find((s) => s.r)!.r!;
    const B = groupOf(owner).B;
    const rebT = leafy ? ((swing === 1 ? 1 : -1) * (d.wall / 2 - d.rebate - LEAF_T[d.kind])) : 0;
    // reveal: from face 0 to the rebate plane with one outline, then the other to face 1
    const ring = (o: V2[], tA: (u: number) => number, tB: (u: number) => number) => {
      for (let i = 0; i < o.length; i++) {
        const p = o[i], q = o[(i + 1) % o.length];
        const cx = o.reduce((s, v) => s + v[0], 0) / o.length, cy = o.reduce((s, v) => s + v[1], 0) / o.length;
        const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
        const nn = norm3([al[0] * (cx - mx), cy - my, al[1] * (cx - mx)]);
        const A = W(p[0], p[1], tA(p[0])), Bq = W(q[0], q[1], tA(q[0])), C = W(q[0], q[1], tB(q[0])), D = W(p[0], p[1], tB(p[0]));
        const seg = Math.hypot(q[0] - p[0], q[1] - p[1]), dep = Math.abs(tB(p[0]) - tA(p[0]));
        B.bins.trim.tri(A, Bq, C, nn, [0, 0], [seg / 2, 0], [seg / 2, dep / 2]);
        B.bins.trim.tri(A, C, D, nn, [0, 0], [seg / 2, dep / 2], [0, dep / 2]);
      }
    };
    if (!leafy) ring(clear, (u) => depthOn(0, u), (u) => depthOn(1, u));
    else {
      const nonSwing = 1 - swing;
      const tNon = (u: number) => depthOn(nonSwing, u), tSw = (u: number) => depthOn(swing, u);
      ring(clear, tNon, () => rebT);
      ring(reb, () => rebT, tSw);
      // the rebate step: a flat ring between the two outlines facing the swing side
      const f: Frame = { o: [c[0] + n[0] * rebT, 0, c[1] + n[1] * rebT], r: [al[0], 0, al[1]], u: [0, 1, 0], n: swing === 1 ? [n[0], 0, n[1]] : [-n[0], 0, -n[1]] };
      // U-shaped ring between the rebated and the clear outline (open at the threshold)
      for (let i = 1; i < reb.length; i++) {
        const j = (i + 1) % reb.length;
        const A = at(f, reb[i][0], reb[i][1]), Bq = at(f, reb[j][0], reb[j][1]), C = at(f, clear[j][0], clear[j][1]), D = at(f, clear[i][0], clear[i][1]);
        quadN(B, 'trim', A, Bq, C, D, f.n);
      }
    }
    if (d.kind === 'gate') gateDetails(B, d, W, clear);
    // carve the exterior where the doorway passes (both faces, a little beyond)
    const t0 = Math.min(depthOn(0, 0), depthOn(0, -d.width / 2), depthOn(0, d.width / 2)) - (sides[0].r ? 0.05 : 0.02);
    const t1 = Math.max(depthOn(1, 0), depthOn(1, -d.width / 2), depthOn(1, d.width / 2)) + (sides[1].r ? 0.05 : 0.02);
    const out = d.kind === 'gate' ? 1.4 : 0;
    carveVols.push(extrudeVolume(c, al, n, leafy ? reb : clear, t0 - out, t1));
    if (d.kind === 'gate') carveVols.push(extrudeVolume(c, al, n, clear.map(([u, yy]) => [u * 1.0005, yy] as V2), t0 - out, t1));
  }

  function gateDetails(B: Builder, d: DoorSpec, W: (u: number, y: number, t: number) => V3, clear: V2[]) {
    // portcullis groove just inside the outer arch: a slot in both jambs and the head
    const front = -d.wall / 2, g0 = front + 0.62, g1 = g0 + 0.15, deep = 0.12;
    const hw = d.width / 2, y = d.centre[1], top = d.height + (P.rise[d.id] ?? headRise(d.head, d.width));
    for (const sgn of [-1, 1]) {
      const u0 = sgn * hw, u1 = sgn * (hw + deep);
      const nIn: V3 = norm3([-sgn * d.along[0], 0, -sgn * d.along[1]]);
      // back of the groove
      quadN(B, 'iron', W(u1, y, g0), W(u1, y, g1), W(u1, y + d.height, g1), W(u1, y + d.height, g0), nIn);
      // groove cheeks
      for (const [t, f] of [[g0, 1], [g1, -1]] as [number, number][]) quadN(B, 'trim', W(u0, y, t), W(u1, y, t), W(u1, y + d.height, t), W(u0, y + d.height, t), [d.normal[0] * f, 0, d.normal[1] * f]);
    }
    void top; void clear;
  }

  function embrasure(B: Builder, r: RoomSpec, w: Win): boolean {
    // the room face behind the window
    const e = edgeFacing(r.id, w);
    if (!e) return false;
    const T = dot(sub(e.a, w.mid), scale(w.dir, -1)); // depth of the room face behind the exterior plane
    const back = w.curved ? -0.1 : w.depth;           // depth of the niche's back plane
    if (T - back < 0.15) return false;
    const old = P.phase[r.id] === 'old';
    const head: Head = old ? 'round' : 'segmental';
    const sp = nicheSplay(T - back);
    const cx = (w.s0 + w.s1) / 2, wb = w.curved ? w.s1 - w.s0 : w.s1 - w.s0 + 0.16;
    const ybB = w.curved ? w.yb : w.yb - 0.05, ytB = w.curved ? w.yt : w.yt + 0.08;
    const backO = archOutline(cx, ybB, wb, Math.max(0.2, ytB - ybB - (w.curved ? 0 : 0.04)), w.curved ? 'flat' : head, w.curved ? 0 : 0.04);
    const wf = wb + 2 * sp;
    const low = w.yb - r.y0 > 2.2 ? Math.max(r.y0 + 0.9, w.yb - 0.7 * (T - back)) : w.yb - r.y0 > 0.6 ? Math.max(r.y0 + 0.45, w.yb - 0.15) : r.y0 + 0.02;
    const yfT = Math.min(r.y1 - 0.12, w.yt + 0.2 + sp * 0.5);
    const riseF = Math.min(headRise(head, wf), Math.max(0.05, (yfT - low) * 0.35));
    const frontO = archOutline(cx, low, wf, Math.max(0.3, yfT - low - riseF), head, riseF);
    // the hole must sit inside the room face
    const W = (s: number, y: number, dd: number): V3 => at(w.f, s, y, -dd);
    const ptsF = frontO.map(([s, y]) => toEdge(e, W(s, y, T)));
    const sMin = Math.min(...ptsF.map((p) => p[0])), sMax = Math.max(...ptsF.map((p) => p[0]));
    if (sMin < 0.12 || sMax > e.L - 0.12 || low < r.y0 - 1e-6 || yfT > r.y1) return false;
    for (const h of e.holes) { const hs = h.pts.map((p) => p[0]); if (Math.min(...hs) < sMax + 0.15 && Math.max(...hs) > sMin - 0.15) return false; }
    // the niche must not run into another space (stair shafts, the room next door)
    const foot: V2[] = [[cx - wf / 2, T], [cx + wf / 2, T], [cx + wb / 2, back], [cx - wb / 2, back]].map(([s, dd]) => { const p = W(s, 0, dd); return [p[0], p[2]] as V2; });
    for (const o of P.rooms) {
      if (o.id === r.id || o.y1 <= ybB || o.y0 >= yfT) continue;
      if (convexOverlap(foot, outline.get(o.id)!, 0.05)) return false;
    }
    e.holes.push({ pts: ptsF, kind: 'window' });
    // reveals (index-matched outlines)
    const mat: MatKey = 'trim';
    for (let i = 0; i < frontO.length; i++) {
      const j = (i + 1) % frontO.length;
      const A = W(backO[i][0], backO[i][1], back), Bp = W(backO[j][0], backO[j][1], back), C = W(frontO[j][0], frontO[j][1], T), D = W(frontO[i][0], frontO[i][1], T);
      const mid = [(A[0] + Bp[0] + C[0] + D[0]) / 4, (A[1] + Bp[1] + C[1] + D[1]) / 4, (A[2] + Bp[2] + C[2] + D[2]) / 4];
      const axis = W(cx, (ybB + ytB) / 2, (back + T) / 2);
      // normal: perpendicular to the quad, oriented toward the niche axis
      let nn = norm3(cross3(sub3(Bp, A), sub3(D, A)));
      if (dot3(nn, sub3(axis as V3, mid as V3)) < 0) nn = [-nn[0], -nn[1], -nn[2]];
      const seg = Math.hypot(Bp[0] - A[0], Bp[1] - A[1], Bp[2] - A[2]), dep = T - back;
      B.bins[mat].tri(A, Bp, C, nn, [0, 0], [seg / 2, 0], [seg / 2, dep / 2]);
      B.bins[mat].tri(A, C, D, nn, [0, 0], [seg / 2, dep / 2], [0, dep / 2]);
    }
    const fi: Frame = { o: w.f.o, r: w.f.r, u: w.f.u, n: [-w.f.n[0], -w.f.n[1], -w.f.n[2]] };
    if (!w.curved) {
      // back wall of the niche with the opening(s) through it, and glass seen from inside
      ringFaceMulti(B, wallMat(r), fi, backO, w.ops.map((o) => o.pts), back);
      for (const o of w.ops) {
        if (o.fill === 'glass') B.planar('glass', fi, o.pts, o.depth + 0.002);
        else if (o.fill === 'void') {
          const xs = o.pts.map((p) => p[0]), ys = o.pts.map((p) => p[1]);
          carveVols.push(extrudeVolume([w.f.o[0], w.f.o[2]], [w.f.r[0], w.f.r[2]], [w.f.n[0], w.f.n[2]], rectPts(Math.min(...xs) - 0.01, Math.max(...xs) + 0.01, Math.min(...ys) - 0.01, Math.max(...ys) + 0.01), -o.depth - 0.03, -o.depth + 0.03));
        }
      }
    } else {
      if (w.glass) B.planar('glass', fi, rectPts(w.s0, w.s1, w.yb, w.yt), -0.098);
      carveVols.push(extrudeVolume([w.f.o[0], w.f.o[2]], [w.f.r[0], w.f.r[2]], [w.f.n[0], w.f.n[2]], rectPts(w.s0, w.s1, w.yb, w.yt), -0.8, w.glass ? 0.097 : 0.14));
    }
    return true;
  }

  function edgeFacing(id: string, w: Win): Edge | null {
    let best: Edge | null = null, bd = 9;
    for (const e of edgesOf.get(id)!) {
      if (dot(e.n, w.dir) > -0.985) continue;
      const T = dot(sub(e.a, w.mid), scale(w.dir, -1));
      if (T < 0.15 || T > 3.8) continue;
      const t = dot(sub(w.mid, e.a), norm(sub(e.b, e.a)));
      if (t < 0 || t > e.L) continue;
      if (T < bd) { bd = T; best = e; }
    }
    return best;
  }

  function cell(B: Builder, r: RoomSpec) {
    const p = outline.get(r.id)!, es = edgesOf.get(r.id)!, wm = wallMat(r);
    const vault = P.vault[r.id];
    const floorM: MatKey = P.floorMat[r.id] === 'board' ? 'wood' : 'trim';
    B.cap(floorM, p, r.y0, true);
    let u0 = 0;
    const topAt = vault ? vaultHeight(r, vault) : () => r.y1;
    for (const e of es) {
      const f = wallFrame(e.a, e.b, e.n);
      const top: V2[] = [];
      const ed = norm(sub(e.b, e.a));
      const ss = [0, e.L];
      if (vault) {
        // sample the top where the edge crosses the vault's slice lines so wall and vault share vertices
        const side: V2 = [-vault.axis[1], vault.axis[0]], bs = p.map((q) => dot(q, side)), b0 = Math.min(...bs), b1 = Math.max(...bs);
        const ba = dot(e.a, side), db = dot(ed, side);
        if (Math.abs(db) > 1e-6) for (let k = 1; k < VAULT_K; k++) { const sk = (b0 + ((b1 - b0) * k) / VAULT_K - ba) / db; if (sk > 1e-4 && sk < e.L - 1e-4) ss.push(sk); }
      }
      ss.sort((x, y) => y - x);
      for (const sv of ss) top.push([sv, topAt(add(e.a, scale(ed, sv)))]);
      const poly: V2[] = [[0, r.y0], [e.L, r.y0], ...top];
      const topFn = (x: number) => topAt(add(e.a, scale(ed, Math.max(0, Math.min(e.L, x)))));
      const holes = cleanHoles(e.holes.map((h) => h.pts), e.L, r.y0, topFn);
      e.holes.forEach((h, i) => { if (h.kind === 'door' && !holes.kept.includes(i)) dropped.push(`${h.id}@${r.id}`); });
      B.planar(wm, f, poly, 0, holes.holes, u0);
      u0 += e.L;
    }
    if (vault) vaultSurface(B, r, vault, p, wm);
    else {
      B.cap('wood', p, r.y1, false);
      beams(B, r, p);
    }
  }

  function vaultHeight(r: RoomSpec, _v: { axis: V2; spring: number }) { return ceilingAt(P, r); }

  function vaultSurface(B: Builder, r: RoomSpec, v: { axis: V2; spring: number; ribs: boolean; murder?: boolean }, p: V2[], wm: MatKey) {
    const side: V2 = [-v.axis[1], v.axis[0]], h = vaultHeight(r, v);
    const bs = p.map((q) => dot(q, side)), b0 = Math.min(...bs), b1 = Math.max(...bs);
    const K = VAULT_K, bin = B.bins[wm];
    const nrm = (q: V2): V3 => { const e = 0.02, dh = (h(add(q, scale(side, e))) - h(add(q, scale(side, -e)))) / (2 * e); return norm3([side[0] * dh, -1, side[1] * dh]); };
    for (let k = 0; k < K; k++) {
      const lo = b0 + ((b1 - b0) * k) / K, hi = b0 + ((b1 - b0) * (k + 1)) / K;
      const piece = clip(clip(p, { n: side, c: lo }), { n: scale(side, -1), c: -hi });
      if (piece.length < 3) continue;
      for (let i = 1; i < piece.length - 1; i++) {
        const tri = [piece[0], piece[i], piece[i + 1]]; // positive winding in (x, z) faces down
        bin.triN(tri.map((q) => [q[0], h(q), q[1]] as V3), tri.map(nrm), tri.map((q) => [dot(q, v.axis) / 4, dot(q, side) / 4] as [number, number]));
      }
    }
    if (v.ribs) {
      const as = p.map((q) => dot(q, v.axis)), a0 = Math.min(...as), a1 = Math.max(...as);
      for (let a = a0 + 1.2; a < a1 - 0.6; a += 1.6) {
        const seg = 10;
        for (let i = 0; i < seg; i++) {
          const ba = b0 + 0.02 + ((b1 - b0 - 0.04) * i) / seg, bb = b0 + 0.02 + ((b1 - b0 - 0.04) * (i + 1)) / seg;
          const q0 = add(scale(v.axis, a), scale(side, ba)), q1 = add(scale(v.axis, a), scale(side, bb));
          const P0: V3 = [q0[0], h(q0) - 0.1, q0[1]], P1: V3 = [q1[0], h(q1) - 0.1, q1[1]];
          ribBox(B, P0, P1, v.axis, 0.28, 0.2);
        }
      }
    }
    if (v.murder) {
      const as = p.map((q) => dot(q, v.axis)), a0 = Math.min(...as), a1 = Math.max(...as), bc = (b0 + b1) / 2;
      for (let a = a0 + 2.0; a < a1 - 1.0; a += 2.4) {
        const q = add(scale(v.axis, a), scale(side, bc)), y = h(q) - 0.01;
        const sq: V2[] = [add(q, add(scale(v.axis, -0.22), scale(side, -0.22))), add(q, add(scale(v.axis, 0.22), scale(side, -0.22))), add(q, add(scale(v.axis, 0.22), scale(side, 0.22))), add(q, add(scale(v.axis, -0.22), scale(side, 0.22)))];
        B.cap('void', sq, y, false);
      }
    }
  }

  function beams(B: Builder, r: RoomSpec, p: V2[]) {
    // beams span the short way across the room, every ~2.3 m, under the boards
    let best = 0, bl = 0;
    for (let i = 0; i < p.length; i++) { const L = Math.hypot(p[(i + 1) % p.length][0] - p[i][0], p[(i + 1) % p.length][1] - p[i][1]); if (L > bl) { bl = L; best = i; } }
    const ax = norm(sub(p[(best + 1) % p.length], p[best])), side: V2 = [-ax[1], ax[0]];
    const as = p.map((q) => dot(q, ax)), a0 = Math.min(...as), a1 = Math.max(...as);
    const n = Math.max(1, Math.round((a1 - a0) / 2.3));
    for (let k = 0; k < n; k++) {
      const a = a0 + ((a1 - a0) * (k + 0.5)) / n;
      const seg = clip(clip(p, { n: ax, c: a - 0.13 }), { n: scale(ax, -1), c: -(a + 0.13) });
      if (seg.length < 3) continue;
      const bsd = seg.map((q) => dot(q, side)), s0 = Math.min(...bsd), s1 = Math.max(...bsd);
      const c = add(scale(ax, a), scale(side, (s0 + s1) / 2));
      B.box('wood', [c[0], r.y1 - 0.16, c[1]], [s1 - s0, 0.32, 0.26], side, { top: false });
    }
  }

  /** Carve along a tunnel in 1 m pieces so a sloped flight never carves above its own crown. */
  function tunnelCarve(r: RoomSpec) {
    const t = P.tunnels.find((x) => x.room === r.id)!, a = t.path[0], z = t.path[t.path.length - 1];
    const dir = norm(sub([z[0], z[2]], [a[0], a[2]])), side: V2 = [-dir[1], dir[0]], L = Math.hypot(z[0] - a[0], z[2] - a[2]), hw = t.width / 2;
    const yAt = (s: number) => { for (let k = 0; k < t.path.length - 1; k++) { const p = t.path[k], q = t.path[k + 1], tp = dot(sub([p[0], p[2]], [a[0], a[2]]), dir), tq = dot(sub([q[0], q[2]], [a[0], a[2]]), dir); if (s >= tp - 1e-6 && s <= tq + 1e-6) return p[1] + (q[1] - p[1]) * (s - tp) / Math.max(1e-6, tq - tp); } return z[1]; };
    for (let s = 0; s < L - 1e-6; s += 1) {
      const e = Math.min(L, s + 1), y0 = Math.min(yAt(s), yAt(e)) - 0.05, y1 = Math.max(yAt(s), yAt(e)) + t.crown + 0.02;
      const q = (ss: number, u: number): V2 => add(add([a[0], a[2]], scale(dir, ss)), scale(side, u));
      carveVols.push(prismVolume([q(s, -hw), q(e, -hw), q(e, hw), q(s, hw)], y0, y1));
    }
  }

  function tunnelRoom(B: Builder, r: RoomSpec) {
    const t = P.tunnels.find((x) => x.room === r.id)!;
    const es = edgesOf.get(r.id)!;
    const dir = norm(sub([t.path[t.path.length - 1][0], t.path[t.path.length - 1][2]], [t.path[0][0], t.path[0][2]]));
    const capHoles = (startCap: boolean): V3[][] => {
      const want = startCap ? dir : scale(dir, -1);
      const e = es.find((x) => dot(x.n, want) > 0.95);
      if (!e) return [];
      const ed = norm(sub(e.b, e.a));
      return e.holes.map((h) => h.pts.map(([s, y]) => [e.a[0] + ed[0] * s, y, e.a[1] + ed[1] * s] as V3));
    };
    buildTunnel(B, t.path, { width: t.width, crown: t.crown, caps: { start: capHoles(true), end: capHoles(false) } });
  }
}

// ---------------------------------------------------------------- free helpers

const angDist = (a: number, b: number) => Math.abs(((a - b) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
export const nicheSplay = (depth: number) => Math.max(0.15, Math.min(0.55, depth * 0.3));
const norm3 = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const rectPts = (s0: number, s1: number, y0: number, y1: number): V2[] => [[s0, y0], [s1, y0], [s1, y1], [s0, y1]];

function quadN(B: Builder, m: MatKey, a: V3, b: V3, c: V3, d: V3, n: V3) { B.bins[m].tri(a, b, c, n, [0, 0], [0.5, 0], [0.5, 0.5]); B.bins[m].tri(a, c, d, n, [0, 0], [0.5, 0.5], [0, 0.5]); }

function ringFaceMulti(B: Builder, m: MatKey, f: Frame, outer: V2[], holes: V2[][], d: number) { B.planar(m, f, outer, d, holes); }

/** Box between two points (a rib segment), width w across, height h, oriented with `axis` as its width. */
function ribBox(B: Builder, a: V3, b: V3, axis: V2, w: number, h: number) {
  const d = norm3(sub3(b, a)), ax: V3 = [axis[0], 0, axis[1]], up = norm3(cross3(ax, d));
  const dn: V3 = up[1] > 0 ? [-up[0], -up[1], -up[2]] : up;
  const P = (p: V3, s: number, t: number): V3 => [p[0] + ax[0] * s + dn[0] * t, p[1] + ax[1] * s + dn[1] * t, p[2] + ax[2] * s + dn[2] * t];
  const hw = w / 2;
  quadN(B, 'trim', P(a, -hw, h), P(b, -hw, h), P(b, hw, h), P(a, hw, h), dn);
  quadN(B, 'trim', P(a, -hw, 0), P(b, -hw, 0), P(b, -hw, h), P(a, -hw, h), [-ax[0], -ax[1], -ax[2]]);
  quadN(B, 'trim', P(a, hw, 0), P(b, hw, 0), P(b, hw, h), P(a, hw, h), ax);
}

/** Holes must lie inside the face and not overlap; drop the ones that don't (windows first). */
/**
 * Holes that fit inside a wall face (between its ends, under its top) and do not overlap an earlier hole.
 * Returns the cleaned outlines and the indices of the input holes they came from.
 */
export function cleanHoles(hs: V2[][], L: number, y0: number, top: (x: number) => number): { holes: V2[][]; kept: number[] } {
  const ok: V2[][] = [], kept: number[] = [];
  hs.forEach((h, i) => {
    const xs = h.map((p) => p[0]), ys = h.map((p) => p[1]);
    if (Math.min(...xs) < 0.02 || Math.max(...xs) > L - 0.02 || h.some(([x, y]) => y > top(x) - 0.01)) return;
    const bb = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    if (ok.some((o) => { const ox = o.map((p) => p[0]), oy = o.map((p) => p[1]); return Math.min(...ox) < bb[1] && Math.max(...ox) > bb[0] && Math.min(...oy) < bb[3] && Math.max(...oy) > bb[2]; })) return;
    // holes touching the floor line: lift the bottom a hair so triangulation keeps a sliver
    ok.push(h.map(([x, y]) => [x, Math.max(y, y0 + 0.002)] as V2));
    kept.push(i);
  });
  // drop repeated consecutive points
  return { holes: ok.map((h) => h.filter((p, i) => { const q = h[(i + h.length - 1) % h.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-4; })), kept };
}

/** Openings of one exterior wall grouped into windows (twin lights share one embrasure). */
function groupWindows(w: WallRecord) {
  const f = w.frame, out: { f: Frame; ops: Opening[]; s0: number; s1: number; yb: number; yt: number; depth: number; curved: boolean; glass: boolean; dir: V2; mid: V2 }[] = [];
  const items = w.openings.map((o) => { const xs = o.pts.map((p) => p[0]), ys = o.pts.map((p) => p[1]); return { o, s0: Math.min(...xs), s1: Math.max(...xs), yb: Math.min(...ys), yt: Math.max(...ys) }; }).sort((a, b) => a.s0 - b.s0 || a.yb - b.yb);
  const used = new Set<number>();
  items.forEach((it, i) => {
    if (used.has(i)) return;
    const g = [it]; used.add(i);
    items.forEach((jt, j) => { if (!used.has(j) && jt.s0 < g[g.length - 1].s1 + 0.45 && jt.s0 > it.s0 - 0.01 && jt.yb < it.yt && jt.yt > it.yb) { g.push(jt); used.add(j); } });
    const s0 = Math.min(...g.map((x) => x.s0)), s1 = Math.max(...g.map((x) => x.s1)), yb = Math.min(...g.map((x) => x.yb)), yt = Math.max(...g.map((x) => x.yt));
    const mid = at(f, (s0 + s1) / 2, 0, 0);
    out.push({ f, ops: g.map((x) => x.o), s0, s1, yb, yt, depth: Math.max(...g.map((x) => x.o.depth)), curved: false, glass: g.some((x) => x.o.fill === 'glass'), dir: [f.n[0], f.n[2]], mid: [mid[0], mid[2]] });
  });
  return out;
}

function curvedWindow(c: CurvedRecord) {
  const n: V2 = [Math.cos(c.a), Math.sin(c.a)], tan: V2 = [-Math.sin(c.a), Math.cos(c.a)];
  const o = add(c.c, scale(n, c.R));
  const f: Frame = { o: [o[0], 0, o[1]], r: [tan[0], 0, tan[1]], u: [0, 1, 0], n: [n[0], 0, n[1]] };
  return { f, ops: [{ pts: rectPts(-c.w / 2, c.w / 2, c.y, c.y + c.h), depth: 0, fill: c.glass ? 'glass' : 'void', reveal: 'trim' } as Opening], s0: -c.w / 2, s1: c.w / 2, yb: c.y, yt: c.y + c.h, depth: 0, curved: true, glass: c.glass, dir: n, mid: o };
}

/** Plan polygons of solid masses that enclose an opening (so it lights nothing). */
function solidMasses(): V2[][] {
  const m: V2[][] = wingQuads().map((w) => w.quad);
  for (const t of TOWERS) m.push(t.kind === 'square' ? squareTowerPoly(t) : Array.from({ length: 32 }, (_, i) => add(towerCentre(t), [Math.cos((i / 32) * Math.PI * 2) * t.r, Math.sin((i / 32) * Math.PI * 2) * t.r])));
  const g = gatehouseFrame(), hw = GATEHOUSE.width / 2;
  m.push([add(g.base, scale(g.dir, -hw)), add(g.base, scale(g.dir, hw)), add(add(g.base, scale(g.dir, hw)), scale(g.out, GATEHOUSE.project)), add(add(g.base, scale(g.dir, -hw)), scale(g.out, GATEHOUSE.project))]);
  const e = eastTurretFrame(), ew = EAST_TURRET.w / 2;
  m.push([add(e.base, scale(e.dir, -ew)), add(e.base, scale(e.dir, ew)), add(add(e.base, scale(e.dir, ew)), scale(e.out, EAST_TURRET.project)), add(add(e.base, scale(e.dir, -ew)), scale(e.out, EAST_TURRET.project))]);
  const sc = stairTowerCentre();
  m.push(Array.from({ length: STAIR_TOWER.sides }, (_, i) => add(sc, [Math.cos((i / STAIR_TOWER.sides) * Math.PI * 2 + 0.2) * STAIR_TOWER.r, Math.sin((i / STAIR_TOWER.sides) * Math.PI * 2 + 0.2) * STAIR_TOWER.r])));
  return m;
}

/** The battered plinth on the courtyard side of each wing would cross every courtyard door: take it off. */
function courtyardPlinth(vols: Volume[]) {
  const sc = stairTowerCentre();
  for (const w of wingQuads()) {
    const ib = w.quad[2], ia = w.quad[3], d = norm(sub(ib, ia)), out = leftN(w.quad[0], w.quad[1]);
    // courtyard face runs ia → ib (same direction as the outer wall); its outward normal is the wing's inward v
    let s0 = -1.5, s1 = Math.hypot(ib[0] - ia[0], ib[1] - ia[1]) + 1.5;
    const ss = dot(sub(sc, ia), d);
    if (ss > s1 - 6) s1 = Math.min(s1, ss - STAIR_TOWER.r - 0.4);
    if (ss < 6 && ss > -4) s0 = Math.max(s0, ss + STAIR_TOWER.r + 0.4);
    const o = add(ia, scale(d, s0)), L = s1 - s0;
    vols.push(extrudeVolume(o, d, out, rectPts(0, L, GROUND - 2.5, GROUND + 2.85), 0.002, 1.3));
  }
}

/** Sally port on the far bank: a low stone housing where the moat tunnel's last flight leaves the ground. */
function portal(ext: Builder, P: PlanX, deps: ShellDeps, vols: Volume[]) {
  const sp = P.sallyPort!, t = P.tunnels.find((x) => x.room === sp.room)!;
  const h = deps.heightAt ?? (() => 3.0);
  const end = t.path[t.path.length - 1], dir = sp.dir, side: V2 = [-dir[1], dir[0]];
  const start: V2 = [t.path[0][0], t.path[0][2]];
  const floorAt = (s: number) => {
    for (let k = 0; k < t.path.length - 1; k++) {
      const a = t.path[k], b = t.path[k + 1], ta = dot(sub([a[0], a[2]], start), dir), tb = dot(sub([b[0], b[2]], start), dir);
      if (s >= ta && s <= tb) return a[1] + (b[1] - a[1]) * (s - ta) / Math.max(1e-6, tb - ta);
    }
    return end[1];
  };
  const len = sp.len;
  let tH = len - 3;
  for (let s = sp.moatEdge; s < len; s += 0.25) { const p = add(start, scale(dir, s)); if (floorAt(s) + t.crown + 0.5 > h(p[0], p[1])) { tH = s; break; } }
  const hw = t.width / 2 + 0.75, tEnd = len + 0.7;
  const q = (s: number, u: number): V2 => add(add(start, scale(dir, s)), scale(side, u));
  const poly: V2[] = [q(tH, -hw), q(tEnd, -hw), q(tEnd, hw), q(tH, hw)];
  const g0 = Math.min(...poly.map((p) => h(p[0], p[1]))) - 1.2;
  const top = end[1] + t.crown + 0.55;
  ext.prism('old', poly, g0, top, { top: 'trim' });
  // a sloped coping toward the bank
  ext.prism('trim', [q(tEnd - 0.1, -hw - 0.1), q(tEnd + 0.1, -hw - 0.1), q(tEnd + 0.1, hw + 0.1), q(tEnd - 0.1, hw + 0.1)], top, top + 0.25);
  void vols;
}
