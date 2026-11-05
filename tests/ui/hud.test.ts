// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { createHud } from '../../src/ui/hud';
import { hudDeps } from './fakes';

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const tools = (log: string[] = []) => ({ title: 'Tools', sections: [{ kind: 'actions' as const, id: 'v', label: 'Views', options: [{ id: 'a', label: 'A' }], onPick: (id: string) => log.push(id) }] });

describe('createHud', () => {
  it('mounts one root with the ids older code looks up', () => {
    const d = hudDeps();
    const hud = createHud(d);
    expect(hud.root.id).toBe('hud');
    expect(hud.root.parentElement).toBe(document.body);
    expect(q('#crosshair').hidden).toBe(true);
    expect(q('#help').hidden).toBe(true); // nothing to say yet
    expect(q('.hud-toggle').hidden).toBe(true); // no tools mounted
    expect(hud.locked).toBe(false);
    const parent = document.createElement('div');
    const h2 = createHud({ ...d, parent });
    expect(h2.root.parentElement).toBe(parent);
  });

  it('renders help as keycaps from items or from a plain string', () => {
    const hud = createHud(hudDeps());
    hud.setHelp([{ keys: 'E/Q', action: 'up / down' }, { action: 'plain' }]);
    const hints = [...document.querySelectorAll('#help .hint')];
    expect(hints).toHaveLength(2);
    expect([...hints[0].querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['E', 'Q']);
    expect(hints[0].textContent).toBe('E/Qup / down');
    expect(hints[1].querySelector('kbd')).toBeNull();
    hud.setHelp([{ keys: '`', action: 'tools' }]);
    expect(document.querySelector('#help kbd')?.className).toBe('glyph');
    hud.setHelp('WASD walk · Shift run');
    expect([...document.querySelectorAll('#help kbd')].map((k) => k.textContent)).toEqual(['WASD', 'Shift']);
    expect(q('#help').hidden).toBe(false);
  });

  it('shows the prompt and rings the crosshair while something is targeted', () => {
    const hud = createHud(hudDeps());
    const prompt = q('.hud-prompt');
    expect(prompt.getAttribute('role')).toBe('status');
    hud.setPrompt('Open door');
    expect(prompt.classList.contains('is-on')).toBe(true);
    expect(hud.root.classList.contains('has-target')).toBe(true);
    expect(prompt.querySelector('kbd')?.textContent).toBe('E');
    expect(q('#crosshair').hidden).toBe(false); // shown with a target even while the mouse is free
    expect(prompt.querySelector('span')?.textContent).toBe('Open door');
    hud.setPrompt('Open door'); // no change
    hud.promptView.show('Raise portcullis');
    expect(prompt.querySelector('span')?.textContent).toBe('Raise portcullis');
    hud.setPrompt('Pick up', 'F');
    expect(prompt.querySelector('kbd')?.textContent).toBe('F');
    hud.promptView.dispose();
    expect(prompt.classList.contains('is-on')).toBe(false);
    expect(hud.root.classList.contains('has-target')).toBe(false);
    expect(q('#crosshair').hidden).toBe(true);
    expect(prompt.querySelector('span')?.textContent).toBe('Pick up'); // keeps the text while it fades
  });

  it('on the first lock shows the crosshair and a controls card that fades once', () => {
    const d = hudDeps();
    const hud = createHud(d, { cardMs: 1000 });
    const card = q('.hud-card');
    hud.setLocked(true); // no help yet: no card
    expect(card.hidden).toBe(true);
    hud.setLocked(false);
    hud.setHelp('WASD walk · Esc release');
    hud.setLocked(true);
    expect(hud.locked).toBe(true);
    expect(hud.root.classList.contains('is-locked')).toBe(true);
    expect(q('#crosshair').hidden).toBe(false);
    expect(q('#help').hidden).toBe(true);
    expect(card.hidden).toBe(false);
    expect(card.querySelector('h2')?.textContent).toBe('Controls');
    expect(card.querySelectorAll('li')).toHaveLength(2);
    hud.setLocked(true); // repeated: nothing
    d.timers.advance(999);
    expect(card.classList.contains('is-out')).toBe(false);
    d.timers.advance(1);
    expect(card.classList.contains('is-out')).toBe(true);
    d.timers.advance(600);
    expect(card.hidden).toBe(true);
    expect(card.classList.contains('is-out')).toBe(false);
    // later locks do not show it again
    hud.setLocked(false);
    hud.setLocked(true);
    expect(card.hidden).toBe(true);
  });

  it('shows the card again on H, and holds it when asked', () => {
    const d = hudDeps({ reducedMotion: true });
    const hud = createHud(d);
    d.keys.press('KeyH');
    expect(q('.hud-card').hidden).toBe(true); // no help yet
    hud.setHelp('E use');
    d.keys.press('KeyH');
    expect(q('.hud-card').hidden).toBe(false);
    d.timers.advance(4500);
    d.timers.advance(0);
    expect(q('.hud-card').hidden).toBe(true); // reduced motion: no fade time
    hud.showControls(Infinity);
    d.timers.advance(60_000);
    expect(q('.hud-card').hidden).toBe(false);
    expect(d.timers.pending()).toBe(0);
    d.keys.press('KeyH', { repeat: true }); // auto-repeat ignored
  });

  it('toasts and replaces a running toast', () => {
    const d = hudDeps();
    const hud = createHud(d);
    const t = q('.hud-toast');
    hud.toast('The gate is barred');
    expect(t.textContent).toBe('The gate is barred');
    expect(t.classList.contains('is-on')).toBe(true);
    d.timers.advance(2000);
    hud.toast('Again', 1000);
    d.timers.advance(999);
    expect(t.classList.contains('is-on')).toBe(true);
    d.timers.advance(1);
    expect(t.classList.contains('is-on')).toBe(false);
    expect(d.timers.pending()).toBe(0);
  });

  it('toggles the tools with ` and Esc, focusing the first control and releasing the mouse', () => {
    const d = hudDeps();
    let released = 0;
    const hud = createHud(d, { onToolsOpen: () => { released++; } });
    expect(d.keys.press('Backquote').prevented).toBe(false); // no panel yet
    const log: string[] = [];
    const panel = hud.tools(tools(log));
    const toggle = q<HTMLButtonElement>('.hud-toggle');
    expect(hud.toolsOpen).toBe(false);
    expect(panel.el.hidden).toBe(true);
    expect(toggle.hidden).toBe(false);
    expect(toggle.getAttribute('aria-controls')).toBe('hud-tools');
    expect(d.keys.press('Backquote').prevented).toBe(true);
    expect(hud.toolsOpen).toBe(true);
    expect(panel.el.hidden).toBe(false);
    expect(toggle.hidden).toBe(true);
    expect(document.activeElement?.textContent).toBe('A');
    expect(released).toBe(0); // not locked
    d.keys.press('Escape');
    expect(hud.toolsOpen).toBe(false);
    expect(document.activeElement).not.toBe(panel.first());
    d.keys.press('Escape'); // already shut: nothing
    toggle.click();
    expect(hud.toolsOpen).toBe(true);
    hud.setToolsOpen(true); // no change
    panel.el.querySelector<HTMLButtonElement>('.tools-close')!.click();
    expect(hud.toolsOpen).toBe(false);
    // typing in a text field does not toggle; a focused slider does
    const text = document.createElement('input');
    d.keys.press('Backquote', { target: text });
    expect(hud.toolsOpen).toBe(false);
    const area = document.createElement('textarea');
    d.keys.press('Backquote', { target: area });
    expect(hud.toolsOpen).toBe(false);
    const range = document.createElement('input'); range.type = 'range';
    d.keys.press('Backquote', { target: range });
    expect(hud.toolsOpen).toBe(true);
    // locking shuts the tools; opening them while locked asks to release the mouse
    hud.setLocked(true);
    expect(hud.toolsOpen).toBe(false);
    expect(toggle.hidden).toBe(true);
    d.keys.press('Backquote');
    expect(released).toBe(1);
    expect(hud.toolsOpen).toBe(true);
    // closing while focus is elsewhere leaves focus alone
    const outside = document.createElement('button'); document.body.append(outside); outside.focus();
    hud.setToolsOpen(false);
    expect(document.activeElement).toBe(outside);
  });

  it('opens a freshly mounted panel when asked, replacing the old one', () => {
    const hud = createHud(hudDeps());
    const a = hud.tools(tools());
    const b = hud.tools(tools(), true);
    expect(a.el.isConnected).toBe(false);
    expect(b.el.isConnected).toBe(true);
    expect(hud.toolsOpen).toBe(true);
    expect(b.el.classList.contains('hud-tools')).toBe(true);
  });

  it('stops listening and clears its timers on dispose', () => {
    const d = hudDeps();
    const hud = createHud(d);
    hud.setHelp('E use');
    hud.setLocked(true);
    hud.toast('x');
    expect(d.timers.pending()).toBe(2);
    hud.dispose();
    expect(d.timers.pending()).toBe(0);
    expect(d.keys.listeners).toHaveLength(0);
    expect(hud.root.isConnected).toBe(false);
    createHud(d).dispose(); // nothing running
  });
});
