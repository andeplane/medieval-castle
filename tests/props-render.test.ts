import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { makePropMaterials, meshFromProp, type PropTextures } from '../src/props/render';
import { makeProp } from '../src/props/kit';
import { PropMesh } from '../src/props/geom';
import type { PropTex } from '../src/props/textures';

// tiny typed fake textures: the adapter only needs sizes and byte arrays
const fake = (): PropTex => ({ size: 2, albedo: new Uint8Array(16), normal: new Uint8Array(16), rough: new Uint8Array(16) });
const textures: PropTextures = { wood: fake(), iron: fake(), cloth: fake(), straw: fake(), ceramic: fake() };

describe('prop render adapter', () => {
  const mats = makePropMaterials(textures);
  it('makes one material per bin, cloth double-sided, flame unlit', () => {
    expect(Object.keys(mats).sort()).toEqual(['ceramic', 'cloth', 'flame', 'iron', 'straw', 'wax', 'wood']);
    expect(mats.cloth.side).toBe(THREE.DoubleSide);
    expect(mats.flame).toBeInstanceOf(THREE.MeshBasicNodeMaterial);
    expect((mats.wood as THREE.MeshStandardNodeMaterial).vertexColors).toBe(true);
  });
  it('builds one mesh per non-empty material with colour attributes and a triangle count', () => {
    const p = makeProp('candlestick', 1);
    const g = meshFromProp(p.mesh, mats, 'candle');
    const used = Object.values(p.mesh.bins).filter((b) => b.triangles > 0).length;
    expect(g.children).toHaveLength(used);
    expect(g.userData.triangles).toBe(p.mesh.triangles);
    const m = g.children[0] as THREE.Mesh;
    expect(m.geometry.getAttribute('color').count).toBe(m.geometry.getAttribute('position').count);
    expect(g.children.find((c) => c.name === 'candle-flame')!.castShadow).toBe(false);
    expect(meshFromProp(new PropMesh(), mats).children).toHaveLength(0);
  });
});
