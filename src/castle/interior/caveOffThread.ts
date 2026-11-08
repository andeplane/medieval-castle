// The caves' rock (caveGeom.ts caveRock: the signed field meshed by surface nets and its openness baked, ~1 s) off the main
// thread, as the stones are (castle/stones/offThread.ts), so the loading tunnel keeps answering while it
// runs. The plan goes in as plain data; the soup comes back in transferable arrays and primes caveRock's
// cache, so the interior build that follows finds it there. Same pure function either way: without workers
// (tests, old browsers) or on a worker error it runs inline.
import type { CavePlan } from './caves';
import { caveRock, primeCaveRock, type CaveSoup } from './caveGeom';

export interface PackedSoup { pos: Float64Array; nor: Float64Array; tris: Uint32Array; open: Float32Array }
export interface CaveWorker {
  run(plan: CavePlan, seed: number): Promise<PackedSoup>;
  dispose(): void;
}

/** The soup in transferable arrays (the worker's answer). */
export function packCaveRock(R: CaveSoup): PackedSoup {
  return { pos: Float64Array.from(R.pos), nor: Float64Array.from(R.nor), tris: Uint32Array.from(R.tris), open: Float32Array.from(R.open) };
}

/** Make the plan's rock (in a worker when `spawn` gives one) and leave it in caveRock's cache. */
export function caveRockOffThread(P: CavePlan, seed: number, spawn: (() => CaveWorker) | null, warn: (m: string, e: unknown) => void = console.warn): Promise<void> {
  const inline = () => { caveRock(P, seed); };
  if (!spawn) return Promise.resolve(inline());
  let w: CaveWorker;
  try { w = spawn(); } catch (e) { warn('cave worker unavailable, meshing inline', e); return Promise.resolve(inline()); }
  return w.run(P, seed).then((s) => primeCaveRock(P, seed, s), (e) => { warn('cave worker failed, meshing inline', e); inline(); }).finally(() => w.dispose());
}

/* v8 ignore start -- browser binding; the worker body is cave.worker.ts */
export function browserCaveWorker(): (() => CaveWorker) | null {
  if (typeof Worker === 'undefined') return null;
  return () => {
    const w = new Worker(new URL('./cave.worker.ts', import.meta.url), { type: 'module' });
    return {
      run: (plan, seed) => new Promise<PackedSoup>((resolve, reject) => {
        w.onmessage = (e: MessageEvent<PackedSoup>) => resolve(e.data);
        w.onerror = (e) => reject(e);
        w.postMessage({ plan, seed });
      }),
      dispose: () => w.terminate(),
    };
  };
}
/* v8 ignore stop */
