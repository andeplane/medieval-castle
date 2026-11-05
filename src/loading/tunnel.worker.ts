// Worker entry: real worker globals for serveTunnel (logic and tests in worker.ts).
import { serveTunnel } from './worker';
import { createTunnelRenderer } from './gl';
import type { WorkerScope } from './protocol';

const g = self as unknown as WorkerScope & {
  requestAnimationFrame?: (cb: (t: number) => void) => number; cancelAnimationFrame?: (id: number) => void;
};
const raf = g.requestAnimationFrame?.bind(g) ?? ((cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16) as unknown as number);
const caf = g.cancelAnimationFrame?.bind(g) ?? ((id: number) => clearTimeout(id));
serveTunnel(g, {
  clock: { now: () => performance.now(), raf, caf },
  getGL: (c) => c.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' }),
  makeRenderer: createTunnelRenderer,
});
