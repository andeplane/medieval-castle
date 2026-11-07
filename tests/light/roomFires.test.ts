import { describe, it, expect } from 'vitest';
import { LightRig } from '../../src/light/rig';
import { createRoomFires } from '../../src/light/roomFires';
import type { FlameInstance } from '../../src/light/flames';
import type { LightEmitter } from '../../src/light/types';
import { fakeFactory } from './fakes';

const torch = (x: number): LightEmitter => ({ kind: 'torch', position: [x, 2, 0], colour: [1, 1, 1], intensity: 3, flicker: 0.2 });

describe('room fires', () => {
  it('adds a room\'s emitters once, puts them out and lights them again under the same ids', () => {
    const rig = new LightRig(fakeFactory(), { shadows: 0, lights: 4, fadeTime: 0, motion: 0 });
    const seen: FlameInstance[][] = [];
    const F = createRoomFires(rig, (fs) => seen.push(fs));
    F.set('a', [torch(0)], [{ kind: 'torch', base: [0, 1.8, 0], height: 0.3 }]);
    F.set('b', [torch(5), torch(6)], []);
    expect(rig.count).toBe(3);
    expect(F.rooms()).toEqual(['a', 'b']);
    expect(F.flames()).toHaveLength(1);
    expect(seen).toHaveLength(0); // flames go out once a frame, on sync
    F.sync(); F.sync();
    expect(seen).toHaveLength(1);
    expect(seen.at(-1)![0].seed).toBe(rig['sources'][0].seed); // linked to its own torch
    rig.update(0, 0.016, [0, 2, 0]);
    expect(rig.stats().lit).toBe(3);
    F.clear('b');
    rig.update(0.1, 0.016, [0, 2, 0]);
    expect(rig.stats().lit).toBe(1);
    F.clear('b'); // twice: nothing
    F.sync();
    expect(seen).toHaveLength(2);
    F.set('b', [torch(5), torch(6)], []);
    expect(rig.count).toBe(3);
    rig.update(0.2, 0.016, [0, 2, 0]);
    expect(rig.stats().lit).toBe(3);
    F.clear('a');
    expect(F.flames()).toHaveLength(0);
    expect(F.rooms()).toEqual(['b']);
  });
});
