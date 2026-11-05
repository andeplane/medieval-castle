import { describe, it, expect, vi } from 'vitest';
import { createTunnelRenderer } from '../../src/loading/gl';
import { FRAG, VERT } from '../../src/loading/tunnel.glsl';
import { N_TORCH } from '../../src/loading/model';
import { PALETTE } from '../../src/loading/tunnel';
import { fakeGL } from './fakes';

describe('tunnel shader source', () => {
  it('declares every uniform the renderer sets, sized for the torch count', () => {
    for (const u of ['uRes', 'uTime', 'uFill', 'uLook', 'uMotion', 'uStone', 'uMortar', 'uDay']) expect(FRAG).toMatch(new RegExp(`uniform \\w+ ${u}\\b`));
    expect(FRAG).toContain(`uniform float uI[${N_TORCH}]`);
    expect(VERT.startsWith('#version 300 es')).toBe(true);
    expect(FRAG.startsWith('#version 300 es')).toBe(true);
  });
});

describe('createTunnelRenderer', () => {
  it('uploads the castle palette once and draws a full-screen triangle per frame', () => {
    const gl = fakeGL();
    const r = createTunnelRenderer(gl, PALETTE, false)!;
    expect(r).not.toBeNull();
    expect(gl.uniforms.get('uStone')).toHaveLength(18);
    expect(gl.uniforms.get('uMortar')).toEqual([0.35, 0.34, 0.31]);
    expect(gl.uniforms.get('uMotion')).toBe(1);
    r.draw({ w: 640, h: 360, time: 2, torches: new Float32Array([1, 0.5]), fill: 0.2, day: 0.4, look: [0.1, -0.2] });
    expect(gl.calls).toContain('viewport 0 0 640 360');
    expect(gl.calls.at(-1)).toBe('draw');
    expect(gl.uniforms.get('uRes')).toEqual([640, 360]);
    expect(gl.uniforms.get('uI')).toEqual([1, 0.5]);
    expect(gl.uniforms.get('uFill')).toBe(0.2);
    expect(gl.uniforms.get('uDay')).toBe(0.4);
    expect(gl.uniforms.get('uLook')).toEqual([0.1, -0.2]);
    expect(gl.uniforms.get('uTime')).toBe(2);
    r.dispose();
    expect(gl.lost).toBe(true);
  });

  it('turns motion off for reduced motion and survives a missing lose-context extension', () => {
    const gl = fakeGL();
    gl.noLoseExt = true;
    const r = createTunnelRenderer(gl, PALETTE, true)!;
    expect(gl.uniforms.get('uMotion')).toBe(0);
    expect(() => r.dispose()).not.toThrow();
  });

  it('returns null and warns when a shader does not compile', () => {
    const gl = fakeGL();
    gl.failCompile = gl.FRAGMENT_SHADER;
    const warn = vi.fn();
    expect(createTunnelRenderer(gl, PALETTE, false, warn)).toBeNull();
    expect(warn).toHaveBeenCalledWith('loading tunnel shader failed', expect.any(Error));
    expect(gl.calls).not.toContain('useProgram');
  });

  it('returns null when no shader object can be made or the info log is empty', () => {
    const gl = fakeGL();
    gl.nullShader = true;
    const warn = vi.fn();
    expect(createTunnelRenderer(gl, PALETTE, false, warn)).toBeNull();
    const g2 = fakeGL();
    g2.failCompile = g2.VERTEX_SHADER;
    g2.getShaderInfoLog = () => null;
    expect(createTunnelRenderer(g2, PALETTE, false, warn)).toBeNull();
    expect((warn.mock.calls[1][1] as Error).message).toBe('shader compile failed');
  });

  it('returns null when the program does not link', () => {
    const gl = fakeGL();
    gl.failLink = true;
    const warn = vi.fn();
    expect(createTunnelRenderer(gl, PALETTE, false, warn)).toBeNull();
    expect(warn).toHaveBeenCalledWith('loading tunnel link failed', 'link error');
  });

  it('defaults to console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gl = fakeGL();
    gl.failLink = true;
    createTunnelRenderer(gl, PALETTE, false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
