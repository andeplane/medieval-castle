// How many GPU draws three r187's WebGPU backend issues for a scene from one camera, counted from the
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
}

type Batched = THREE.BatchedMesh & {
  _updateDrawParameters(c: THREE.Camera, g: THREE.BufferGeometry, m: THREE.Material, f: string): void;
  _mergedDrawCount: number;
};

/** Draws of one object of its own (children apart). */
function drawsOf(o: THREE.Object3D, camera: THREE.Camera, shadow: boolean): number {
  const m = o as THREE.Mesh;
  if (!(m.isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite)) return 0;
  if (shadow && !o.castShadow) return 0;
  if (o.frustumCulled) {
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    if (!o.intersectsFrustum(frustum)) return 0;
  }
  if ((o as THREE.BatchedMesh).isBatchedMesh) {
    const b = o as Batched;
    b._updateDrawParameters(camera, b.geometry, b.material as THREE.Material, 'merged');
    return b._mergedDrawCount;
  }
  if (Array.isArray(m.material)) return m.geometry.groups.filter((g) => (m.material as THREE.Material[])[g.materialIndex ?? 0]?.visible).length;
  return (m.material as THREE.Material).visible ? 1 : 0;
}

/**
 * The draws of `root` from `camera` in one pass. `shadow`: a shadow map's pass, where only casters draw.
 * Matrices must be current (root.updateMatrixWorld(), camera.updateMatrixWorld()).
 */
export function countDraws(root: THREE.Object3D, camera: THREE.Camera, shadow = false): DrawCount {
  const byGroup: Record<string, number> = {};
  let draws = 0;
  const walk = (o: THREE.Object3D, top: string) => {
    if (!o.visible) return;
    const n = o.layers.test(camera.layers) ? drawsOf(o, camera, shadow) : 0;
    if (n) { draws += n; byGroup[top] = (byGroup[top] ?? 0) + n; }
    for (const c of o.children) walk(c, top);
  };
  if (root.visible) for (const c of root.children) walk(c, c.name || c.type);
  return { draws, byGroup };
}
