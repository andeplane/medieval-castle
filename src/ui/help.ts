// What the HUD says about controls: key + action pairs per camera mode, before and after the mouse
// is captured, and the review flags (?ui=…) that keep the HUD visible in captures. Pure.

/** One control: the key(s) as printed on a keycap, and what they do. A missing key is plain text. */
export interface HelpItem { keys?: string; action: string }

export type HelpMode = 'orbit' | 'fly' | 'walk';

/**
 * Accepts the plain strings other modules already write ("WASD walk · Shift run · E use") and
 * turns each " · " segment into a key + action when it starts with something that looks like a key.
 */
export function parseHelp(text: string): HelpItem[] {
  return text.split(/\s+·\s+/).map((s) => s.trim()).filter(Boolean).map((seg) => {
    const m = /^(\S+)\s+(.+)$/.exec(seg);
    return m && looksLikeKey(m[1]) ? { keys: m[1], action: m[2] } : { action: seg };
  });
}

const NAMED = new Set(['Shift', 'Esc', 'Space', 'Tab', 'Ctrl', 'Alt', 'Enter', 'Click', 'Drag', 'Scroll', 'Mouse', '`']);
/** Single letters, digits, runs of capitals (WASD), slash pairs (E/Q) and named keys. */
export function looksLikeKey(t: string): boolean {
  return t.split('/').every((p) => NAMED.has(p) || /^[A-Z0-9`]{1,5}$/.test(p));
}

const ORBIT: HelpItem[] = [{ keys: 'Drag', action: 'orbit' }, { keys: 'Right-drag', action: 'pan' }, { keys: 'Scroll', action: 'zoom' }];
export const HELP: Record<HelpMode, { free: HelpItem[]; locked: HelpItem[] }> = {
  orbit: { free: ORBIT, locked: ORBIT },
  fly: {
    free: [{ keys: 'Click', action: 'to look around' }, { keys: 'WASD', action: 'fly' }, { keys: 'E/Q', action: 'up / down' }, { keys: 'Shift', action: 'fast' }],
    locked: [{ keys: 'WASD', action: 'fly' }, { keys: 'E/Q', action: 'up / down' }, { keys: 'Shift', action: 'fast' }, { keys: 'Click', action: 'use' }, { keys: 'Esc', action: 'release the mouse' }],
  },
  walk: {
    free: [{ keys: 'Click', action: 'to look around' }, { keys: 'WASD', action: 'walk' }, { keys: 'Shift', action: 'run' }, { keys: 'Space', action: 'jump' }, { keys: 'C', action: 'crouch' }, { keys: 'E', action: 'use' }],
    locked: [{ keys: 'WASD', action: 'walk' }, { keys: 'Shift', action: 'run' }, { keys: 'Space', action: 'jump' }, { keys: 'C', action: 'crouch' }, { keys: 'E', action: 'open, close, use' }, { keys: 'Esc', action: 'release the mouse' }],
  },
};

/** The help line for a mode, with the HUD's own keys (tools, controls) added to the free line. */
export function helpFor(mode: HelpMode, locked: boolean): HelpItem[] {
  return locked ? HELP[mode].locked : [...HELP[mode].free, { keys: 'H', action: 'controls' }, { keys: '`', action: 'tools' }];
}

/**
 * ?ui=… review flags, a comma list; present at all means the HUD stays visible under ?shot.
 * locked: draw it as if the mouse were captured · tools / notools: panel open or shut · card: hold the controls card.
 */
export interface UiFlags { visible: boolean; locked: boolean; tools: boolean | null; card: boolean }
export function uiFlags(search: string): UiFlags {
  const q = new URLSearchParams(search);
  const raw = q.get('ui');
  const set = new Set((raw ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  return {
    visible: raw !== null,
    locked: set.has('locked'),
    tools: set.has('tools') ? true : set.has('notools') ? false : null,
    card: set.has('card'),
  };
}

/** "15.5" hours → "15:30". */
export function clockText(hours: number): string {
  const m = Math.round(hours * 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
