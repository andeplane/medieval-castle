// Pure state of the loading tunnel: how far the displayed progress has eased toward the real one,
// which torches are lit and how bright each is, and how much fill light is up. No DOM, no GL, no
// clock of its own: callers pass `now` (ms), so tests drive it frame by frame.
export const N_TORCH = 8;
/** The last stretch of progress raises the fill light and the daylight at the far grille. */
export const FILL_FROM = 0.93;

/** Progress at which each torch strikes (torch 0 is the farthest), spread evenly up to just before the fill. */
export function torchThresholds(n = N_TORCH, fillFrom = FILL_FROM): number[] {
  if (n === 1) return [0.03];
  return Array.from({ length: n }, (_, i) => 0.03 + (i * (fillFrom - 0.06)) / (n - 1));
}

/** "Cutting the stone… 42%", for assistive tech (the overlay sets step and percent apart). */
export const caption = (label: string, shown: number) => `${label} ${Math.round(shown * 100)}%`;

const smooth = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export interface ModelOpts { fixed?: number; reduced?: boolean; n?: number }

export class LoadingModel {
  readonly n: number;
  readonly thresholds: number[];
  readonly fixed: boolean;
  readonly reduced: boolean;
  target: number;
  shown: number;
  label = 'Down to the cellar…';
  /** ignition time (ms) per torch, null while unlit */
  readonly ignite: (number | null)[];
  /** the boot step running now: progress walks from start to end over its expected duration */
  span: { start: number; end: number; ms: number; t0: number } | null = null;

  constructor(o: ModelOpts = {}) {
    this.n = o.n ?? N_TORCH;
    this.thresholds = torchThresholds(this.n);
    this.fixed = o.fixed !== undefined;
    this.reduced = !!o.reduced;
    this.target = this.shown = clamp01(o.fixed ?? 0);
    this.ignite = new Array(this.n).fill(null);
  }

  /** Raise the target (progress never goes backwards) and optionally change the caption. */
  setTarget(p: number, label?: string) {
    this.target = Math.max(this.target, clamp01(p));
    if (label) this.label = label;
  }

  /** A boot step began at `now`; expected to take `ms` and to cover progress start..end. */
  setSpan(start: number, end: number, ms: number, now: number) {
    this.span = { start, end, ms: Math.max(1, ms), t0: now };
    this.setTarget(start);
  }

  /**
   * Advance by dt seconds at time `now` (ms). The shown value eases toward the target but at least
   * 0.45/s, so torches strike one after another instead of all in one frame.
   */
  tick(now: number, dt: number) {
    if (this.span) this.setTarget(spanProgress(this.span, now));
    if (this.shown < this.target) this.shown = Math.min(this.target, this.shown + Math.max(dt * 0.45, (this.target - this.shown) * dt * 3));
    for (let i = 0; i < this.n; i++) {
      // a fixed preview shows torches already burning steadily
      if (this.ignite[i] === null && this.shown >= this.thresholds[i]) this.ignite[i] = this.fixed ? -Infinity : now;
    }
  }

  /** Torch brightness: a sputtering strike over ~0.55 s that settles to 1. */
  torch(i: number, now: number): number {
    const at = this.ignite[i];
    if (at === null) return 0;
    const a = (now - at) / 1000;
    const ramp = Math.min(1, a / 0.55);
    const sputter = this.reduced || !isFinite(a) ? 1 : 1 + 0.6 * Math.exp(-a * 5) * Math.sin(a * 47) + 0.35 * Math.exp(-a * 3);
    return ramp * ramp * sputter;
  }

  /** Fill light 0..1 over the last stretch of progress. */
  fill(): number { return smooth(clamp01((this.shown - FILL_FROM) / (1 - FILL_FROM))); }

  get percent() { return Math.round(this.shown * 100); }
  get caption() { return caption(this.label, this.shown); }
  get done() { return this.shown >= 1; }
}

/**
 * Progress inside a boot step, proportional to time: linear over the expected duration, then
 * slowing as it nears the step's end (it never reaches it, the next step does), so a step that
 * runs long still moves a little instead of sitting still.
 */
export function spanProgress(s: { start: number; end: number; ms: number; t0: number }, now: number): number {
  const x = Math.max(0, (now - s.t0) / s.ms);
  const f = x < 0.85 ? x : 0.85 + 0.14 * (1 - Math.exp(-(x - 0.85) * 2.5));
  return s.start + (s.end - s.start) * f;
}
