// Stone revetment around the island: the bank is faced with old rubble masonry rising from the moat
// (as at Gravensteen), with a coping course, a few slumped stretches and fallen stones.
import { rngFor } from '../core/rng';
import { type V2, len, sub } from '../core/math2d';
import { Builder, offsetPoly, wallFrame } from './builder';

export function buildRevetment(B: Builder, island: V2[], groundAt: (x: number, z: number) => number, skip: (x: number, z: number) => boolean) {
  const r = rngFor('revetment');
  const ring = offsetPoly(island, -0.35);
  const inner = offsetPoly(island, -1.6);
  const n = ring.length;
  const tops = ring.map((_, i) => groundAt(inner[i][0], inner[i][1]) + 0.25 + (r() - 0.5) * 0.12);
  // slumped stretches: runs of a few segments where the facing has fallen into the moat
  const broken = new Array(n).fill(false);
  for (let k = 0; k < 3; k++) { const s = Math.floor(r() * n), L = 2 + Math.floor(r() * 3); for (let j = 0; j < L; j++) broken[(s + j) % n] = true; }
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n], L = len(sub(b, a));
    const m: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (skip(m[0], m[1])) continue;
    const d: V2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], out: V2 = [d[1], -d[0]];
    const f = wallFrame(a, b, out);
    const ta = tops[i], tb = tops[(i + 1) % n];
    if (broken[i]) {
      const h = -0.6 + r() * 0.8;
      B.planar('old', f, [[0, -2], [L, -2], [L, h + r() * 0.4], [0, h]]);
      for (let k = 0; k < 4; k++) { const t = r() * L, p: V2 = [a[0] + d[0] * t + out[0] * (0.4 + r() * 1.6), a[1] + d[1] * t + out[1] * (0.4 + r() * 1.6)], s = 0.35 + r() * 0.45; B.box('old', [p[0], -0.3 + r() * 0.5, p[1]], [s * 1.3, s, s], [r() - 0.5, r() - 0.5]); }
      continue;
    }
    B.planar('old', f, [[0, -2], [L, -2], [L, tb], [0, ta]]);
    // coping stones, slightly proud, following the top
    const cy = (ta + tb) / 2;
    B.box('trim', [m[0] - out[0] * 0.15, cy + 0.08, m[1] - out[1] * 0.15], [L + 0.04, 0.2, 0.75], d);
  }
}
