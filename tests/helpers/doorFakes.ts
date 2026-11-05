// Small type-safe fakes for the door system: batches, physics, sound, and a fixed-step runner.
import * as THREE from 'three/webgpu';
import type { V3, Quat } from '../../src/castle/interior/types';
import type { PartBin } from '../../src/castle/interior/doorParts';
import type { BatchFactory } from '../../src/castle/interior/doorBatch';
import type { DoorSound, Vec3Like } from '../../src/castle/interior/doors';

export function fakeBatch() {
  const made: { name: string; geoms: PartBin[]; inst: number[]; mats: Map<number, number[]>; cols: Map<number, V3> }[] = [];
  const factory: BatchFactory = (name) => {
    const b = { name, geoms: [] as PartBin[], inst: [] as number[], mats: new Map<number, number[]>(), cols: new Map<number, V3>() };
    made.push(b);
    return {
      object: new THREE.Object3D(),
      addGeometry: (g) => b.geoms.push(g) - 1,
      addInstance: (g) => b.inst.push(g) - 1,
      setMatrixAt: (i, m) => { b.mats.set(i, [...m]); },
      setColorAt: (i, c) => { b.cols.set(i, c); },
    };
  };
  return { factory, made };
}
export function fakePhysics() {
  const bodies: { half: V3; tag?: string; pose?: { p: V3; q: Quat }; removed: boolean }[] = [];
  return {
    bodies,
    api: {
      addStaticMesh() {},
      addKinematicBox(half: V3, tag?: string) {
        const b = { half, tag, removed: false } as (typeof bodies)[number];
        bodies.push(b);
        return { setPose: (p: V3, q: Quat) => { b.pose = { p, q }; }, remove: () => { b.removed = true; } };
      },
      raycast: () => null,
    },
  };
}
export function fakeSound() { const log: { s: DoorSound; w: number }[] = []; return { log, sink: { play: (s: DoorSound, _p: V3, w: number) => { log.push({ s, w }); } } }; }
export const M = { wood: new THREE.MeshStandardNodeMaterial(), iron: new THREE.MeshStandardNodeMaterial(), trim: new THREE.MeshStandardNodeMaterial() };
export const run = (sys: { update(dt: number, p?: Vec3Like): void }, seconds: number, p?: Vec3Like) => { for (let t = 0; t < seconds; t += 1 / 60) sys.update(1 / 60, p); };
