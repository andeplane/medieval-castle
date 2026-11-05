// The render side of the doors: every leaf class is one geometry in a BatchedMesh per material, every
// leaf one instance. doors.ts only sees the small BatchLike interface, so tests can pass a fake.
import * as THREE from 'three/webgpu';
import type { PartBin } from './doorParts';
import type { M4 } from './doorGeom';
import type { V3 } from './types';

export interface BatchLike {
  object: THREE.Object3D;
  addGeometry(b: PartBin): number;
  addInstance(geometry: number): number;
  setMatrixAt(instance: number, m: M4): void;
  setColorAt(instance: number, rgb: V3): void;
  setVisibleAt(instance: number, visible: boolean): void;
}
export type BatchFactory = (name: string, material: THREE.Material, maxInstances: number, maxVertices: number) => BatchLike;

const _m = new THREE.Matrix4(), _c = new THREE.Color();

export const threeBatch: BatchFactory = (name, material, maxInstances, maxVertices) => {
  const mesh = new THREE.BatchedMesh(Math.max(1, maxInstances), Math.max(3, maxVertices), 0, material);
  mesh.name = name; mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.sortObjects = false;      // opaque: no per-frame sort
  mesh.frustumCulled = false;    // instances move; per-instance culling still runs (perObjectFrustumCulled)
  return {
    object: mesh,
    addGeometry(b) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      return mesh.addGeometry(g);
    },
    addInstance: (g) => mesh.addInstance(g),
    setMatrixAt: (i, m) => { mesh.setMatrixAt(i, _m.fromArray(m)); },
    setColorAt: (i, rgb) => { mesh.setColorAt(i, _c.setRGB(rgb[0], rgb[1], rgb[2])); },
    setVisibleAt: (i, v) => { mesh.setVisibleAt(i, v); },
  };
};
