// Stone layout off the main thread (offThread.ts): plain faces and exclusions in, packed stones out.
import { layoutStones, packStones } from './set';
import type { Exclusion, StoneFace } from './layout';

self.onmessage = (e: MessageEvent<{ faces: StoneFace[]; exclusions: Exclusion[] }>) => {
  const packed = packStones(layoutStones(e.data.faces, e.data.exclusions));
  (self as unknown as Worker).postMessage(packed, [packed.buffer]);
};
