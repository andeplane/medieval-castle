// window.__game contract (game-debug-tools recipe A), trimmed to what an exterior review needs:
// readiness, compact state, camera bookmarks, time of day and manual stepping for captures.
import type * as THREE from 'three/webgpu';
import type { CameraRig } from '../camera/controls';
import { VIEWS } from '../camera/controls';

export interface HookDeps {
  renderer: THREE.WebGPURenderer; camera: THREE.PerspectiveCamera; rig: CameraRig;
  setTime(h: number): void; getTime(): number; renderNow(): Promise<void>; stats(): Record<string, unknown>;
  /** Advance game systems (doors…) by dt without rendering. */
  tick?(dt: number): void;
  /** Use whatever is under the crosshair (E). */
  use?(): boolean;
  doors?: { state(): Record<string, number>; setOpen(id: string, open: boolean, instant?: boolean): void };
}

const r = (n: number) => Math.round(n * 100) / 100;
const errors: string[] = [];
addEventListener('error', (e) => errors.push(String(e.message)));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

export function installHooks(d: HookDeps) {
  const hooks = {
    version: 1,
    ready: false,
    state: () => ({
      coords: 'x east, y up, z south, metres; moat water at y=0, island ground ~2.6',
      camera: { mode: d.rig.mode, x: r(d.camera.position.x), y: r(d.camera.position.y), z: r(d.camera.position.z) },
      time: d.getTime(),
      backend: (d.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2',
      ...d.stats(),
      errors: errors.slice(-5),
    }),
    views: () => VIEWS.map((v) => v.name),
    setCamera: (name: string) => { const v = VIEWS.find((x) => x.name === name); if (v) d.rig.go(v); return !!v; },
    setTime: (h: number) => d.setTime(h),
    step: async (n = 1) => { for (let i = 0; i < n; i++) { d.rig.update(1 / 60); d.tick?.(1 / 60); await d.renderNow(); } },
    /** Use what the crosshair is on; returns whether anything was used. */
    use: () => d.use?.() ?? false,
    /** Doors: state() = openness 0..1 per id; setOpen(id, open, instant); tick(seconds) advances without rendering. */
    doors: d.doors && {
      state: () => d.doors!.state(),
      setOpen: (id: string, open: boolean, instant = false) => d.doors!.setOpen(id, open, instant),
      tick: (seconds = 1) => { for (let t = 0; t < seconds; t += 1 / 60) d.tick?.(1 / 60); return d.doors!.state(); },
    },
  };
  const w = window as unknown as Record<string, unknown>;
  w.__game = hooks;
  w.render_game_to_text = () => JSON.stringify(hooks.state());
  return hooks;
}
