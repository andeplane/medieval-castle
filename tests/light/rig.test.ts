import { describe, it, expect } from 'vitest';
import { LightRig, toSource, DEFAULT_RIG } from '../../src/light/rig';
import { PROFILES } from '../../src/light/flicker';
import type { LightEmitter } from '../../src/light/types';
import { fakeFactory } from './fakes';

const torch = (x: number, seed?: number): LightEmitter => ({ kind: 'torch', position: [x, 1.8, 0], colour: [1, 1, 1], intensity: 3, flicker: 0.25, seed });
const candle = (x: number): LightEmitter => ({ kind: 'candle', position: [x, 0.9, 0], colour: [1, 1, 1], intensity: 1, flicker: 0.12 });

describe('toSource', () => {
  it('resolves candela, range and a normalised warm colour from the kind', () => {
    const s = toSource(torch(0, 5));
    expect(s.candela).toBe(PROFILES.torch.candela * 3);
    expect(s.range).toBeCloseTo(PROFILES.torch.range * Math.sqrt(3));
    expect(Math.max(...s.colour)).toBeCloseTo(1);
    expect(s.colour[0]).toBeGreaterThan(s.colour[1]); expect(s.colour[1]).toBeGreaterThan(s.colour[2]);
    expect(s.seed).toBe(5);
    expect(toSource(torch(1)).seed).not.toBe(toSource(torch(2)).seed);
    expect(toSource({ ...candle(0), intensity: 100 }).range).toBe(PROFILES.candle.range * 2); // capped
    expect(toSource({ ...candle(0), intensity: 0.01 }).range).toBe(PROFILES.candle.range * 0.5); // floored
  });
});

describe('LightRig', () => {
  it('creates a fixed pool once: shadow casters and plain lights', () => {
    const f = fakeFactory();
    const rig = new LightRig(f, { shadows: 2, lights: 3 });
    expect(f.lights.map((l) => l.castShadow)).toEqual([true, true, false, false, false]);
    rig.setEmitters([torch(0), torch(4), torch(8)]);
    expect(f.lights).toHaveLength(5); // no new lights for new emitters: materials never recompile
    expect(new LightRig(fakeFactory()).options).toEqual(DEFAULT_RIG);
  });

  it('drives the nearest fires, turns spare lights off, and flickers', () => {
    const f = fakeFactory();
    const rig = new LightRig(f, { shadows: 1, lights: 2, fadeTime: 0 });
    expect(rig.setEmitters([torch(0), torch(3), candle(1)])).toEqual([0, 1, 2]);
    rig.update(1, 0.016, [0.2, 1.6, 0.5]);
    const on = f.lights.filter((l) => l.candela > 0);
    expect(on).toHaveLength(3);
    expect(f.lights[0].castShadow).toBe(true);
    expect(Math.abs(f.lights[0].position[0])).toBeLessThan(0.2); // the nearest torch, wobbling a little
    const a = f.lights[0].candela;
    rig.update(1.37, 0.016, [0.2, 1.6, 0.5]);
    expect(f.lights[0].candela).not.toBe(a);
    expect(rig.stats()).toEqual({ sources: 3, lit: 3, shadowLit: 1, candela: Math.round(PROFILES.torch.candela * 3 * 2 + PROFILES.candle.candela) });
    // walk away: everything goes dark and parks out of sight
    rig.update(2, 0.016, [500, 1.6, 0]);
    for (const l of f.lights) { expect(l.candela).toBe(0); expect(l.position[1]).toBe(-1000); }
    expect(rig.snapshot().shadow[0].source).toBe(-1);
  });

  it('respects visibility and reduced motion', () => {
    const f = fakeFactory();
    const rig = new LightRig(f, { shadows: 1, lights: 0, fadeTime: 0, motion: 0 });
    rig.setEmitters([torch(0), torch(2)]);
    rig.update(1, 0.016, [0, 1.6, 0], (id) => id === 1);
    expect(f.lights[0].position[0]).toBe(2);
    const cd = f.lights[0].candela;
    rig.update(2.5, 0.016, [0, 1.6, 0], (id) => id === 1);
    expect(f.lights[0].candela).toBe(cd); // steady
    expect(cd).toBe(PROFILES.torch.candela * 3);
  });

  it('supports carried torches (NPCs) and fires that go out', () => {
    const f = fakeFactory();
    const rig = new LightRig(f, { shadows: 0, lights: 1, fadeTime: 0, motion: 0 });
    rig.setEmitters([]);
    const id = rig.add(torch(0), true);
    expect(rig.count).toBe(1);
    rig.move(id, [5, 1.5, 5]);
    rig.update(0, 0.016, [5, 1.6, 5]);
    expect(f.lights[0].position).toEqual([5, 1.5, 5]);
    rig.setScale(id, 0.5);
    rig.update(0, 0.016, [5, 1.6, 5]);
    expect(f.lights[0].candela).toBeCloseTo(PROFILES.torch.candela * 3 * 0.5);
    rig.setScale(id, 0);
    rig.update(0, 0.016, [5, 1.6, 5]);
    expect(f.lights[0].candela).toBe(0);
  });

  it('flickerOf matches what the lights do; meanLights lists every source steady', () => {
    const rig = new LightRig(fakeFactory());
    rig.setEmitters([torch(0, 3), candle(2)]);
    expect(rig.flickerOf(0, 2).k).toBe(rig.flickerOf(0, 2).k);
    const m = rig.meanLights();
    expect(m).toHaveLength(2);
    expect(m[0].candela).toBe(PROFILES.torch.candela * 3);
    expect(m[1].position).toEqual([2, 0.9, 0]);
  });
});
