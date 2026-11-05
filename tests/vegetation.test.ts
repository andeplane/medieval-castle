// Guards for the vegetation placement: seeded, plausible counts, and nothing planted where it can't be.
import { describe, it, expect } from 'vitest';
import { placeTrees, VARIANTS } from '../src/world/treePlacement';
import { sample, footDist } from '../src/world/terrain';

const cams: [number, number][] = [[118, 132], [-150, 175], [-62, -96], [13, 45], [44, 27], [-92, 58]];
const spots = placeTrees(cams);

describe('tree placement', () => {
  it('is a pure function of the seed', () => {
    const again = placeTrees(cams);
    expect(again.length).toBe(spots.length);
    const sum = (s: typeof spots) => s.reduce((a, p) => a + p.x * 3 + p.z * 7 + p.v * 11 + p.s, 0);
    expect(sum(again)).toBeCloseTo(sum(spots), 6);
  });

  it('plants a landscape, not a scatter: island groups, hedgerows and forests', () => {
    const island = spots.filter((p) => sample(p.x, p.z).zone === 'island');
    expect(island.length).toBeGreaterThan(6);
    expect(island.length).toBeLessThan(30);
    const bushes = spots.filter((p) => VARIANTS[p.v].startsWith('bush')).length;
    expect(bushes).toBeGreaterThan(3000); // hedgerows and forest edges
    expect(spots.length).toBeGreaterThan(15000);
    expect(spots.length).toBeLessThan(60000); // impostor budget
  });

  it('keeps trees out of the moat, off the walls and away from the bookmark cameras', () => {
    for (const p of spots) {
      const s = sample(p.x, p.z);
      expect(s.zone).not.toBe('moat');
      if (s.zone === 'island') expect(footDist(p.x, p.z)).toBeGreaterThan(6.9);
      else expect(s.h).toBeGreaterThan(1.4);
      for (const [cx, cz] of cams) expect(Math.hypot(p.x - cx, p.z - cz)).toBeGreaterThan(13.9);
    }
  });
});
