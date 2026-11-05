// Boot steps on a time axis, so the tunnel's progress moves in proportion to time instead of
// jumping per step and then waiting (e.g. sitting at 90 % through the shader compile). Each step
// gets a share of the bar equal to its expected duration: the duration it took on this device last
// time (kept in local storage), or a default on the first visit.
import { FILL_FROM } from './model';

/** Boot steps in order, as main.ts names them (matched without regard to case). */
export const STEPS = [
  'Down to the cellar…',      // the main bundle downloads
  'Cutting the stone…', 'Raising the walls…', 'Furnishing the rooms…', 'Shaping the land…',
  'Planting trees…', 'Laying the floors…', 'Lighting the halls…',
] as const;

/** First-visit guesses (ms) for a fast desktop; replaced by measurements after one load. */
export const DEFAULT_MS: Record<string, number> = {
  'down to the cellar…': 2000, 'cutting the stone…': 2500, 'raising the walls…': 1500, 'furnishing the rooms…': 800,
  'shaping the land…': 1200, 'planting trees…': 1200, 'laying the floors…': 600, 'lighting the halls…': 3500,
};

export interface TimeStore { load(): Record<string, number> | null; save(ms: Record<string, number>): void }
export interface Span { start: number; end: number; ms: number }

const key = (label: string) => label.toLowerCase();

export class Timeline {
  private readonly expected: Record<string, number>;
  private readonly spans = new Map<string, Span>();
  private readonly measured: Record<string, number> = {};
  private current: string;
  private t0: number;

  constructor(private now: () => number, private store: TimeStore | null, steps: readonly string[] = STEPS) {
    const saved = store?.load() ?? {};
    this.expected = {};
    for (const s of steps) {
      const k = key(s), v = saved[k];
      this.expected[k] = typeof v === 'number' && v > 0 && v < 120_000 ? v : (DEFAULT_MS[k] ?? 1000);
    }
    // bar shares up to the final fill, in proportion to expected time
    const total = steps.reduce((a, s) => a + this.expected[key(s)], 0);
    let acc = 0;
    for (const s of steps) {
      const k = key(s), ms = this.expected[k];
      this.spans.set(k, { start: (acc / total) * FILL_FROM, end: ((acc + ms) / total) * FILL_FROM, ms });
      acc += ms;
    }
    this.current = key(steps[0]);
    this.t0 = now();
  }

  /** The step that runs from construction (the download). */
  first(): Span { return this.spans.get(this.current)!; }

  /** A new step began. Returns its span, or null for a label not in the plan (it stays in the current step). */
  enter(label: string): Span | null {
    const k = key(label), span = this.spans.get(k);
    if (!span || k === this.current) return null;
    this.close();
    this.current = k;
    return span;
  }

  /** Boot finished: record the last step and remember this device's timings (averaged with last time). */
  finish() {
    this.close();
    if (!this.store) return;
    const out: Record<string, number> = {};
    for (const [k, ms] of Object.entries(this.measured)) out[k] = Math.round(this.expected[k] * 0.3 + ms * 0.7);
    this.store.save(out);
  }

  private close() {
    const t = this.now();
    this.measured[this.current] = (this.measured[this.current] ?? 0) + (t - this.t0);
    this.t0 = t;
  }
}

/** localStorage-backed store; any storage failure just means default timings. */
export function localTimeStore(storage: Pick<Storage, 'getItem' | 'setItem'> | null, name = 'moated-castle:boot-ms:v1'): TimeStore {
  return {
    load: () => {
      try { const v = JSON.parse(storage?.getItem(name) ?? 'null'); return v && typeof v === 'object' ? v : null; } catch { return null; }
    },
    save: (ms) => { try { storage?.setItem(name, JSON.stringify(ms)); } catch { /* private mode, quota: ignore */ } },
  };
}
