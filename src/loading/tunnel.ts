// Loading screen: a pitch-black tunnel under the moat. Load progress strikes the wall torches one by
// one, starting far down the tunnel and coming toward the viewer; the last stretch brings up a soft
// fill and daylight through the far grille. The tunnel is drawn by a worker on an OffscreenCanvas
// (backend.ts) so it keeps animating while the main thread builds the castle; without workers it
// falls back to the main thread, and without WebGL2 the caption alone carries progress.
// Everything time-, frame-, GPU- or worker-related is injected (`LoadingDeps`).
import { caption } from './model';
import { renderSize } from './loop';
import { createTunnelRenderer, type Palette } from './gl';
import { localBackend, workerBackend, type BackendInit, type TunnelBackend } from './backend';
import type { FromWorker } from './protocol';
import { STONE_GREYS } from '../render/texgen';

export { renderSize };

export interface LoadingScreen {
  /** Set load progress 0..1 and an optional caption, then yield a frame so the page can paint. */
  progress(p: number, label?: string): Promise<void>;
  /** Light the rest, hold a moment, fade out and free the GPU context. */
  finish(): Promise<void>;
  /** Remove at once (captures, errors). */
  dispose(): void;
  readonly shown: number;
}

export interface LoadingDeps {
  raf(cb: (t: number) => void): number;
  caf(id: number): void;
  wait(ms: number): Promise<void>;
  /** one frame plus a macrotask, so a following synchronous step does not swallow the paint */
  nextFrame(): Promise<void>;
  reducedMotion: boolean;
  viewport(): { w: number; h: number; dpr: number };
  /** pointer position in -1..1 for a little parallax; returns an unsubscribe */
  onPointer(cb: (x: number, y: number) => void): () => void;
  /** window resize; returns an unsubscribe */
  onResize(cb: () => void): () => void;
  /** start drawing the tunnel into this canvas */
  backend(canvas: HTMLCanvasElement, init: BackendInit): TunnelBackend;
}

/* v8 ignore start -- thin browser bindings, exercised by the captures */
export function browserBackend(canvas: HTMLCanvasElement, init: BackendInit): TunnelBackend {
  if ('transferControlToOffscreen' in canvas && typeof Worker !== 'undefined') {
    try {
      const w = new Worker(new URL('./tunnel.worker.ts', import.meta.url), { type: 'module' });
      return workerBackend(canvas.transferControlToOffscreen(), {
        post: (m, transfer) => w.postMessage(m, transfer ?? []),
        listen: (onMessage, onError) => { w.onmessage = (e: MessageEvent<FromWorker>) => onMessage(e.data); w.onerror = onError; },
        terminate: () => w.terminate(),
      }, init);
    } catch (e) { console.warn('tunnel worker unavailable, drawing on the main thread', e); }
  }
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
  const clock = { now: () => performance.now(), raf: (cb: (t: number) => void) => requestAnimationFrame(cb), caf: (id: number) => cancelAnimationFrame(id) };
  return localBackend(canvas, gl, init, clock, createTunnelRenderer);
}

export const browserDeps = (): LoadingDeps => ({
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  nextFrame: () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))),
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  viewport: () => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }),
  onPointer: (cb) => {
    const f = (e: PointerEvent) => cb((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1));
    addEventListener('pointermove', f);
    return () => removeEventListener('pointermove', f);
  },
  onResize: (cb) => { addEventListener('resize', cb); return () => removeEventListener('resize', cb); },
  backend: browserBackend,
});
/* v8 ignore stop */

/** The castle's rubble greys (texgen.ts), most common first, and its mortar. */
export const PALETTE: Palette = {
  stone: [...STONE_GREYS.rubble].sort((a, b) => b.w - a.w).slice(0, 6).map((g) => g.c),
  mortar: [0.35, 0.34, 0.31],
};

export function createLoadingScreen(root: HTMLElement, opts: { fixed?: number } = {}, d: LoadingDeps = browserDeps()): LoadingScreen {
  const doc = root.ownerDocument;
  root.textContent = '';
  const canvas = doc.createElement('canvas');
  const cap = doc.createElement('div');
  cap.className = 'cap';
  const title = doc.createElement('div');
  title.className = 'title';
  title.textContent = 'MOATED CASTLE';
  const labelEl = doc.createElement('div');
  labelEl.className = 'label';
  cap.append(title, labelEl);
  root.append(canvas, cap);
  root.setAttribute('role', 'progressbar');
  root.setAttribute('aria-valuemin', '0');
  root.setAttribute('aria-valuemax', '100');

  const sz = renderSize(d.viewport());
  const be = d.backend(canvas, { ...sz, reduced: d.reducedMotion, fixed: opts.fixed, palette: PALETTE });
  let label = 'Down to the cellar…', disposed = false;
  const syncLabel = () => {
    labelEl.textContent = caption(label, be.shown);
    root.setAttribute('aria-valuenow', String(Math.round(be.shown * 100)));
  };
  const unPointer = d.onPointer((x, y) => be.look(x, y));
  const unResize = d.onResize(() => { const s = renderSize(d.viewport()); be.resize(s.w, s.h); });
  // the caption lives in the page, so it only updates when the main thread is free; the tunnel does not wait for it
  let raf = 0;
  const tick = () => { if (disposed) return; syncLabel(); raf = d.raf(tick); };
  raf = d.raf(tick);
  syncLabel();

  const screen: LoadingScreen = {
    get shown() { return be.shown; },
    async progress(p, l) {
      be.progress(p);
      if (l) label = l;
      syncLabel();
      await d.nextFrame();
    },
    async finish() {
      label = 'The castle awaits';
      be.progress(1);
      await be.whenDone();
      syncLabel();
      await d.wait(d.reducedMotion ? 200 : 900);
      root.style.opacity = '0';
      await d.wait(d.reducedMotion ? 0 : 700);
      screen.dispose();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      d.caf(raf);
      unPointer();
      unResize();
      be.dispose();
      root.remove();
    },
  };
  return screen;
}
