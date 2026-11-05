// Sky, sun, image-based light and aerial-perspective fog (game-materials-shaders/water-sky-fog.md).
import * as THREE from 'three/webgpu';
import { fog, densityFogFactor, uniform, mix, positionWorld, smoothstep, float } from 'three/tsl';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { castleCentre } from '../castle/layout';

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
  const envScene = new THREE.Scene();
  envScene.add(envSky);
  // a dull ground hemisphere so reflections and ambient from below are earthy, not sky blue
  const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 32), new THREE.MeshBasicNodeMaterial({ color: 0x2d3320 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -2;
  envScene.add(ground);
  const pmrem = new THREE.PMREMGenerator(renderer);

  const sun = new THREE.DirectionalLight(0xfff1df, 3.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  sc.left = -82; sc.right = 82; sc.top = 82; sc.bottom = -82; sc.near = 10; sc.far = 600;
  sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.04;
  const c = castleCentre();
  sun.target.position.set(c[0], 10, c[1]);
  scene.add(sun, sun.target);
  // warm bounce from the ground so shaded stone is not sky-blue
  const bounce = new THREE.HemisphereLight(0xc9d2dc, 0x6b6248, 0.55);
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
      envSky.sunPosition.value.copy(sunDir);
      sun.position.set(c[0] + sunDir.x * 300, 10 + sunDir.y * 300, c[1] + sunDir.z * 300);
      const warm = 1 - Math.min(1, el / 25);
      sun.color.setRGB(1, 0.95 - 0.25 * warm, 0.88 - 0.45 * warm);
      sun.intensity = 3.3 * Math.min(1, Math.max(0.05, el / 12));
      fogColor.value.setRGB(0.62 + 0.18 * warm, 0.68 + 0.02 * warm, 0.76 - 0.2 * warm);
      if (scene.environment) (scene.environment as THREE.Texture).dispose();
      scene.environment = pmrem.fromScene(envScene as unknown as THREE.Scene, 0, 0.1, 200).texture;
      scene.environmentIntensity = 0.32;
    },
  };
  rig.setTime(rig.hours);
  return rig;
}
