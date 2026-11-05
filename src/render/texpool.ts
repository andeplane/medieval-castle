// Small worker pool so the masonry, slate and ground textures generate in parallel. If workers are
// unavailable (sandboxed iframe, CSP), the same jobs run on the main thread.
type Out = Record<string, unknown>;

async function inline(jobs: string[]): Promise<Record<string, Out>> {
  const T = await import('./texgen');
  const run: Record<string, () => Out> = {
    ashlar: () => ({ ...T.ashlarSet() }), rubble: () => ({ ...T.rubbleSet() }), dressed: () => ({ ...T.dressedSet() }),
    slate: () => ({ ...T.slate() }), planks: () => ({ ...T.planks() }), macro: () => ({ data: T.macroNoise() }),
    ground: () => ({ ...T.groundLayers() }), water: () => ({ data: T.waterNormals() }),
  };
  const out: Record<string, Out> = {};
  for (const j of jobs) out[j] = run[j]();
  return out;
}

export async function generateTextures(jobs: string[]): Promise<Record<string, Out>> {
  try { return await viaWorkers(jobs); } catch (e) { console.warn('texture workers unavailable, generating inline', e); return inline(jobs); }
}

function viaWorkers(jobs: string[]): Promise<Record<string, Out>> {
  const n = Math.max(1, Math.min(jobs.length, (navigator.hardwareConcurrency || 4) - 1, 6));
  const workers = Array.from({ length: n }, () => new Worker(new URL('./texgen.worker.ts', import.meta.url), { type: 'module' }));
  const results: Record<string, Out> = {};
  let next = 0;
  return new Promise((resolve, reject) => {
    let pending = jobs.length;
    const fail = (e: unknown) => { workers.forEach((x) => x.terminate()); reject(e); };
    const timer = setTimeout(() => fail(new Error('texture workers timed out')), 60_000);
    const feed = (w: Worker) => {
      if (next >= jobs.length) return;
      const job = jobs[next++];
      w.onmessage = (e) => {
        results[job] = e.data.out;
        if (--pending === 0) { clearTimeout(timer); workers.forEach((x) => x.terminate()); resolve(results); } else feed(w);
      };
      w.onerror = (e) => { clearTimeout(timer); fail(e); };
      w.postMessage({ job });
    };
    workers.forEach(feed);
  });
}
