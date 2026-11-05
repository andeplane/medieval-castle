// Rendering stats over the game (I toggles it, ?stats starts with it shown): fps, frame time, CPU and
// GPU time, draw calls, triangles and the render size. A small fixed chip in the top-right corner,
// out of the way of the tools panel; numbers in tabular figures so they do not jitter. It also shows
// the benchmark's progress and final table. The document is injected (happy-dom in tests).
import type { FrameSummary } from '../render/perf';

export interface RenderInfo { width: number; height: number; pixelRatio: number; backend: string }

export interface StatsOverlay {
  readonly el: HTMLElement;
  readonly visible: boolean;
  setVisible(v: boolean): void;
  toggle(): void;
  /** Redraw from a summary (call a few times a second, not every frame). */
  update(s: FrameSummary, r: RenderInfo): void;
  /** A line under the numbers (benchmark progress), or null. */
  note(text: string | null): void;
  /** A preformatted block under the numbers (the benchmark table), or null. */
  report(text: string | null): void;
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} k` : String(n));

export function statsLines(s: FrameSummary, r: RenderInfo): [string, string][] {
  return [
    ['fps', `${Math.round(s.fps)}`],
    ['frame', `${s.p50.toFixed(1)} ms · p95 ${s.p95.toFixed(1)}`],
    ['cpu', `${s.cpuMs.toFixed(1)} ms`],
    ['gpu', s.gpuMs === null ? 'n/a' : `${s.gpuMs.toFixed(1)} ms`],
    ['draws', fmt(s.drawCalls)],
    ['tris', fmt(s.triangles)],
    ['size', `${r.width}×${r.height} @${r.pixelRatio}`],
    ['api', r.backend],
  ];
}

export function createStatsOverlay(doc: Document, parent: HTMLElement = doc.body, visible = false): StatsOverlay {
  const el = doc.createElement('section');
  el.className = 'stats';
  el.setAttribute('aria-label', 'Rendering stats');
  const dl = doc.createElement('dl');
  const noteEl = doc.createElement('p'); noteEl.className = 'stats-note'; noteEl.hidden = true;
  const pre = doc.createElement('pre'); pre.className = 'stats-report'; pre.hidden = true;
  el.append(dl, noteEl, pre);
  parent.append(el);
  let shown = visible;
  const sync = () => { el.hidden = !shown; };
  sync();
  return {
    el,
    get visible() { return shown; },
    setVisible(v) { shown = v; sync(); },
    toggle() { shown = !shown; sync(); },
    update(s, r) {
      if (!shown) return;
      dl.textContent = '';
      for (const [k, v] of statsLines(s, r)) {
        const dt = doc.createElement('dt'); dt.textContent = k;
        const dd = doc.createElement('dd'); dd.textContent = v;
        dl.append(dt, dd);
      }
    },
    note(text) { noteEl.hidden = text === null; noteEl.textContent = text ?? ''; },
    report(text) { pre.hidden = text === null; pre.textContent = text ?? ''; },
  };
}
