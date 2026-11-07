// Shader compilation behind the loading screen without freezing it. Measured (headless, pipeline cache
// counts): compiling the scene for the canvas built 48 pipelines the game never used, and the first
// frame then built the other 94 synchronously in one task (≈ 1 s on an M-series Mac, "Lighting the
// halls" freezing the mouse look). Instead each render pass compiles itself (PassNode.compileAsync:
// its own target, MRT and samples, so the pipelines match the real frame; three yields to the page
// every few ms while it builds them), then what compileAsync cannot reach (sun shadow maps, three
// skips them while precompiling; the water's reflection; the full-screen post passes) is built by a
// few warm-up renders, each in its own task, with a breath in between so no two join into one.
// Collaborators are injected so the order can be tested without a GPU.
export interface PrecompileSteps {
  /** async compiles, in order (e.g. the AO pre-pass, then the main scene pass) */
  passes: (() => Promise<void>)[];
  /** synchronous warm-up renders, in order, each staging in a little more of the frame */
  warm: (() => void)[];
  /** let the page take input and paint (LoadingScreen.breathe) */
  breathe(): Promise<void>;
}

export async function precompile(s: PrecompileSteps) {
  let first = true;
  const gap = async () => { if (!first) await s.breathe(); first = false; };
  for (const p of s.passes) { await gap(); await p(); }
  for (const w of s.warm) { await gap(); w(); }
}
