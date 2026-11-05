// Cameras (camera-systems / input-systems): orbit for reviewing the exterior, free fly, and a walk
// mode that keeps you on the island at eye height and outside the walls. Named bookmarks make the
// art-review captures repeatable (game-art-review).
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { heightAt, islandWalkable } from '../world/terrain';
import { castleCentre, gatehouseFrame } from '../castle/layout';
import { GATEHOUSE, GROUND } from '../castle/spec';
import { MouseLook } from './mouseLook';

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
  { name: 'towertop', label: 'From the great tower', mode: 'fly', pos: [-28, 56, -12], target: [80, 20, 160] }, // over the keep's south parapet, clear of the cap house and the corner turret
  { name: 'top', label: 'Top down', mode: 'orbit', pos: [0.1, 260, 0.1], target: [0, 0, 0] },
  { name: 'door-gate', label: 'Main gate', mode: 'walk', pos: [gEye[0], 0, gEye[1]], target: [gLook[0], GROUND + 2.2, gLook[1]] },
  // close-up material checks (texture at 1–3 m): old rubble in sun, new ashlar, north face in shade, a quoin corner.
  { name: 'closeup-rubble', label: 'Rubble 1 m', mode: 'fly', pos: [-17.04, 7.0, 22.6], target: [-25.29, 5.58, 19.29] },
  { name: 'closeup-ashlar', label: 'Ashlar 1.5 m', mode: 'fly', pos: [-7.71, 6.8, 19.37], target: [-14.14, 5.45, 13.21] },
  { name: 'closeup-shade', label: 'Shade 2 m', mode: 'fly', pos: [-5.65, 7.0, -22.68], target: [-0.13, 5.85, -15.67] },
  { name: 'closeup-corner', label: 'Quoin 3 m', mode: 'fly', pos: [-25.16, 8.0, 24.51], target: [-19.66, 6.81, 17.49] },
];

export class CameraRig {
  mode: Mode = 'orbit';
  orbit: OrbitControls;
  private keys = new Set<string>();
  private yaw = 0; private pitch = 0;
  speed = { fly: 22, walk: 4.2 };
  /** Where walk mode may step (doors widen this into an open gate passage). */
  canWalk: (x: number, z: number) => boolean = islandWalkable;
  /** Ground height under the camera (walk eye height, fly floor). */
  groundAt: (x: number, z: number) => number = heightAt;

  constructor(public camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.orbit = new OrbitControls(camera, dom);
    this.orbit.enableDamping = true; this.orbit.dampingFactor = 0.08;
    this.orbit.minDistance = 8; this.orbit.maxDistance = 1200; this.orbit.maxPolarAngle = Math.PI * 0.495;
    addEventListener('keydown', (e) => { if ((e.target as HTMLElement)?.tagName === 'INPUT') return; this.keys.add(e.code); });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    this.look = new MouseLook({
      el: dom, doc: document,
      enabled: () => this.mode !== 'orbit',
      get: () => ({ yaw: this.yaw, pitch: this.pitch }),
      set: (l) => { this.yaw = l.yaw; this.pitch = l.pitch; },
      // clear held keys on release so the player does not keep walking after Esc
      onLockChange: (locked) => { if (!locked) this.keys.clear(); this.onLockChange?.(locked); },
    });
  }

  look: MouseLook;
  /** True while the pointer is captured for mouse look. */
  get locked() { return this.look.locked; }
  onLockChange?: (locked: boolean) => void;

  setMode(m: Mode) {
    this.mode = m;
    if (m === 'orbit') this.look.release();
    this.orbit.enabled = m === 'orbit';
    if (m !== 'orbit') {
      const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.yaw = e.y; this.pitch = e.x;
    } else {
      const dir = new THREE.Vector3(); this.camera.getWorldDirection(dir);
      this.orbit.target.copy(this.camera.position).addScaledVector(dir, 60);
    }
  }

  go(v: View) {
    const p = new THREE.Vector3(...v.pos);
    if (v.mode === 'walk') p.y = this.groundAt(p.x, p.z) + 1.7;
    this.camera.position.copy(p);
    this.camera.lookAt(new THREE.Vector3(...v.target));
    this.orbit.target.set(...v.target);
    this.setMode(v.mode);
    // only orbit views go through the orbit control: its update pushes a close bookmark out to
    // minDistance and clamps the polar angle, which lifted walk views looking up at the walls to the
    // target's height (the courtyard view ended up inside the west wing)
    if (v.mode === 'orbit') this.orbit.update();
  }

  update(dt: number) {
    if (this.mode === 'orbit') { this.orbit.update(); return; }
    const k = (c: string) => this.keys.has(c);
    const fwd = (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0);
    const str = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
    const fast = k('ShiftLeft') || k('ShiftRight') ? 3 : 1;
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    if (this.mode === 'fly') {
      const v = new THREE.Vector3(str, (k('KeyE') || k('Space') ? 1 : 0) - (k('KeyQ') || k('KeyC') ? 1 : 0), -fwd).applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, this.yaw, 0)));
      if (fwd) v.y += -fwd * -Math.sin(this.pitch) * 0;
      const look = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      const moveDir = new THREE.Vector3().addScaledVector(look, fwd).addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion), str);
      moveDir.y += v.y;
      this.camera.position.addScaledVector(moveDir, this.speed.fly * fast * dt);
      const floor = this.groundAt(this.camera.position.x, this.camera.position.z) + 1.0;
      if (this.camera.position.y < floor) this.camera.position.y = floor;
    } else {
      const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), rgt = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const step = new THREE.Vector3().addScaledVector(f, fwd).addScaledVector(rgt, str);
      if (step.lengthSq() > 0) step.normalize().multiplyScalar(this.speed.walk * fast * dt);
      const p = this.camera.position;
      // slide along obstacles: try full step, then each axis
      for (const s of [step, new THREE.Vector3(step.x, 0, 0), new THREE.Vector3(0, 0, step.z)]) {
        if (this.canWalk(p.x + s.x, p.z + s.z)) { p.x += s.x; p.z += s.z; break; }
      }
      const target = this.groundAt(p.x, p.z) + 1.7;
      p.y += (target - p.y) * Math.min(1, dt * 12);
    }
  }
}
