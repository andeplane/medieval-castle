// Sky, sun, image-based light and aerial-perspective fog (game-materials-shaders/water-sky-fog.md).
import * as THREE from 'three/webgpu';
import { fog, densityFogFactor, uniform, mix, positionWorld, smoothstep, float, vec3, vec4, luminance } from 'three/tsl';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { castleCentre } from '../castle/layout';
import { sunDirection } from '../render/materials';
import { NearFarShadowNode } from '../render/shadows';

export interface SkyRig {
  sky: SkyMesh; sun: THREE.DirectionalLight; sunDir: THREE.Vector3;
  setTime(hours: number): void; hours: number;
}

export function makeSky(renderer: THREE.WebGPURenderer, scene: THREE.Scene): SkyRig {
  const sky = new SkyMesh();
  sky.scale.setScalar(40000);
  sky.turbidity.value = 3.2; sky.rayleigh.value = 1.35; sky.mieCoefficient.value = 0.0035; sky.mieDirectionalG.value = 0.82;
  sky.cloudCoverage.value = 0.42; sky.cloudDensity.value = 0.55; sky.cloudElevation.value = 0.55; sky.cloudScale.value = 0.00018;
  (sky.material as unknown as { fog: boolean }).fog = false;
  scene.add(sky);

  const envSky = new SkyMesh();
  envSky.scale.setScalar(80);
  for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG'] as const) envSky[k].value = sky[k].value;
  envSky.cloudCoverage.value = 0; envSky.showSunDisc.value = 0;
  // The ambient light is the sky seen through a grey filter: a clear blue sky would turn every shaded
  // wall cyan (STYLE.md: shade stays grey-green). Keep 30 % of the sky's saturation, lean it neutral.
  {
    const mat = envSky.material as unknown as THREE.NodeMaterial;
    const sky0 = mat.colorNode as unknown as THREE.Node<'vec4'>;
    const rgb = sky0.xyz, l = luminance(rgb);
    mat.colorNode = vec4(mix(vec3(l), rgb, 0.3).mul(vec3(1.04, 1.02, 0.95)), 1);
  }
  const envScene = new THREE.Scene();
  envScene.add(envSky);
  // a dull ground hemisphere so reflections and ambient from below are earthy, not sky blue
  const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 32), new THREE.MeshBasicNodeMaterial({ color: 0x353a27 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -2;
  envScene.add(ground);
  const pmrem = new THREE.PMREMGenerator(renderer);

  const sun = new THREE.DirectionalLight(0xfff1df, 3.4);
  sun.castShadow = true;
  sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.04;
  const c = castleCentre();
  sun.target.position.set(c[0], 10, c[1]);
  scene.add(sun, sun.target);
  // shadows: a static 4k map over the island (re-rendered when the sun moves) plus a 2k map
  // that follows the camera for crisp shadows within ~25 m (render/shadows.ts)
  const shadowNode = new NearFarShadowNode(sun, {
    centre: new THREE.Vector3(c[0], 10, c[1]), farHalf: 105, farMap: 4096, farRadius: 2.5,
    nearHalf: 24, nearMap: 2048, nearRadius: 1.5, nearAhead: 14, nearMaxHeight: 70,
  });
  (sun.shadow as unknown as { shadowNode: unknown }).shadowNode = shadowNode;
  // bounce: neutral sky above, grass-green ground below, so shaded stone reads grey-green
  const bounce = new THREE.HemisphereLight(0xcfd0cb, 0x5d6446, 0.75);
  scene.add(bounce);

  // fog: thin everywhere, a bit denser low down (valley haze); colour follows the horizon
  const fogColor = uniform(new THREE.Color(0xa7b6c4));
  const fogDensity = uniform(0.00012);
  const hazeLow = float(1).sub(smoothstep(0, 400, positionWorld.y)).mul(0.35).add(1);
  scene.fogNode = fog(fogColor, densityFogFactor(fogDensity.mul(hazeLow)));
  void mix;

  const sunDir = new THREE.Vector3();
  const rig: SkyRig = {
    sky, sun, sunDir, hours: 15.5,
    setTime(hours: number) {
      rig.hours = hours;
      const t = (hours - 6) / 14; // 06:00 → 20:00
      const el = Math.max(-0.1, Math.sin(Math.PI * Math.min(1, Math.max(0, t)))) * 46;
      const az = 90 + 180 * t; // east → south → west
      const elR = THREE.MathUtils.degToRad(el), azR = THREE.MathUtils.degToRad(az);
      sunDir.set(Math.sin(azR) * Math.cos(elR), Math.sin(elR), -Math.cos(azR) * Math.cos(elR)).normalize();
      sky.sunPosition.value.copy(sunDir);
      sunDirection.value.copy(sunDir);
      envSky.sunPosition.value.copy(sunDir);
      sun.position.set(c[0] + sunDir.x * 300, 10 + sunDir.y * 300, c[1] + sunDir.z * 300);
      const warm = 1 - Math.min(1, el / 25);
      sun.color.setRGB(1, 0.95 - 0.25 * warm, 0.88 - 0.45 * warm);
      sun.intensity = 3.3 * Math.min(1, Math.max(0.05, el / 12));
      fogColor.value.setRGB(0.62 + 0.18 * warm, 0.68 + 0.02 * warm, 0.76 - 0.2 * warm);
      if (scene.environment) (scene.environment as THREE.Texture).dispose();
      scene.environment = pmrem.fromScene(envScene as unknown as THREE.Scene, 0, 0.1, 200).texture;
      scene.environmentIntensity = 0.5;
    },
  };
  rig.setTime(rig.hours);
  return rig;
}
