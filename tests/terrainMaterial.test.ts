// The node materials build without a GPU (shader graphs only compile when rendered).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { makeTerrainMaterial, hazeColor, type GroundData } from '../src/world/terrainMaterial';
import { fieldLayout } from '../src/world/fields';
import { fakeDeps } from './fakes';

describe('terrain material', () => {
  it('builds the terrain, rock and stream materials and an empty relief texture', () => {
    const N = 8, px = () => new Uint8Array(N * N * 4).fill(128);
    const G: GroundData = { size: N, grass: px(), dirt: px(), rock: px(), mud: px(), normal: px() };
    const m = makeTerrainMaterial(G, new THREE.DataTexture(px(), N, N), fieldLayout(fakeDeps()), 64);
    expect(m).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
    expect(m.colorNode).toBeTruthy();
    const ud = m.userData as { rock: THREE.Material; stream: THREE.Material; reliefTex: THREE.DataTexture; timings: Record<string, number> };
    expect(ud.rock).toBeInstanceOf(THREE.Material);
    expect(ud.stream).toBeInstanceOf(THREE.Material);
    expect(ud.reliefTex.image.width).toBe(512);
    expect(ud.timings.fieldMapMs).toBeGreaterThanOrEqual(0);
    expect(hazeColor.value).toBeInstanceOf(THREE.Color);
  });
});
