import { describe, it, expect, vi } from 'vitest';
import { startLoop, renderSize, followLook } from '../../src/loading/loop';
import { LoadingModel } from '../../src/loading/model';
import { createTunnelRenderer } from '../../src/loading/gl';
import { PALETTE } from '../../src/loading/tunnel';
import { fakeClock, fakeGL } from './fakes';

describe('renderSize', () => {
  it('renders at half the device pixels with DPR capped at 2', () => {
    expect(renderSize({ w: 1000, h: 500, dpr: 3 })).toEqual({ w: 1000, h: 500 });
    expect(renderSize({ w: 1000, h: 500, dpr: 1 })).toEqual({ w: 500, h: 250 });
    expect(renderSize({ w: 0, h: 0, dpr: 1 })).toEqual({ w: 2, h: 2 });
  });
});

describe('followLook', () => {
  it('eases toward the pointer at a frame-rate independent pace', () => {
    const a = followLook([0, 0], [1, -1], 1 / 3);
    expect(a[0]).toBeCloseTo(1 - Math.exp(-1));
    expect(a[1]).toBeCloseTo(-(1 - Math.exp(-1)));
    const b: [number, number] = [0, 0];
    for (let i = 0; i < 20; i++) followLook(b, [1, -1], 1 / 60);
    expect(b[0]).toBeCloseTo(a[0], 5);
    expect(followLook([0.5, 0.5], [1, 1], 0)).toEqual([0.5, 0.5]);
  });
});

describe('startLoop', () => {
  it('drifts the camera after the pointer instead of snapping to it', () => {
    const gl = fakeGL();
    const clock = fakeClock();
    const look: [number, number] = [0, 0];
    startLoop({ model: new LoadingModel(), renderer: createTunnelRenderer(gl, PALETTE, false), clock, size: () => ({ w: 8, h: 8 }), look, minFrameMs: 0 });
    clock.frame();
    look[0] = 1; look[1] = -1;
    clock.frame(33);
    const [x1, y1] = gl.uniforms.get('uLook') as number[];
    expect(x1).toBeGreaterThan(0);
    expect(x1).toBeLessThan(0.2);
    expect(y1).toBeCloseTo(-x1);
    for (let i = 0; i < 120; i++) clock.frame(33);
    expect((gl.uniforms.get('uLook') as number[])[0]).toBeGreaterThan(0.99);
  });

  it('ticks the model and draws torches, fill and daylight every frame until stopped', () => {
    const gl = fakeGL();
    const clock = fakeClock();
    const m = new LoadingModel();
    const onFrame = vi.fn();
    const look: [number, number] = [0.1, 0.2];
    const stop = startLoop({ model: m, renderer: createTunnelRenderer(gl, PALETTE, false), clock, size: () => ({ w: 64, h: 32 }), look, onFrame });
    clock.frame();
    expect(gl.uniforms.get('uI')).toEqual(new Array(8).fill(0));
    expect(gl.uniforms.get('uDay')).toBe(0);
    expect(gl.uniforms.get('uFill')).toBe(0);
    expect(gl.uniforms.get('uLook')).toEqual([0.1, 0.2]);
    expect(gl.calls).toContain('viewport 0 0 64 32');
    m.setTarget(1);
    for (let i = 0; i < 400; i++) clock.frame();
    expect(m.done).toBe(true);
    expect((gl.uniforms.get('uI') as number[]).every((x) => x > 0.5)).toBe(true);
    expect(gl.uniforms.get('uDay')).toBe(1);
    expect(gl.uniforms.get('uFill')).toBeCloseTo(0.3);
    expect(onFrame).toHaveBeenCalledWith(m);
    stop();
    const n = onFrame.mock.calls.length;
    clock.frame();
    expect(onFrame.mock.calls.length).toBe(n);
  });

  it('ignores a stale frame after stop and runs without a renderer', () => {
    const clock = fakeClock();
    const m = new LoadingModel();
    const stop = startLoop({ model: m, renderer: null, clock, size: () => ({ w: 1, h: 1 }), look: [0, 0] });
    const pending = clock.frames[0];
    m.setTarget(0.5);
    clock.frame(100);
    expect(m.shown).toBeGreaterThan(0);
    stop();
    const before = m.shown;
    pending(5000);
    expect(m.shown).toBe(before);
  });
});
