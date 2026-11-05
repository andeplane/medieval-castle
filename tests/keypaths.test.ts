// Key paths (AGENTS.md): the player's own motor and colliders, assembled as main.ts assembles them (castle,
// bridge, revetment, the interior shell's collision soups, terrain with holes, boundary, every door leaf,
// the locked sally-port grille), walked by steering the player along the interior nav graph. No browser.
import { describe, it, expect, beforeAll } from 'vitest';
import { buildCastle } from '../src/castle/castle';
import { buildBridge } from '../src/castle/bridge';
import { buildRevetment } from '../src/castle/revetment';
import { buildInterior, type PlanX } from '../src/castle/interior';
import { navGraph, findPath, type NavGraph } from '../src/castle/interior/nav';
import { buildDoors, gateDoorSpecs, gatePortcullisSpec, type DoorSystem } from '../src/castle/interior/doors';
import type { V3 } from '../src/castle/interior/types';
import { ISLAND, MOAT_OUTER, heightAt } from '../src/world/terrain';
import { pointInPoly } from '../src/core/math2d';
import { courtyard } from '../src/castle/layout';
import { GROUND } from '../src/castle/spec';
import { MOAT_TUNNEL_Y } from '../src/castle/interior/plan';
import { setupPlay, playDoors } from '../src/player/setup';
import { ScriptedInput } from '../src/player/input';
import { Footsteps } from '../src/player/footsteps';
import { fakeClock, fakeView } from './helpers';
import { mats, doorMats, terrainObject } from './world';

type Play = Awaited<ReturnType<typeof setupPlay>>;

describe('key paths', { timeout: 120_000 }, () => {
  let play: Play, input: ScriptedInput, plan: PlanX, G: NavGraph, doors: DoorSystem, bridge: ReturnType<typeof buildBridge>;

  beforeAll(async () => {
    const { builder } = buildCastle();
    bridge = buildBridge(builder, ISLAND, MOAT_OUTER, pointInPoly, undefined, heightAt);
    buildRevetment(builder, ISLAND, heightAt, (x, z) => Math.hypot(x - bridge.start[0], z - bridge.start[1]) < 3.2);
    const interior = buildInterior(mats(), builder, { heightAt });
    const castle = builder.build(mats());
    plan = interior.plan; G = navGraph(plan);
    input = new ScriptedInput();
    play = await setupPlay({
      castle, terrain: terrainObject(), bridge, input, view: fakeView(), footsteps: new Footsteps(() => null), clock: fakeClock(0.01),
      interior: { collision: interior.collision },
    });
    const sets = playDoors(gateDoorSpecs(), plan.doors);
    doors = buildDoors(sets.active, doorMats(), play.physics, { initial: 0, portcullis: [gatePortcullisSpec()], characters: play.characters });
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

  const path = (from: string, to: string, allowLocked = false) => {
    const p = findPath(G, from, to, { allowLocked })!;
    for (const id of p.doors) if (doors.state()[id] !== undefined) doors.setOpen(id, true, true); // E on each door on the way
    return p;
  };
  const room = (id: string) => plan.rooms.find((r) => r.id === id)!;
  const start = (x: number, y: number, z: number) => play.player.teleport(x, play.player.groundAt(x, z, y + 1, y), z, 0, 0);

  it('bridge end → through gate-main → the gate passage → the courtyard', () => {
    doors.setOpen('main-gate', true, true); // the gate opening counts as open (gate-portcullis branch owns it)
    const p = path('outside', 'courtyard');
    expect(p.doors).toEqual(['gate-main', 'gate-inner', 'gate-court']);
    start(bridge.start[0], bridge.deck, bridge.start[1]);
    const w = follow(route(p.nodes));
    expect(w.reached, JSON.stringify(w)).toBe(w.of);
    expect(pointInPoly(courtyard(), w.feet[0], w.feet[2])).toBe(true);
    expect(w.feet[1]).toBeCloseTo(GROUND, 0);
    expect(w.minY).toBeGreaterThan(1.5); // down the bridge-head steps to the lawn, never into the moat
  });

  it('courtyard → ground-floor rooms → the SW tower stair up one floor', () => {
    const p = path('courtyard', 'sw-1');
    expect(p.nodes).toContain('room:W0-2');
    expect(p.nodes.filter((n) => n.startsWith('landing:sw-stair'))).toHaveLength(2);
    const c = G.nodes.get('room:courtyard')!.pos;
    start(c[0], c[1], c[2]);
    const w = follow(route(p.nodes));
    expect(w.reached, JSON.stringify(w)).toBe(w.of);
    const top = room('sw-1');
    expect(pointInPoly(top.poly, w.feet[0], w.feet[2])).toBe(true);
    expect(w.feet[1]).toBeCloseTo(top.y0, 1);
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
});
