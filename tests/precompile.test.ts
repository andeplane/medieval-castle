// Boot shader compilation in pieces (render/precompile.ts): every pass compiles, then the warm-up
// renders run one per task, with the page breathing between any two pieces.
import { describe, expect, it } from 'vitest';
import { precompile } from '../src/render/precompile';

describe('precompile', () => {
  it('compiles each pass, then warms up one render per task, breathing between all pieces', async () => {
    const log: string[] = [];
    let pending = 0;
    const pass = (n: string) => async () => { pending++; await Promise.resolve(); log.push(`compile ${n}`); pending--; };
    await precompile({
      passes: [pass('pre'), pass('scene')],
      warm: [() => log.push(`warm 1 (pending ${pending})`), () => log.push('warm 2')],
      breathe: async () => { log.push('breathe'); },
    });
    expect(log).toEqual(['compile pre', 'breathe', 'compile scene', 'breathe', 'warm 1 (pending 0)', 'breathe', 'warm 2']);
  });
  it('does nothing without pieces', async () => {
    let breaths = 0;
    await precompile({ passes: [], warm: [], breathe: async () => { breaths++; } });
    expect(breaths).toBe(0);
  });
});
