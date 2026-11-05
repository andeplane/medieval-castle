// Castle exterior review build. Boot: renderer → textures/materials → castle → world → compile → run.
// URL flags: ?webgl (force WebGL2, used for headless captures), ?view=<bookmark>, ?time=<hours>,
// ?ao=0 (no ambient occlusion), ?shot (hide UI), ?debug (three Inspector), ?seed=N,
// ?play (start walking at the spawn), ?test=walk (movement test course on the east lawn),
// ?test=stairs (stair test scene instead of the castle; &cut for a cutaway drum).
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, builtinAOContext, screenUV, renderOutput, luminance, mix, vec3, vec4, float, clamp, smoothstep, positionView } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { makeMaterials } from './render/materials';
import { buildCastle } from './castle/castle';
import { buildBridge } from './castle/bridge';
import { buildRevetment } from './castle/revetment';
import { buildTerrain, prepareTerrain, ISLAND, MOAT_OUTER, heightAt } from './world/terrain';
import { makeSky } from './world/sky';
import { makeWater } from './world/water';
import { buildVegetation, type Vegetation } from './world/vegetation';
import { CameraRig, VIEWS, spawnPoint, type Mode } from './camera/controls';
import { outerPoly, gatehouseFrame } from './castle/layout';
import { GATEHOUSE } from './castle/spec';
import { installHooks, type HookWindow } from './debug/hooks';
import { pointInPoly } from './core/math2d';
import { Builder } from './castle/builder';
import { buildCourse, type CourseInfo } from './debug/testcourse';
import { KeyboardInput, ScriptedInput, MergedInput } from './player/input';
import { MouseLook } from './camera/mouseLook';
import { Footsteps, browserAudio } from './player/footsteps';
import { systemClock } from './core/clock';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { setupPlay, type InteriorCollision } from './player/setup';
import type { LoadingScreen } from './loading/tunnel';
import { stepProgress, textureProgress } from './loading/model';
import { setTextureProgress } from './render/texpool';

const params = new URLSearchParams(location.search);
// Loading screen (src/loading, started by entry.ts): each boot step lights more of the tunnel;
// texture jobs fill CUTTING → RAISING.
let screen: LoadingScreen;
const say = (s: string) => screen.progress(stepProgress(s, screen.shown), s);
if (params.has('shot')) document.body.classList.add('shot');

async function main() {
  const terrainReady = prepareTerrain(); // mountain erosion in a worker, alongside the textures
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') });
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = params.get('tm') === 'agx' ? THREE.AgXToneMapping : params.get('tm') === 'aces' ? THREE.ACESFilmicToneMapping : THREE.NeutralToneMapping;
  renderer.toneMappingExposure = Number(params.get('exposure') ?? 0.72);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // soft PCF; PCFSoftShadowMap is deprecated in r187
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
  await terrainReady;

  await say('RAISING THE WALLS…');
  const test = params.get('test');
  let builder, lights: unknown[];
  let bridge: ReturnType<typeof buildBridge> | null = null;
  if (test === 'stairs') {
    const { buildStairTest } = await import('./debug/stairtest');
    const t = buildStairTest(params.has('cut'));
    builder = t.builder; lights = t.lights;
    for (const l of t.lights) scene.add(l);
    VIEWS.splice(0, VIEWS.length, ...t.views);
  } else {
    ({ builder, lights } = buildCastle());
    const b = buildBridge(builder, ISLAND, MOAT_OUTER, pointInPoly, heightAt);
    buildRevetment(builder, ISLAND, heightAt, (x, z) => Math.hypot(x - b.start[0], z - b.start[1]) < 3.2);
    bridge = b;
  }
  const mats = { old: M.old, new: M.new, trim: M.trim, slate: M.slate, lead: M.lead, wood: M.wood, iron: M.iron, void: M.void, glass: M.glass };
  const castle = builder.build(mats);
  scene.add(castle);
  let course: { info: CourseInfo; object: THREE.Object3D } | null = null;
  if (test === 'walk') {
    const cb = new Builder();
    const info = buildCourse(cb);
    course = { info, object: cb.build(mats) };
    course.object.name = 'test-course';
    scene.add(course.object);
  }

  await say('SHAPING THE LAND…');
  const sky = makeSky(renderer, scene);
  const terrain = buildTerrain(M.terrain);
  scene.add(terrain);
  const water = makeWater(sky.sunDir);
  scene.add(water);

  await say('PLANTING TREES…');
  let veg: Vegetation | null = null;
  if (!test) try { veg = await buildVegetation({ renderer, scene, keepClear: VIEWS.map((v) => [v.pos[0], v.pos[2]]), macro: M.macro }); scene.add(veg.group); } catch (e) { console.error('vegetation failed', e); }

  // post: GTAO from a single-sampled normal pre-pass, then the main pass, then a light grade
  // (threejs-postprocessing). ?ao=0 drops AO, ?aoview shows it, ?grade=0 drops the grade.
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  let aoTex: THREE.Node | null = null;
  if (params.get('ao') !== '0') {
    const pre = pass(scene, camera, { samples: 0 });
    pre.setMRT(mrt({ output: normalView }));
    const aoPass = ao(pre.getTextureNode('depth'), pre.getTextureNode(), camera);
    aoPass.resolutionScale = 0.5;
    // metre-scale occlusion so window reveals, corbels and machicolations read with depth
    aoPass.radius.value = 1.1; aoPass.thickness.value = 1.5; aoPass.scale.value = 1.2; aoPass.distanceExponent.value = 1.3;
    const aoNode = aoPass.getTextureNode();
    aoTex = aoNode;
    // half-res AO turns to noise far away; fade it out with distance (the textures carry their own AO)
    const aoFar = smoothstep(110, 260, positionView.z.negate());
    scenePass.contextNode = builtinAOContext(mix(aoNode.sample(screenUV).r, float(1), aoFar));
  }
  if (params.get('grade') !== '0') {
    // after tone mapping: a touch less saturation (candy greens and blues read as CG), a gentle
    // S-curve, warm highlights and neutral shadows (STYLE.md light)
    pipeline.outputColorTransform = false;
    const c = renderOutput(scenePass).rgb, l = luminance(c);
    let g = mix(vec3(l), c, 0.88);
    g = g.sub(0.5).mul(1.07).add(0.5);
    g = g.mul(mix(vec3(0.995, 1.0, 1.01), vec3(1.025, 1.0, 0.965), smoothstep(0.35, 0.9, l)));
    pipeline.outputNode = vec4(clamp(g, 0, 1), 1);
  } else pipeline.outputNode = scenePass;
  if (params.has('aoview') && aoTex) { pipeline.outputColorTransform = true; pipeline.outputNode = aoTex; }
  void output;

  // physics + player (G.1): colliders are built here, before the ready flag
  await say('LAYING THE FLOORS…');
  const input = new KeyboardInput(window);
  const scripted = new ScriptedInput();
  const footsteps = new Footsteps(browserAudio(window));
  const interior = (window as unknown as { __game?: { interior?: InteriorCollision } }).__game?.interior ?? null;
  const play = await setupPlay({
    castle, terrain, bridge, interior, input: new MergedInput([input, scripted]), view: camera, footsteps, clock: systemClock,
    extra: course ? { object: course.object, holes: course.info.holes } : null,
  });
  const { physics, player } = play;
  console.info('physics ready', play.timings, physics.stats());

  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true; orbit.dampingFactor = 0.08;
  orbit.minDistance = 8; orbit.maxDistance = 1200; orbit.maxPolarAngle = Math.PI * 0.495;
  // the stair bookmarks are close, upward-looking views: lift the orbit clamps
  if (test === 'stairs') { orbit.minDistance = 0.01; orbit.maxPolarAngle = Math.PI; }
  const rig = new CameraRig(camera, orbit, input);
  rig.player = player;
  rig.alpha = () => physics.alpha;
  rig.walkable = play.walkable;
  const mouse = new MouseLook({
    el: renderer.domElement, doc: document,
    enabled: () => rig.mode !== 'orbit',
    get: () => rig.getLook(), set: (l) => rig.setLook(l),
    // clear held keys on release so the player does not keep walking after Esc
    onLockChange: (locked) => { if (!locked) input.clear(); syncMode(); },
  });
  rig.mouse = mouse;
  input.capture = () => mouse.locked;
  try { const s = Number(localStorage.getItem('mouseSens')); if (s > 0) mouse.sensitivity = s; } catch { /* storage blocked */ }
  const tick = (dt: number) => { physics.step(dt); rig.update(dt); };
  const setTime = (h: number) => { sky.setTime(h); (water as unknown as { sunDirection: { value: THREE.Vector3 } }).sunDirection.value.copy(sky.sunDir); };
  setTime(Number(params.get('time') ?? 15.5));
  const start = VIEWS.find((v) => v.name === (params.get('view') ?? 'hero')) ?? VIEWS[0];
  rig.go(start);
  if (params.has('play')) rig.setMode('walk');

  // UI
  const ui = document.getElementById('ui')!;
  const modeRow = document.createElement('div'); modeRow.className = 'row';
  const viewRow = document.createElement('div'); viewRow.className = 'row';
  const modeBtns: Record<string, HTMLButtonElement> = {};
  const help = document.getElementById('help')!;
  const keysText = 'P walk · F fly · O orbit';
  const walkKeys = 'WASD walk · Shift run · Space jump · C (or Ctrl) crouch · M sound';
  const helpText: Record<Mode, string> = {
    orbit: `Drag to orbit · right-drag to pan · scroll to zoom · ${keysText}`,
    fly: `Click to look with the mouse · WASD move · E/Q up/down · Shift fast · ${keysText}`,
    walk: `Click to look with the mouse · ${walkKeys} · ${keysText}`,
  };
  const lockedText: Record<Mode, string> = { orbit: helpText.orbit, fly: 'WASD move · E/Q up/down · Shift fast · Esc to release mouse', walk: `${walkKeys} · Esc to release mouse` };
  const crosshair = document.getElementById('crosshair')!;
  const syncMode = () => {
    for (const [k, b] of Object.entries(modeBtns)) b.classList.toggle('on', k === rig.mode);
    help.textContent = (rig.locked ? lockedText : helpText)[rig.mode];
    crosshair.hidden = !rig.locked;
  };
  rig.onModeChange = () => syncMode();
  input.onPress = (code) => {
    footsteps.unlock();
    if (code === 'KeyP') rig.setMode('walk');
    else if (code === 'KeyF') rig.setMode('fly');
    else if (code === 'KeyO') rig.setMode('orbit');
    else if (code === 'KeyM') footsteps.enabled = !footsteps.enabled;
  };
  renderer.domElement.addEventListener('pointerdown', () => footsteps.unlock());
  for (const m of ['orbit', 'fly', 'walk'] as Mode[]) {
    const b = document.createElement('button'); b.textContent = m[0].toUpperCase() + m.slice(1);
    b.onclick = () => { rig.setMode(m); syncMode(); b.blur(); };
    modeBtns[m] = b; modeRow.appendChild(b);
  }
  const time = document.createElement('label');
  time.innerHTML = 'Time <input type="range" min="6.5" max="19.8" step="0.1">';
  const slider = time.querySelector('input')!; slider.value = String(sky.hours);
  slider.oninput = () => setTime(Number(slider.value));
  modeRow.appendChild(time);
  const sens = document.createElement('label');
  sens.innerHTML = 'Mouse <input type="range" min="0.0008" max="0.006" step="0.0001">';
  const sensIn = sens.querySelector('input')!; sensIn.value = String(mouse.sensitivity);
  sensIn.oninput = () => { mouse.sensitivity = Number(sensIn.value); try { localStorage.setItem('mouseSens', sensIn.value); } catch { /* private mode */ } };
  modeRow.appendChild(sens);
  for (const v of VIEWS) { const b = document.createElement('button'); b.textContent = v.label; b.onclick = () => { rig.go(v); syncMode(); }; viewRow.appendChild(b); }
  ui.append(modeRow, viewRow);
  syncMode();

  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

  await say('LIGHTING…');
  await renderer.compileAsync(scene, camera);

  const info = renderer.info;
  const hooks = installHooks({
    renderer, camera, rig, setTime, getTime: () => sky.hours, tick,
    renderNow: async () => { veg?.update(camera); pipeline.render(); },
    physics, player, input: scripted, course: course?.info ?? null, interior,
    probes: { island: ISLAND, boundary: play.boundary, outer: outerPoly(), gate: { ...gatehouseFrame(), project: GATEHOUSE.project }, bridge, spawn: spawnPoint() },
    stats: () => ({
      castleTriangles: castle.userData.triangles, terrain: terrain.userData, vegetation: veg?.stats(), windows: lights.length,
      drawCalls: info.render.drawCalls, frameTriangles: info.render.triangles, textureMs: Math.round(tTex),
      physics: { ...physics.stats(), ...play.timings },
    }),
  }, window as unknown as HookWindow, systemClock);

  if (params.has('shot')) {
    // captures render on demand through __game.step(), so a slow software renderer is not flooded
    screen.dispose();
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
    tick(dt);
    veg?.update(camera);
    pipeline.render();
  });
  // two frames, then reveal
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  hooks.ready = true;
  await screen.finish();
}

/** Boot the castle behind the loading screen (called by src/loading/entry.ts). */
export function boot(loading: LoadingScreen) {
  screen = loading;
  setTextureProgress((done, total) => void screen.progress(textureProgress(done, total)));
  return main().catch((e) => { console.error(e); screen.dispose(); const el = document.createElement('div'); el.id = 'loading'; el.textContent = 'Something went wrong: ' + (e?.message ?? e); document.body.appendChild(el); });
}
