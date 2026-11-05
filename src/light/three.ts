// three.js side of the light system: point lights for the rig and instanced flame, halo and smoke
// sprites (three draw calls for any number of flames). Thin glue; the logic is in the pure modules.
import * as THREE from 'three/webgpu';
import {
  attribute, uniform, uv, vec2, vec3, vec4, float, mix, smoothstep, clamp, pow, abs, max, exp, normalize, cross,
  cameraPosition, cameraViewMatrix, cameraProjectionMatrix, positionGeometry, mx_noise_float, varying, dot, length,
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
function quad(rows: number, attrs: Record<string, [Float32Array, number]>, count: number) {
  const g = new THREE.InstancedBufferGeometry();
  const p = new THREE.PlaneGeometry(1, 1, 1, rows); p.translate(0, 0.5, 0);
  g.index = p.index; g.setAttribute('position', p.getAttribute('position')); g.setAttribute('uv', p.getAttribute('uv'));
  for (const [k, [a, n]] of Object.entries(attrs)) g.setAttribute(k, new THREE.InstancedBufferAttribute(a, n));
  g.instanceCount = count;
  return g;
}

/** `update` takes this frame's flame brightness and the clock (seconds) that drives the flame motion. */
export interface FlameSprites { group: THREE.Group; update(brightness: Float32Array, time: number): void; count: number }

/** Flames (cylindrical billboards around their up axis), halos (camera-facing) and torch smoke. */
export function makeFlameSprites(fs: FlameInstance[]): FlameSprites {
  const P = packFlames(fs);
  const flick = new Float32Array(P.count).fill(1);
  const flickAttr = new THREE.InstancedBufferAttribute(flick, 1); flickAttr.setUsage(THREE.DynamicDrawUsage);
  const attrs = { iBase: [P.base, 3], iUp: [P.up, 3], iShape: [P.shape, 4], iLook: [P.look, 4], iGlow: [P.glow, 4] } as Record<string, [Float32Array, number]>;
  const geo = (rows: number) => { const g = quad(rows, attrs, P.count); g.setAttribute('iFlick', flickAttr); return g; };

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
  const vSeed = varying(shape.z), vKind = varying(shape.w), vLook = varying(look), vFl = varying(fl), vGlow = varying(glow);

  // ---- flame body: turbulent teardrop, black-body ramp, additive HDR
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
    return col.mul(temp.mul(temp).mul(1.4).add(blue.mul(0.25))).mul(vLook.z).mul(vFl);
  })();

  // ---- halo: camera-facing glow around the flame (the damp air and the eye's own bloom)
  const haloMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  haloMat.vertexNode = (() => {
    const size = shape.x.mul(glow.y);
    const centre = base.add(up.mul(shape.x.mul(0.45)));
    const view = cameraViewMatrix.mul(vec4(centre, 1.0));
    const off = vec2(positionGeometry.x, positionGeometry.y.sub(0.5)).mul(size);
    return cameraProjectionMatrix.mul(vec4(view.xy.add(off), view.z, 1.0));
  })();
  haloMat.colorNode = (() => {
    const p = uv().sub(0.5).mul(2), r2 = dot(p, p);
    const fall = exp(r2.mul(-5.0)).sub(exp(float(-5.0))).max(0.0);
    return vec3(1.0, 0.52, 0.2).mul(fall).mul(vGlow.x).mul(vFl.mul(vFl));
  })();

  // ---- smoke: a thin dark column above torches and braziers, alpha-blended
  const smokeMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  smokeMat.positionNode = cylinder(shape.x.mul(1.4), shape.x.mul(5.0).mul(glow.z), shape.x.mul(0.55));
  smokeMat.colorNode = vec3(0.045, 0.04, 0.037);
  smokeMat.opacityNode = (() => {
    const u = uv(), x = u.x.mul(2).sub(1), y = u.y, t = time.mul(0.9).add(vSeed.mul(31.0));
    const curl = mx_noise_float(vec3(y.mul(2.0).sub(t.mul(0.7)), vSeed.mul(5.0), 0.0)).mul(0.45).mul(y);
    const wisp = mx_noise_float(vec3(x.mul(3.0), y.mul(4.0).sub(t.mul(1.6)), vSeed.mul(5.0).add(2.0))).mul(0.5).add(0.5);
    const col = float(1).sub(smoothstep(0.08, 0.5, abs(x.sub(curl)).div(y.mul(0.9).add(0.15))));
    const fade = smoothstep(0.0, 0.12, y).mul(float(1).sub(smoothstep(0.35, 1.0, y)));
    return clamp(col.mul(fade).mul(wisp).mul(vGlow.z).mul(0.42), 0.0, 1.0);
  })();
  void length; void vKind;

  const group = new THREE.Group(); group.name = 'flames';
  const add = (g: THREE.InstancedBufferGeometry, m: THREE.Material, name: string, order: number, count = P.count) => {
    g.instanceCount = count;
    const mesh = new THREE.Mesh(g, m); mesh.name = name; mesh.frustumCulled = false; mesh.renderOrder = order;
    mesh.castShadow = mesh.receiveShadow = false;
    group.add(mesh);
  };
  if (P.count) {
    // smoke reads only for kinds with smoke > 0; others collapse to zero height
    add(geo(6), smokeMat, 'flame-smoke', 1);
    add(geo(8), flameMat, 'flame-body', 2);
    add(geo(1), haloMat, 'flame-halo', 3);
  }
  return {
    group, count: P.count,
    update(b, t) { flick.set(b.subarray(0, flick.length)); flickAttr.needsUpdate = true; time.value = t; },
  };
}
