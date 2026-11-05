// Prop-kit review page (props.html): every kind in a gallery cell against a stone wall, plus three
// dressed rooms (hall, chamber, store). Same window.__game contract as the castle page, so
// `URL=http://localhost:5173/props.html npm run shots` captures every bookmark.
// URL flags: ?webgl, ?shot, ?view=<name>, ?seed=N (prop variants), ?spin (turntable the camera).
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { generateTextures } from '../render/texpool';
import type { TexSet } from '../render/texgen';
import { woodTex, ironTex, clothTex, strawTex, ceramicTex } from './textures';
import { makePropMaterials, meshFromProp } from './render';
import { mergePlaced, previewLayout } from './place';

const params = new URLSearchParams(location.search);
const loading = document.getElementById('loading')!;
if (params.has('shot')) document.body.classList.add('shot');

function dataTex(data: Uint8Array, N: number, srgb: boolean, rep: number) {
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 8;
  t.repeat.set(rep, rep);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true; return t;
}
const stoneMat = (s: TexSet, rep: number, tint: number) => new THREE.MeshStandardNodeMaterial({ map: dataTex(s.albedo, s.size, true, rep), normalMap: dataTex(s.normal, s.size, false, rep), color: tint, roughness: 0.92 });

/** A box whose UVs are in world metres / tile so the stone reads at true scale. */
function stoneBox(min: number[], max: number[], tile: number, mat: THREE.Material) {
  const sx = max[0] - min[0], sy = max[1] - min[1], sz = max[2] - min[2];
  const g = new THREE.BoxGeometry(sx, sy, sz);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute, nrm = g.getAttribute('normal') as THREE.BufferAttribute, pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i));
    const x = pos.getX(i) + min[0] + sx / 2, y = pos.getY(i) + min[1] + sy / 2, z = pos.getZ(i) + min[2] + sz / 2;
    if (ny > 0.5) uv.setXY(i, x / tile, z / tile); else if (nx > 0.5) uv.setXY(i, z / tile, y / tile); else uv.setXY(i, x / tile, y / tile);
  }
  const m = new THREE.Mesh(g, mat);
  m.position.set(min[0] + sx / 2, min[1] + sy / 2, min[2] + sz / 2);
  m.castShadow = m.receiveShadow = true;
  return m;
}

async function main() {
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') });
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = Number(params.get('exposure') ?? 0.9);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15171a);
  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 300);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  loading.textContent = 'CUTTING THE STONE…';
  const t0 = performance.now();
  const T = await generateTextures(['rubble', 'dressed']);
  const floorM = stoneMat(T.dressed as unknown as TexSet, 1, 0xb8b2a8), wallM = stoneMat(T.rubble as unknown as TexSet, 1, 0xd8d2c8);
  loading.textContent = 'SHAPING THE FURNITURE…';
  const mats = makePropMaterials({ wood: woodTex(), iron: ironTex(), cloth: clothTex(), straw: strawTex(), ceramic: ceramicTex() });
  const tTex = performance.now() - t0;

  const seed = Number(params.get('seed') ?? 1);
  const L = previewLayout(seed);
  const t1 = performance.now();
  const { mesh, emitters } = mergePlaced(L.placed);
  const props = meshFromProp(mesh, mats, 'props');
  const tBuild = performance.now() - t1;
  scene.add(props);

  // stage: a floor, a wall behind each gallery cell and three-walled rooms for the vignettes
  scene.add(stoneBox([-4, -0.3, -16], [30, 0, 24], 2, floorM));
  for (const w of L.walls) scene.add(stoneBox(w.min, w.max, 4, wallM));
  for (const s of L.stages) {
    const t = 0.6;
    scene.add(stoneBox([s.min[0] - t, 0, s.min[2] - t], [s.max[0] + t, s.max[1], s.min[2]], 4, wallM));
    scene.add(stoneBox([s.min[0] - t, 0, s.min[2]], [s.min[0], s.max[1], s.max[2]], 4, wallM));
    scene.add(stoneBox([s.max[0], 0, s.min[2]], [s.max[0] + t, s.max[1], s.max[2]], 4, wallM));
  }

  // light: soft window light from the south-west, a cool fill, and the fixture emitters as point lights
  scene.add(new THREE.HemisphereLight(0x9aa4b0, 0x3a332b, 0.6));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
  sun.position.set(-14, 22, 30); sun.target.position.set(10, 0, -2);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 90 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  for (const e of emitters.slice(0, 16)) {
    const l = new THREE.PointLight(new THREE.Color(...e.colour), e.intensity * 0.9, 7, 2);
    l.position.set(...e.position);
    scene.add(l);
  }

  const go = (name: string) => {
    const v = L.views.find((x) => x.name === name) ?? L.views[0];
    camera.position.set(...v.pos); controls.target.set(...v.target); controls.update();
    return v.name === name;
  };
  go(params.get('view') ?? 'kit');

  // UI: one button per room view and a select for every kind
  const ui = document.getElementById('ui')!;
  const row = document.createElement('div'); row.className = 'row';
  for (const v of L.views.filter((x) => !x.name.startsWith('p-'))) { const b = document.createElement('button'); b.textContent = v.label; b.onclick = () => go(v.name); row.appendChild(b); }
  const sel = document.createElement('select');
  sel.innerHTML = '<option value="">Piece…</option>' + L.views.filter((x) => x.name.startsWith('p-')).map((v) => `<option value="${v.name}">${v.label}</option>`).join('');
  sel.onchange = () => sel.value && go(sel.value);
  row.appendChild(sel); ui.appendChild(row);

  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
  await renderer.compileAsync(scene, camera);

  const spin = params.has('spin');
  const render = () => { if (spin) { controls.autoRotate = true; controls.autoRotateSpeed = 1.5; } controls.update(); renderer.render(scene, camera); };
  const info = renderer.info;
  const errors: string[] = [];
  addEventListener('error', (e) => errors.push(String(e.message)));
  const hooks = {
    version: 1, ready: false,
    state: () => ({
      page: 'props', kinds: L.views.filter((x) => x.name.startsWith('p-')).length, placed: L.placed.length,
      propTriangles: props.userData.triangles, emitters: emitters.length, materials: props.children.length,
      drawCalls: info.render.drawCalls, frameTriangles: info.render.triangles,
      textureMs: Math.round(tTex), buildMs: Math.round(tBuild),
      perKind: Object.fromEntries(L.placed.slice(0, L.views.length).filter((p, i, a) => a.findIndex((q) => q.prop.kind === p.prop.kind) === i).map((p) => [p.prop.kind.name, p.prop.mesh.triangles])),
      backend: (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2', errors,
    }),
    views: () => L.views.map((v) => v.name),
    setCamera: go,
    step: async (n = 1) => { for (let i = 0; i < n; i++) render(); },
  };
  (window as unknown as Record<string, unknown>).__game = hooks;
  renderer.setAnimationLoop(render);
  if (params.has('shot')) loading.remove(); else { loading.style.opacity = '0'; setTimeout(() => loading.remove(), 700); }
  hooks.ready = true;
}

main().catch((e) => { loading.textContent = 'FAILED: ' + (e as Error).message; console.error(e); });
