// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { createLoadingScreen, renderSize, PALETTE } from '../../src/loading/tunnel';
import { STONE_GREYS } from '../../src/render/texgen';
import { fakeDeps } from './fakes';

const root = () => { document.body.innerHTML = '<div id="loading">BUILDING THE CASTLE…</div>'; return document.getElementById('loading')!; };
/** "step | pct" as the two parts of the caption line show them */
const label = () => { const l = document.querySelector('#loading .label'); return l ? `${l.querySelector('.step')?.textContent} | ${l.querySelector('.pct')?.textContent}` : undefined; };

describe('renderSize', () => {
  it('renders at 0.75 of device pixels with DPR capped at 2', () => {
    expect(renderSize({ w: 1000, h: 500, dpr: 3 })).toEqual({ w: 1500, h: 750 });
    expect(renderSize({ w: 1000, h: 500, dpr: 1 })).toEqual({ w: 750, h: 375 });
    expect(renderSize({ w: 0, h: 0, dpr: 1 })).toEqual({ w: 2, h: 2 });
  });
});

describe('PALETTE', () => {
  it('uses the castle rubble greys, most common first', () => {
    const top = [...STONE_GREYS.rubble].sort((a, b) => b.w - a.w)[0].c;
    expect(PALETTE.stone[0]).toEqual(top);
    expect(PALETTE.stone).toHaveLength(6);
  });
});

describe('createLoadingScreen', () => {
  it('replaces the text placeholder with a canvas, title and an accessible progress caption', () => {
    const el = root();
    const d = fakeDeps();
    createLoadingScreen(el, {}, d);
    expect(el.querySelector('canvas')).not.toBeNull();
    expect(el.querySelector('.title')?.textContent).toBe('Moated Castle');
    expect(label()).toBe('Down to the cellar… | 0%');
    expect(el.getAttribute('aria-label')).toBe('Loading Moated Castle');
    expect(el.getAttribute('aria-valuetext')).toBe('Down to the cellar… 0%');
    expect(el.getAttribute('role')).toBe('progressbar');
    expect(el.getAttribute('aria-valuenow')).toBe('0');
  });

  it('lights torches as progress arrives and sizes the canvas to the viewport', async () => {
    const el = root();
    const d = fakeDeps();
    const s = createLoadingScreen(el, {}, d);
    d.frame();
    expect(d.gl!.uniforms.get('uI')).toEqual(new Array(8).fill(0));
    await s.progress(0.3, 'Cutting the stone…');
    for (let i = 0; i < 120; i++) d.frame();
    expect(s.shown).toBeCloseTo(0.3);
    expect(label()).toBe('Cutting the stone… | 30%');
    const lit = (d.gl!.uniforms.get('uI') as number[]).filter((x) => x > 0).length;
    expect(lit).toBe(3);
    const c = el.querySelector('canvas')!;
    expect([c.width, c.height]).toEqual([1200, 600]);
    expect(d.gl!.uniforms.get('uDay')).toBeCloseTo(0.04);
    d.pointer!(0.5, -0.25);
    d.frame();
    expect(d.gl!.uniforms.get('uLook')).toEqual([0.5, -0.25]);
  });

  it('finishes: lights everything, raises fill and daylight, fades and cleans up', async () => {
    const el = root();
    const d = fakeDeps();
    const s = createLoadingScreen(el, {}, d);
    const gl = d.gl!;
    await s.finish();
    expect(s.shown).toBe(1);
    expect(d.waits).toEqual([900, 700]);
    expect(el.style.opacity).toBe('0');
    expect(el.isConnected).toBe(false);
    expect(gl.lost).toBe(true);
    expect(d.unsubscribed).toBe(true);
    expect(d.frames).toHaveLength(0);
    expect(label()).toBeUndefined();
  });

  it('shortens the hold and fade for reduced motion', async () => {
    const d = fakeDeps({ reducedMotion: true });
    await createLoadingScreen(root(), {}, d).finish();
    expect(d.waits).toEqual([200, 0]);
  });

  it('reaches full fill light before fading', async () => {
    const d = fakeDeps();
    const s = createLoadingScreen(root(), {}, d);
    const fills: number[] = [];
    const draw = d.gl!.drawArrays;
    d.gl!.drawArrays = (...a) => { fills.push(d.gl!.uniforms.get('uFill') as number); draw(...a); };
    await s.finish();
    expect(Math.max(...fills)).toBeCloseTo(0.3);
  });

  it('dispose is idempotent and stops drawing', () => {
    const d = fakeDeps();
    const s = createLoadingScreen(root(), {}, d);
    s.dispose();
    s.dispose();
    const n = d.gl!.calls.length;
    d.frame();
    expect(d.gl!.calls.length).toBe(n);
  });

  it('stops a finish in progress when disposed', async () => {
    const d = fakeDeps();
    const s = createLoadingScreen(root(), {}, d);
    d.nextFrame = async () => { s.dispose(); };
    await s.finish();
    expect(s.shown).toBeLessThan(1);
  });

  it('a stale frame callback after dispose does nothing', () => {
    const d = fakeDeps();
    const s = createLoadingScreen(root(), {}, d);
    const pending = d.frames[0];
    s.dispose();
    pending(100);
    expect(d.frames).toHaveLength(0);
  });

  it('keeps the caption working without WebGL2 or when the shader fails', async () => {
    for (const d of [fakeDeps({ gl: null }), fakeDeps({ makeRenderer: () => null })]) {
      const s = createLoadingScreen(root(), {}, d);
      await s.progress(0.5);
      for (let i = 0; i < 100; i++) d.frame();
      expect(label()).toBe('Down to the cellar… | 50%');
      s.dispose();
    }
  });

  it('holds a fixed progress for previews', () => {
    const d = fakeDeps();
    createLoadingScreen(root(), { fixed: 1 }, d);
    d.frame();
    expect(d.gl!.uniforms.get('uI')).toEqual(new Array(8).fill(1));
    expect(d.gl!.uniforms.get('uDay')).toBeCloseTo(1);
  });
});
