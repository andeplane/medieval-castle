// three.js side of the light system: point lights for the rig and instanced flame, halo and smoke
// sprites (three draw calls for any number of flames). Thin glue; the logic is in the pure modules.
import * as THREE from 'three/webgpu';
import {
  attribute, uniform, uv, vec2, vec3, vec4, float, mix, smoothstep, clamp, pow, abs, max, exp, normalize, cross,
  cameraPosition, cameraViewMatrix, cameraProjectionMatrix, cameraNear, positionGeometry, positionView, mx_noise_float, varying, dot, length, min,
} from 'three/tsl';
import type { LightFactory, LightHandle } from './rig';
import { packFlames, type FlameInstance } from './flames';

export interface ThreeLightOptions { shadowMapSize: number; shadowBias: number; shadowNormalBias: number }

/** A LightFactory that adds PointLights to `parent`; `lights` lists them for material lightsNodes. */
export function threeLightFactory(parent: THREE.Object3D, o: Partial<ThreeLightOptions> = {}): LightFactory & { lights: THREE.PointLight[] } {
  const opt = { shadowMapSize: 512, shadowBias: -0.004, shadowNormalBias: 0.02, ...o };
  const lights: THREE.PointLight[] = [];
  return {
    lights,
    create(castShadow: boolean): LightHandle {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.castShadow = castShadow;
      if (castShadow) {
        l.shadow.mapSize.set(opt.shadowMapSize, opt.shadowMapSize);
        l.shadow.bias = opt.shadowBias; l.shadow.normalBias = opt.shadowNormalBias;
        l.shadow.camera.near = 0.45; // the fixture holding the flame must not shadow the whole wall
        l.shadow.radius = 3; // a flame is a 10 cm source: soft shadows
      }
      l.name = castShadow ? 'fire-shadow-light' : 'fire-light';
      parent.add(l); lights.push(l);
      return {
        set(p, c, cd, range) { l.position.set(p[0], p[1], p[2]); l.color.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace); l.intensity = cd; l.distance = range; },
      };
    },
  };
}

/** Instanced quad: x in [-0.5, 0.5], y in [0, 1], several rows so the cylindrical billboard can bend. */
function quad(rows: number, count: number) {
  const g = new THREE.InstancedBufferGeometry();
  const p = new THREE.PlaneGeometry(1, 1, 1, rows); p.translate(0, 0.5, 0);
  g.index = p.index; g.setAttribute('position', p.getAttribute('position')); g.setAttribute('uv', p.getAttribute('uv'));
  g.instanceCount = count;
  return g;
}

/**
 * The view's opaque surfaces, for the sprites to meet them softly. `distance`: view depth (m) of the opaque
 * surface under this pixel (huge where there is none); `on`: 1 while the camera that depth belongs to is
 * drawing, 0 for any other (the water's reflection), which then draws the sprites as without it.
 */
export interface SceneDepth { distance: Node<'float'>; on: Node<'float'> }
type Node<T extends string> = THREE.Node<T>;

/**
 * How far the halo's glow is cut off by what stands near the flame, as the ray to the pixel sees it. The halo is
 * the glow of the air round the flame (a gaussian, `sigma` metres, around the flame centre at view depth `centre`):
 * a ray that meets a surface at `distance` gathers the part of it in front of the surface, Φ((distance −
 * centre) / sigma) (logistic fit of the normal CDF). It was one flat sprite through the flame, cut by the depth
 * test where it crossed anything: a hard line across a torch's stick, wandering as the camera moved (Anders,
 * 2026-11-09). Exported for tests.
 */
export function glowInFront(distance: number, centre: number, sigma: number) { return 1 / (1 + Math.exp((-1.702 * (distance - centre)) / sigma)); }
/** The halo's gaussian sigma (m) for a sprite `size` metres across: the shader's exp(−5 r²) with r = 1 at the edge. */
export const haloSigma = (size: number) => (size * 0.5) / Math.sqrt(10);

/** `update` takes this frame's flame brightness and the clock (seconds) that drives the flame motion;
 * `set` replaces the flames (streamed rooms), growing the buffers when they are too small. */
export interface FlameSprites { group: THREE.Group; update(brightness: Float32Array, time: number): void; set(fs: FlameInstance[]): void; count: number }

/** Flames (cylindrical billboards around their up axis), halos (camera-facing) and torch smoke. */
export function makeFlameSprites(fs: FlameInstance[], capacity = 0, depth: SceneDepth | null = null): FlameSprites {
  let P = packFlames(fs), cap = Math.max(1, capacity, P.count);
  // instance buffers hold `cap` flames; the first P.count are drawn
  const SIZES = { iBase: 3, iUp: 3, iShape: 4, iLook: 4, iGlow: 4, iFlick: 1 } as const;
  type Key = keyof typeof SIZES;
  const alloc = () => Object.fromEntries(Object.entries(SIZES).map(([k, n]) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n).fill(k === 'iFlick' ? 1 : 0), n);
    a.setUsage(THREE.DynamicDrawUsage);
    return [k, a];
  })) as Record<Key, THREE.InstancedBufferAttribute>;
  let A = alloc();
  const fill = () => {
    const src: Record<Exclude<Key, 'iFlick'>, Float32Array> = { iBase: P.base, iUp: P.up, iShape: P.shape, iLook: P.look, iGlow: P.glow };
    for (const k of Object.keys(src) as (keyof typeof src)[]) { (A[k].array as Float32Array).set(src[k]); A[k].needsUpdate = true; }
  };
  fill();
  const geo = (rows: number) => { const g = quad(rows, P.count); for (const k of Object.keys(A) as Key[]) g.setAttribute(k, A[k]); return g; };

  const base = attribute<'vec3'>('iBase', 'vec3'), up = attribute<'vec3'>('iUp', 'vec3'), shape = attribute<'vec4'>('iShape', 'vec4');
  const look = attribute<'vec4'>('iLook', 'vec4'), glow = attribute<'vec4'>('iGlow', 'vec4'), fl = attribute<'float'>('iFlick', 'float');
  const vecF = shape.x.mul(1.0);
  // cylindrical billboard around `up`, `w`/`h` metres, offset `lift` metres along up
  type F = typeof vecF;
  const cylinder = (w: F, h: F, lift: F) => {
    const toCam = normalize(cameraPosition.sub(base));
    const right = normalize(cross(up, toCam));
    return base.add(right.mul(positionGeometry.x.mul(w))).add(up.mul(positionGeometry.y.mul(h).add(lift)));
  };
  const time = uniform(0);
  // soft particles: a flame or a smoke column is a volume `thick` metres deep, not a sheet, so it fades out where an
  // opaque surface is within that depth behind it instead of being cut by the depth test in a hard line
  const soft = (thick: F) => depth ? mix(float(1), smoothstep(0.0, thick, depth.distance.sub(positionView.z.negate())), depth.on) : float(1);
  const vSeed = varying(shape.z), vKind = varying(shape.w), vLook = varying(look), vFl = varying(fl), vGlow = varying(glow);

  // ---- flame body: turbulent teardrop, black-body ramp, additive HDR
  const vWidth = varying(shape.y);
  const flameMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  flameMat.positionNode = cylinder(shape.y, shape.x, shape.x.mul(0));
  flameMat.colorNode = (() => {
    const u = uv(), x = u.x.mul(2).sub(1), y = u.y;
    const ragged = vLook.x, t = time.mul(vLook.y).add(vSeed.mul(53.0));
    const n1 = mx_noise_float(vec3(x.mul(2.2), y.mul(2.8).sub(t.mul(2.6)), vSeed.mul(9.0)));
    const n2 = mx_noise_float(vec3(x.mul(5.5), y.mul(6.5).sub(t.mul(5.8)), vSeed.mul(9.0).add(4.0)));
    const turb = n1.mul(0.65).add(n2.mul(0.35));
    const sway = mx_noise_float(vec3(t.mul(0.6), vSeed.mul(7.0), 1.5)).mul(0.35).mul(ragged.add(0.3));
    const xs = x.sub(sway.mul(y).mul(y)).sub(turb.mul(ragged).mul(y).mul(0.9));
    const ys = clamp(y.add(turb.mul(0.1).mul(y)), 0.0, 1.0);
    // teardrop: round belly low down, long tongue; licks break off near the tip
    const w = pow(ys, 0.45).mul(pow(float(1).sub(ys), 1.1)).mul(1.25);
    const d = abs(xs).div(max(w, 0.001));
    const body = float(1).sub(smoothstep(0.0, 1.0, d));
    const tip = float(1).sub(smoothstep(0.35, 1.0, ys.add(turb.mul(ragged).mul(0.45))));
    const foot = smoothstep(0.0, 0.06, y);
    const licks = smoothstep(-0.35, 0.25, n2.add(float(1).sub(ys).mul(0.9)));
    const temp = clamp(body.mul(tip).mul(foot).mul(licks).mul(float(1.15).add(n1.mul(0.25))), 0.0, 1.0);
    // black-body ramp: dull red at the edges, orange, yellow, a pale core low in the flame
    const k = pow(temp, 0.8);
    let col = mix(vec3(0.55, 0.06, 0.0), vec3(1.0, 0.3, 0.03), smoothstep(0.0, 0.35, k));
    col = mix(col, vec3(1.0, 0.58, 0.14), smoothstep(0.3, 0.65, k));
    col = mix(col, vec3(1.0, 0.8, 0.42), smoothstep(0.65, 0.95, k).mul(float(1).sub(smoothstep(0.3, 0.75, ys))));
    // candles and lanterns: a small blue cup at the wick where the gas burns clean
    const blue = vLook.w.mul(float(1).sub(smoothstep(0.03, 0.16, y))).mul(float(1).sub(smoothstep(0.25, 0.9, d))).mul(foot);
    col = mix(col, vec3(0.12, 0.2, 0.85), blue.mul(0.7));
    return col.mul(temp.mul(temp).mul(1.4).add(blue.mul(0.25))).mul(vLook.z).mul(vFl).mul(soft(vWidth.mul(0.5)));
  })();

  // ---- halo: camera-facing glow around the flame (the damp air and the eye's own bloom)
  const haloMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  // the quad stands 3 sigma in front of the flame (keeping its size on screen), so the depth test cuts it only at
  // surfaces wholly in front of the glow; glowInFront does the rest, per pixel, against the scene's depth
  const size = shape.x.mul(glow.y), sigma = size.mul(haloSigma(1));
  const view = cameraViewMatrix.mul(vec4(base.add(up.mul(shape.x.mul(0.45))), 1.0));
  const vCentre = varying(view.z.negate()), vSigma = varying(sigma);
  haloMat.vertexNode = (() => {
    // never behind the flame, never through the near plane
    const z = depth ? min(view.z.add(sigma.mul(3).mul(depth.on)), max(view.z, cameraNear.mul(-1.5))) : view.z;
    const off = vec2(positionGeometry.x, positionGeometry.y.sub(0.5)).mul(size);
    return cameraProjectionMatrix.mul(vec4(view.xy.add(off).mul(z.div(view.z)), z, 1.0));
  })();
  const inFront = depth ? mix(float(1), float(1).div(exp(depth.distance.sub(vCentre).div(vSigma).mul(-1.702)).add(1)), depth.on) : float(1);
  haloMat.colorNode = (() => {
    const p = uv().sub(0.5).mul(2), r2 = dot(p, p);
    const fall = exp(r2.mul(-5.0)).sub(exp(float(-5.0))).max(0.0);
    return vec3(1.0, 0.52, 0.2).mul(fall).mul(vGlow.x).mul(vFl.mul(vFl)).mul(inFront);
  })();

  // ---- smoke: a thin dark column above torches and braziers, alpha-blended
  const vSmoke = varying(shape.x.mul(0.7)); // the column's half-width
  const smokeMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  smokeMat.positionNode = cylinder(shape.x.mul(1.4), shape.x.mul(5.0).mul(glow.z), shape.x.mul(0.55));
  smokeMat.colorNode = vec3(0.045, 0.04, 0.037);
  smokeMat.opacityNode = (() => {
    const u = uv(), x = u.x.mul(2).sub(1), y = u.y, t = time.mul(0.9).add(vSeed.mul(31.0));
    const curl = mx_noise_float(vec3(y.mul(2.0).sub(t.mul(0.7)), vSeed.mul(5.0), 0.0)).mul(0.45).mul(y);
    const wisp = mx_noise_float(vec3(x.mul(3.0), y.mul(4.0).sub(t.mul(1.6)), vSeed.mul(5.0).add(2.0))).mul(0.5).add(0.5);
    const col = float(1).sub(smoothstep(0.08, 0.5, abs(x.sub(curl)).div(y.mul(0.9).add(0.15))));
    const fade = smoothstep(0.0, 0.12, y).mul(float(1).sub(smoothstep(0.35, 1.0, y)));
    return clamp(col.mul(fade).mul(wisp).mul(vGlow.z).mul(0.42).mul(soft(vSmoke)), 0.0, 1.0);
  })();
  void length; void vKind;

  const group = new THREE.Group(); group.name = 'flames';
  const meshes: [THREE.Mesh, number][] = [];
  const add = (rows: number, m: THREE.Material, name: string, order: number) => {
    const mesh = new THREE.Mesh(geo(rows), m); meshes.push([mesh, rows]); mesh.name = name; mesh.frustumCulled = false; mesh.renderOrder = order;
    mesh.castShadow = mesh.receiveShadow = false;
    group.add(mesh);
  };
  // smoke reads only for kinds with smoke > 0; others collapse to zero height
  add(6, smokeMat, 'flame-smoke', 1);
  add(8, flameMat, 'flame-body', 2);
  add(1, haloMat, 'flame-halo', 3);
  // no flames: no draw calls
  const show = () => { for (const c of group.children) c.visible = P.count > 0; };
  show();
  const out: FlameSprites = {
    group, count: P.count,
    update(b, t) { const f = A.iFlick.array as Float32Array; f.set(b.subarray(0, Math.min(P.count, f.length))); A.iFlick.needsUpdate = true; time.value = t; },
    set(next) {
      P = packFlames(next);
      if (P.count > cap) {
        cap = Math.max(P.count, cap * 2);
        A = alloc();
        // new buffers mean new geometries (the renderer keys its buffers on the geometry)
        for (const [m, rows] of meshes) { m.geometry.dispose(); m.geometry = geo(rows); }
      }
      fill();
      for (const [m] of meshes) (m.geometry as THREE.InstancedBufferGeometry).instanceCount = P.count;
      out.count = P.count;
      show();
    },
  };
  return out;
}
