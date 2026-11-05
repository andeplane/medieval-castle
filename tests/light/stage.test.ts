import { describe, it, expect } from 'vitest';
import { vaultProfile, vaultHeight, vaultShell, vaultFloor, vaultEnd, lightStage, CELLAR, TUNNEL, type Surf } from '../../src/light/stage';
import { mergePlaced } from '../../src/props/place';

/** Every triangle's winding agrees with its normal, normals are unit, UVs finite. */
function checkSurf(s: Surf) {
  expect(s.pos.length % 9).toBe(0);
  expect(s.nor.length).toBe(s.pos.length);
  expect(s.uv.length).toBe((s.pos.length / 3) * 2);
  for (let i = 0; i < s.pos.length; i += 9) {
    const p = (k: number) => [s.pos[i + k * 3], s.pos[i + k * 3 + 1], s.pos[i + k * 3 + 2]];
    const [a, b, c] = [p(0), p(1), p(2)];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const N = [s.nor[i], s.nor[i + 1], s.nor[i + 2]];
    expect(Math.hypot(...N)).toBeCloseTo(1);
    expect(n[0] * N[0] + n[1] * N[1] + n[2] * N[2]).toBeGreaterThan(0);
  }
  for (const x of s.uv) expect(Number.isFinite(x)).toBe(true);
}

describe('vault geometry', () => {
  it('profile runs floor → spring → crown → spring → floor', () => {
    const P = vaultProfile(2, 1.5, 1);
    expect(P[0]).toEqual([-2, 0]); expect(P[P.length - 1]).toEqual([2, 0]);
    expect(P[1][0]).toBeCloseTo(-2); expect(P[1][1]).toBeCloseTo(1.5);
    const mid = P[(P.length - 1) / 2];
    expect(mid[0]).toBeCloseTo(0); expect(mid[1]).toBeCloseTo(2.5);
    expect(vaultHeight(2, 1.5, 1, 0)).toBeCloseTo(2.5);
    expect(vaultHeight(2, 1.5, 1, 2)).toBeCloseTo(1.5);
    expect(vaultHeight(2, 1.5, 1, 3)).toBe(0);
    // a semicircle when rise = half width
    expect(vaultHeight(1, 1.6, 1, 0.6)).toBeCloseTo(1.6 + 0.8);
  });
  it('shell, floor and end walls face inward with metre UVs', () => {
    checkSurf(vaultShell(CELLAR));
    const f = vaultFloor(CELLAR); checkSurf(f);
    expect(f.uv[0]).toBeCloseTo(CELLAR.x0 / CELLAR.tile);
    for (const facing of [1, -1] as const) {
      checkSurf(vaultEnd(TUNNEL, 0, facing));
      checkSurf(vaultEnd(TUNNEL, 0, facing, { halfWidth: 0.5, height: 1.8, reveal: 0.6 }));
    }
    // a door leaves a hole: no wall triangle inside the opening
    const e = vaultEnd(CELLAR, 6, -1, { halfWidth: 0.6, height: 2 });
    for (let i = 0; i < e.pos.length; i += 9) {
      const cz = (e.pos[i + 2] + e.pos[i + 5] + e.pos[i + 8]) / 3, cy = (e.pos[i + 1] + e.pos[i + 4] + e.pos[i + 7]) / 3;
      expect(Math.abs(cz) < 0.6 && cy < 2).toBe(false);
    }
  });
});

describe('light stage', () => {
  const S = lightStage(1);
  it('builds clean surfaces and places fixtures with flames and lights', () => {
    checkSurf(S.walls); checkSurf(S.floors);
    const { mesh, emitters } = mergePlaced(S.placed);
    expect(emitters.filter((e) => e.kind === 'torch').length).toBeGreaterThanOrEqual(8);
    expect(emitters.some((e) => e.kind === 'candle')).toBe(true);
    expect(mesh.flames.length).toBeGreaterThan(emitters.length); // the chandelier shares one light
    // every torch flame is inside a vault, under the ceiling
    for (const f of mesh.flames) {
      const inCellar = f.base[0] > CELLAR.x0 && f.base[0] < CELLAR.x1;
      const v = inCellar ? CELLAR : TUNNEL;
      expect(f.base[1] + f.height).toBeLessThan(vaultHeight(v.halfWidth, v.spring, v.rise, f.base[2]));
      expect(f.base[1]).toBeGreaterThan(0.5);
      expect(Math.abs(f.base[2])).toBeLessThan(v.halfWidth);
    }
  });
  it('has review views and probe volumes inside the spaces', () => {
    expect(S.views.map((v) => v.name)).toEqual(['cellar', 'supper', 'torch', 'tunnel', 'door']);
    for (const v of S.volumes) for (const n of v.probes) expect(n).toBeGreaterThanOrEqual(1);
    expect(lightStage(2).placed[0].prop.seed).not.toBe(S.placed[0].prop.seed);
  });
});
