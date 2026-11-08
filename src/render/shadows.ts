// Two-level sun shadows for a scene built around one castle (threejs-lighting):
// - far: a static map fitted to the castle and island, re-rendered only when the sun moves;
// - near: a small map that follows the camera (texel-snapped so it does not shimmer), re-rendered
//   every frame while the camera is close to the ground, for crisp contact shadows near the player.
// The shader uses the near map inside its box and cross-fades to the far map at the box edge.
// Same structure as three's CSMShadowNode (per-cascade proxy lights + ShadowNodes), but the far level
// stays fixed on the castle instead of following the view, so distant views keep sharp shadows.
import * as THREE from 'three/webgpu';
import { ShadowBaseNode } from 'three/webgpu';
import { VIEW_MASK } from './passLayers';
import { Fn, If, vec4, uniform, positionWorld, max, abs, smoothstep, shadow, renderGroup } from 'three/tsl';

class ProxyLight extends THREE.Object3D { target = new THREE.Object3D(); castShadow = true; shadow!: THREE.DirectionalLightShadow }

export interface NearFarOpts {
  centre: THREE.Vector3; farHalf: number; farMap: number; farRadius: number;
  nearHalf: number; nearMap: number; nearRadius: number; nearAhead: number;
  /** above this camera height (m) the near level is switched off */
  nearMaxHeight: number;
}

const _m = new THREE.Matrix4(), _mi = new THREE.Matrix4(), _c = new THREE.Vector3(), _f = new THREE.Vector3(), _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0), _fwd = new THREE.Vector3();
const PULL = 800; // m from the box centre back towards the sun

export class NearFarShadowNode extends ShadowBaseNode {
  camera: THREE.Camera | null = null;
  near = new ProxyLight(); far = new ProxyLight();
  private nearCentre = uniform(new THREE.Vector3()).setGroup(renderGroup);
  private axisX = uniform(new THREE.Vector3(1, 0, 0)).setGroup(renderGroup);
  private axisY = uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup);
  private nearHalfU = uniform(1).setGroup(renderGroup);
  private lastSun = new THREE.Vector3();
  private lastFrame = -1;
  private o: NearFarOpts;
  private nodes: { near: THREE.Node<'vec4'>; far: THREE.Node<'vec4'> } | null = null;

  constructor(light: THREE.DirectionalLight, o: NearFarOpts) {
    super(light);
    this.o = o;
    const mk = (half: number, map: number, radius: number, auto: boolean) => {
      const s = light.shadow.clone() as THREE.DirectionalLightShadow;
      s.mapSize.set(map, map); s.radius = radius; s.autoUpdate = auto;
      // the full-detail casters, whichever pass renders the map first (three takes the frame camera's
      // layers otherwise, and the water's mirrored camera draws stand-ins: render/passLayers.ts)
      s.camera.layers.mask = VIEW_MASK;
      const c = s.camera; c.left = -half; c.right = half; c.top = half; c.bottom = -half; c.near = 1; c.far = PULL + 500; c.updateProjectionMatrix();
      return s;
    };
    this.far.shadow = mk(o.farHalf, o.farMap, o.farRadius, false);
    this.near.shadow = mk(o.nearHalf, o.nearMap, o.nearRadius, true);
    this.near.shadow.bias = light.shadow.bias * 0.5; this.near.shadow.normalBias = light.shadow.normalBias * 0.5;
  }

  setup(builder: THREE.NodeBuilder) {
    if (this.camera === null) this.camera = (builder as unknown as { camera: THREE.Camera }).camera;
    if (!this.nodes) this.nodes = { near: shadow(this.near as unknown as THREE.Light, this.near.shadow) as unknown as THREE.Node<'vec4'>, far: shadow(this.far as unknown as THREE.Light, this.far.shadow) as unknown as THREE.Node<'vec4'> };
    const { near, far } = this.nodes;
    return Fn((b: THREE.NodeBuilder) => {
      this.setupShadowPosition(b as never);
      const d = positionWorld.sub(this.nearCentre);
      const e = max(abs(d.dot(this.axisX)), abs(d.dot(this.axisY))).div(this.nearHalfU);
      const w = smoothstep(0.72, 0.94, e).toVar();
      const ret = vec4(1).toVar('nearFarShadow');
      If(w.lessThan(1), () => { ret.assign(near); });
      If(w.greaterThan(0), () => { ret.assign(ret.mul(w.oneMinus()).add(far.mul(w))); });
      return ret;
    })();
  }

  build(builder: THREE.NodeBuilder, ...p: unknown[]) {
    (builder as unknown as { addSequentialNode(n: unknown): void }).addSequentialNode(this);
    return (super.build as (...a: unknown[]) => unknown)(builder, ...p) as never;
  }

  /** Place a proxy light so its shadow camera is centred on `centre` (snapped to its texel grid). */
  private place(l: ProxyLight, centre: THREE.Vector3, half: number, map: number) {
    const light = this.light as THREE.DirectionalLight;
    _dir.subVectors(light.target.position, light.position).normalize();
    _m.lookAt(light.position, light.target.position, _up); _mi.copy(_m).invert();
    _c.copy(centre).applyMatrix4(_mi);
    const texel = (2 * half) / map;
    _c.x = Math.floor(_c.x / texel) * texel; _c.y = Math.floor(_c.y / texel) * texel;
    _c.z += PULL; // pull the shadow camera back towards the sun so tall casters at low sun are inside it
    _c.applyMatrix4(_m);
    l.position.copy(_c); l.target.position.copy(_c).add(_dir);
    l.updateMatrixWorld(); l.target.updateMatrixWorld();
    const parent = light.parent;
    if (parent && l.parent === null) { parent.add(l); parent.add(l.target); }
  }

  updateBefore(frame?: { frameId: number }): undefined {
    const light = this.light as THREE.DirectionalLight, cam = this.camera;
    if (!cam) return;
    // once per frame: this runs for every render that uses the sun (the AO pre-pass, the main pass and the
    // water reflection's mirrored camera). three re-renders an auto-updating shadow map once per frame per
    // camera, so the reflection drew the near map a second time from the same box; it is now asked for
    // explicitly, once a frame, and placed from the view camera only.
    if (frame) { if (frame.frameId === this.lastFrame) return; this.lastFrame = frame.frameId; }
    const o = this.o;
    _dir.subVectors(light.target.position, light.position).normalize();
    if (!_dir.equals(this.lastSun)) {
      this.lastSun.copy(_dir);
      this.place(this.far, o.centre, o.farHalf, o.farMap);
      this.far.shadow.needsUpdate = true;
      _m.lookAt(light.position, light.target.position, _up);
      this.axisX.value.setFromMatrixColumn(_m, 0); this.axisY.value.setFromMatrixColumn(_m, 1);
    }
    // near level: a box ahead of the camera, off when flying high (the far map is enough there)
    const pos = cam.getWorldPosition(_f);
    const on = pos.y < o.nearMaxHeight && Math.hypot(pos.x - o.centre.x, pos.z - o.centre.z) < o.farHalf;
    this.near.shadow.autoUpdate = false;
    this.near.shadow.needsUpdate = on;
    if (on) {
      const fwd = cam.getWorldDirection(_fwd);
      fwd.y = 0; if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1); fwd.normalize();
      const c = pos.addScaledVector(fwd, o.nearAhead);
      this.place(this.near, c, o.nearHalf, o.nearMap);
      this.nearCentre.value.copy(this.near.position).addScaledVector(_dir, PULL);
      this.nearHalfU.value = o.nearHalf;
    } else {
      this.nearHalfU.value = 1e-3; // everything uses the far map
    }
    return undefined;
  }
}
