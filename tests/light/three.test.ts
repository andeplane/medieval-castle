import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { threeLightFactory, makeFlameSprites, glowInFront, haloSigma } from '../../src/light/three';
import { float, uniform } from 'three/tsl';
import { LOOKS } from '../../src/light/flames';
import { linkFlames } from '../../src/light/flames';
import { LightRig } from '../../src/light/rig';

describe('three.js light adapter', () => {
  it('makes point lights, shadowed ones with soft, near-clipped shadow cameras', () => {
    const parent = new THREE.Group();
    const f = threeLightFactory(parent, { shadowMapSize: 256 });
    const rig = new LightRig(f, { shadows: 1, lights: 2, fadeTime: 0, motion: 0 });
    expect(f.lights).toHaveLength(3);
    expect(parent.children).toHaveLength(3);
    const [s, p] = f.lights;
    expect(s.castShadow).toBe(true); expect(p.castShadow).toBe(false);
    expect(s.shadow.mapSize.x).toBe(256);
    expect(s.shadow.camera.near).toBeGreaterThan(0.2);
    expect(s.decay).toBe(2);
    rig.setEmitters([{ kind: 'torch', position: [1, 2, 3], colour: [1, 1, 1], intensity: 3, flicker: 0.25 }]);
    rig.update(0, 0.016, [1, 2, 4]);
    expect(s.position.toArray()).toEqual([1, 2, 3]);
    expect(s.intensity).toBeGreaterThan(0); expect(s.distance).toBeGreaterThan(5);
    expect(s.color.r).toBeGreaterThan(s.color.b);
    expect(p.intensity).toBe(0);
    expect(threeLightFactory(new THREE.Group()).create(true)).toBeDefined();
  });

  it('draws any number of flames in three instanced meshes and updates brightness', () => {
    const fl = linkFlames([
      { kind: 'torch', base: [0, 1, 0], height: 0.3, up: [0, 0.9, 0.3] },
      { kind: 'candle', base: [1, 1, 0], height: 0.03 },
    ], []);
    const S = makeFlameSprites(fl);
    expect(S.count).toBe(2);
    expect(S.group.children.map((c) => c.name)).toEqual(['flame-smoke', 'flame-body', 'flame-halo']);
    for (const c of S.group.children) {
      const m = c as THREE.Mesh;
      expect((m.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(2);
      expect(m.frustumCulled).toBe(false); expect(m.castShadow).toBe(false);
    }
    const body = S.group.children[1] as THREE.Mesh;
    expect((body.material as THREE.Material).blending).toBe(THREE.AdditiveBlending);
    expect((body.material as THREE.Material).depthWrite).toBe(false);
    const attr = (body.geometry as THREE.InstancedBufferGeometry).getAttribute('iFlick') as THREE.InstancedBufferAttribute;
    const v0 = attr.version;
    S.update(new Float32Array([0.5, 1.2, 9]), 3);
    expect(Array.from(attr.array as Float32Array).map((x) => +x.toFixed(2))).toEqual([0.5, 1.2]);
    expect(attr.version).toBeGreaterThan(v0);
    const none = makeFlameSprites([]);
    expect(none.group.children.every((c) => !c.visible)).toBe(true); // no flames, no draw calls
  });

  it('replaces its flames (streamed rooms), growing the buffers past their capacity', () => {
    const one = linkFlames([{ kind: 'torch', base: [0, 1, 0], height: 0.3 }], []);
    const S = makeFlameSprites([], 2);
    const body = () => S.group.children[1] as THREE.Mesh;
    const first = body().geometry as THREE.InstancedBufferGeometry;
    S.set(one);
    expect(S.count).toBe(1);
    expect(body().geometry).toBe(first); // fits: same buffers
    expect(first.instanceCount).toBe(1);
    expect(S.group.children.every((c) => c.visible)).toBe(true);
    expect(Array.from((first.getAttribute('iBase').array as Float32Array).slice(0, 3))).toEqual([0, 1, 0]);
    const five = linkFlames([0, 1, 2, 3, 4].map((x) => ({ kind: 'candle' as const, base: [x, 1, 0] as [number, number, number], height: 0.03 })), []);
    let disposed = false;
    first.addEventListener('dispose', () => { disposed = true; });
    S.set(five);
    const grown = body().geometry as THREE.InstancedBufferGeometry;
    expect(grown).not.toBe(first); expect(disposed).toBe(true);
    expect(grown.instanceCount).toBe(5);
    expect((grown.getAttribute('iBase') as THREE.InstancedBufferAttribute).count).toBeGreaterThanOrEqual(5);
    expect((grown.getAttribute('iBase').array as Float32Array)[12]).toBe(4);
    S.update(new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]), 1);
    expect(Array.from((grown.getAttribute('iFlick').array as Float32Array).slice(0, 5)).map((x) => +x.toFixed(1))).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
    S.set([]);
    expect(S.count).toBe(0);
    expect(S.group.children.every((c) => !c.visible)).toBe(true);
  });

  it('the halo fades smoothly into surfaces near the flame instead of being cut in a line', () => {
    // a torch's glow (0.24 m flame × haloSize) is a gaussian ~13 cm wide; its stick runs through it
    const s = haloSigma(0.24 * LOOKS.torch.haloSize);
    expect(s).toBeGreaterThan(0.1); expect(s).toBeLessThan(0.16);
    expect(glowInFront(5, 5, s)).toBeCloseTo(0.5, 5); // a surface through the flame's centre gets the front half
    expect(glowInFront(5 + 4 * s, 5, s)).toBeGreaterThan(0.99); // well behind: all of it
    expect(glowInFront(5 - 4 * s, 5, s)).toBeLessThan(0.01); // well in front: none
    // no step anywhere: across the stick (a few cm either side of the centre) it changes gradually
    for (let d = -3 * s; d < 3 * s; d += 0.01) expect(Math.abs(glowInFront(5 + d + 0.01, 5, s) - glowInFront(5 + d, 5, s))).toBeLessThan(0.06);
    // the sprites take the scene depth: same meshes, the depth only shapes their shaders
    const fl = linkFlames([{ kind: 'torch', base: [0, 1, 0], height: 0.24 }], []);
    const S = makeFlameSprites(fl, 0, { distance: float(3), on: uniform(1) });
    expect(S.group.children.map((c) => c.name)).toEqual(['flame-smoke', 'flame-body', 'flame-halo']);
    const halo = (S.group.children[2] as THREE.Mesh).material as THREE.MeshBasicNodeMaterial;
    expect(halo.vertexNode).toBeTruthy(); expect(halo.colorNode).toBeTruthy();
  });
});
