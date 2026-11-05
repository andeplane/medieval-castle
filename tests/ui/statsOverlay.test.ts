// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { createStatsOverlay, statsLines } from '../../src/ui/statsOverlay';
import { summarize } from '../../src/render/perf';

const s = { ...summarize([{ frameMs: 20, cpuMs: 2.25, drawCalls: 1866, triangles: 5_608_000 }]), gpuMs: 14.04 };
const r = { width: 2400, height: 1794, pixelRatio: 2, backend: 'webgpu' };

describe('stats overlay', () => {
  it('formats the numbers', () => {
    expect(Object.fromEntries(statsLines(s, r))).toEqual({ fps: '50', frame: '20.0 ms · p95 20.0', cpu: '2.3 ms', gpu: '14.0 ms', draws: '1.9 k', tris: '5.61 M', size: '2400×1794 @2', api: 'webgpu' });
    expect(Object.fromEntries(statsLines({ ...s, gpuMs: null, drawCalls: 12 }, r))).toMatchObject({ gpu: 'n/a', draws: '12' });
  });
  it('starts hidden, toggles, and only redraws while shown', () => {
    document.body.innerHTML = '';
    const o = createStatsOverlay(document);
    expect(o.el.parentElement).toBe(document.body);
    expect(o.visible).toBe(false);
    expect(o.el.hidden).toBe(true);
    o.update(s, r);
    expect(o.el.querySelectorAll('dt')).toHaveLength(0);
    o.toggle();
    expect(o.el.hidden).toBe(false);
    o.update(s, r);
    expect([...o.el.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['fps', 'frame', 'cpu', 'gpu', 'draws', 'tris', 'size', 'api']);
    o.update(s, r);
    expect(o.el.querySelectorAll('dd')).toHaveLength(8);
    o.setVisible(false);
    expect(o.el.hidden).toBe(true);
  });
  it('shows a note and a report, and clears them', () => {
    const parent = document.createElement('div');
    const o = createStatsOverlay(document, parent, true);
    expect(o.visible).toBe(true);
    const note = o.el.querySelector<HTMLElement>('.stats-note')!, pre = o.el.querySelector<HTMLElement>('.stats-report')!;
    expect(note.hidden && pre.hidden).toBe(true);
    o.note('bench 1/3'); o.report('| a |');
    expect([note.hidden, note.textContent, pre.hidden, pre.textContent]).toEqual([false, 'bench 1/3', false, '| a |']);
    o.note(null); o.report(null);
    expect([note.hidden, note.textContent, pre.hidden]).toEqual([true, '', true]);
  });
});
