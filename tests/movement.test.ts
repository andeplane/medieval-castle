// Pure movement maths: the feel numbers (speeds, acceleration, air control, jump, crouch, bob).
import { describe, it, expect } from 'vitest';
import {
  TUNING, targetSpeed, wishVelocity, accelerate, clipVelocity, jumpLogic, nextCrouch, capsuleHalf, headBob, isStep, jumpSpeed, stride, damp,
  type MoveInput,
} from '../src/player/movement';

const I = (p: Partial<MoveInput> = {}): MoveInput => ({ fwd: 0, str: 0, run: false, crouch: false, jump: false, ...p });

describe('movement maths', () => {
  it('maps input to speed: walk, run forward only, crouch, back-pedal, strafe', () => {
    expect(targetSpeed(I(), false)).toBe(0);
    expect(targetSpeed(I({ fwd: 1 }), false)).toBe(TUNING.walk);
    expect(targetSpeed(I({ fwd: 1, run: true }), false)).toBe(TUNING.run);
    expect(targetSpeed(I({ fwd: -1, run: true }), false)).toBeLessThan(TUNING.walk);
    expect(targetSpeed(I({ str: 1, run: true }), false)).toBe(TUNING.walk);
    expect(targetSpeed(I({ fwd: -1, str: 1 }), false)).toBe(TUNING.walk);
    expect(targetSpeed(I({ fwd: 1, run: true }), true)).toBe(TUNING.crouch);
  });
  it('wish velocity follows the yaw convention (yaw 0 = north, −z) and normalises diagonals', () => {
    const [x, z] = wishVelocity(I({ fwd: 1 }), 0, 3);
    expect(x).toBeCloseTo(0); expect(z).toBeCloseTo(-3);
    const [x2, z2] = wishVelocity(I({ fwd: 1, str: 1 }), 0, 3);
    expect(Math.hypot(x2, z2)).toBeCloseTo(3); expect(x2).toBeGreaterThan(0);
    expect(wishVelocity(I({ fwd: 1 }), Math.PI / 2, 3)[0]).toBeCloseTo(-3); // yaw +90° looks west
    expect(wishVelocity(I(), 0, 3)).toEqual([0, 0]);
  });
  it('accelerates over ~0.1–0.25 s on the ground and brakes without overshoot', () => {
    let v: [number, number] = [0, 0], t = 0;
    while (Math.hypot(...v) < TUNING.walk - 1e-6) { v = accelerate(v, [0, -TUNING.walk], true, 1 / 60); t += 1 / 60; }
    expect(t).toBeGreaterThan(0.06); expect(t).toBeLessThan(0.25);
    v = [0, -TUNING.run]; t = 0;
    while (Math.hypot(...v) > 0) { v = accelerate(v, [0, 0], true, 1 / 60); t += 1 / 60; expect(v[1]).toBeLessThanOrEqual(0); }
    expect(t).toBeGreaterThan(0.1); expect(t).toBeLessThan(0.4);
  });
  it('limits air control and never adds speed beyond the wish in the air', () => {
    let v: [number, number] = [0, -TUNING.run];
    for (let i = 0; i < 30; i++) v = accelerate(v, [TUNING.walk, 0], false, 1 / 60);
    expect(v[0]).toBeLessThan(3); expect(Math.hypot(...v)).toBeLessThanOrEqual(TUNING.run + 1e-6);
    let w: [number, number] = [0, 0];
    for (let i = 0; i < 300; i++) w = accelerate(w, [0, -1], false, 1 / 60);
    expect(Math.hypot(...w)).toBeLessThanOrEqual(1 + 1e-6);
    const drift = accelerate([2, 0], [0, 0], false, 1 / 60);
    expect(drift[0]).toBeLessThan(2); expect(drift[0]).toBeGreaterThan(1.9);
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
    expect(jumpLogic({ coyote: 0, buffer: 0 }, true, true, false, 1 / 60).jump).toBe(false);
    expect(jumpSpeed() ** 2 / (2 * TUNING.gravity)).toBeCloseTo(TUNING.jumpHeight);
  });
  it('crouch: hold to crouch, cannot stand under a low ceiling; capsule heights add up', () => {
    expect(nextCrouch(false, true, true)).toBe(true);
    expect(nextCrouch(true, false, true)).toBe(false);
    expect(nextCrouch(true, false, false)).toBe(true);
    expect(nextCrouch(false, false, false)).toBe(false);
    expect(2 * (capsuleHalf(TUNING.crouchHeight) + TUNING.radius)).toBeCloseTo(TUNING.crouchHeight);
    expect(2 * (capsuleHalf(TUNING.height) + TUNING.radius)).toBeCloseTo(TUNING.height);
  });
  it('gait: strides, head bob lowest at foot strikes and larger when running; steps vs slopes', () => {
    expect(stride(false, false)).toBe(TUNING.strideWalk);
    expect(stride(true, false)).toBe(TUNING.strideRun);
    expect(stride(true, true)).toBe(TUNING.strideCrouch);
    expect(headBob(3, 1, 0)[0]).toBeCloseTo(-TUNING.bobWalk);
    expect(headBob(3.5, 1, 0)[0]).toBeCloseTo(0);
    expect(Math.abs(headBob(3, 1, 1)[0])).toBeGreaterThan(Math.abs(headBob(3, 1, 0)[0]));
    expect(headBob(3, 0, 1)[0]).toBeCloseTo(0);
    expect(isStep(0.2, 0.05)).toBe(true);    // stair riser in one tick
    expect(isStep(-0.3, 0.05)).toBe(true);   // snapped down a step
    expect(isStep(0.03, 0.05)).toBe(false);  // 30° ramp at walking speed
    expect(damp(1, 0, 10, 0.1)).toBeCloseTo(Math.exp(-1));
  });
});
