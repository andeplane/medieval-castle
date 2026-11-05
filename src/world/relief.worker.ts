// Mountain erosion off the main thread; runs while the textures generate. The page passes its seed,
// because a worker's own location has no ?seed. The worker is its own composition root.
import { erodeRelief } from './relief';
import { seededDeps } from './deps';

self.onmessage = (e: MessageEvent<{ seed: number }>) => {
  const t0 = performance.now();
  const { R, D } = erodeRelief(seededDeps(e.data.seed));
  (self as unknown as Worker).postMessage({ R, D, ms: Math.round(performance.now() - t0) }, [R.buffer, D.buffer]);
};
