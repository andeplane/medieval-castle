// Navigation over the interior plan, for NPCs: a graph of rooms, door midpoints and stair landings
// (A* over it picks the rooms and doors to pass), plus a clean walkable floor polygon per room for local
// steering or a navmesh later. Pure functions of the plan.
import type { V2 } from '../../core/math2d';
import type { InteriorPlan, SpaceId, V3 } from './types';
import { courtyard } from '../layout';
import { GROUND } from '../spec';
import { orient } from './geom';
import { stairNavPath } from './stairs';
import { stairOpts } from './plan';

export type NavKind = 'room' | 'door' | 'landing';
export interface NavNode { id: string; kind: NavKind; space: SpaceId; pos: V3 }
export interface NavEdge {
  a: string; b: string; cost: number; door?: string; stair?: string; locked?: boolean;
  /** Walking line from a to b where it is not straight (stair flights, from stairNavPath). */
  line?: V3[];
}
export interface NavGraph { nodes: Map<string, NavNode>; edges: NavEdge[]; adj: Map<string, NavEdge[]> }
export interface NavPath { nodes: string[]; doors: string[]; cost: number }

/** Climbing a stair costs this many metres of level walking per metre of height. */
export const CLIMB = 2.5;

const dist3 = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const centroid = (p: V2[]): V2 => [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];

/**
 * Nodes: `room:<space>` (centroid at floor height; 'courtyard' and 'outside' included), `door:<id>`
 * (bottom centre of the opening), `landing:<stair>:<i>`. Edges carry the door id they pass and are
 * `locked` through a grille. Stair rooms reach their doors only through their landings.
 */
export function navGraph(P: InteriorPlan): NavGraph {
  const nodes = new Map<string, NavNode>(), edges: NavEdge[] = [], adj = new Map<string, NavEdge[]>();
  const node = (n: NavNode) => { nodes.set(n.id, n); adj.set(n.id, []); };
  const edge = (e: NavEdge) => { edges.push(e); adj.get(e.a)!.push(e); adj.get(e.b)!.push(e); };
  const rooms = new Map(P.rooms.map((r) => [r.id, r])), doorById = new Map(P.doors.map((d) => [d.id, d]));
  for (const r of P.rooms) { const c = centroid(r.poly); node({ id: `room:${r.id}`, kind: 'room', space: r.id, pos: [c[0], r.y0, c[1]] }); }
  const cy = centroid(courtyard());
  node({ id: 'room:courtyard', kind: 'room', space: 'courtyard', pos: [cy[0], GROUND, cy[1]] });
  const spacePos = (sp: SpaceId, d: InteriorPlan['doors'][number], k: number): V3 => {
    const n = nodes.get(`room:${sp}`);
    if (n) return n.pos;
    const s = k === 0 ? -1 : 1; // an outdoor space without a node: a point 6 m out from the door
    return [d.centre[0] + d.normal[0] * s * 6, d.centre[1], d.centre[2] + d.normal[1] * s * 6];
  };
  for (const d of P.doors) {
    const id = `door:${d.id}`, locked = d.kind === 'grille' || undefined;
    node({ id, kind: 'door', space: d.spaces[0], pos: d.centre });
    d.spaces.forEach((sp, k) => {
      const r = rooms.get(sp);
      if (r?.kind === 'stair') return; // joined through the landing below
      if (!nodes.has(`room:${sp}`)) node({ id: `room:${sp}`, kind: 'room', space: sp, pos: spacePos(sp, d, k) });
      const rn = nodes.get(`room:${sp}`)!;
      edge({ a: rn.id, b: id, cost: Math.max(0.05, dist3(rn.pos, d.centre)), door: d.id, locked });
    });
  }
    for (const s of P.stairs) {
    const room = nodes.get(`room:${s.id}`);
    // the stair's own walking line, split at its landings (each landing is a vertex at its height)
    const line = stairNavPath(s, stairOpts(P, s));
    const order = s.landings.map((L, i) => ({ L, i })).sort((a, b) => a.L.y - b.L.y);
    const cut: number[] = [];
    let from = 0;
    for (const { L } of order) {
      let k = line.findIndex((p, j) => j >= from && Math.abs(p[1] - L.y) < 0.02);
      if (k < 0) k = from;
      cut.push(k); from = k;
    }
    order.forEach(({ L, i }, n) => {
      const d = L.door ? doorById.get(L.door) : undefined;
      const pos: V3 = line[cut[n]] ?? L.at ?? (d ? [d.centre[0], L.y, d.centre[2]] : [room!.pos[0], L.y, room!.pos[2]]);
      const id = `landing:${s.id}:${i}`;
      node({ id, kind: 'landing', space: s.id, pos });
      if (d) edge({ a: id, b: `door:${d.id}`, cost: Math.max(0.05, dist3(pos, d.centre)), door: d.id, stair: s.id, locked: d.kind === 'grille' || undefined });
      if (n > 0) {
        const prev = nodes.get(`landing:${s.id}:${order[n - 1].i}`)!;
        const seg = line.length ? line.slice(cut[n - 1], cut[n] + 1) : [prev.pos, pos];
        let run = 0;
        for (let j = 1; j < seg.length; j++) run += Math.hypot(seg[j][0] - seg[j - 1][0], seg[j][2] - seg[j - 1][2]);
        edge({ a: prev.id, b: id, cost: Math.max(0.05, run + Math.abs(pos[1] - prev.pos[1]) * CLIMB), stair: s.id, line: seg });
      } else if (room) edge({ a: room.id, b: id, cost: Math.max(0.05, dist3(room.pos, pos)), stair: s.id });
    });
  }
  return { nodes, edges, adj };
}

/** A* between two spaces (room ids, 'courtyard', 'outside'). Locked edges are skipped unless allowed. */
export function findPath(G: NavGraph, from: SpaceId, to: SpaceId, o: { allowLocked?: boolean } = {}): NavPath | null {
  const s = `room:${from}`, t = `room:${to}`;
  if (!G.nodes.has(s) || !G.nodes.has(t)) return null;
  const goal = G.nodes.get(t)!.pos;
  const h = (id: string) => dist3(G.nodes.get(id)!.pos, goal);
  const g = new Map<string, number>([[s, 0]]), came = new Map<string, { from: string; e: NavEdge }>();
  const open = new Set([s]), done = new Set<string>();
  while (open.size) {
    let cur = '', best = Infinity;
    for (const id of open) { const f = g.get(id)! + h(id); if (f < best) { best = f; cur = id; } }
    if (cur === t) {
      const nodes = [t], doors: string[] = [];
      let k = t;
      while (came.has(k)) { const c = came.get(k)!; if (c.e.door && !doors.includes(c.e.door)) doors.unshift(c.e.door); nodes.unshift(c.from); k = c.from; }
      return { nodes, doors, cost: g.get(t)! };
    }
    open.delete(cur); done.add(cur);
    for (const e of G.adj.get(cur)!) {
      if (e.locked && !o.allowLocked) continue;
      const nb = e.a === cur ? e.b : e.a;
      if (done.has(nb)) continue;
      const ng = g.get(cur)! + e.cost;
      if (ng < (g.get(nb) ?? Infinity)) { g.set(nb, ng); came.set(nb, { from: cur, e }); open.add(nb); }
    }
  }
  return null;
}

/**
 * Walkable floor outline per room: the plan polygon, positively wound, with repeated and collinear points
 * removed (round rooms keep their facets). Clean input for a navmesh generator.
 */
export function floorPolys(P: InteriorPlan): Map<SpaceId, V2[]> {
  const out = new Map<SpaceId, V2[]>();
  for (const r of P.rooms) {
    let p = orient(r.poly).filter((q, i, a) => { const n = a[(i + 1) % a.length]; return Math.hypot(n[0] - q[0], n[1] - q[1]) > 0.05; });
    for (let changed = true; changed && p.length > 3;) {
      changed = false;
      for (let i = 0; i < p.length; i++) {
        const a = p[(i + p.length - 1) % p.length], b = p[i], c = p[(i + 1) % p.length];
        const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        if (Math.abs(cr) < 1e-4) { p = p.filter((_, j) => j !== i); changed = true; break; }
      }
    }
    out.set(r.id, p);
  }
  return out;
}
