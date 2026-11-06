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
import { bridgePlan, buildBridge, type BridgePlan } from './castle/bridge';
import { revetmentPlan, buildRevetment } from './castle/revetment';
import { rimMask, rimTurf, rimTurfMesh } from './castle/turf';
import { buildTerrain, prepareTerrain, ISLAND, MOAT_OUTER, heightAt, footDist, defaultTerrain } from './world/terrain';
import { rngFor } from './core/rng';
import { makeSky } from './world/sky';
import { makeWater } from './world/water';
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
import { makeInteriorMaterials, tagGroups, bakeInteriorLight, createInteriorLight, bvhOccluder, sunStateOf, buildShadowSkins } from './render/interiorLight';
import { createAutoExposure, gpuLumaReader } from './render/exposure';
import { createVisibility, courtView } from './world/visibility';
import { fromFurniture, wallTorches } from './render/interiorFire';
import { createWindowFlags, makeWindowGlass, triFrames, groupIndexOfRooms, tagWindowGroups, nightOf } from './render/windowGlass';
import { LightRig } from './light/rig';
import { threeLightFactory, makeFlameSprites } from './light/three';
import { linkFlames, flameBrightness } from './light/flames';
import { buildRoomTest } from './debug/roomtest';
import type { InteriorGroup, InteriorPlan, SpaceId } from './castle/interior/types';
import type { WindowInput } from './render/interiorMath';
import { buildCourse, type CourseInfo } from './debug/testcourse';
import { KeyboardInput, ScriptedInput, MergedInput } from './player/input';
import { MouseLook } from './camera/mouseLook';
import { Footsteps, browserAudio } from './player/footsteps';
import { systemClock } from './core/clock';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { setupPlay, playDoors } from './player/setup';
import { buildDoors, joinDoors, inDoorway } from './castle/interior/doors';
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
import { ResolutionGovernor, startRatio } from './render/resolution';
import { runBench, benchTable, BENCH_STEPS, type BenchRow } from './debug/bench';

const params = new URLSearchParams(location.search);
/** Doors that never open: the sally-port grille on the far bank (the moat tunnel is a dead end). */
// Loading screen (src/loading, started by entry.ts): each boot step lights more of the tunnel,
// in proportion to how long the step took on this device last time (src/loading/timeline.ts).
let screen: LoadingScreen;
const say = (s: string) => screen.step(s);
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
    bridge = bridgePlan({ island: ISLAND, moatOuter: MOAT_OUTER, gate: gatehouseFrame(), groundAt: heightAt, rng: rngFor('bridge') });
    bridgeTriangles = buildBridge(builder, bridge, rngFor('bridge-stones'));
    revetment = revetmentPlan({ island: ISLAND, groundAt: heightAt, rng: rngFor('revetment'), exclude: (x, z) => pointInPoly(bridge!.footprint, x, z) });
    revetmentTriangles = buildRevetment(builder, revetment, rngFor('revetment-stones'));
  }
  const mats = { old: M.old, new: M.new, trim: M.trim, slate: M.slate, lead: M.lead, wood: M.wood, iron: M.iron, void: M.void, glass: M.glass, pave: M.pave };
  // interiors: rooms, doorways, embrasures, stairs, cellars and tunnels; carves the exterior bins in place
  // wall torches (render/interiorFire.ts) when there is no furniture: placed on the plan, their holders
  // built by the shell into each room's group, their flames and lights fed to the light rig below
  const iplan = params.get('interior') === '0' || test === 'stairs' ? null : planInterior();
  const torches = iplan && params.get('furniture') !== '1' ? wallTorches(iplan, (id) => groupKey(iplan.rooms.find((r) => r.id === id)!)) : null;
  const interior = iplan ? buildInterior(mats, builder, { heightAt, plan: iplan, torches: torches?.holders }) : null;
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
  }
  const tStones = performance.now();
  const stoneSet = new StoneSet(builder.stoneFaces, builder.stoneExcl); // every stone of the castle (D.1), queryable with stonesNear()
  const layoutMs = Math.round(performance.now() - tStones);
  // real stones on silhouettes (parapets, corners, buttresses); flat walls get their depth from parallax.
  // ?stones=all: every stone near the camera, as before (A/B)
  const stones = new StoneField(stoneSet, { old: M.old, new: M.new }, params.get('stones') === 'all' ? { ...LOD, plain: Infinity } : LOD);
  scene.add(stones.group);
  stones.group.visible = params.get('stones') !== '0'; // ?stones=0: textured walls only, for A/B
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
  const terrain = buildTerrain(M.terrain);
  scene.add(terrain);
  if (revetment) {
    // turf over the rim, with the same noise as the terrain's ground weights (world/terrain.ts 'terrain-b')
    const rimNoise = defaultTerrain().deps.noise2('terrain-b');
    scene.add(rimTurfMesh(rimTurf(revetment, heightAt, rimMask({ footDist, noise: rimNoise, gate: gatehouseFrame() })), M.terrain));
  }
  const water = makeWater(sky.sunDir);
  scene.add(water);

  // interior light (render/interiorLight.ts): the shell's meshes switch to the sun-only interior
  // materials; the test cell (?test=room) brings its own hall and chamber
  const interiorLight = createInteriorLight();
  const IM = makeInteriorMaterials(M, sky.sun, interiorLight);
  const IMu = makeInteriorMaterials(M, null, interiorLight); // cellars and tunnels: no direct sun
  const keys = ['old', 'new', 'trim', 'wood', 'iron', 'glass'] as const;
  const swap = new Map<THREE.Material, THREE.Material>(keys.map((k) => [M[k], IM[k]]));
  const swapUnder = new Map<THREE.Material, THREE.Material>(keys.map((k) => [M[k], IMu[k]]));
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
  const tB = performance.now();
  const occluder = bvhOccluder([...shells, ...lit.groups.map((g) => g.object)]);
  const bvhMs = performance.now() - tB;
  const bake = bakeInteriorLight(lit.groups, occluder, { plan: lit.plan, windows: lit.windows, sun: sunStateOf(sky.sun), light: interiorLight });
  if (lit.plan.rooms.length) scene.add(buildShadowSkins(lit.plan, bake.apertures));
  console.info(`interior light: ${bake.rooms} rooms, ${bake.apertures.length} apertures, ${bake.triangles} tris tagged, bake ${bake.ms.toFixed(1)} ms, BVH ${bvhMs.toFixed(1)} ms over ${occluder.triangles} tris`);
  // leaf doors and the portcullis pass daylight on as they open: re-solve when one moves
  const doorLit: Record<string, number> = {};
  const syncDoorLight = () => {
    for (const [id, o] of Object.entries(doors.state())) {
      const was = doorLit[id];
      if (was === undefined || Math.abs(was - o) > 0.05 || (o !== was && (o === 0 || o === 1))) { doorLit[id] = o; bake.setDoorOpen(id, o); }
    }
  };
  // props join their groups after the bake (they don't shadow the sun-visibility rays): they take the
  // interior clones of their materials and are room-tagged like the shell, so they get the room's light
  if (furniture && interior) {
    const tf = performance.now();
    const rooms = interior.plan.rooms.slice(0, interiorLight.maxRooms);
    const index = new Map(rooms.map((r, i) => [r.id, i] as [SpaceId, number]));
    const tagged: InteriorGroup[] = [];
    for (const g of interior.groups) {
      const o = furniture.objects.get(g.key);
      if (!o) continue;
      const set = g.floor < 0 ? IMu : IM;
      o.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh && (m.material as THREE.MeshStandardNodeMaterial).isMeshStandardNodeMaterial) m.material = set.adopt(m.material as THREE.MeshStandardNodeMaterial); });
      tagged.push({ ...g, object: o });
      g.object.add(o);
    }
    tagGroups(tagged, rooms, index, 4.5);
    console.info(`furniture: interior materials + room tags in ${(performance.now() - tf).toFixed(0)} ms`);
  }
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
  if (params.get('ao') !== '0') {
    const pre = pass(scene, camera, { samples: 0 });
    pre.setMRT(mrt({ output: normalView }));
    // the AO is computed at half resolution, so its normal/depth pre-pass needs no more (it was a full
    // second drawing of the scene at full size: ~7 ms of a 20 ms frame on an M4 at retina 2×)
    pre.setResolutionScale(0.5);
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
  await say('Laying the floors…');
  const input = new KeyboardInput(window);
  const scripted = new ScriptedInput();
  const footsteps = new Footsteps(browserAudio(window));
  const play = await setupPlay({
    castle, terrain, bridge: bridge ? bridgeInfo(bridge.walkable, bridge.d) : null, interior: interior ? { collision: interior.collision } : null, furniture: furniture ? [...furniture.collision.values()] : [], input: new MergedInput([input, scripted]), view: camera, footsteps, clock: systemClock,
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
  // and tunnels have no sun), and so does the portcullis, for its windlass room
  const under = (d: { centre: number[] }) => d.centre[1] < GROUND - 1;
  // doors to the courtyard or outside are seen in daylight: they take the exterior wood and iron, which the
  // sun and sky light (an interior material left them flat black from the sunlit courtyard)
  const outdoor = (d: { spaces: string[] }) => d.spaces.includes('courtyard') || d.spaces.includes('outside');
  const inMats = (set: typeof IM) => ({ wood: set.adopt(M.wood), iron: set.adopt(M.iron) });
  const doorOpts = { sound: audio, characters: play.characters, initial: params.has('doors') ? Number(params.get('doors')) : undefined };
  // cellar and tunnel leaves never see the sun: they cast no sun shadow, as the interior shell does not,
  // so the near shadow map does not draw them
  const noSun = <S extends { object: THREE.Object3D }>(s: S): S => { s.object.traverse((o) => { o.castShadow = false; }); return s; };
  const doors = joinDoors([
    buildDoors(doorSets.active.filter((d) => !under(d) && !outdoor(d)), inMats(IM), physics, { ...doorOpts, portcullis: port }),
    noSun(buildDoors(doorSets.active.filter((d) => under(d) && !outdoor(d)), inMats(IMu), physics, doorOpts)),
    buildDoors(doorSets.active.filter(outdoor), { wood: M.wood, iron: M.iron }, physics, doorOpts),
  ]);
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
  // per frame: interior cells on/off (world/visibility.ts) and eye adaptation (render/exposure.ts)
  // a courtyard doorway is seen from the courtyard, or from above the lowest wing's parapet
  const vis = createVisibility(camera, lit.groups, lit.plan, { scene, apertures: bake.apertures, ground: heightAt, inCourt: courtView(courtyard(), Math.min(...WINGS.map((w) => w.top))) });
  // firelight (src/light): the furniture's fixtures, or a few wall torches without furniture; the
  // rig lights the nearest ones in shown groups, and the interior materials take its light pool
  const groupOf = new Map<string, string>(), groupIx = new Map(lit.groups.map((g, i) => [g.key, i]));
  for (const g of lit.groups) for (const id of g.rooms) groupOf.set(id, g.key);
  // (?test=room brings its own plan: its torches have no holders)
  const fire = furniture ? fromFurniture(furniture.emitters, furniture.flames) : torches && lit.plan === iplan ? torches : wallTorches(lit.plan, (id) => groupOf.get(id));
  const fireLights = threeLightFactory(scene);
  // no shadow-casting fire lights: one cube shadow redraws everything near it six times (+700 calls)
  const fireRig = new LightRig(fireLights, { shadows: 0, lights: 8 });
  fireRig.setEmitters(fire.emitters);
  IM.setDynamicLights(fireLights.lights); IMu.setDynamicLights(fireLights.lights);
  const flames = linkFlames(fire.flames, fire.emitters), flameK = new Float32Array(flames.length);
  const sprites = makeFlameSprites(flames);
  scene.add(sprites.group);
  const fireShown = (id: number) => vis.state.visible[groupIx.get(fire.group[id]) ?? -1] ?? false;
  let fireT = 0;
  const fireGroups = lit.groups.map((g) => fire.group.includes(g.key));
  // door leaves follow their rooms: shown while either side is shown (outside counts when not deep)
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
    fireRig.update(fireT, dt, [camera.position.x, camera.position.y, camera.position.z], fireShown);
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
  stones.update(camera.position, Infinity);
  await renderer.compileAsync(scene, camera);

  const info = renderer.info;
  const hooks = installHooks({
    renderer, camera, rig, setTime, getTime: () => sky.hours, tick,
    renderNow: async () => { info.reset(); stones.update(camera.position, Infinity); veg?.update(camera); vis.update(); updateFire(1 / 60); exposure.update(1 / 60, vis.state); pipeline.render(); },
    physics, player, input: scripted, course: course?.info ?? null, interior: null, // set below
    probes: { island: ISLAND, boundary: play.boundary, outer: outerPoly(), court: courtyard(), gate: { ...gatehouseFrame(), project: GATEHOUSE.project }, bridge: bridge ? bridgeInfo(bridge.walkable, bridge.d) : null, spawn: spawnPoint(), gateDoors: gateSpecs },
    use: () => interaction.use(),
    doors, hud,
    stats: () => ({
      interior: interior ? { triangles: interior.triangles, groups: interior.groups.length, meshes: interior.groups.reduce((s, g) => s + g.object.children.length, 0), rooms: interior.plan.rooms.length, doors: interior.plan.doors.length, stairs: interior.plan.stairs.length, ...interior.stats } : null,
      furniture: furniture ? { props: furniture.props, triangles: furniture.triangles, groups: furniture.objects.size, emitters: [...furniture.emitters.values()].reduce((s, e) => s + e.length, 0) } : null,
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
      fire: { ...fireRig.stats(), flames: flames.length, source: furniture ? 'furniture' : 'wall torches' },
      physics: { ...physics.stats(), ...play.timings },
    }),
  }, window as unknown as HookWindow, systemClock);

  // the doors module reports leaf positions here: __game.interiorLight.setDoorOpen(id, 0..1)
  (hooks as Record<string, unknown>).interiorLight = { setDoorOpen: bake.setDoorOpen, roomLight: bake.roomLight, knobs: interiorLight, exposure: exposure.state, visibility: vis };
  (window as unknown as { __game: Record<string, unknown> }).__game.interior = interior ? { plan: interior.plan, groups: interior.groups, collision: interior.collision } : null;
  (window as unknown as { __game: Record<string, unknown> }).__game.furniture = furniture ? { dressing: furniture.dressing, emitters: furniture.emitters, flames: furniture.flames, collision: furniture.collision } : null;

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
