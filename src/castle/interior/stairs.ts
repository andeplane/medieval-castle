// PLACEHOLDER until the stairs branch lands (it owns this file and replaces it at merge).
// Plain stone steps for a StairSpec: spiral wedges round a newel between landings, or a straight flight.
// Rise ≤ 0.2 m; landings are flat wedges at each landing angle.
import type { Builder } from '../builder';
import type { StairSpec } from './types';

type V3 = [number, number, number];
const TAU = Math.PI * 2;

export function buildStair(B: Builder, s: StairSpec): void {
  if (s.kind === 'spiral') spiral(B, s); else straight(B, s);
}

function spiral(B: Builder, s: StairSpec) {
  const c = s.centre!, R = s.radius!, rn = s.newel ?? 0.2, turn = s.turn ?? 1;
  const L = [...s.landings].sort((a, b) => a.y - b.y);
  const ys = [...new Set(L.map((l) => +l.y.toFixed(3)))];
  const angleAt = (y: number) => L.find((l) => Math.abs(l.y - y) < 1e-3)?.angle ?? s.startAngle ?? 0;
  B.cyl('trim', c[0], c[1], rn, rn, ys[0], ys[ys.length - 1] + 2.4, 12, { top: null });
  const wedge = (a0: number, a1: number, yTop: number, thick: number) => {
    const n = 3, poly: [number, number][] = [];
    for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; poly.push([c[0] + Math.cos(a) * rn, c[1] + Math.sin(a) * rn]); }
    for (let i = n; i >= 0; i--) { const a = a0 + ((a1 - a0) * i) / n; poly.push([c[0] + Math.cos(a) * R, c[1] + Math.sin(a) * R]); }
    B.prism('trim', poly, yTop - thick, yTop, { bottom: true });
  };
  for (let k = 0; k < ys.length; k++) {
    const y = ys[k], a = angleAt(y);
    wedge(a - 0.55, a + 0.55, y, 0.3); // landing in front of the door
    if (k === ys.length - 1) break;
    const yn = ys[k + 1], an = angleAt(yn), dy = yn - y;
    const n = Math.ceil(dy / 0.2 - 1e-6), rise = dy / n;
    // sweep from just past this landing to just before the next, at least one full turn when tall
    let sweep = ((((an - a) * turn) % TAU) + TAU) % TAU;
    while (sweep < 1.6 || sweep / n < 0.18) sweep += TAU;
    const a0 = a + 0.55 * turn, span = sweep - 1.1, da = span / n;
    for (let i = 0; i < n - 1; i++) {
      const s0 = a0 + turn * da * i, s1 = s0 + turn * da;
      wedge(Math.min(s0, s1), Math.max(s0, s1), y + rise * (i + 1), 0.35);
    }
  }
}

function straight(B: Builder, s: StairSpec) {
  const a = s.start!, b = s.end!, w = s.width;
  const dx = b[0] - a[0], dz = b[2] - a[2], L = Math.hypot(dx, dz), dy = b[1] - a[1];
  const d: [number, number] = [dx / L, dz / L];
  const n = Math.ceil(Math.abs(dy) / 0.2 - 1e-6), run = L / n, rise = dy / n;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) * run, top = a[1] + rise * (i + 1);
    const p: V3 = [a[0] + d[0] * t, 0, a[2] + d[1] * t];
    const bottom = Math.min(a[1], b[1]) - 0.05;
    B.box('trim', [p[0], (top + bottom) / 2, p[2]], [run, top - bottom, w], d);
  }
  // landings
  for (const l of s.landings) if (l.at) {
    const top = l.y, bottom = Math.min(a[1], b[1]) - 0.05;
    if (top - bottom > 0.02) B.box('trim', [l.at[0], (top + bottom) / 2, l.at[2]], [1.2, top - bottom, w], d);
  }
}
