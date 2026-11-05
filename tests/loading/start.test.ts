import { describe, it, expect, vi } from 'vitest';
import { start, type EntryDeps } from '../../src/loading/start';
import type { LoadingScreen } from '../../src/loading/tunnel';

function deps(search: string) {
  const screen: LoadingScreen = { shown: 0, progress: vi.fn(async () => {}), finish: vi.fn(async () => {}), dispose: vi.fn() };
  let tick: (() => void) | null = null;
  const d: EntryDeps = {
    search,
    screen: () => screen,
    bootGame: vi.fn(async () => ({})),
    every: (_ms, f) => { tick = f; },
    reload: vi.fn(),
  };
  return { d, screen, run: (n: number) => { for (let i = 0; i < n; i++) tick!(); } };
}

describe('entry start', () => {
  it('boots the game behind the tunnel by default', () => {
    const { d } = deps('');
    expect(start(d)).toBe('boot');
    expect(d.bootGame).toHaveBeenCalledOnce();
  });
  it('holds a fixed preview without booting', () => {
    const { d } = deps('?loading=0.4');
    expect(start(d)).toBe('hold');
    expect(d.bootGame).not.toHaveBeenCalled();
  });
  it('loops a fake load in demo mode', () => {
    const { d, screen, run } = deps('?loading=demo');
    expect(start(d)).toBe('demo');
    run(1);
    expect(screen.progress).toHaveBeenLastCalledWith(0.04, 'Cutting the stone…');
    run(15);
    expect(screen.progress).toHaveBeenLastCalledWith(expect.closeTo(0.64), 'Raising the walls…');
    run(9);
    expect(screen.progress).toHaveBeenLastCalledWith(1, 'Lighting…');
    run(20);
    expect(d.reload).toHaveBeenCalled();
    expect(d.bootGame).not.toHaveBeenCalled();
  });
});
