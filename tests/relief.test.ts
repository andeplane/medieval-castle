// Mountains: the uneroded relief stays in range, and the droplet and thermal erosion passes move material
// downhill without blowing up.
import { describe, it, expect } from 'vitest';
import { makeRelief0, erode, thermal, erodeRelief, RN } from '../src/world/relief';
import { seededDeps } from '../src/world/deps';
import { fakeDeps, flatDeps } from './fakes';

const cone = (N: number, H = 1) => {
  const h = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) h[i + j * N] = Math.max(0, H - Math.hypot(i - N / 2, j - N / 2) / (N / 2));
  return h;
};

describe('mountains', () => {
  it('rise to the north and west and stay below 1.4 km', () => {
    const h = makeRelief0(seededDeps(1187));
    expect(h(0, 0)).toBe(0);
    expect(h(-1750, -2650)).toBeGreaterThan(400);
    expect(h(2500, 2500)).toBeLessThan(200);
    let max = 0;
    for (let z = -9000; z < 3000; z += 150) for (let x = -9000; x < 3000; x += 150) max = Math.max(max, h(x, z));
    expect(max).toBeLessThan(1400);
  });

  it('takes its noise from the deps', () => {
    const a = makeRelief0(flatDeps(0)), b = makeRelief0(flatDeps(0.5));
    expect(a(0, 0)).toBe(0);
    expect(a(-4300, -4500)).not.toBeCloseTo(b(-4300, -4500));
  });
});

describe('erosion', () => {
  it('carves the droplet paths and keeps heights finite', () => {
    const N = 48, h = cone(N), before = h.slice();
    erode(h, N, fakeDeps().rng('erosion'), 400);
    let changed = 0, finite = true;
    for (let k = 0; k < N * N; k++) { if (Math.abs(h[k] - before[k]) > 1e-6) changed++; if (!Number.isFinite(h[k])) finite = false; }
    expect(finite).toBe(true);
    expect(changed).toBeGreaterThan(50);
  });

  it('skips flat ground (no droplets where there is no relief)', () => {
    const N = 24, h = new Float32Array(N * N);
    erode(h, N, fakeDeps().rng('flat'), 50);
    expect(h.every((v) => v === 0)).toBe(true);
  });

  it('thermal pass slumps slopes steeper than the talus angle', () => {
    const N = 16, h = new Float32Array(N * N);
    h[8 + 8 * N] = 10;
    const total = h.reduce((s, v) => s + v, 0);
    thermal(h, N, 0.5, 0.5, 60);
    expect(h[8 + 8 * N]).toBeLessThan(3);
    expect(h.reduce((s, v) => s + v, 0)).toBeCloseTo(total, 3); // mass is conserved
  });

  it('erodes the relief grid and reports the delta', () => {
    const N = 96, { R, D } = erodeRelief(fakeDeps(), 300, N);
    expect(R).toHaveLength(N * N);
    expect(D).toHaveLength(N * N);
    let cut = 0;
    for (let k = 0; k < N * N; k++) if (D[k] < -0.01) cut++;
    expect(cut).toBeGreaterThan(0);
    expect(RN).toBe(512);
  });
});
