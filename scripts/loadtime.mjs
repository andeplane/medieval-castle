// Time a cold load to __game.ready in headless Chrome (WebGL2 / SwiftShader, a proxy for the real
// thing: shader linking is synchronous and far slower than on a GPU), with the long tasks per step.
//   npm run dev &   then   node scripts/loadtime.mjs   (env URL, W, H, QUERY, RUNS)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const URL = process.env.URL ?? 'http://localhost:5173/';
const W = Number(process.env.W ?? 1280), H = Number(process.env.H ?? 720);
const QUERY = process.env.QUERY ?? '';
const RUNS = Number(process.env.RUNS ?? 1);

for (let run = 0; run < RUNS; run++) {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[error]', m.text().slice(0, 300)); });
  await page.addInitScript(() => {
    const w = window;
    w.__long = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true });
  });
  await page.goto(`${URL}?webgl${QUERY ? '&' + QUERY : ''}`);
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 3_600_000, polling: 200 });
  const r = await page.evaluate(() => {
    const ready = performance.now();
    const marks = performance.getEntriesByType('mark').map((m) => [m.name, m.startTime]);
    return { ready, marks, long: window.__long, state: window.__game.state() };
  });
  const stepOf = (t) => { let s = 'boot'; for (const [n, at] of r.marks) if (at <= t) s = n; return s; };
  const byStep = {};
  for (const [t, d] of r.long) { const s = stepOf(t); (byStep[s] ??= []).push(Math.round(d)); }
  console.log(`run ${run + 1}: ready ${(r.ready / 1000).toFixed(1)} s  draw calls ${r.state.drawCalls}  triangles ${r.state.frameTriangles}`);
  for (const [n, at] of r.marks) console.log(`  ${(at / 1000).toFixed(1).padStart(7)} s  ${n}`);
  const all = r.long.map(([, d]) => d).sort((a, b) => b - a);
  console.log(`  long tasks: ${all.length}, total ${(all.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} s, longest ${all.slice(0, 5).map((d) => Math.round(d)).join(', ')} ms`);
  for (const [s, ds] of Object.entries(byStep)) console.log(`    ${s}: ${ds.length} tasks, ${(ds.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} s, longest ${Math.max(...ds)} ms`);
  await browser.close();
}
