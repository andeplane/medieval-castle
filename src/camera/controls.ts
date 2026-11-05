// Cameras (camera-systems / input-systems): orbit for reviewing the exterior, free fly, and walk, which
// is the physics player (src/player/controller.ts). Named bookmarks make the art-review captures
// repeatable (game-art-review); walk bookmarks teleport the player and aim the head at the target.
import * as THREE from 'three/webgpu';
import { heightAt } from '../world/terrain';
import { castleCentre, gatehouseFrame } from '../castle/layout';
import { GATEHOUSE, GROUND } from '../castle/spec';
import { add, scale } from '../core/math2d';
import type { InputSource } from '../player/input';
import type { Look } from './mouseLook';
import type { PlayerController } from '../player/controller';
import { TUNING } from '../player/movement';

export type Mode = 'orbit' | 'fly' | 'walk';
export interface View { name: string; label: string; mode: Mode; pos: [number, number, number]; target: [number, number, number] }

const C = castleCentre();
// in front of the main gate, a little off-axis, looking into the gate passage
const GF = gatehouseFrame(), gAt = (s: number, d: number) => [GF.base[0] + GF.dir[0] * s + GF.out[0] * d, GF.base[1] + GF.dir[1] * s + GF.out[1] * d];
const gEye = gAt(1.4, GATEHOUSE.project + 6.5), gLook = gAt(0, GATEHOUSE.project - 1.5);
export const VIEWS: View[] = [
  { name: 'hero', label: 'Hero', mode: 'orbit', pos: [118, 52, 132], target: [C[0], 22, C[1]] },
  { name: 'aerial', label: 'Aerial', mode: 'orbit', pos: [-150, 150, 175], target: [C[0], 12, C[1]] },
  { name: 'north', label: 'North walls', mode: 'orbit', pos: [-62, 9, -96], target: [-4, 24, -20] },
  { name: 'gate', label: 'Gate', mode: 'walk', pos: [13, 0, 45], target: [3, 15, 20] },
  { name: 'ward', label: 'East ward', mode: 'walk', pos: [44, 0, 27], target: [20, 22, -6] },
  { name: 'moat', label: 'Across the moat', mode: 'orbit', pos: [-92, 4.8, 58], target: [-10, 20, 4] },
  { name: 'courtyard', label: 'Courtyard', mode: 'walk', pos: [-11, 0, 4], target: [12, 22, -8] },
  { name: 'towertop', label: 'From the great tower', mode: 'fly', pos: [-24, 56, -16], target: [80, 20, 160] },
  { name: 'top', label: 'Top down', mode: 'orbit', pos: [0.1, 260, 0.1], target: [0, 0, 0] },
  { name: 'door-gate', label: 'Main gate', mode: 'walk', pos: [gEye[0], 0, gEye[1]], target: [gLook[0], GROUND + 2.2, gLook[1]] },
];

/** Where play starts: on the lawn just south of the gate, facing it. Not a bookmark (trees avoid those). */
export function spawnPoint() {
  const g = gatehouseFrame();
  const p = add(g.base, scale(g.out, GATEHOUSE.project + 7));
  const yaw = Math.atan2(g.out[0], g.out[1]); // camera forward is (−sin yaw, −cos yaw): look back along −out
  return { x: p[0], z: p[1], yaw };
}

const REVIEW_FOV = 55, REVIEW_NEAR = 0.25; // walk mode uses TUNING.near (the player sets it)
/** Yaw and pitch that look from `from` toward `to` (yaw 0 = north, −z). */
export function aim(from: THREE.Vector3, to: THREE.Vector3) {
  const d = to.clone().sub(from);
  return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) };
}

/** The mouse-look parts the rig uses (MouseLook from ./mouseLook, or a fake). */
export interface MouseControl { readonly locked: boolean; release(): void }
/** Something that can orbit (OrbitControls, or a fake in tests). */
export interface Orbiter { enabled: boolean; target: THREE.Vector3; update(): void }

export class CameraRig {
  mode: Mode = 'orbit';
  private yaw = 0; private pitch = 0;
  speed = { fly: 22 };
  /** The physics player; walk mode drives it. */
  player: PlayerController | null = null;
  /** Physics interpolation factor for the walk camera. */
  alpha: () => number = () => 1;
  /** Inside the player's boundary (where dropping into walk mode is allowed). */
  walkable: ((x: number, z: number) => boolean) | null = null;
  /** Mouse look, attached after construction (it reads and writes the rig's look). */
  mouse: MouseControl | null = null;
  onModeChange?: (mode: Mode) => void;
  /** Ground height under the camera (fly floor; walk bookmarks without a player). */
  groundAt: (x: number, z: number) => number = heightAt;

  constructor(public camera: THREE.PerspectiveCamera, public orbit: Orbiter, private keys: InputSource) {}

  get locked() { return this.mouse?.locked ?? false; }
  /** The head direction mouse look turns: the player's in walk mode, the fly camera's otherwise. */
  getLook(): Look { return this.mode === 'walk' && this.player ? { yaw: this.player.yaw, pitch: this.player.pitch } : { yaw: this.yaw, pitch: this.pitch }; }
  setLook(l: Look) {
    if (this.mode === 'walk' && this.player) { this.player.yaw = l.yaw; this.player.pitch = l.pitch; } else { this.yaw = l.yaw; this.pitch = l.pitch; }
  }

  setMode(m: Mode) {
    const prev = this.mode;
    this.mode = m;
    if (m === 'orbit') this.mouse?.release();
    this.orbit.enabled = m === 'orbit';
    this.player?.setActive(m === 'walk');
    if (m === 'walk' && prev !== 'walk') this.enterWalk();
    if (prev === 'walk' && m !== 'walk' && this.player) { this.yaw = this.player.yaw; this.pitch = this.player.pitch; }
    else if (m !== 'orbit' && m !== 'walk') {
      const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.yaw = e.y; this.pitch = e.x;
    }
    if (m === 'orbit') {
      const dir = new THREE.Vector3(); this.camera.getWorldDirection(dir);
      this.orbit.target.copy(this.camera.position).addScaledVector(dir, 60);
    }
    if (m !== 'walk' && (this.camera.fov !== REVIEW_FOV || this.camera.near !== REVIEW_NEAR)) { this.camera.fov = REVIEW_FOV; this.camera.near = REVIEW_NEAR; this.camera.updateProjectionMatrix(); }
    this.onModeChange?.(m);
  }

  /** Drop the player where the camera is if that is a sensible spot on the island, else at the spawn. */
  private enterWalk() {
    const pl = this.player;
    if (!pl) return;
    const p = this.camera.position;
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    if (p.y < 45 && this.walkable?.(p.x, p.z)) {
      const y = pl.groundAt(p.x, p.z, p.y, heightAt(p.x, p.z));
      pl.teleport(p.x, y, p.z, e.y, THREE.MathUtils.clamp(e.x, -0.6, 0.6));
    } else this.toSpawn();
  }
  toSpawn() {
    const s = spawnPoint(), pl = this.player;
    if (!pl) return;
    const y = pl.groundAt(s.x, s.z, heightAt(s.x, s.z) + 3, heightAt(s.x, s.z));
    pl.spawn = { x: s.x, y, z: s.z, yaw: s.yaw };
    pl.teleport(s.x, y, s.z, s.yaw, 0.12);
  }

  go(v: View) {
    const target = new THREE.Vector3(...v.target);
    if (v.mode === 'walk' && this.player) {
      const [x, , z] = v.pos, pl = this.player;
      const y = pl.groundAt(x, z, heightAt(x, z) + 3, heightAt(x, z));
      const { yaw, pitch } = aim(new THREE.Vector3(x, y + TUNING.eye, z), target);
      if (this.mode !== 'walk') this.setMode('walk');
      pl.teleport(x, y, z, yaw, pitch);
      pl.frame(1, 1);
      return;
    }
    const p = new THREE.Vector3(...v.pos);
    if (v.mode === 'walk') p.y = this.groundAt(p.x, p.z) + TUNING.eye;
    this.camera.position.copy(p);
    this.camera.lookAt(target);
    this.orbit.target.copy(target);
    this.setMode(v.mode);
    // OrbitControls.update() would push a close walk/fly bookmark out to minDistance
    if (v.mode === 'orbit') this.orbit.update();
  }

  update(dt: number) {
    if (this.mode === 'orbit') { this.orbit.update(); return; }
    if (this.mode === 'walk' && this.player) { this.player.frame(this.alpha(), dt); return; }
    const k = (...c: string[]) => this.keys.down(...c);
    const fwd = (k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0);
    const str = (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0);
    const up = (k('KeyE', 'Space') ? 1 : 0) - (k('KeyQ', 'KeyC') ? 1 : 0);
    const fast = k('ShiftLeft', 'ShiftRight') ? 3 : 1;
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    const look = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const move = new THREE.Vector3().addScaledVector(look, fwd).addScaledVector(right, str);
    move.y += up;
    this.camera.position.addScaledVector(move, this.speed.fly * fast * dt);
    const floor = this.groundAt(this.camera.position.x, this.camera.position.z) + 1.0;
    if (this.camera.position.y < floor) this.camera.position.y = floor;
  }
}
