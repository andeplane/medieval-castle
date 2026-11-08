// Eye adaptation (threejs-postprocessing / post-processing.md: exposure is the camera). Every few frames
// the linear HDR scene colour (before tone mapping) is reduced to a 32×18 grid of log-luminance taps,
// read back asynchronously, centre-weighted and averaged; exposure then eases towards a target in log
// space (darker scenes ~1.4 s, brighter ~0.6 s). Outdoors exposure never drops below 0.72; indoors it
// may close one stop more beside a fire (EXPOSURE.minInside), and it rises at most 2.5 stops in rooms, ~3.2 underground. ?exposure=N fixes it; ?shot sets it directly
// from where the camera is (inside / underground / outside) so captures are deterministic.
// The controller takes its collaborators (the luminance reader, the exposure target) as interfaces;
// gpuLumaReader is the real reader.
import * as THREE from 'three/webgpu';
import { texture, uv, vec2, vec4, float, luminance, log2, clamp } from 'three/tsl';
import { EXPOSURE, type ExposureCfg, adaptStops, meanLog2, targetStops } from './interiorMath';

/** Something that can hand back a w×h grid of log-encoded luminance (R channel, 4 bytes per texel). */
export interface LumaReader { w: number; h: number; request(): Promise<ArrayLike<number>> }
export interface ExposureTarget { toneMappingExposure: number }
export interface Where { inside: boolean; deep: boolean }

/** Stops above base used for deterministic captures. */
export const SHOT_STOPS = { inside: 2.5, deep: 3.2 };

export function createAutoExposure(o: { target: ExposureTarget; reader: LumaReader | null; fixed?: number | null; shot?: boolean; every?: number; cfg?: ExposureCfg }) {
  const cfg = o.cfg ?? EXPOSURE, every = o.every ?? 6;
  let frame = 0, pending = false, measured: number | null = null;
  const state = { stops: 0, target: 0, meanLog2: NaN, exposure: cfg.base, samples: 0 };
  const apply = () => { state.exposure = o.fixed ?? cfg.base * Math.pow(2, state.stops); o.target.toneMappingExposure = state.exposure; };
  apply();
  return {
    state,
    /** after the frame's render: occasionally reduce and read back the scene luminance */
    measure(): Promise<void> | null {
      if (o.fixed != null || o.shot || !o.reader || pending || frame++ % every) return null;
      const r = o.reader;
      pending = true;
      return r.request().then((px) => { measured = meanLog2(px, r.w, r.h); state.samples++; }, () => {}).finally(() => { pending = false; });
    },
    /** before the frame's render */
    update(dt: number, where: Where) {
      if (o.fixed == null && o.shot) state.stops = where.deep ? SHOT_STOPS.deep : where.inside ? SHOT_STOPS.inside : 0;
      else if (o.fixed == null) {
        if (measured !== null) { state.meanLog2 = measured; state.target = targetStops(measured, where.deep, cfg, where.inside); }
        state.stops = adaptStops(state.stops, state.target, dt, cfg);
      }
      apply();
    },
  };
}

/** Reduce `source` (linear HDR) to a small log-luminance grid on the GPU and read it back. */
export function gpuLumaReader(renderer: THREE.WebGPURenderer, source: THREE.Texture, w = 32, h = 18): LumaReader {
  const rt = new THREE.RenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false });
  const mat = new THREE.MeshBasicNodeMaterial();
  // 4 taps per cell, log2 luminance encoded to 0..1 over 2^-14 … 2^4
  const t = uv(), off = vec2(0.25 / w, 0.25 / h);
  let s = float(0) as unknown as THREE.Node<'float'>;
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) s = s.add(log2(luminance(texture(source, t.add(off.mul(vec2(dx, dy)))).rgb).max(1e-5)));
  mat.colorNode = vec4(clamp(s.mul(0.25).add(14).div(18), 0, 1), 0, 0, 1);
  const quad = new THREE.QuadMesh(mat);
  return {
    w, h,
    request() {
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      quad.render(renderer);
      renderer.setRenderTarget(prev);
      return renderer.readRenderTargetPixelsAsync(rt, 0, 0, w, h) as Promise<ArrayLike<number>>;
    },
  };
}
