// Key input sources and procedural footsteps, with typed fakes for the window and the AudioContext.
import { describe, it, expect } from 'vitest';
import { KeyboardInput, ScriptedInput, MergedInput, type KeyEventLike, type KeyEventSource } from '../src/player/input';
import { Footsteps, browserAudio } from '../src/player/footsteps';

class FakeWindow implements KeyEventSource {
  l: Record<string, ((e: KeyEventLike) => void)[]> = {};
  addEventListener(type: string, f: (e: KeyEventLike) => void) { (this.l[type] ??= []).push(f); }
  fire(type: string, e: KeyEventLike = { code: '' }) { for (const f of this.l[type] ?? []) f(e); }
}

describe('KeyboardInput', () => {
  it('tracks held keys, single presses, repeats, inputs fields, blur and capture', () => {
    const w = new FakeWindow(), k = new KeyboardInput(w);
    const presses: string[] = [];
    k.onPress = (c) => presses.push(c);
    w.fire('keydown', { code: 'KeyW' });
    w.fire('keydown', { code: 'KeyW', repeat: true });
    expect(k.down('KeyW')).toBe(true);
    expect(k.down('KeyS', 'KeyA')).toBe(false);
    expect(presses).toEqual(['KeyW']);
    expect(k.take('KeyW')).toBe(true);
    expect(k.take('KeyW')).toBe(false);
    w.fire('keyup', { code: 'KeyW' });
    expect(k.down('KeyW')).toBe(false);
    w.fire('keydown', { code: 'KeyE', target: { tagName: 'INPUT' } });
    expect(k.down('KeyE')).toBe(false);
    let prevented = 0;
    const space = { code: 'Space', preventDefault: () => { prevented++; } };
    w.fire('keydown', space);
    expect(prevented).toBe(0);
    k.capture = () => true;
    w.fire('keydown', { ...space, repeat: true });
    w.fire('keydown', { code: 'KeyQ', preventDefault: () => { prevented += 10; } });
    expect(prevented).toBe(1);
    w.fire('blur');
    expect(k.down('Space', 'KeyQ')).toBe(false);
  });
});

describe('ScriptedInput and MergedInput', () => {
  it('holds keys, turns new holds into presses, merges sources', () => {
    const a = new ScriptedInput(), b = new ScriptedInput(), m = new MergedInput([a, b]);
    a.hold(['KeyW']);
    expect(m.down('KeyW')).toBe(true);
    expect(m.take('KeyW')).toBe(true);
    a.hold(['KeyW', 'Space']);
    expect(a.take('KeyW')).toBe(false); // still held, not a new press
    b.press('Space');
    expect(m.take('Space')).toBe(true);
    expect(m.take('Space')).toBe(false);
    expect(m.down('KeyX')).toBe(false);
  });
});

// ---- footsteps against a typed fake AudioContext
class P { value = 0; setValueAtTime(v: number) { this.value = v; return this; } linearRampToValueAtTime(v: number) { this.value = v; return this; } exponentialRampToValueAtTime(v: number) { this.value = v; return this; } }
class N { connected: N[] = []; connect(n: N) { this.connected.push(n); return n; } disconnect() { this.connected = []; } }
class FakeAudio {
  sampleRate = 8000; currentTime = 0; state = 'running'; destination = new N(); resumed = 0; nodes: N[] = [];
  private mk<T extends N>(n: T) { this.nodes.push(n); return n; }
  createGain() { return this.mk(Object.assign(new N(), { gain: new P() })); }
  createBiquadFilter() { return this.mk(Object.assign(new N(), { type: '', frequency: new P(), Q: new P() })); }
  createBufferSource() { return this.mk(Object.assign(new N(), { buffer: null as unknown, playbackRate: new P(), start: () => {} })); }
  createOscillator() { const o = Object.assign(new N(), { type: '', frequency: new P(), start: () => {}, stop: () => { o.onended?.(); }, onended: null as null | (() => void) }); return this.mk(o); }
  createBuffer(_c: number, n: number) { const d = new Float32Array(n); return { getChannelData: () => d }; }
  resume() { this.resumed++; return Promise.resolve(); }
}

describe('Footsteps', () => {
  it('stays silent until unlocked, then plays every surface; can be muted', () => {
    const ctx = new FakeAudio();
    const f = new Footsteps(() => ctx as unknown as AudioContext);
    f.play('stone', false);
    expect(ctx.nodes.length).toBe(0);
    f.unlock();
    for (const s of ['stone', 'wood', 'grass', 'dirt'] as const) { f.play(s, false); f.play(s, true, 1.3); }
    expect(ctx.nodes.length).toBeGreaterThan(8 * 5);
    f.unlock();
    expect(ctx.resumed).toBe(1);
    const n = ctx.nodes.length;
    f.enabled = false; f.play('wood', false);
    f.enabled = true; ctx.state = 'suspended'; f.play('wood', false);
    expect(ctx.nodes.length).toBe(n);
  });
  it('copes without an AudioContext', () => {
    const f = new Footsteps(() => null);
    f.unlock(); f.play('stone', false);
    expect(browserAudio({})()).toBeNull();
    expect(browserAudio({ AudioContext: FakeAudio as unknown as typeof AudioContext })()).toBeInstanceOf(FakeAudio);
  });
});
