// The tunnel's frame loop: tick the model, draw the renderer. The same loop runs inside the worker
// (normal case, so a busy main thread cannot freeze it) or on the main thread as a fallback.
import { LoadingModel } from './model';
import type { TunnelRenderer } from './gl';

export interface Clock {
  now(): number;
  raf(cb: (t: number) => void): number;
  caf(id: number): void;
}

export interface LoopOpts {
  model: LoadingModel;
  renderer: TunnelRenderer | null;
  clock: Clock;
  /** current drawing-buffer size; the loop resizes the canvas through setSize when it changes */
  size(): { w: number; h: number };
  /** raw pointer target in -1..1; the camera eases toward it (followLook) */
  look: readonly [number, number];
  /** after every frame (worker: report progress to the page) */
  onFrame?(m: LoadingModel): void;
  /** minimum ms between draws; the tunnel is slow and soft, 30 fps leaves the GPU to the castle */
  minFrameMs?: number;
}

export function startLoop(o: LoopOpts): () => void {
  const { model: m, renderer, clock } = o;
  const torches = new Float32Array(m.n);
  const t0 = clock.now();
  const minMs = o.minFrameMs ?? 30;
  const look: [number, number] = [o.look[0], o.look[1]];
  let last = t0, lastDraw = -Infinity, raf = 0, stopped = false;
  const tick = (now: number) => {
    if (stopped) return;
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    m.tick(now, dt);
    followLook(look, o.look, dt);
    last = now;
    if (renderer && now - lastDraw >= minMs) {
      lastDraw = now;
      const { w, h } = o.size();
      for (let i = 0; i < m.n; i++) torches[i] = m.torch(i, now);
      const f = m.fill();
      // fully dark at first; the fill and the daylight at the grille only come up at the end
      renderer.draw({ w, h, time: (now - t0) / 1000, torches, fill: f * 0.3, day: f, look });
    }
    o.onFrame?.(m);
    raf = clock.raf(tick);
  };
  raf = clock.raf(tick);
  return () => { stopped = true; clock.caf(raf); };
}

/** Render at half the device pixels (DPR capped at 2): the scene is soft and dark, it upscales well. */
export const renderSize = (v: { w: number; h: number; dpr: number }) => {
  const s = Math.min(v.dpr, 2) * 0.5;
  return { w: Math.max(2, Math.round(v.w * s)), h: Math.max(2, Math.round(v.h * s)) };
};

/**
 * Ease the camera's look toward the pointer (in place), so the view drifts after the mouse instead
 * of snapping; pointer moves from a busy main thread arrive in bursts and this smooths them too.
 * Exponential, frame-rate independent: about 63% of the way in 1/rate seconds.
 */
export function followLook(cur: [number, number], target: readonly [number, number], dt: number, rate = 3) {
  const k = 1 - Math.exp(-rate * dt);
  cur[0] += (target[0] - cur[0]) * k;
  cur[1] += (target[1] - cur[1]) * k;
  return cur;
}
