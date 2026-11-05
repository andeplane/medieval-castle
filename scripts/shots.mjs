// Capture the camera bookmarks to shots/<view>.png (game-art-review). Usage:
//   npm run dev &   then   node scripts/shots.mjs [view ...]   (env URL, W, H, QUERY to override)
// Headless Chrome has no WebGPU here, so captures force the WebGL2 backend (?webgl).
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // pre-installed globally; or npm i -D playwright
import { mkdirSync } from 'node:fs';

const URL = process.env.URL ?? 'http://localhost:5173/';
const W = Number(process.env.W ?? 1600), H = Number(process.env.H ?? 900);
const QUERY = process.env.QUERY ?? '';
const OUT = process.env.OUT ?? 'shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const views = process.argv.slice(2);
const t0 = Date.now();
await page.goto(`${URL}?webgl&shot${QUERY ? '&' + QUERY : ''}`);
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 600_000, polling: 1000 });
console.log('ready in', ((Date.now() - t0) / 1000).toFixed(1), 's');
console.log(JSON.stringify(await page.evaluate(() => window.__game.state())));
const list = views.length ? views : await page.evaluate(() => window.__game.views());
for (const v of list) {
  const t = Date.now();
  await page.evaluate((name) => window.__game.setCamera(name), v);
  await page.evaluate(() => window.__game.step(1));
  await page.screenshot({ path: `${OUT}/${v}.png`, timeout: 300_000 });
  console.log('shot', v, ((Date.now() - t) / 1000).toFixed(1), 's');
}
await browser.close();
