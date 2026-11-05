// Tree impostors (game-performance-optimization §6): every tree variant is baked once at load into an
// atlas of NA azimuths × NE elevations (albedo with baked crown AO, and tree-local normals), then drawn
// far away as one camera-facing quad per tree. The quad picks the frame nearest to the view direction
// and is lit like any other surface with the baked normals, so it shades with the sun and the fog.
// All frames are baked in one orthographic render: each tile holds a copy of the tree rotated so the
// wanted view direction points at the camera (no per-tile viewports, so both backends agree).
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  attribute, texture, uv, vec2, vec3, vec4, float, cameraPosition, normalize, cross, atan, asin, round, mod, floor, select, uniformArray,
  varying, transformNormalToView, positionGeometry, normalGeometry, mix, smoothstep, dFdx, dFdy, log2, max, min, clamp, sqrt, sin, cos, Fn,
} from 'three/tsl';

export const NA = 8;                 // azimuth frames
export const ELEV = [2, 38];         // elevation of each frame row, degrees
export const NE = ELEV.length;
export const TILE = 192;             // pixels per frame

export interface BakeSource {
  branches: THREE.BufferGeometry; leaves: THREE.BufferGeometry;
  barkMap: THREE.Texture; leafMap: THREE.Texture;
  barkTint: THREE.Color; leafTint: THREE.Color;
  crown: THREE.Vector3; crownR: number;
}

export interface Atlas {
  albedo: THREE.Texture; normal: THREE.Texture; rows: number;
  /** per row (variant * NE + elevation): quad width, height, base height in the quad (0..1) */
  frames: THREE.Vector4[];
  targets: THREE.RenderTarget[];
}

function dir(az: number, el: number) {
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

/** Quad size per elevation row, from the projected extents of every vertex over all azimuth frames. */
function frameBounds(src: BakeSource) {
  const out: THREE.Vector4[] = [];
  const pts: THREE.Vector3[] = [];
  for (const g of [src.branches, src.leaves]) {
    const p = g.attributes.position as THREE.BufferAttribute;
    const step = Math.max(1, Math.floor(p.count / 6000));
    for (let i = 0; i < p.count; i += step) pts.push(new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)));
  }
  for (const elDeg of ELEV) {
    const el = THREE.MathUtils.degToRad(elDeg);
    let xm = 0, y0 = 0, y1 = 0;
    for (let a = 0; a < NA; a++) {
      const t = dir((a / NA) * Math.PI * 2, el);
      const right = new THREE.Vector3(t.z, 0, -t.x).normalize(), up = new THREE.Vector3().crossVectors(t, right);
      for (const p of pts) { xm = Math.max(xm, Math.abs(p.dot(right))); const y = p.dot(up); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    const W = xm * 2 * 1.04, H = (y1 - y0) * 1.04, v0 = (-y0 + (y1 - y0) * 0.02) / H;
    out.push(new THREE.Vector4(W, H, v0, 0));
  }
  return out;
}

export function bakeImpostors(renderer: THREE.WebGPURenderer, sources: BakeSource[]): Atlas {
  const rows = sources.length * NE;
  const W = NA * TILE, H = rows * TILE;
  const frames: THREE.Vector4[] = [];
  const scene = new THREE.Scene();
  const albedoMats: THREE.Material[] = [], normalMats: THREE.Material[] = [];
  const meshes: THREE.Mesh[] = [];

  sources.forEach((src, vi) => {
    const fb = frameBounds(src);
    frames.push(...fb);
    // bake materials: unlit; albedo is stored as sqrt (8-bit linear bands otherwise) with crown AO folded in
    const crownAO = Fn(() => {
      const d = positionGeometry.sub(vec3(src.crown)).length().div(src.crownR);
      const hf = clamp(positionGeometry.y.div(src.crown.y * 1.6), 0, 1);
      return mix(float(0.58), float(1), smoothstep(0.15, 1.0, d)).mul(mix(float(0.8), float(1), hf));
    });
    const leafTex = texture(src.leafMap, uv());
    const leafA = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 });
    leafA.colorNode = sqrt(leafTex.rgb.mul(vec3(src.leafTint.r, src.leafTint.g, src.leafTint.b)).mul(crownAO()));
    leafA.opacityNode = leafTex.a;
    const barkA = new THREE.MeshBasicNodeMaterial();
    barkA.colorNode = sqrt(texture(src.barkMap, uv()).rgb.mul(vec3(src.barkTint.r, src.barkTint.g, src.barkTint.b)).mul(crownAO().mul(0.7)));
    // normals in tree-local space; leaves lean toward a round crown so the far canopy shades as a volume
    const leafN = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 });
    const radial = normalize(positionGeometry.sub(vec3(src.crown)).mul(vec3(1, 0.8, 1)));
    leafN.colorNode = normalize(mix(normalGeometry, radial, 0.75)).mul(0.5).add(0.5);
    leafN.opacityNode = leafTex.a;
    const barkN = new THREE.MeshBasicNodeMaterial();
    barkN.colorNode = normalize(normalGeometry).mul(0.5).add(0.5);
    albedoMats.push(barkA, leafA); normalMats.push(barkN, leafN);

    for (let e = 0; e < NE; e++) {
      const f = fb[e], row = vi * NE + e, el = THREE.MathUtils.degToRad(ELEV[e]);
      for (let a = 0; a < NA; a++) {
        const az = (a / NA) * Math.PI * 2;
        const outer = new THREE.Group();
        outer.position.set(a + 0.5, row + f.z, 0);
        outer.scale.set(1 / f.x, 1 / f.y, 0.02);
        const inner = new THREE.Group();
        inner.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), el).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -az));
        const b = new THREE.Mesh(src.branches, barkA), l = new THREE.Mesh(src.leaves, leafA);
        b.userData.mats = [barkA, barkN]; l.userData.mats = [leafA, leafN];
        b.frustumCulled = l.frustumCulled = false;
        inner.add(b, l); outer.add(inner); scene.add(outer);
        meshes.push(b, l);
      }
    }
  });

  const cam = new THREE.OrthographicCamera(0, NA, rows, 0, -50, 50);
  cam.position.set(0, 0, 10); cam.lookAt(0, 0, 0);
  const mk = () => {
    const rt = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: true, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    rt.texture.colorSpace = THREE.NoColorSpace;
    rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    return rt;
  };
  const rtA = mk(), rtN = mk();
  const prev = { target: renderer.getRenderTarget(), tm: renderer.toneMapping, clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), auto: renderer.autoClear };
  renderer.autoClear = true;
  renderer.toneMapping = THREE.NoToneMapping;
  // cleared to transparent black: the atlas is effectively premultiplied, and the impostor shader divides
  // the filtered colour by the filtered alpha, so silhouettes don't pick up dark fringes in the mips
  renderer.setClearColor(new THREE.Color(0, 0, 0), 0);
  renderer.setRenderTarget(rtA);
  renderer.render(scene, cam);
  for (const m of meshes) m.material = m.userData.mats[1];
  renderer.setClearColor(new THREE.Color(0, 0, 0), 0);
  renderer.setRenderTarget(rtN);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prev.target);
  renderer.setClearColor(prev.clear, prev.alpha);
  renderer.toneMapping = prev.tm;
  renderer.autoClear = prev.auto;
  for (const m of [...albedoMats, ...normalMats]) m.dispose();
  return { albedo: rtA.texture, normal: rtN.texture, rows, frames, targets: [rtA, rtN] };
}

/** Shared quad (uv 0..1, origin at the bottom centre is placed by the shader). */
export function impostorQuad() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/**
 * Lit impostor material. Per-instance attributes:
 *   iA = (x, y, z, rotation about y), iB = (scale, first atlas row of the variant, brightness, width factor).
 * A scale of 0 collapses the quad (used to hide a tree while its mesh LOD is shown).
 */
export function impostorMaterial(atlas: Atlas) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5 });
  const iA = attribute<'vec4'>('iA', 'vec4'), iB = attribute<'vec4'>('iB', 'vec4');
  const base = iA.xyz, rot = iA.w, scale = iB.x;
  const toCam = cameraPosition.sub(base);
  const t = normalize(toCam);
  const right = normalize(vec3(t.z, 0, t.x.negate()));
  const up = cross(t, right);
  const step = (Math.PI * 2) / NA;
  const az = atan(t.x, t.z).sub(rot);
  const a = mod(mod(round(az.div(step)), NA).add(NA), NA);
  const el = asin(clamp(t.y, -1, 1));
  const e = select(el.greaterThan(THREE.MathUtils.degToRad((ELEV[0] + ELEV[1]) / 2)), float(1), float(0));
  const row = iB.y.add(e);
  const fr = uniformArray(atlas.frames, 'vec4').element(row.toInt()) as unknown as Node<'vec4'>;
  const q = uv();
  m.positionNode = base.add(right.mul(q.x.sub(0.5).mul(fr.x).mul(scale).mul(iB.w))).add(up.mul(q.y.sub(fr.z).mul(fr.y).mul(scale)));

  const vA = varying(a, 'vImpA'), vRow = varying(row, 'vImpRow'), vRot = varying(rot, 'vImpRot'), vB = varying(iB.z, 'vImpTint');
  const cu = clamp(q.x, 0.01, 0.99), cv = clamp(q.y, 0.005, 0.995);
  // render-target textures put v = 0 at the top of the rendered image (both backends), so flip the row axis
  const auv = vec2(floor(vA.add(0.5)).add(cu).div(NA), float(1).sub(floor(vRow.add(0.5)).add(cv).div(atlas.rows)));
  const alb = texture(atlas.albedo, auv), nrm = texture(atlas.normal, auv);
  // keep alpha coverage at low mips (Golus): scale alpha up with the mip level
  const tsz = vec2(NA * TILE, atlas.rows * TILE);
  const dx = dFdx(auv.mul(tsz)), dy = dFdy(auv.mul(tsz));
  const lod = max(float(0), log2(max(dx.dot(dx), dy.dot(dy))).mul(0.5));
  m.opacityNode = alb.a.mul(float(1).add(lod.mul(0.3)));
  const ca = alb.rgb.div(max(alb.a, 0.004)), na = nrm.rgb.div(max(nrm.a, 0.004));
  m.colorNode = ca.mul(ca).mul(vB).mul(1.1);
  const nl = na.mul(2).sub(1);
  const c = cos(vRot), s = sin(vRot);
  const nw = normalize(vec3(nl.x.mul(c).add(nl.z.mul(s)), nl.y, nl.x.negate().mul(s).add(nl.z.mul(c))));
  m.normalNode = transformNormalToView(nw);
  void vec4; void min;
  return m;
}
