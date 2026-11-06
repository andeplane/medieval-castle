// Every stair in the generated castle, walked up and back down by the player's own motor, controller
// and colliders (assembled as main.ts assembles them) with W held and the view steered along the
// flight's walking line (stairNavPath: 2/3 of the radius on a spiral). Climbing must feel like
// walking: no slow-downs at the steps, no stalls, and an eye that rises and falls without a jolt.
import { describe, it, expect, beforeAll } from 'vitest';
import { buildInterior, type PlanX } from '../src/castle/interior';
import { stairOpts } from '../src/castle/interior/plan';
import { stairNavPath } from '../src/castle/interior/stairs';
import { buildDoors } from '../src/castle/interior/doors';
import type { V3 } from '../src/castle/interior/types';
import { heightAt } from '../src/world/terrain';
import { setupPlay, playDoors } from '../src/player/setup';
import { ScriptedInput } from '../src/player/input';
import { Footsteps } from '../src/player/footsteps';
import { TUNING } from '../src/player/movement';
import { DT } from '../src/physics/world';
import { fakeClock, fakeView } from './helpers';
import { mats, doorMats, terrainObject, islandCastle } from './world';

type Play = Awaited<ReturnType<typeof setupPlay>>;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

describe('stair walk', { timeout: 300_000 }, () => {
  let play: Play, input: ScriptedInput, plan: PlanX;
  const view = fakeView();

  beforeAll(async () => {
    const isl = islandCastle();
    const interior = buildInterior(mats(), isl.builder, { heightAt });
    const castle = isl.builder.build(mats());
    plan = interior.plan;
    input = new ScriptedInput();
    play = await setupPlay({
      castle, terrain: terrainObject(), bridge: isl.bridge, input, view, footsteps: new Footsteps(() => null), clock: fakeClock(0.01),
      interior: { collision: interior.collision },
    });
    // every leaf shut, in its doorway: the walking lines stay inside the stair rooms
    const doors = buildDoors(playDoors([], plan.doors).active, doorMats(), play.physics, { initial: 0 });
    play.physics.onFixed((dt) => doors.update(dt, play.playerCentre()));
    play.player.setActive(true);
  }, 300_000);

  /**
   * W held, the view turned each tick toward the point 0.5 m further along `line` than the nearest one
   * (stairNavPath samples it every ≤ 12 cm). Per tick: the motor's horizontal speed and the camera height.
   */
  const walk = (line: V3[]) => {
    const p = play.player, m = p.motor, end = line[line.length - 1];
    p.teleport(line[0][0], p.groundAt(line[0][0], line[0][2], line[0][1] + 0.5, line[0][1]), line[0][2]);
    for (let i = 0; i < 10; i++) play.physics.tick(); // settle on the floor
    const speeds: number[] = [], eyes: number[] = [];
    let k = 0, ok = false;
    input.hold(['KeyW']);
    for (let i = 0, max = Math.round((4 + line.length * 0.15) * 60); i < max; i++) {
      const f = m.feet;
      let best = Infinity;
      for (let j = k; j < Math.min(line.length, k + 12); j++) {
        const d = Math.hypot(line[j][0] - f[0], line[j][2] - f[2]);
        if (d < best) { best = d; k = j; }
      }
      let a = k, run = 0;
      while (a + 1 < line.length && run < 0.5) { run += Math.hypot(line[a + 1][0] - line[a][0], line[a + 1][2] - line[a][2]); a++; }
      if (Math.hypot(end[0] - f[0], end[2] - f[2]) < 0.3 && Math.abs(end[1] - f[1]) < 0.3) { ok = true; break; }
      p.yaw = Math.atan2(-(line[a][0] - f[0]), -(line[a][2] - f[2]));
      play.physics.tick();
      p.frame(1, DT);
      speeds.push(m.speed); eyes.push(view.position.y);
    }
    input.hold([]);
    for (let i = 0; i < 20; i++) play.physics.tick();
    const after = speeds.slice(Math.round(0.3 / DT));
    let jump = 0, jolt = 0;
    for (let i = 1; i < eyes.length; i++) {
      jump = Math.max(jump, Math.abs(eyes[i] - eyes[i - 1]));
      if (i > 1) jolt = Math.max(jolt, Math.abs(eyes[i] - 2 * eyes[i - 1] + eyes[i - 2]));
    }
    return { ok, feet: m.feet.map(r3), minSpeed: r3(Math.min(...after)), seconds: r3(speeds.length * DT), jump: r3(jump), jolt: r3(jolt) };
  };

  it('walks every stair up and back down at walking speed, without stalls or jolts of the eye', () => {
    expect(plan.stairs.some((s) => s.kind === 'spiral')).toBe(true);
    expect(plan.stairs.some((s) => s.kind === 'straight')).toBe(true);
    const bad: string[] = [], all: Record<string, unknown> = {};
    for (const s of plan.stairs) {
      const line = stairNavPath(s, stairOpts(plan, s));
      expect(line.length, s.id).toBeGreaterThan(1);
      for (const [dir, l] of [['up', line], ['down', [...line].reverse()]] as const) {
        const w = walk(l);
        all[`${s.id} ${dir}`] = w;
        // at the far landing; never under 80 % of walking speed once under way (on main: 0.02 m/s,
        // a near-stall at many treads); the eye moves at most 6 cm a tick (3 m/s up the steepest
        // walking line is ≈ 5) and its climbing speed changes by at most 3.5 cm a tick per tick
        // (on main: 7-8, a bump at every step)
        if (!w.ok || w.minSpeed < 0.8 * TUNING.walk || w.jump > 0.06 || w.jolt > 0.035) bad.push(`${s.id} ${dir} ${JSON.stringify(w)}`);
      }
    }
    expect(Object.keys(all)).toHaveLength(plan.stairs.length * 2);
    expect(bad, bad.join('\n')).toEqual([]);
  });
});
