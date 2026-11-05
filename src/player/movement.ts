// Pure movement maths for the first-person player (game-feel / input-systems): input → wish velocity,
// acceleration and friction, jump buffering and coyote time, crouch rules, head bob and step
// smoothing. No three.js or Rapier here, so tests/player.test.ts can pin the feel down.

export const TUNING = {
  walk: 3.0, run: 6.0, crouch: 1.5, backFactor: 0.8,
  groundAccel: 26, groundFriction: 30,   // m/s²: 0 → walk in ~0.12 s, run → stop in ~0.2 s
  airAccel: 5, airDrag: 0.15,            // limited air control
  gravity: 18, jumpHeight: 0.9, maxFall: 40,
  coyote: 0.1, jumpBuffer: 0.12,
  radius: 0.3, height: 1.75, crouchHeight: 1.1, eye: 1.62, crouchEye: 0.98,
  autostep: 0.31, autostepMinWidth: 0.12, snap: 0.4, maxSlopeDeg: 50, skin: 0.02,
  strideWalk: 1.45, strideRun: 2.1, strideCrouch: 0.85,
  bobWalk: 0.032, bobRun: 0.055, swayWalk: 0.018, swayRun: 0.028,
  fov: 70, fovRunKick: 6,
  stepSmooth: 14,                        // 1/s: how fast the camera catches up after a step
  // camera vs walls: the eye stays on the capsule axis (sway ≤ skin) and below the capsule top, and the
  // near plane is small enough that its corners stay well inside the capsule (nearCorner < radius)
  near: 0.06, headroom: 0.1,
};
export type Tuning = typeof TUNING;

export interface MoveInput { fwd: number; str: number; run: boolean; crouch: boolean; jump: boolean }

/** Distance from the eye to a corner of the near plane (how far the view frustum reaches out sideways). */
export const nearCorner = (near: number, fovDeg: number, aspect: number) => {
  const h = near * Math.tan((fovDeg * Math.PI) / 360);
  return Math.hypot(near, h, h * aspect);
};

/** Eye height above the feet, kept inside the capsule (never above its top less `headroom`). */
export const eyeClamp = (eye: number, capsuleHeight: number, t: Tuning = TUNING) => Math.min(Math.max(eye, t.radius), capsuleHeight - t.headroom);

export const jumpSpeed = (t: Tuning = TUNING) => Math.sqrt(2 * t.gravity * t.jumpHeight);

/** Target speed for the current input and stance (m/s). Running only counts when moving forward. */
export function targetSpeed(inp: MoveInput, crouched: boolean, t: Tuning = TUNING) {
  if (!inp.fwd && !inp.str) return 0;
  if (crouched) return t.crouch;
  const back = inp.fwd < 0 && Math.abs(inp.str) < 0.5;
  if (inp.run && inp.fwd > 0) return t.run;
  return back ? t.walk * t.backFactor : t.walk;
}

/** World-space horizontal wish velocity. yaw = 0 looks north (−z), as the camera rig does. */
export function wishVelocity(inp: MoveInput, yaw: number, speed: number): [number, number] {
  const f: [number, number] = [-Math.sin(yaw), -Math.cos(yaw)], r: [number, number] = [Math.cos(yaw), -Math.sin(yaw)];
  let x = f[0] * inp.fwd + r[0] * inp.str, z = f[1] * inp.fwd + r[1] * inp.str;
  const l = Math.hypot(x, z);
  if (l < 1e-6) return [0, 0];
  x /= l; z /= l;
  return [x * speed, z * speed];
}

/**
 * Move horizontal velocity toward the wish velocity. On the ground: accelerate toward it, or brake with
 * friction when there is no input (never overshoot). In the air: small steering only, a little drag.
 */
export function accelerate(v: [number, number], wish: [number, number], grounded: boolean, dt: number, t: Tuning = TUNING): [number, number] {
  const hasInput = wish[0] !== 0 || wish[1] !== 0;
  if (grounded) {
    const rate = (hasInput ? t.groundAccel : t.groundFriction) * dt;
    const dx = wish[0] - v[0], dz = wish[1] - v[1], d = Math.hypot(dx, dz);
    if (d <= rate) return [wish[0], wish[1]];
    return [v[0] + (dx / d) * rate, v[1] + (dz / d) * rate];
  }
  let x = v[0] * (1 - t.airDrag * dt), z = v[1] * (1 - t.airDrag * dt);
  if (hasInput) {
    // steer toward the wish direction, but never add speed beyond the wish speed
    const ws = Math.hypot(wish[0], wish[1]);
    const nx = x + (wish[0] / ws) * t.airAccel * dt, nz = z + (wish[1] / ws) * t.airAccel * dt;
    const cur = Math.hypot(x, z), nl = Math.hypot(nx, nz), cap = Math.max(cur, ws);
    const k = nl > cap ? cap / nl : 1;
    x = nx * k; z = nz * k;
  }
  return [x, z];
}

/** Remove the part of the velocity that drives into a wall (normal points out of the wall). */
export function clipVelocity(v: [number, number], n: [number, number]): [number, number] {
  const d = v[0] * n[0] + v[1] * n[1];
  return d < 0 ? [v[0] - n[0] * d, v[1] - n[1] * d] : v;
}

/** Jump timers: buffered presses and coyote time. Returns the new timers and whether to jump now. */
export function jumpLogic(s: { coyote: number; buffer: number }, pressed: boolean, grounded: boolean, canJump: boolean, dt: number, t: Tuning = TUNING) {
  let coyote = grounded ? t.coyote : Math.max(0, s.coyote - dt);
  let buffer = pressed ? t.jumpBuffer : Math.max(0, s.buffer - dt);
  const jump = buffer > 0 && coyote > 0 && canJump;
  if (jump) { coyote = 0; buffer = 0; }
  return { coyote, buffer, jump };
}

/** Crouch stance: hold to crouch; standing up needs head room. */
export function nextCrouch(crouched: boolean, wantCrouch: boolean, canStand: boolean) {
  if (wantCrouch) return true;
  return crouched && !canStand;
}

/** Capsule half-height for a total height (Rapier capsule: half segment + radius each end). */
export const capsuleHalf = (height: number, t: Tuning = TUNING) => Math.max(0.05, height / 2 - t.radius);

/** Stride length for footstep cadence and bob. */
export const stride = (running: boolean, crouched: boolean, t: Tuning = TUNING) => (crouched ? t.strideCrouch : running ? t.strideRun : t.strideWalk);

/** Head bob offsets [up, side] for a phase measured in steps (one step = 1.0). */
export function headBob(phase: number, weight: number, runMix: number, t: Tuning = TUNING): [number, number] {
  const amp = t.bobWalk + (t.bobRun - t.bobWalk) * runMix, sway = t.swayWalk + (t.swayRun - t.swayWalk) * runMix;
  // lowest at each foot strike (whole phases), highest mid-stride; sway once per two steps
  const up = -amp * 0.5 * (1 + Math.cos(phase * 2 * Math.PI));
  return [up * weight, sway * Math.sin(phase * Math.PI) * weight];
}

/**
 * Is a vertical move a stair step rather than a slope? Steps lift the feet more than the steepest
 * walkable slope could over the horizontal distance covered in the tick.
 */
export function isStep(dy: number, dh: number, t: Tuning = TUNING) {
  return Math.abs(dy) > 0.025 && Math.abs(dy) > dh * Math.tan((t.maxSlopeDeg * Math.PI) / 180) * 1.15 + 0.01;
}

/** Exponential approach, frame-rate independent. */
export const damp = (a: number, b: number, rate: number, dt: number) => b + (a - b) * Math.exp(-rate * dt);
