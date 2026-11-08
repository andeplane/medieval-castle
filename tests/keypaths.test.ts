// Key paths (AGENTS.md): the player's own motor and colliders, assembled as main.ts assembles them (castle,
// bridge, revetment, the interior shell's collision soups, terrain with holes, boundary, every door leaf,
// the main gate's portcullis, the locked sally-port grille), walked by steering the player along the interior nav graph. No browser.
import { describe, it, expect, beforeAll } from 'vitest';
import { buildInterior, type PlanX } from '../src/castle/interior';
import { navGraph, findPath, type NavGraph } from '../src/castle/interior/nav';
import { buildDoors, type DoorSystem } from '../src/castle/interior/doors';
import { portcullisInPlan } from '../src/castle/interior/portcullis';
import type { V3 } from '../src/castle/interior/types';
import { heightAt } from '../src/world/terrain';
import { pointInPoly } from '../src/core/math2d';
import { courtyard } from '../src/castle/layout';
import { PAVE_Y } from '../src/castle/paving';
import { MOAT_TUNNEL_Y } from '../src/castle/interior/plan';
import { caveWalk, caveSpan } from '../src/castle/interior/caves';
import { setupPlay, playDoors } from '../src/player/setup';
import { ScriptedInput } from '../src/player/input';
import { Footsteps } from '../src/player/footsteps';
import { fakeClock, fakeView } from './helpers';
import { mats, doorMats, terrainObject, islandCastle } from './world';
import type { BridgeInfo } from '../src/physics/boundary';

type Play = Awaited<ReturnType<typeof setupPlay>>;

describe('key paths', { timeout: 120_000 }, () => {
  let play: Play, input: ScriptedInput, plan: PlanX, G: NavGraph, doors: DoorSystem, bridge: BridgeInfo, deckAt: (x: number, z: number) => number | null;

  beforeAll(async () => {
    const isl = islandCastle(), builder = isl.builder;
    bridge = isl.bridge; deckAt = isl.plan.deckHeightAt;
    const interior = buildInterior(mats(), builder, { heightAt });
    const castle = builder.build(mats());
    plan = interior.plan; G = navGraph(plan);
    input = new ScriptedInput();
    play = await setupPlay({
      castle, terrain: terrainObject(), bridge, input, view: fakeView(), footsteps: new Footsteps(() => null), clock: fakeClock(0.01),
      interior: { collision: interior.collision },
    });
    const sets = playDoors([], plan.doors);
    const gate = plan.doors.find((d) => d.id === 'gate-main')!;
    // initial 0: every leaf shut and the portcullis down
    doors = buildDoors(sets.active, doorMats(), play.physics, { initial: 0, portcullis: [portcullisInPlan(gate, plan.rooms)], characters: play.characters });
    buildDoors(sets.locked, doorMats(), play.physics, { ajar: 0, initial: 0 });
    play.physics.onFixed((dt) => doors.update(dt, play.playerCentre()));
    play.player.setActive(true);
  }, 300_000);

  /** Steer the player (W held, yaw set toward the next point each tick) through `pts`; returns how far it got. */
  const follow = (pts: V3[], reach = 0.35) => {
    const p = play.player;
    const start = p.feet.map((v) => Math.round(v * 100) / 100);
    let reached = 0, minY = 1e9, stuck: { at: number[]; target: V3 } | null = null;
    input.hold(['KeyW']);
    for (const q of pts) {
      let ok = false;
      const max = Math.round((3 + Math.hypot(q[0] - p.feet[0], q[2] - p.feet[2]) / 1.2) * 60); // walking is 3 m/s: generous
      for (let i = 0; i < max; i++) {
        const dx = q[0] - p.feet[0], dz = q[2] - p.feet[2];
        if (Math.hypot(dx, dz) < reach && Math.abs(q[1] - p.feet[1]) < 1.2) { ok = true; break; }
        p.yaw = Math.atan2(-dx, -dz);
        play.physics.tick();
        minY = Math.min(minY, p.feet[1]);
      }
      if (!ok) { stuck = { at: p.feet.map((v) => Math.round(v * 100) / 100), target: q.map((v) => Math.round(v * 100) / 100) as V3 }; break; }
      reached++;
    }
    input.hold([]);
    for (let i = 0; i < 30; i++) play.physics.tick();
    return { reached, of: pts.length, feet: [...p.feet] as V3, minY, stuck, start };
  };

  /** Points to walk for a nav path: stair lines as they are, doors with an approach point on each room side. */
  const route = (nodes: string[]): V3[] => {
    const pts: V3[] = [];
    const rooms = new Map(plan.rooms.map((r) => [r.id, r]));
    for (let i = 0; i < nodes.length; i++) {
      const n = G.nodes.get(nodes[i])!;
      const e = i > 0 ? G.adj.get(nodes[i - 1])!.find((x) => x.a === nodes[i] || x.b === nodes[i]) : undefined;
      if (e?.line) { const l = e.a === nodes[i] ? [...e.line].reverse() : e.line; pts.push(...l.slice(1)); continue; }
      if (n.kind === 'door') {
        const d = plan.doors.find((x) => `door:${x.id}` === n.id)!;
        const prev = pts[pts.length - 1] ?? n.pos, off = d.wall / 2 + 0.5;
        const side = Math.sign((prev[0] - d.centre[0]) * d.normal[0] + (prev[2] - d.centre[2]) * d.normal[1]) || -1;
        const at = (s: number): V3 => [d.centre[0] + d.normal[0] * s * off, d.centre[1], d.centre[2] + d.normal[1] * s * off];
        const sp = (s: number) => d.spaces[s > 0 ? 1 : 0];
        if (rooms.get(sp(side))?.kind !== 'stair') pts.push(at(side));
        pts.push(d.centre);
        if (rooms.get(sp(-side))?.kind !== 'stair') pts.push(at(-side));
        continue;
      }
      pts.push(n.pos);
    }
    return pts;
  };

  const path = (from: string, to: string, allowLocked = false, open = true) => {
    const p = findPath(G, from, to, { allowLocked })!;
    // E on each door on the way, from the side the path comes from (a leaf swings away from whoever opens it)
    if (open) for (const id of p.doors) if (doors.state()[id] !== undefined) {
      const at = p.nodes.indexOf(`door:${id}`), from = G.nodes.get(p.nodes[Math.max(0, at - 1)])!.pos;
      doors.setOpen(id, true, true, { pos: { x: from[0], y: from[1] + 1, z: from[2] } });
    }
    return p;
  };
  const room = (id: string) => plan.rooms.find((r) => r.id === id)!;
  const start = (x: number, y: number, z: number) => play.player.teleport(x, play.player.groundAt(x, z, y + 1, y), z, 0, 0);

  it('bridge end → the lowered portcullis stops you → raise it → through gate-main → the courtyard', () => {
    const p = path('outside', 'courtyard', false, false);
    expect(p.doors).toEqual(['gate-main', 'gate-inner', 'gate-court']);
    for (const id of p.doors.slice(1)) if (doors.state()[id] !== undefined) doors.setOpen(id, true, true); // E on the inner doors
    expect(doors.isPassable('gate-main')).toBe(false);
    // the bridge end: half a metre short of the broken edge, on the deck
    const e: [number, number] = [bridge.start[0] + bridge.dir[0] * (bridge.breakAt - 0.5), bridge.start[1] + bridge.dir[1] * (bridge.breakAt - 0.5)];
    start(e[0], deckAt(e[0], e[1])!, e[1]);
    const pts = route(p.nodes);
    const shut = follow(pts);
    expect(shut.reached).toBeLessThan(pts.length);
    // stopped by the grille in the gate passage, short of the groove (2.1 m in from the front face)
    const g = plan.doors.find((d) => d.id === 'gate-main')!;
    const into = (f: V3) => (f[0] - g.centre[0]) * g.normal[0] + (f[2] - g.centre[2]) * g.normal[1] + g.wall / 2; // the normal points in
    expect(into(shut.feet)).toBeGreaterThan(1.5);
    expect(into(shut.feet)).toBeLessThan(2.1);
    // E as the player: a request from where they stand, then the windlass heaves it up (≈ 6 s of ticks)
    expect(doors.request('gate-main', true, { pos: play.playerCentre() })).toBe(true);
    let t = 0;
    for (; t < 15 && !doors.isOpen('gate-main'); t += 1 / 60) play.physics.tick();
    expect(doors.isOpen('gate-main')).toBe(true);
    expect(t).toBeGreaterThan(3);
    const w = follow(pts.slice(shut.reached));
    expect(w.reached, JSON.stringify(w)).toBe(w.of);
    expect(pointInPoly(courtyard(), w.feet[0], w.feet[2])).toBe(true);
    expect(w.feet[1]).toBeCloseTo(PAVE_Y, 1); // standing on the paving, not the earth under it
    expect(play.player.surfaceTag).toBe('castle-pave'); // the last footsteps were on the cobbles…
    expect(play.player.surface).toBe('stone'); // …and sounded like stone
    expect(shut.minY).toBeGreaterThan(1.5); // down the bridge-head steps to the lawn, never into the moat
  });

  it('courtyard → SE tower stair → the windlass room over the gate → the winch lowers and raises the portcullis', () => {
    const p = path('courtyard', 'gate2');
    expect(p.nodes).toContain('room:gate2');
    const c = G.nodes.get('room:courtyard')!.pos;
    start(c[0], c[1], c[2]);
    const r = room('gate2'), g = plan.doors.find((d) => d.id === 'gate-main')!;
    // then up to the drum: stand 1.9 m behind the groove line (portcullis.ts GROOVE_IN), beside the near rope
    const k = g.wall / 2 - 0.5, at: V3 = [g.centre[0] + g.normal[0] * (k + 1.9) + g.along[0] * 0.9, r.y0, g.centre[2] + g.normal[1] * (k + 1.9) + g.along[1] * 0.9];
    const w = follow([...route(p.nodes), at]);
    expect(w.reached, JSON.stringify(w)).toBe(w.of);
    expect(pointInPoly(r.poly, w.feet[0], w.feet[2])).toBe(true);
    expect(w.feet[1]).toBeCloseTo(r.y0, 1);
    // E on the windlass from where the player stands: down (fast, on the brake), then up again (slow)
    const tickUntil = (done: () => boolean, max: number) => { let t = 0; for (; t < max && !done(); t += 1 / 60) play.physics.tick(); return t; };
    expect(doors.isOpen('gate-main')).toBe(true); // key path 1 left it raised
    expect(doors.request('gate-main', false, { pos: play.playerCentre() })).toBe(true);
    const down = tickUntil(() => doors.state()['gate-main'] === 0, 10);
    expect(down).toBeLessThan(2.5);
    expect(doors.isPassable('gate-main')).toBe(false);
    expect(doors.request('gate-main', true, { pos: play.playerCentre() })).toBe(true);
    const up = tickUntil(() => doors.isOpen('gate-main'), 15);
    expect(up).toBeGreaterThan(down * 2);
    expect(doors.isOpen('gate-main')).toBe(true);
  });

  it('courtyard → ground-floor rooms → the SW tower stair up one floor', () => {
    const p = path('courtyard', 'sw-1', false, false);
    expect(p.nodes).toContain('room:W0-2');
    // the courtyard door into W0-2 is a real leaf: shut, it stops you; opened (E), you walk through
    const d = plan.doors.find((x) => x.id === 'court>W0-2')!;
    expect(d.leaf).toBe(true);
    expect(doors.state()[d.id]).toBe(0);
    const c0 = G.nodes.get('room:courtyard')!.pos;
    start(c0[0], c0[1], c0[2]);
    const shut = follow(route(['room:courtyard', 'door:court>W0-2', 'room:W0-2']));
    expect(shut.reached).toBeLessThan(4); // never the point past the door
    const side = (f: V3) => (f[0] - d.centre[0]) * d.normal[0] + (f[2] - d.centre[2]) * d.normal[1];
    expect(side(shut.feet)).toBeLessThan(d.wall / 2); // still in the doorway at most, not in the room
    path('courtyard', 'sw-1');
    expect(p.nodes.filter((n) => n.startsWith('landing:sw-stair'))).toHaveLength(2);
    const c = G.nodes.get('room:courtyard')!.pos;
    start(c[0], c[1], c[2]);
    const w = follow(route(p.nodes));
    expect(w.reached, JSON.stringify(w)).toBe(w.of);
    const top = room('sw-1');
    expect(pointInPoly(top.poly, w.feet[0], w.feet[2])).toBe(true);
    expect(w.feet[1]).toBeCloseTo(top.y0, 1);
  });

  it('N0-3 → the cellar stair door → its top landing (not the cellar floor 4.4 m below) → down the flight to the N cellar', () => {
    const p = path('N0-3', 'N-c1');
    const d = plan.doors.find((x) => x.id === 'N0-3>N-cellarstair')!, top = room('N0-3'), bot = room('N-c1');
    expect(p.doors[0]).toBe(d.id);
    const n = G.nodes.get('room:N0-3')!.pos;
    start(n[0], top.y0, n[2]);
    // through the door Anders used: 0.6 m past its inner face, on the stair side
    const landing: V3 = [d.centre[0] + d.normal[0] * (d.wall / 2 + 0.6), d.centre[1], d.centre[2] + d.normal[1] * (d.wall / 2 + 0.6)];
    const a = follow([...route(['room:N0-3', `door:${d.id}`]), landing]);
    expect(a.reached, JSON.stringify(a)).toBe(a.of);
    expect(a.feet[1]).toBeCloseTo(top.y0, 1); // standing on the landing at the sill…
    expect(a.minY).toBeGreaterThan(top.y0 - 0.1); // …never dropped into the stairwell
    // and on down the flight to the cellar
    const w = follow(route(p.nodes.slice(2))); // from the top landing's nosing
    expect(w.reached, JSON.stringify(w)).toBe(w.of);
    expect(pointInPoly(bot.poly, w.feet[0], w.feet[2])).toBe(true);
    expect(w.feet[1]).toBeCloseTo(bot.y0, 1);
  });

  it('a cellar → the moat tunnel → stops at the locked sally-port grille', () => {
    const p = path('great-c', 'tunnel-5');
    const t = plan.tunnels.find((x) => x.id === 'tunnel-5')!, g = plan.doors.find((d) => d.id === 'sallyport-grille')!;
    expect(doors.state()['sallyport-grille']).toBeUndefined(); // not in the openable set
    const beyond: V3 = [g.centre[0] + g.normal[0] * 3, g.centre[1], g.centre[2] + g.normal[1] * 3];
    const c = room('great-c');
    const n = G.nodes.get('room:great-c')!.pos;
    start(n[0], c.y0, n[2]);
    const pts = [...route(p.nodes.slice(0, -1)), ...t.path.slice(1, -1), beyond];
    const w = follow(pts);
    expect(w.reached, JSON.stringify(w)).toBe(pts.length - 1); // every point up to the grille…
    expect(w.minY).toBeGreaterThan(MOAT_TUNNEL_Y - 0.3); // …down to the bottom of the tunnel…
    const past = (w.feet[0] - g.centre[0]) * g.normal[0] + (w.feet[2] - g.centre[2]) * g.normal[1];
    expect(past).toBeLessThan(-0.2);  // …but not through it
    expect(past).toBeGreaterThan(-1.2);
  });

  /** Points to walk through a chain of rooms: each doorway with a point before and after it, a cave passage along its own walking line, a chamber or cellar through its middle. */
  const caveRoute = (rooms: string[]): V3[] => {
    const pts: V3[] = [];
    for (let i = 0; i < rooms.length; i++) {
      const r = room(rooms[i]);
      if (i > 0) {
        const d = plan.doors.find((x) => x.spaces.includes(rooms[i - 1]) && x.spaces.includes(rooms[i]))!;
        const into = d.spaces[1] === rooms[i] ? 1 : -1, off = d.wall / 2 + 0.45;
        const at = (s: number): V3 => {
          const q: [number, number] = [d.centre[0] + d.normal[0] * s * off, d.centre[2] + d.normal[1] * s * off];
          const sp = d.spaces[s > 0 ? 1 : 0], cs = plan.caves && caveSpan(plan.caves, sp, q);
          return [q[0], cs ? cs.floor : d.centre[1], q[1]];
        };
        pts.push(at(-into), d.centre, at(into));
      }
      if (r.zone !== 'cave') { if (i === 0 || i === rooms.length - 1) { const n = G.nodes.get(`room:${r.id}`)!.pos; pts.push([n[0], r.y0, n[2]]); } continue; }
      let w = caveWalk(plan.caves!, r.id);
      const last = pts[pts.length - 1];
      if (last && w.length > 1 && Math.hypot(w[0][0] - last[0], w[0][2] - last[2]) > Math.hypot(w[w.length - 1][0] - last[0], w[w.length - 1][2] - last[2])) w = [...w].reverse();
      pts.push(...w);
    }
    return pts;
  };

  it('the N cellar → the breach → the squeeze → down the drop → the great cavern, as the nav graph leads', () => {
    const p = path('N-c1', 'cave-cavern');
    const rooms = p.nodes.filter((n) => n.startsWith('room:')).map((n) => n.slice(5));
    expect(rooms).toEqual(['N-c1', 'cave-breach', 'cave-hall', 'cave-squeeze', 'cave-ledge', 'cave-drop', 'cave-cavern']);
    const c = room('N-c1'), n = G.nodes.get('room:N-c1')!.pos;
    start(n[0], c.y0, n[2]);
    const w = follow(caveRoute(rooms));
    expect(w.reached, JSON.stringify(w)).toBe(w.of);
    const cav = plan.caves!.chambers.find((k) => k.id === 'cave-cavern')!;
    expect(Math.hypot(w.feet[0] - cav.c[0], w.feet[2] - cav.c[1])).toBeLessThan(0.6);
    expect(w.feet[1]).toBeCloseTo(cav.y, 0); // on the cavern floor, 8.8 m below the cellar and under the moat
    expect(w.minY).toBeGreaterThan(cav.y - 0.3); // never through a floor
  });

  it('every cave chamber on foot: both dead ends and back, the cavern, and out through the crack into the great tower\'s cellar', () => {
    const loop = ['N-c1', 'cave-breach', 'cave-hall', 'cave-crawl', 'cave-ossuary', 'cave-crawl', 'cave-hall', 'cave-squeeze', 'cave-ledge', 'cave-drop', 'cave-cavern',
      'cave-smugglers', 'cave-cache', 'cave-smugglers', 'cave-cavern', 'cave-rise', 'cave-well', 'cave-slope', 'cave-sump', 'cave-climb', 'great-c'];
    for (const k of plan.caves!.chambers) expect(loop).toContain(k.id);
    const c = room('N-c1'), n = G.nodes.get('room:N-c1')!.pos;
    start(n[0], c.y0, n[2]);
    const pts = caveRoute(loop);
    const w = follow(pts);
    expect(w.reached, JSON.stringify(w)).toBe(w.of);
    const gc = room('great-c');
    expect(pointInPoly(gc.poly, w.feet[0], w.feet[2])).toBe(true);
    expect(w.feet[1]).toBeCloseTo(gc.y0, 1);
    expect(w.minY).toBeGreaterThan(-10.6 - 0.3);
  });
});
