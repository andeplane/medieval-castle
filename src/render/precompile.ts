// Shader compilation behind the loading screen without freezing it. Measured (headless, pipeline cache
// counts): compiling the scene for the canvas built 48 pipelines the game never used, and the first
// frame then built the other 94 synchronously in one task (≈ 1 s on an M-series Mac, "Lighting the
// halls" freezing the mouse look). Instead each render pass compiles itself (PassNode.compileAsync:
// its own target, MRT and samples, so the pipelines match the real frame; three yields to the page
// every few ms while it builds them), then what compileAsync cannot reach (sun shadow maps, three
// skips them while precompiling; the water's reflection; the full-screen post passes) is built by a
// few warm-up renders, each in its own task, with a breath in between so no two join into one.
//
// Nested renders while a pass compiles: three runs each compile item's `updateBefore` nodes, and the
// scene pass's items carry the AO context (whose pre-pass renders the whole scene) and the water's
// reflector (which renders it again from below). Measured headless: 44 pre-pass and 44 reflection
// renders of the whole castle, every room shown, during one scene-pass compile (88 full frames, the
// most expensive part of loading after #60). The first of each builds every pipeline it needs (the same
// objects are shown throughout the compile); the rest build nothing new. So while the passes compile,
// each nested render (scene, camera, target) runs once (`renderOnce`).
// Collaborators are injected so the order can be tested without a GPU.
export interface PrecompileSteps {
  /** async compiles, in order (e.g. the AO pre-pass, then the main scene pass) */
  passes: (() => Promise<void>)[];
  /** synchronous warm-up renders, in order, each staging in a little more of the frame */
  warm: (() => void)[];
  /** let the page take input and paint (LoadingScreen.breathe) */
  breathe(): Promise<void>;
  /** while the passes compile: make repeated nested renders no-ops; returns the undo (renderOnce) */
  quiet?: () => () => void;
}

export async function precompile(s: PrecompileSteps) {
  let first = true;
  const gap = async () => { if (!first) await s.breathe(); first = false; };
  const undo = s.quiet?.();
  try {
    for (const p of s.passes) { await gap(); await p(); }
  } finally { undo?.(); }
  for (const w of s.warm) { await gap(); w(); }
}

/** What renderOnce needs of a renderer: render(scene, camera), the target it draws into now and its context node. */
export interface RenderLike { render(scene: object, camera: object): unknown; getRenderTarget(): object | null; contextNode?: object | null }

/**
 * Wrap `r.render` so that each (scene, camera, current target, current context node) renders only the
 * first time; returns the undo, which puts the renderer's own render back. The context node is in the key
 * because the same reflection is rendered under the AO pre-pass's context and under the scene pass's, and
 * each builds its own pipelines. Counts go to `stats`.
 */
export function renderOnce(r: RenderLike, stats = { rendered: 0, skipped: 0 }) {
  const own = Object.prototype.hasOwnProperty.call(r, 'render');
  const orig = r.render;
  const ids = new WeakMap<object, number>();
  let n = 0;
  const id = (o: object | null | undefined) => { if (!o) return 0; let i = ids.get(o); if (i === undefined) ids.set(o, i = ++n); return i; };
  const seen = new Set<string>();
  r.render = function (scene: object, camera: object) {
    const key = `${id(scene)}|${id(camera)}|${id(r.getRenderTarget())}|${id(r.contextNode)}`;
    if (seen.has(key)) { stats.skipped++; return undefined; }
    seen.add(key);
    stats.rendered++;
    return orig.call(r, scene, camera);
  };
  return () => { if (own) r.render = orig; else delete (r as { render?: unknown }).render; };
}
