// Where the draw calls go at a few poses: per pass (shadow cascades, AO pre-pass, scene pass, post) and
// per top-level group / mesh name, counted by wrapping the backend's draw() for one rendered frame.
//   npm run dev &   then   node scripts/drawcalls.mjs   (env URL, W, H, QUERY, POSES=name,... , DETAIL=1)
// Poses: bookmark names, or eye:x,y,z>x,y,z for __game.lookFrom(eye, target, 'fly').
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const URL = process.env.URL ?? 'http://localhost:5173/';
const W = Number(process.env.W ?? 1280), H = Number(process.env.H ?? 720);
const QUERY = process.env.QUERY ?? '';
// poses separated by ';' (or ',' between bookmark names)
const POSES = (process.env.POSES ?? 'hero,gate,courtyard,hall,chamber,towerroom;eye:11.6,4.3,-1.2>14.2,4.0,-3.3').split(';').flatMap((s) => s.startsWith('eye:') ? [s] : s.split(','));

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
// LIVE=1: the game's own loop (no ?shot); one whole animation frame is counted, from one info.reset() to the next
const LIVE = process.env.LIVE === '1';
await page.goto(`${URL}?webgl${LIVE ? '' : '&shot'}${QUERY ? '&' + QUERY : ''}`);
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 3_600_000, polling: 1000 });
await page.evaluate(() => {
  const { renderer } = window.__game.render;
  const be = renderer.backend, draw = be.draw.bind(be);
  window.__calls = null;
  // live: arm() records the next whole frame (the loop resets renderer.info at the start of each)
  const reset = renderer.info.reset.bind(renderer.info);
  renderer.info.reset = () => { if (window.__arm === 1) { window.__calls = []; window.__arm = 2; } else if (window.__arm === 2) { window.__done = window.__calls; window.__calls = null; window.__arm = 0; } return reset(); };
  be.draw = (ro, info) => {
    if (window.__calls) {
      const rt = renderer.getRenderTarget(), cam = window.__game.render.camera;
      // the AO pre-pass draws at half size, the scene pass at full size, both with the game camera;
      // the water's reflection with its own virtual camera; shadow maps with an orthographic one
      const pass = ro.camera.isOrthographicCamera ? (rt && rt.width === rt.height && rt.width >= 1024 ? `shadow ${rt.width}` : 'post')
        : ro.camera !== cam ? 'reflection' : rt && rt.width < renderer.domElement.width ? 'AO pre-pass' : 'scene';
      let o = ro.object, top = o.name || o.type;
      while (o.parent && o.parent.parent) { o = o.parent; }
      top = o.name || o.type;
      const g = top.startsWith('interior:') ? 'interior' : top;
      const t0 = renderer.info.render.triangles;
      const res = draw(ro, info);
      window.__calls.push([pass, g, ro.object.name || ro.object.type, ro.object.castShadow, top, renderer.info.render.triangles - t0]);
      return res;
    }
    return draw(ro, info);
  };
});
for (const p of POSES) {
  if (p.startsWith('eye:')) {
    const [e, t] = p.slice(4).split('>').map((s) => s.split(',').map(Number));
    await page.evaluate(([e, t]) => window.__game.lookFrom(e, t, 'fly'), [e, t]);
  } else await page.evaluate((name) => window.__game.setCamera(name), p);
  let r;
  if (LIVE) {
    await page.waitForTimeout(Number(process.env.SETTLE ?? 20000)); // a few live frames at this pose (furniture streams in)
    await page.evaluate(() => { window.__done = null; window.__arm = 1; });
    await page.waitForFunction(() => !!window.__done, null, { timeout: 600_000, polling: 200 });
    r = await page.evaluate(() => ({ c: window.__done, st: { ...window.__game.state(), drawCalls: window.__done.length } }));
  } else {
    await page.evaluate(() => window.__game.step(1));
    // a new animation frame first: the passes re-render once per frame (three's node frame), so a second
    // render in the same frame draws only the output quad
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.evaluate(() => { window.__calls = []; });
    await page.evaluate(() => window.__game.step(1));
    r = await page.evaluate(() => { const c = window.__calls; window.__calls = null; return { c, st: window.__game.state() }; });
  }
  const by = (f) => { const m = {}; for (const x of r.c) { const k = f(x); m[k] = (m[k] ?? 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  console.log(`\n== ${p}: drawCalls ${r.st.drawCalls} (hooked ${r.c.length}), triangles ${(r.st.frameTriangles / 1e6).toFixed(2)} M, groups shown ${r.st.light?.groupsShown}/${r.st.light?.groups}, room ${r.st.light?.room}, camera ${r.st.camera.mode} (${r.st.camera.x}, ${r.st.camera.y}, ${r.st.camera.z})`);
  console.log('  by pass:', by((x) => x[0]).map(([k, v]) => `${k} ${v}`).join(', '));
  console.log('  by pass+group:', by((x) => `${x[0]}|${x[1]}`).slice(0, 25).map(([k, v]) => `${k} ${v}`).join(', '));
  const tby = (f) => { const m = {}; for (const x of r.c) { const k = f(x); m[k] = (m[k] ?? 0) + (x[5] ?? 0); } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  console.log('  tris by pass:', tby((x) => x[0]).map(([k, v]) => `${k} ${(v / 1e3).toFixed(0)}k`).join(', '));
  console.log('  tris by pass+group:', tby((x) => `${x[0]}|${x[1]}`).slice(0, 40).map(([k, v]) => `${k} ${(v / 1e3).toFixed(0)}k`).join(', '));
  console.log('  tris by group (all passes):', tby((x) => x[1]).slice(0, 30).map(([k, v]) => `${k} ${(v / 1e3).toFixed(0)}k`).join(', '));
  console.log('  tris by mesh (all passes):', tby((x) => `${x[1]}/${x[2]}`).slice(0, 40).map(([k, v]) => `${k} ${(v / 1e3).toFixed(0)}k`).join(', '));
  if (process.env.DETAIL) console.log('  interior groups (scene+shadow):', by((x) => `${x[0]}|${x[4]}`).filter(([k]) => k.includes('interior:')).slice(0, 40).map(([k, v]) => `${k} ${v}`).join(', '));
}
await browser.close();
