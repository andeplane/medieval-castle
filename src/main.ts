// Castle exterior review build. Boot: renderer → textures/materials → castle → world → compile → run.
// URL flags: ?webgl (force WebGL2, used for headless captures), ?view=<bookmark>, ?time=<hours>,
// ?ao=0 (no ambient occlusion), ?shot (hide UI), ?debug (three Inspector), ?seed=N.
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, builtinAOContext, screenUV } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { makeMaterials } from './render/materials';
import { buildCastle } from './castle/castle';
import { buildBridge } from './castle/bridge';
import { buildRevetment } from './castle/revetment';
import { buildTerrain, ISLAND, MOAT_OUTER, heightAt } from './world/terrain';
import { makeSky } from './world/sky';
import { makeWater } from './world/water';
import { buildTrees } from './world/trees';
import { CameraRig, VIEWS, type Mode } from './camera/controls';
import { buildInterior } from './castle/interior';
import { interiorViews } from './camera/interiorViews';
import { installHooks } from './debug/hooks';
import { pointInPoly } from './core/math2d';

const params = new URLSearchParams(location.search);
const loading = document.getElementById('loading')!;
const say = (s: string) => { loading.textContent = s; return new Promise((r) => setTimeout(r, 0)); };
if (params.has('shot')) document.body.classList.add('shot');

async function main() {
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') });
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = params.get('tm') === 'agx' ? THREE.AgXToneMapping : params.get('tm') === 'aces' ? THREE.ACESFilmicToneMapping : THREE.NeutralToneMapping;
  renderer.toneMappingExposure = Number(params.get('exposure') ?? 0.72);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);
  if (params.has('debug')) {
    const { Inspector } = await import('three/addons/inspector/Inspector.js');
    (renderer as unknown as { inspector: unknown }).inspector = new Inspector();
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.25, 30000);

  await say('CUTTING THE STONE…');
  const t0 = performance.now();
  const M = await makeMaterials();
  const tTex = performance.now() - t0;

  await say('RAISING THE WALLS…');
  const { builder, lights } = buildCastle();
  const bridge = buildBridge(builder, ISLAND, MOAT_OUTER, pointInPoly);
  buildRevetment(builder, ISLAND, heightAt, (x, z) => Math.hypot(x - bridge.start[0], z - bridge.start[1]) < 3.2);
  const mats = { old: M.old, new: M.new, trim: M.trim, slate: M.slate, lead: M.lead, wood: M.wood, iron: M.iron, void: M.void, glass: M.glass };
  // interiors: rooms, doorways, embrasures, stairs, cellars and tunnels; carves the exterior bins in place
  const interior = params.get('interior') === '0' ? null : buildInterior(mats, builder, { heightAt });
  const castle = builder.build(mats);
  scene.add(castle);
  if (interior) { for (const g of interior.groups) scene.add(g.object); VIEWS.push(...interiorViews(interior.plan)); }

  await say('SHAPING THE LAND…');
  const sky = makeSky(renderer, scene);
  scene.add(buildTerrain(M.terrain));
  const water = makeWater(sky.sunDir);
  scene.add(water);

  await say('PLANTING TREES…');
  let trees: THREE.Group | null = null;
  try { trees = buildTrees(VIEWS.map((v) => [v.pos[0], v.pos[2]])); scene.add(trees); } catch (e) { console.error('trees failed', e); }

  // post: GTAO from a single-sampled normal pre-pass, then the main pass (threejs-postprocessing)
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  if (params.get('ao') !== '0') {
    const pre = pass(scene, camera, { samples: 0 });
    pre.setMRT(mrt({ output: normalView }));
    const aoPass = ao(pre.getTextureNode('depth'), pre.getTextureNode(), camera);
    aoPass.resolutionScale = 0.5;
    scenePass.contextNode = builtinAOContext(aoPass.getTextureNode().sample(screenUV).r);
  }
  pipeline.outputNode = scenePass;
  void output;

  const rig = new CameraRig(camera, renderer.domElement);
  const setTime = (h: number) => { sky.setTime(h); (water as unknown as { sunDirection: { value: THREE.Vector3 } }).sunDirection.value.copy(sky.sunDir); };
  setTime(Number(params.get('time') ?? 15.5));
  const start = VIEWS.find((v) => v.name === (params.get('view') ?? 'hero')) ?? VIEWS[0];
  rig.go(start);

  // UI
  const ui = document.getElementById('ui')!;
  const modeRow = document.createElement('div'); modeRow.className = 'row';
  const viewRow = document.createElement('div'); viewRow.className = 'row';
  const modeBtns: Record<string, HTMLButtonElement> = {};
  const help = document.getElementById('help')!;
  const helpText: Record<Mode, string> = {
    orbit: 'Drag to orbit · right-drag to pan · scroll to zoom',
    fly: 'WASD move · E/Q up/down · Shift fast · drag (or double-click to lock) to look',
    walk: 'WASD walk · Shift run · drag (or double-click to lock) to look',
  };
  const syncMode = () => { for (const [k, b] of Object.entries(modeBtns)) b.classList.toggle('on', k === rig.mode); help.textContent = helpText[rig.mode]; };
  for (const m of ['orbit', 'fly', 'walk'] as Mode[]) {
    const b = document.createElement('button'); b.textContent = m[0].toUpperCase() + m.slice(1);
    b.onclick = () => { rig.setMode(m); if (m === 'walk') { const p = camera.position; if (p.y > 30) rig.go(VIEWS.find((v) => v.name === 'gate')!); } syncMode(); };
    modeBtns[m] = b; modeRow.appendChild(b);
  }
  const time = document.createElement('label');
  time.innerHTML = 'Time <input type="range" min="6.5" max="19.8" step="0.1">';
  const slider = time.querySelector('input')!; slider.value = String(sky.hours);
  slider.oninput = () => setTime(Number(slider.value));
  modeRow.appendChild(time);
  for (const v of VIEWS) { const b = document.createElement('button'); b.textContent = v.label; b.onclick = () => { rig.go(v); syncMode(); }; viewRow.appendChild(b); }
  ui.append(modeRow, viewRow);
  syncMode();

  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

  await say('LIGHTING…');
  await renderer.compileAsync(scene, camera);

  const info = renderer.info;
  const hooks = installHooks({
    renderer, camera, rig, setTime, getTime: () => sky.hours,
    renderNow: async () => { pipeline.render(); },
    stats: () => ({
      castleTriangles: castle.userData.triangles, trees: trees?.userData, windows: lights.length,
      interior: interior ? { triangles: interior.triangles, groups: interior.groups.length, meshes: interior.groups.reduce((s, g) => s + g.object.children.length, 0), rooms: interior.plan.rooms.length, doors: interior.plan.doors.length, stairs: interior.plan.stairs.length, ...interior.stats } : null,
      drawCalls: info.render.drawCalls, frameTriangles: info.render.triangles, textureMs: Math.round(tTex),
    }),
  });

  (window as unknown as { __game: Record<string, unknown> }).__game.interior = interior ? { plan: interior.plan, groups: interior.groups, collision: interior.collision } : null;

  if (params.has('shot')) {
    // captures render on demand through __game.step(), so a slow software renderer is not flooded
    loading.remove();
    hooks.ready = true;
    return;
  }
  const fpsEl = document.createElement('span');
  fpsEl.style.cssText = 'margin-left:8px;opacity:.8;font-variant-numeric:tabular-nums';
  modeRow.appendChild(fpsEl);
  let last = performance.now(), frames = 0, acc = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now(), raw = (now - last) / 1000, dt = Math.min(0.05, raw); last = now;
    frames++; acc += raw;
    if (acc > 0.5) { fpsEl.textContent = `${Math.round(frames / acc)} fps`; frames = 0; acc = 0; }
    rig.update(dt);
    pipeline.render();
  });
  // two frames, then reveal
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  loading.style.opacity = '0';
  setTimeout(() => loading.remove(), 700);
  hooks.ready = true;
}

main().catch((e) => { console.error(e); loading.textContent = 'Something went wrong: ' + (e?.message ?? e); });
