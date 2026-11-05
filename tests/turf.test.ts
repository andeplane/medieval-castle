// The turf strip on top of the revetment, and the stone helpers the bridge and revetment are built from.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { ISLAND, MOAT_OUTER, heightAt, footDist } from '../src/world/terrain';
import { gatehouseFrame } from '../src/castle/layout';
import { bridgePlan } from '../src/castle/bridge';
import { REVET, revetmentPlan } from '../src/castle/revetment';
import { rimMask, rimTurf, rimTurfMesh } from '../src/castle/turf';
import { Builder } from '../src/castle/builder';
import { addStone, boxCorners, faceTri, rotate, wedgeCorners, BOTTOM_FACE, type V3 } from '../src/castle/rubble';
import { rngFor } from '../src/core/rng';
import { pointInPoly } from '../src/core/math2d';

const bridge = bridgePlan({ island: ISLAND, moatOuter: MOAT_OUTER, gate: gatehouseFrame(), groundAt: heightAt, rng: rngFor('bridge') });
const plan = revetmentPlan({ island: ISLAND, groundAt: heightAt, rng: rngFor('revetment'), exclude: (x, z) => pointInPoly(bridge.footprint, x, z) });
const mask = rimMask({ footDist, noise: () => 0, gate: gatehouseFrame() });
const geom = rimTurf(plan, heightAt, mask);

describe('rim mask', () => {
  it('sums to one and is muddier toward the edge', () => {
    for (const e of [0, 0.5, 1, 1.9]) { const m = mask(50, 30, e); expect(m.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6); }
    expect(mask(50, 30, 0)[3]).toBeGreaterThan(mask(50, 30, 1.9)[3]);
  });
  it('matches the terrain weights where the strip ends', () => {
    // terrain: mud = 1 - smoothstep(0.3, 2.2, e) on open lawn
    const e = REVET.turfIn, t = Math.min(1, Math.max(0, (e - 0.3) / 1.9)), mud = 1 - t * t * (3 - 2 * t);
    expect(mask(50, 30, e)[3]).toBeCloseTo(mud, 3);
  });
  it('wears a path out of the gate', () => {
    const g = gatehouseFrame(), p = [g.centre[0] + g.out[0] * 10, g.centre[1] + g.out[1] * 10];
    expect(mask(p[0], p[1], 3)[1]).toBeGreaterThan(0.5);
    expect(rimMask({ footDist: () => 99, noise: () => 0 })(p[0], p[1], 3)[1]).toBe(0);
  });
});

describe('rim turf', () => {
  it('is a closed band of finite, upward-facing quads round the island', () => {
    const { positions: P, indices: I, uvs, masks } = geom;
    expect(P.length / 3).toBe(uvs.length / 2);
    expect(P.length / 3).toBe(masks.length / 4);
    expect(I.length % 3).toBe(0);
    expect(I.length / 3).toBeGreaterThan(4000);
    expect(I.length / 3).toBeLessThan(12000);
    expect(P.every(Number.isFinite)).toBe(true);
    let up = 0, side = 0;
    for (let t = 0; t < I.length; t += 3) {
      const [a, b, c] = [I[t], I[t + 1], I[t + 2]].map((v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const ny = u[2] * v[0] - u[0] * v[2], l = Math.hypot(u[1] * v[2] - u[2] * v[1], ny, u[0] * v[1] - u[1] * v[0]);
      if (ny / l > 0.5) up++; else side++;
    }
    expect(side).toBeGreaterThan(0); // earth faces over the damaged stretches
    expect(side).toBeLessThan(up * 0.05);
  });
  it('leaves the bridge abutment uncovered', () => {
    const p = bridge.P(-1, 0);
    for (let v = 0; v < geom.positions.length / 3; v++) {
      const near = Math.hypot(geom.positions[v * 3] - p[0], geom.positions[v * 3 + 2] - p[1]) < 0.6;
      if (near) expect(Array.from(geom.indices).includes(v)).toBe(false);
    }
  });
  it('becomes a mesh with the terrain attributes', () => {
    const m = rimTurfMesh(geom, new THREE.MeshBasicNodeMaterial());
    expect(m.geometry.getAttribute('mask').itemSize).toBe(4);
    expect(m.geometry.getAttribute('normal').count).toBe(geom.positions.length / 3);
    expect(m.receiveShadow).toBe(true);
  });
});

describe('stones', () => {
  it('rotates', () => {
    const p: V3 = [1, 2, 3];
    rotate(p, 0, 0, 0).forEach((v, i) => expect(v).toBeCloseTo(p[i], 9));
    const q = rotate([1, 0, 0], Math.PI / 2, 0, 0);
    expect(q[2]).toBeCloseTo(-1, 9);
    expect(Math.hypot(...rotate(p, 0.3, -0.7, 1.1))).toBeCloseTo(Math.hypot(...p), 9);
  });
  it('builds boxes and wedges', () => {
    const pose = { c: [0, 0, 0] as V3, yaw: 0, pitch: 0, roll: 0 };
    const b = boxCorners([2, 1, 3], pose);
    expect(b[7]).toEqual([1, 0.5, 1.5]);
    const w = wedgeCorners(0.4, 0.6, 0.5, 1, pose);
    expect(w[1][0] - w[0][0]).toBeCloseTo(0.4, 9);
    expect(w[3][0] - w[2][0]).toBeCloseTo(0.6, 9);
  });
  it('chips corners and skips faces', () => {
    const B = new Builder();
    const c = boxCorners([1, 1, 1], { c: [0, 5, 0], yaw: 0.4, pitch: 0.1, roll: 0 });
    expect(addStone(B, 'old', c)).toBe(12);
    expect(addStone(B, 'old', c, { skip: [BOTTOM_FACE] })).toBe(10);
    expect(addStone(B, 'trim', c, { chips: Array(8).fill(0.1) })).toBe(6 * 6 + 8);
    expect(addStone(B, 'trim', c, { chips: Array(8).fill(0) })).toBe(12);
    // every normal points away from the stone's centre
    const { pos, nor } = B.bins.trim;
    for (let i = 0; i < pos.length; i += 9) {
      const cx = (pos[i] + pos[i + 3] + pos[i + 6]) / 3, cy = (pos[i + 1] + pos[i + 4] + pos[i + 7]) / 3 - 5, cz = (pos[i + 2] + pos[i + 5] + pos[i + 8]) / 3;
      expect(cx * nor[i] + cy * nor[i + 1] + cz * nor[i + 2]).toBeGreaterThan(0);
    }
  });
  it('drops degenerate faces', () => {
    const B = new Builder();
    expect(addStone(B, 'old', Array(8).fill([0, 0, 0]))).toBe(0);
    faceTri(B, 'old', [0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 1, 0]);
    expect(B.bins.old.pos.length).toBe(0);
    faceTri(B, 'old', [0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0]);
    expect(B.bins.old.nor[1]).toBe(1);
    faceTri(B, 'old', [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, -1]);
    expect(B.bins.old.nor[9 + 2]).toBe(-1);
  });
});
