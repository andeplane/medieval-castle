// Barrel-vaulted stone tunnel along a straight path whose floor may rise or fall: level runs are flagged,
// slopes become steps (≤ 0.2 m rise). Standalone so other scenes (e.g. a loading screen) can reuse it.
import { ShapeUtils, Vector2 } from 'three/webgpu';
import type { Builder, MatKey } from '../builder';
import type { V2 } from '../../core/math2d';

type V3 = [number, number, number];
export interface TunnelOpts {
  width: number;            // clear width between the walls
  crown: number;            // floor to crown of the vault
  wall?: MatKey;            // walls + vault (default 'old')
  floor?: MatKey;           // flags and steps (default 'trim')
  rib?: MatKey | null;      // transverse ribs every `ribEvery` m (default 'trim'), null for none
  ribEvery?: number;
  maxRise?: number;         // tallest step (default 0.2)
  /** Holes in the end caps, as world-space outlines lying in the cap planes (doors, grilles). */
  caps?: { start?: V3[][]; end?: V3[][] };
  arcSeg?: number;
}

/** Cross-section (u across, y above the floor line) of wall + semicircular vault, left wall bottom first. */
export function tunnelSection(width: number, crown: number, seg = 12, below = 0.3): V2[] {
  const hw = width / 2, spring = crown - hw;
  const pts: V2[] = [[-hw, -below], [-hw, spring]];
  for (let i = 1; i < seg; i++) { const a = Math.PI - (Math.PI * i) / seg; pts.push([Math.cos(a) * hw, spring + Math.sin(a) * hw]); }
  pts.push([hw, spring], [hw, -below]);
  return pts;
}

export function buildTunnel(B: Builder, path: V3[], o: TunnelOpts): { triangles: number } {
  const wallM = o.wall ?? 'old', floorM = o.floor ?? 'trim', ribM = o.rib === undefined ? 'trim' : o.rib;
  const hw = o.width / 2, maxRise = o.maxRise ?? 0.2;
  const start = path[0], end = path[path.length - 1];
  const dx = end[0] - start[0], dz = end[2] - start[2], len = Math.hypot(dx, dz);
  const dir: V2 = [dx / len, dz / len], side: V2 = [-dir[1], dir[0]];
  const sec = tunnelSection(o.width, o.crown, o.arcSeg ?? 12);
  const before = Object.values(B.bins).reduce((s, b) => s + b.pos.length, 0);
  const W = (t: number, u: number, y: number): V3 => [start[0] + dir[0] * t + side[0] * u, y, start[2] + dir[1] * t + side[1] * u];
  const tOf = (p: V3) => (p[0] - start[0]) * dir[0] + (p[2] - start[2]) * dir[1];
  const wallBin = B.bins[wallM], T = 4;
  const arcLen = [0]; for (let i = 1; i < sec.length; i++) arcLen.push(arcLen[i - 1] + Math.hypot(sec[i][0] - sec[i - 1][0], sec[i][1] - sec[i - 1][1]));

  // walls and vault: quads between consecutive sections (each section vertical, offset by the floor line)
  for (let k = 0; k < path.length - 1; k++) {
    const t0 = tOf(path[k]), t1 = tOf(path[k + 1]), y0 = path[k][1], y1 = path[k + 1][1];
    for (let i = 0; i < sec.length - 1; i++) {
      const a = sec[i], b = sec[i + 1];
      const A = W(t0, a[0], y0 + a[1]), Bp = W(t0, b[0], y0 + b[1]), C = W(t1, b[0], y1 + b[1]), D = W(t1, a[0], y1 + a[1]);
      // inward normal: toward the section's axis at the spring line
      const mu = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, sp = o.crown - hw;
      let nu = -mu, ny = Math.max(0, sp - my) > 0 ? 0 : sp - my;
      if (Math.abs(a[0] - b[0]) < 1e-6) { nu = -Math.sign(a[0]); ny = 0; }
      const l = Math.hypot(nu, ny) || 1;
      const n: V3 = [side[0] * nu / l, ny / l, side[1] * nu / l];
      const ua = arcLen[i] / T, ub = arcLen[i + 1] / T;
      wallBin.tri(A, Bp, C, n, [t0 / T, ua], [t0 / T, ub], [t1 / T, ub]);
      wallBin.tri(A, C, D, n, [t0 / T, ua], [t1 / T, ub], [t1 / T, ua]);
    }
  }
  // floor: flags on level runs, steps on slopes
  const fb = B.bins[floorM], up: V3 = [0, 1, 0];
  const quad = (bin: typeof fb, a: V3, b: V3, c: V3, d: V3, n: V3, uv: (p: V3) => [number, number]) => { bin.tri(a, b, c, n, uv(a), uv(b), uv(c)); bin.tri(a, c, d, n, uv(a), uv(c), uv(d)); };
  const flat = (p: V3): [number, number] => [p[0] / 2, p[2] / 2];
  for (let k = 0; k < path.length - 1; k++) {
    const t0 = tOf(path[k]), t1 = tOf(path[k + 1]), y0 = path[k][1], y1 = path[k + 1][1], dy = y1 - y0;
    if (Math.abs(dy) < 1e-4) { quad(fb, W(t0, -hw, y0), W(t0, hw, y0), W(t1, hw, y0), W(t1, -hw, y0), up, flat); continue; }
    const n = Math.max(1, Math.ceil(Math.abs(dy) / maxRise - 1e-6)), run = (t1 - t0) / n, rise = dy / n;
    const riserN: V3 = dy > 0 ? [-dir[0], 0, -dir[1]] : [dir[0], 0, dir[1]];
    const side2 = (p: V3): [number, number] => [((p[0] - start[0]) * side[0] + (p[2] - start[2]) * side[1]) / 2, p[1] / 2];
    for (let i = 0; i < n; i++) {
      const ta = t0 + i * run, tb = ta + run;
      const yt = dy > 0 ? y0 + (i + 1) * rise : y0 + i * rise;
      quad(fb, W(ta, -hw, yt), W(ta, hw, yt), W(tb, hw, yt), W(tb, -hw, yt), up, flat);
      if (dy > 0) { const yp = y0 + i * rise; quad(fb, W(ta, -hw, yp), W(ta, hw, yp), W(ta, hw, yt), W(ta, -hw, yt), riserN, side2); }
      else { const yn = i === n - 1 ? y1 : y0 + (i + 1) * rise; quad(fb, W(tb, -hw, yt), W(tb, hw, yt), W(tb, hw, yn), W(tb, -hw, yn), riserN, side2); }
    }
  }
  // end caps (facing into the tunnel) with door holes
  const cap = (p: V3, t: number, facing: 1 | -1, holes: V3[][]) => {
    const pts = sec.map(([u, y]) => new Vector2(u, p[1] + y));
    const hs = holes.map((h) => h.map((q) => new Vector2((q[0] - start[0]) * side[0] + (q[2] - start[2]) * side[1], q[1])));
    const tris = ShapeUtils.triangulateShape(pts, hs);
    const all = [...pts, ...hs.flat()];
    const n: V3 = [dir[0] * facing, 0, dir[1] * facing];
    for (const [i, j, k] of tris) {
      const P = [all[i], all[j], all[k]];
      wallBin.tri(W(t, P[0].x, P[0].y), W(t, P[1].x, P[1].y), W(t, P[2].x, P[2].y), n, [P[0].x / T, P[0].y / T], [P[1].x / T, P[1].y / T], [P[2].x / T, P[2].y / T]);
    }
  };
  cap(start, 0, 1, o.caps?.start ?? []);
  cap(end, len, -1, o.caps?.end ?? []);
  // transverse ribs: thin arches proud of the vault
  if (ribM) {
    const every = o.ribEvery ?? 3.2, rb = B.bins[ribM];
    for (let t = every; t < len - 0.8; t += every) {
      // floor height under the rib
      let y = start[1];
      for (let k = 0; k < path.length - 1; k++) { const a = tOf(path[k]), b = tOf(path[k + 1]); if (t >= a && t <= b) y = path[k][1] + (path[k + 1][1] - path[k][1]) * ((t - a) / Math.max(1e-6, b - a)); }
      const inner = tunnelSection(o.width - 0.24, o.crown - 0.12, o.arcSeg ?? 12, 0);
      for (const tt of [t - 0.15, t + 0.15]) {
        const f: 1 | -1 = tt < t ? -1 : 1, n: V3 = [dir[0] * f, 0, dir[1] * f];
        for (let i = 1; i < sec.length - 2; i++) {
          const a = sec[i], b = sec[i + 1], ai = inner[i], bi = inner[i + 1];
          rb.tri(W(tt, a[0], y + a[1]), W(tt, b[0], y + b[1]), W(tt, bi[0], y + bi[1]), n, [0, 0], [0.2, 0], [0.2, 0.1]);
          rb.tri(W(tt, a[0], y + a[1]), W(tt, bi[0], y + bi[1]), W(tt, ai[0], y + ai[1]), n, [0, 0], [0.2, 0.1], [0, 0.1]);
        }
      }
      for (let i = 1; i < inner.length - 2; i++) {
        const a = inner[i], b = inner[i + 1], mu = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2 - (o.crown - 0.12 - (o.width - 0.24) / 2);
        const l = Math.hypot(mu, my) || 1, n: V3 = [-side[0] * mu / l, -my / l, -side[1] * mu / l];
        rb.tri(W(t - 0.15, a[0], y + a[1]), W(t + 0.15, a[0], y + a[1]), W(t + 0.15, b[0], y + b[1]), n, [0, 0], [0.15, 0], [0.15, 0.2]);
        rb.tri(W(t - 0.15, a[0], y + a[1]), W(t + 0.15, b[0], y + b[1]), W(t - 0.15, b[0], y + b[1]), n, [0, 0], [0.15, 0.2], [0, 0.2]);
      }
    }
  }
  const after = Object.values(B.bins).reduce((s, b) => s + b.pos.length, 0);
  return { triangles: (after - before) / 9 };
}
