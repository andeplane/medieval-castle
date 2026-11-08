// Castle exterior review build. Boot: renderer → textures/materials → castle → world → compile → run.
// URL flags: ?webgl (force WebGL2, used for headless captures), ?view=<bookmark>, ?time=<hours>,
// ?ao=0 (no ambient occlusion), ?stones=0 (no real stones), ?interior=0, ?shot (hide UI; add ?ui=locked,tools,card to keep the HUD), ?debug (three Inspector), ?seed=N,
// ?exposure=N (fixed), ?play (start walking at the spawn), ?test=walk (movement test course on the east lawn),
// ?test=stairs (stair test scene instead of the castle; &cut for a cutaway drum),
// ?test=room (no castle: a test hall + chamber for the interior light, debug/roomtest.ts).
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, builtinAOContext, screenUV, renderOutput, luminance, mix, vec3, vec4, float, clamp, smoothstep, positionView } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { makeMaterials } from './render/materials';
import { buildCastle } from './castle/castle';
import { StoneField, LOD } from './castle/stones/field';
import { StoneSet } from './castle/stones/set';
import { layoutStonesOffThread, browserStoneWorker } from './castle/stones/offThread';
import { caveRockOffThread, browserCaveWorker } from './castle/interior/caveOffThread';
import { precompile, renderOnce, asyncPipelines, type DeferredPipelines, type PipelineBackendLike } from './render/precompile';
import { bridgePlan, buildBridge, type BridgePlan } from './castle/bridge';
import { revetmentPlan, buildRevetment } from './castle/revetment';
import { rimMask, rimTurf, rimTurfMesh } from './castle/turf';
import { buildTerrain, prepareTerrain, ISLAND, MOAT_OUTER, heightAt, footDist, defaultTerrain } from './world/terrain';
import { rngFor } from './core/rng';
import { makeSky } from './world/sky';
import { makeWater, cameraFrustum } from './world/water';
import { buildVegetation, type Vegetation } from './world/vegetation';
import { CameraRig, VIEWS, spawnPoint } from './camera/controls';
import { outerPoly, gatehouseFrame, courtyard } from './castle/layout';
import { GATEHOUSE, GROUND, WINGS } from './castle/spec';
import { bridgeInfo } from './physics/boundary';
import { buildInterior } from './castle/interior';
import { groupKey } from './castle/interior/shell';
import { interiorViews } from './camera/interiorViews';
import { installHooks, type HookWindow } from './debug/hooks';
import { pointInPoly } from './core/math2d';
import { Builder } from './castle/builder';
import { makeInteriorMaterials, bakeInteriorLight, createInteriorLight, bvhOccluder, sunStateOf, buildShadowSkins, syncFires as syncFireTextures, setCarried, CAVE_FLOOR } from './render/interiorLight';
import { createAutoExposure, gpuLumaReader } from './render/exposure';
import { createVisibility, shadowInView } from './world/visibility';
import { wallTorches, type FireSources } from './render/interiorFire';
import { createWindowFlags, makeWindowGlass, triFrames, groupIndexOfRooms, tagWindowGroups, nightOf } from './render/windowGlass';
import { FireTable, roomFires, firesByRoom } from './light/roomLight';
import { PROFILES, flicker } from './light/flicker';
import { makeFlameSprites } from './light/three';
import { linkFlames, flameBrightness, type FlameInstance } from './light/flames';
import { createRoomFires } from './light/roomFires';
import type { WorkerPort, FurnitureJobs } from './props/furnishWorker';
import type { FurnitureStreamer, WantedRooms } from './props/streamer';
import { buildRoomTest } from './debug/roomtest';
import type { InteriorGroup, InteriorPlan, SpaceId } from './castle/interior/types';
import type { PropMat } from './props/geom';
import type { WindowInput } from './render/interiorMath';
import { buildCourse, type CourseInfo } from './debug/testcourse';
import { KeyboardInput, ScriptedInput, MergedInput } from './player/input';
import { MouseLook } from './camera/mouseLook';
import { Footsteps, browserAudio } from './player/footsteps';
import { systemClock } from './core/clock';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { setupPlay, playDoors } from './player/setup';
import { buildDoors, buildCastleDoors, inDoorway } from './castle/interior/doors';
import { portcullisInPlan } from './castle/interior/portcullis';
import { planInterior } from './castle/interior/plan';
import { createInteraction } from './game/interact';
import { DoorAudio } from './game/doorAudio';
import type { LoadingScreen } from './loading/tunnel';
import { createHud, browserHudDeps } from './ui/hud';
import { wireGameHud } from './ui/gameHud';
import { showBootError } from './ui/error';
import { createStatsOverlay } from './ui/statsOverlay';
import { FrameStats, pixelRatio, gpuFrameTimes } from './render/perf';
import { ResolutionGovernor, startRatio, gtaoSizeFor } from './render/resolution';
import { runBench, benchTable, BENCH_STEPS, type BenchRow } from './debug/bench';
import { CAVE_ZONE } from './castle/interior/caves';
import { doorsOnWayToCaves } from './castle/interior/nav';
import { caveFires, caveShading } from './castle/interior/caveGeom';
import { lanternFire, lanternAt, lanternLit } from './player/lantern';

const params = new URLSearchParams(location.search);
/** Doors that never open: the sally-port grille on the far bank (the moat tunnel is a dead end). */
// Loading screen (src/loading, started by entry.ts): each boot step lights more of the tunnel,
// in proportion to how long the step took on this device last time (src/loading/timeline.ts).
let screen: LoadingScreen;
// each step is a performance mark too, so load profiles (scripts/loadtime.mjs) can split by step
const say = (s: string) => { performance.mark(s); return screen.step(s); };
// between two pieces of one step: input and a paint, so the pieces are separate tasks (no frozen mouse look)
const breathe = () => screen.breathe();
if (params.has('shot') && !params.has('ui')) document.body.classList.add('shot');

async function main() {
  if (params.get('test') === 'doors') { const { runDoorTest } = await import('./test/doorScene'); return runDoorTest(screen); }
  const terrainReady = prepareTerrain(); // mountain erosion in a worker, alongside the textures
  // trackTimestamp: GPU time per frame for the stats overlay and the benchmark (WebGPU timestamp queries)
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl'), trackTimestamp: !params.has('webgl') });
  await renderer.init();
  // the screen's ratio (≤ 2) is the ceiling; dynamic resolution starts at the 1440p pixel budget and climbs
  // from there when the GPU has headroom (?scale= fixes the ratio, ?dynres=0 keeps the screen's)
  const maxRatio = pixelRatio(devicePixelRatio, params.get('scale'));
  const useDynres = !params.has('scale') && params.get('dynres') !== '0';
  renderer.setPixelRatio(useDynres ? startRatio(innerWidth, innerHeight, maxRatio) : maxRatio);
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
  const testRoom = test === 'room';
  let builder: Builder, lights: unknown[];
  let bridgeTriangles = 0, revetmentTriangles = 0, revetment: ReturnType<typeof revetmentPlan> | undefined, bridge: BridgePlan | undefined;
  if (test === 'stairs') {
    const { buildStairTest } = await import('./debug/stairtest');
    const t = buildStairTest(params.has('cut'));
    builder = t.builder; lights = t.lights;
    for (const l of t.lights) scene.add(l);
    VIEWS.splice(0, VIEWS.length, ...t.views);
  } else if (testRoom) {
    builder = new Builder(); lights = [];
  } else {
    ({ builder, lights } = buildCastle(undefined, params.get('interior') === '0' ? [] : undefined)); // no doorways without interiors
    await breathe();
    bridge = bridgePlan({ island: ISLAND, moatOuter: MOAT_OUTER, gate: gatehouseFrame(), groundAt: heightAt, rng: rngFor('bridge') });
    bridgeTriangles = buildBridge(builder, bridge, rngFor('bridge-stones'));
    revetment = revetmentPlan({ island: ISLAND, groundAt: heightAt, rng: rngFor('revetment'), exclude: (x, z) => pointInPoly(bridge!.footprint, x, z) });
    revetmentTriangles = buildRevetment(builder, revetment, rngFor('revetment-stones'));
  }
  const mats = { old: M.old, new: M.new, trim: M.trim, slate: M.slate, lead: M.lead, wood: M.wood, iron: M.iron, void: M.void, glass: M.glass, pave: M.pave, rock: M.rock, pool: M.pool, glow: M.glow };
  // interiors: rooms, doorways, embrasures, stairs, cellars and tunnels; carves the exterior bins in place
  // wall torches (render/interiorFire.ts) when there is no furniture: placed on the plan, their holders
  // built by the shell into each room's group, their flames and lights fed to the light rig below
  await breathe();
  const iplan = params.get('interior') === '0' || test === 'stairs' ? null : planInterior();
  const torches = iplan && params.get('furniture') !== '1' ? wallTorches(iplan, (id) => groupKey(iplan.rooms.find((r) => r.id === id)!)) : null;
  // the caves' own fires: the smugglers' lantern on its crate and their fire in the great cavern (their
  // bodies are cave geometry, not torch holders or furniture), lit with or without furniture
  const caveFire = iplan?.caves ? caveFires(iplan.caves, groupKey(iplan.rooms.find((r) => r.zone === CAVE_ZONE)!)) : null;
  if (torches && caveFire) {
    torches.emitters.push(...caveFire.emitters); torches.flames.push(...caveFire.flames); torches.group.push(...caveFire.group);
  }
  // the caves' rock is meshed in a worker (castle/interior/caveOffThread.ts) and waits in caveRock's cache
  if (iplan?.caves) await caveRockOffThread(iplan.caves, iplan.seed, browserCaveWorker());
  const interior = iplan ? buildInterior(mats, builder, { heightAt, plan: iplan, torches: torches?.holders }) : null;
  // every stone of the castle (D.1) is laid out in a worker while the land, trees and floors are made
  // (castle/stones/offThread.ts); the faces are final once the interior has carved its doorways
  const tStones = performance.now();
  const stonesLaid = layoutStonesOffThread(builder.stoneFaces, builder.stoneExcl, browserStoneWorker());
  await breathe();
  const castle = builder.build(mats);
  scene.add(castle);
  if (interior) { for (const g of interior.groups) scene.add(g.object); VIEWS.push(...interiorViews(interior.plan)); }
  // furniture (src/props): off until Anders approves it in the castle; ?furniture=1 turns it on.
  // Streamed: a small pool of workers furnishes rooms on demand (props/furnishWorker.ts) and makes the
  // prop textures; the rooms near the camera come in during the first frames (createFurnitureStreamer below)
  const interiorLight = createInteriorLight(1024, iplan?.rooms ?? []);
  let furnitureJobs: FurnitureJobs | null = null;
  let propTextures: Promise<import('./props/furnishWorker').PropTexSet> | null = null;
  if (interior && params.get('furniture') === '1') {
    const { workerJobs, poolSize } = await import('./props/furnishWorker');
    const worker = () => new Worker(new URL('./props/furnish.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerPort;
    furnitureJobs = workerJobs(worker, poolSize(navigator.hardwareConcurrency), { plan: interior.plan, maxRooms: interiorLight.maxRooms, windows: interior.windows });
    propTextures = furnitureJobs.textures();
  }
  let course: { info: CourseInfo; object: THREE.Object3D } | null = null;
  if (test === 'walk') {
    const cb = new Builder();
    const info = buildCourse(cb);
    course = { info, object: cb.build(mats) };
    course.object.name = 'test-course';
    scene.add(course.object);
  }

  await say('Shaping the land…');
  const sky = makeSky(renderer, scene);
  await breathe();
  // no ground in the rooms: world/terrain.ts groundHole, plus the interior's own (the sally port's housing)
  const terrain = buildTerrain(M.terrain, undefined, { holes: interior?.groundHoles.terrain });
  scene.add(terrain);
  await breathe();
  if (revetment) {
    // turf over the rim, with the same noise as the terrain's ground weights (world/terrain.ts 'terrain-b')
    const rimNoise = defaultTerrain().deps.noise2('terrain-b');
    scene.add(rimTurfMesh(rimTurf(revetment, heightAt, rimMask({ footDist, noise: rimNoise, gate: gatehouseFrame() })), M.terrain));
  }
  const water = makeWater(sky.sunDir, interior?.groundHoles.water);
  scene.add(water);

  // interior light (render/interiorLight.ts): the shell's meshes switch to the sun-only interior
  // materials; the test cell (?test=room) brings its own hall and chamber
  const IM = makeInteriorMaterials(M, sky.sun, interiorLight);
  const IMu = makeInteriorMaterials(M, null, interiorLight); // cellars and tunnels: no direct sun
  const keys = ['old', 'new', 'trim', 'wood', 'iron', 'glass'] as const;
  const swap = new Map<THREE.Material, THREE.Material>(keys.map((k) => [M[k], IM[k]]));
  const swapUnder = new Map<THREE.Material, THREE.Material>(keys.map((k) => [M[k], IMu[k]]));
  for (const k of ['rock', 'pool', 'glow'] as const) swapUnder.set(M[k], IMu.adopt(M[k], CAVE_FLOOR)); // the caves: underground only, darker
  if (iplan?.caves) { const s = caveShading(iplan.caves); M.caveShade.pool.value.fromArray(s.pool); M.caveShade.fire.value.fromArray(s.fire); }
  let lit: { groups: InteriorGroup[]; plan: InteriorPlan; windows: WindowInput[] } = { groups: [], plan: { rooms: [], doors: [], stairs: [] }, windows: [] };
  const shells: THREE.Object3D[] = [castle];
  if (interior) {
    // interior meshes cast no sun shadow: the hidden shadow skins (buildShadowSkins) shape the light
    // through the windows, and each mesh would otherwise be drawn again into every shadow cascade
    for (const g of interior.groups) {
      const sw = g.floor < 0 ? swapUnder : swap;
      g.object.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.material = sw.get(m.material as THREE.Material) ?? m.material; m.castShadow = false; } });
    }
    // castle.ts window lights ({p, n, w, h}); the embrasure behind each one is fitted to its room
    lit = { groups: interior.groups, plan: interior.plan, windows: lights as WindowInput[] };
  }
  if (testRoom) {
    const t = buildRoomTest(M, IM);
    scene.add(t.exterior); shells.push(t.exterior);
    for (const g of t.groups) scene.add(g.object);
    VIEWS.push(...t.views);
    lit = t;
  }
  await breathe();
  const tB = performance.now();
  const occluder = bvhOccluder([...shells, ...lit.groups.map((g) => g.object)]);
  const bvhMs = performance.now() - tB;
  await breathe();
  const bake = bakeInteriorLight(lit.groups, occluder, { plan: lit.plan, windows: lit.windows, sun: sunStateOf(sky.sun), light: interiorLight });
  if (lit.plan.rooms.length) scene.add(buildShadowSkins(lit.plan, bake.apertures));
  console.info(`interior light: ${bake.rooms} rooms, ${bake.apertures.length} apertures, ${bake.triangles} tris tagged, bake ${bake.ms.toFixed(1)} ms, BVH ${bvhMs.toFixed(1)} ms over ${occluder.triangles} tris`);
  // leaf doors and the portcullis pass daylight on as they open: re-solve when one moves
  const doorLit: Record<string, number> = {};
  const syncDoorLight = () => {
    for (const [id, o] of Object.entries(doors.state())) {
      const was = doorLit[id];
      if (was === undefined || Math.abs(was - o) > 0.05 || (o !== was && (o === 0 || o === 1))) { doorLit[id] = o; bake.setDoorOpen(id, o); vis.setDoorOpen(id, o > 0); }
    }
  };
  // props join their rooms' groups after the bake (they don't shadow the sun-visibility rays): they take
  // the interior clones of their materials (a group below ground, or a stair, has no sun), and the
  // worker tagged their triangles with rooms as tagGroups tags the shell's, so they get the room's light
  let furnMats: { above: Record<PropMat, THREE.Material>; under: Record<PropMat, THREE.Material> } | null = null;
  if (propTextures) {
    const [{ makePropMaterials }, { PROP_MATS }, T] = await Promise.all([import('./props/render'), import('./props/geom'), propTextures]);
    const tw = performance.now();
    const pm = makePropMaterials(T);
    const adoptAll = (set: typeof IM) => Object.fromEntries(PROP_MATS.map((k) => [k, (pm[k] as THREE.MeshStandardNodeMaterial).isMeshStandardNodeMaterial ? set.adopt(pm[k] as THREE.MeshStandardNodeMaterial) : pm[k]])) as Record<PropMat, THREE.Material>;
    furnMats = { above: adoptAll(IM), under: adoptAll(IMu) };
    console.info(`furniture: prop materials in ${(performance.now() - tw).toFixed(0)} ms (rooms stream in from workers)`);
  }
  await breathe();
  // exterior windows (render/windowGlass.ts): see-through into rooms that are shown, a dark pane
  // (warm at night when the room has firelight) while their group is culled
  const winFlags = createWindowFlags(Math.max(1, lit.groups.length));
  const winGlass = makeWindowGlass(M.glass, winFlags);
  const paneSoup: number[] = [];
  for (const g of lit.groups) g.object.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.material === IM.glass) paneSoup.push(...(m.geometry.attributes.position.array as Float32Array)); });
  const panes = triFrames(paneSoup), roomGroup = groupIndexOfRooms(lit.groups);
  let winTagged = 0;
  for (const s of shells) s.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.material === M.glass) { winTagged += tagWindowGroups(m.geometry, lit.plan.rooms, roomGroup, panes); m.material = winGlass; } });

  await say('Planting trees…');
  let veg: Vegetation | null = null;
  if (!test) try { veg = await buildVegetation({ renderer, scene, keepClear: VIEWS.map((v) => [v.pos[0], v.pos[2]]), macro: M.macro }); scene.add(veg.group); } catch (e) { console.error('vegetation failed', e); }

  // post: GTAO from a single-sampled normal pre-pass, then the main pass, then a light grade
  // (threejs-postprocessing). ?ao=0 drops AO, ?aoview shows it, ?grade=0 drops the grade.
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  let aoTex: THREE.Node | null = null;
  let prePass: ReturnType<typeof pass> | null = null;
  if (params.get('ao') !== '0') {
    const pre = pass(scene, camera, { samples: 0 });
    pre.setMRT(mrt({ output: normalView }));
    // the AO is computed at half resolution, so its normal/depth pre-pass needs no more (it was a full
    // second drawing of the scene at full size: ~7 ms of a 20 ms frame on an M4 at retina 2×)
    pre.setResolutionScale(0.5);
    prePass = pre;
    const aoPass = ao(pre.getTextureNode('depth'), pre.getTextureNode(), camera);
    aoPass.resolutionScale = 0.5;
    // the AO target must be texel for texel the pre-pass (GTAONode rounds where PassNode floors: a seam
    // down the middle of the screen at odd buffer widths, render/resolution.ts passTexels)
    const aoSetSize = aoPass.setSize.bind(aoPass);
    aoPass.setSize = (w: number, h: number) => aoSetSize(gtaoSizeFor(w, 0.5), gtaoSizeFor(h, 0.5));
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

  // the stones from the worker: the set is queryable with stonesNear(); real stones are drawn on silhouettes
  // (parapets, corners, buttresses), flat walls get their depth from parallax. ?stones=all: every stone
  // near the camera, as before (A/B)
  const stoneSet = new StoneSet(builder.stoneFaces, builder.stoneExcl, {}, await stonesLaid);
  const layoutMs = Math.round(performance.now() - tStones); // wall time to the worker's answer
  const stones = new StoneField(stoneSet, { old: M.old, new: M.new }, params.get('stones') === 'all' ? { ...LOD, plain: Infinity } : LOD);
  scene.add(stones.group);
  stones.group.visible = params.get('stones') !== '0'; // ?stones=0: textured walls only, for A/B

  // physics + player (G.1): colliders are built here, before the ready flag
  await say('Laying the floors…');
  const input = new KeyboardInput(window);
  const scripted = new ScriptedInput();
  const footsteps = new Footsteps(browserAudio(window));
  const play = await setupPlay({
    castle, terrain, bridge: bridge ? bridgeInfo(bridge.walkable, bridge.d) : null, interior: interior ? { collision: interior.collision, terrainHoles: interior.groundHoles.terrain } : null, input: new MergedInput([input, scripted]), view: camera, footsteps, clock: systemClock,
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
    onLockChange: (locked) => { if (!locked) input.clear(); ui.sync(); },
  });
  rig.mouse = mouse;
  input.capture = () => mouse.locked;
  try { const s = Number(localStorage.getItem('mouseSens')); if (s > 0) mouse.sensitivity = s; } catch { /* storage blocked */ }
  // doors (G.2): the main gate has no leaves; the plan's 'gate-main' is closed by its portcullis, whose
  // windlass stands in the room above. Every leaf door of the interior plan is a kinematic box in the
  // physics world, posed each fixed tick, and so is the grille while it is low; the player and any NPC
  // motors stop a swinging leaf.
  const audio = new DoorAudio(camera);
  const plan = test === 'stairs' ? null : interior?.plan ?? planInterior(); // the stair scene has no castle
  const gateDoor = plan?.doors.find((d) => d.id === 'gate-main');
  const gateSpecs = gateDoor ? [gateDoor] : [];
  const doorSets = playDoors([], interior?.plan.doors ?? []);
  const port = gateDoor ? [portcullisInPlan(gateDoor, plan!.rooms)] : [];
  // a batch has one material: leaves take their floor's interior material (as the furniture does; cellars
  // and tunnels have no sun), and so does the portcullis, for its windlass room; a courtyard or outside
  // door's faces that look out take the exterior wood and iron, which the sun and sky light
  const inMats = (set: typeof IM) => ({ wood: set.adopt(M.wood), iron: set.adopt(M.iron) });
  const doorOpts = { sound: audio, characters: play.characters, initial: params.has('doors') ? Number(params.get('doors')) : undefined, portcullis: port, standOpen: new Set(iplan ? doorsOnWayToCaves(iplan) : []) };
  const doors = buildCastleDoors(doorSets.active, { above: inMats(IM), under: inMats(IMu), outdoor: { wood: M.wood, iron: M.iron } }, GROUND, physics, doorOpts);
  scene.add(doors.object);
  // locked doors: their own system, never opened, with no interactables and no request() from NPCs
  const locked = buildDoors(doorSets.locked, inMats(IMu), physics, { ajar: 0, initial: 0 });
  scene.add(locked.object);
  // the fly camera's floor in the gate passage is the sill, not the terrain under the gatehouse
  rig.groundAt = (x, z) => { const d = gateSpecs.find((g) => inDoorway(g, x, z, 0, 0.2)); return d ? d.centre[1] : heightAt(x, z); };
  // the player blocks leaves by its body in walk mode; a flying camera by where it is
  physics.onFixed((dt) => doors.update(dt, rig.mode === 'walk' ? play.playerCentre() : camera.position));

  // HUD (src/ui): crosshair, use prompt, help, controls card and the review tools (` toggles them)
  const hud = createHud(browserHudDeps(), { onToolsOpen: () => mouse.release() });
  const interaction = createInteraction(camera, renderer.domElement, () => doors.interactables, {
    enabled: () => rig.mode !== 'fly',
    view: hud.promptView,
    // walls between you and a door stop the use ray; door leaves themselves do not
    occluder: (f, dir, max) => { const h = physics.raycast([f.x, f.y, f.z], [dir.x, dir.y, dir.z], max); return h && !h.tag?.startsWith('door:') ? h.dist : null; },
  });
  const setTime = (h: number) => { sky.setTime(h); (water as unknown as { sunDirection: { value: THREE.Vector3 } }).sunDirection.value.copy(sky.sunDir); bake.update(); winFlags.night.value = nightOf(sky.sunDir.y); };
  setTime(Number(params.get('time') ?? 15.5));
  const start = VIEWS.find((v) => v.name === (params.get('view') ?? (testRoom ? 'room-hall' : 'hero'))) ?? VIEWS[0];
  // per frame: which rooms are drawn (world/visibility.ts: the room graph, two steps from the camera's
  // space) and eye adaptation (render/exposure.ts); above the lowest wing's parapet the camera is in the
  // courtyard and outside at once
  const courtPoly = courtyard();
  const vis = createVisibility(camera, lit.groups, lit.plan, { scene, apertures: bake.apertures, ground: heightAt, court: (x, z) => pointInPoly(courtPoly, x, z), roofs: Math.min(...WINGS.map((w) => w.top)), frustum: () => cameraFrustum(camera) });
  // firelight (src/light): the furniture's fixtures, or a few wall torches without furniture; the
  // rig lights the nearest ones (whatever is drawn), and the interior materials take its light pool
  const groupOf = new Map<string, string>();
  for (const g of lit.groups) for (const id of g.rooms) groupOf.set(id, g.key);
  // (?test=room brings its own plan: its torches have no holders)
  // (streamed furniture brings its fires room by room, below)
  // with furniture, the rooms' fires stream in with it (below); the caves' stay, they have no furniture
  const fire: FireSources = furnMats ? { emitters: [...caveFire?.emitters ?? []], flames: [...caveFire?.flames ?? []], group: [...caveFire?.group ?? []], holders: [] } : torches && lit.plan === iplan ? torches : wallTorches(lit.plan, (id) => groupOf.get(id));
  // each room's fires light that room, every one of them, wherever the camera is (light/roomLight.ts):
  // one row per room in a table the interior shader sums per pixel; no point lights, so nothing is picked
  // by distance and nothing shines through a wall into the next room
  const fireTable = new FireTable(interiorLight.maxRooms), fireSeen = { version: -1 };
  const roomBox = (id: string) => { const row = bake.roomIndex.get(id), r = lit.plan.rooms.find((x) => x.id === id); return row === undefined || !r ? undefined : { row, box: r }; };
  // wall torches by their holder's room, the caves' lantern on its crate by the room it stands in
  for (const [id, es] of firesByRoom(lit.plan.rooms, fire.emitters, fire.holders)) { const r = roomBox(id); if (r) fireTable.set(r.row, roomFires(r.box, es)); }
  // the lantern the player carries in the caves (player/lantern.ts): it goes from room to room, so it is
  // no room's fire but the interior shader's one carried light (InteriorLight.carried)
  const caveRooms = new Set(lit.plan.rooms.filter((r) => r.zone === CAVE_ZONE).map((r) => r.id));
  const lookDir = new THREE.Vector3();
  let flames = linkFlames(fire.flames, fire.emitters), flameK = new Float32Array(flames.length);
  const fixedFlames = furnMats ? flames : []; // the caves' with furniture: streamed rooms' flames join them
  const sprites = makeFlameSprites(flames, furnMats ? 256 : 0);
  scene.add(sprites.group);
  let fireT = 0;
  // windows glow at night for rooms with firelight: streamed rooms count once they have come in
  const fireGroups = lit.groups.map((g) => fire.group.includes(g.key));
  // streamed furniture: rooms in from the workers, a few per frame, out again when no longer wanted.
  // The wanted rooms are the ones the room graph draws (world/visibility.ts), the camera's own first
  let furnStream: FurnitureStreamer | null = null, syncFires: (() => void) | null = null;
  const planRooms = new Set(lit.plan.rooms.map((r) => r.id));
  const wanted: WantedRooms = {
    wantedRooms() {
      const s = new Set<SpaceId>();
      for (const id of [...vis.state.from, ...vis.state.drawn]) if (planRooms.has(id)) s.add(id); // not 'courtyard' / 'outside'
      return s;
    },
  };
  if (furnMats && furnitureJobs && interior) {
    const [{ createFurnitureStreamer }, { createRoomSink }] = await Promise.all([import('./props/streamer'), import('./props/roomMeshes')]);
    const groupByKey = new Map(interior.groups.map((g) => [g.key, g]));
    const roomOrder = new Map(interior.plan.rooms.map((r, i) => [r.id, i]));
    const fires = createRoomFires(fireTable, roomBox, (fs: FlameInstance[]) => { flames = [...fixedFlames, ...fs]; flameK = new Float32Array(flames.length); sprites.set(flames); });
    syncFires = fires.sync;
    const fm = furnMats;
    furnStream = createFurnitureStreamer({
      jobs: furnitureJobs, now: () => performance.now(), onError: (id, e) => console.error(`furniture: room ${id} failed`, e),
      sink: createRoomSink({
        parentOf: (k) => groupByKey.get(k)?.object,
        matsFor: (k) => ((groupByKey.get(k)?.floor ?? 0) < 0 ? fm.under : fm.above),
        order: (id) => roomOrder.get(id) ?? 0,
        physics,
        fire: {
          set(room, es, fs) { fires.set(room, es, fs); const i = lit.groups.findIndex((g) => g.rooms.includes(room)); if (i >= 0) fireGroups[i] = true; },
          clear: (room) => fires.clear(room),
        },
      }),
    });
  }
  const updateFurniture = () => { if (!furnStream) return; furnStream.setWanted(wanted.wantedRooms()); furnStream.update(); syncFires?.(); };
  // furniture casts sun shadows only where they can land on screen (world/visibility.ts shadowInView):
  // a drawn room's furniture above, below or behind the view went into the near shadow map every frame
  // (77 shadow draw calls at the tower room with furniture, 58 of them furniture). Frustum culling of casters only: what is drawn, and
  // every shadow that can be seen, stay as they are.
  const frustum = new THREE.Frustum(), viewProj = new THREE.Matrix4(), sphere = new THREE.Sphere();
  const sunCasters = () => {
    if (!furnStream) return;
    camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const sun: [number, number, number] = [sky.sunDir.x, sky.sunDir.y, sky.sunDir.z];
    lit.groups.forEach((g, i) => {
      if (!vis.state.visible[i]) return;
      for (const o of g.object.children) {
        if (!o.name.startsWith('furniture:')) continue;
        for (const m of o.children as THREE.Mesh[]) {
          m.userData.sunCaster ??= m.castShadow; // what roomMeshes chose (flames, cloth and paint never cast)
          if (!m.userData.sunCaster) continue;
          // each room's part of the merged mesh (props/roomMeshes.ts), + 0.5 m for the shadow filter's blur
          const parts = (m.userData.spheres as THREE.Sphere[] | undefined) ?? (m.geometry.boundingSphere ? [m.geometry.boundingSphere] : []);
          m.castShadow = parts.some((s) => { sphere.copy(s).applyMatrix4(m.matrixWorld); return shadowInView(frustum.planes, [sphere.center.x, sphere.center.y, sphere.center.z], sphere.radius + 0.5, sun); });
        }
      }
    });
  };
  // door leaves follow the room graph: shown while either of their spaces is drawn
  // the portcullis follows the gate's spaces and its windlass the room it stands in (doors.setVisible)
  const portCells = port.flatMap((p) => [{ id: p.id, spaces: gateDoor!.spaces }, ...(p.winch?.room ? [{ id: p.id + ':winch', spaces: [p.winch.room, p.winch.room] }] : [])]);
  const doorCells = [...doorSets.active.map((d) => [doors, d] as const), ...doorSets.locked.map((d) => [locked, d] as const), ...portCells.map((d) => [doors, d] as const)];
  const doorShown = new Map<string, boolean>();
  const syncDoorVis = () => {
    for (const [sys, d] of doorCells) {
      const v = vis.isRoomVisible(d.spaces[0]) || vis.isRoomVisible(d.spaces[1]);
      if (doorShown.get(d.id) !== v) { doorShown.set(d.id, v); sys.setVisible(d.id, v); }
    }
  };
  const updateFire = (dt: number) => {
    syncDoorVis();
    fireT += dt;
    winFlags.set(vis.state.visible, fireGroups);
    // every room's fires flicker; nothing depends on where the camera is (tests/world.test.ts)
    fireTable.update(fireT); syncFireTextures(interiorLight, fireTable, fireSeen);
    if (caveRooms.size) {
      camera.getWorldDirection(lookDir);
      const at = lanternAt([camera.position.x, camera.position.y, camera.position.z], [lookDir.x, lookDir.y, lookDir.z]);
      const f = lanternFire(at); // its near field and reach: player/lantern.ts
      setCarried(interiorLight, lanternLit(vis.state.from, caveRooms) ? f : null, flicker(PROFILES.lantern, f.seed, fireT, f.amount).k);
    }
    sprites.update(flameBrightness(flames, fireT, 1, flameK), fireT);
  };
  const exposure = createAutoExposure({ target: renderer, reader: gpuLumaReader(renderer, scenePass.getTexture('output')), fixed: params.has('exposure') ? Number(params.get('exposure')) : null, shot: params.has('shot') });
  rig.go(start);
  // play starts walking at the spawn outside the gate; a ?view= bookmark, ?shot captures and the
  // test scenes keep their review camera (O orbits, F flies)
  const review = params.has('view') || params.has('shot') || !!test;
  if (!review || params.has('play')) { rig.setMode('walk'); rig.toSpawn(); }

  const ui = wireGameHud(hud, {
    rig, views: VIEWS, search: location.search, time: { get: () => sky.hours, set: setTime },
    walkFrom: { above: 30, view: 'gate', height: () => camera.position.y },
  });
  rig.onModeChange = () => ui.sync();
  const tick = (dt: number) => { physics.step(dt); syncDoorLight(); rig.update(dt); interaction.update(); ui.sync(); };
  input.onPress = (code) => {
    footsteps.unlock();
    if (code === 'KeyP') rig.setMode('walk');
    else if (code === 'KeyF') rig.setMode('fly');
    else if (code === 'KeyO') rig.setMode('orbit');
    else if (code === 'KeyI') statsView.toggle();
    else if (code === 'KeyM') { footsteps.enabled = !footsteps.enabled; hud.toast(footsteps.enabled ? 'Footsteps on' : 'Footsteps off'); }
  };
  renderer.domElement.addEventListener('pointerdown', () => footsteps.unlock());

  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

  await say('Lighting the halls…');
  // streamed furniture is not in the scene yet: compile its materials (and the flames') on stand-ins
  // now, so the first room that comes in does not stall a frame on shader compiles
  const warm = new THREE.Group();
  if (furnMats) {
    const g = new THREE.BufferGeometry();
    for (const [n, k] of [['position', 3], ['normal', 3], ['uv', 2], ['color', 3], ['interiorRoom', 1]] as const) g.setAttribute(n, new THREE.BufferAttribute(new Float32Array(3 * k), k));
    for (const set of [furnMats.above, furnMats.under]) for (const m of Object.values(set)) { const o = new THREE.Mesh(g, m); o.frustumCulled = false; warm.add(o); }
    for (const c of sprites.group.children) c.visible = true;
  }
  scene.add(warm);
  // what the first frame adds to the scene (the stones, tree levels and grass near the camera) is there before
  // the compile; the rooms are all still shown, so their shaders are built too
  rig.update(0); // the camera where the first frame puts it (walk mode: on the player at the spawn)
  while (stones.update(camera.position, 30)) await breathe(); // ~30 ms of stone geometry per task
  await breathe();
  veg?.update(camera);
  await breathe();
  // shaders in pieces (render/precompile.ts): each pass compiles for its own target, then two warm-up
  // frames build what that cannot reach, first without the water (shadow maps, post passes), then with
  // it (its reflection of the scene), drawn whether or not it can be seen from here (vis hides it then)
  const frameState = () => { stones.update(camera.position); veg?.update(camera); vis.update(); updateFire(1 / 60); exposure.update(1 / 60, vis.state); };
  const pre = prePass;
  const nestedRenders = { rendered: 0, skipped: 0 };
  let deferred = null as DeferredPipelines | null;
  await precompile({
    passes: [...(pre ? [() => { performance.mark('compile: AO pre-pass'); return pre.compileAsync(renderer); }] : []), () => { performance.mark('compile: scene pass'); return scenePass.compileAsync(renderer); }],
    warm: [() => { performance.mark('compile: warm-up 1'); water.visible = false; frameState(); pipeline.render(); water.visible = true; }, () => { performance.mark('compile: warm-up 2'); frameState(); water.visible = true; pipeline.render(); exposure.measure(); }],
    breathe,
    // the AO pre-pass and the water's reflection render the whole scene once per compile item otherwise
    quiet: () => renderOnce(renderer, nestedRenders),
    // the pipelines those renders make, compiled off the GPU process's main thread (the tunnel keeps drawing)
    defer: () => (deferred = asyncPipelines(renderer.backend as unknown as PipelineBackendLike)),
  });
  console.info(`precompile: nested renders ${nestedRenders.rendered}, skipped ${nestedRenders.skipped}; render pipelines made async ${deferred?.count ?? 0}`);
  scene.remove(warm);
  warm.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  sprites.set(flames);

  const info = renderer.info;
  const hooks = installHooks({
    renderer, camera, rig, setTime, getTime: () => sky.hours, tick,
    // captures wait for the furniture of every room they show (settle), before the frame's counters reset
    renderNow: async () => { if (furnStream) { vis.update(); furnStream.setWanted(wanted.wantedRooms()); await furnStream.settle(); syncFires?.(); } info.reset(); stones.update(camera.position, Infinity); veg?.update(camera); vis.update(); sunCasters(); updateFire(1 / 60); exposure.update(1 / 60, vis.state); pipeline.render(); },
    physics, player, input: scripted, course: course?.info ?? null, interior: null, // set below
    probes: { island: ISLAND, boundary: play.boundary, outer: outerPoly(), court: courtyard(), gate: { ...gatehouseFrame(), project: GATEHOUSE.project }, bridge: bridge ? bridgeInfo(bridge.walkable, bridge.d) : null, spawn: spawnPoint(), gateDoors: gateSpecs },
    use: () => interaction.use(),
    doors, hud,
    stats: () => ({
      interior: interior ? { triangles: interior.triangles, groups: interior.groups.length, meshes: interior.groups.reduce((s, g) => s + g.object.children.length, 0), rooms: interior.plan.rooms.length, doors: interior.plan.doors.length, stairs: interior.plan.stairs.length, ...interior.stats } : null,
      furniture: furnStream ? furnStream.stats() : null,
      castleTriangles: castle.userData.triangles, bridgeTriangles, revetmentTriangles, stones: { ...stones.stats(), layoutMs }, terrain: terrain.userData, vegetation: veg?.stats(), windows: lights.length,
      doorTriangles: doors.triangles, doors: { ...doors.state(), ...locked.state() }, target: interaction.target(), sounds: audio.log.slice(-6),
      drawCalls: info.render.drawCalls, frameTriangles: info.render.triangles, textureMs: Math.round(tTex),
      light: {
        room: vis.roomId, inside: vis.state.inside, deep: vis.state.deep, underground: vis.state.underground,
        groupsShown: vis.state.visible.filter(Boolean).length, groups: lit.groups.length, meshesShown: lit.groups.reduce((s, g, i) => s + (vis.state.visible[i] ? g.object.children.length : 0), 0),
        exposure: Math.round(exposure.state.exposure * 1000) / 1000, meanLog2: Math.round(exposure.state.meanLog2 * 100) / 100,
        bakeMs: Math.round(bake.ms * 10) / 10, bvhMs: Math.round(bvhMs * 10) / 10, apertures: bake.apertures.length,
      },
      windowsSeeThrough: winTagged,
      fire: { ...fireTable.stats(), flames: flames.length, source: furnStream ? 'furniture' : 'wall torches' },
      physics: { ...physics.stats(), ...play.timings },
    }),
  }, window as unknown as HookWindow, systemClock);

  // the doors module reports leaf positions here: __game.interiorLight.setDoorOpen(id, 0..1)
  (hooks as Record<string, unknown>).interiorLight = { setDoorOpen: bake.setDoorOpen, roomLight: bake.roomLight, knobs: interiorLight, exposure: exposure.state, visibility: vis };
  (window as unknown as { __game: Record<string, unknown> }).__game.interior = interior ? { plan: interior.plan, groups: interior.groups, collision: interior.collision } : null;
  (window as unknown as { __game: Record<string, unknown> }).__game.furniture = furnStream ? { stats: () => furnStream!.stats(), settle: () => furnStream!.settle(), isLoaded: (id: SpaceId) => furnStream!.isLoaded(id) } : null;

  // rendering stats (I, or ?stats) and the benchmark (?bench, or __game.bench())
  const frameStats = new FrameStats(240);
  const statsView = createStatsOverlay(document, document.body, params.has('stats') || params.has('bench'));
  const backendName = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
  const renderInfo = () => { const s = renderer.getDrawingBufferSize(new THREE.Vector2()); return { width: s.x, height: s.y, pixelRatio: renderer.getPixelRatio(), backend: backendName }; };
  const bench = async (o: { warmMs?: number; measureMs?: number; steps?: string[] } = {}): Promise<{ rows: BenchRow[]; table: string; render: ReturnType<typeof renderInfo> }> => {
    statsView.setVisible(true); statsView.report(null);
    const steps = o.steps ? BENCH_STEPS.filter((s) => o.steps!.includes(s.name)) : BENCH_STEPS;
    const rows = await runBench(steps, {
      go: (from) => {
        if (from === 'spawn') { rig.setMode('walk'); rig.toSpawn(); return true; }
        const v = VIEWS.find((x) => x.name === from); if (!v) return false;
        rig.go(v); return true;
      },
      hold: (keys) => scripted.hold(keys),
      reset: () => frameStats.clear(),
      summary: () => frameStats.summary(),
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      onRow: (r, i, n) => statsView.note(`bench ${i + 1}/${n}: ${r.name} ${r.fps} fps`),
    }, o);
    const table = benchTable(rows);
    statsView.note(null); statsView.report(table);
    console.info('bench\n' + table);
    return { rows, table, render: renderInfo() };
  };
  (hooks as Record<string, unknown>).bench = bench;
  // for profiling from the console or Playwright: per-pass GPU times live in the backend's timestamp pools
  (hooks as Record<string, unknown>).render = { renderer, scene, camera, pipeline };

  if (params.has('shot')) {
    // captures render on demand through __game.step(), so a slow software renderer is not flooded
    info.autoReset = false; // renderNow resets it, so state() reports the last captured frame
    screen.dispose();
    hooks.ready = true;
    return;
  }
  let last = performance.now(), frames = 0, acc = 0;
  // the render resolution follows the GPU's load unless ?scale= fixes it (?dynres=0 keeps the screen's)
  const dynres = useDynres ? new ResolutionGovernor({ max: maxRatio, start: renderer.getPixelRatio() }) : null;
  // GPU time from WebGPU timestamp queries only (the WebGL2 timer-query path reads nonsense here)
  const gpuTimed = backendName === 'webgpu' && (renderer.backend as unknown as { trackTimestamp?: boolean }).trackTimestamp === true;
  const gpuPool = () => (renderer.backend as unknown as { timestampQueryPool: { render: { timestamps: Map<string, number> } } }).timestampQueryPool.render;
  const adapterVendor = (renderer.backend as unknown as { device?: { adapterInfo?: { vendor?: string } } }).device?.adapterInfo?.vendor;
  const tiledGpu = adapterVendor ? adapterVendor === 'apple' : /Mac/.test(navigator.userAgent); // see gpuFrameTimes
  let gpuPending = false;
  renderer.setAnimationLoop(() => {
    const now = performance.now(), raw = (now - last) / 1000, dt = Math.min(0.05, raw); last = now;
    frames++; acc += raw;
    if (acc > 0.25) {
      ui.setFps(frames / acc);
      const sum = frameStats.summary();
      statsView.update(sum, renderInfo());
      frames = 0; acc = 0;
      // dynamic resolution: step the pixel ratio by the GPU time (frame time without timestamps)
      if (dynres && sum.frames >= 30) {
        // without GPU timestamps the frame time is tied to vsync: only a missed 60 Hz frame says anything
        const r = dynres.update(sum.gpuMs ?? (sum.p50 > 17.5 ? sum.p50 : 0), now);
        if (r !== renderer.getPixelRatio()) { renderer.setPixelRatio(r); frameStats.clear(); }
      }
    }
    tick(dt);
    stones.update(camera.position);
    veg?.update(camera);
    vis.update();
    updateFurniture();
    sunCasters();
    updateFire(dt);
    exposure.update(dt, vis.state);
    pipeline.render();
    exposure.measure();
    frameStats.push({ frameMs: raw * 1000, cpuMs: performance.now() - now, drawCalls: info.render.drawCalls, triangles: info.render.triangles });
    // GPU time per frame from the timestamp pool's per-pass durations (one resolve in flight at a time)
    if (gpuTimed && !gpuPending) {
      gpuPending = true;
      void renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER).then(() => {
        for (const ms of gpuFrameTimes(gpuPool().timestamps, tiledGpu)) frameStats.pushGpu(ms);
        gpuPending = false;
      });
    }
  });
  // two frames, then reveal
  performance.mark('first frames');
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  hooks.ready = true;
  await screen.finish();
  if (params.has('bench')) (hooks as Record<string, unknown>).benchResult = await bench();
}

/** Boot the castle behind the loading screen (called by src/loading/entry.ts). */
export function boot(loading: LoadingScreen) {
  screen = loading;
  return main().catch((e) => { console.error(e); screen.dispose(); showBootError(document, e, () => location.reload()); });
}
