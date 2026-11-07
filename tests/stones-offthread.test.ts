// The stone layout off the main thread (castle/stones/offThread.ts): the worker path runs the same pure
// layoutStones and hands the stones back packed, so it must lay exactly the stones the inline path lays.
// The fake worker crosses a structured-clone boundary like a real one (inputs cloned, output transferred).
import { describe, expect, it, vi } from 'vitest';
import { layoutStones, packStones, unpackStones, StoneSet } from '../src/castle/stones/set';
import { layoutStonesOffThread, type StoneWorker } from '../src/castle/stones/offThread';
import type { Exclusion, StoneFace } from '../src/castle/stones/layout';
import { buildCastle } from '../src/castle/castle';
import { buildInterior } from '../src/castle/interior/index';
import { heightAt } from '../src/world/terrain';
import { mats } from './world';

/** A worker that runs the real worker body on cloned inputs. */
const fakeWorker = (log: string[] = []): (() => StoneWorker) => () => ({
  run: async (faces: StoneFace[], excl: Exclusion[]) => { log.push('run'); const m = structuredClone({ faces, excl }); return packStones(layoutStones(m.faces, m.excl)); },
  dispose: () => { log.push('dispose'); },
});

const wall = (o: number, n: 1 | -1): StoneFace => ({
  mat: 'old', geom: { kind: 'plane', o: [0, 0, o], r: [1, 0, 0], n: [0, 0, n] },
  s0: 0, s1: 6, y0: 0, y1: 3, u0: 0, holes: [[[2, 0], [3, 0], [3, 2], [2, 2]]], ends: [false, true], sil: n < 0, owner: -1,
});
const faces = [wall(0, 1), wall(5, -1)];
const excl: Exclusion[] = [{ owner: 7, pts: [[4, 0, -0.5], [5, 0, -0.5], [5, 0, 0.5], [4, 0, 0.5], [4, 1.5, -0.5], [5, 1.5, -0.5], [5, 1.5, 0.5], [4, 1.5, 0.5]] }];

describe('stone layout off the main thread', () => {
  it('packs and unpacks every field exactly', () => {
    const st = layoutStones(faces, excl);
    expect(st.length).toBeGreaterThan(20);
    expect(unpackStones(packStones(st))).toEqual(st);
  });

  it('lays the same stones through the worker as inline, and frees the worker', async () => {
    const log: string[] = [];
    const got = await layoutStonesOffThread(faces, excl, fakeWorker(log));
    expect(got).toEqual(layoutStones(faces, excl));
    expect(log).toEqual(['run', 'dispose']);
    const a = new StoneSet(faces, excl), b = new StoneSet(faces, excl, {}, got);
    expect([...b.centres]).toEqual([...a.centres]);
    expect(b.stonesNear([1, 1, 0], 2).map((r) => r.stone)).toEqual(a.stonesNear([1, 1, 0], 2).map((r) => r.stone));
  });

  it('lays out inline without workers, or when the worker cannot start or fails', async () => {
    const want = layoutStones(faces, excl), warn = vi.fn();
    expect(await layoutStonesOffThread(faces, excl, null, warn)).toEqual(want);
    expect(await layoutStonesOffThread(faces, excl, () => { throw new Error('no worker'); }, warn)).toEqual(want);
    let freed = false;
    const broken = () => ({ run: () => Promise.reject(new Error('boom')), dispose: () => { freed = true; } });
    expect(await layoutStonesOffThread(faces, excl, broken, warn)).toEqual(want);
    expect(freed).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('lays every stone of the whole castle identically through the worker (as main.ts does)', async () => {
    const { builder } = buildCastle();
    buildInterior(mats(), builder, { heightAt });
    const inline = new StoneSet(builder.stoneFaces, builder.stoneExcl);
    const off = new StoneSet(builder.stoneFaces, builder.stoneExcl, {}, await layoutStonesOffThread(builder.stoneFaces, builder.stoneExcl, fakeWorker()));
    expect(off.stones.length).toBe(inline.stones.length);
    expect(off.stones).toEqual(inline.stones);
    expect([...off.centres]).toEqual([...inline.centres]);
  }, 120_000);
});
