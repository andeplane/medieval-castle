// Run the in-game benchmark (src/debug/bench.ts) in a browser and print / save the table:
//   npm run dev &   then   npm run bench          (env URL, W, H, QUERY, OUT, STEPS=a,b, MEASURE ms, WARM ms)
// Headless Chrome here is software WebGL2 (SwiftShader): its fps says nothing about a real GPU, but
// draw calls and triangles are the same. For real numbers open the game with ?bench on the machine
// itself (e.g. https://andeplane.github.io/midieval-castle/?bench) or point URL at it with HEADED=1.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const URL = process.env.URL ?? 'http://localhost:5173/';
const W = Number(process.env.W ?? 1280), H = Number(process.env.H ?? 720);
const QUERY = process.env.QUERY ?? '';
const OUT = process.env.OUT ?? 'shots/bench';
const headed = process.env.HEADED === '1';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch(headed ? { headless: false } : { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${URL}?stats${headed ? '' : '&webgl'}${QUERY ? '&' + QUERY : ''}`);
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 600_000, polling: 1000 });
const opts = { warmMs: Number(process.env.WARM ?? 1000), measureMs: Number(process.env.MEASURE ?? 3000), steps: process.env.STEPS?.split(',') };
const res = await page.evaluate((o) => window.__game.bench(o), opts);
console.log(`${res.render.width}×${res.render.height} @${res.render.pixelRatio} ${res.render.backend}\n${res.table}`);
const file = `${OUT}/bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify({ url: URL, query: QUERY, ...res }, null, 2));
console.log('wrote', file);
await browser.close();
