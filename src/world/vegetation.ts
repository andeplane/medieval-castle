// Vegetation entry point: trees (mesh LODs + impostors, trees.ts/impostors.ts) and ground cover
// (grass, flowers, reeds, grass.ts). main.ts builds it once and calls update(camera) every frame.
import * as THREE from 'three/webgpu';
import { buildTrees } from './trees';
import { buildGroundCover } from './grass';

export interface Vegetation { group: THREE.Group; update(camera: THREE.PerspectiveCamera): void; stats(): Record<string, unknown> }

export async function buildVegetation(o: { renderer: THREE.WebGPURenderer; scene: THREE.Scene; keepClear: [number, number][]; macro: THREE.Texture }): Promise<Vegetation> {
  const group = new THREE.Group();
  group.name = 'vegetation';
  if (new URLSearchParams(location.search).get('veg') === '0') return { group, update() {}, stats: () => ({ disabled: true }) };
  const trees = await buildTrees(o.renderer, o.keepClear);
  group.add(trees.group);
  const terrain = o.scene.getObjectByName('terrain-near') as THREE.Mesh | undefined;
  const cover = terrain ? buildGroundCover(terrain, o.macro) : null;
  if (cover) group.add(cover.group);
  // tree shadows come from fixed L1 casters on layer 1: let the sun's shadow camera see that layer
  // The sun's shadow camera is fixed on the castle, so one shadow render per frame serves every camera;
  // without this the reflector's mirrored camera re-renders the whole shadow map a second time.
  const suns: THREE.DirectionalLight[] = [];
  o.scene.traverse((ob) => { const l = ob as THREE.DirectionalLight; if (l.isDirectionalLight && l.castShadow) suns.push(l); });
  for (const l of suns) { l.shadow.camera.layers.enable(1); l.shadow.autoUpdate = false; l.shadow.needsUpdate = true; }
  return {
    group,
    update(camera) { trees.update(camera.position); cover?.update(camera); for (const l of suns) l.shadow.needsUpdate = true; },
    stats: () => ({ ...trees.group.userData, lod: { ...trees.stats }, cover: cover?.stats() }),
  };
}
