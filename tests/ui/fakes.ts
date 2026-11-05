// Type-safe fakes for the HUD's injected key source, timers and camera rig.
import type { KeyLike, KeySource, Timers, HudDeps } from '../../src/ui/hud';
import type { RigLike } from '../../src/ui/gameHud';
import type { HelpMode } from '../../src/ui/help';

export interface FakeKeys extends KeySource {
  listeners: ((e: KeyLike) => void)[];
  press(code: string, extra?: Partial<KeyLike>): { prevented: boolean };
}
export function fakeKeys(): FakeKeys {
  const k: FakeKeys = {
    listeners: [],
    addEventListener: (_t, l) => { k.listeners.push(l); },
    removeEventListener: (_t, l) => { k.listeners = k.listeners.filter((x) => x !== l); },
    press(code, extra = {}) {
      const r = { prevented: false };
      for (const l of [...k.listeners]) l({ code, preventDefault: () => { r.prevented = true; }, ...extra });
      return r;
    },
  };
  return k;
}

export interface FakeTimers extends Timers {
  now: number;
  pending(): number;
  /** advance the clock, firing due callbacks in order (callbacks may schedule more) */
  advance(ms: number): void;
}
export function fakeTimers(): FakeTimers {
  let id = 0;
  const q = new Map<number, { at: number; f: () => void }>();
  const t: FakeTimers = {
    now: 0,
    set: (f, ms) => { q.set(++id, { at: t.now + ms, f }); return id; },
    clear: (i) => { q.delete(i); },
    pending: () => q.size,
    advance(ms) {
      const end = t.now + ms;
      for (;;) {
        const due = [...q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        q.delete(due[0]); t.now = due[1].at; due[1].f();
      }
      t.now = end;
    },
  };
  return t;
}

export function hudDeps(o: Partial<HudDeps> = {}): HudDeps & { keys: FakeKeys; timers: FakeTimers } {
  document.body.innerHTML = '';
  return { doc: document, keys: fakeKeys(), timers: fakeTimers(), ...o } as HudDeps & { keys: FakeKeys; timers: FakeTimers };
}

export interface FakeView { name: string; label: string; mode: HelpMode }
export interface FakeRig extends RigLike<FakeView> { mode: HelpMode; locked: boolean; log: string[] }
export function fakeRig(mode: HelpMode = 'walk'): FakeRig {
  const r: FakeRig = {
    mode, locked: false, log: [],
    setMode: (m) => { r.mode = m; r.log.push(`mode ${m}`); },
    go: (v) => { r.mode = v.mode; r.log.push(`go ${v.name}`); },
  };
  return r;
}
