// CameraRig with typed fakes: modes, bookmarks (walk ones teleport the player), look routing for mouse
// look, fly movement, pointer release on orbit, and dropping into walk mode where the camera is.
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three/webgpu';
import { CameraRig, VIEWS, spawnPoint, aim, type Orbiter, type MouseControl } from '../src/camera/controls';
import { PlayerController } from '../src/player/controller';
import { CharacterMotor } from '../src/character/motor';
import { ScriptedInput } from '../src/player/input';
import { TUNING } from '../src/player/movement';
import type { CharacterBody, MoveResult } from '../src/character/types';
import type { V3 } from '../src/castle/interior/types';
import { heightAt } from '../src/world/terrain';

class Body implements CharacterBody {
  id = 1; p: V3 = [0, 0, 0];
  feet(): V3 { return [...this.p]; }
  move(d: V3): MoveResult { this.p = [this.p[0] + d[0], Math.max(0, this.p[1] + d[1]), this.p[2] + d[2]]; return { move: d, grounded: true, hits: [] }; }
  teleport(p: V3) { this.p = [...p]; }
  setHeight() {}
  fits() { return true; }
  remove() {}
}

describe('CameraRig', () => {
  let rig: CameraRig, cam: THREE.PerspectiveCamera, keys: ScriptedInput, orbit: Orbiter & { updates: number }, mouse: MouseControl & { released: number }, player: PlayerController;
  beforeEach(() => {
    cam = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
    keys = new ScriptedInput();
    orbit = { enabled: true, target: new THREE.Vector3(), updates: 0, update() { this.updates++; } };
    mouse = { locked: false, released: 0, release() { this.released++; } };
    player = new PlayerController({ motor: new CharacterMotor(new Body()), input: keys, view: cam, ray: { raycast: (f) => ({ point: [f[0], heightAt(f[0], f[2]), f[2]], normal: [0, 1, 0], dist: 1 }) } });
    rig = new CameraRig(cam, orbit, keys);
  });

  it('works without a player or mouse attached', () => {
    expect(rig.locked).toBe(false);
    rig.go(VIEWS.find((v) => v.mode === 'walk')!);
    expect(rig.mode).toBe('walk');
    expect(cam.position.y).toBeCloseTo(heightAt(cam.position.x, cam.position.z) + TUNING.eye);
    rig.toSpawn();
    rig.update(1 / 60); // walk without a player falls back to the fly update
    rig.setLook({ yaw: 1, pitch: 0.2 });
    expect(rig.getLook()).toEqual({ yaw: 1, pitch: 0.2 });
  });

  it('orbit bookmarks update the orbit target and release the mouse', () => {
    rig.mouse = mouse;
    rig.go(VIEWS[0]);
    expect(rig.mode).toBe('orbit');
    expect(orbit.enabled).toBe(true);
    expect(mouse.released).toBe(1);
    rig.update(1 / 60);
    expect(orbit.updates).toBeGreaterThan(1);
    expect(cam.fov).toBe(55);
  });

  it('walk bookmarks teleport the player and aim the head at the target', () => {
    rig.player = player;
    const v = VIEWS.find((x) => x.name === 'gate')!;
    const seen: string[] = [];
    rig.onModeChange = (m) => seen.push(m);
    rig.go(v);
    expect(rig.mode).toBe('walk');
    expect(player.active).toBe(true);
    expect(player.feet[0]).toBe(v.pos[0]);
    expect(cam.position.y).toBeCloseTo(heightAt(v.pos[0], v.pos[2]) + TUNING.eye, 1);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const want = new THREE.Vector3(...v.target).sub(cam.position).normalize();
    expect(dir.dot(want)).toBeGreaterThan(0.99);
    expect(seen).toContain('walk');
    rig.go(v); // already walking
    expect(rig.getLook().yaw).toBeCloseTo(player.yaw);
    rig.setLook({ yaw: 0.4, pitch: -0.1 });
    expect(player.yaw).toBe(0.4);
    rig.update(1 / 60);
    expect(cam.fov).toBeCloseTo(TUNING.fov, 0);
    expect(cam.near).toBe(TUNING.near); // small near plane while walking: the frustum stays inside the capsule
  });

  it('entering walk mode drops you under the camera on the island, else at the spawn', () => {
    rig.player = player;
    rig.walkable = () => true;
    cam.position.set(30, 10, 30); cam.lookAt(0, 10, 0);
    rig.setMode('walk');
    expect(player.feet[0]).toBe(30);
    expect(player.feet[1]).toBeCloseTo(heightAt(30, 30));
    rig.update(1 / 60);
    rig.setMode('fly');
    expect(cam.fov).toBe(55);
    expect(cam.near).toBe(0.25);
    rig.walkable = () => false;
    cam.position.set(30, 20, 30); // off the island and not just above a floor
    rig.setMode('walk');
    const s = spawnPoint();
    expect(player.feet[0]).toBeCloseTo(s.x); expect(player.spawn.yaw).toBeCloseTo(s.yaw);
    rig.setMode('orbit');
    expect(player.active).toBe(false);
  });

  it('flies with WASD, E/Q, Shift, and stays above the ground', () => {
    cam.position.set(0, 50, 0); cam.lookAt(0, 50, -10);
    rig.setMode('fly');
    rig.setLook({ yaw: 0, pitch: 0 });
    keys.hold(['KeyW']); rig.update(1);
    expect(cam.position.z).toBeCloseTo(-22);
    keys.hold(['KeyE', 'ShiftLeft']); rig.update(1);
    expect(cam.position.y).toBeCloseTo(50 + 66);
    keys.hold(['KeyQ']); rig.update(10);
    expect(cam.position.y).toBeCloseTo(heightAt(cam.position.x, cam.position.z) + 1);
    keys.hold(['KeyD', 'KeyS']); rig.update(0.1);
    keys.hold([]);
    expect(rig.getLook()).toEqual({ yaw: 0, pitch: 0 });
  });

  it('aims and the spawn faces the gate', () => {
    const a = aim(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -5));
    expect(a.yaw).toBeCloseTo(0); expect(a.pitch).toBeCloseTo(0);
    expect(aim(new THREE.Vector3(0, 0, 0), new THREE.Vector3(-5, 5, 0)).yaw).toBeCloseTo(Math.PI / 2);
    const s = spawnPoint();
    expect(s.z).toBeGreaterThan(20); // south of the castle
  });
});
