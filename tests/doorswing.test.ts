// A swinging leaf never traps a character (Anders, 2026-11-06: "I stand next to a door and open it, it
// crashes into me and it is hard to move, as if I am inside the door"). Over every openable leaf of the
// generated castle, the player's own motor and colliders (assembled as main.ts and the key paths do) stand
// in the swing arc on the swing side, near the hinge, mid-leaf and near the latch edge; the door opens and
// the world steps. The capsule must never overlap a leaf collider, and the character must still walk away.
// No browser.
import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { buildInterior, type PlanX } from '../src/castle/interior';
import { buildDoors, type DoorSystem } from '../src/castle/interior/doors';
import { placeLeaves, type LeafPlace } from '../src/castle/interior/doorGeom';
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
  let play: Play, input: ScriptedInput, plan: PlanX, doors: DoorSystem, leaves: { d: DoorSpec; pl: LeafPlace }[];

  beforeAll(async () => {
    const isl = islandCastle(), builder = isl.builder;
    const interior = buildInterior(mats(), builder, { heightAt });
    const castle = builder.build(mats());
    plan = interior.plan;
    input = new ScriptedInput();
    play = await setupPlay({
      castle, terrain: terrainObject(), bridge: isl.bridge, input, view: fakeView(), footsteps: new Footsteps(() => null), clock: fakeClock(0.01),
      interior: { collision: interior.collision },
    });
    const sets = playDoors([], plan.doors);
    const gate = plan.doors.find((d) => d.id === 'gate-main')!;
    doors = buildDoors(sets.active, doorMats(), play.physics, { initial: 0, portcullis: [portcullisInPlan(gate, plan.rooms)], characters: play.characters });
    buildDoors(sets.locked, doorMats(), play.physics, { ajar: 0, initial: 0 });
    play.physics.onFixed((dt) => doors.update(dt, play.playerCentre()));
    play.player.setActive(true);
    leaves = sets.active.flatMap((d) => placeLeaves(d).map((pl) => ({ d, pl })));
  }, 300_000);

  const ONLY_DOORS = groups([L.Character], [L.Door]);
  /** Does the player's capsule (1 cm thinner, for contact slop) at these feet overlap a door leaf collider? */
  const overlap = (feet: V3): string | null => {
    const r = TUNING.radius - 0.01, hh = Math.max(0.05, TUNING.height / 2 - TUNING.radius);
    const c = { x: feet[0], y: feet[1] + hh + TUNING.radius + TUNING.skin, z: feet[2] };
    const hit = play.physics.world.intersectionWithShape(c, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Capsule(hh, r), RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, ONLY_DOORS);
    return hit ? play.physics.tagOf(hit) ?? 'door' : null;
  };

  /** Swing-arc spots on the swing side: [radius from the hinge axis, angle from shut (rad)]. */
  const spots = (pl: LeafPlace): [string, number, number][] => [
    ['hinge', 0.5, 0.75], ['mid', pl.width * 0.55, 0.6], ['latch', pl.width - 0.06, 0.9],
  ];
  const at = (pl: LeafPlace, r: number, phi: number): [number, number] => {
    const c = Math.cos(phi), s = Math.sin(phi);
    return [pl.pivot[0] + r * (pl.eU[0] * c + pl.eV[0] * s), pl.pivot[2] + r * (pl.eU[1] * c + pl.eV[1] * s)];
  };
  const park = () => { play.player.teleport(0, 200, 0); }; // out of every arc (and every query) between cases

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
    for (const { d, pl } of leaves) {
      for (const [name, r, phi] of spots(pl)) {
        park();
        doors.setOpen(d.id, false, true);
        play.physics.tick();
        const [x, z] = at(pl, r, phi);
        const y = play.player.groundAt(x, z, pl.pivot[1] + 1, pl.pivot[1]);
        if (Math.abs(y - pl.pivot[1]) > 0.35) continue; // not floor on this side (a stair well)
        play.player.teleport(x, y, z);
        for (let i = 0; i < 4; i++) play.physics.tick();
        // only spots a character can actually stand on, clear of the stone and the shut leaf
        if (!play.player.motor.body.fits(TUNING.height) || overlap(play.player.feet) || Math.hypot(play.player.feet[0] - x, play.player.feet[2] - z) > 0.05) continue;
        cases++;
        doors.setOpen(d.id, true);
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
          const rad: [number, number] = [x - pl.pivot[0], z - pl.pivot[2]];
          const dirs: [number, number][] = [rad, pl.eV, pl.eU, [-pl.eU[0], -pl.eU[1]]];
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
            park(); doors.setOpen(d.id, false, true); play.physics.tick();
            play.player.teleport(start[0], start[1], start[2]);
            const room = away();
            if (best < room - 0.05) bad = `stuck: moved only ${best.toFixed(2)} m (${room.toFixed(2)} m with the leaf shut)`;
          }
        }
        if (bad) fails.push(`${d.id} ${name}: ${bad}`);
      }
      park();
      doors.setOpen(d.id, false, true);
    }
    expect(cases).toBeGreaterThan(leaves.length * 2);
    expect(fails, fails.join('\n')).toEqual([]);
  });

  it('an NPC in the arc stops the leaf the same way (doors take every character, not only the player)', () => {
    const { d, pl } = leaves.find((l) => l.d.id === 'court>W0-2')!;
    park();
    doors.setOpen(d.id, false, true);
    const npc = new CharacterMotor(play.physics.createCharacter(shapeFrom()));
    play.npcs.push(npc);
    play.physics.onFixed((dt) => npc.update(IDLE, dt));
    const [x, z] = at(pl, pl.width * 0.55, 0.6);
    npc.teleport([x, play.player.groundAt(x, z, pl.pivot[1] + 1, pl.pivot[1]), z]);
    for (let i = 0; i < 10; i++) play.physics.tick();
    expect(doors.request(d.id, true, { pos: play.characters()[0] })).toBe(true);
    for (let i = 0; i < 180; i++) { play.physics.tick(); expect(overlap(npc.feet)).toBeNull(); }
    expect(doors.isOpen(d.id)).toBe(false); // stopped against the NPC…
    npc.teleport([x + pl.eV[0] * 3, npc.feet[1], z + pl.eV[1] * 3]); // …which steps out of the arc
    for (let i = 0; i < 180; i++) play.physics.tick();
    expect(doors.isOpen(d.id)).toBe(true); // and the leaf carries on
  });
});
