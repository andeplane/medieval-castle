// MinimalHud with typed fakes: help text, crosshair on lock, prompt forwarding, toasts that restore help.
import { describe, it, expect } from 'vitest';
import { MinimalHud, type HudElements, type Timers } from '../src/player/hud';

class FakeTimers implements Timers {
  pending = new Map<number, () => void>(); next = 1; cleared: unknown[] = [];
  set(fn: () => void) { const h = this.next++; this.pending.set(h, fn); return h; }
  clear(h: unknown) { this.cleared.push(h); this.pending.delete(h as number); }
  fireAll() { const fns = [...this.pending.values()]; this.pending.clear(); for (const f of fns) f(); }
}

describe('MinimalHud', () => {
  it('shows help, the crosshair while locked, forwards prompts, and toasts over the help', () => {
    const el: HudElements = { help: { textContent: '' }, crosshair: { hidden: true } };
    const prompts: (string | null)[] = [];
    const t = new FakeTimers();
    const hud = new MinimalHud(el, { show: (l) => prompts.push(l) }, t);
    hud.setHelp('WASD walk');
    expect(el.help.textContent).toBe('WASD walk');
    hud.setLocked(true); expect(el.crosshair.hidden).toBe(false);
    hud.setLocked(false); expect(el.crosshair.hidden).toBe(true);
    hud.setPrompt('Open the gate'); hud.setPrompt(null);
    expect(prompts).toEqual(['Open the gate', null]);
    hud.toast('Footsteps off');
    expect(el.help.textContent).toBe('Footsteps off');
    hud.setHelp('Esc releases'); // help changes under a toast: shown when the toast ends
    expect(el.help.textContent).toBe('Footsteps off');
    hud.toast('Footsteps on'); // a second toast replaces the first
    expect(t.cleared).toEqual([1]);
    t.fireAll();
    expect(el.help.textContent).toBe('Esc releases');
  });
});
