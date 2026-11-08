// The render side of the doors: every leaf class is one geometry, every leaf part one instance, all the
// instances of one material one mesh. doors.ts only sees the small BatchLike interface, so tests can pass a fake.
//
// One draw call per batch and pass, whatever is shown (2026-11-08). The batches were THREE.BatchedMeshes;
// WebGPU in three r187 has no multi-draw, so a BatchedMesh costs one drawIndexed per run of shown
// instances that share a geometry: one per shown leaf class, 192 draws a pass at the courtyard on
// Anders' Mac (759 of the frame's 1209 with the sun's shadow). Now each instance's vertices are baked
// in world space into one merged geometry (re-baked only when its matrix changes: a swinging leaf, the
// portcullis), and an index buffer lists the vertices of the instances that are shown. The same
// triangles at the same places with the same colours, in one draw.
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
  /** Everything set so far is in the buffers (doors.ts calls it once built; rendering calls it too). */
  flush?(): void;
}
export type BatchFactory = (name: string, material: THREE.Material, maxInstances: number, maxVertices: number) => BatchLike;

const IDENTITY: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * Bake `count` vertices of `src` (local positions and normals) by `m` into `pos`/`nor` from vertex `at`.
 * Normals as three's BatchNode turns them (divided by each column's squared length, then by the 3×3),
 * so the shading is what the BatchedMesh drew.
 */
export function bakeInstance(src: PartBin, m: M4, pos: Float32Array, nor: Float32Array, at: number): void {
  const sx = m[0] * m[0] + m[1] * m[1] + m[2] * m[2], sy = m[4] * m[4] + m[5] * m[5] + m[6] * m[6], sz = m[8] * m[8] + m[9] * m[9] + m[10] * m[10];
  const n = src.pos.length / 3;
  for (let v = 0; v < n; v++) {
    const x = src.pos[3 * v], y = src.pos[3 * v + 1], z = src.pos[3 * v + 2], o = 3 * (at + v);
    pos[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
    pos[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    pos[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    const a = src.nor[3 * v] / sx, b = src.nor[3 * v + 1] / sy, c = src.nor[3 * v + 2] / sz;
    nor[o] = m[0] * a + m[4] * b + m[8] * c;
    nor[o + 1] = m[1] * a + m[5] * b + m[9] * c;
    nor[o + 2] = m[2] * a + m[6] * b + m[10] * c;
  }
}

export const threeBatch: BatchFactory = (name, material) => {
  const geoms: PartBin[] = [];
  type Inst = { g: number; m: M4; rgb: V3 | null; on: boolean; at: number; dirty: boolean };
  const inst: Inst[] = [];
  const geometry = new THREE.BufferGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name; mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.frustumCulled = false; // leaves move; nothing is culled per pass, as with the BatchedMesh before
  mesh.visible = false; // until an instance is added
  let built = false, order = true, moved = false, shown = 0;
  let pos: THREE.BufferAttribute, nor: THREE.BufferAttribute, index: THREE.BufferAttribute;

  const build = () => {
    let n = 0;
    for (const it of inst) { it.at = n; n += geoms[it.g].pos.length / 3; }
    const P = new Float32Array(3 * n), N = new Float32Array(3 * n), U = new Float32Array(2 * n), R = new Float32Array(n).fill(-1);
    const coloured = inst.some((it) => it.rgb);
    const C = coloured ? new Float32Array(3 * n).fill(1) : null;
    for (const it of inst) {
      const s = geoms[it.g];
      bakeInstance(s, it.m, P, N, it.at);
      U.set(s.uv, 2 * it.at);
      if (C && it.rgb) for (let v = 0, k = s.pos.length / 3; v < k; v++) C.set(it.rgb, 3 * (it.at + v));
      it.dirty = false;
    }
    pos = new THREE.BufferAttribute(P, 3); nor = new THREE.BufferAttribute(N, 3);
    geometry.setAttribute('position', pos); geometry.setAttribute('normal', nor);
    geometry.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    // no room tag (render/interiorShader.ts): with an interior material a leaf takes the ambient floor,
    // the sun and the fires, not the daylight of whichever room happens to be row 0
    geometry.setAttribute('interiorRoom', new THREE.BufferAttribute(R, 1));
    if (C) {
      geometry.setAttribute('color', new THREE.BufferAttribute(C, 3));
      // the per-leaf tint (the BatchedMesh's colour table) as a vertex colour; a material shared with
      // meshes that have no colour attribute is unchanged for them (three checks the geometry)
      (material as THREE.MeshStandardNodeMaterial).vertexColors = true;
    }
    index = new THREE.BufferAttribute(new Uint32Array(Math.max(1, n)), 1);
    geometry.setIndex(index);
    built = true; order = true; moved = false;
  };

  const flush = () => {
    if (!built) build();
    if (moved) {
      for (const it of inst) if (it.dirty) {
        bakeInstance(geoms[it.g], it.m, pos.array as Float32Array, nor.array as Float32Array, it.at);
        const k = geoms[it.g].pos.length;
        pos.addUpdateRange(3 * it.at, k); nor.addUpdateRange(3 * it.at, k);
        it.dirty = false;
      }
      pos.needsUpdate = true; nor.needsUpdate = true;
      moved = false;
    }
    if (order) {
      // the shown instances' vertices, in instance order
      const ix = index.array as Uint32Array;
      let n = 0;
      for (const it of inst) if (it.on) for (let v = it.at, e = it.at + geoms[it.g].pos.length / 3; v < e; v++) ix[n++] = v;
      index.clearUpdateRanges(); index.addUpdateRange(0, Math.max(1, n)); index.needsUpdate = true;
      geometry.setDrawRange(0, n);
      order = false;
    }
  };
  mesh.onBeforeRender = flush;

  return {
    object: mesh,
    addGeometry: (b) => geoms.push(b) - 1,
    addInstance: (g) => { built = false; shown++; mesh.visible = true; return inst.push({ g, m: IDENTITY, rgb: null, on: true, at: 0, dirty: false }) - 1; },
    setMatrixAt: (i, m) => {
      const it = inst[i];
      if (it.m.length === m.length && it.m.every((x, k) => x === m[k])) return;
      it.m = [...m]; it.dirty = true; moved = true;
    },
    setColorAt: (i, rgb) => {
      inst[i].rgb = [rgb[0], rgb[1], rgb[2]];
      built = false; // colours are set while building; a later one rebuilds the buffers
    },
    setVisibleAt: (i, v) => {
      const it = inst[i];
      if (it.on === v) return;
      it.on = v; order = true; shown += v ? 1 : -1;
      mesh.visible = shown > 0; // nothing shown: no draw at all (an empty draw still counts)
    },
    flush,
  };
};
