// The AO pre-pass's camera (main.ts). Half-resolution GTAO turns to noise far away, so the scene pass fades
// the AO out between 110 m and AO_FADE and uses none beyond. The pre-pass drew the whole view anyway, out
// to the horizon: at the hero view a third of the frame's triangles went into normals and depth that no
// pixel used. Its camera is now the view's with the far plane just past AO_FADE: three's frustum culling
// skips whatever lies wholly beyond, and a pixel the pre-pass leaves empty is one the AO does not reach.
// Only the AO's input changes; what the view draws is untouched.
import type * as THREE from 'three/webgpu';
import { FX_LAYER } from './passLayers';

/** View depth (m) beyond which the scene pass uses no AO at all. */
export const AO_FADE = 260;
/** The pre-pass's far plane: a little past AO_FADE, so every pixel the AO still reaches has its depth. */
export const AO_FAR = AO_FADE + 15;

/** Make `to` the view camera `from` with the pre-pass's far plane and without FX_LAYER (call before each pre-pass render). */
export function aoCamera(from: THREE.PerspectiveCamera, to: THREE.PerspectiveCamera): void {
  to.copy(from, false);
  to.far = Math.min(from.far, AO_FAR);
  to.layers.disable(FX_LAYER);
  to.updateProjectionMatrix();
  to.updateMatrixWorld();
}
