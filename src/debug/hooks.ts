// window.__game contract (game-debug-tools recipe A), trimmed to what an exterior review needs:
// readiness, compact state, camera bookmarks, time of day and manual stepping for captures, plus the
// player: __game.player (pos, teleport, look, state) and __game.input(keys, ms) for scripted walks.
import type * as THREE from 'three/webgpu';
import type { CameraRig } from '../camera/controls';
import { VIEWS } from '../camera/controls';
import type { Physics } from '../physics/world';
import type { PlayerController } from '../player/controller';
import type { ScriptedInput } from '../player/input';

export interface HookDeps {
  renderer: THREE.WebGPURenderer; camera: THREE.PerspectiveCamera; rig: CameraRig;
  setTime(h: number): void; getTime(): number; renderNow(): Promise<void>; stats(): Record<string, unknown>;
  tick(dt: number): void;
  physics: Physics; player: PlayerController; input: ScriptedInput;
  course: unknown; interior: unknown;
}

const r = (n: number) => Math.round(n * 100) / 100;
const errors: string[] = [];
addEventListener('error', (e) => errors.push(String(e.message)));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

export function installHooks(d: HookDeps) {
  const { player, physics, input } = d;
  const hooks = {
    version: 2,
    ready: false,
    state: () => ({
      coords: 'x east, y up, z south, metres; moat water at y=0, island ground ~2.6',
      camera: { mode: d.rig.mode, x: r(d.camera.position.x), y: r(d.camera.position.y), z: r(d.camera.position.z), fov: r(d.camera.fov) },
      player: player.state(),
      time: d.getTime(),
      backend: (d.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2',
      ...d.stats(),
      errors: errors.slice(-5),
    }),
    views: () => VIEWS.map((v) => v.name),
    setCamera: (name: string) => { const v = VIEWS.find((x) => x.name === name); if (v) d.rig.go(v); return !!v; },
    setMode: (m: 'orbit' | 'fly' | 'walk') => d.rig.setMode(m),
    setTime: (h: number) => d.setTime(h),
    step: async (n = 1) => { for (let i = 0; i < n; i++) { d.tick(1 / 60); await d.renderNow(); } },
    player: {
      get pos() { return [...player.feet]; },
      /** Feet at (x, y, z); y omitted or null → the ground under (x, z). Switches to walk mode. */
      teleport(x: number, y: number | null, z: number, yaw?: number, pitch?: number) {
        if (d.rig.mode !== 'walk') d.rig.setMode('walk');
        const yy = y ?? player.groundAt(x, z, 80, 0);
        player.teleport(x, yy, z, yaw, pitch);
        player.frame(1, 1);
        return player.state();
      },
      look(yaw: number, pitch = 0) { player.yaw = yaw; player.pitch = pitch; },
      state: () => player.state(),
      spawn: () => { d.rig.toSpawn(); return player.state(); },
    },
    /**
     * Hold `keys` (KeyboardEvent.code, e.g. ['KeyW', 'ShiftLeft']) for `ms` of simulated time, stepping
     * physics synchronously at 60 Hz without rendering. Returns the player state plus timings and a
     * trace of [x, y, z, grounded] every `traceEvery` ticks.
     */
    input(keys: string[], ms: number, opts: { traceEvery?: number } = {}) {
      if (d.rig.mode !== 'walk') d.rig.setMode('walk');
      input.hold(keys);
      const n = Math.max(1, Math.round(ms / (1000 / 60)));
      const trace: [number, number, number, boolean][] = [];
      let groundedTicks = 0, maxMs = 0, sum = 0;
      for (let i = 0; i < n; i++) {
        const t = performance.now();
        physics.tick();
        const dt = performance.now() - t; sum += dt; maxMs = Math.max(maxMs, dt);
        if (player.grounded) groundedTicks++;
        if (opts.traceEvery && i % opts.traceEvery === 0) trace.push([r(player.feet[0]), r(player.feet[1]), r(player.feet[2]), player.grounded]);
      }
      input.hold([]);
      d.rig.update(1 / 60);
      return { ...player.state(), ticks: n, groundedFrac: groundedTicks / n, tickMs: sum / n, tickMsMax: maxMs, trace };
    },
    physics: { stats: () => physics.stats(), raycast: physics.raycast.bind(physics) },
    course: d.course,
    interior: d.interior,
  };
  const w = window as unknown as Record<string, unknown>;
  // keep anything another module already published (e.g. __game.interior from the shell)
  const prev = (w.__game ?? {}) as Record<string, unknown>;
  w.__game = Object.assign(prev, hooks);
  w.render_game_to_text = () => JSON.stringify(hooks.state());
  return w.__game as typeof hooks;
}
