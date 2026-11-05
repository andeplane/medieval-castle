// Shared test fixtures: axis-aligned boxes as static meshes, typed fakes for the clock and camera.
import * as THREE from 'three/webgpu';
import type { Physics } from '../src/physics/world';
import type { Clock } from '../src/core/clock';
import type { CameraView } from '../src/player/controller';

export function boxGeometry(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}
export const addBox = (P: Physics, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, tag = 'stone') =>
  P.addStaticMesh(boxGeometry(x0, x1, y0, y1, z0, z1), tag);

/** A clock that advances by `step` ms on every read. */
export const fakeClock = (step = 0.5): Clock => { let t = 0; return { now: () => (t += step) }; };

export const fakeView = (): CameraView & { projUpdates: number } => {
  const v = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fov: 55, projUpdates: 0, updateProjectionMatrix: () => { v.projUpdates++; } };
  return v;
};
