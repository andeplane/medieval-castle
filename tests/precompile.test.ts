// Boot shader compilation in pieces (render/precompile.ts): every pass compiles, then the warm-up
// renders run one per task, with the page breathing between any two pieces.
import { describe, expect, it } from 'vitest';
import { precompile, renderOnce, asyncPipelines } from '../src/render/precompile';

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

describe('precompile with deferred pipelines', () => {
  it('waits for each piece\'s pipelines before the next piece, and undoes the deferral at the end', async () => {
    const log: string[] = [];
    const defer = () => ({
      count: 0,
      settle: async () => { log.push('settle'); },
      undo: () => log.push('undo'),
    });
    await precompile({
      passes: [async () => { log.push('pass'); }],
      warm: [() => log.push('warm 1'), () => log.push('warm 2')],
      breathe: async () => {},
      quiet: () => { log.push('quiet'); return () => log.push('loud'); },
      defer,
    });
    expect(log).toEqual(['quiet', 'pass', 'settle', 'loud', 'warm 1', 'settle', 'warm 2', 'settle', 'undo']);
  });
  it('undoes the deferral when a piece fails', async () => {
    const log: string[] = [];
    await expect(precompile({
      passes: [], warm: [() => { throw new Error('w'); }], breathe: async () => {},
      defer: () => ({ count: 0, settle: async () => {}, undo: () => log.push('undo') }),
    })).rejects.toThrow('w');
    expect(log).toEqual(['undo']);
  });
});

describe('asyncPipelines', () => {
  // three's backend: with an array it compiles asynchronously and pushes a promise; with null it is synchronous
  class Backend {
    made: string[] = []; done: (() => void)[] = [];
    createRenderPipeline(o: string, promises: Promise<unknown>[] | null) {
      if (promises === null) { this.made.push(`sync ${o}`); return; }
      this.made.push(`async ${o}`);
      promises.push(new Promise<void>((r) => this.done.push(() => { this.made.push(`ready ${o}`); r(); })));
    }
  }
  it('makes a render\'s pipelines asynchronous, leaves compileAsync\'s alone, and settles all of them', async () => {
    const b = new Backend();
    const d = asyncPipelines(b);
    b.createRenderPipeline('a', null); // a render
    const compile: Promise<unknown>[] = [];
    b.createRenderPipeline('b', compile); // compileAsync: its own array, not waited for by settle
    expect(compile.length).toBe(1);
    expect(d.count).toBe(1);
    let settled = false;
    const s = d.settle().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    b.createRenderPipeline('c', null); // made while waiting: settle waits for it too
    b.done[0](); // a
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    b.done[2](); // c
    await s;
    expect(settled).toBe(true);
    expect(d.count).toBe(2);
    expect(b.made).toEqual(['async a', 'async b', 'async c', 'ready a', 'ready c']);
    d.undo();
    expect(Object.prototype.hasOwnProperty.call(b, 'createRenderPipeline')).toBe(false);
    b.createRenderPipeline('d', null);
    expect(b.made.at(-1)).toBe('sync d');
  });
  it('puts back a createRenderPipeline the backend had of its own', async () => {
    const own = () => 'own';
    const b = { createRenderPipeline: own };
    const d = asyncPipelines(b);
    expect(b.createRenderPipeline).not.toBe(own);
    await d.settle(); // nothing pending
    d.undo();
    expect(b.createRenderPipeline).toBe(own);
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
