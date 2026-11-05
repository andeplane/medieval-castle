// Tunnel worker logic: owns the OffscreenCanvas, the model and the frame loop, so the tunnel keeps
// animating while the page's main thread is busy building the castle and compiling shaders.
// Wiring to the real worker global is in tunnel.worker.ts; tests pass a fake scope.
import { LoadingModel } from './model';
import { startLoop, type Clock } from './loop';
import type { GLLike, Palette, TunnelRenderer } from './gl';
import type { ToWorker, WorkerScope } from './protocol';

export interface WorkerDeps {
  clock: Clock;
  getGL(canvas: OffscreenCanvas): GLLike | null;
  makeRenderer(gl: GLLike, pal: Palette, reduced: boolean): TunnelRenderer | null;
}

export function serveTunnel(scope: WorkerScope, d: WorkerDeps) {
  let model: LoadingModel | null = null;
  let renderer: TunnelRenderer | null = null;
  let stop: (() => void) | null = null;
  let canvas: OffscreenCanvas | null = null;
  const size = { w: 2, h: 2 };
  const look: [number, number] = [0, 0];
  let sent = -1;

  scope.onmessage = ({ data: m }: { data: ToWorker }) => {
    switch (m.t) {
      case 'init': {
        if (model) return;
        canvas = m.canvas;
        size.w = m.w; size.h = m.h;
        model = new LoadingModel({ fixed: m.fixed, reduced: m.reduced });
        const gl = d.getGL(canvas);
        renderer = gl ? d.makeRenderer(gl, m.palette, m.reduced) : null;
        if (!renderer) scope.postMessage({ t: 'nogl' });
        const c = canvas;
        stop = startLoop({
          model, renderer, clock: d.clock, look,
          size: () => { if (c.width !== size.w || c.height !== size.h) { c.width = size.w; c.height = size.h; } return size; },
          onFrame: (mm) => { const v = Math.round(mm.shown * 1000) / 1000; if (v !== sent) { sent = v; scope.postMessage({ t: 'shown', v }); } },
        });
        return;
      }
      case 'size': size.w = m.w; size.h = m.h; return;
      case 'progress': model?.setTarget(m.p); return;
      case 'span': model?.setSpan(m.start, m.end, m.ms, d.clock.now()); return;
      case 'look': look[0] = m.x; look[1] = m.y; return;
      case 'stop': stop?.(); renderer?.dispose(); stop = null; renderer = null; return;
    }
  };
}
