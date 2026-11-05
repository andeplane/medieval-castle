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
  ok(Object.keys(s).length === 7, `doors present: ${Object.keys(s).join(', ')}`);
  ok(Object.entries(s).every(([k, v]) => (k === 't-gate' ? v === 1 : v === 0)), 'all leaves start closed, the gate portcullis up');

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

  // the gate: no leaves, only the portcullis
  await ev(page, () => window.__game.doors.setOpen('t-gate', false));
  s = await tick(page, 3);
  ok(s['t-gate'] === 0, 'test gate portcullis lowered');
  await ev(page, () => window.__game.setCamera('door-gate'));
  await ev(page, () => window.__game.step(1));
  await page.screenshot({ path: `${OUT}/test-gate-lowered.png`, timeout: 300_000 });
  await page.close();
}

// ---------------------------------------------------------------- the castle gate, walked as the player
if (process.env.MAIN !== '0') {
  const t0 = Date.now();
  const page = await open('');
  console.log('castle ready in', ((Date.now() - t0) / 1000).toFixed(1), 's');
  const shot = async (name) => { await ev(page, () => window.__game.step(1)); await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 600_000 }); console.log('  shot', name); };
  const game = () => ev(page, () => window.__game.state());
  // signed distance of the camera through the gate wall (outside < 0), and where the groove is
  const through = () => ev(page, () => { const d = window.__game.interior.plan.doors.find((x) => x.id === 'gate-main'); const c = window.__game.state().camera; return (c.x - d.centre[0]) * d.normal[0] + (c.z - d.centre[2]) * d.normal[1]; });
  const groove = 2.6 / 2 - 0.5; // portcullis.ts GROOVE_IN: 0.5 m from the inner face of the 2.6 m gate wall
  let s = await state(page);
  ok(s['gate-main'] === 1 && Object.keys(s).length === 1, `castle gate: one portcullis, no leaves, starts raised (${JSON.stringify(s)})`);
  await ev(page, () => window.__game.setCamera('door-gate'));
  await shot('castle-gate-raised');
  // lowered: walk up to it with W and get stopped by the grille
  await ev(page, () => window.__game.doors.setOpen('gate-main', false, true));
  await shot('castle-gate-lowered');
  // walk straight at it along the gate axis from 7 m out (the walker slides along whatever stops it)
  await ev(page, () => { const d = window.__game.interior.plan.doors.find((x) => x.id === 'gate-main'); const n = d.normal, c = d.centre; window.__game.lookFrom([c[0] - n[0] * 7, 0, c[2] - n[1] * 7], [c[0] + n[0] * 4, c[1] + 1.9, c[2] + n[1] * 4], 'walk'); });
  await ev(page, () => window.__game.walk(4));
  let t = await through();
  ok(t < groove - 0.25 && t > groove - 0.7, `walked up to the lowered grille and stopped (${t.toFixed(2)} m, groove at ${groove})`);
  await tick(page, 0.05);
  let g = await game();
  ok(g.target?.id === 'gate-main' && g.target.label === 'Raise portcullis', `crosshair on the grille: ${JSON.stringify(g.target)}`);
  ok(await ev(page, () => window.__game.use()), 'E (use) on the grille');
  s = await tick(page, 2);
  ok(s['gate-main'] > 0.05 && s['gate-main'] < 0.8, `rising slowly after 2 s (${s['gate-main']})`);
  ok(await ev(page, () => window.__game.walk(1)).then(async () => (await through()) < groove), 'still blocked while it is low');
  s = await tick(page, 10);
  ok(s['gate-main'] === 1, 'fully raised');
  g = await game();
  ok(g.sounds.some((x) => x.name === 'clank'), 'ratchet clanks were heard');
  await ev(page, () => window.__game.walk(3));
  t = await through();
  ok(t > groove + 0.3, `walked under it into the gate (${t.toFixed(2)} m)`);
  await shot('castle-gate-walked-in');
  // from the inside: turn round, look up at it and lower it
  await ev(page, () => { const d = window.__game.interior.plan.doors.find((x) => x.id === 'gate-main'); const n = d.normal, c = d.centre, k = 2.0; window.__game.lookFrom([c[0] + n[0] * k, 0, c[2] + n[1] * k], [c[0] - n[0] * 1, c[1] + 5.0, c[2] - n[1] * 1], 'walk'); }); // looking up at the raised grid
  await tick(page, 0.05);
  g = await game();
  ok(g.target?.id === 'gate-main' && g.target.label === 'Lower portcullis', `from inside, crosshair on the grille: ${JSON.stringify(g.target)}`);
  await ev(page, () => window.__game.use());
  s = await tick(page, 3);
  ok(s['gate-main'] === 0, 'dropped and seated from the inside');
  g = await game();
  ok(g.sounds.some((x) => x.name === 'thud'), 'thud when the spikes seat');
  await shot('castle-gate-inside-lowered');
  // the windlass in the room above
  const winch = await ev(page, () => {
    const P = window.__game.interior.plan, d = P.doors.find((x) => x.id === 'gate-main'), n = d.normal, a = d.along, c = d.centre;
    const r = P.rooms.filter((x) => x.zone === 'gate' && x.y0 > c[1] + 8).sort((x, y) => x.y0 - y.y0)[0];
    const k = 2.6 / 2 - 0.5, gx = c[0] + n[0] * k, gz = c[2] + n[1] * k;
    return { room: r.id, y: r.y0, pos: [gx + n[0] * 1.9 + a[0] * 0.9, r.y0 + 1.6, gz + n[1] * 1.9 + a[1] * 0.9], look: [gx + n[0] * 0.25, r.y0 + 0.9, gz + n[1] * 0.25], wide: [gx + n[0] * 3.3 + a[0] * 2.2, r.y0 + 2.4, gz + n[1] * 3.3 + a[1] * 2.2] };
  });
  await ev(page, (w) => window.__game.lookFrom(w.pos, w.look, 'fly'), winch);
  await tick(page, 0.05);
  g = await game();
  ok(g.target?.id === 'gate-main:winch' && g.target.label === 'Raise portcullis', `winch in ${winch.room}: crosshair on it: ${JSON.stringify(g.target)}`);
  await shot('castle-winch-lowered');
  await ev(page, () => window.__game.use());
  s = await tick(page, 12);
  ok(s['gate-main'] === 1, 'raised from the winch');
  await shot('castle-winch-raised');
  // the whole windlass from the back of the room
  await ev(page, (w) => window.__game.lookFrom(w.wide, w.look, 'fly'), winch);
  await shot('castle-winch-room');
  await ev(page, () => window.__game.setCamera('gatepass'));
  await shot('castle-passage-raised');
  console.log(JSON.stringify({ doors: (await game()).doors, doorTriangles: (await game()).doorTriangles, drawCalls: (await game()).drawCalls }));
  await page.close();
}
await browser.close();
console.log(`doortest: ${checks} checks passed`);
