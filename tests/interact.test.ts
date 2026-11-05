// Interaction targeting and the use action, with fake input/view; the DOM defaults with tiny fakes;
// procedural door audio against a fake AudioContext.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import type { Interactable } from '../src/castle/interior/types';
import { createInteraction, pickTarget, domUseInput, domPromptView, REACH, type UseInput, type PromptView } from '../src/game/interact';
import { DoorAudio } from '../src/game/doorAudio';

/** An interactable that is a wall-sized target at distance `d` straight ahead (−z) of the origin. */
function target(id: string, d: number, log: string[] = []): Interactable {
  let open = false;
  return {
    id,
    label: () => (open ? 'Close door' : 'Open door'),
    hit: (ray, max) => {
      if (ray.direction.z >= -0.5) return null;
      const t = (ray.origin.z + d) / -ray.direction.z;
      return t >= 0 && t <= max ? t : null;
    },
    use: () => { open = !open; log.push(id); },
  };
}
function fakeIO() {
  const shown: (string | null)[] = [];
  let fire: ((s: 'key' | 'click') => void) | null = null;
  let disposed = 0, unsubscribed = 0;
  const input: UseInput = { subscribe: (cb) => { fire = cb; return () => { unsubscribed++; }; } };
  const view: PromptView = { show: (l) => { shown.push(l); }, dispose: () => { disposed++; } };
  return { input, view, shown, press: () => fire?.('key'), counts: () => ({ disposed, unsubscribed }) };
}
const camera = () => { const c = new THREE.PerspectiveCamera(); c.position.set(0, 0, 0); c.lookAt(0, 0, -1); return c; };

describe('pickTarget', () => {
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));
  it('takes the nearest hit within reach', () => {
    expect(pickTarget(ray, [target('far', 2), target('near', 1)])?.item.id).toBe('near');
    expect(pickTarget(ray, [target('near', 1), target('far', 2)])?.item.id).toBe('near');
    expect(pickTarget(ray, [target('beyond', REACH + 0.5)])).toBeNull();
    expect(pickTarget(ray, [])).toBeNull();
  });
  it('skips targets behind something solid', () => {
    const wall = () => 0.5;
    expect(pickTarget(ray, [target('a', 1.5)], REACH, wall)).toBeNull();
    expect(pickTarget(ray, [target('a', 1.5)], REACH, () => 1.48)?.item.id).toBe('a'); // the door's own collider
    expect(pickTarget(ray, [target('a', 1.5)], REACH, () => null)?.item.id).toBe('a');
  });
});

describe('createInteraction', () => {
  it('shows the prompt for what the crosshair is on and uses it on the input action', () => {
    const io = fakeIO(), used: string[] = [];
    let items = [target('door', 1.2, used)];
    const ia = createInteraction(camera(), {} as HTMLElement, () => items, { input: io.input, view: io.view });
    ia.update();
    expect(io.shown.at(-1)).toBe('Open door');
    expect(ia.target()).toEqual({ id: 'door', label: 'Open door', dist: 1.2 });
    io.press();
    expect(used).toEqual(['door']);
    expect(io.shown.at(-1)).toBe('Close door');
    expect(ia.use()).toBe(true);
    items = [];
    ia.update();
    expect(io.shown.at(-1)).toBeNull();
    expect(ia.target()).toBeNull();
    expect(ia.use()).toBe(false);
    ia.dispose();
    expect(io.counts()).toEqual({ disposed: 1, unsubscribed: 1 });
  });
  it('honours a custom reach', () => {
    const io = fakeIO();
    const ia = createInteraction(camera(), {} as HTMLElement, () => [target('door', 1.2)], { input: io.input, view: io.view, reach: 1 });
    ia.update();
    expect(ia.target()).toBeNull();
  });
});

// --------------------------------------------------------------------------- DOM defaults with fakes

class FakeEl {
  id = ''; textContent = ''; children: FakeEl[] = []; attrs: Record<string, string> = {}; removed = false;
  cls = new Set<string>();
  classList = { toggle: (c: string, on: boolean) => { if (on) this.cls.add(c); else this.cls.delete(c); } };
  constructor(public tagName: string) {}
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  append(...e: FakeEl[]) { this.children.push(...e); }
  appendChild(e: FakeEl) { this.children.push(e); }
  remove() { this.removed = true; }
}
function fakeDoc() {
  const head = new FakeEl('HEAD'), body = new FakeEl('BODY');
  return { head, body, createElement: (t: string) => new FakeEl(t.toUpperCase()) };
}

describe('DOM prompt view', () => {
  it('adds a dot and a chip, toggles them and cleans up', () => {
    const doc = fakeDoc();
    const v = domPromptView(doc as unknown as Document);
    const [dot, chip] = doc.body.children;
    expect(dot.id).toBe('xhair'); expect(chip.id).toBe('useprompt');
    expect(chip.attrs.role).toBe('status');
    v.show('Open gate');
    expect(chip.cls.has('on')).toBe(true);
    expect(chip.children[1].textContent).toBe('Open gate');
    v.show('Open gate');
    v.show(null);
    expect(dot.cls.has('on')).toBe(false);
    expect(chip.children[1].textContent).toBe('Open gate'); // keeps the text while fading out
    v.dispose();
    expect(dot.removed && chip.removed && doc.head.children[0].removed).toBe(true);
  });
});

describe('DOM use input', () => {
  const key = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Event('keydown'), { code, repeat: false, ...extra });
  it('fires on E (not repeats, not in inputs, not when disabled) and on a locked left click', () => {
    const win = new EventTarget(), dom = new EventTarget() as EventTarget & { ownerDocument: { pointerLockElement: unknown } };
    dom.ownerDocument = { pointerLockElement: null };
    let enabled = true;
    const got: string[] = [];
    const off = domUseInput(dom as unknown as HTMLElement, win as unknown as Window, () => enabled).subscribe((s) => got.push(s));
    win.dispatchEvent(key('KeyE'));
    win.dispatchEvent(key('KeyW'));
    win.dispatchEvent(key('KeyE', { repeat: true }));
    enabled = false; win.dispatchEvent(key('KeyE')); enabled = true;
    const click = (button: number) => dom.dispatchEvent(Object.assign(new Event('pointerdown'), { button }));
    click(0); // not locked
    dom.ownerDocument.pointerLockElement = dom;
    click(2); click(0);
    expect(got).toEqual(['key', 'click']);
    // a key typed into an input field is ignored
    const ev = key('KeyE');
    Object.defineProperty(ev, 'target', { value: { tagName: 'INPUT' } });
    const listeners: ((e: Event) => void)[] = [];
    const win2 = { addEventListener: (_: string, f: (e: Event) => void) => listeners.push(f), removeEventListener: () => {} };
    domUseInput(dom as unknown as HTMLElement, win2 as unknown as Window).subscribe((s) => got.push(s));
    listeners[0](ev);
    expect(got).toEqual(['key', 'click']);
    off();
    win.dispatchEvent(key('KeyE'));
    expect(got).toHaveLength(2);
  });
});

// --------------------------------------------------------------------------- audio

/** A WebAudio stand-in: every node accepts any call, connect() chains, params take automation. */
function fakeAudio(state = 'running') {
  const calls: string[] = [];
  const node = (kind: string): unknown => new Proxy({ kind } as Record<string, unknown>, {
    get(t, p: string) {
      if (p in t) return t[p];
      if (p === 'connect') return (n: unknown) => n;
      if (['gain', 'frequency', 'Q', 'pan', 'offset', 'threshold', 'ratio', 'playbackRate'].includes(p)) return (t[p] = node('param'));
      return (...a: unknown[]) => { calls.push(`${kind}.${p}`); void a; return undefined; };
    },
    set(t, p: string, v) { t[p] = v; return true; },
  });
  const ctx = {
    state, currentTime: 1, sampleRate: 8000, destination: node('dest'),
    resume: () => { ctx.state = 'running'; calls.push('resume'); return Promise.resolve(); },
    createBuffer: (_c: number, n: number) => ({ getChannelData: () => new Float32Array(n) }),
    createGain: () => node('gain'), createOscillator: () => node('osc'), createBiquadFilter: () => node('filter'),
    createStereoPanner: () => node('pan'), createDynamicsCompressor: () => node('comp'), createBufferSource: () => node('src'),
    createConstantSource: () => node('const'),
  };
  return { ctx, calls };
}

describe('DoorAudio', () => {
  it('starts on the first gesture and plays every door sound, positioned', () => {
    const fa = fakeAudio('suspended'), gestures = new EventTarget();
    const cam = new THREE.PerspectiveCamera(); cam.updateMatrixWorld();
    const a = new DoorAudio(cam, { createContext: () => fa.ctx as unknown as AudioContext, gestures, now: () => 42 });
    a.play('creak', [1, 0, 0], 1); // before any gesture: logged, silent
    expect(a.log[0]).toEqual({ t: 42, name: 'creak', gain: expect.any(Number) });
    expect(fa.calls).toHaveLength(0);
    gestures.dispatchEvent(new Event('pointerdown'));
    expect(fa.calls).toContain('resume');
    gestures.dispatchEvent(new Event('keydown')); // already running
    for (const s of ['creak', 'latch', 'thud', 'bump', 'clank', 'chain'] as const) a.play(s, [2, 1, -3], s === 'thud' ? 2.2 : 1);
    a.play('creak', [0, 0, 0], 2.2); // heavy, right at the listener
    expect(fa.calls.filter((c) => c.endsWith('.start')).length).toBeGreaterThan(20);
    a.play('thud', [500, 0, 0], 1); // too far to hear
    expect(a.log.at(-1)!.gain).toBeLessThan(0.02);
    for (let i = 0; i < 50; i++) a.play('latch', [1, 0, 0], 1);
    expect(a.log.length).toBeLessThanOrEqual(40);
  });
  it('stays silent if no AudioContext can be made', () => {
    const gestures = new EventTarget();
    const a = new DoorAudio(new THREE.PerspectiveCamera(), { createContext: () => { throw new Error('no audio'); }, gestures });
    gestures.dispatchEvent(new Event('pointerdown'));
    a.play('thud', [0, 0, 0], 1);
    expect(a.ctx).toBeNull();
  });
});
