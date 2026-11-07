// three.js side of the prop kit: materials from the generated textures and meshes from PropMesh bins.
// Kept thin on purpose; all shape logic lives in geom.ts / kit.ts, which are pure and unit-tested.
import * as THREE from 'three/webgpu';
import { float, sin, time, positionWorld, vec3, vertexColor } from 'three/tsl';
import { PROP_MATS, type PropMesh, type PropMat } from './geom';
import { brassTex, stoneTex, paintAtlas, type PropTex } from './textures';

export type PropMaterials = Record<PropMat, THREE.Material>;
/** brass, stone and paint are generated here when the caller does not pass them (main.ts passes the first five). */
export interface PropTextures { wood: PropTex; iron: PropTex; cloth: PropTex; straw: PropTex; ceramic: PropTex; brass?: PropTex; stone?: PropTex; paint?: PropTex }

function tex(data: Uint8Array, N: number, srgb: boolean, clamp = false) {
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

export function makePropMaterials(T: PropTextures): PropMaterials {
  const std = (s: PropTex, o: { metalness?: number; normalScale?: number; side?: THREE.Side; clamp?: boolean }) => new THREE.MeshStandardNodeMaterial({
    map: tex(s.albedo, s.size, true, o.clamp), normalMap: tex(s.normal, s.size, false, o.clamp), roughnessMap: tex(s.rough, s.size, false, o.clamp),
    normalScale: new THREE.Vector2(o.normalScale ?? 1, o.normalScale ?? 1), roughness: 1, metalness: o.metalness ?? 0, vertexColors: true, side: o.side ?? THREE.FrontSide,
  });
  const wax = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.55, vertexColors: true });
  // light scattering through the wax near the flame; a tint above 1 marks a glowing shade (an oil
  // lamp's opal globe): the excess glows warm, so the lit globe reads without a light inside it
  wax.emissiveNode = vec3(0.06, 0.03, 0.01).add(vertexColor().rgb.sub(vec3(1, 1, 1)).max(vec3(0, 0, 0)).mul(vec3(1.6, 1.1, 0.6)));
  const flame = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const flick = sin(time.mul(17).add(positionWorld.x.mul(31)).add(positionWorld.z.mul(17))).mul(0.12).add(float(1));
  flame.colorNode = vec3(4.0, 2.2, 0.8).mul(flick);
  flame.opacityNode = float(0.9);
  return {
    wood: std(T.wood, { normalScale: 0.8 }),
    iron: std(T.iron, { metalness: 0.75, side: THREE.DoubleSide }),
    cloth: std(T.cloth, { normalScale: 0.6, side: THREE.DoubleSide }),
    straw: std(T.straw, { normalScale: 0.8, side: THREE.DoubleSide }),
    ceramic: std(T.ceramic, { normalScale: 0.5 }),
    brass: std(T.brass ?? brassTex(), { metalness: 0.85, normalScale: 0.4 }),
    stone: std(T.stone ?? stoneTex(), { normalScale: 0.9 }),
    paint: std(T.paint ?? paintAtlas(), { normalScale: 0.5, side: THREE.DoubleSide, clamp: true }),
    wax, flame,
  };
}

/** One mesh per non-empty bin. userData.triangles counts all of them. */
export function meshFromProp(mesh: PropMesh, mats: PropMaterials, name = 'props') {
  const group = new THREE.Group();
  group.name = name;
  let tris = 0;
  for (const k of PROP_MATS) {
    const b = mesh.bins[k];
    if (!b.pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mats[k]);
    m.name = `${name}-${k}`;
    m.castShadow = k !== 'flame' && k !== 'cloth' && k !== 'paint';
    m.receiveShadow = k !== 'flame';
    group.add(m);
    tris += b.triangles;
  }
  group.userData.triangles = tris;
  return group;
}

