// window.__game contract (game-debug-tools recipe A), trimmed to what an exterior review needs:
// readiness, compact state, camera bookmarks, time of day and manual stepping for captures, plus the
// player: __game.player (pos, teleport, look, state) and __game.input(keys, ms) for scripted walks.
import type * as THREE from 'three/webgpu';
import type { CameraRig } from '../camera/controls';
import { VIEWS } from '../camera/controls';
import type { Physics } from '../physics/world';
import type { PlayerController } from '../player/controller';
import type { ScriptedInput } from '../player/input';
import type { Clock } from '../core/clock';

/** The window the hooks live on (injected; tests pass a fake). */
export interface HookWindow {
  addEventListener(type: 'error', l: (e: { message: string }) => void): void;
  addEventListener(type: 'unhandledrejection', l: (e: { reason: unknown }) => void): void;
  __game?: unknown; render_game_to_text?: () => string;
}

export interface HookDeps {
  renderer: Pick<THREE.WebGPURenderer, 'backend'>; camera: THREE.PerspectiveCamera; rig: CameraRig;
  setTime(h: number): void; getTime(): number; renderNow(): Promise<void>; stats(): Record<string, unknown>;
  /** Advance a frame of game systems (physics, which steps the doors; the camera) without rendering. */
  tick(dt: number): void;
  physics: Physics; player: PlayerController; input: ScriptedInput;
  course: unknown; interior: unknown;
  /** Plain data for scripts (outlines, gate frame, bridge) so tests can check positions. */
  probes?: Record<string, unknown>;
  /** Use whatever is under the crosshair (E). */
  use?(): boolean;
  doors?: { state(): Record<string, number>; setOpen(id: string, open: boolean, instant?: boolean): void };
}

const r = (n: number) => Math.round(n * 100) / 100;

export function installHooks(d: HookDeps, w: HookWindow, clock: Clock) {
  const { player, physics, input } = d;
  const errors: string[] = [];
  w.addEventListener('error', (e) => errors.push(String(e.message)));
  w.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
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
    /** Free camera for close-up checks: __game.lookFrom([x, y, z], [tx, ty, tz]). */
    lookFrom: (pos: [number, number, number], target: [number, number, number], mode: 'orbit' | 'fly' | 'walk' = 'fly') => {
      d.rig.go({ name: 'custom', label: 'Custom', mode, pos, target });
      if (mode === 'fly') d.camera.position.set(...pos); // go() lets the orbit control clamp to its 8 m minimum; same ray, so the look direction holds
    },
    /** free camera pose for close-up material checks: setPose([x,y,z],[tx,ty,tz]) */
    setPose: (pos: [number, number, number], target: [number, number, number]) => {
      d.rig.go({ name: 'pose', label: 'pose', mode: 'fly', pos, target });
      d.camera.position.set(...pos);
    },
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
        const t = clock.now();
        physics.tick();
        const dt = clock.now() - t; sum += dt; maxMs = Math.max(maxMs, dt);
        if (player.grounded) groundedTicks++;
        if (opts.traceEvery && i % opts.traceEvery === 0) trace.push([r(player.feet[0]), r(player.feet[1]), r(player.feet[2]), player.grounded]);
      }
      input.hold([]);
      d.rig.update(1 / 60);
      return { ...player.state(), ticks: n, groundedFrac: groundedTicks / n, tickMs: sum / n, tickMsMax: maxMs, trace };
    },
    physics: { stats: () => physics.stats(), raycast: physics.raycast.bind(physics) },
    course: d.course,
    probes: d.probes ?? {},
    interior: d.interior,
    /** Use what the crosshair is on; returns whether anything was used. */
    use: () => d.use?.() ?? false,
    /** Doors: state() = openness 0..1 per id; setOpen(id, open, instant); tick(seconds) advances without rendering. */
    doors: d.doors && {
      state: () => d.doors!.state(),
      setOpen: (id: string, open: boolean, instant = false) => d.doors!.setOpen(id, open, instant),
      tick: (seconds = 1) => { for (let t = 0; t < seconds; t += 1 / 60) d.tick(1 / 60); return d.doors!.state(); },
    },
  };
  // keep anything another module already published (e.g. __game.interior from the shell)
  const game = Object.assign((w.__game ?? {}) as Record<string, unknown>, hooks) as typeof hooks;
  w.__game = game;
  w.render_game_to_text = () => JSON.stringify(hooks.state());
  return game;
}
