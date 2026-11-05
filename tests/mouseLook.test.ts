import { describe, expect, it, vi } from 'vitest';
import { applyMouseDelta, Look, LookDocument, LookElement, MAX_DELTA, MouseLook, PITCH_LIMIT } from '../src/camera/mouseLook';

describe('applyMouseDelta', () => {
  it('turns left/right and up/down', () => {
    expect(applyMouseDelta({ yaw: 0, pitch: 0 }, 100, 50, 0.01)).toEqual({ yaw: -1, pitch: -0.5 });
  });
  it('clamps pitch', () => {
    expect(applyMouseDelta({ yaw: 0, pitch: 1.4 }, 0, -200, 0.01).pitch).toBe(PITCH_LIMIT);
    expect(applyMouseDelta({ yaw: 0, pitch: -1.4 }, 0, 200, 0.01).pitch).toBe(-PITCH_LIMIT);
  });
  it('drops spikes', () => {
    const l = { yaw: 0.3, pitch: 0.1 };
    expect(applyMouseDelta(l, MAX_DELTA + 1, 0, 0.01)).toBe(l);
    expect(applyMouseDelta(l, 0, -MAX_DELTA - 1, 0.01)).toBe(l);
  });
});

/** Typed fakes for the canvas and document. */
function setup(opts: { enabled?: boolean; lockable?: boolean; lockRejects?: boolean } = {}) {
  const handlers: Record<string, (e: never) => void> = {};
  let enabled = opts.enabled ?? true;
  const doc = {
    pointerLockElement: null as unknown,
    addEventListener: (t: string, l: (e: never) => void) => { handlers['doc:' + t] = l; },
    exitPointerLock: vi.fn(() => { doc.pointerLockElement = null; handlers['doc:pointerlockchange']({} as never); }),
  } satisfies LookDocument;
  const el: LookElement = {
    addEventListener: (t: string, l: (e: never) => void) => { handlers[t] = l; },
    setPointerCapture: vi.fn(),
  };
  if (opts.lockable !== false) {
    el.requestPointerLock = vi.fn(() => {
      if (opts.lockRejects) return Promise.reject(new Error('no gesture'));
      doc.pointerLockElement = el; handlers['doc:pointerlockchange']({} as never); return Promise.resolve();
    });
  }
  let look: Look = { yaw: 0, pitch: 0 };
  const onLockChange = vi.fn();
  const ml = new MouseLook({ el, doc, enabled: () => enabled, get: () => look, set: (l) => { look = l; }, onLockChange, sensitivity: 0.01 });
  const fire = (t: string, e: object = {}) => handlers[t](e as never);
  return { ml, el, doc, fire, onLockChange, look: () => look, setEnabled: (v: boolean) => { enabled = v; } };
}

describe('MouseLook', () => {
  it('a click grabs the pointer and the mouse turns the head', () => {
    const t = setup();
    t.fire('pointerdown', { pointerId: 1 });
    expect(t.el.requestPointerLock).toHaveBeenCalledOnce();
    expect(t.ml.locked).toBe(true);
    expect(t.onLockChange).toHaveBeenCalledWith(true);
    expect(t.el.setPointerCapture).not.toHaveBeenCalled(); // throws while locked
    t.fire('mousemove', { movementX: 10, movementY: -5 });
    expect(t.look()).toEqual({ yaw: -0.1, pitch: 0.05 });
  });

  it('does not re-request the lock while locked', () => {
    const t = setup();
    t.fire('pointerdown', { pointerId: 1 });
    t.fire('pointerdown', { pointerId: 1 });
    expect(t.el.requestPointerLock).toHaveBeenCalledOnce();
  });

  it('ignores the mouse when not locked and not dragging', () => {
    const t = setup();
    t.fire('mousemove', { movementX: 10, movementY: 10 });
    expect(t.look()).toEqual({ yaw: 0, pitch: 0 });
  });

  it('does nothing while disabled (orbit mode)', () => {
    const t = setup({ enabled: false });
    t.fire('pointerdown', { pointerId: 1 });
    expect(t.el.requestPointerLock).not.toHaveBeenCalled();
    t.setEnabled(false);
    t.fire('mousemove', { movementX: 10, movementY: 10 });
    expect(t.look()).toEqual({ yaw: 0, pitch: 0 });
  });

  it('falls back to drag-look where pointer lock is unavailable', () => {
    const t = setup({ lockable: false });
    t.fire('pointerdown', { pointerId: 7 });
    expect(t.el.setPointerCapture).toHaveBeenCalledWith(7);
    t.fire('mousemove', { movementX: 10, movementY: 0 });
    expect(t.look().yaw).toBeCloseTo(-0.1);
    t.fire('pointerup');
    t.fire('mousemove', { movementX: 10, movementY: 0 });
    expect(t.look().yaw).toBeCloseTo(-0.1);
  });

  it('swallows a rejected lock request and still drag-looks', async () => {
    const t = setup({ lockRejects: true });
    t.fire('pointerdown', { pointerId: 1 });
    await Promise.resolve();
    expect(t.ml.locked).toBe(false);
    t.fire('mousemove', { movementX: 0, movementY: 10 });
    expect(t.look().pitch).toBeCloseTo(-0.1);
  });

  it('tolerates setPointerCapture throwing', () => {
    const t = setup({ lockable: false });
    (t.el.setPointerCapture as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('InvalidStateError'); });
    expect(() => t.fire('pointerdown', { pointerId: 1 })).not.toThrow();
  });

  it('release() exits the lock and reports it; no-op when unlocked', () => {
    const t = setup();
    t.ml.release();
    expect(t.doc.exitPointerLock).not.toHaveBeenCalled();
    t.fire('pointerdown', { pointerId: 1 });
    t.ml.release();
    expect(t.doc.exitPointerLock).toHaveBeenCalledOnce();
    expect(t.ml.locked).toBe(false);
    expect(t.onLockChange).toHaveBeenLastCalledWith(false);
  });

  it('works without an onLockChange callback and uses a default sensitivity', () => {
    const doc: LookDocument = { pointerLockElement: null, addEventListener: () => {}, exitPointerLock: () => {} };
    const el: LookElement = { addEventListener: () => {}, setPointerCapture: () => {} };
    const ml = new MouseLook({ el, doc, enabled: () => true, get: () => ({ yaw: 0, pitch: 0 }), set: () => {} });
    expect(ml.sensitivity).toBeGreaterThan(0);
  });
});
