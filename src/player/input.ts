// Key input (input-systems): keys by KeyboardEvent.code, so WASD works on any layout. KeyboardInput
// listens to the window it is given; ScriptedInput is driven by tests and __game.input(); MergedInput
// combines them. Mouse look lives in src/camera/mouseLook.ts.

export interface InputSource {
  /** Any of these keys held? */
  down(...codes: string[]): boolean;
  /** True once per press of this key (consumes it). */
  take(code: string): boolean;
}

/** Keys held by a script, with presses for newly held keys. */
export class ScriptedInput implements InputSource {
  held = new Set<string>();
  private pressed = new Set<string>();
  /** Hold exactly these keys; newly held keys count as presses. */
  hold(keys: Iterable<string>) {
    const next = new Set(keys);
    for (const k of next) if (!this.held.has(k)) this.pressed.add(k);
    this.held = next;
  }
  press(code: string) { this.pressed.add(code); }
  down(...codes: string[]) { return codes.some((c) => this.held.has(c)); }
  take(code: string) { const p = this.pressed.has(code); this.pressed.delete(code); return p; }
}

export class MergedInput implements InputSource {
  constructor(private parts: InputSource[]) {}
  down(...codes: string[]) { return this.parts.some((p) => p.down(...codes)); }
  take(code: string) { let any = false; for (const p of this.parts) any = p.take(code) || any; return any; }
}

/** The bits of a keyboard event we read. */
export interface KeyEventLike { code: string; repeat?: boolean; target?: unknown; preventDefault?(): void }
export interface KeyEventSource {
  addEventListener(type: 'keydown' | 'keyup', l: (e: KeyEventLike) => void): void;
  addEventListener(type: 'blur', l: () => void): void;
}

/** Keys that games use and the page would otherwise act on (scrolling) while playing. */
const GAME_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown']);

export class KeyboardInput implements InputSource {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  /** Fired once per physical key press (no repeats): mode switches and the like. */
  onPress: ((code: string) => void) | null = null;
  /** While true, game keys do not reach the page (no scrolling on Space). */
  capture: () => boolean = () => false;

  constructor(win: KeyEventSource) {
    win.addEventListener('keydown', (e: KeyEventLike) => {
      if ((e.target as { tagName?: string } | undefined)?.tagName === 'INPUT') return;
      if (!e.repeat) { this.pressed.add(e.code); this.onPress?.(e.code); }
      this.keys.add(e.code);
      if (this.capture() && GAME_KEYS.has(e.code)) e.preventDefault?.();
    });
    win.addEventListener('keyup', (e: KeyEventLike) => { this.keys.delete(e.code); });
    win.addEventListener('blur', () => this.clear());
  }

  /** Release every held key (window blur, pointer unlock: don't keep walking after Esc). */
  clear() { this.keys.clear(); this.pressed.clear(); }
  down(...codes: string[]) { return codes.some((c) => this.keys.has(c)); }
  take(code: string) { const p = this.pressed.has(code); this.pressed.delete(code); return p; }
}
