// The whole castle's stone data: the Builder's wall records and stone faces, laid out into one
// queryable StoneSet. Rngs and the ground are injected, so the build is reproducible and fast.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { buildCastle } from '../src/castle/castle';
import type { MatKey } from '../src/castle/builder';
import { bridgePlan, buildBridge } from '../src/castle/bridge';
import { revetmentPlan, buildRevetment } from '../src/castle/revetment';
import { islandOutline, moatOuter, gatehouseFrame } from '../src/castle/layout';
import { pointInPoly } from '../src/core/math2d';
import { mulberry32 } from '../src/core/rng';
import { StoneSet } from '../src/castle/stones/set';
import { faceBounds, F_SIL, type V3 } from '../src/castle/stones/layout';
import { GROUND } from '../src/castle/spec';

function build(seed: number) {
  const { builder } = buildCastle(mulberry32(seed));
  const island = islandOutline();
  const ground = () => GROUND;
  const bridge = bridgePlan({ island, moatOuter: moatOuter(island), gate: gatehouseFrame(), groundAt: ground, rng: mulberry32(3) });
  buildBridge(builder, bridge, mulberry32(5));
  const rev = revetmentPlan({ island, groundAt: ground, rng: mulberry32(4), exclude: (x, z) => pointInPoly(bridge.footprint, x, z) });
  buildRevetment(builder, rev, mulberry32(6));
  return builder;
}

describe('castle stones', () => {
  const B = build(11);
  const set = new StoneSet(B.stoneFaces, B.stoneExcl);

  it('the Builder records wall faces and stone faces for the exterior masonry', () => {
    expect(B.walls.length).toBeGreaterThan(100);
    for (const w of B.walls) {
      expect(typeof w.mat).toBe('string');
      expect(w.y1).toBeGreaterThan(w.y0);
      expect(Math.hypot(w.out[0], w.out[1])).toBeCloseTo(1, 6);
    }
    expect(B.stoneFaces.length).toBeGreaterThan(500);
    expect(B.stoneExcl.length).toBeGreaterThan(500);
    for (const f of B.stoneFaces) {
      expect(f.s1).toBeGreaterThan(f.s0);
      expect(f.y1).toBeGreaterThan(f.y0);
      const [lo, hi] = faceBounds(f);
      for (let k = 0; k < 3; k++) expect(hi[k]).toBeGreaterThan(lo[k]);
    }
    expect(B.stoneFaces.some((f) => f.geom.kind === 'cyl')).toBe(true);
    expect(B.stoneFaces.some((f) => f.geom.kind === 'plane' && f.geom.bat)).toBe(true);
    expect(B.stoneFaces.some((f) => f.sil)).toBe(true);
  });

  it('lays out over a hundred thousand stones, with silhouette stones on parapets and corners', () => {
    expect(set.stones.length).toBeGreaterThan(100_000);
    expect(set.stones.filter((s) => s.flags & F_SIL).length).toBeGreaterThan(5_000);
  });

  it('stonesNear finds the stones of a wall next to a point, and nothing in the open courtyard air', () => {
    const f = B.stoneFaces.find((x) => x.geom.kind === 'plane' && !x.geom.bat && x.s1 - x.s0 > 8 && x.y1 - x.y0 > 6 && x.mat === 'old')!;
    const g = f.geom as { o: V3; r: V3; n: V3 };
    const sm = (f.s0 + f.s1) / 2, ym = (f.y0 + f.y1) / 2;
    const p: V3 = [g.o[0] + g.r[0] * sm + g.n[0] * 0.5, ym, g.o[2] + g.r[2] * sm + g.n[2] * 0.5];
    const near = set.stonesNear(p, 1.5);
    expect(near.length).toBeGreaterThan(3);
    expect(near.some((s) => s.face === f)).toBe(true);
    expect(set.stonesNear([0, 200, 0], 5)).toEqual([]);
  });

  it('builds one mesh per material bin', () => {
    const m = new THREE.MeshBasicMaterial();
    const g = B.build(new Proxy({}, { get: () => m }) as Record<MatKey, THREE.Material>);
    expect(g.children.length).toBeGreaterThan(5);
    expect(new Set(g.children.map((c) => c.name)).size).toBe(g.children.length);
    expect(g.userData.triangles).toBeGreaterThan(50_000);
    expect(g.children.find((c) => c.name === 'castle-glass')?.castShadow).toBe(false);
  });

  it('is a pure function of the injected rngs', () => {
    const a = build(11), b = B;
    expect(JSON.stringify(a.stoneFaces)).toBe(JSON.stringify(b.stoneFaces));
    expect(JSON.stringify(a.walls)).toBe(JSON.stringify(b.walls));
    expect(JSON.stringify(a.stoneExcl)).toBe(JSON.stringify(b.stoneExcl));
  });
});
