// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { createLoadingScreen, renderSize, PALETTE } from '../../src/loading/tunnel';
import { STONE_GREYS } from '../../src/render/texgen';
import { fakeDeps } from './fakes';

const root = () => { document.body.innerHTML = '<div id="loading">BUILDING THE CASTLE…</div>'; return document.getElementById('loading')!; };
/** "step | pct" as the two parts of the caption line show them */
const label = () => { const l = document.querySelector('#loading .label'); return l ? `${l.querySelector('.step')?.textContent} | ${l.querySelector('.pct')?.textContent}` : undefined; };

describe('PALETTE', () => {
  it('uses the castle rubble greys, most common first', () => {
    const top = [...STONE_GREYS.rubble].sort((a, b) => b.w - a.w)[0].c;
    expect(PALETTE.stone[0]).toEqual(top);
    expect(PALETTE.stone).toHaveLength(6);
  });
  it('re-exports renderSize', () => expect(renderSize({ w: 100, h: 100, dpr: 1 })).toEqual({ w: 50, h: 50 }));
});

describe('createLoadingScreen', () => {
  it('replaces the placeholder with a canvas, title and accessible caption, and starts the backend', () => {
    const el = root();
    const d = fakeDeps();
    createLoadingScreen(el, { fixed: 0.4 }, d);
    expect(el.querySelector('canvas')).not.toBeNull();
    expect(el.querySelector('.title')?.textContent).toBe('Moated Castle');
    expect(label()).toBe('Down to the cellar… | 0%');
    expect(el.getAttribute('aria-label')).toBe('Loading Moated Castle');
    expect(el.getAttribute('aria-valuetext')).toBe('Down to the cellar… 0%');
    expect(el.getAttribute('role')).toBe('progressbar');
    expect(d.be.init).toEqual({ w: 800, h: 400, reduced: false, fixed: 0.4, palette: PALETTE });
  });

  it('forwards progress, pointer and resize to the backend and shows its progress in the caption', async () => {
    const d = fakeDeps();
    createLoadingScreen(root(), {}, d);
    const s = createLoadingScreen(root(), {}, d);
    await s.progress(0.3, 'Cutting the stone…');
    expect(d.be.progresses).toContain(0.3);
    d.be.shownValue = 0.25;
    d.clock.frame();
    expect(label()).toBe('Cutting the stone… | 25%');
    expect(s.shown).toBe(0.25);
    expect(document.getElementById('loading')!.getAttribute('aria-valuenow')).toBe('25');
    await s.progress(0.4);
    expect(label()).toBe('Cutting the stone… | 25%');
    d.pointer!(0.5, -0.25);
    expect(d.be.looks).toEqual([[0.5, -0.25]]);
    d.view = { w: 400, h: 200, dpr: 1 };
    d.resize!();
    expect(d.be.sizes).toEqual([[200, 100]]);
  });

  it('breathe yields a frame between two pieces of a step without touching progress or caption', async () => {
    const d = fakeDeps();
    const s = createLoadingScreen(root(), {}, d);
    await s.step('Raising the walls…');
    const spans = d.be.spans.length, t = d.clock.time;
    await s.breathe();
    expect(d.clock.time).toBeGreaterThan(t);
    expect(d.be.spans).toHaveLength(spans);
    expect(d.be.progresses).toEqual([]);
    expect(label()).toBe('Raising the walls… | 0%');
  });

  it('finishes: waits for the backend to reach 100 %, holds, fades and cleans up', async () => {
    const el = root();
    const d = fakeDeps();
    const s = createLoadingScreen(el, {}, d);
    const fin = s.finish();
    expect(d.be.progresses).toEqual([1]);
    expect(d.waits).toEqual([]);
    d.be.finishNow();
    await fin;
    expect(d.waits).toEqual([900, 700]);
    expect(el.style.opacity).toBe('0');
    expect(el.isConnected).toBe(false);
    expect(d.be.disposed).toBe(true);
    expect(d.unsubscribed).toBe(2);
    expect(d.clock.frames).toHaveLength(0);
  });

  it('shortens the hold and fade for reduced motion', async () => {
    const d = fakeDeps({ reducedMotion: true });
    const s = createLoadingScreen(root(), {}, d);
    d.be.finishNow();
    await s.finish();
    expect(d.waits).toEqual([200, 0]);
    expect(d.be.init!.reduced).toBe(true);
  });

  it('dispose is idempotent and stops the caption loop', () => {
    const d = fakeDeps();
    const s = createLoadingScreen(root(), {}, d);
    const pending = d.clock.frames[0];
    s.dispose();
    s.dispose();
    expect(d.unsubscribed).toBe(2);
    pending(100);
    expect(d.clock.frames).toHaveLength(0);
  });
});

describe('boot steps on a time axis', () => {
  it('starts the download step at once and moves through steps by time; fixed previews get none', async () => {
    const d = fakeDeps();
    const s = createLoadingScreen(root(), {}, d);
    expect(d.be.spans).toHaveLength(1);
    expect(d.be.spans[0][0]).toBe(0);
    d.clock.time = 1000;
    await s.step('Cutting the stone…');
    expect(d.be.spans).toHaveLength(2);
    expect(d.be.spans[1][0]).toBeCloseTo(d.be.spans[0][1]);
    expect(label()).toMatch(/^Cutting the stone… \|/);
    await s.step('FURNISHING THE ROOMS…');   // case-insensitive
    await s.step('Something new…');          // unknown: caption only
    expect(d.be.spans).toHaveLength(3);
    expect(label()).toMatch(/^Something new… \|/);
    d.clock.time = 5000;
    d.be.finishNow();
    await s.finish();
    expect(d.memory.saves).toBe(1);
    expect(Object.keys(d.memory.data!)).toEqual(['down to the cellar…', 'cutting the stone…', 'furnishing the rooms…']);

    const f = fakeDeps();
    const p = createLoadingScreen(root(), { fixed: 0.5 }, f);
    await p.step('Cutting the stone…');
    expect(f.be.spans).toHaveLength(0);
  });
});
