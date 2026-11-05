// Cameras (camera-systems / input-systems): orbit for reviewing the exterior, free fly, and walk, which
// is the physics player (src/player/controller.ts). Named bookmarks make the art-review captures
// repeatable (game-art-review); walk bookmarks teleport the player and aim the head at the target.
import * as THREE from 'three/webgpu';
import { heightAt } from '../world/terrain';
import { castleCentre, gatehouseFrame } from '../castle/layout';
import { GATEHOUSE } from '../castle/spec';
import { add, scale } from '../core/math2d';
import type { InputSource } from '../player/input';
import type { PlayerController } from '../player/controller';
import { TUNING } from '../player/movement';

export type Mode = 'orbit' | 'fly' | 'walk';
export interface View { name: string; label: string; mode: Mode; pos: [number, number, number]; target: [number, number, number] }

const C = castleCentre();
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
];

/** Where play starts: on the lawn just south of the gate, facing it. Not a bookmark (trees avoid those). */
export function spawnPoint() {
  const g = gatehouseFrame();
  const p = add(g.base, scale(g.out, GATEHOUSE.project + 7));
  const yaw = Math.atan2(g.out[0], g.out[1]); // camera forward is (−sin yaw, −cos yaw): look back along −out
  return { x: p[0], z: p[1], yaw };
}

const REVIEW_FOV = 55;
/** Yaw and pitch that look from `from` toward `to` (yaw 0 = north, −z). */
export function aim(from: THREE.Vector3, to: THREE.Vector3) {
  const d = to.clone().sub(from);
  return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) };
}

/** What the rig needs from input: keys and look for fly mode, and control over mouse look / lock. */
export interface RigInput extends InputSource { lookEnabled: boolean; readonly locked: boolean; exitLock(): void }
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
  private sens = 0.0022;
  onModeChange?: (mode: Mode) => void;

  constructor(public camera: THREE.PerspectiveCamera, public orbit: Orbiter, private input: RigInput) {}

  get locked() { return this.input.locked; }
  get sensitivity() { return this.sens; }
  set sensitivity(s: number) { this.sens = s; if (this.player) this.player.sensitivity = s; }

  setMode(m: Mode) {
    const prev = this.mode;
    this.mode = m;
    if (m === 'orbit') this.input.exitLock();
    this.input.lookEnabled = m !== 'orbit';
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
    if (m !== 'walk' && this.camera.fov !== REVIEW_FOV) { this.camera.fov = REVIEW_FOV; this.camera.updateProjectionMatrix(); }
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
    if (v.mode === 'walk') p.y = heightAt(p.x, p.z) + TUNING.eye;
    this.camera.position.copy(p);
    this.camera.lookAt(target);
    this.orbit.target.copy(target);
    this.setMode(v.mode);
    this.orbit.update();
  }

  update(dt: number) {
    if (this.mode === 'orbit') { this.orbit.update(); return; }
    if (this.mode === 'walk' && this.player) { this.player.frame(this.alpha(), dt); return; }
    const [dx, dy] = this.input.look();
    this.yaw -= dx * this.sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * this.sens, -1.5, 1.5);
    const k = (...c: string[]) => this.input.down(...c);
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
    const floor = heightAt(this.camera.position.x, this.camera.position.z) + 1.0;
    if (this.camera.position.y < floor) this.camera.position.y = floor;
  }
}
