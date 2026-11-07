// CharacterMotor: walking physics shared by the player and future NPCs. It takes an intent (a wish
// velocity plus jump and crouch) every fixed tick and drives a CharacterBody: acceleration and friction,
// limited air control, gravity, buffered jumps with coyote time, crouch with head-room checks, wall
// sliding, and gait events (footfalls, landings, stair steps) for audio and cameras.
import type { V3 } from '../castle/interior/types';
import type { CharacterBody, CharacterShape } from './types';
import { TUNING, type Tuning, accelerate, clipVelocity, jumpLogic, nextCrouch, stride, isStep, jumpSpeed } from '../player/movement';

export interface MotorIntent {
  /** Desired horizontal velocity, world space (m/s). */
  wish: [number, number];
  /** True on the tick a jump is requested (buffered for a short while). */
  jump: boolean;
  /** Held while the character wants to crouch. */
  crouch: boolean;
}
export const IDLE: MotorIntent = { wish: [0, 0], jump: false, crouch: false };

export interface Footfall { tag?: string; running: boolean; strength: number; feet: V3 }

export const shapeFrom = (t: Tuning = TUNING): CharacterShape => ({
  radius: t.radius, height: t.height, skin: t.skin, autostep: t.autostep, autostepMinWidth: t.autostepMinWidth, snap: t.snap, maxSlopeDeg: t.maxSlopeDeg,
});

/** How far above and below the feet a grounded character looks for the floor ahead (m). */
const PROBE_UP = 0.4, PROBE_DOWN = 0.4;
/** How far ahead of the capsule's axis the floor is probed (m): about where its round bottom meets a slope. */
const LOOKAHEAD = 0.1;

/**
 * The rise (m/s) that keeps a horizontal velocity on a floor of normal n: 0 on flat ground, up or
 * down the plane on a slope or a stair's walking ramp.
 */
export const riseAlong = (vel: [number, number], n: V3) => -(vel[0] * n[0] + vel[1] * n[2]) / n[1];

export class CharacterMotor {
  feet: V3 = [0, 0, 0];
  prevFeet: V3 = [0, 0, 0];
  vel: [number, number] = [0, 0];
  vy = 0;
  grounded = false;
  crouched = false;
  /** Horizontal speed actually moved last tick (m/s). */
  speed = 0;
  running = false;
  /** Gait phase in steps (a footfall at each whole number). */
  phase = 0;
  /** Vertical jump of the last tick caused by a stair step (autostep up, snap down), else 0. */
  stepDy = 0;
  /** Impact speed of a landing in the last tick (m/s), else 0. */
  landed = 0;
  /** Tag of the floor under the character, from the last contact. */
  floorTag: string | undefined;
  onFootfall: ((f: Footfall) => void) | null = null;

  private timers = { coyote: 0, buffer: 0 };
  /** Did the last move touch something too steep to walk on (a riser, an edge, a wall)? */
  private touching = false;
  private readonly cosMax: number;
  private airTime = 0;

  constructor(readonly body: CharacterBody, readonly t: Tuning = TUNING) {
    this.feet = body.feet(); this.prevFeet = [...this.feet];
    this.cosMax = Math.cos((t.maxSlopeDeg * Math.PI) / 180);
  }

  /** Current capsule height (standing or crouched). */
  get height() { return this.crouched ? this.t.crouchHeight : this.t.height; }

  teleport(p: V3) {
    this.body.teleport(p);
    this.feet = [...p]; this.prevFeet = [...p];
    this.vel = [0, 0]; this.vy = 0; this.grounded = false; this.stepDy = 0; this.landed = 0; this.airTime = 0;
    this.timers = { coyote: 0, buffer: 0 };
  }

  update(intent: MotorIntent, dt: number) {
    const t = this.t;
    this.prevFeet = [...this.feet];
    this.stepDy = 0; this.landed = 0;

    // stance: crouch while asked; stand again only with head room
    const want = nextCrouch(this.crouched, intent.crouch, intent.crouch || !this.crouched || this.body.fits(t.height));
    if (want !== this.crouched) { this.crouched = want; this.body.setHeight(want ? t.crouchHeight : t.height); }

    this.vel = accelerate(this.vel, intent.wish, this.grounded, dt, t);
    const j = jumpLogic(this.timers, intent.jump, this.grounded, true, dt, t);
    this.timers = { coyote: j.coyote, buffer: j.buffer };
    const fallSpeed = this.vy;
    if (j.jump) { this.vy = jumpSpeed(t); this.grounded = false; }
    else if (this.grounded) this.vy = -1;   // press into the ground so grounding and snapping hold
    else this.vy = Math.max(-t.maxFall, this.vy - t.gravity * dt);

    const r = this.body.move(this.grounded && !j.jump ? this.groundMove(dt) : [this.vel[0] * dt, this.vy * dt, this.vel[1] * dt]);
    const [mx, my, mz] = r.move;
    let floor: string | undefined;
    this.touching = false;
    for (const h of r.hits) {
      const [nx, ny, nz] = h.normal;
      if (ny > -0.5 && ny < this.cosMax) this.touching = true;
      if (Math.abs(ny) < 0.7) {
        // only a wall taller than a step eats velocity: the KCC rides a stair riser for a few ticks
        // before the autostep climbs it, and losing speed there would stall on the step
        if (h.point[1] - this.feet[1] > t.autostep + 0.1) { const l = Math.hypot(nx, nz) || 1; this.vel = clipVelocity(this.vel, [nx / l, nz / l]); }
      } else if (ny < 0 && this.vy > 0) this.vy = 0;   // head hit a ceiling
      else if (ny > 0) floor = h.tag;
    }
    if (floor) this.floorTag = floor;
    const wasGrounded = this.grounded;
    this.feet = [this.feet[0] + mx, this.feet[1] + my, this.feet[2] + mz];
    const dh = Math.hypot(mx, mz);
    this.speed = dh / dt;
    if (r.grounded && wasGrounded && isStep(my, dh, t)) this.stepDy = my;

    if (r.grounded && !wasGrounded) {
      if (fallSpeed < -2.5 && this.airTime > 0.12) {
        this.landed = -fallSpeed;
        this.footfall(Math.min(1.6, 0.7 + -fallSpeed * 0.1));
      }
      this.vy = -1;
    }
    this.airTime = r.grounded ? 0 : this.airTime + dt;
    this.grounded = r.grounded;

    // gait follows distance walked, so cadence matches speed
    this.running = this.speed > (t.walk + t.run) / 2 - 0.2;
    if (this.grounded && dh > 1e-4) {
      const before = Math.floor(this.phase);
      this.phase += dh / stride(this.running, this.crouched, t);
      if (Math.floor(this.phase) !== before) this.footfall(this.crouched ? 0.45 : this.running ? 1.25 : 0.9);
    }
  }

  /**
   * A grounded tick's move. With a body that can probe the floor, the move follows the plane of the
   * floor just ahead, and presses down only while the character touches something too steep to walk
   * on (a riser, an edge, a wall): pressing 1 m/s straight down into a 35° stair ramp cost half the
   * horizontal speed, and on flat landings it made the KCC stall now and then (a zero move with only
   * the floor as contact). Without the press against a step's edge, though, the KCC slides up edges
   * taller than the autostep. A body without a probe always presses.
   */
  private groundMove(dt: number): V3 {
    const [vx, vz] = this.vel, f = this.feet, v = Math.hypot(vx, vz), body = this.body;
    if (!body.probe) return [vx * dt, this.vy * dt, vz * dt];
    const rise = (k: number) => {
      const g = body.probe!(f[0] + vx * k, f[2] + vz * k, f[1] + PROBE_UP, PROBE_UP + PROBE_DOWN);
      if (g?.tag) this.floorTag = g.tag;
      return g && g.normal[1] >= this.cosMax ? riseAlong(this.vel, g.normal) : 0;
    };
    // going up, follow the floor where the capsule's round bottom meets it, a little ahead of its
    // axis (else the KCC climbs the first ticks of a ramp by projection, at a third less speed);
    // going down, the floor under the axis (else it presses into the landing before the ramp starts)
    const up = v > 1e-6 ? rise(dt + LOOKAHEAD / v) : 0;
    const dy = up > 0 ? up : Math.min(0, rise(dt));
    return [vx * dt, (dy + (this.touching ? this.vy : 0)) * dt, vz * dt];
  }

  private footfall(strength: number) { this.onFootfall?.({ tag: this.floorTag, running: this.running, strength, feet: [...this.feet] }); }
}
