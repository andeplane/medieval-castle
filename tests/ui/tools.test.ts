// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { createToolsPanel, type ToolsConfig } from '../../src/ui/tools';

function config(log: string[]): ToolsConfig {
  return {
    title: 'Tools',
    sections: [
      { kind: 'choice', id: 'mode', label: 'Camera', value: 'walk', options: [{ id: 'orbit', label: 'Orbit' }, { id: 'walk', label: 'Walk' }], onChange: (id) => log.push(`mode ${id}`) },
      { kind: 'range', id: 'time', label: 'Time of day', min: 6, max: 20, step: 0.5, value: 15, format: (v) => `${v} h`, onInput: (v) => log.push(`time ${v}`) },
      { kind: 'actions', id: 'views', label: 'Views', options: [{ id: 'hero', label: 'Hero' }, { id: 'gate', label: 'Gate' }], onPick: (id) => log.push(`view ${id}`) },
      { kind: 'select', id: 'piece', label: 'Pieces', placeholder: 'Choose…', options: [{ id: 'p-chair', label: 'Chair' }], onPick: (id) => log.push(`piece ${id}`) },
    ],
  };
}

describe('createToolsPanel', () => {
  it('builds labelled, keyboard-reachable controls for each section', () => {
    const log: string[] = [];
    const p = createToolsPanel(document, config(log));
    document.body.append(p.el);
    expect(p.el.tagName).toBe('ASIDE');
    expect(p.el.id).toBe('tools');
    expect(p.el.getAttribute('aria-label')).toBe('Tools');
    expect(p.el.querySelector('h2')?.textContent).toBe('Tools');
    expect(p.el.querySelector('.tools-close')).toBeNull();
    expect(p.first()?.textContent).toBe('Orbit');
    for (const g of p.el.querySelectorAll('[aria-labelledby]')) expect(document.getElementById(g.getAttribute('aria-labelledby')!)).not.toBeNull();

    // choice: aria-pressed follows clicks and set()
    const seg = [...p.el.querySelectorAll<HTMLButtonElement>('.tools-seg button')];
    expect(seg.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    seg[0].click();
    expect(log).toEqual(['mode orbit']);
    expect(seg[0].getAttribute('aria-pressed')).toBe('true');
    p.set('mode', 'walk');
    expect(seg[1].getAttribute('aria-pressed')).toBe('true');

    // range: value printed in the label and as aria-valuetext
    const range = p.el.querySelector<HTMLInputElement>('input[type=range]')!;
    const out = p.el.querySelector('output')!;
    expect(out.textContent).toBe('15 h');
    range.value = '9.5';
    range.dispatchEvent(new Event('input'));
    expect(log.at(-1)).toBe('time 9.5');
    expect(range.getAttribute('aria-valuetext')).toBe('9.5 h');
    p.set('time', 12);
    expect(out.textContent).toBe('12 h');

    // actions
    p.el.querySelectorAll<HTMLButtonElement>('.tools-list button')[1].click();
    expect(log.at(-1)).toBe('view gate');
    // a mouse click drops focus (so Space does not press it again); a keyboard press keeps it
    const gate = p.el.querySelectorAll<HTMLButtonElement>('.tools-list button')[1];
    gate.focus();
    gate.dispatchEvent(new MouseEvent('click', { detail: 0 }));
    expect(document.activeElement).toBe(gate);
    gate.dispatchEvent(new MouseEvent('click', { detail: 1 }));
    expect(document.activeElement).not.toBe(gate);
    seg[1].focus();
    seg[1].dispatchEvent(new MouseEvent('click', { detail: 1 }));
    expect(document.activeElement).not.toBe(seg[1]);
    expect(log.slice(-3)).toEqual(['view gate', 'view gate', 'mode walk']);

    // select: the placeholder does nothing, a piece goes there
    const sel = p.el.querySelector('select')!;
    sel.value = '';
    sel.dispatchEvent(new Event('change'));
    expect(log.at(-1)).toBe('mode walk');
    sel.value = 'p-chair';
    sel.dispatchEvent(new Event('change'));
    expect(log.at(-1)).toBe('piece p-chair');
    p.set('piece', '');
    expect(sel.value).toBe('');

    p.setStat('60 fps');
    expect(p.el.querySelector('.tools-stat')?.textContent).toBe('60 fps');
    p.set('unknown', 1); // ignored
  });

  it('adds a labelled close button when it can be closed, and a custom id', () => {
    let closed = 0;
    const p = createToolsPanel(document, { title: 'Prop kit', sections: [] }, { id: 'x', onClose: () => { closed++; } });
    expect(p.el.id).toBe('x');
    expect(p.first()).toBeNull();
    const b = p.el.querySelector<HTMLButtonElement>('.tools-close')!;
    expect(b.getAttribute('aria-label')).toBe('Close prop kit (`)');
    expect(b.querySelector('svg')).not.toBeNull();
    b.click();
    expect(closed).toBe(1);
  });
});
