// How many GPU draws (and triangles) three r187's WebGPU backend issues for a scene from one camera, counted from the
// scene graph without a renderer (tests/drawBudget.test.ts holds the budget). It follows three's
// StandardDrawingPipeline.project: hidden objects and their children are skipped, an object is drawn
// only when its layers meet the camera's and, if frustumCulled, its bounds meet the frustum; a mesh with
// a material array draws once per geometry group. WebGPU has no multi-draw, so a BatchedMesh costs one
// drawIndexed per run of shown instances that share a geometry (WebGPUBackend.draw), not one: that is
// how the door batches cost ~600 of Anders' 1180 draw calls at the hero view (2026-11-08).
import * as THREE from 'three/webgpu';

export interface DrawCount {
  /** GPU draw calls for this pass. */
  draws: number;
  /** Draws by top-level object under the root (its name, or its type). */
  byGroup: Record<string, number>;
  /** Triangles for this pass, as three's renderer.info counts them (instances × index or vertex count / 3). */
  triangles: number;
  /** Triangles by top-level object. */
  trisByGroup: Record<string, number>;
}

type Batched = THREE.BatchedMesh & {
  _updateDrawParameters(c: THREE.Camera, g: THREE.BufferGeometry, m: THREE.Material, f: string): void;
  _mergedDrawCount: number;
};

const NONE = { draws: 0, tris: 0 };

/** Draws and triangles of one object of its own (children apart). */
function drawsOf(o: THREE.Object3D, camera: THREE.Camera, shadow: boolean): { draws: number; tris: number } {
  const m = o as THREE.Mesh;
  if (!(m.isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite)) return NONE;
  if (shadow && !o.castShadow) return NONE;
  if (o.frustumCulled) {
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    if (!o.intersectsFrustum(frustum)) return NONE;
  }
  if ((o as THREE.BatchedMesh).isBatchedMesh) {
    const b = o as Batched;
    b._updateDrawParameters(camera, b.geometry, b.material as THREE.Material, 'merged');
    return { draws: b._mergedDrawCount, tris: 0 }; // (none in the castle any more: doorBatch.ts)
  }
  if (!m.isMesh) return { draws: (m.material as THREE.Material).visible ? 1 : 0, tris: 0 };
  const g = m.geometry, n = g.index ? g.index.count : (g.attributes.position?.count ?? 0);
  const ig = g as THREE.InstancedBufferGeometry;
  const inst = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : ig.isInstancedBufferGeometry && Number.isFinite(ig.instanceCount) ? ig.instanceCount : 1;
  const range = (start: number, count: number) => Math.max(0, Math.min(n, start + count, g.drawRange.start + g.drawRange.count) - Math.max(start, g.drawRange.start));
  if (Array.isArray(m.material)) {
    const shown = g.groups.filter((x) => (m.material as THREE.Material[])[x.materialIndex ?? 0]?.visible);
    return { draws: shown.length, tris: shown.reduce((t, x) => t + Math.floor(range(x.start, x.count) / 3) * inst, 0) };
  }
  return (m.material as THREE.Material).visible ? { draws: 1, tris: Math.floor(range(0, Infinity) / 3) * inst } : NONE;
}

/**
 * The draws of `root` from `camera` in one pass. `shadow`: a shadow map's pass, where only casters draw.
 * Matrices must be current (root.updateMatrixWorld(), camera.updateMatrixWorld()).
 */
export function countDraws(root: THREE.Object3D, camera: THREE.Camera, shadow = false): DrawCount {
  const byGroup: Record<string, number> = {}, trisByGroup: Record<string, number> = {};
  let draws = 0, triangles = 0;
  const walk = (o: THREE.Object3D, top: string) => {
    if (!o.visible) return;
    const n = o.layers.test(camera.layers) ? drawsOf(o, camera, shadow) : NONE;
    if (n.draws) { draws += n.draws; byGroup[top] = (byGroup[top] ?? 0) + n.draws; }
    if (n.tris) { triangles += n.tris; trisByGroup[top] = (trisByGroup[top] ?? 0) + n.tris; }
    for (const c of o.children) walk(c, top);
  };
  if (root.visible) for (const c of root.children) walk(c, c.name || c.type);
  return { draws, byGroup, triangles, trisByGroup };
}
