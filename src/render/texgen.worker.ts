// Texture generation off the main thread; results come back as transferable buffers.
import * as T from './texgen';

const jobs: Record<string, () => Record<string, unknown>> = {
  ashlar: () => ({ ...T.ashlarSet() }),
  rubble: () => ({ ...T.rubbleSet() }),
  dressed: () => ({ ...T.dressedSet() }),
  slate: () => ({ ...T.slate() }),
  planks: () => ({ ...T.planks() }),
  macro: () => ({ data: T.macroNoise() }),
  ground: () => ({ ...T.groundLayers() }),
  water: () => ({ data: T.waterNormals() }),
};

self.onmessage = (e: MessageEvent<{ job: string }>) => {
  const out = jobs[e.data.job]();
  const transfer = Object.values(out).filter((v): v is Uint8Array => v instanceof Uint8Array).map((v) => v.buffer as ArrayBuffer);
  (self as unknown as Worker).postMessage({ out }, transfer);
};
