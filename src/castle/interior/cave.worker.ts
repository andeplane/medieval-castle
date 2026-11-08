// The caves' rock off the main thread (caveOffThread.ts): the plan in, the packed soup out.
import { caveRock } from './caveGeom';
import { packCaveRock } from './caveOffThread';
import type { CavePlan } from './caves';

self.onmessage = (e: MessageEvent<{ plan: CavePlan; seed: number }>) => {
  const s = packCaveRock(caveRock(e.data.plan, e.data.seed));
  (self as unknown as Worker).postMessage(s, [s.pos.buffer, s.nor.buffer, s.tris.buffer, s.open.buffer]);
};
