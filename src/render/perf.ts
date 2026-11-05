// Frame measurement (game-performance-optimization: measure first). A ring of recent frames with
// wall time, CPU time spent in the frame callback, GPU time from timestamp queries (when the backend
// has them), draw calls and triangles, summarised as fps and percentiles. Pure: the page pushes
// samples, the stats overlay and the benchmark read summaries.

export interface FrameSample {
  /** wall time since the previous frame (ms) */
  frameMs: number;
  /** time spent in the frame callback: game update + render encoding (ms) */
  cpuMs: number;
  drawCalls: number;
  triangles: number;
}

export interface FrameSummary {
  frames: number;
  fps: number;
  /** mean, median, 95th percentile and worst frame time (ms) */
  frameMs: number; p50: number; p95: number; max: number;
  cpuMs: number;
  /** mean GPU time per frame (ms), or null when the backend has no timestamp queries */
  gpuMs: number | null;
  drawCalls: number;
  triangles: number;
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const mean = (a: readonly number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
/** Nearest-rank percentile of an ascending array. */
export const percentile = (sorted: readonly number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : 0);

export function summarize(frames: readonly FrameSample[], gpu: readonly number[] = []): FrameSummary {
  const ms = frames.map((f) => f.frameMs).sort((a, b) => a - b);
  const avg = mean(ms);
  return {
    frames: frames.length,
    fps: avg > 0 ? round(1000 / avg) : 0,
    frameMs: round(avg, 2), p50: round(percentile(ms, 0.5), 2), p95: round(percentile(ms, 0.95), 2), max: round(ms[ms.length - 1] ?? 0, 2),
    cpuMs: round(mean(frames.map((f) => f.cpuMs)), 2),
    gpuMs: gpu.length ? round(mean(gpu), 2) : null,
    drawCalls: Math.round(mean(frames.map((f) => f.drawCalls))),
    triangles: Math.round(mean(frames.map((f) => f.triangles))),
  };
}

/** The last `capacity` frames and GPU timings (GPU times arrive later, from an async readback). */
export class FrameStats {
  private frames: FrameSample[] = [];
  private gpu: number[] = [];
  constructor(readonly capacity = 240) {}
  push(s: FrameSample) { this.frames.push(s); if (this.frames.length > this.capacity) this.frames.shift(); }
  pushGpu(ms: number) { if (!(ms > 0)) return; this.gpu.push(ms); if (this.gpu.length > this.capacity) this.gpu.shift(); }
  clear() { this.frames = []; this.gpu = []; }
  summary(): FrameSummary { return summarize(this.frames, this.gpu); }
}

/**
 * Device pixels per CSS pixel to render at. `?scale=` overrides it; otherwise the screen's ratio,
 * capped at `max` (a retina screen at 2 shades four times the pixels of a plain one).
 */
export function pixelRatio(devicePixelRatio: number, param: string | null, max = 2): number {
  const p = Number(param);
  if (param !== null && param !== '' && p > 0) return Math.min(p, 4);
  return Math.min(devicePixelRatio || 1, max);
}
