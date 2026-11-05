// ?test=doors: a stone wall with one opening of every head and kind (round, pointed, segmental and
// flat plank doors, a postern, a gate closed by its portcullis, an iron grille), each cut with a real
// rebate. For captures (?doors=0|0.5|1 sets the starting openness) and scripts/doortest.mjs.
import * as THREE from 'three/webgpu';
import { pass, mrt, normalView, builtinAOContext, screenUV } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { makeMaterials } from '../render/materials';
import { Builder, wallFrame, at, type Frame } from '../castle/builder';
import { makeSky } from '../world/sky';
import { CameraRig, VIEWS, type View } from '../camera/controls';
import { installHooks } from '../debug/hooks';
import { castleCentre } from '../castle/layout';
import { GROUND } from '../castle/spec';
import { buildDoors, inDoorway } from '../castle/interior/doors';
import { portcullisFor } from '../castle/interior/portcullis';
import { openingOutline } from '../castle/interior/doorGeom';
import type { DoorSpec } from '../castle/interior/types';
import { createInteraction } from '../game/interact';
import { DoorAudio } from '../game/doorAudio';
import { createHud, browserHudDeps } from '../ui/hud';
import { wireGameHud } from '../ui/gameHud';
import type { V2 } from '../core/math2d';
import type { LoadingScreen } from '../loading/tunnel';

const T = 1.4, WALL_H = 8.2, LAP = 0.06;
type Def = Pick<DoorSpec, 'id' | 'kind' | 'head' | 'width' | 'height' | 'hinge' | 'swingInto' | 'rebate'> & { leaf?: boolean };
const DEFS: Def[] = [
  { id: 't-round', kind: 'plank', head: 'round', width: 1.1, height: 2.0, hinge: 'left', swingInto: 1, rebate: 0.16 },
  { id: 't-pointed', kind: 'plank', head: 'pointed', width: 1.2, height: 2.05, hinge: 'right', swingInto: 0, rebate: 0.16 },
  { id: 't-segmental', kind: 'plank', head: 'segmental', width: 1.3, height: 2.1, hinge: 'left', swingInto: 1, rebate: 0.18 },
  { id: 't-flat', kind: 'plank', head: 'flat', width: 0.95, height: 2.0, hinge: 'right', swingInto: 1, rebate: 0.15 },
  { id: 't-postern', kind: 'postern', head: 'round', width: 0.85, height: 1.55, hinge: 'left', swingInto: 0, rebate: 0.2 },
  { id: 't-gate', kind: 'gate', head: 'pointed', width: 3.4, height: 3.2, hinge: 'left', swingInto: 1, rebate: 0.45, leaf: false },
  { id: 't-grille', kind: 'grille', head: 'round', width: 1.2, height: 2.1, hinge: 'right', swingInto: 1, rebate: 0.12 },
];

export function doorTestSpecs(): { doors: DoorSpec[]; x0: number; x1: number; z: number } {
  const c = castleCentre(), gap = 2.1;
  const total = DEFS.reduce((s, d) => s + d.width, 0) + gap * (DEFS.length - 1);
  let x = c[0] - total / 2;
  const doors = DEFS.map((d) => {
    const cx = x + d.width / 2; x += d.width + gap;
    return { leaf: true, ...d, spaces: ['north', 'south'], centre: [cx, GROUND, c[1]], along: [1, 0], normal: [0, 1], wall: T } as DoorSpec;
  });
  return { doors, x0: c[0] - total / 2 - 3, x1: c[0] + total / 2 + 3, z: c[1] };
}

/** Wall with rebated openings: the swing face is cut LAP wider, then a stop, then the clear opening. */
function buildWall(B: Builder, doors: DoorSpec[], X0: number, X1: number, zc: number) {
  const faces = [{ z: zc - T / 2, out: [0, -1] as V2, side: 0, mat: 'old' as const }, { z: zc + T / 2, out: [0, 1] as V2, side: 1, mat: 'new' as const }];
  // door s runs along its right hand, which is −x for a door facing +z
  const outline = (d: DoorSpec, lap: number) => openingOutline(d.head, d.width, d.height, 12, lap).map(([s, y]) => [d.centre[0] - X0 - s, y] as V2);
  for (const f of faces) {
    const fr = wallFrame([X0, f.z], [X1, f.z], f.out);
    const holes = doors.map((d) => outline(d, d.swingInto === f.side ? LAP : 0).map(([s, y]) => [s, y + GROUND] as V2));
    B.planar(f.mat, fr, [[0, GROUND], [X1 - X0, GROUND], [X1 - X0, GROUND + WALL_H], [0, GROUND + WALL_H]], 0, holes);
  }
  for (const d of doors) {
    const swing = faces[d.swingInto], fr = wallFrame([X0, swing.z], [X1, swing.z], swing.out);
    const shifted = (k: number): Frame => ({ ...fr, o: at(fr, 0, 0, -k) });
    const wide = outline(d, LAP).map(([s, y]) => [s, y + GROUND] as V2), clear = outline(d, 0).map(([s, y]) => [s, y + GROUND] as V2);
    B.openingInsides(fr, { pts: wide, depth: d.rebate, fill: 'none', reveal: 'trim' });
    B.planar('trim', shifted(d.rebate), wide, 0, [clear]);
    B.openingInsides(shifted(d.rebate), { pts: clear, depth: T - d.rebate, fill: 'none', reveal: 'trim' });
  }
  B.cap('trim', [[X0, zc - T / 2], [X1, zc - T / 2], [X1, zc + T / 2], [X0, zc + T / 2]], GROUND + WALL_H, true);
  for (const x of [X0, X1]) B.wall('old', [x, zc - T / 2], [x, zc + T / 2], [x === X0 ? -1 : 1, 0], GROUND, GROUND + WALL_H);
  // flagged floor both sides, thresholds through the openings
  B.prism('trim', [[X0 - 6, zc - 10], [X1 + 6, zc - 10], [X1 + 6, zc + 10], [X0 - 6, zc + 10]], GROUND - 0.4, GROUND, { top: 'trim' });
}

export async function runDoorTest(screen: LoadingScreen) {
  const params = new URLSearchParams(location.search);
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') });
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = Number(params.get('exposure') ?? 0.72);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 30000);
  void screen.progress(0.3, 'Cutting the oak…');
  const M = await makeMaterials();

  const { doors: specs, x0, x1, z } = doorTestSpecs();
  const B = new Builder();
  buildWall(B, specs, x0, x1, z);
  const wall = B.build({ old: M.old, new: M.new, trim: M.trim, slate: M.slate, lead: M.lead, wood: M.wood, iron: M.iron, void: M.void, glass: M.glass });
  scene.add(wall);

  // the gate has no leaves: a portcullis (no windlass here, there is no room above)
  const port = portcullisFor(specs.find((d) => d.kind === 'gate')!, null);
  const audio = new DoorAudio(camera);
  const init = params.get('doors');
  const doors = buildDoors(specs, M, undefined, { ajar: 0, initial: init === null ? undefined : Number(init), portcullis: [port], sound: audio });
  if (params.get('port') === 'down') doors.setOpen(port.id, false, true);
  scene.add(doors.object);

  const sky = makeSky(renderer, scene);
  sky.setTime(Number(params.get('time') ?? 15.5));
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

  // bookmarks for this scene replace the castle ones
  const G = GROUND, dx = (id: string) => specs.find((d) => d.id === id)!.centre[0];
  const v = (name: string, label: string, pos: [number, number, number], target: [number, number, number]): View => ({ name, label, mode: 'fly', pos, target });
  const mid12 = (dx('t-round') + dx('t-pointed')) / 2;
  const views: View[] = [
    v('door-all', 'All doors', [(x0 + x1) / 2, G + 3.4, z + 15], [(x0 + x1) / 2, G + 2, z]),
    v('door-swing', 'Ledged side', [mid12 + 0.6, G + 1.7, z + 4.6], [mid12, G + 1.3, z]),
    v('door-show', 'Show side', [dx('t-pointed') - 0.4, G + 1.6, z - 4.6], [dx('t-pointed') + 0.4, G + 1.3, z]),
    v('door-gate', 'Gate inside', [dx('t-gate') + 1.6, G + 1.8, z + 6.5], [dx('t-gate'), G + 2.2, z]),
    v('door-gate-out', 'Gate outside', [dx('t-gate') - 1.2, G + 1.7, z - 7], [dx('t-gate'), G + 2.4, z]),
    v('door-grille', 'Postern & grille', [(dx('t-postern') + dx('t-grille')) / 2, G + 2.0, z + 9], [(dx('t-postern') + dx('t-grille')) / 2, G + 1.4, z]),
    v('door-close', 'Close-up', [dx('t-segmental') + 0.9, G + 1.5, z + 2.1], [dx('t-segmental') - 0.1, G + 1.0, z + 0.4]),
    v('door-use', 'At the door', [dx('t-round'), G + 1.6, z + T / 2 + 1.3], [dx('t-round'), G + 1.2, z]),
  ];
  VIEWS.splice(0, VIEWS.length, ...views);

  const rig = new CameraRig(camera, renderer.domElement);
  rig.groundAt = () => GROUND; // flat flagged floor, no terrain here
  const feet = new THREE.Vector3();
  rig.canWalk = (x, zz) => {
    feet.set(x, camera.position.y - 0.8, zz);
    if (doors.blocksPlayer(feet)) return false;
    const inWall = Math.abs(zz - z) < T / 2 + 0.3 && x > x0 - 0.3 && x < x1 + 0.3;
    return (!inWall || specs.some((d) => inDoorway(d, x, zz, 0.3, 0.3))) && Math.abs(zz - z) < 9.5 && x > x0 - 5 && x < x1 + 5;
  };
  rig.go(views.find((w) => w.name === (params.get('view') ?? 'door-all')) ?? views[0]);
  // the castle page's HUD with walk/fly and these bookmarks
  const hud = createHud(browserHudDeps(), { onToolsOpen: () => rig.look.release() });
  const interaction = createInteraction(camera, renderer.domElement, () => doors.interactables, { enabled: () => rig.mode !== 'fly', view: hud.promptView });
  const ui = wireGameHud(hud, { rig, views, modes: ['walk', 'fly'], search: location.search, title: 'Door test' });
  rig.onLockChange = ui.sync;
  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
  const info = renderer.info;
  await renderer.compileAsync(scene, camera);
  const hooks = installHooks({
    renderer, camera, rig, setTime: (h) => sky.setTime(h), getTime: () => sky.hours,
    renderNow: async () => { pipeline.render(); },
    tick: (dt) => { doors.update(dt, camera.position); interaction.update(); ui.sync(); },
    use: () => interaction.use(),
    doors, hud,
    stats: () => ({ scene: 'test=doors', drawCalls: info.render.drawCalls, frameTriangles: info.render.triangles, wallTriangles: wall.userData.triangles, doorTriangles: doors.triangles, doors: doors.state(), target: interaction.target(), sounds: audio.log.slice(-6) }),
  });
  if (params.has('shot')) { screen.dispose(); hooks.ready = true; return; }
  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
    rig.update(dt);
    doors.update(dt, camera.position);
    interaction.update();
    ui.sync();
    pipeline.render();
  });
  hooks.ready = true;
  await screen.finish();
}
