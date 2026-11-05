// First-person player (game-feel, camera-systems): maps input to a CharacterMotor intent and drives
// the camera with interpolation, stair-step smoothing, head bob, a landing dip and a running FOV kick.
// Everything it touches comes in through the constructor: motor, input, view, raycaster.
import * as THREE from 'three/webgpu';
import type { PhysicsApi, V3 } from '../castle/interior/types';
import type { CharacterMotor, Footfall, MotorIntent } from '../character/motor';
import type { InputSource } from './input';
import { TUNING, type MoveInput, targetSpeed, wishVelocity, headBob, damp } from './movement';

export type Surface = 'stone' | 'wood' | 'grass' | 'dirt';
export type SurfaceResolver = (tag: string | undefined, x: number, z: number) => Surface;
export const defaultSurface: SurfaceResolver = (tag) => (!tag ? 'stone' : tag.includes('wood') ? 'wood' : tag.includes('terrain') ? 'grass' : 'stone');

/** The bits of a PerspectiveCamera the player writes. */
export interface CameraView { position: THREE.Vector3; quaternion: THREE.Quaternion; fov: number; updateProjectionMatrix(): void }

export interface PlayerDeps {
  motor: CharacterMotor;
  input: InputSource;
  view: CameraView;
  ray: Pick<PhysicsApi, 'raycast'>;
  surfaceAt?: SurfaceResolver;
  onFootstep?: (s: Surface, running: boolean, strength: number) => void;
}

const T = TUNING;
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

export class PlayerController {
  /** Only the active player reads input and moves (walk mode). */
  active = false;
  /** Head direction (radians); mouse look (src/camera/mouseLook.ts) writes it in walk mode. */
  yaw = 0; pitch = 0;
  spawn = { x: 0, y: 3, z: 0, yaw: 0 };
  surface: Surface = 'grass';
  surfaceTag: string | undefined;
  footsteps = 0;

  readonly motor: CharacterMotor;
  private input: InputSource;
  private view: CameraView;
  private ray: Pick<PhysicsApi, 'raycast'>;
  private surfaceAt: SurfaceResolver;
  private onFootstep: PlayerDeps['onFootstep'];
  private eyeH = T.eye;
  private stepOff = 0; private prevStepOff = 0;
  private bobW = 0; private runMix = 0;
  private dip = 0;
  private fov = T.fov;

  constructor(d: PlayerDeps) {
    this.motor = d.motor; this.input = d.input; this.view = d.view; this.ray = d.ray;
    this.surfaceAt = d.surfaceAt ?? defaultSurface;
    this.onFootstep = d.onFootstep;
    this.motor.onFootfall = (f) => this.footfall(f);
  }

  get feet() { return this.motor.feet; }
  get grounded() { return this.motor.grounded; }
  get crouched() { return this.motor.crouched; }

  setActive(on: boolean) { if (on && !this.active) this.input.take('Space'); this.active = on; }

  /** Feet at (x, y, z). Clears velocity and camera smoothing. */
  teleport(x: number, y: number, z: number, yaw?: number, pitch?: number) {
    this.motor.teleport([x, y, z]);
    this.stepOff = this.prevStepOff = 0; this.dip = 0;
    if (yaw !== undefined) this.yaw = yaw;
    if (pitch !== undefined) this.pitch = pitch;
  }

  /** Highest walkable surface under (x, z), searched down from `fromY`. */
  groundAt(x: number, z: number, fromY: number, fallback: number) {
    const hit = this.ray.raycast([x, fromY, z], [0, -1, 0], fromY + 30);
    return hit && hit.normal[1] > 0.5 ? hit.point[1] : fallback;
  }

  readInput(): MoveInput {
    const i = this.input;
    const ax = (neg: string[], pos: string[]) => (i.down(...pos) ? 1 : 0) - (i.down(...neg) ? 1 : 0);
    return {
      fwd: ax(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']),
      str: ax(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']),
      run: i.down('ShiftLeft', 'ShiftRight'),
      crouch: i.down('KeyC', 'ControlLeft', 'ControlRight'),
      jump: i.take('Space'),
    };
  }

  intent(inp: MoveInput): MotorIntent {
    return { wish: wishVelocity(inp, this.yaw, targetSpeed(inp, this.motor.crouched)), jump: inp.jump, crouch: inp.crouch };
  }

  /** One fixed tick: input → motor, then the camera-side state that follows the motor. */
  fixedUpdate(dt: number) {
    if (!this.active) return;
    const m = this.motor;
    this.prevStepOff = this.stepOff;
    m.update(this.intent(this.readInput()), dt);
    if (m.stepDy) this.stepOff = THREE.MathUtils.clamp(this.stepOff - m.stepDy, -0.5, 0.5);
    this.stepOff = damp(this.stepOff, 0, T.stepSmooth, dt);
    if (m.landed > 2.5) this.dip = Math.min(0.14, this.dip + (m.landed - 2) * 0.02);
    this.dip = damp(this.dip, 0, 7, dt);
    this.runMix = damp(this.runMix, m.running ? 1 : 0, 6, dt);
    this.bobW = damp(this.bobW, m.grounded ? Math.min(1, m.speed / T.walk) : 0, 10, dt);
    this.fov = damp(this.fov, T.fov + (m.running && m.grounded ? T.fovRunKick : 0), 5, dt);
    if (m.feet[1] < -15) this.teleport(this.spawn.x, this.spawn.y, this.spawn.z, this.spawn.yaw, 0);
  }

  private footfall(f: Footfall) {
    let tag = f.tag;
    if (!tag) tag = this.ray.raycast([f.feet[0], f.feet[1] + 0.2, f.feet[2]], [0, -1, 0], 0.8)?.tag;
    this.surfaceTag = tag;
    this.surface = this.surfaceAt(tag, f.feet[0], f.feet[2]);
    this.footsteps++;
    this.onFootstep?.(this.surface, f.running, f.strength);
  }

  /** Per rendered frame: place the camera between the last two ticks. */
  frame(alpha: number, dt: number) {
    const m = this.motor, v = this.view;
    this.eyeH = damp(this.eyeH, m.crouched ? T.crouchEye : T.eye, 12, dt);
    const [bu, bs] = headBob(m.phase, this.bobW, this.runMix);
    const off = this.prevStepOff + (this.stepOff - this.prevStepOff) * alpha;
    const lerp = (i: 0 | 1 | 2) => m.prevFeet[i] + (m.feet[i] - m.prevFeet[i]) * alpha;
    v.position.set(lerp(0) + Math.cos(this.yaw) * bs, lerp(1) + this.eyeH + off - this.dip + bu, lerp(2) - Math.sin(this.yaw) * bs);
    v.quaternion.setFromEuler(euler.set(this.pitch, this.yaw, 0, 'YXZ'));
    if (Math.abs(v.fov - this.fov) > 0.01) { v.fov = this.fov; v.updateProjectionMatrix(); }
  }

  state() {
    const r = (n: number) => Math.round(n * 1000) / 1000, m = this.motor, f: V3 = m.feet;
    return {
      x: r(f[0]), y: r(f[1]), z: r(f[2]), eye: r(f[1] + this.eyeH),
      yaw: r(this.yaw), pitch: r(this.pitch), speed: r(m.speed), vy: r(m.vy),
      grounded: m.grounded, crouched: m.crouched, surface: this.surface, surfaceTag: this.surfaceTag,
      stepOffset: r(this.stepOff), fov: r(this.fov), footsteps: this.footsteps, active: this.active,
    };
  }
}
