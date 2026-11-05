import { describe, it, expect } from 'vitest';
import { furnish } from '../src/props/furnish';
import { makePropMaterials } from '../src/props/render';
import type { PropTex } from '../src/props/textures';
import { makeProp } from '../src/props/kit';
import type { Dressing } from '../src/props/dress';
import type { InteriorPlan } from '../src/castle/interior/types';

const fake = (): PropTex => ({ size: 2, albedo: new Uint8Array(16), normal: new Uint8Array(16), rough: new Uint8Array(16) });
const mats = makePropMaterials({ wood: fake(), iron: fake(), cloth: fake(), straw: fake(), ceramic: fake() });

describe('furnish', () => {
  it('builds one object per group with emitters and colliders, from an injected dressing', () => {
    const placed = [{ prop: makeProp('chest', 1), at: [0, 0, 0] as [number, number, number], yaw: 0 }, { prop: makeProp('sconce', 1), at: [1, 2, 0] as [number, number, number], yaw: 0 }];
    const dressing: Dressing = { rooms: [], byGroup: new Map([['N:1', placed]]) };
    const plan: InteriorPlan = { rooms: [], doors: [], stairs: [] };
    const f = furnish(plan, mats, { dress: () => dressing });
    expect([...f.objects.keys()]).toEqual(['N:1']);
    expect(f.objects.get('N:1')!.name).toBe('furniture:N:1');
    expect(f.props).toBe(2);
    expect(f.triangles).toBe(placed[0].prop.mesh.triangles + placed[1].prop.mesh.triangles);
    expect(f.emitters.get('N:1')).toHaveLength(1);
    expect(f.collision.get('N:1')!.getAttribute('position').count).toBe(36);
  });
  it('uses the real dressing by default', () => {
    expect(furnish({ rooms: [], doors: [], stairs: [] }, mats).objects.size).toBe(0);
  });
});
