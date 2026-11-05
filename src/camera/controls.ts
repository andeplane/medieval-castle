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
export interface View { name: string; label: string; mode: Mode; pos: [number, number, number]; target: [number, number, number]; clamp?: boolean }

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
  { name: 'towertop', label: 'From the great tower', mode: 'fly', pos: [-28, 56, -12], target: [80, 20, 160] }, // over the keep's south parapet, clear of the cap house and the corner turret
  { name: 'top', label: 'Top down', mode: 'orbit', pos: [0.1, 260, 0.1], target: [0, 0, 0] },
  { name: 'door-gate', label: 'Main gate', mode: 'walk', pos: [gEye[0], 0, gEye[1]], target: [gLook[0], GROUND + 2.2, gLook[1]] },
  // close-up material checks (texture at 1–3 m): old rubble in sun, new ashlar, north face in shade, a quoin corner.
  { name: 'closeup-rubble', label: 'Rubble 1 m', mode: 'fly', pos: [-17.04, 7.0, 22.6], target: [-25.29, 5.58, 19.29] },
  { name: 'closeup-ashlar', label: 'Ashlar 1.5 m', mode: 'fly', pos: [-7.71, 6.8, 19.37], target: [-14.14, 5.45, 13.21] },
  { name: 'closeup-shade', label: 'Shade 2 m', mode: 'fly', pos: [-5.65, 7.0, -22.68], target: [-0.13, 5.85, -15.67] },
  { name: 'closeup-corner', label: 'Quoin 3 m', mode: 'fly', pos: [-25.16, 8.0, 24.51], target: [-19.66, 6.81, 17.49] },
  // Anders' live screenshot (2026-11-05): on foot at the base of the S wing (ashlar), 1.1 m out, looking west along it
  { name: 'closeup-walk', label: 'Wall foot', mode: 'walk', pos: [-9.157, 0, 19.096], target: [-12.638, GROUND + 2.3, 18.288] },
  // walk views of the moat edge: by the bridge looking along it, and along the revetment
  { name: 'bridge', label: 'Bridge', mode: 'walk', pos: [20.7, 0, 53.4], target: [14.5, 1.2, 67.8] },
  { name: 'rim', label: 'Moat edge', mode: 'walk', pos: [48.4, 0, 32.0], target: [59.5, 1.2, 13.5] },
  // courtyard paving: on foot looking at the ground 1.5 m ahead (by the flag path), 0.5 m over the cobbles at
  // the S wing's foot, and from the gate passage out into the courtyard
  { name: 'court-ground', label: 'Courtyard ground', mode: 'walk', pos: [2.6, 0, 3.4], target: [3.8, GROUND, 2.5] },
  { name: 'court-close', label: 'Cobbles 0.5 m', mode: 'fly', pos: [7.5, GROUND + 0.52, 5.6], target: [8.0, GROUND, 6.9] },
  { name: 'gatepass-court', label: 'Passage to courtyard', mode: 'walk', pos: [4.1, 0, 12.8], target: [5.0, GROUND + 0.8, -2] },
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
  /** Keep the fly camera above the terrain (off for interior bookmarks: cellars and tunnels lie below it). */
  clampFly = true;
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
    if (prev === 'walk' && m !== 'walk' && this.player) {
      this.yaw = this.player.yaw; this.pitch = this.player.pitch;
      // flying off from a cellar or tunnel must not snap the camera up through the ground
      const c = this.camera.position;
      this.clampFly = c.y > this.groundAt(c.x, c.z);
    }
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
    // a floor just under the camera counts even off the island (the moat tunnel); cellars and tunnels
    // lie below the terrain, so the floor comes from a ray, never from the terrain height
    const floor = pl.groundAt(p.x, p.z, p.y, NaN), close = !Number.isNaN(floor) && p.y - floor < 4;
    if (p.y < 45 && (close || this.walkable?.(p.x, p.z))) {
      const y = Number.isNaN(floor) ? heightAt(p.x, p.z) : floor;
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
    this.clampFly = v.clamp !== false;
    this.camera.position.copy(p);
    this.camera.lookAt(target);
    this.orbit.target.copy(target);
    this.setMode(v.mode);
    // only orbit views go through the orbit control: its update pushes a close bookmark out to
    // minDistance and clamps the polar angle, which lifted walk views looking up at the walls to the
    // target's height (the courtyard view ended up inside the west wing)
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
    if (this.clampFly && this.camera.position.y < floor) this.camera.position.y = floor;
  }
}
