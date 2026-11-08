// A swinging leaf never traps a character (Anders, 2026-11-06: "I stand next to a door and open it, it
// crashes into me and it is hard to move, as if I am inside the door"). Over every openable leaf of the
// generated castle, the player's own motor and colliders (assembled as main.ts and the key paths do) stand
// in the swing arc on the swing side, near the hinge, mid-leaf and near the latch edge; the door opens and
// the world steps. The capsule must never overlap a leaf collider, and the character must still walk away.
// No browser.
import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { createInteraction, type UseInput } from '../src/game/interact';
import { m4apply } from '../src/castle/interior/doorGeom';
import { buildInterior, type PlanX } from '../src/castle/interior';
import { buildDoors, type DoorSystem } from '../src/castle/interior/doors';
import { placeLeaves, leafPoint, leafSwing, type LeafPlace } from '../src/castle/interior/doorGeom';
import { portcullisInPlan } from '../src/castle/interior/portcullis';
import type { DoorSpec, V3 } from '../src/castle/interior/types';
import { heightAt } from '../src/world/terrain';
import { setupPlay, playDoors } from '../src/player/setup';
import { ScriptedInput } from '../src/player/input';
import { Footsteps } from '../src/player/footsteps';
import { CharacterMotor, shapeFrom, IDLE } from '../src/character/motor';
import { TUNING } from '../src/player/movement';
import { groups, L } from '../src/physics/world';
import { fakeClock, fakeView } from './helpers';
import { mats, doorMats, terrainObject, islandCastle } from './world';

type Play = Awaited<ReturnType<typeof setupPlay>>;

describe('door swing vs characters', { timeout: 300_000 }, () => {
  let play: Play, input: ScriptedInput, plan: PlanX, doors: DoorSystem, leaves: { d: DoorSpec; pl: LeafPlace; way: 1 | -1 }[];
  let view: ReturnType<typeof fakeView>;

  beforeAll(async () => {
    const isl = islandCastle(), builder = isl.builder;
    const interior = buildInterior(mats(), builder, { heightAt });
    const castle = builder.build(mats());
    plan = interior.plan;
    input = new ScriptedInput();
    play = await setupPlay({
      castle, terrain: terrainObject(), bridge: isl.bridge, input, view: (view = fakeView()), footsteps: new Footsteps(() => null), clock: fakeClock(0.01),
      interior: { collision: interior.collision },
    });
    const sets = playDoors([], plan.doors);
    const gate = plan.doors.find((d) => d.id === 'gate-main')!;
    doors = buildDoors(sets.active, doorMats(), play.physics, { initial: 0, portcullis: [portcullisInPlan(gate, plan.rooms)], characters: play.characters });
    buildDoors(sets.locked, doorMats(), play.physics, { ajar: 0, initial: 0 });
    play.physics.onFixed((dt) => doors.update(dt, play.playerCentre()));
    play.player.setActive(true);
    // every way a leaf swings: forward, and back where it can (onto whoever stands beyond the one who opens it)
    leaves = sets.active.flatMap((d) => (d.swingsBack ? [1, -1] as const : [1] as const).map((way) => ({ d, pl: placeLeaves(d)[0], way })));
  }, 300_000);

  const ONLY_DOORS = groups([L.Character], [L.Door]);
  /** Does the player's capsule (1 cm thinner, for contact slop) at these feet overlap a door leaf collider? */
  const overlap = (feet: V3): string | null => {
    const r = TUNING.radius - 0.01, hh = Math.max(0.05, TUNING.height / 2 - TUNING.radius);
    const c = { x: feet[0], y: feet[1] + hh + TUNING.radius + TUNING.skin, z: feet[2] };
    const hit = play.physics.world.intersectionWithShape(c, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Capsule(hh, r), RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, ONLY_DOORS);
    return hit ? play.physics.tagOf(hit) ?? 'door' : null;
  };

  /** Swing-arc spots on the side it swings to: [radius from the axis it turns on, angle from shut (rad)]. */
  const spots = (pl: LeafPlace): [string, number, number][] => [
    ['hinge', 0.5, 0.75], ['mid', pl.width * 0.55, 0.6], ['latch', pl.width - 0.06, 0.9],
  ];
  /** The axis a leaf turns on its way: its pintles forward, its back edge back. */
  const axis = (pl: LeafPlace, way: 1 | -1) => (way > 0 ? pl.pivot : leafPoint(pl, leafSwing(pl, 0), [0, 0, pl.backAxis]));
  const at = (pl: LeafPlace, way: 1 | -1, r: number, phi: number): [number, number] => {
    const c = Math.cos(phi), s = Math.sin(phi) * way, o = axis(pl, way);
    return [o[0] + r * (pl.eU[0] * c + pl.eV[0] * s), o[2] + r * (pl.eU[1] * c + pl.eV[1] * s)];
  };
  const park = () => { play.player.teleport(0, 200, 0); }; // out of every arc (and every query) between cases
  /** Someone on the other side of the door from where the leaf swings `way`, 1 m off the doorway: they open it that way. */
  const opener = (d: DoorSpec, pl: LeafPlace, way: 1 | -1) => {
    const t = (d.wall / 2 + 1) * way;
    return { pos: { x: d.centre[0] - pl.eV[0] * t, y: d.centre[1] + 0.9, z: d.centre[2] - pl.eV[1] * t } };
  };
  /** Shut, next opened `way`. */
  const shut = (d: DoorSpec, pl: LeafPlace, way: 1 | -1) => {
    doors.setOpen(d.id, true, true, opener(d, pl, way)); doors.setOpen(d.id, false, true);
    expect(doors.swingsInto(d.id)).toBe(way > 0 ? pl.seat : 1 - pl.seat);
  };

  /** Hold W toward (dx, dz) for n ticks, as the player does. */
  const walk = (dx: number, dz: number, n = 30) => {
    input.hold(['KeyW']);
    play.player.yaw = Math.atan2(-dx, -dz);
    for (let i = 0; i < n; i++) play.physics.tick();
    input.hold([]);
  };

  it('a leaf opened onto a character never overlaps it, and the character can walk away', () => {
    const fails: string[] = [];
    let cases = 0;
    for (const { d, pl, way } of leaves) {
      for (const [name, r, phi] of spots(pl)) {
        park();
        shut(d, pl, way);
        play.physics.tick();
        const [x, z] = at(pl, way, r, phi);
        const y = play.player.groundAt(x, z, pl.pivot[1] + 1, pl.pivot[1]);
        if (Math.abs(y - pl.pivot[1]) > 0.35) continue; // not floor on this side (a stair well)
        play.player.teleport(x, y, z);
        for (let i = 0; i < 4; i++) play.physics.tick();
        // only spots a character can actually stand on, clear of the stone and the shut leaf
        if (!play.player.motor.body.fits(TUNING.height) || overlap(play.player.feet) || Math.hypot(play.player.feet[0] - x, play.player.feet[2] - z) > 0.05) continue;
        cases++;
        doors.setOpen(d.id, true, false, opener(d, pl, way)); // someone opens it from the other side, onto them
        let bad: string | null = null;
        // until it is fully open or has rested (stopped against the character) for a quarter second
        for (let i = 0, still = 0, last = -1; i < 120 && !bad && still < 15 && !doors.isOpen(d.id); i++) {
          play.physics.tick();
          const o = overlap(play.player.feet), now = doors.state()[d.id];
          if (o) bad = `overlap ${o} at tick ${i} (openness ${now})`;
          still = now === last ? still + 1 : 0; last = now;
        }
        if (!bad) {
          // walk away: radially out from the hinge, straight into the room, or along the wall either way
          const o = axis(pl, way), rad: [number, number] = [x - o[0], z - o[2]];
          const dirs: [number, number][] = [rad, [pl.eV[0] * way, pl.eV[1] * way], pl.eU, [-pl.eU[0], -pl.eU[1]]];
          const start: V3 = [...play.player.feet];
          // each try goes on from where the last ended (no teleport back: the leaf may have swung on into
          // the start spot once the character left it); distance is measured from the start
          const away = () => {
            let best = 0;
            for (const [dx, dz] of dirs) {
              walk(dx, dz);
              const f = play.player.feet;
              best = Math.max(best, Math.hypot(f[0] - start[0], f[2] - start[2]));
              if (overlap(f)) bad = 'overlap after walking';
              if (best >= 0.5) break;
            }
            return best;
          };
          const best = away();
          if (best < 0.5) {
            // a cramped room (a turret, a stair landing): as far as it lets you with the leaf shut
            park(); shut(d, pl, way); play.physics.tick();
            play.player.teleport(start[0], start[1], start[2]);
            const room = away();
            if (best < room - 0.05) bad = `stuck: moved only ${best.toFixed(2)} m (${room.toFixed(2)} m with the leaf shut)`;
          }
        }
        if (bad) fails.push(`${d.id} ${way > 0 ? 'forward' : 'back'} ${name}: ${bad}`);
      }
      park();
      doors.setOpen(d.id, false, true);
    }
    expect(cases).toBeGreaterThan(leaves.length * 2);
    expect(fails, fails.join('\n')).toEqual([]);
  }, 200_000);

  it('an NPC in the arc stops the leaf the same way (doors take every character, not only the player)', () => {
    const { d, pl, way } = leaves.find((l) => l.d.id === 'court>W0-2')!;
    park();
    shut(d, pl, way);
    const npc = new CharacterMotor(play.physics.createCharacter(shapeFrom()));
    play.npcs.push(npc);
    play.physics.onFixed((dt) => npc.update(IDLE, dt));
    const [x, z] = at(pl, way, pl.width * 0.55, 0.6);
    npc.teleport([x, play.player.groundAt(x, z, pl.pivot[1] + 1, pl.pivot[1]), z]);
    for (let i = 0; i < 10; i++) play.physics.tick();
    expect(doors.request(d.id, true, opener(d, pl, way))).toBe(true); // opened from the other side, onto the NPC
    for (let i = 0; i < 180; i++) { play.physics.tick(); expect(overlap(npc.feet)).toBeNull(); }
    expect(doors.isOpen(d.id)).toBe(false); // stopped against the NPC…
    npc.teleport([x + pl.eV[0] * 3 * way, npc.feet[1], z + pl.eV[1] * 3 * way]); // …which steps out of the arc
    for (let i = 0; i < 180; i++) play.physics.tick();
    expect(doors.isOpen(d.id)).toBe(true); // and the leaf carries on
  }, 200_000);

  // Anders, 2026-11-08: a door shut at the near end of a deep wall passage jumped to the far end when he
  // pressed E; and walking through, it jumped back without a key. Walked as the player does, with the
  // player's motor, camera and E (createInteraction): from either side of deep-wall doors, walk up until the
  // crosshair is on the leaf, press E, and watch the leaf: it swings away from the player, turning on an edge
  // that never leaves its seat; walking through the open door and back (movement only) never moves it; shut
  // again, it is exactly where it was.
  it('walks deep-wall doors from either side: E swings the leaf away in its seat, walking past never moves it', () => {
    let press: (() => void) | null = null;
    const use: UseInput = { subscribe: (cb) => { press = () => cb('key'); return () => {}; } };
    const cam = new THREE.PerspectiveCamera(), shown: (string | null)[] = [];
    const ia = createInteraction(cam, {} as HTMLElement, () => doors.interactables, { input: use, view: { show: (l) => { shown.push(l); }, dispose: () => {} } });
    const look = () => { play.player.frame(1, 1 / 60); cam.position.copy(view.position); cam.quaternion.copy(view.quaternion); ia.update(); };
    const step = (n: number) => { for (let i = 0; i < n; i++) { play.physics.tick(); look(); } };
    const same = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
    const deep = leaves.filter((l) => l.way < 0 && l.d.wall >= 2 && l.d.spaces.every((sp) => plan.rooms.some((r) => r.id === sp && r.kind !== 'stair') || sp === 'courtyard'));
    const sample = deep.filter((_, i) => i % Math.max(1, Math.floor(deep.length / 8)) === 0).slice(0, 8);
    expect(sample.length).toBeGreaterThanOrEqual(6);
    const fails: string[] = [];
    let walked = 0;
    for (const { d, pl } of sample) for (const side of [0, 1] as const) {
      park(); doors.setOpen(d.id, false, true); play.physics.tick();
      const shut = doors.leafPose(d.id)!, sg = side === 1 ? 1 : -1, fx = -d.normal[0] * sg, fz = -d.normal[1] * sg;
      // stand 1.2 m off the doorway on this side, facing it
      const x = d.centre[0] + d.normal[0] * sg * (d.wall / 2 + 1.2), z = d.centre[2] + d.normal[1] * sg * (d.wall / 2 + 1.2);
      play.player.teleport(x, play.player.groundAt(x, z, d.centre[1] + 1, d.centre[1]), z, Math.atan2(-fx, -fz), -0.15);
      step(4);
      // walk in (W only) until the crosshair is on the leaf
      input.hold(['KeyW']);
      for (let i = 0; i < 240 && ia.target()?.id !== d.id; i++) step(1);
      input.hold([]);
      if (ia.target()?.id !== d.id) { fails.push(`${d.id} from ${d.spaces[side]}: never got the crosshair on it`); continue; }
      if (!same(doors.leafPose(d.id)!, shut)) fails.push(`${d.id} from ${d.spaces[side]}: moved before E`);
      press!();
      const hinge = [m4apply(shut, [0, 0, 0]), m4apply(shut, [0, 0, pl.backAxis])];
      for (let i = 0; i < 400 && doors.state()[d.id] < 1; i++) {
        step(1);
        // it turns on its pintles or its back edge: one of the two stays put
        const m = doors.leafPose(d.id)!, a = m4apply(m, [0, 0, 0]), b = m4apply(m, [0, 0, pl.backAxis]);
        if (Math.min(Math.hypot(a[0] - hinge[0][0], a[2] - hinge[0][2]), Math.hypot(b[0] - hinge[1][0], b[2] - hinge[1][2])) > 1e-6) { fails.push(`${d.id} from ${d.spaces[side]}: left its seat`); break; }
      }
      if (!doors.isOpen(d.id)) { fails.push(`${d.id} from ${d.spaces[side]}: did not open (${doors.state()[d.id]})`); continue; }
      if (doors.swingsInto(d.id) !== 1 - side) fails.push(`${d.id} from ${d.spaces[side]}: swung toward the player`);
      // the leaf's latch edge went away from the player
      const latch = (m: number[]) => { const p = m4apply(m, [pl.mirrored ? -pl.width : pl.width, 1, 0]); return (p[0] - d.centre[0]) * d.normal[0] + (p[2] - d.centre[2]) * d.normal[1]; };
      if ((latch(doors.leafPose(d.id)!) - latch(shut)) * sg > -0.5) fails.push(`${d.id} from ${d.spaces[side]}: latch edge did not go away (${((latch(doors.leafPose(d.id)!) - latch(shut)) * sg).toFixed(2)})`);
      // walk through to the far side and back, movement only: the open leaf never moves
      const open = doors.leafPose(d.id)!, f0 = [...play.player.feet];
      walk(fx, fz, 150);
      const through = ((play.player.feet[0] - d.centre[0]) * d.normal[0] + (play.player.feet[2] - d.centre[2]) * d.normal[1]) * sg;
      walk(-fx, -fz, 150);
      if (!same(doors.leafPose(d.id)!, open)) fails.push(`${d.id} from ${d.spaces[side]}: moved while walked past`);
      if (through < -d.wall / 2) walked++;
      // shut it (as anyone can) and it is back exactly where it was
      doors.request(d.id, false, { pos: { x: play.player.feet[0], y: play.player.feet[1] + 0.9, z: play.player.feet[2] } }) || doors.setOpen(d.id, false);
      for (let i = 0; i < 300 && doors.state()[d.id] > 0; i++) play.physics.tick();
      if (!same(doors.leafPose(d.id)!, shut)) fails.push(`${d.id} from ${d.spaces[side]}: shut somewhere else`);
      void f0;
    }
    expect(fails, fails.join('\n')).toEqual([]);
    expect(walked).toBeGreaterThanOrEqual(sample.length); // most walks went right through the doorway
  }, 300_000);
});
