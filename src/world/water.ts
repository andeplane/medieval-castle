// Moat and lake water. A custom TSL surface rather than the stock WaterMesh so the moat can be dark and
// still, with a distorted planar reflection of the castle (reflector()), Fresnel, sun glint and shadows.
import * as THREE from 'three/webgpu';
import { texture, positionWorld, time, vec2, vec3, normalize, reflector, cameraPosition, dot, max, pow, float, mix, transformNormalToView, uniform } from 'three/tsl';
import { waterNormalData } from '../render/materials';

export function makeWater(sunDir: THREE.Vector3) {
  const tex = new THREE.DataTexture(waterNormalData!, 512, 512, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.06, metalness: 0 });
  const p = positionWorld.xz;
  const s0 = texture(tex, p.mul(1 / 9.0).add(vec2(time.mul(0.011), time.mul(0.007)))).xyz.mul(2).sub(1);
  const s1 = texture(tex, p.mul(1 / 23.0).sub(vec2(time.mul(0.006), time.mul(-0.009)))).xyz.mul(2).sub(1);
  const s2 = texture(tex, p.mul(1 / 3.1).add(vec2(time.mul(-0.02), time.mul(0.016)))).xyz.mul(2).sub(1);
  const tn = s0.add(s1).add(s2.mul(0.5));
  const calm = float(0.22);
  const nWorld = normalize(vec3(tn.x.mul(calm), 1, tn.y.mul(calm)));
  mat.normalNode = transformNormalToView(nWorld);

  const eye = normalize(cameraPosition.sub(positionWorld));
  const cosT = max(dot(eye, nWorld), 0);
  const fres = float(0.02).add(float(0.98).mul(pow(float(1).sub(cosT), 5)));

  // bounces: false renders the reflection once per frame. With the default (true) it re-renders for every
  // pass that draws the water, so the AO normal pre-pass and the main pass each drew the whole mirrored
  // scene again from the same camera (2 × ~1.1 M triangles and ~85 draw calls a frame, for the same image).
  const refl = reflector({ resolutionScale: 0.5, bounces: false });
  const dist = positionWorld.sub(cameraPosition).length();
  refl.uvNode = refl.uvNode!.add(nWorld.xz.mul(float(0.25).div(dist.add(8))).mul(4));
  const deep = vec3(0.012, 0.022, 0.018);
  mat.colorNode = deep;
  // reflection is added as emission so it is not darkened by the base colour; the lit base gives glint
  mat.emissiveNode = mix(deep.mul(0.2), refl.rgb.mul(0.92), fres.mul(0.85).add(0.08));
  mat.envMapIntensity = 0.2;

  const water = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), mat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0;
  water.add(refl.target);
  water.receiveShadow = true;
  water.name = 'water';
  const sunDirection = uniform(sunDir.clone());
  return Object.assign(water, { sunDirection });
}
