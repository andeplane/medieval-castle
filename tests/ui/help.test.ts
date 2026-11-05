import { describe, it, expect } from 'vitest';
import { parseHelp, looksLikeKey, helpFor, HELP, uiFlags, clockText } from '../../src/ui/help';

describe('parseHelp', () => {
  it('splits the old " · " strings into key + action where a key leads', () => {
    expect(parseHelp('WASD walk · Shift run · E/Q up/down · Esc to release mouse · just text')).toEqual([
      { keys: 'WASD', action: 'walk' }, { keys: 'Shift', action: 'run' }, { keys: 'E/Q', action: 'up/down' },
      { keys: 'Esc', action: 'to release mouse' }, { action: 'just text' },
    ]);
    expect(parseHelp('Walk to a door and press E')).toEqual([{ action: 'Walk to a door and press E' }]);
    expect(parseHelp('  ')).toEqual([]);
    expect(parseHelp('Solo')).toEqual([{ action: 'Solo' }]);
  });
  it('recognises keys', () => {
    for (const k of ['E', 'WASD', 'E/Q', 'Shift', '`', 'F1', 'Click']) expect(looksLikeKey(k)).toBe(true);
    for (const k of ['Walk', 'door', 'WASDQE', 'E/door']) expect(looksLikeKey(k)).toBe(false);
  });
});

describe('helpFor', () => {
  it('gives the free line with the HUD keys, and the locked line without them', () => {
    const free = helpFor('walk', false);
    expect(free[0]).toEqual({ keys: 'Click', action: 'to look around' });
    expect(free.slice(-3).map((h) => h.keys)).toEqual(['H', '`', 'I']);
    expect(helpFor('walk', true)).toBe(HELP.walk.locked);
    expect(helpFor('walk', true).at(-1)).toEqual({ keys: 'Esc', action: 'release the mouse' });
    expect(helpFor('fly', true).map((h) => h.keys)).toContain('E/Q');
    expect(helpFor('orbit', true)).toEqual(HELP.orbit.free);
  });
});

describe('uiFlags', () => {
  it('reads the ?ui= review flags', () => {
    expect(uiFlags('')).toEqual({ visible: false, locked: false, tools: null, card: false });
    expect(uiFlags('?ui')).toEqual({ visible: true, locked: false, tools: null, card: false });
    expect(uiFlags('?shot&ui=locked, card')).toEqual({ visible: true, locked: true, tools: null, card: true });
    expect(uiFlags('?ui=tools').tools).toBe(true);
    expect(uiFlags('?ui=notools').tools).toBe(false);
  });
});

describe('clockText', () => {
  it('prints hours as hh:mm', () => {
    expect(clockText(15.5)).toBe('15:30');
    expect(clockText(6.5)).toBe('06:30');
    expect(clockText(19.99)).toBe('19:59');
    expect(clockText(23.999)).toBe('00:00');
  });
});
