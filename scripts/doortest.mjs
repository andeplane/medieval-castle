// Scripted door check (game-debug-tools): opens and closes doors through window.__game in the
// ?test=doors scene and on the main castle gate, asserts the state changes, and saves a few frames.
//   npx vite --port 5183 --strictPort &   then   URL=http://localhost:5183/ node scripts/doortest.mjs
// Env: URL, OUT (default shots/doortest), W, H, MAIN=0 to skip the castle gate (slow to build).
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // pre-installed globally; or npm i -D playwright
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const URL = process.env.URL ?? 'http://localhost:5173/';
const OUT = process.env.OUT ?? 'shots/doortest';
const W = Number(process.env.W ?? 960), H = Number(process.env.H ?? 540);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const open = async (query) => {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[error]', m.text().slice(0, 300)); });
  await page.goto(`${URL}?webgl&shot&${query}`);
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 600_000, polling: 500 });
  return page;
};
const ev = (page, fn, arg) => page.evaluate(fn, arg);
const state = (page) => ev(page, () => window.__game.doors.state());
const tick = (page, s) => ev(page, (sec) => window.__game.doors.tick(sec), s);
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; console.log('  ✓', msg); };

// ---------------------------------------------------------------- test scene
{
  const t0 = Date.now();
  const page = await open('test=doors');
  console.log('test scene ready in', ((Date.now() - t0) / 1000).toFixed(1), 's');
  let s = await state(page);
  ok(Object.keys(s).length >= 8, `doors present: ${Object.keys(s).join(', ')}`);
  ok(Object.entries(s).every(([k, v]) => (k.includes('portcullis') ? v === 1 : v === 0)), 'all leaves start closed, portcullis up');

  // setOpen with animation
  await ev(page, () => window.__game.doors.setOpen('t-round', true));
  await tick(page, 0.3);
  const mid = (await state(page))['t-round'];
  ok(mid > 0.2 && mid < 1, `t-round mid-swing after 0.3 s (${mid})`);
  s = await tick(page, 4);
  ok(s['t-round'] === 1, 't-round fully open after 4 s');
  await ev(page, () => window.__game.doors.setOpen('t-round', false, true));
  ok((await state(page))['t-round'] === 0, 'instant close');

  // look at the door and press "E" (via __game.use)
  await ev(page, () => window.__game.setCamera('door-use'));
  await ev(page, () => window.__game.step(1));
  const target = (await ev(page, () => window.__game.state())).target;
  ok(target?.id === 't-round' && target.label === 'Open door', `crosshair on t-round: ${JSON.stringify(target)}`);
  ok(await ev(page, () => window.__game.use()), '__game.use() used something');
  s = await tick(page, 4);
  ok(s['t-round'] === 1, 'use() opened the door');
  await ev(page, () => window.__game.step(1));
  await page.screenshot({ path: `${OUT}/test-use-open.png`, timeout: 300_000 });
  // the open leaf swings out of the way, so aim at it again from the same spot is no longer possible: close by id
  await ev(page, () => window.__game.doors.setOpen('t-round', false));
  s = await tick(page, 3);
  ok(s['t-round'] === 0, 'closed again');
  ok((await ev(page, () => window.__game.state())).sounds.some((x) => x.name === 'thud'), 'a thud was logged when it shut');

  // the gate, its wicket and the portcullis
  await ev(page, () => window.__game.doors.setOpen('t-portcullis', false));
  s = await tick(page, 5);
  ok(s['t-portcullis'] === 0, 'portcullis lowered');
  await ev(page, () => { window.__game.doors.setOpen('t-gate', true); window.__game.doors.setOpen('t-gate:wicket', true); });
  s = await tick(page, 8);
  ok(s['t-gate'] === 1 && s['t-gate:wicket'] === 1, 'gate and wicket open');
  await ev(page, () => window.__game.setCamera('door-gate'));
  await ev(page, () => window.__game.step(1));
  await page.screenshot({ path: `${OUT}/test-gate-open.png`, timeout: 300_000 });
  await page.close();
}

// ---------------------------------------------------------------- the castle gate
if (process.env.MAIN !== '0') {
  const t0 = Date.now();
  const page = await open('');
  console.log('castle ready in', ((Date.now() - t0) / 1000).toFixed(1), 's');
  let s = await state(page);
  ok(s['main-gate'] === 0 && s['main-portcullis'] === 1, 'castle gate closed, portcullis raised');
  await ev(page, () => window.__game.doors.setOpen('main-gate', true));
  s = await tick(page, 8);
  ok(s['main-gate'] === 1, 'castle gate opens');
  await ev(page, () => window.__game.setCamera('gate'));
  await ev(page, () => window.__game.step(1));
  await page.screenshot({ path: `${OUT}/castle-gate-open.png`, timeout: 300_000 });
  await ev(page, () => window.__game.doors.setOpen('main-portcullis', false));
  s = await tick(page, 6);
  ok(s['main-portcullis'] === 0, 'castle portcullis drops');
  await ev(page, () => window.__game.step(1));
  await page.screenshot({ path: `${OUT}/castle-gate-portcullis.png`, timeout: 300_000 });
  console.log(JSON.stringify(await ev(page, () => window.__game.state())));
  await page.close();
}
await browser.close();
console.log(`doortest: ${checks} checks passed`);
