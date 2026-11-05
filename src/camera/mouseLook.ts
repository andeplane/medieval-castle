// FPS mouse look (input-systems): a click grabs the pointer, the mouse turns the head while it is
// locked, Esc releases it (the browser does that). Dragging still looks around where pointer lock is
// unavailable (headless captures, some embeds). The DOM is injected through small interfaces so the
// behaviour is tested with typed fakes and can be reused by the physics player later.

/** Yaw/pitch in radians; pitch is clamped so the head cannot flip over. */
export interface Look { yaw: number; pitch: number }

export const PITCH_LIMIT = 1.5;
/** Chrome can report a huge delta on the first move after locking; anything larger is dropped. */
export const MAX_DELTA = 300;

/** Apply one mouse delta to a look direction. Pure. */
export function applyMouseDelta(look: Look, dx: number, dy: number, sensitivity: number): Look {
  if (Math.abs(dx) > MAX_DELTA || Math.abs(dy) > MAX_DELTA) return look;
  const pitch = Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, look.pitch - dy * sensitivity));
  return { yaw: look.yaw - dx * sensitivity, pitch };
}

type Listener<E> = (e: E) => void;
/** The parts of the canvas mouse look needs. */
export interface LookElement {
  addEventListener(type: 'pointerdown', l: Listener<{ pointerId: number }>): void;
  addEventListener(type: 'pointerup', l: Listener<unknown>): void;
  addEventListener(type: 'mousemove', l: Listener<{ movementX: number; movementY: number }>): void;
  requestPointerLock?(): unknown;
  setPointerCapture(id: number): void;
}
/** The parts of `document` mouse look needs. */
export interface LookDocument {
  readonly pointerLockElement: unknown;
  addEventListener(type: 'pointerlockchange', l: Listener<unknown>): void;
  exitPointerLock(): void;
}

export interface MouseLookOptions {
  el: LookElement;
  doc: LookDocument;
  /** Whether mouse look is active at all (false in orbit mode). */
  enabled: () => boolean;
  get: () => Look;
  set: (look: Look) => void;
  onLockChange?: (locked: boolean) => void;
  sensitivity?: number;
}

export class MouseLook {
  locked = false;
  sensitivity: number;
  private dragging = false;

  constructor(private o: MouseLookOptions) {
    this.sensitivity = o.sensitivity ?? 0.0022;
    const { el, doc } = o;
    el.addEventListener('pointerdown', (e) => {
      if (!o.enabled()) return;
      if (doc.pointerLockElement !== el && el.requestPointerLock) {
        const r = el.requestPointerLock() as Promise<void> | undefined;
        r?.catch?.(() => { /* denied (e.g. no user gesture): drag-look still works */ });
      }
      this.dragging = true;
      // setPointerCapture throws while the pointer is locked
      if (doc.pointerLockElement !== el) try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    el.addEventListener('pointerup', () => { this.dragging = false; });
    el.addEventListener('mousemove', (e) => {
      if (!o.enabled() || (!this.locked && !this.dragging)) return;
      o.set(applyMouseDelta(o.get(), e.movementX, e.movementY, this.sensitivity));
    });
    doc.addEventListener('pointerlockchange', () => {
      this.locked = doc.pointerLockElement === el;
      this.dragging = false;
      o.onLockChange?.(this.locked);
    });
  }

  release() { if (this.o.doc.pointerLockElement) this.o.doc.exitPointerLock(); }
}
