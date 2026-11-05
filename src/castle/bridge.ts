// The old bridge across the south moat, with its middle span fallen into the water. It explains why
// the player cannot leave the island and gives the moat view a focal point.
import { rngFor } from '../core/rng';
import { type V2, add, scale, sub, norm, len, edgeDist } from '../core/math2d';
import { Builder, wallFrame, at, type Frame } from './builder';
import { GROUND } from './spec';
import { gatehouseFrame } from './layout';

type V3 = [number, number, number];

/** First point along a ray where the polygon edge is crossed (march outward). */
function hitEdge(poly: V2[], from: V2, d: V2, start: number, inside: (x: number, z: number) => boolean) {
  for (let t = start; t < 400; t += 0.25) { const p = add(from, scale(d, t)); if (!inside(p[0], p[1])) return t; }
  return 400;
}

export function buildBridge(B: Builder, island: V2[], moatOuter: V2[], pip: (poly: V2[], x: number, z: number) => boolean) {
  const r = rngFor('bridge');
  const g = gatehouseFrame();
  const d = norm(add(g.out, [0.12, 0])); // slightly skewed, as old bridges often are
  const from = g.centre;
  const t0 = hitEdge(island, from, d, 5, (x, z) => pip(island, x, z));
  const t1 = hitEdge(moatOuter, from, d, t0 + 2, (x, z) => pip(moatOuter, x, z));
  const A = add(from, scale(d, t0 - 2.5)), Z = add(from, scale(d, t1 + 2.5));
  const span = len(sub(Z, A));
  const side: V2 = [d[1], -d[0]];
  const W = 4.2, deck = GROUND + 0.35, bed = -2.6;
  const P = (t: number, s: number): V2 => add(add(A, scale(d, t)), scale(side, s));

  // abutments and two piers with cutwaters
  const piers = [span * 0.36, span * 0.66];
  const pierW = 2.2;
  const block = (t0: number, t1: number, y1: number, cut: boolean) => {
    const poly: V2[] = [P(t0, -W / 2 - 0.2), P(t1, -W / 2 - 0.2), P(t1, W / 2 + 0.2), P(t0, W / 2 + 0.2)];
    B.prism('old', poly, bed, y1);
    if (cut) for (const sgn of [-1, 1]) {
      const tip = P((t0 + t1) / 2, sgn * (W / 2 + 2.0));
      const a = P(t0, sgn * (W / 2 + 0.2)), b = P(t1, sgn * (W / 2 + 0.2));
      B.prism('old', sgn > 0 ? [a, b, tip] : [b, a, tip], bed, 1.4);
      B.prism('trim', sgn > 0 ? [a, b, tip] : [b, a, tip], 1.4, 1.65);
    }
  };
  block(-1.5, 2.0, deck, false);
  block(span - 2.0, span + 1.5, deck, false);
  for (const t of piers) block(t - pierW / 2, t + pierW / 2, deck - 0.4, true);

  // arches: first and last spans intact, the middle one fallen
  const spans: [number, number, boolean][] = [[2.0, piers[0] - pierW / 2, true], [piers[0] + pierW / 2, piers[1] - pierW / 2, false], [piers[1] + pierW / 2, span - 2.0, true]];
  for (const [a, b, intact] of spans) {
    const L = b - a, rise = Math.min(L * 0.38, deck - 1.2), spring = deck - 0.7 - rise;
    const arc = (k: number, n: number): V2 => { const tt = k / n; const x = a + L * tt; return [x, spring + rise * Math.sin(Math.PI * tt)]; };
    const n = 14;
    if (intact) {
      for (const sgn of [-1, 1]) {
        const out: V2 = scale(side, sgn);
        const f: Frame = wallFrame(P(0, sgn * W / 2), P(1, sgn * W / 2), out);
        // spandrel wall: the polygon above the arch
        const pts: V2[] = [[a, spring]];
        for (let k = 1; k < n; k++) pts.push(arc(k, n));
        pts.push([b, spring], [b, deck], [a, deck]);
        B.planar('old', f, pts, 0);
        // voussoir ring
        for (let k = 0; k < n; k++) {
          const p0 = arc(k, n), p1 = arc(k + 1, n), m = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2] as V2;
          const c = at(f, m[0], m[1] + 0.25, 0.04);
          const along: V3 = [f.r[0] * (p1[0] - p0[0]), p1[1] - p0[1], f.r[2] * (p1[0] - p0[0])];
          ringStone(B, c, along, f.n, Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) - 0.03, 0.55, 0.1);
        }
      }
      // soffit
      const f0 = wallFrame(P(0, -W / 2), P(1, -W / 2), scale(side, -1));
      for (let k = 0; k < n; k++) {
        const p0 = arc(k, n), p1 = arc(k + 1, n);
        const q = (pp: V2, s: number) => at(f0, pp[0], pp[1], -s);
        const v0 = q(p0, 0), v1 = q(p1, 0), v2 = q(p1, W), v3 = q(p0, W);
        B.bins.old.tri(v0, v1, v2, [0, -1, 0], [0, 0], [0.4, 0], [0.4, 1]);
        B.bins.old.tri(v0, v2, v3, [0, -1, 0], [0, 0], [0.4, 1], [0, 1]);
      }
      // deck with parapets
      B.prism('old', [P(a, -W / 2), P(b, -W / 2), P(b, W / 2), P(a, W / 2)], deck - 0.05, deck, { top: 'trim' });
      for (const sgn of [-1, 1]) B.prism('old', [P(a - 0.3, sgn * (W / 2 - 0.45)), P(b + 0.3, sgn * (W / 2 - 0.45)), P(b + 0.3, sgn * W / 2), P(a - 0.3, sgn * W / 2)], deck, deck + 1.0, { top: 'trim' });
    } else {
      // broken arch stubs on each pier and tumbled stones in the water
      for (const [x0, dir] of [[a, 1], [b, -1]] as [number, number][]) {
        const stub = 1.4 + r() * 0.8;
        for (let k = 0; k < 4; k++) {
          const tt = (k + 0.5) / n, x = x0 + dir * L * tt;
          if (Math.abs(x - x0) > stub) break;
          const y = spring + rise * Math.sin(Math.PI * tt);
          B.box('old', [...(P(x, 0) as V2).slice(0, 1), y, P(x, 0)[1]] as V3, [L / n + 0.05, 0.8, W], d);
        }
      }
      for (let k = 0; k < 16; k++) {
        const x = a + L * (0.15 + 0.7 * r()), s = (r() - 0.5) * (W + 3), p = P(x, s), sz = 0.6 + r() * 1.2;
        B.box(r() < 0.4 ? 'trim' : 'old', [p[0], -0.9 + r() * 0.9, p[1]], [sz * 1.4, sz, sz], norm([r() - 0.5, r() - 0.5]));
      }
    }
  }
  return { start: A, end: Z, dir: d };
}

function ringStone(B: Builder, c: V3, along: V3, n: V3, L: number, H: number, D: number) {
  const al = Math.hypot(...along); const a: V3 = [along[0] / al, along[1] / al, along[2] / al];
  const up: V3 = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
  const P = (s: number, t: number, dd: number): V3 => [c[0] + a[0] * s + up[0] * t + n[0] * dd, c[1] + a[1] * s + up[1] * t + n[1] * dd, c[2] + a[2] * s + up[2] * t + n[2] * dd];
  const hs = L / 2, ht = H / 2;
  B.bins.trim.tri(P(-hs, -ht, D), P(hs, -ht, D), P(hs, ht, D), n, [0, 0], [L / 2, 0], [L / 2, H / 2]);
  B.bins.trim.tri(P(-hs, -ht, D), P(hs, ht, D), P(-hs, ht, D), n, [0, 0], [L / 2, H / 2], [0, H / 2]);
}

export { edgeDist };
