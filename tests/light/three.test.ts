import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { threeLightFactory, makeFlameSprites } from '../../src/light/three';
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
    expect(makeFlameSprites([]).group.children).toHaveLength(0);
  });
});
