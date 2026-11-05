// Eye adaptation (threejs-postprocessing / post-processing.md: exposure is the camera). Every few frames
// the linear HDR scene colour (before tone mapping) is reduced to a 32×18 grid of log-luminance taps,
// read back asynchronously, centre-weighted and averaged; exposure then eases towards a target in log
// space (darker scenes ~1.4 s, brighter ~0.6 s). Exposure never drops below the exterior's 0.72 and
// rises at most 2.5 stops in rooms, ~3 stops underground. ?exposure=N fixes it; ?shot sets it directly
// from where the camera is (inside / underground / outside) so captures are deterministic.
import * as THREE from 'three/webgpu';
import { texture, uv, vec2, vec4, float, luminance, log2, clamp, Fn } from 'three/tsl';
import { EXPOSURE, adaptStops, meanLog2, targetStops } from './interiorMath';

const GW = 32, GH = 18, EVERY = 6;

export interface Where { inside: boolean; deep: boolean }

export function createAutoExposure(renderer: THREE.WebGPURenderer, source: () => THREE.Texture, opts: { fixed?: number | null; shot?: boolean } = {}) {
  const rt = new THREE.RenderTarget(GW, GH, { type: THREE.UnsignedByteType, depthBuffer: false });
  const srcTex = source();
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = Fn(() => {
    // 4 taps per cell, log2 of luminance, encoded to 0..1 over 2^-14 … 2^4
    const t = uv(), o = vec2(0.25 / GW, 0.25 / GH);
    let s: THREE.Node<'float'> = float(0) as unknown as THREE.Node<'float'>;
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) s = s.add(log2(luminance(texture(srcTex, t.add(o.mul(vec2(dx, dy)))).rgb).max(1e-5)));
    return vec4(clamp(s.mul(0.25).add(14).div(18), 0, 1), 0, 0, 1);
  })();
  const quad = new THREE.QuadMesh(mat);
  let frame = 0, pending = false, measured: number | null = null;
  const state = { stops: 0, target: 0, meanLog2: NaN, exposure: EXPOSURE.base };
  const apply = () => { state.exposure = opts.fixed ?? EXPOSURE.base * Math.pow(2, state.stops); renderer.toneMappingExposure = state.exposure; };
  apply();

  return {
    state,
    /** after the frame's render: occasionally reduce and read back the scene luminance */
    measure() {
      if (opts.fixed != null || opts.shot || pending || frame++ % EVERY) return;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      quad.render(renderer);
      renderer.setRenderTarget(prev);
      pending = true;
      renderer.readRenderTargetPixelsAsync(rt, 0, 0, GW, GH).then((px) => { measured = meanLog2(px as Uint8Array, GW, GH); }).catch(() => {}).finally(() => { pending = false; });
    },
    /** before the frame's render */
    update(dt: number, where: Where) {
      if (opts.fixed != null) return apply();
      if (opts.shot) {
        // deterministic captures: the adapted value for where the camera is
        state.stops = where.deep ? 2.9 : where.inside ? 2.1 : 0;
        return apply();
      }
      if (measured !== null) { state.meanLog2 = measured; state.target = targetStops(measured, where.deep); }
      state.stops = adaptStops(state.stops, state.target, dt);
      apply();
    },
  };
}
