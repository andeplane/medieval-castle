// PlayerController with typed fakes: scripted keys → motor intent, the camera (eye height, crouch,
// interpolation, bob, FOV kick, step smoothing), footstep surfaces, respawn, teleport and ground probes.
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three/webgpu';
import { PlayerController, defaultSurface, type Surface } from '../src/player/controller';
import { CharacterMotor } from '../src/character/motor';
import { ScriptedInput } from '../src/player/input';
import { TUNING } from '../src/player/movement';
import type { CharacterBody, MoveResult } from '../src/character/types';
import type { PhysicsApi, V3 } from '../src/castle/interior/types';
import { fakeView } from './helpers';

/** Flat floor at y = 0 with optional single steps (+0.2 at z < −3) and a void below y −20 at x > 50. */
class FloorBody implements CharacterBody {
  id = 7; p: V3 = [0, 0, 0]; stepAt: number | null = null; fits = () => true;
  feet(): V3 { return [...this.p]; }
  floor(x: number, z: number) { return x > 50 ? -1e9 : this.stepAt !== null && z < this.stepAt ? 0.2 : 0; }
  move(d: V3): MoveResult {
    const o = this.feet();
    const x = o[0] + d[0], z = o[2] + d[2], f = this.floor(x, z);
    let y = o[1] + d[1];
    const hits: MoveResult['hits'] = [];
    if (f > o[1] && f - o[1] < 0.31) y = f;     // autostep
    if (y <= f) { y = f; hits.push({ normal: [0, 1, 0], point: [x, f, z], tag: x < -5 ? 'castle-wood' : undefined }); }
    this.p = [x, y, z];
    return { move: [x - o[0], y - o[1], z - o[2]], grounded: y <= f + 1e-6, hits };
  }
  teleport(p: V3) { this.p = [...p]; }
  setHeight() {}
  remove() {}
}

const ray = (tag?: string): Pick<PhysicsApi, 'raycast'> => ({
  raycast: (from) => (from[1] > 50 ? null : { point: [from[0], 0.5, from[2]], normal: [0, 1, 0], dist: 1, tag }),
});

describe('PlayerController', () => {
  let body: FloorBody, input: ScriptedInput, view: ReturnType<typeof fakeView>, pl: PlayerController, steps: [Surface, boolean, number][];
  const tick = (s: number, keys: string[] = []) => { input.hold(keys); for (let i = 0; i < Math.round(s * 60); i++) { pl.fixedUpdate(1 / 60); pl.frame(1, 1 / 60); } input.hold([]); };

  beforeEach(() => {
    body = new FloorBody(); input = new ScriptedInput(); view = fakeView(); steps = [];
    pl = new PlayerController({ motor: new CharacterMotor(body), input, view, ray: ray('terrain'), onFootstep: (s, r, k) => steps.push([s, r, k]) });
    pl.setActive(true);
    pl.teleport(0, 0, 0, 0, 0);
  });

  it('only moves while active, and ignores a Space pressed before activation', () => {
    pl.setActive(false);
    input.press('Space');
    tick(0.5, ['KeyW']);
    expect(pl.feet[2]).toBe(0);
    pl.setActive(true);
    tick(0.1);
    expect(pl.motor.vy).toBeLessThanOrEqual(0);
  });

  it('WASD + Shift map to walk and run speeds in the look direction', () => {
    tick(1, ['KeyW']);
    expect(pl.state().speed).toBeCloseTo(TUNING.walk, 1);
    expect(pl.feet[2]).toBeLessThan(-2);
    tick(1, ['KeyW', 'ShiftLeft']);
    expect(pl.state().speed).toBeCloseTo(TUNING.run, 1);
    pl.yaw = Math.PI / 2;
    const x0 = pl.feet[0];
    tick(0.5, ['KeyW']);
    expect(pl.feet[0]).toBeLessThan(x0 - 0.5); // yaw +90° walks west
    const z1 = pl.feet[2];
    tick(0.5, ['KeyD']);
    expect(pl.feet[2]).toBeLessThan(z1 - 0.5); // strafing right while facing west goes north
  });

  it('camera: eye height, interpolation, run FOV kick, crouch eye, bob', () => {
    tick(0.2);
    expect(view.position.y).toBeCloseTo(TUNING.eye, 2);
    tick(2, ['KeyW', 'ShiftLeft']);
    expect(view.fov).toBeGreaterThan(TUNING.fov + 3);
    expect(view.projUpdates).toBeGreaterThan(0);
    tick(1.5);
    expect(view.fov).toBeCloseTo(TUNING.fov, 0);
    tick(1, ['KeyC']);
    expect(pl.state().crouched).toBe(true);
    expect(view.position.y).toBeLessThan(TUNING.crouchEye + 0.05);
    tick(1);
    expect(view.position.y).toBeCloseTo(TUNING.eye, 1);
    // interpolation: alpha 0 shows the previous tick, alpha 1 the current one
    input.hold(['KeyW']); pl.fixedUpdate(1 / 60); pl.fixedUpdate(1 / 60);
    pl.frame(0, 0); const z0 = view.position.z;
    pl.frame(1, 0); const z1 = view.position.z;
    expect(z1).toBeLessThan(z0);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pl.pitch, pl.yaw, 0, 'YXZ'));
    expect(view.quaternion.angleTo(q)).toBeCloseTo(0);
  });

  it('smooths the camera over a stair step', () => {
    body.stepAt = -1;
    let maxJump = 0, prev = 0;
    input.hold(['KeyW']);
    for (let i = 0; i < 60; i++) { pl.fixedUpdate(1 / 60); pl.frame(1, 1 / 60); if (i) maxJump = Math.max(maxJump, view.position.y - prev); prev = view.position.y; }
    expect(pl.feet[1]).toBeCloseTo(0.2);
    expect(maxJump).toBeLessThan(0.1); // the 0.2 m step is spread over several frames
  });

  it('footsteps by surface, with cadence that follows speed', () => {
    tick(2, ['KeyW']);
    const walkSteps = steps.length;
    expect(walkSteps).toBeGreaterThanOrEqual(3);
    expect(steps[0][0]).toBe('grass'); // the floor contact has no tag here, so the ray down says 'terrain'
    steps.length = 0;
    tick(2, ['KeyW', 'ShiftLeft']);
    expect(steps.length).toBeGreaterThan(walkSteps);
    expect(steps.some((s) => s[1])).toBe(true);
    pl.teleport(-10, 0, 0, 0, 0); steps.length = 0;
    tick(1, ['KeyW']);
    expect(steps.at(-1)?.[0]).toBe('wood');
    expect(pl.state().surfaceTag).toBe('castle-wood');
  });

  it('surface resolver defaults', () => {
    expect(defaultSurface(undefined, 0, 0)).toBe('stone');
    expect(defaultSurface('castle-wood', 0, 0)).toBe('wood');
    expect(defaultSurface('terrain', 0, 0)).toBe('grass');
    expect(defaultSurface('castle-old', 0, 0)).toBe('stone');
  });

  it('respawns after a long fall, lands with a dip, and probes the ground', () => {
    pl.spawn = { x: 1, y: 0, z: 1, yaw: 0.5 };
    pl.teleport(60, 0, 0);
    tick(2.5);
    expect(pl.feet[0]).toBe(1);
    expect(pl.yaw).toBe(0.5);
    pl.teleport(0, 3, 0);
    tick(1);
    expect(pl.grounded).toBe(true);
    expect(pl.groundAt(0, 0, 10, -7)).toBe(0.5);
    expect(pl.groundAt(0, 0, 100, -7)).toBe(-7);
    const flat = new PlayerController({ motor: new CharacterMotor(new FloorBody()), input, view, ray: { raycast: () => ({ point: [0, 9, 0], normal: [1, 0, 0], dist: 1 }) } });
    expect(flat.groundAt(0, 0, 10, -7)).toBe(-7);
  });

  it('jumps on Space and reports state', () => {
    tick(0.1);
    input.press('Space');
    pl.fixedUpdate(1 / 60);
    expect(pl.motor.vy).toBeGreaterThan(4);
    const s = pl.state();
    expect(s.active).toBe(true);
    expect(typeof s.eye).toBe('number');
  });
});
