// Castle exterior review build. Boot: renderer → textures/materials → castle → world → compile → run.
// URL flags: ?webgl (force WebGL2, used for headless captures), ?view=<bookmark>, ?time=<hours>,
// ?ao=0 (no ambient occlusion), ?stones=0 (no real stones), ?shot (hide UI; add ?ui=locked,tools,card to keep the HUD), ?debug (three Inspector), ?seed=N,
// ?test=stairs (stair test scene instead of the castle; &cut for a cutaway drum).
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, builtinAOContext, screenUV, renderOutput, luminance, mix, vec3, vec4, float, clamp, smoothstep, positionView } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { makeMaterials } from './render/materials';
import { buildCastle } from './castle/castle';
import { StoneField } from './castle/stones/field';
import { StoneSet } from './castle/stones/set';
import { bridgePlan, buildBridge, withBridge, type BridgePlan } from './castle/bridge';
import { revetmentPlan, buildRevetment } from './castle/revetment';
import { rimMask, rimTurf, rimTurfMesh } from './castle/turf';
import { gatehouseFrame } from './castle/layout';
import { buildTerrain, prepareTerrain, ISLAND, MOAT_OUTER, heightAt, islandWalkable, footDist, defaultTerrain } from './world/terrain';
import { rngFor } from './core/rng';
import { makeSky } from './world/sky';
import { makeWater } from './world/water';
import { buildVegetation, type Vegetation } from './world/vegetation';
import { CameraRig, VIEWS } from './camera/controls';
import { buildInterior } from './castle/interior';
import { interiorViews } from './camera/interiorViews';
import { installHooks } from './debug/hooks';
import { pointInPoly } from './core/math2d';
import { buildDoors, gateDoorSpecs, gatePortcullisSpec, inDoorway } from './castle/interior/doors';
import { createInteraction } from './game/interact';
import { DoorAudio } from './game/doorAudio';
import type { LoadingScreen } from './loading/tunnel';
import { stepProgress, textureProgress } from './loading/model';
import { setTextureProgress } from './render/texpool';
import { createHud, browserHudDeps } from './ui/hud';
import { wireGameHud } from './ui/gameHud';
import { showBootError } from './ui/error';

const params = new URLSearchParams(location.search);
// Loading screen (src/loading, started by entry.ts): each boot step lights more of the tunnel;
// texture jobs fill "Cutting the stone" → "Raising the walls".
let screen: LoadingScreen;
const say = (s: string) => screen.progress(stepProgress(s, screen.shown), s);
if (params.has('shot') && !params.has('ui')) document.body.classList.add('shot');

async function main() {
  if (params.get('test') === 'doors') { const { runDoorTest } = await import('./test/doorScene'); return runDoorTest(screen); }
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

  await say('Cutting the stone…');
  const t0 = performance.now();
  const M = await makeMaterials();
  const tTex = performance.now() - t0;
  await terrainReady;

  await say('Raising the walls…');
  const test = params.get('test');
  let builder, lights: unknown[];
  let bridgeTriangles = 0, revetmentTriangles = 0, revetment: ReturnType<typeof revetmentPlan> | undefined, bridge: BridgePlan | undefined;
  if (test === 'stairs') {
    const { buildStairTest } = await import('./debug/stairtest');
    const t = buildStairTest(params.has('cut'));
    builder = t.builder; lights = t.lights;
    for (const l of t.lights) scene.add(l);
    VIEWS.splice(0, VIEWS.length, ...t.views);
  } else {
    ({ builder, lights } = buildCastle());
    bridge = bridgePlan({ island: ISLAND, moatOuter: MOAT_OUTER, gate: gatehouseFrame(), groundAt: heightAt, rng: rngFor('bridge') });
    bridgeTriangles = buildBridge(builder, bridge, rngFor('bridge-stones'));
    revetment = revetmentPlan({ island: ISLAND, groundAt: heightAt, rng: rngFor('revetment'), exclude: (x, z) => pointInPoly(bridge!.footprint, x, z) });
    revetmentTriangles = buildRevetment(builder, revetment, rngFor('revetment-stones'));
  }
  const mats = { old: M.old, new: M.new, trim: M.trim, slate: M.slate, lead: M.lead, wood: M.wood, iron: M.iron, void: M.void, glass: M.glass };
  // interiors: rooms, doorways, embrasures, stairs, cellars and tunnels; carves the exterior bins in place
  const interior = params.get('interior') === '0' || test ? null : buildInterior(mats, builder, { heightAt });
  const castle = builder.build(mats);
  scene.add(castle);
  if (interior) { for (const g of interior.groups) scene.add(g.object); VIEWS.push(...interiorViews(interior.plan)); }
  // furniture (src/props): off until Anders approves it in the castle; ?furniture=1 turns it on
  let furniture: import('./props/furnish').Furniture | null = null;
  if (interior && params.get('furniture') === '1') {
    await say('FURNISHING THE ROOMS…');
    const [{ furnish }, { makePropMaterials }, T] = await Promise.all([import('./props/furnish'), import('./props/render'), import('./props/textures')]);
    const pm = makePropMaterials({ wood: T.woodTex(), iron: T.ironTex(), cloth: T.clothTex(), straw: T.strawTex(), ceramic: T.ceramicTex() });
    furniture = furnish(interior.plan, pm);
    for (const g of interior.groups) { const o = furniture.objects.get(g.key); if (o) g.object.add(o); }
  }
  const tStones = performance.now();
  const stoneSet = new StoneSet(builder.stoneFaces, builder.stoneExcl); // every stone of the castle (D.1), queryable with stonesNear()
  const layoutMs = Math.round(performance.now() - tStones);
  const stones = new StoneField(stoneSet, { old: M.old, new: M.new }); // real stones near the camera
  scene.add(stones.group);
  stones.group.visible = params.get('stones') !== '0'; // ?stones=0: textured walls only, for A/B
  // the main gate: two leaves with a wicket, and the portcullis (until the shell emits all DoorSpecs)
  const audio = new DoorAudio(camera);
  const gateSpecs = test ? [] : gateDoorSpecs();
  const doors = buildDoors(gateSpecs, M, undefined, { portcullis: test ? [] : [gatePortcullisSpec()], sound: audio, initial: params.has('doors') ? Number(params.get('doors')) : undefined });
  scene.add(doors.object);

  await say('Shaping the land…');
  const sky = makeSky(renderer, scene);
  const terrain = buildTerrain(M.terrain);
  scene.add(terrain);
  if (revetment) {
    // turf over the rim, with the same noise as the terrain's ground weights (world/terrain.ts 'terrain-b')
    const rimNoise = defaultTerrain().deps.noise2('terrain-b');
    scene.add(rimTurfMesh(rimTurf(revetment, heightAt, rimMask({ footDist, noise: rimNoise, gate: gatehouseFrame() })), M.terrain));
  }
  const water = makeWater(sky.sunDir);
  scene.add(water);

  await say('Planting trees…');
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

  const rig = new CameraRig(camera, renderer.domElement);
  // walk mode may step into the gate passage when the leaves and portcullis let you
  const feet = new THREE.Vector3();
  // the island half of the bridge is walkable up to its broken edge
  const ground = bridge ? withBridge(bridge, islandWalkable, heightAt) : { canWalk: islandWalkable, groundAt: heightAt };
  rig.canWalk = (x, z) => {
    feet.set(x, camera.position.y - 0.8, z);
    if (doors.blocksPlayer(feet)) return false;
    return ground.canWalk(x, z) || gateSpecs.some((d) => inDoorway(d, x, z));
  };
  // the passage floor is the gate sill, not the terrain under the gatehouse
  rig.groundAt = (x, z) => { const d = gateSpecs.find((g) => inDoorway(g, x, z, 0, 0.2)); return d ? d.centre[1] : ground.groundAt(x, z); };
  // HUD (src/ui): crosshair, use prompt, help, controls card and the review tools (` toggles them)
  const hud = createHud(browserHudDeps(), { onToolsOpen: () => rig.look.release() });
  const interaction = createInteraction(camera, renderer.domElement, () => doors.interactables, { enabled: () => rig.mode !== 'fly', view: hud.promptView });
  // the stair bookmarks are close, upward-looking fly views: lift the orbit clamps that go() applies
  if (test) { rig.orbit.minDistance = 0.01; rig.orbit.maxPolarAngle = Math.PI; }
  const setTime = (h: number) => { sky.setTime(h); (water as unknown as { sunDirection: { value: THREE.Vector3 } }).sunDirection.value.copy(sky.sunDir); };
  setTime(Number(params.get('time') ?? 15.5));
  const start = VIEWS.find((v) => v.name === (params.get('view') ?? 'hero')) ?? VIEWS[0];
  rig.go(start);

  const ui = wireGameHud(hud, {
    rig, views: VIEWS, search: location.search, time: { get: () => sky.hours, set: setTime },
    walkFrom: { above: 30, view: 'gate', height: () => camera.position.y },
  });
  rig.onLockChange = ui.sync;

  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

  await say('Lighting the halls…');
  stones.update(camera.position, Infinity);
  await renderer.compileAsync(scene, camera);

  const info = renderer.info;
  const hooks = installHooks({
    renderer, camera, rig, setTime, getTime: () => sky.hours,
    renderNow: async () => { info.reset(); stones.update(camera.position, Infinity); veg?.update(camera); pipeline.render(); },
    tick: (dt) => { doors.update(dt, camera.position); interaction.update(); ui.sync(); },
    use: () => interaction.use(),
    doors, hud,
    stats: () => ({
      interior: interior ? { triangles: interior.triangles, groups: interior.groups.length, meshes: interior.groups.reduce((s, g) => s + g.object.children.length, 0), rooms: interior.plan.rooms.length, doors: interior.plan.doors.length, stairs: interior.plan.stairs.length, ...interior.stats } : null,
      furniture: furniture ? { props: furniture.props, triangles: furniture.triangles, groups: furniture.objects.size, emitters: [...furniture.emitters.values()].reduce((s, e) => s + e.length, 0) } : null,
      castleTriangles: castle.userData.triangles, bridgeTriangles, revetmentTriangles, stones: { ...stones.stats(), layoutMs }, terrain: terrain.userData, vegetation: veg?.stats(), windows: lights.length,
      doorTriangles: doors.triangles, doors: doors.state(), target: interaction.target(), sounds: audio.log.slice(-6),
      drawCalls: info.render.drawCalls, frameTriangles: info.render.triangles, textureMs: Math.round(tTex),
    }),
  });

  (window as unknown as { __game: Record<string, unknown> }).__game.interior = interior ? { plan: interior.plan, groups: interior.groups, collision: interior.collision } : null;
  (window as unknown as { __game: Record<string, unknown> }).__game.furniture = furniture ? { dressing: furniture.dressing, emitters: furniture.emitters, flames: furniture.flames, collision: furniture.collision } : null;

  if (params.has('shot')) {
    // captures render on demand through __game.step(), so a slow software renderer is not flooded
    info.autoReset = false; // renderNow resets it, so state() reports the last captured frame
    screen.dispose();
    hooks.ready = true;
    return;
  }
  let last = performance.now(), frames = 0, acc = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now(), raw = (now - last) / 1000, dt = Math.min(0.05, raw); last = now;
    frames++; acc += raw;
    if (acc > 0.5) { ui.setFps(frames / acc); frames = 0; acc = 0; }
    rig.update(dt);
    stones.update(camera.position);
    doors.update(dt, camera.position);
    interaction.update();
    ui.sync();
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
  return main().catch((e) => { console.error(e); screen.dispose(); showBootError(document, e, () => location.reload()); });
}
