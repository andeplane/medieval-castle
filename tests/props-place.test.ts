import { describe, it, expect } from 'vitest';
import { makeProp } from '../src/props/kit';
import { mergePlaced, placedFootprint, previewLayout, yawXZ } from '../src/props/place';

describe('placing props', () => {
  it('yaw rotation matches rotY', () => {
    const [x, z] = yawXZ(1, 0, Math.PI / 2); expect(x).toBeCloseTo(0); expect(z).toBeCloseTo(-1);
  });
  it('merges placed props into one mesh and moves emitters into world space', () => {
    const c = makeProp('candlestick', 1), t = makeProp('trestle-table', 1);
    const { mesh, emitters } = mergePlaced([{ prop: t, at: [0, 0, 0], yaw: 0 }, { prop: c, at: [5, 0.78, 2], yaw: Math.PI / 2 }]);
    expect(mesh.triangles).toBe(c.mesh.triangles + t.mesh.triangles);
    expect(emitters).toHaveLength(1);
    const e = c.meta.emitters[0];
    expect(emitters[0].position[1]).toBeCloseTo(0.78 + e.position[1]);
    expect(Math.hypot(emitters[0].position[0] - 5, emitters[0].position[2] - 2)).toBeCloseTo(Math.hypot(e.position[0], e.position[2]));
  });
  it('rotated footprints swap width and depth', () => {
    const p = makeProp('bench', 2);
    const [a, b, c, d] = placedFootprint({ prop: p, at: [1, 0, 1], yaw: Math.PI / 2 });
    expect(c - a).toBeCloseTo(p.bounds.max[2] - p.bounds.min[2]);
    expect(d - b).toBeCloseTo(p.bounds.max[0] - p.bounds.min[0]);
  });
  it('preview layout: every kind has a bookmark, names are unique, rooms hold their props', () => {
    const L = previewLayout(1);
    const names = L.views.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of ['kit', 'hall', 'chamber', 'store', 'drawing', 'p-bed', 'p-sconce', 'p-chimneypiece']) expect(names).toContain(n);
    expect(L.stages).toHaveLength(4);
    const room = L.placed.slice(names.filter((n) => n.startsWith('p-')).length);
    for (const p of room) {
      const [x0, z0, x1, z1] = placedFootprint(p);
      const inside = L.stages.some((s) => x0 >= s.min[0] - 0.05 && x1 <= s.max[0] + 0.05 && z0 >= s.min[2] - 0.05 && z1 <= s.max[2] + 0.05);
      expect(inside, p.prop.kind.name).toBe(true);
    }
    expect(previewLayout(2).placed[0].prop.seed).toBe(2);
  });
});

describe('collider soup', () => {
  it('turns each blocking prop collider into a 12-triangle box, skipping walk-over props', async () => {
    const { colliderSoup } = await import('../src/props/place');
    const t = makeProp('chest', 1), rug = makeProp('rug', 1);
    const soup = colliderSoup([{ prop: t, at: [2, 1, 3], yaw: 0.5 }, { prop: rug, at: [0, 0, 0], yaw: 0 }]);
    expect(soup.length).toBe(t.meta.colliders.length * 12 * 9);
    const ys = soup.filter((_, i) => i % 3 === 1);
    expect(Math.min(...ys)).toBeCloseTo(1 + t.meta.colliders[0].centre[1] - t.meta.colliders[0].half[1]);
  });
});
