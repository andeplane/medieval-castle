// The castle's stone layout (layoutStones, ~0.6 s on an M-series Mac) off the main thread, so the
// loading tunnel keeps answering the mouse while it runs. Faces and exclusions are plain data; the
// stones come back packed in one transferable Float64Array. Same pure function either way, so the
// same seed lays the same stones; without workers (tests, old browsers) or on a worker error it runs inline.
import type { Exclusion, Stone, StoneFace } from './layout';
import { layoutStones, unpackStones } from './set';

export interface StoneWorker {
  /** lay out the stones (default masonry spec and salt) and hand them back packed (packStones) */
  run(faces: StoneFace[], exclusions: Exclusion[]): Promise<Float64Array>;
  dispose(): void;
}

export function layoutStonesOffThread(faces: StoneFace[], exclusions: Exclusion[], spawn: (() => StoneWorker) | null, warn: (m: string, e: unknown) => void = console.warn): Promise<Stone[]> {
  const inline = () => layoutStones(faces, exclusions);
  if (!spawn) return Promise.resolve(inline());
  let w: StoneWorker;
  try { w = spawn(); } catch (e) { warn('stone worker unavailable, laying out inline', e); return Promise.resolve(inline()); }
  return w.run(faces, exclusions).then(unpackStones, (e) => { warn('stone worker failed, laying out inline', e); return inline(); }).finally(() => w.dispose());
}

/* v8 ignore start -- browser binding; the worker body is layout.worker.ts */
export function browserStoneWorker(): (() => StoneWorker) | null {
  if (typeof Worker === 'undefined') return null;
  return () => {
    const w = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
    return {
      run: (faces, exclusions) => new Promise<Float64Array>((resolve, reject) => {
        w.onmessage = (e: MessageEvent<Float64Array>) => resolve(e.data);
        w.onerror = (e) => reject(e);
        w.postMessage({ faces, exclusions });
      }),
      dispose: () => w.terminate(),
    };
  };
}
/* v8 ignore stop */
