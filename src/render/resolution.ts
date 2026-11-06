// Dynamic resolution (game-performance-optimization): the frame is pixel-bound on retina screens, so
// the render pixel ratio follows the GPU's load. Once a second it looks at the GPU time per frame
// (timestamp queries; the frame time when there are none) and steps the ratio down when a frame
// costs more than the budget, or back up when there is plenty of headroom. Steps are coarse and
// changes are spaced out (quicker down than up), because each one reallocates the render targets. Pure: the page feeds it
// load samples and applies the ratio it returns.

export interface ResolutionOptions {
  /** highest ratio (the screen's, capped) and lowest */
  max: number; min: number;
  step: number;
  /** frame budget in ms (16.7 = 60 fps) */
  budgetMs: number;
  /** step up only when the load would still fit after the step: load × (r+step)² / r² < budget × headroom */
  headroom: number;
  /** ms after a change before the next step down, and before a step up */
  downAfterMs: number; upAfterMs: number;
  /** ratio to begin at (default max); the governor climbs from it to max when the GPU has headroom */
  start?: number;
}

/** The brief's performance target: 60 fps at 1440p. */
export const PIXEL_BUDGET = 2560 * 1440;

/**
 * Where dynamic resolution starts: the highest ratio, on the governor's step grid, at which a
 * `width` × `height` CSS-pixel canvas has no more than `budget` device pixels (never below `min`,
 * never above `max`). A full-screen retina MacBook at 2× is 6–8 M pixels, twice the 1440p target,
 * and starting there made the first seconds crawl while the governor stepped down a quarter a second.
 */
export function startRatio(width: number, height: number, max: number, budget = PIXEL_BUDGET, o: Pick<ResolutionOptions, 'min' | 'step'> = RESOLUTION): number {
  const px = width * height;
  if (!(px > 0)) return max;
  const fit = Math.sqrt(budget / px);
  if (fit >= max) return max;
  return Math.min(max, Math.max(o.min, Math.floor(fit / o.step) * o.step));
}

export const RESOLUTION: Omit<ResolutionOptions, 'max'> = { min: 1, step: 0.25, budgetMs: 15, headroom: 0.8, downAfterMs: 1000, upAfterMs: 3000 };

export class ResolutionGovernor {
  ratio: number;
  private o: ResolutionOptions;
  private lastChange = -Infinity;
  constructor(o: Partial<ResolutionOptions> & { max: number }) {
    this.o = { ...RESOLUTION, ...o };
    this.o.min = Math.min(this.o.min, this.o.max);
    this.ratio = Math.min(this.o.max, Math.max(this.o.min, this.o.start ?? this.o.max));
  }
  /**
   * Feed the mean GPU (or frame) time per frame over the last second; returns the ratio to render at.
   * Pixel cost scales with ratio², so a step changes the load by about ((r ± step) / r)².
   */
  update(loadMs: number, now: number): number {
    const { min, max, step, budgetMs, headroom, downAfterMs, upAfterMs } = this.o;
    if (!(loadMs > 0)) return this.ratio;
    const r = this.ratio, since = now - this.lastChange;
    let next = r;
    if (loadMs > budgetMs) { if (r > min && since >= downAfterMs) next = Math.max(min, r - step); }
    else if (r < max && since >= upAfterMs && loadMs * ((r + step) / r) ** 2 < budgetMs * headroom) next = Math.min(max, r + step);
    if (next !== r) { this.ratio = next; this.lastChange = now; }
    return this.ratio;
  }
}
