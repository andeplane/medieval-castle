// Where the tunnel is drawn. Normally in a worker (OffscreenCanvas), so a busy main thread cannot
// freeze it; otherwise on the main thread. Both expose the same small interface to the screen.
import { LoadingModel } from './model';
import { startLoop, type Clock } from './loop';
import type { GLLike, Palette, TunnelRenderer } from './gl';
import type { FromWorker, ToWorker } from './protocol';

export interface TunnelBackend {
  readonly shown: number;
  /** true when drawing in a worker */
  readonly offThread: boolean;
  progress(p: number): void;
  look(x: number, y: number): void;
  resize(w: number, h: number): void;
  /** resolves once the shown progress has reached 1 */
  whenDone(): Promise<void>;
  dispose(): void;
}

export interface BackendInit { w: number; h: number; reduced: boolean; fixed?: number; palette: Palette }

function doneSignal() {
  let resolve!: () => void, fired = false;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, fire: () => { if (!fired) { fired = true; resolve(); } } };
}

/** Main-thread fallback (no OffscreenCanvas or no workers). */
export function localBackend(canvas: { width: number; height: number }, gl: GLLike | null, init: BackendInit, clock: Clock,
  makeRenderer: (gl: GLLike, pal: Palette, reduced: boolean) => TunnelRenderer | null): TunnelBackend {
  const m = new LoadingModel({ fixed: init.fixed, reduced: init.reduced });
  const renderer = gl ? makeRenderer(gl, init.palette, init.reduced) : null;
  const size = { w: init.w, h: init.h };
  const look: [number, number] = [0, 0];
  const done = doneSignal();
  const stop = startLoop({
    model: m, renderer, clock, look,
    size: () => { if (canvas.width !== size.w || canvas.height !== size.h) { canvas.width = size.w; canvas.height = size.h; } return size; },
    onFrame: (mm) => { if (mm.done) done.fire(); },
  });
  return {
    get shown() { return m.shown; },
    offThread: false,
    progress: (p) => m.setTarget(p),
    look: (x, y) => { look[0] = x; look[1] = y; },
    resize: (w, h) => { size.w = w; size.h = h; },
    whenDone: () => done.promise,
    dispose: () => { stop(); renderer?.dispose(); },
  };
}

export interface WorkerLike {
  post(m: ToWorker, transfer?: Transferable[]): void;
  listen(onMessage: (m: FromWorker) => void, onError: (e: unknown) => void): void;
  terminate(): void;
}

/** Tunnel drawn by a worker on a transferred OffscreenCanvas. */
export function workerBackend(offscreen: OffscreenCanvas, w: WorkerLike, init: BackendInit): TunnelBackend {
  let shown = init.fixed ?? 0, target = shown, blind = false;
  const done = doneSignal();
  // without a worker-side GL context the caption alone shows progress, so follow the target directly
  const goBlind = () => { blind = true; shown = target; if (shown >= 1) done.fire(); };
  w.listen((data) => {
    if (data.t === 'nogl') goBlind();
    else { shown = data.v; if (shown >= 1) done.fire(); }
  }, () => goBlind());
  w.post({ t: 'init', canvas: offscreen, w: init.w, h: init.h, reduced: init.reduced, fixed: init.fixed, palette: init.palette }, [offscreen]);
  return {
    get shown() { return shown; },
    offThread: true,
    progress: (p) => {
      target = Math.max(target, Math.min(1, p));
      if (blind) goBlind(); else w.post({ t: 'progress', p });
    },
    look: (x, y) => w.post({ t: 'look', x, y }),
    resize: (ww, hh) => w.post({ t: 'size', w: ww, h: hh }),
    whenDone: () => done.promise,
    dispose: () => { w.post({ t: 'stop' }); w.terminate(); },
  };
}
