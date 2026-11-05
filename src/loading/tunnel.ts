// Loading screen: a pitch-dark tunnel under the moat where load progress lights the wall torches one
// by one, nearest first, and the last step brings up a soft fill and daylight through the far grille.
// It runs on its own small WebGL2 canvas so it is up within a frame, long before the castle's
// renderer, textures and shaders exist. Without WebGL2 the caption alone carries progress.
// Everything time-, frame- or GPU-related is injected (`LoadingDeps`) so tests drive it directly.
import { LoadingModel } from './model';
import { createTunnelRenderer, type GLLike, type TunnelRenderer, type Palette } from './gl';
import { STONE_GREYS } from '../render/texgen';

export interface LoadingScreen {
  /** Set load progress 0..1 and an optional caption, then yield a frame so the new light is drawn. */
  progress(p: number, label?: string): Promise<void>;
  /** Light the rest, hold a moment, fade out and free the GPU context. */
  finish(): Promise<void>;
  /** Remove at once (captures, errors). */
  dispose(): void;
  readonly shown: number;
}

export interface LoadingDeps {
  now(): number;
  raf(cb: (t: number) => void): number;
  caf(id: number): void;
  wait(ms: number): Promise<void>;
  /** one frame plus a macrotask, so a following synchronous step does not swallow the draw */
  nextFrame(): Promise<void>;
  reducedMotion: boolean;
  viewport(): { w: number; h: number; dpr: number };
  getGL(canvas: HTMLCanvasElement): GLLike | null;
  /** pointer position in -1..1 for a little parallax; returns an unsubscribe */
  onPointer(cb: (x: number, y: number) => void): () => void;
  makeRenderer(gl: GLLike, pal: Palette, reduced: boolean): TunnelRenderer | null;
}

/* v8 ignore start -- thin browser bindings, exercised by the captures */
export const browserDeps = (): LoadingDeps => ({
  now: () => performance.now(),
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  nextFrame: () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))),
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  viewport: () => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }),
  getGL: (c) => c.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' }),
  onPointer: (cb) => {
    const f = (e: PointerEvent) => cb((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1));
    addEventListener('pointermove', f);
    return () => removeEventListener('pointermove', f);
  },
  makeRenderer: createTunnelRenderer,
});
/* v8 ignore stop */

/** The castle's rubble greys (texgen.ts), most common first, and its mortar. */
export const PALETTE: Palette = {
  stone: [...STONE_GREYS.rubble].sort((a, b) => b.w - a.w).slice(0, 6).map((g) => g.c),
  mortar: [0.31, 0.3, 0.28],
};

/** Render at ~0.75 of device pixels (DPR capped at 2): the scene is soft and dark, it upscales well. */
export const renderSize = (v: { w: number; h: number; dpr: number }) => {
  const s = Math.min(v.dpr, 2) * 0.75;
  return { w: Math.max(2, Math.round(v.w * s)), h: Math.max(2, Math.round(v.h * s)) };
};

export function createLoadingScreen(root: HTMLElement, opts: { fixed?: number } = {}, d: LoadingDeps = browserDeps()): LoadingScreen {
  const m = new LoadingModel({ fixed: opts.fixed, reduced: d.reducedMotion });
  const doc = root.ownerDocument;
  root.textContent = '';
  const canvas = doc.createElement('canvas');
  const caption = doc.createElement('div');
  caption.className = 'cap';
  const title = doc.createElement('div');
  title.className = 'title';
  title.textContent = 'MOATED CASTLE';
  const labelEl = doc.createElement('div');
  labelEl.className = 'label';
  caption.append(title, labelEl);
  root.append(canvas, caption);
  root.setAttribute('role', 'progressbar');
  root.setAttribute('aria-valuemin', '0');
  root.setAttribute('aria-valuemax', '100');
  const syncLabel = () => { labelEl.textContent = m.caption; root.setAttribute('aria-valuenow', String(m.percent)); };

  const gl = d.getGL(canvas);
  const renderer = gl ? d.makeRenderer(gl, PALETTE, d.reducedMotion) : null;
  const look: [number, number] = [0, 0];
  const unPointer = d.onPointer((x, y) => { look[0] = x; look[1] = y; });
  const torches = new Float32Array(m.n);
  const t0 = d.now();
  let last = t0, raf = 0, disposed = false;

  const tick = (now: number) => {
    if (disposed) return;
    m.tick(now, Math.min(0.1, Math.max(0, (now - last) / 1000)));
    last = now;
    syncLabel();
    if (renderer) {
      const { w, h } = renderSize(d.viewport());
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      for (let i = 0; i < m.n; i++) torches[i] = m.torch(i, now);
      const f = m.fill();
      // a little daylight at the far grille from the start, so the dark has a direction
      renderer.draw({ w, h, time: (now - t0) / 1000, torches, fill: f * 0.3, day: 0.04 + 0.96 * f, look });
    }
    raf = d.raf(tick);
  };
  raf = d.raf(tick);
  syncLabel();

  const screen: LoadingScreen = {
    get shown() { return m.shown; },
    async progress(p, label) {
      m.setTarget(p, label);
      syncLabel();
      await d.nextFrame();
    },
    async finish() {
      m.setTarget(1, 'The castle awaits');
      while (!disposed && !m.done) await d.nextFrame();
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
      renderer?.dispose();
      root.remove();
    },
  };
  return screen;
}

let single: LoadingScreen | null = null;
/**
 * The page's one loading screen on #loading, shared by entry.ts (which starts it before the main
 * bundle downloads) and main.ts. ?loading=<0..1> holds it at that progress (art review).
 */
export function loadingScreen(search = location.search, el = document.getElementById('loading')!, deps?: LoadingDeps): LoadingScreen {
  if (single) return single;
  const q = new URLSearchParams(search).get('loading');
  single = createLoadingScreen(el, q && q !== 'demo' ? { fixed: Number(q) } : {}, deps);
  return single;
}
/** test hook */
export const resetLoadingScreen = () => { single = null; };
