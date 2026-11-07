// Capture the loading tunnel at fixed progress values to shots/loading-<p>.png (art review).
//   npm run dev &   then   node scripts/loading-shots.mjs [0 0.3 0.6 1]   (env URL, W, H, OUT)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { mkdirSync } from 'node:fs';

const URL = process.env.URL ?? 'http://localhost:5173/';
const W = Number(process.env.W ?? 1600), H = Number(process.env.H ?? 900);
const OUT = process.env.OUT ?? 'shots';
mkdirSync(OUT, { recursive: true });
const list = process.argv.slice(2).length ? process.argv.slice(2) : ['0', '0.2', '0.45', '0.7', '0.9', '1'];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 400)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
for (const p of list) {
  await page.goto(`${URL}?loading=${p}`);
  await page.waitForTimeout(Number(process.env.WAIT ?? 2500));
  await page.screenshot({ path: `${OUT}/loading-${p}.png` });
  console.log('shot', p);
}
await browser.close();
