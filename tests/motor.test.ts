// CharacterMotor on the real Rapier KCC (Node): a synthetic course of stairs, ramps, a low beam, a wall,
// a stair through a terrain hole into a tunnel, the boundary ribbon, and two characters that collide.
import { describe, it, expect, beforeAll } from 'vitest';
import { createPhysics, type Physics } from '../src/physics/world';
import { CharacterMotor, IDLE, shapeFrom, riseAlong, type MotorIntent, type Footfall } from '../src/character/motor';
import type { CharacterBody, MoveResult } from '../src/character/types';
import { TUNING, wishVelocity } from '../src/player/movement';
import { addBox, fakeClock } from './helpers';

// lanes along −z, one per x
const LANE = { s15: 0, s20: 3, s30: 6, s35: 9, r30: 12, r55: 15, beam: 18, tunnel: 24, boundary: 27, wall: 33 };

describe('CharacterMotor on Rapier', () => {
  let P: Physics, m: CharacterMotor;
  const north = (speed = TUNING.walk, p: Partial<MotorIntent> = {}): MotorIntent => ({ wish: [0, -speed], jump: false, crouch: false, ...p });
  const run = (intent: MotorIntent | ((i: number) => MotorIntent), seconds: number, motor = m) => {
    let grounded = 0;
    const n = Math.round(seconds * 60);
    for (let i = 0; i < n; i++) { motor.update(typeof intent === 'function' ? intent(i) : intent, 1 / 60); P.world.step(); if (motor.grounded) grounded++; }
    return { feet: motor.feet, groundedFrac: grounded / n, crouched: motor.crouched, speed: motor.speed };
  };
  const at = (x: number, y = 0, z = 0, motor = m) => motor.teleport([x, y, z]);
  const stairs = (x: number, rise: number, runL: number, n: number) => { for (let k = 1; k <= n; k++) addBox(P, x - 1, x + 1, 0, rise * k, -20, -k * runL + runL - 2); };
  const ramp = (x: number, deg: number) => {
    const L = 3, h = L * Math.tan((deg * Math.PI) / 180);
    const v = [x - 1, 0, -2, x + 1, 0, -2, x + 1, h, -2 - L, x - 1, h, -2 - L, x - 1, h, -20, x + 1, h, -20];
    P.world.createCollider(P.R.ColliderDesc.trimesh(new Float32Array(v), new Uint32Array([0, 1, 2, 0, 2, 3, 3, 2, 5, 3, 5, 4])));
  };

  beforeAll(async () => {
    P = await createPhysics(fakeClock());
    // an open terrain sheet at y = 0, with a hole over the tunnel lane's stairwell
    P.addTerrain({ heights: new Float32Array(51 * 41), nx: 51, nz: 41, dx: 1, dz: 1, ox: -10, oz: -30 }, { x0: -10, x1: 40, z0: -30, z1: 10 }, (x, z) => Math.abs(x - LANE.tunnel) < 1.2 && z < -2 && z > -9.5);
    stairs(LANE.s15, 0.15, 0.3, 6); stairs(LANE.s20, 0.2, 0.3, 5); stairs(LANE.s30, 0.3, 0.4, 3); stairs(LANE.s35, 0.35, 0.4, 3);
    ramp(LANE.r30, 30); ramp(LANE.r55, 55);
    addBox(P, LANE.beam - 1, LANE.beam + 1, 1.3, 1.6, -5, -2, 'wood');
    addBox(P, LANE.wall - 4, LANE.wall + 4, 0, 3, -3, -2.6);
    for (let k = 1; k <= 15; k++) addBox(P, LANE.tunnel - 1, LANE.tunnel + 1, -0.2 * k - 0.3, -0.2 * k, -2 - k * 0.3, -2 - (k - 1) * 0.3);
    addBox(P, LANE.tunnel - 1, LANE.tunnel + 1, -3.3, -3, -20, -6.5);
    addBox(P, LANE.boundary - 1, LANE.boundary + 1, -3.3, -3, -12, -1); // a cellar floor under the boundary lane
    P.addBoundary([[LANE.boundary - 2, -4], [LANE.boundary + 2, -4]], -1, 40);
    m = new CharacterMotor(P.createCharacter(shapeFrom()));
  });

  it('walks flat ground at walk and run speed, staying grounded', () => {
    at(-5);
    const w = run(north(), 1.5);
    expect(w.speed).toBeCloseTo(TUNING.walk, 1);
    expect(w.groundedFrac).toBeGreaterThan(0.95);
    at(-5);
    expect(run(north(TUNING.run), 1.5).speed).toBeCloseTo(TUNING.run, 1);
    expect(m.running).toBe(true);
    expect(run(IDLE, 0.5).speed).toBeCloseTo(0, 2);
  });
  // 0.30 m: the KCC rides up over each nosing (no press down while it walks the plain floor), so there is
  // no single-tick lift for the camera to smooth
  it.each([['0.15', LANE.s15, 0.9, 0], ['0.20', LANE.s20, 1.0, 1], ['0.30', LANE.s30, 0.9, 0]])('climbs %s m stairs (big rises reported as steps for the camera)', (_n, x, top, minSteps) => {
    at(x);
    let steps = 0;
    run((i) => { if (i > 0 && m.stepDy) steps++; return north(); }, 4);
    expect(m.feet[1]).toBeCloseTo(top, 1);
    expect(steps).toBeGreaterThanOrEqual(minSteps);
  });
  it('runs up stairs too', () => {
    at(LANE.s20);
    expect(run(north(TUNING.run), 3).feet[1]).toBeCloseTo(1.0, 1);
  });
  it('cannot walk up 0.35 m steps, but can jump them', () => {
    at(LANE.s35);
    expect(run(north(), 3).feet[1]).toBeLessThan(0.1);
    for (let i = 0; i < 6; i++) { run(north(TUNING.walk, { jump: true }), 1 / 60); run(north(), 0.6); }
    expect(m.feet[1]).toBeGreaterThan(0.6);
  });
  it('climbs a 30° ramp but not a 55° one', () => {
    at(LANE.r30);
    expect(run(north(), 4).feet[1]).toBeGreaterThan(1.6);
    at(LANE.r55);
    expect(run(north(), 4).feet[1]).toBeLessThan(0.6);
  });
  it('a low beam blocks standing, crouching passes, and you cannot stand up under it', () => {
    at(LANE.beam);
    expect(run(north(), 2).feet[2]).toBeGreaterThan(-2);
    at(LANE.beam);
    run(north(TUNING.crouch, { crouch: true }), 2.0);
    const under = run(IDLE, 0.3);
    expect(under.feet[2]).toBeLessThan(-2.5);
    expect(under.crouched).toBe(true); // let go of crouch under the beam: still crouched
    expect(run(north(), 3).feet[2]).toBeLessThan(-5.5);
    expect(run(IDLE, 0.3).crouched).toBe(false);
    expect(m.floorTag).toBe('terrain');
  });
  it('slides along a wall instead of passing it', () => {
    at(LANE.wall);
    const yawed = { wish: wishVelocity({ fwd: 1, str: 0, run: false, crouch: false, jump: false }, 0.3, TUNING.walk), jump: false, crouch: false };
    const s = run(yawed, 2);
    expect(s.feet[2]).toBeGreaterThan(-2.65);
    expect(s.feet[0]).toBeLessThan(LANE.wall - 1);
  });
  it('goes down a stair through a terrain hole and walks a tunnel under the terrain sheet', () => {
    at(LANE.tunnel);
    const s = run(north(), 6);
    expect(s.feet[1]).toBeCloseTo(-3, 1);
    expect(s.feet[2]).toBeLessThan(-14);
  });
  it('the boundary blocks at the surface but not underground', () => {
    at(LANE.boundary);
    expect(run(north(), 2.5).feet[2]).toBeGreaterThan(-4);
    at(LANE.boundary, -3, -2);
    expect(run(north(), 2.5).feet[2]).toBeLessThan(-6);
  });
  it('jumps ~0.9 m, lands with an impact and a footfall, hits ceilings', () => {
    at(-5, 0, 5);
    run(IDLE, 0.2);
    let top = 0, landed = 0;
    const falls: Footfall[] = [];
    m.onFootfall = (f) => falls.push(f);
    run((i) => { top = Math.max(top, m.feet[1]); landed = Math.max(landed, m.landed); return { ...IDLE, jump: i === 0 }; }, 1.2);
    m.onFootfall = null;
    expect(top).toBeGreaterThan(0.8); expect(top).toBeLessThan(1.0);
    expect(landed).toBeGreaterThan(2.5);
    expect(falls.length).toBe(1);
    // under the beam a jump stops at the ceiling
    at(LANE.beam, 0, -3.5);
    run({ ...IDLE, crouch: true }, 0.2);
    let peak = 0;
    run((i) => { peak = Math.max(peak, m.feet[1]); return { ...IDLE, crouch: true, jump: i === 0 }; }, 0.8);
    expect(peak).toBeLessThan(0.25);
  });
  it('two characters in one world collide with each other', () => {
    const a = new CharacterMotor(P.createCharacter(shapeFrom()));
    const b = new CharacterMotor(P.createCharacter(shapeFrom()));
    a.teleport([-6, 0, 8]); b.teleport([-6, 0, 2]);
    for (let i = 0; i < 180; i++) {
      a.update({ wish: [0, -TUNING.walk], jump: false, crouch: false }, 1 / 60);
      b.update({ wish: [0, TUNING.walk], jump: false, crouch: false }, 1 / 60);
      P.world.step();
    }
    const gap = Math.hypot(a.feet[0] - b.feet[0], a.feet[2] - b.feet[2]);
    expect(gap).toBeGreaterThan(2 * TUNING.radius - 0.02);
    expect(P.stats().characters).toBe(3);
    a.body.remove(); a.body.remove(); b.body.remove();
    expect(P.stats().characters).toBe(1);
  });
});

/** A typed fake body: flat floor at y = 0 and a tall wall at z = −5. */
class FakeBody implements CharacterBody {
  id = 1; private p: [number, number, number] = [0, 0, 0]; height = TUNING.height; fitsAnswer = true;
  feet(): [number, number, number] { return [...this.p]; }
  move(d: [number, number, number]): MoveResult {
    const hits: MoveResult['hits'] = [];
    const old = this.feet();
    const x = old[0] + d[0];
    let y = old[1] + d[1], z = old[2] + d[2];
    if (z < -4.7) { z = -4.7; hits.push({ normal: [0, 0, 1], point: [x, old[1] + 1, -5] }); }
    if (y < 0) { y = 0; hits.push({ normal: [0, 1, 0], point: [x, 0, z], tag: 'fake' }); }
    this.p = [x, y, z];
    return { move: [x - old[0], y - old[1], z - old[2]], grounded: y <= 1e-6, hits };
  }
  teleport(p: [number, number, number]) { this.p = [...p]; }
  setHeight(h: number) { this.height = h; }
  fits() { return this.fitsAnswer; }
  remove() {}
}

describe('CharacterMotor with a fake body', () => {
  it('clips velocity against tall walls, keeps the floor tag, and respects head room', () => {
    const body = new FakeBody();
    const mm = new CharacterMotor(body);
    for (let i = 0; i < 120; i++) mm.update({ wish: [1, -3], jump: false, crouch: false }, 1 / 60);
    expect(mm.vel[1]).toBeGreaterThan(-0.5); // the wall ate the velocity into it
    expect(mm.floorTag).toBe('fake');
    mm.update({ ...IDLE, crouch: true }, 1 / 60);
    expect(body.height).toBe(TUNING.crouchHeight);
    expect(mm.height).toBe(TUNING.crouchHeight);
    body.fitsAnswer = false;
    mm.update(IDLE, 1 / 60);
    expect(mm.crouched).toBe(true);
    body.fitsAnswer = true;
    mm.update(IDLE, 1 / 60);
    expect(mm.crouched).toBe(false);
    expect(body.height).toBe(TUNING.height);
    expect(mm.height).toBe(TUNING.height);
  });
});

/** A fake body over a floor rising 0.5 m per metre northward (−z) from z = 0, flat before it; it can probe. */
class RampBody implements CharacterBody {
  id = 2; p: [number, number, number] = [0, 0, 0]; moves: [number, number, number][] = []; wall = false;
  floor(z: number) { return Math.max(0, -z * 0.5); }
  feet(): [number, number, number] { return [...this.p]; }
  move(d: [number, number, number]): MoveResult {
    this.moves.push([...d]);
    const x = this.p[0] + d[0], z = this.p[2] + d[2], f = this.floor(z);
    const y = Math.max(f, this.p[1] + d[1]);
    const old = this.p;
    this.p = [x, y, z];
    const hits: MoveResult['hits'] = this.wall ? [{ normal: [1, 0, 0], point: [x - 0.3, y + 0.1, z] }] : [];
    return { move: [x - old[0], y - old[1], z - old[2]], grounded: y - f < 1e-3, hits };
  }
  probe(x: number, z: number) { const n = Math.hypot(0.5, 1); return { y: this.floor(z), normal: (z < 0 ? [0, 1 / n, 0.5 / n] : [0, 1, 0]) as [number, number, number], tag: z < 0 ? 'ramp' : 'flat' }; }
  teleport(p: [number, number, number]) { this.p = [...p]; }
  setHeight() {}
  fits() { return true; }
  remove() {}
}

describe('CharacterMotor along a probed floor', () => {
  it('rises with the floor ahead at full horizontal speed, and presses down only against steep contacts', () => {
    expect(riseAlong([0, -2], [0, 1, 0])).toBeCloseTo(0);
    const n = Math.hypot(0.5, 1);
    expect(riseAlong([0, -2], [0, 1 / n, 0.5 / n])).toBeCloseTo(1); // 2 m/s up a 1:2 slope rises 1 m/s
    expect(riseAlong([0, 2], [0, 1 / n, 0.5 / n])).toBeCloseTo(-1);
    const body = new RampBody(), mm = new CharacterMotor(body);
    mm.teleport([0, 0, 1]);
    for (let i = 0; i < 90; i++) mm.update({ wish: [0, -TUNING.walk], jump: false, crouch: false }, 1 / 60);
    expect(mm.grounded).toBe(true);
    expect(mm.speed).toBeCloseTo(TUNING.walk, 1); // horizontal speed kept on the slope
    expect(mm.feet[1]).toBeCloseTo(body.floor(mm.feet[2]), 2);
    expect(mm.floorTag).toBe('ramp');
    const last = body.moves[body.moves.length - 1];
    expect(last[1]).toBeCloseTo((TUNING.walk / 2) / 60, 4); // in the plane, no press
    body.wall = true;
    mm.update({ wish: [0, -TUNING.walk], jump: false, crouch: false }, 1 / 60);
    mm.update({ wish: [0, -TUNING.walk], jump: false, crouch: false }, 1 / 60);
    expect(body.moves[body.moves.length - 1][1]).toBeLessThan((TUNING.walk / 2) / 60 - 0.01); // pressed: touching a wall
    // going down: the floor under the axis
    body.wall = false;
    for (let i = 0; i < 30; i++) mm.update({ wish: [0, TUNING.walk], jump: false, crouch: false }, 1 / 60);
    expect(body.moves[body.moves.length - 1][1]).toBeLessThan(0);
    // standing still: no lookahead, no rise
    for (let i = 0; i < 30; i++) mm.update(IDLE, 1 / 60);
    expect(body.moves[body.moves.length - 1][1]).toBeCloseTo(0, 6);
  });
});
