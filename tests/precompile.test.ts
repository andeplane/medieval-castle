// Boot shader compilation in pieces (render/precompile.ts): every pass compiles, then the warm-up
// renders run one per task, with the page breathing between any two pieces.
import { describe, expect, it } from 'vitest';
import { precompile, renderOnce } from '../src/render/precompile';

describe('precompile', () => {
  it('compiles each pass, then warms up one render per task, breathing between all pieces', async () => {
    const log: string[] = [];
    let pending = 0;
    const pass = (n: string) => async () => { pending++; await Promise.resolve(); log.push(`compile ${n}`); pending--; };
    await precompile({
      passes: [pass('pre'), pass('scene')],
      warm: [() => log.push(`warm 1 (pending ${pending})`), () => log.push('warm 2')],
      breathe: async () => { log.push('breathe'); },
    });
    expect(log).toEqual(['compile pre', 'breathe', 'compile scene', 'breathe', 'warm 1 (pending 0)', 'breathe', 'warm 2']);
  });
  it('does nothing without pieces', async () => {
    let breaths = 0;
    await precompile({ passes: [], warm: [], breathe: async () => { breaths++; } });
    expect(breaths).toBe(0);
  });
  it('quiets nested renders only while the passes compile, and undoes it even if a pass fails', async () => {
    const log: string[] = [];
    const steps = (fail: boolean) => ({
      passes: [async () => { log.push('pass'); if (fail) throw new Error('x'); }],
      warm: [() => log.push('warm')],
      breathe: async () => {},
      quiet: () => { log.push('quiet'); return () => log.push('loud'); },
    });
    await precompile(steps(false));
    expect(log).toEqual(['quiet', 'pass', 'loud', 'warm']);
    log.length = 0;
    await expect(precompile(steps(true))).rejects.toThrow('x');
    expect(log).toEqual(['quiet', 'pass', 'loud']);
  });
});

describe('renderOnce', () => {
  class Fake {
    target: object | null = null; contextNode: object | null = null; drawn: string[] = [];
    render(scene: { n: string }, camera: { n: string }) { this.drawn.push(`${scene.n}/${camera.n}`); return 'ok'; }
    getRenderTarget() { return this.target; }
  }
  it('renders each scene, camera, target and context once, then restores the renderer', () => {
    const r = new Fake(), stats = { rendered: 0, skipped: 0 };
    const s = { n: 's' }, cam = { n: 'cam' }, refl = { n: 'refl' }, rt = {}, ctxA = {}, ctxB = {};
    const undo = renderOnce(r as never, stats);
    expect(r.render(s, cam)).toBe('ok');
    expect(r.render(s, cam)).toBeUndefined(); // the same again: skipped
    r.render(s, refl); // another camera
    r.target = rt; r.render(s, cam); // another target
    r.contextNode = ctxA; r.render(s, refl); r.render(s, refl);
    r.contextNode = ctxB; r.render(s, refl); // the reflection under another pass's context
    expect(r.drawn).toEqual(['s/cam', 's/refl', 's/cam', 's/refl', 's/refl']);
    expect(stats).toEqual({ rendered: 5, skipped: 2 });
    undo();
    expect(Object.prototype.hasOwnProperty.call(r, 'render')).toBe(false); // the prototype's render again
    r.render(s, cam); r.render(s, cam);
    expect(r.drawn.length).toBe(7);
  });
  it('puts back a render the renderer had of its own', () => {
    const own = () => 'own';
    const r = { render: own, getRenderTarget: () => null };
    const undo = renderOnce(r);
    expect(r.render).not.toBe(own);
    undo();
    expect(r.render).toBe(own);
  });
});
