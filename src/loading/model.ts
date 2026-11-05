// Pure state of the loading tunnel: how far the displayed progress has eased toward the real one,
// which torches are lit and how bright each is, and how much fill light is up. No DOM, no GL, no
// clock of its own: callers pass `now` (ms), so tests drive it frame by frame.
export const N_TORCH = 8;
/** The last stretch of progress raises the fill light and the daylight at the far grille. */
export const FILL_FROM = 0.93;
/** While waiting on a step, progress creeps at CREEP_RATE per second up to CREEP_MAX past it. */
export const CREEP_RATE = 0.012, CREEP_MAX = 0.07;

/** Progress at which each torch strikes (torch 0 is the farthest), spread evenly up to just before the fill. */
export function torchThresholds(n = N_TORCH, fillFrom = FILL_FROM): number[] {
  if (n === 1) return [0.03];
  return Array.from({ length: n }, (_, i) => 0.03 + (i * (fillFrom - 0.06)) / (n - 1));
}

/** Caption under the title: step label and percent. */
export const caption = (label: string, shown: number) => `${label.toUpperCase()}  ${Math.round(shown * 100)}%`;

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

  /**
   * Advance by dt seconds at time `now` (ms). The shown value eases toward the target but at least
   * 0.45/s, so torches strike one after another instead of all in one frame.
   */
  tick(now: number, dt: number) {
    if (this.shown < this.target) this.shown = Math.min(this.target, this.shown + Math.max(dt * 0.45, (this.target - this.shown) * dt * 3));
    else if (!this.fixed && this.target < 1) {
      // creep a little past the last real step while the main thread is busy, so a long step
      // (shader compile) still brings the next light closer; never into the final fill
      const ceil = Math.min(this.target + CREEP_MAX, FILL_FROM - 0.001);
      if (this.shown < ceil) this.shown = Math.min(ceil, this.shown + dt * CREEP_RATE);
    }
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

/** Progress for each boot step label in main.ts; unknown labels (new steps) advance a little. */
export const BOOT_STEPS: Record<string, number> = {
  'CUTTING THE STONE…': 0.06, 'RAISING THE WALLS…': 0.62, 'SHAPING THE LAND…': 0.74, 'PLANTING TREES…': 0.82, 'LIGHTING…': 0.9,
};
export function stepProgress(label: string, shown: number): number {
  return BOOT_STEPS[label] ?? shown + (0.92 - shown) * 0.3;
}
/** Texture jobs fill the stretch between CUTTING THE STONE and RAISING THE WALLS. */
export const textureProgress = (done: number, total: number) => 0.06 + (0.56 * done) / Math.max(1, total);
