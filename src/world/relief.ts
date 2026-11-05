// Mountains and far hills (game-world-generation: fields → erosion). Pure functions of the injected
// noise and rng (deps.ts) and no three.js, so the same code runs in relief.worker.ts (in parallel with texture generation) and on the
// main thread as a fallback. Broad massifs + warped ridged noise, then droplet (hydraulic) erosion and a
// thermal pass on a 512² grid over the northern and western mountains (~26 m cells).
import type { Rng } from '../core/rng';
import type { GenDeps } from './deps';

export const RN = 512;
/** grid covers x ∈ [RX0, RX0 + RSIZE], z ∈ [RZ0, RZ0 + RSIZE] */
export const RX0 = -9300, RZ0 = -9700, RSIZE = 13300, RCELL = RSIZE / (RN - 1);

const sstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const MASSIFS: [number, number, number, number, number][] = [
  // x, z, radius, height, elongation angle — broad domes that ridged noise and erosion carve up
  [-1750, -2650, 1500, 600, 0.6],    // the hill behind the castle in the hero view
  [250, -3500, 1900, 640, -0.3],
  [-3600, -900, 2000, 700, 1.2],
  [-4300, -4500, 2100, 1080, 0.2],   // highest, with snow
  [-1300, -6100, 2400, 980, -0.5],
  [-4700, 1700, 1700, 480, 0.9],
  [1700, -5900, 2100, 620, 0.1],
];

/** Uneroded relief height (metres) at world x, z: 0 within ~1 km of the castle. */
export function makeRelief0(deps: Pick<GenDeps, 'noise2'>) {
  const N = deps.noise2;
  const n1 = N('relief-a'), n2 = N('relief-b'), n3 = N('relief-c'), n4 = N('relief-d'), n5 = N('relief-e');
  const fbm = (f: (x: number, y: number) => number, x: number, z: number, o: number) => { let s = 0, a = 1, fr = 1, n = 0; for (let i = 0; i < o; i++) { s += a * f(x * fr, z * fr); n += a; a *= 0.5; fr *= 2.03; } return s / n; };
  const ridged = (x: number, z: number, o: number) => { let s = 0, a = 1, fr = 1, n = 0, w = 1; for (let i = 0; i < o; i++) { let v = 1 - Math.abs(n3(x * fr, z * fr)); v *= v * w; w = Math.min(1, Math.max(0, v * 1.6)); s += a * v; n += a; a *= 0.5; fr *= 2.1; } return s / n; };
  return (x: number, z: number) => {
    const r = Math.sqrt(x * x + z * z), ang = Math.atan2(z, x);
    const dirW = sstep(-0.2, 0.9, -Math.sin(ang) * 0.85 - Math.cos(ang) * 0.55 + 0.25);
    const wx = x + 650 * n4(x / 4200, z / 4200), wz = z + 650 * n5(x / 4200 + 3.1, z / 4200);
    const rid = ridged(wx / 2300, wz / 2300, 4);
    const broad = 0.5 + 0.5 * fbm(n1, x / 5200 + 11, z / 5200, 2);
    const ring = sstep(1300, 3300, r) * (1 - sstep(8600, 10000, r));
    let dome = 0;
    for (const [mx, mz, R, H, a] of MASSIFS) {
      const dx = x - mx, dz = z - mz, c = Math.cos(a), s = Math.sin(a);
      const u = (dx * c + dz * s) / (R * 1.35), v = (-dx * s + dz * c) / R;
      dome += H * Math.exp(-(u * u + v * v) * 1.6);
    }
    dome *= sstep(1000, 2400, r);
    let h = ring * dirW * (150 * broad + 260 * rid * broad) + dome * (0.5 + 0.42 * rid);
    h += sstep(1200, 4000, r) * (1 - dirW) * 160 * (0.5 + 0.5 * fbm(n2, x / 1600 + 7, z / 1600, 3));
    return h;
  };
}

export function erode(h: Float32Array, N: number, rng: Rng, droplets: number) {
  const P = { inertia: 0.3, capacity: 3, minCapacity: 0.001, erode: 0.2, deposit: 0.25, evaporate: 0.035, gravity: 4, maxSteps: 48, radius: 4 };
  const bx: number[] = [], by: number[] = [], bw: number[] = [];
  let wsum = 0;
  for (let dy = -P.radius; dy <= P.radius; dy++) for (let dx = -P.radius; dx <= P.radius; dx++) {
    const d = Math.hypot(dx, dy);
    if (d < P.radius) { bx.push(dx); by.push(dy); bw.push(1 - d / P.radius); wsum += 1 - d / P.radius; }
  }
  const BW = Float64Array.from(bw, (w) => w / wsum), BO = Int32Array.from(bx, (x, k) => x + by[k] * N);
  let gx = 0, gy = 0;
  const hAt = (x: number, y: number) => {
    const ix = x | 0, iy = y | 0, u = x - ix, v = y - iy, i = ix + iy * N;
    const a = h[i], b = h[i + 1], c = h[i + N], d = h[i + N + 1];
    gx = (b - a) * (1 - v) + (d - c) * v; gy = (c - a) * (1 - u) + (d - b) * u;
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
  };
  for (let n = 0, tries = 0; n < droplets && tries < droplets * 8; tries++) {
    let x = 4 + rng() * (N - 9), y = 4 + rng() * (N - 9);
    if (h[(x | 0) + (y | 0) * N] < 0.08) continue; // only where there is relief to carve
    n++;
    let dx = 0, dy = 0, speed = 1, water = 1, sediment = 0;
    for (let step = 0; step < P.maxSteps; step++) {
      const ix = x | 0, iy = y | 0, u = x - ix, v = y - iy, i = ix + iy * N;
      const h0 = hAt(x, y);
      dx = dx * P.inertia - gx * (1 - P.inertia);
      dy = dy * P.inertia - gy * (1 - P.inertia);
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-9) break;
      dx /= len; dy /= len; x += dx; y += dy;
      if (x < 4 || y < 4 || x >= N - 5 || y >= N - 5) break;
      const dh = hAt(x, y) - h0;
      const cap = Math.max(-dh * speed * water * P.capacity, P.minCapacity);
      if (sediment > cap || dh > 0) {
        const amt = dh > 0 ? Math.min(dh, sediment) : (sediment - cap) * P.deposit;
        sediment -= amt;
        h[i] += amt * (1 - u) * (1 - v); h[i + 1] += amt * u * (1 - v);
        h[i + N] += amt * (1 - u) * v; h[i + N + 1] += amt * u * v;
      } else {
        const amt = Math.min((cap - sediment) * P.erode, -dh);
        for (let k = 0; k < BW.length; k++) {
          const j = i + BO[k], w = amt * BW[k];
          const taken = w < h[j] ? w : Math.max(0, h[j]);
          h[j] -= taken; sediment += taken;
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed - dh * P.gravity));
      water *= 1 - P.evaporate;
    }
  }
}

export function thermal(h: Float32Array, N: number, talus: number, rate = 0.5, iters = 10) {
  const nb = [1, -1, N, -N];
  for (let it = 0; it < iters; it++)
    for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
      const i = x + y * N;
      let maxD = 0, sumD = 0;
      for (const o of nb) { const d = h[i] - h[i + o]; if (d > talus) { sumD += d - talus; maxD = Math.max(maxD, d); } }
      if (sumD === 0) continue;
      const move = rate * (maxD - talus) * 0.5;
      for (const o of nb) { const d = h[i] - h[i + o]; if (d > talus) { const m = (move * (d - talus)) / sumD; h[i] -= m; h[i + o] += m; } }
    }
}

/** Eroded heights R and erosion delta D (metres; − cut, + deposited) on an N² grid over the relief
 *  area (the terrain samples the RN² one; tests use a coarser N). */
export function erodeRelief(deps: GenDeps, droplets = 220000, N = RN) {
  const relief0 = makeRelief0(deps), HS = 1000, cell = N === RN ? RCELL : RSIZE / (N - 1);
  const R = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) R[i + j * N] = relief0(RX0 + i * cell, RZ0 + j * cell) / HS;
  const before = R.slice();
  erode(R, N, deps.rng('erosion'), droplets);
  thermal(R, N, (Math.tan((34 * Math.PI) / 180) * cell) / HS);
  const D = new Float32Array(N * N);
  for (let k = 0; k < N * N; k++) { D[k] = (R[k] - before[k]) * HS; R[k] *= HS; }
  return { R, D };
}
