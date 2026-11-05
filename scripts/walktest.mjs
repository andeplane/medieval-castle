// Scripted walk test in the real page (headless WebGL2), launched like scripts/shots.mjs:
//   npm run dev &   then   node scripts/walktest.mjs        (env URL, W, H, OUT, SHOTS=0 to skip captures)
// Loads ?test=walk (the movement course), drives the player through __game.input(keys, ms), which steps
// physics synchronously without rendering, and asserts: the gate wall stops you, the revetment keeps
// you on the island, the bridge ends at the break, and the course stairs/ramps/beam/descent behave.
// Prints the per-tick physics cost and writes a few walk-mode captures for checking eye height.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const URL = process.env.URL ?? 'http://localhost:5173/';
const W = Number(process.env.W ?? 960), H = Number(process.env.H ?? 540);
const OUT = process.env.OUT ?? 'shots/walk';
const SHOTS = process.env.SHOTS !== '0';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[error]', m.text().slice(0, 300)); else if (m.text().startsWith('physics ready')) console.log('[page]', m.text()); });
const t0 = Date.now();
await page.goto(`${URL}?webgl&shot&test=walk&ao=0`);
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 600_000, polling: 1000 });
console.log('ready in', ((Date.now() - t0) / 1000).toFixed(1), 's');
const st = await page.evaluate(() => window.__game.state());
console.log('physics', JSON.stringify(st.physics));

const pip = (poly, x, z) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i], [xj, zj] = poly[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; };
const P = await page.evaluate(() => window.__game.probes);
const course = await page.evaluate(() => window.__game.course);
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
const tele = async (x, y, z, yaw) => {
  const s = await page.evaluate(([x, y, z, yaw]) => window.__game.player.teleport(x, y, z, yaw, 0), [x, y, z, yaw]);
  // a teleport that misses the ground would fall, respawn at the gate and make later checks meaningless
  if (Math.hypot(s.x - x, s.z - z) > 0.1 || s.y < 0.5) throw new Error(`teleport to ${x}, ${z} landed at ${s.x}, ${s.y}, ${s.z}`);
  return s;
};
const input = (keys, ms) => page.evaluate(([k, ms]) => window.__game.input(k, ms, { traceEvery: 6 }), [keys, ms]);
const face = (a, b) => Math.atan2(-(b[0] - a[0]), -(b[1] - a[1]));
const tickMs = [];
const run = async (keys, ms) => { const r = await input(keys, ms); tickMs.push(r.tickMs); return r; };

// 1. spawn, walk into the gate: the closed gate (and its plinth) stops you
await page.evaluate(() => window.__game.player.spawn());
let r = await run(['KeyW'], 5000);
const g = P.gate, front = [g.base[0] + g.out[0] * g.project, g.base[1] + g.out[1] * g.project];
const into = -((r.x - front[0]) * g.out[0] + (r.z - front[1]) * g.out[1]);
check('gate wall stops you', into < 2.7 && into > -1.5, `into gatehouse ${into.toFixed(2)} m (closed gate at 2.6)`);

// 2. walls elsewhere: run at the east wing
await tele(44, null, 27, face([44, 27], [20, -6]));
r = await run(['KeyW', 'ShiftLeft'], 6000);
{
  const d = [20 - 44, -6 - 27], l = Math.hypot(...d), off = Math.abs(((r.x - 44) * d[1] - (r.z - 27) * d[0]) / l), gone = ((r.x - 44) * d[0] + (r.z - 27) * d[1]) / l;
  check('east wall stops you (sliding along it is fine)', !pip(P.outer, r.x, r.z) && gone > 4, `stopped at ${r.x.toFixed(1)}, ${r.z.toFixed(1)} (${gone.toFixed(1)} m along, ${off.toFixed(1)} m off the line)`);
}

// 3. revetment: run and jump outward toward the moat from several places
let fails = 0, tries = 0;
for (const i of [0, 24, 40, 64, 100, 116]) {
  const e = P.island[i], l = Math.hypot(e[0], e[1]), s = [e[0] - (e[0] / l) * 6, e[1] - (e[1] / l) * 6];
  if (pip(P.outer, s[0], s[1])) continue;
  tries++;
  await tele(s[0], null, s[1], face(s, e));
  r = await run(['KeyW', 'ShiftLeft'], 2500);
  const r2 = await run(['KeyW', 'Space'], 800);
  const minY = Math.min(...r.trace.map((t) => t[1]), ...r2.trace.map((t) => t[1]));
  if (!pip(P.island, r2.x, r2.z) || minY < 1) fails++;
}
check('revetment keeps you on the island', fails === 0 && tries > 2, `${tries - fails}/${tries} edges held`);

// 4. bridge: out to the broken span, not off it
const b = P.bridge, a = [b.start[0] - b.dir[0] * 4, b.start[1] - b.dir[1] * 4];
await tele(a[0], null, a[1], face(a, [a[0] + b.dir[0], a[1] + b.dir[1]]));
r = await run(['KeyW'], 7000);
const along = (r.x - b.start[0]) * b.dir[0] + (r.z - b.start[1]) * b.dir[1];
check('bridge walkable to the break, not beyond', along > b.breakAt - 1.5 && along < b.breakAt + 0.1 && r.y > b.deck - 0.6, `along ${along.toFixed(2)} / break ${b.breakAt.toFixed(2)}, y ${r.y.toFixed(2)}`);

// 5. the course
const lane = (n) => course.lanes.find((l) => l.name === n);
const go = async (n, keys, ms) => { const l = lane(n); await tele(l.x, course.slab, l.z0, 0); return run(keys, ms); };
for (const n of ['stairs-0.15', 'stairs-0.20', 'stairs-0.30']) {
  r = await go(n, ['KeyW'], 3000);
  check(`climbs ${n}`, Math.abs(r.y - lane(n).top) < 0.08, `y ${(r.y - course.slab).toFixed(2)} of ${(lane(n).top - course.slab).toFixed(2)}, grounded ${(r.groundedFrac * 100).toFixed(0)}%`);
}
r = await go('stairs-0.20', ['KeyW', 'ShiftLeft'], 2000);
check('runs up 0.20 stairs', Math.abs(r.y - lane('stairs-0.20').top) < 0.08, `y ${(r.y - course.slab).toFixed(2)}`);
r = await go('stairs-0.35', ['KeyW'], 3000);
check('blocked by 0.35 steps', r.y < course.slab + 0.1, `y ${(r.y - course.slab).toFixed(2)}`);
await go('stairs-0.35', ['KeyW'], 1000);
for (let i = 0; i < 3; i++) { await run(['KeyW', 'Space'], 100); await run(['KeyW'], 700); }
r = await run(['KeyW'], 10);
check('jumps up 0.35 steps', r.y > course.slab + 0.6, `y ${(r.y - course.slab).toFixed(2)}`);
r = await go('ramp-30', ['KeyW'], 2800);
check('climbs the 30° ramp', r.y > lane('ramp-30').top - 0.25, `y ${(r.y - course.slab).toFixed(2)} of ${(lane('ramp-30').top - course.slab).toFixed(2)}`);
r = await go('ramp-55', ['KeyW'], 4000);
check('blocked by the 55° ramp', r.y < course.slab + 0.6, `y ${(r.y - course.slab).toFixed(2)}`);
r = await go('beam', ['KeyW'], 4000);
check('low beam blocks standing', r.z > lane('beam').beamZ[1] - 0.1, `z ${r.z.toFixed(2)} (beam ${lane('beam').beamZ[1].toFixed(2)})`);
await go('beam', ['KeyW', 'KeyC'], 2400);
r = await run([], 300);
check('crouch under the beam, cannot stand up there', r.crouched && r.z < lane('beam').beamZ[1] - 0.3, `crouched ${r.crouched}, z ${r.z.toFixed(2)}`);
r = await run(['KeyW'], 3000);
const r3 = await run([], 300);
check('stands up after the beam', !r3.crouched && r.z < lane('beam').beamZ[0], `z ${r.z.toFixed(2)}`);
r = await go('descent', ['KeyW'], 9000);
const groundAbove = await page.evaluate(([x, z]) => window.__game.physics.raycast([x, 60, z], [0, -1, 0], 80)?.point[1], [r.x, r.z]);
check('stairs down through the ground into a tunnel under it', Math.abs(r.y - lane('descent').floorY) < 0.08 && r.z < lane('descent').endZ + 1.5 && groundAbove > r.y + 1.75,
  `y ${(r.y - course.slab).toFixed(2)}, ground above ${(groundAbove - r.y).toFixed(2)} m over the feet, grounded ${(r.groundedFrac * 100).toFixed(0)}%`);

tickMs.sort((x, y) => x - y);
const mean = tickMs.reduce((s, v) => s + v, 0) / tickMs.length;
console.log(`physics tick (player + world.step, ms): median ${tickMs[tickMs.length >> 1].toFixed(3)} mean ${mean.toFixed(3)} max-run ${tickMs.at(-1).toFixed(3)}`);

if (SHOTS) {
  for (const v of ['spawn', 'gate', 'courtyard', 'ward', 'course']) {
    const t = Date.now();
    if (v === 'spawn') await page.evaluate(() => window.__game.player.spawn());
    else if (v === 'course') { const l = lane('stairs-0.20'); await tele(l.x - 0.4, course.slab, l.z0 + 2.5, -0.35); }
    else await page.evaluate((n) => window.__game.setCamera(n), v);
    await page.evaluate(() => window.__game.step(1));
    const s = await page.evaluate(() => window.__game.state());
    await page.screenshot({ path: `${OUT}/${v}.png`, timeout: 300_000 });
    console.log('shot', v, `eye ${(s.camera.y - s.player.y).toFixed(2)} m over the feet, fov ${s.camera.fov}`, ((Date.now() - t) / 1000).toFixed(1), 's');
  }
}
await browser.close();
const failed = results.filter((x) => !x.ok);
console.log(failed.length ? `${failed.length} FAILED` : `all ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
