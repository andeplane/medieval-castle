// Firelight review page (lights.html): a vaulted cellar and a torch-lit tunnel dressed with the prop
// kit, lit only by fire through the shared light system. Same window.__game contract as the castle
// page, so `URL=http://localhost:5173/lights.html npm run shots` captures every bookmark.
// URL flags: ?webgl, ?shot, ?view=<name>, ?t=<seconds> (freeze time), ?exposure, ?bloom, ?fill, ?haze,
// ?gi=0 (no bounce bake), ?shadows=N, ?lights=N, ?still (no flicker), ?seed=N.
import * as THREE from 'three/webgpu';
import { pass, mrt, output, emissive, texture, uv, vec3, vec4, float, mix, clamp, smoothstep, luminance, renderOutput, screenUV, length, normalView, builtinAOContext } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { LightProbeGrid } from 'three/addons/lighting/LightProbeGrid.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { generateTextures } from '../render/texpool';
import type { TexSet } from '../render/texgen';
import { woodTex, ironTex, clothTex, strawTex, ceramicTex } from '../props/textures';
import { makePropMaterials, meshFromProp } from '../props/render';
import { mergePlaced } from '../props/place';
import { lightStage, type Surf } from './stage';
import { LightRig } from './rig';
import { linkFlames, flameBrightness } from './flames';
import { threeLightFactory, makeFlameSprites } from './three';
import { WARM_INTERIOR, lookFromParams, whiteBalance } from './look';

const params = new URLSearchParams(location.search);
const loading = document.getElementById('loading')!;
if (params.has('shot')) document.body.classList.add('shot');
const look = lookFromParams(WARM_INTERIOR, (k) => params.get(k));

function dataTex(data: Uint8Array, N: number, srgb: boolean) {
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true; return t;
}
/** Stone with the generated albedo, normal and cavity AO (data.g), a little warmer and damp-rough. */
function stoneMat(s: TexSet, tint: number, rough: number) {
  const m = new THREE.MeshStandardNodeMaterial({ map: dataTex(s.albedo, s.size, true), normalMap: dataTex(s.normal, s.size, false), color: tint, roughness: rough });
  m.normalScale.set(1.0, 1.0);
  const data = texture(dataTex(s.data, s.size, false), uv());
  m.aoNode = mix(float(1), data.g, 0.85);
  return m;
}
function surfMesh(s: Surf, mat: THREE.Material, name: string) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(s.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(s.nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(s.uv, 2));
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, mat); m.name = name; m.castShadow = m.receiveShadow = true;
  return m;
}

async function main() {
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') });
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  const TM = { agx: THREE.AgXToneMapping, aces: THREE.ACESFilmicToneMapping, neutral: THREE.NeutralToneMapping } as const;
  renderer.toneMapping = TM[(params.get('tm') ?? look.toneMapping) as keyof typeof TM] ?? THREE.AgXToneMapping;
  renderer.toneMappingExposure = look.exposure;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020101);
  scene.fog = new THREE.FogExp2(look.haze.colour, look.haze.density);
  const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.05, 120);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  loading.textContent = 'CUTTING THE STONE…';
  const t0 = performance.now();
  const T = await generateTextures(['rubble', 'dressed']);
  const wallM = stoneMat(T.rubble as unknown as TexSet, 0x9c958c, 0.88), floorM = stoneMat(T.dressed as unknown as TexSet, 0x8a8178, 0.72);
  const mats = makePropMaterials({ wood: woodTex(), iron: ironTex(), cloth: clothTex(), straw: strawTex(), ceramic: ceramicTex() });
  // wax glows from inside near the flame (subsurface); kept as a faint emissive
  (mats.wax as THREE.MeshStandardNodeMaterial).emissiveNode = vec3(0.09, 0.04, 0.012);
  const tTex = performance.now() - t0;

  loading.textContent = 'LIGHTING THE TORCHES…';
  const stage = lightStage(Number(params.get('seed') ?? 1));
  if (!params.has('nowalls')) scene.add(surfMesh(stage.walls, wallM, 'walls'), surfMesh(stage.floors, floorM, 'floors')); // ?nowalls: flames on black for tuning
  const { mesh, emitters } = mergePlaced(stage.placed);
  const props = meshFromProp(mesh, mats, 'props');
  scene.add(props);

  // fill: a whisper of cool light so unlit corners are deep, not dead black
  const fill = new THREE.HemisphereLight(look.fill.sky, look.fill.ground, look.fill.intensity);
  scene.add(fill);

  // the shared light system: emitters → a fixed pool of flickering point lights, flames → sprites
  const motion = params.has('still') || matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1;
  const factory = threeLightFactory(scene, { shadowMapSize: 512 });
  const rig = new LightRig(factory, { shadows: Number(params.get('shadows') ?? 2), lights: Number(params.get('lights') ?? 10), motion });
  rig.setEmitters(emitters);
  const flames = linkFlames(mesh.flames, emitters);
  const sprites = makeFlameSprites(flames);
  scene.add(sprites.group);
  const bright = new Float32Array(flames.length);

  // warm bounce: bake irradiance probes once with every fire at its mean brightness (flames hidden)
  let tBake = 0;
  if (params.get('gi') !== '0') {
    const t1 = performance.now();
    sprites.group.visible = false;
    const bakeLights = rig.meanLights().map((m) => {
      const l = new THREE.PointLight(new THREE.Color().setRGB(...m.colour, THREE.LinearSRGBColorSpace), m.candela, m.range, 2);
      l.position.set(...m.position); scene.add(l); return l;
    });
    for (const h of factory.lights) h.intensity = 0;
    for (const v of stage.volumes) {
      const grid = new LightProbeGrid(v.size[0], v.size[1], v.size[2], v.probes[0], v.probes[1], v.probes[2]);
      grid.position.set(...v.centre);
      await grid.bake(renderer, scene, { cubemapSize: 32, near: 0.05, far: 40, bounces: 1 });
      scene.add(grid);
    }
    for (const l of bakeLights) scene.remove(l);
    sprites.group.visible = true;
    tBake = performance.now() - t1;
  }

  // post: AO for contact darkness, bloom on the HDR flames, then a warm grade with a soft vignette
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  if (params.get('ao') !== '0') {
    const pre = pass(scene, camera, { samples: 0 });
    pre.setMRT(mrt({ output: normalView }));
    const aoPass = ao(pre.getTextureNode('depth'), pre.getTextureNode(), camera);
    aoPass.resolutionScale = 0.5; aoPass.radius.value = 0.6; aoPass.scale.value = 1.1;
    scenePass.contextNode = builtinAOContext(aoPass.getTextureNode().sample(screenUV).r);
  }
  const hdr = scenePass.getTextureNode();
  const glow = bloom(hdr, look.bloom.strength, look.bloom.radius, look.bloom.threshold);
  pipeline.outputColorTransform = false;
  const c = renderOutput(hdr.add(glow).mul(vec3(...whiteBalance(1800, look.grade.adapt)))).rgb, l = luminance(c), g = look.grade;
  let graded = mix(vec3(l), c, g.saturation);
  graded = graded.sub(0.5).mul(g.contrast).add(0.5);
  graded = graded.mul(mix(vec3(...g.shadowTint), vec3(...g.warm), smoothstep(0.08, 0.6, l)));
  const vig = float(1).sub(smoothstep(0.35, 1.05, length(screenUV.sub(0.5).mul(vec3(1.6, 1.0, 0).xy))).mul(g.vignette));
  pipeline.outputNode = vec4(clamp(graded.mul(vig), 0, 1), 1);
  void output; void emissive;

  const go = (name: string) => {
    const v = stage.views.find((x) => x.name === name) ?? stage.views[0];
    camera.position.set(...v.pos); controls.target.set(...v.target); controls.update();
    return v.name === name;
  };
  go(params.get('view') ?? 'cellar');

  const ui = document.getElementById('ui')!;
  const row = document.createElement('div'); row.className = 'row';
  for (const v of stage.views) { const b = document.createElement('button'); b.textContent = v.label; b.onclick = () => go(v.name); row.appendChild(b); }
  ui.appendChild(row);
  const help = document.getElementById('help')!;
  help.textContent = 'Drag to look around · scroll to move closer';

  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

  const fixedT = params.get('t');
  let last = performance.now(), simT = fixedT === null ? 0 : Number(fixedT);
  const eye = (): [number, number, number] => [camera.position.x, camera.position.y, camera.position.z];
  const frame = (dt: number) => {
    if (fixedT === null) simT += dt;
    controls.update();
    rig.update(simT, dt, eye());
    sprites.update(flameBrightness(flames, simT, motion, bright), simT * motion);
    pipeline.render();
  };
  rig.update(simT, 10, eye()); // settle the pools before the first frame (no fade-in on load)
  await renderer.compileAsync(scene, camera);

  const info = renderer.info;
  const errors: string[] = [];
  addEventListener('error', (e) => errors.push(String(e.message)));
  const hooks = {
    version: 1, ready: false,
    state: () => ({
      page: 'lights', emitters: emitters.length, flames: flames.length, rig: rig.stats(),
      propTriangles: props.userData.triangles, drawCalls: info.render.drawCalls, frameTriangles: info.render.triangles,
      textureMs: Math.round(tTex), bakeMs: Math.round(tBake),
      backend: (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2', errors,
    }),
    views: () => stage.views.map((v) => v.name),
    setCamera: (n: string) => { const ok = go(n); rig.update(simT, 10, eye()); return ok; },
    step: async (n = 1) => { for (let i = 0; i < n; i++) frame(1 / 60); },
  };
  (window as unknown as Record<string, unknown>).__game = hooks;
  if (params.has('shot')) { loading.remove(); hooks.ready = true; return; }
  renderer.setAnimationLoop(() => { const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now; frame(dt); });
  loading.style.opacity = '0'; setTimeout(() => loading.remove(), 700);
  hooks.ready = true;
}

main().catch((e) => { loading.textContent = 'FAILED: ' + (e as Error).message; console.error(e); });
