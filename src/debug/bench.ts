// A repeatable benchmark: the same camera bookmarks and walks every time, each held for a warm-up
// and then measured (real frames, real rendering), so builds can be compared on one machine.
// ?bench runs it after loading and shows the table in the stats overlay; __game.bench() returns
// the rows; scripts/bench.mjs drives it from Playwright. The page is injected, so tests use fakes.
import type { FrameSummary } from '../render/perf';

export interface BenchStep {
  name: string;
  /** a camera bookmark to stand at, or 'spawn' for the player's spawn point */
  from: string;
  /** keys held while measuring (KeyboardEvent.code), e.g. ['KeyW'] to walk */
  keys?: string[];
}

export interface BenchRow extends FrameSummary { name: string }

export interface BenchDeps {
  /** Put the camera / player where the step starts; false if the place does not exist. */
  go(from: string): boolean;
  hold(keys: string[]): void;
  /** Forget the frames so far. */
  reset(): void;
  summary(): FrameSummary;
  wait(ms: number): Promise<void>;
  /** Called after each step, for progress. */
  onRow?(row: BenchRow, i: number, n: number): void;
}

export interface BenchOptions { warmMs?: number; measureMs?: number }

/** Views across the castle: far, at the walls, the gate, the courtyard, close-ups, rooms, underground. */
export const BENCH_STEPS: BenchStep[] = [
  { name: 'hero', from: 'hero' },
  { name: 'aerial', from: 'aerial' },
  { name: 'gate', from: 'gate' },
  { name: 'door-gate', from: 'door-gate' },
  { name: 'courtyard', from: 'courtyard' },
  { name: 'ward', from: 'ward' },
  { name: 'closeup-ashlar', from: 'closeup-ashlar' },
  { name: 'gatepass', from: 'gatepass' },
  { name: 'tunnel', from: 'tunnel' },
  // walks: from the spawn over the bridge into the gate; running across the courtyard
  { name: 'walk-gate', from: 'spawn', keys: ['KeyW'] },
  { name: 'run-courtyard', from: 'courtyard', keys: ['KeyW', 'ShiftLeft'] },
];

export async function runBench(steps: readonly BenchStep[], d: BenchDeps, o: BenchOptions = {}): Promise<BenchRow[]> {
  const warm = o.warmMs ?? 1000, measure = o.measureMs ?? 3000;
  const rows: BenchRow[] = [];
  for (const [i, s] of steps.entries()) {
    if (!d.go(s.from)) continue;
    d.hold(s.keys ?? []);
    await d.wait(warm);
    d.reset();
    await d.wait(measure);
    const row = { name: s.name, ...d.summary() };
    d.hold([]);
    rows.push(row);
    d.onRow?.(row, i, steps.length);
  }
  return rows;
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n));

/** A markdown table of benchmark rows, for PROGRESS.md and PR descriptions. */
export function benchTable(rows: readonly BenchRow[]): string {
  const head = '| view | fps | frame ms (p50 / p95) | CPU ms | GPU ms | draw calls | triangles |\n|---|---|---|---|---|---|---|';
  const body = rows.map((r) => `| ${r.name} | ${r.fps} | ${r.p50} / ${r.p95} | ${r.cpuMs} | ${r.gpuMs ?? '–'} | ${r.drawCalls} | ${k(r.triangles)} |`);
  return [head, ...body].join('\n');
}
