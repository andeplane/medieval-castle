// What the page entry does: light the tunnel at once, then fetch and boot the castle (main.ts, the
// big chunk) behind it. ?loading=demo loops a fake load for review; ?loading=<0..1> holds a value.
import type { LoadingScreen } from './tunnel';

/** ?loading=<0..1> holds the tunnel at that progress (art review); demo or absent is a live load. */
export function screenOpts(search: string): { fixed?: number } {
  const q = new URLSearchParams(search).get('loading');
  return q && q !== 'demo' ? { fixed: Number(q) } : {};
}

export interface EntryDeps {
  search: string;
  screen(opts: { fixed?: number }): LoadingScreen;
  /** fetch the castle chunk and boot it behind this screen */
  bootGame(screen: LoadingScreen): Promise<unknown>;
  every(ms: number, f: () => void): void;
  reload(): void;
}

export function start(d: EntryDeps) {
  const screen = d.screen(screenOpts(d.search));
  const preview = new URLSearchParams(d.search).get('loading');
  if (preview === null) { void d.bootGame(screen); return 'boot'; }
  if (preview === 'demo') {
    let p = 0;
    d.every(400, () => {
      p += 0.04;
      if (p > 1.5) d.reload();
      else void screen.progress(Math.min(1, p), p < 0.6 ? 'Cutting the stone…' : p < 0.9 ? 'Raising the walls…' : 'Lighting…');
    });
    return 'demo';
  }
  return 'hold';
}
