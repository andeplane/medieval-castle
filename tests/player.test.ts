// Player feel and physics: pure movement maths, plus the real Rapier KCC in Node (rapier3d-compat
// embeds its wasm) against a small synthetic course: stairs, slopes, a low beam, a wall, the boundary
// ribbon and a tunnel under an open terrain sheet.
import { describe, it, expect, beforeAll } from 'vitest';
import {
  TUNING, targetSpeed, wishVelocity, accelerate, clipVelocity, jumpLogic, nextCrouch, capsuleHalf, headBob, isStep, jumpSpeed,
  type MoveInput,
} from '../src/player/movement';
import { weld, gridSoup, ribbon } from '../src/physics/mesh';
import { boundaryOutline } from '../src/physics/boundary';
import { pointInPoly, type V2 } from '../src/core/math2d';
import { createPhysics, type Physics } from '../src/physics/world';
import { PlayerController } from '../src/player/controller';
import { Input } from '../src/player/input';

const I = (p: Partial<MoveInput> = {}): MoveInput => ({ fwd: 0, str: 0, run: false, crouch: false, jump: false, ...p });

describe('movement maths', () => {
  it('maps input to speed: walk, run forward only, crouch, back-pedal', () => {
    expect(targetSpeed(I(), false)).toBe(0);
    expect(targetSpeed(I({ fwd: 1 }), false)).toBe(TUNING.walk);
    expect(targetSpeed(I({ fwd: 1, run: true }), false)).toBe(TUNING.run);
    expect(targetSpeed(I({ fwd: -1, run: true }), false)).toBeLessThan(TUNING.walk);
    expect(targetSpeed(I({ fwd: 1, run: true }), true)).toBe(TUNING.crouch);
  });
  it('wish velocity follows the yaw convention (yaw 0 = north, −z) and normalises diagonals', () => {
    const [x, z] = wishVelocity(I({ fwd: 1 }), 0, 3);
    expect(x).toBeCloseTo(0); expect(z).toBeCloseTo(-3);
    const [x2, z2] = wishVelocity(I({ fwd: 1, str: 1 }), 0, 3);
    expect(Math.hypot(x2, z2)).toBeCloseTo(3); expect(x2).toBeGreaterThan(0);
    const [x3] = wishVelocity(I({ fwd: 1 }), Math.PI / 2, 3);
    expect(x3).toBeCloseTo(-3); // yaw +90° looks west
  });
  it('accelerates over ~0.1–0.25 s on the ground and brakes without overshoot', () => {
    let v: [number, number] = [0, 0], t = 0;
    while (Math.hypot(...v) < TUNING.walk - 1e-6) { v = accelerate(v, [0, -TUNING.walk], true, 1 / 60); t += 1 / 60; }
    expect(t).toBeGreaterThan(0.06); expect(t).toBeLessThan(0.25);
    v = [0, -TUNING.run]; t = 0;
    while (Math.hypot(...v) > 0) { v = accelerate(v, [0, 0], true, 1 / 60); t += 1 / 60; expect(v[1]).toBeLessThanOrEqual(0); }
    expect(t).toBeGreaterThan(0.1); expect(t).toBeLessThan(0.4);
  });
  it('limits air control: half a second of steering changes velocity far less than on the ground', () => {
    let v: [number, number] = [0, -TUNING.run];
    for (let i = 0; i < 30; i++) v = accelerate(v, [TUNING.walk, 0], false, 1 / 60);
    expect(v[0]).toBeLessThan(3); expect(Math.hypot(...v)).toBeLessThanOrEqual(TUNING.run + 1e-6);
  });
  it('clips velocity into walls only', () => {
    expect(clipVelocity([1, -2], [0, 1])).toEqual([1, 0]);
    expect(clipVelocity([1, 2], [0, 1])).toEqual([1, 2]);
  });
  it('jump: buffered presses and coyote time', () => {
    let s = { coyote: 0, buffer: 0 };
    let j = jumpLogic(s, true, false, true, 1 / 60); // pressed in the air, just before landing
    expect(j.jump).toBe(false);
    s = j; j = jumpLogic(s, false, true, true, 1 / 60);   // lands within the buffer → jumps
    expect(j.jump).toBe(true);
    s = jumpLogic({ coyote: 0, buffer: 0 }, false, true, true, 1 / 60); // walk off a ledge
    s = jumpLogic(s, false, false, true, 0.05);
    expect(jumpLogic(s, true, false, true, 1 / 60).jump).toBe(true);
    s = jumpLogic(s, false, false, true, 0.2);
    expect(jumpLogic(s, true, false, true, 1 / 60).jump).toBe(false);
    expect(jumpSpeed() ** 2 / (2 * TUNING.gravity)).toBeCloseTo(TUNING.jumpHeight);
  });
  it('crouch: hold to crouch, cannot stand under a low ceiling', () => {
    expect(nextCrouch(false, true, true)).toBe(true);
    expect(nextCrouch(true, false, true)).toBe(false);
    expect(nextCrouch(true, false, false)).toBe(true);
    expect(2 * (capsuleHalf(TUNING.crouchHeight) + TUNING.radius)).toBeCloseTo(TUNING.crouchHeight);
    expect(2 * (capsuleHalf(TUNING.height) + TUNING.radius)).toBeCloseTo(TUNING.height);
  });
  it('head bob: lowest at foot strikes, larger when running; steps vs slopes', () => {
    expect(headBob(3, 1, 0)[0]).toBeCloseTo(-TUNING.bobWalk);
    expect(headBob(3.5, 1, 0)[0]).toBeCloseTo(0);
    expect(Math.abs(headBob(3, 1, 1)[0])).toBeGreaterThan(Math.abs(headBob(3, 1, 0)[0]));
    expect(isStep(0.2, 0.05)).toBe(true);           // stair riser in one tick
    expect(isStep(0.03, 0.05)).toBe(false);         // 30° ramp at walking speed
  });
});

describe('collider helpers', () => {
  it('welds a triangle soup and drops degenerate triangles', () => {
    const quad = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0]);
    const s = weld(quad, null);
    expect(s.vertices.length / 3).toBe(4);
    expect(s.indices.length / 3).toBe(2);
  });
  it('lays out a terrain grid with holes', () => {
    const nx = 5, nz = 4, heights = new Float32Array(nx * nz).map((_, i) => i);
    const g = gridSoup({ heights, nx, nz, dx: 1, dz: 1, ox: 0, oz: 0 }, { x0: 0, x1: 4, z0: 0, z1: 3 }, (x, z) => x < 1 && z < 1);
    expect(g.indices.length / 3).toBe(4 * 3 * 2 - 2);
    expect(g.vertices[(2 * 5 + 3) * 3 + 1]).toBe(2 * 5 + 3); // row-major, X fastest
  });
  it('boundary detours along the bridge to the broken span', () => {
    const island: V2[] = Array.from({ length: 64 }, (_, i) => [Math.cos((i / 64) * Math.PI * 2) * 40, Math.sin((i / 64) * Math.PI * 2) * 30] as V2);
    const b = boundaryOutline(island, { start: [0, 28], dir: [0, 1], width: 4, breakAt: 10 });
    expect(pointInPoly(b, 0, 35)).toBe(true);   // on the bridge
    expect(pointInPoly(b, 0, 39)).toBe(false);  // past the break
    expect(pointInPoly(b, 5, 32)).toBe(false);  // beside the bridge, over the moat
    expect(pointInPoly(b, 0, 0)).toBe(true);
    expect(ribbon(b, 0, 1).indices.length / 3).toBe(b.length * 2);
  });
});

// ---- Rapier in Node: a synthetic course on a flat floor at y = 0
class FakeTarget { private l = new Map<string, ((e: unknown) => void)[]>(); addEventListener(t: string, f: (e: unknown) => void) { (this.l.get(t) ?? this.l.set(t, []).get(t)!).push(f); } }

describe('player on Rapier', () => {
  let P: Physics, pl: PlayerController, input: Input;
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
    const v = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]].flat();
    const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
    P.world.createCollider(P.R.ColliderDesc.trimesh(new Float32Array(v), new Uint32Array(f)));
  };
  const walk = (keys: string[], seconds: number) => {
    for (const k of keys) input.press(k);
    input.virtual = new Set(keys);
    let grounded = 0;
    const n = Math.round(seconds * 60);
    for (let i = 0; i < n; i++) { P.tick(); if (pl.grounded) grounded++; }
    input.virtual = new Set();
    return { ...pl.state(), groundedFrac: grounded / n };
  };
  // lanes along −z, one per x
  const LANE = { s15: 0, s20: 3, s30: 6, s35: 9, r30: 12, r55: 15, beam: 18, wall: 33, tunnel: 24, boundary: 27 };
  const stairs = (x: number, rise: number, run: number, n: number) => { for (let k = 1; k <= n; k++) box(x - 1, x + 1, 0, rise * k, -20, -k * run + run - 2); };
  const ramp = (x: number, deg: number) => {
    const L = 3, h = L * Math.tan((deg * Math.PI) / 180);
    const v = [x - 1, 0, -2, x + 1, 0, -2, x + 1, h, -2 - L, x - 1, h, -2 - L, x - 1, h, -20, x + 1, h, -20];
    P.world.createCollider(P.R.ColliderDesc.trimesh(new Float32Array(v), new Uint32Array([0, 1, 2, 0, 2, 3, 3, 2, 5, 3, 5, 4])));
    return h;
  };

  beforeAll(async () => {
    P = await createPhysics();
    // floor everywhere except over the tunnel lane's stairwell; the tunnel floor is at y = −3
    const floor = new Float32Array(51 * 41).fill(0);
    P.addTerrain({ heights: floor, nx: 51, nz: 41, dx: 1, dz: 1, ox: -10, oz: -30 }, { x0: -10, x1: 40, z0: -30, z1: 10 }, (x, z) => Math.abs(x - LANE.tunnel) < 1.2 && z < -2 && z > -9.5);
    stairs(LANE.s15, 0.15, 0.3, 6); stairs(LANE.s20, 0.2, 0.3, 5); stairs(LANE.s30, 0.3, 0.4, 3); stairs(LANE.s35, 0.35, 0.4, 3);
    ramp(LANE.r30, 30); ramp(LANE.r55, 55);
    box(LANE.beam - 1, LANE.beam + 1, 1.3, 1.6, -5, -2);
    box(LANE.wall - 4, LANE.wall + 4, 0, 3, -3, -2.6);
    // tunnel lane: 15 steps of 0.2 down from z = −2, then a flat tunnel floor at −3 running under the floor sheet
    for (let k = 1; k <= 15; k++) box(LANE.tunnel - 1, LANE.tunnel + 1, -0.2 * k - 0.3, -0.2 * k, -2 - k * 0.3, -2 - (k - 1) * 0.3);
    box(LANE.tunnel - 1, LANE.tunnel + 1, -3.3, -3, -20, -6.5);
    // boundary ribbon across the boundary lane at z = −4, from y = −1 (surface − 1) up; a pit under it
    P.addBoundary([[LANE.boundary - 2, -4], [LANE.boundary + 2, -4]], -1, 40);
    input = new Input(new FakeTarget() as unknown as Window);
    pl = new PlayerController(P, input);
    pl.active = true;
  });

  const at = (x: number, y = 0, z = 0) => pl.teleport(x, y, z, 0, 0);

  it('walks flat ground at walk and run speed, staying grounded', () => {
    at(-5, 0, 0);
    const w = walk(['KeyW'], 1.5);
    expect(w.speed).toBeCloseTo(TUNING.walk, 1);
    expect(w.groundedFrac).toBeGreaterThan(0.95);
    at(-5, 0, 0);
    const r = walk(['KeyW', 'ShiftLeft'], 1.5);
    expect(r.speed).toBeCloseTo(TUNING.run, 1);
  });
  it.each([['0.15', LANE.s15, 0.9], ['0.20', LANE.s20, 1.0], ['0.30', LANE.s30, 0.9]])('climbs %s m stairs', (_n, x, top) => {
    at(x);
    const s = walk(['KeyW'], 4);
    expect(s.y).toBeCloseTo(top, 1);
  });
  it('cannot walk up 0.35 m steps, but can jump them', () => {
    at(LANE.s35);
    expect(walk(['KeyW'], 3).y).toBeLessThan(0.1);
    let y = 0;
    for (let i = 0; i < 6; i++) { walk(['KeyW', 'Space'], 0.1); y = walk(['KeyW'], 0.6).y; }
    expect(y).toBeGreaterThan(0.6);
  });
  it('climbs a 30° ramp but not a 55° one', () => {
    at(LANE.r30);
    expect(walk(['KeyW'], 4).y).toBeGreaterThan(1.6);
    at(LANE.r55);
    expect(walk(['KeyW'], 4).y).toBeLessThan(0.6);
  });
  it('a low beam blocks standing, crouching passes, and you cannot stand up under it', () => {
    at(LANE.beam);
    expect(walk(['KeyW'], 2).z).toBeGreaterThan(-2);
    at(LANE.beam);
    walk(['KeyW', 'KeyC'], 2.0);
    const under = walk([], 0.3);
    expect(under.z).toBeLessThan(-2.5);
    expect(under.crouched).toBe(true); // released C under the beam: still crouched
    const out = walk(['KeyW'], 3);
    expect(out.z).toBeLessThan(-5.5);
    expect(walk([], 0.3).crouched).toBe(false);
  });
  it('slides along a wall instead of passing it', () => {
    at(LANE.wall);
    pl.yaw = 0.3;
    const s = walk(['KeyW'], 2);
    expect(s.z).toBeGreaterThan(-2.65);
    expect(s.x).toBeLessThan(LANE.wall - 1); // slid sideways
  });
  it('goes down a stair through a terrain hole and walks a tunnel under the terrain sheet', () => {
    at(LANE.tunnel);
    const s = walk(['KeyW'], 6);
    expect(s.y).toBeCloseTo(-3, 1);
    expect(s.z).toBeLessThan(-14);
  });
  it('the boundary blocks at the surface but not underground', () => {
    at(LANE.boundary);
    expect(walk(['KeyW'], 2.5).z).toBeGreaterThan(-4);
    box(LANE.boundary - 1, LANE.boundary + 1, -3.3, -3, -12, -1); // a floor at −3 (no terrain above it here is fine)
    at(LANE.boundary, -3, -2);
    expect(walk(['KeyW'], 2.5).z).toBeLessThan(-6);
  });
  it('raycasts hit the world but not the boundary', () => {
    const h = P.raycast([LANE.s15, 5, -10], [0, -1, 0], 10);
    expect(h?.point[1]).toBeCloseTo(0.9, 2);
    expect(P.raycast([LANE.boundary, 1, 0], [0, 0, -1], 10)?.dist ?? 99).toBeGreaterThan(5);
  });
});
