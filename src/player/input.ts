// Input sources (input-systems): keys by KeyboardEvent.code (layout independent) plus mouse look.
// BrowserInput listens to a window, document and canvas it is given (pointer lock, drag fallback);
// ScriptedInput is driven by tests and __game.input(); MergedInput combines them.

export interface InputSource {
  /** Any of these keys held? */
  down(...codes: string[]): boolean;
  /** True once per press of this key (consumes it). */
  take(code: string): boolean;
  /** Mouse movement since the last call, in pixels (consumes it). */
  look(): [number, number];
}

/** Keys held by a script, presses queued, look deltas added by hand. */
export class ScriptedInput implements InputSource {
  held = new Set<string>();
  private pressed = new Set<string>();
  private dx = 0; private dy = 0;
  /** Hold exactly these keys; newly held keys count as presses. */
  hold(keys: Iterable<string>) {
    const next = new Set(keys);
    for (const k of next) if (!this.held.has(k)) this.pressed.add(k);
    this.held = next;
  }
  press(code: string) { this.pressed.add(code); }
  move(dx: number, dy: number) { this.dx += dx; this.dy += dy; }
  clear() { this.held.clear(); this.pressed.clear(); this.dx = this.dy = 0; }
  down(...codes: string[]) { return codes.some((c) => this.held.has(c)); }
  take(code: string) { const p = this.pressed.has(code); this.pressed.delete(code); return p; }
  look(): [number, number] { const d: [number, number] = [this.dx, this.dy]; this.dx = this.dy = 0; return d; }
}

export class MergedInput implements InputSource {
  constructor(private parts: InputSource[]) {}
  down(...codes: string[]) { return this.parts.some((p) => p.down(...codes)); }
  take(code: string) { let any = false; for (const p of this.parts) any = p.take(code) || any; return any; }
  look(): [number, number] { let x = 0, y = 0; for (const p of this.parts) { const [a, b] = p.look(); x += a; y += b; } return [x, y]; }
}

type Listener = (e: Event) => void;
export interface EventSource { addEventListener(type: string, f: Listener): void }
export interface LockDocument extends EventSource { pointerLockElement: Element | null; exitPointerLock(): void }
export interface LockTarget extends EventSource { requestPointerLock?(): unknown; setPointerCapture?(id: number): void }

/** Pointer-lock FPS input (behaviours from PR #5): click to lock, Esc releases, drag as a fallback. */
export class BrowserInput implements InputSource {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  private dx = 0; private dy = 0;
  private dragging = false;
  /** Mouse look on (walk and fly); off in orbit, where OrbitControls own the mouse. */
  lookEnabled = false;
  locked = false;
  /** Fired once per physical key press (no repeats): mode switches and the like. */
  onPress: ((code: string) => void) | null = null;
  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(win: EventSource, private doc: LockDocument, dom: LockTarget) {
    win.addEventListener('keydown', (ev) => {
      const e = ev as KeyboardEvent;
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
      if (!e.repeat) { this.pressed.add(e.code); this.onPress?.(e.code); }
      this.keys.add(e.code);
      // keep the page from scrolling while playing
      if (this.locked && (e.code === 'Space' || e.code === 'KeyC')) e.preventDefault();
    });
    win.addEventListener('keyup', (e) => this.keys.delete((e as KeyboardEvent).code));
    win.addEventListener('blur', () => this.clear());
    dom.addEventListener('pointerdown', (ev) => {
      if (!this.lookEnabled) return;
      if (!this.locked && dom.requestPointerLock) {
        const r = dom.requestPointerLock() as Promise<void> | undefined;
        r?.catch?.(() => {});
      }
      if (this.locked) return; // setPointerCapture throws InvalidStateError while locked
      this.dragging = true;
      try { dom.setPointerCapture?.((ev as PointerEvent).pointerId); } catch { /* ignore */ }
    });
    dom.addEventListener('pointerup', () => { this.dragging = false; });
    dom.addEventListener('mousemove', (ev) => {
      const e = ev as MouseEvent;
      if (!this.lookEnabled || (!this.locked && !this.dragging)) return;
      // Chrome reports a huge first delta right after locking; drop it
      if (Math.abs(e.movementX) > 300 || Math.abs(e.movementY) > 300) return;
      this.dx += e.movementX; this.dy += e.movementY;
    });
    doc.addEventListener('pointerlockchange', () => {
      this.locked = doc.pointerLockElement === (dom as unknown as Element);
      this.dragging = false;
      if (!this.locked) this.clear(); // don't keep walking after Esc
      this.onLockChange?.(this.locked);
    });
  }

  /** Release every held key and pending look. */
  clear() { this.keys.clear(); this.pressed.clear(); this.dx = this.dy = 0; }
  exitLock() { if (this.doc.pointerLockElement) this.doc.exitPointerLock(); }
  down(...codes: string[]) { return codes.some((c) => this.keys.has(c)); }
  take(code: string) { const p = this.pressed.has(code); this.pressed.delete(code); return p; }
  look(): [number, number] { const d: [number, number] = [this.dx, this.dy]; this.dx = this.dy = 0; return d; }
}
