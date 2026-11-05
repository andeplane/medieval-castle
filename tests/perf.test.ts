import { describe, it, expect } from 'vitest';
import { FrameStats, summarize, percentile, pixelRatio, gpuFrameTimes } from '../src/render/perf';
import { runBench, benchTable, BENCH_STEPS, type BenchDeps } from '../src/debug/bench';
import type { FrameSummary } from '../src/render/perf';

const f = (frameMs: number, cpuMs = 1, drawCalls = 10, triangles = 1000) => ({ frameMs, cpuMs, drawCalls, triangles });

describe('frame stats', () => {
  it('summarises fps, percentiles, CPU, GPU, draws and triangles', () => {
    const s = summarize([f(10), f(10), f(10), f(30, 3, 20, 3000)], [4, 6]);
    expect(s).toEqual({ frames: 4, fps: 66.7, frameMs: 15, p50: 10, p95: 30, max: 30, cpuMs: 1.5, gpuMs: 5, drawCalls: 13, triangles: 1500 });
  });
  it('is empty-safe and reports no GPU time without timestamps', () => {
    expect(summarize([])).toEqual({ frames: 0, fps: 0, frameMs: 0, p50: 0, p95: 0, max: 0, cpuMs: 0, gpuMs: null, drawCalls: 0, triangles: 0 });
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
  });
  it('keeps the last frames and GPU timings, drops empty GPU reads, clears', () => {
    const st = new FrameStats(3);
    for (const ms of [100, 10, 10, 10]) st.push(f(ms));
    for (const g of [9, 1, 1, 1, 0, NaN]) st.pushGpu(g);
    expect(st.summary()).toMatchObject({ frames: 3, max: 10, gpuMs: 1 });
    st.clear();
    expect(st.summary().frames).toBe(0);
  });
  it('picks the pixel ratio: ?scale= wins, else the screen capped at 2', () => {
    expect(pixelRatio(2, null)).toBe(2);
    expect(pixelRatio(3, null)).toBe(2);
    expect(pixelRatio(0, null)).toBe(1);
    expect(pixelRatio(2, '1')).toBe(1);
    expect(pixelRatio(2, '0.75')).toBe(0.75);
    expect(pixelRatio(2, '9')).toBe(4);
    expect(pixelRatio(2, '')).toBe(2);
    expect(pixelRatio(2, 'x')).toBe(2);
    expect(pixelRatio(2.5, null, 1.5)).toBe(1.5);
  });
});

describe('GPU time per frame', () => {
  const e: [string, number][] = [['r:1:4:f10', 3], ['r:2:5:f10', 4], ['r:1:4:f9', 2], ['r:2:5:f9', 1], ['bogus', 9], ['r:3:6:f10', 0]];
  it('sums passes on GPUs that run them in turn, takes the longest where they overlap, in frame order', () => {
    expect(gpuFrameTimes(e, false)).toEqual([3, 7]);
    expect(gpuFrameTimes(e, true)).toEqual([2, 4]);
    expect(gpuFrameTimes([], true)).toEqual([]);
  });
});

describe('benchmark', () => {
  const fake = () => {
    const log: string[] = [];
    let n = 0;
    const d: BenchDeps = {
      go: (from) => { log.push(`go ${from}`); return from !== 'missing'; },
      hold: (k) => log.push(`hold ${k.join('+')}`),
      reset: () => log.push('reset'),
      summary: () => ({ ...summarize([f(10 + n++)]), gpuMs: null }) as FrameSummary,
      wait: async (ms) => { log.push(`wait ${ms}`); },
      onRow: (r, i, total) => log.push(`row ${r.name} ${i}/${total}`),
    };
    return { d, log };
  };
  it('warms up, resets, measures each step and skips missing places', async () => {
    const { d, log } = fake();
    const rows = await runBench([{ name: 'a', from: 'a' }, { name: 'x', from: 'missing' }, { name: 'w', from: 'spawn', keys: ['KeyW'] }], d, { warmMs: 5, measureMs: 7 });
    expect(rows.map((r) => [r.name, r.fps])).toEqual([['a', 100], ['w', 90.9]]);
    expect(log).toEqual(['go a', 'hold ', 'wait 5', 'reset', 'wait 7', 'hold ', 'row a 0/3', 'go missing', 'go spawn', 'hold KeyW', 'wait 5', 'reset', 'wait 7', 'hold ', 'row w 2/3']);
  });
  it('defaults to 1 s warm-up and 3 s measurement, and works without onRow', async () => {
    const { d, log } = fake();
    delete d.onRow;
    await runBench([{ name: 'a', from: 'a' }], d);
    expect(log).toContain('wait 1000');
    expect(log).toContain('wait 3000');
  });
  it('covers far views, the gate, rooms, underground and walks', () => {
    const names = BENCH_STEPS.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['hero', 'door-gate', 'courtyard', 'tunnel', 'walk-gate']));
    expect(BENCH_STEPS.filter((s) => s.keys?.includes('KeyW')).length).toBeGreaterThanOrEqual(2);
  });
  it('prints a markdown table', () => {
    const row = (name: string, triangles: number, gpuMs: number | null) => ({ name, ...summarize([f(16)]), triangles, gpuMs });
    const t = benchTable([row('hero', 5_400_000, 12.3), row('tunnel', 52_000, null), row('x', 12, 1)]);
    expect(t.split('\n')).toEqual([
      '| view | fps | frame ms (p50 / p95) | CPU ms | GPU ms | draw calls | triangles |',
      '|---|---|---|---|---|---|---|',
      '| hero | 62.5 | 16 / 16 | 1 | 12.3 | 10 | 5.4 M |',
      '| tunnel | 62.5 | 16 / 16 | 1 | – | 10 | 52 k |',
      '| x | 62.5 | 16 / 16 | 1 | 1 | 10 | 12 |',
    ]);
  });
});
