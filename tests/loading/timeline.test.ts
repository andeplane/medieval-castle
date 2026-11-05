import { describe, it, expect } from 'vitest';
import { Timeline, STEPS, DEFAULT_MS, localTimeStore } from '../../src/loading/timeline';
import { FILL_FROM } from '../../src/loading/model';
import { fakeStore } from './fakes';

const clock = () => { const c = { t: 0, now: () => c.t }; return c; };

describe('Timeline', () => {
  it('gives each step a share of the bar proportional to its expected time, ending at the fill', () => {
    const tl = new Timeline(() => 0, null);
    const spans = [tl.first(), ...STEPS.slice(1).map((s) => tl.enter(s)!)];
    expect(spans[0].start).toBe(0);
    expect(spans.at(-1)!.end).toBeCloseTo(FILL_FROM);
    const total = STEPS.reduce((a, s) => a + DEFAULT_MS[s.toLowerCase()], 0);
    spans.forEach((sp, i) => {
      expect(sp.ms).toBe(DEFAULT_MS[STEPS[i].toLowerCase()]);
      expect(sp.end - sp.start).toBeCloseTo((sp.ms / total) * FILL_FROM);
      if (i) expect(sp.start).toBeCloseTo(spans[i - 1].end);
    });
  });

  it('uses timings remembered from the last visit, ignoring junk', () => {
    const st = fakeStore({ 'lighting the halls…': 20_000, 'planting trees…': -5, 'raising the walls…': 1e9 });
    const tl = new Timeline(() => 0, st);
    expect(tl.enter('Lighting the halls…')!.ms).toBe(20_000);
    expect(tl.enter('Planting trees…')!.ms).toBe(DEFAULT_MS['planting trees…']);
    expect(tl.enter('Raising the walls…')!.ms).toBe(DEFAULT_MS['raising the walls…']);
  });

  it('ignores unknown labels and re-entering the current step', () => {
    const tl = new Timeline(() => 0, null, ['A', 'B']);
    expect(tl.enter('nope')).toBeNull();
    expect(tl.enter('a')).toBeNull();
    expect(tl.enter('B')).not.toBeNull();
    expect(tl.first().ms).toBe(1000);   // no default for 'a'
  });

  it('measures each step and saves a blend with what was expected', () => {
    const c = clock();
    const st = fakeStore();
    const tl = new Timeline(c.now, st, ['A', 'B']);
    c.t = 3000; tl.enter('B');
    c.t = 4000; tl.enter('A');            // steps can repeat; time adds up
    c.t = 5000; tl.finish();
    expect(st.data).toEqual({ a: Math.round(1000 * 0.3 + 4000 * 0.7), b: Math.round(1000 * 0.3 + 1000 * 0.7) });
    new Timeline(c.now, null).finish();   // no store: nothing to save
  });
});

describe('localTimeStore', () => {
  it('round-trips through storage', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
    const st = localTimeStore(storage);
    expect(st.load()).toBeNull();
    st.save({ a: 1 });
    expect(st.load()).toEqual({ a: 1 });
    mem.set('moated-castle:boot-ms:v1', '7');
    expect(st.load()).toBeNull();
    mem.set('moated-castle:boot-ms:v1', '{bad');
    expect(st.load()).toBeNull();
  });
  it('survives missing or throwing storage', () => {
    expect(localTimeStore(null).load()).toBeNull();
    localTimeStore(null).save({ a: 1 });
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
    expect(localTimeStore(bad).load()).toBeNull();
    expect(() => localTimeStore(bad).save({ a: 1 })).not.toThrow();
  });
});
