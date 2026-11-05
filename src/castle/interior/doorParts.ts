// Leaf geometry, one set per size class (doorGeom.ts), as plain arrays in leaf local coordinates:
// x hinge → latch, y up from the leaf bottom, z toward the swing space, pintle axis at x = z = 0.
// Plank leaves are real joinery: vertical oak boards with chamfered edges and gaps, shaped to the head;
// ledges and braces on the swing side (brace foot on the hinge side, so it holds the latch edge up);
// strap hinges ending in spear tips, knuckles on the pintle axis; clinched nail heads in rows on the
// show face; ring handle and escutcheon outside, thumb latch and pull ring inside. Every door is one whole
// leaf (no wicket or cutout); posterns are thick, banded and studded all over; grilles are an iron yett.
// Gates have no leaves: the portcullis (portcullis.ts) closes them.
import type { Rng } from '../../core/rng';
import type { V3 } from './types';
import { KIND, leafDepth, headTop, GROW, type LeafClass, type LeafKind } from './doorGeom';

type P2 = [number, number];
export interface PartBin { pos: number[]; nor: number[]; uv: number[] }
const bin = (): PartBin => ({ pos: [], nor: [], uv: [] });
export interface Box3 { min: V3; max: V3 }
export interface LeafGeom {
  wood: PartBin; iron: PartBin;
  /** Iron fixed to the jamb (pintles, keeper), posed with the closed leaf. */
  fixed: PartBin;
  /** Solid boxes of the leaf in local coordinates (collision and aim). */
  boxes: Box3[];
  width: number; height: number;
}

// ---------------------------------------------------------------- primitive writers

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
type UvFn = (p: V3) => P2;
const NOUV: UvFn = () => [0, 0];

/** Triangle facing `out` (winding fixed to match), flat normal. */
export function tri(b: PartBin, p0: V3, p1: V3, p2: V3, out: V3, uvf: UvFn) {
  let n = norm3(cross3(sub3(p1, p0), sub3(p2, p0)));
  if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) { [p1, p2] = [p2, p1]; n = [-n[0], -n[1], -n[2]]; }
  if (!Number.isFinite(n[0]) || (n[0] === 0 && n[1] === 0 && n[2] === 0)) return;
  for (const p of [p0, p1, p2]) { b.pos.push(...p); b.nor.push(...n); b.uv.push(...uvf(p)); }
}
function quad(b: PartBin, a: V3, c: V3, d: V3, e: V3, out: V3, uvf: UvFn) { tri(b, a, c, d, out, uvf); tri(b, a, d, e, out, uvf); }

function ccw(p: P2[]): P2[] {
  let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], q = p[(i + 1) % p.length]; s += a[0] * q[1] - q[0] * a[1]; }
  return s < 0 ? [...p].reverse() : p;
}
/** Drop points closer than eps to the previous one. */
function clean(p: P2[], eps = 1e-4): P2[] {
  const o: P2[] = [];
  for (const q of p) if (!o.length || Math.hypot(q[0] - o[o.length - 1][0], q[1] - o[o.length - 1][1]) > eps) o.push(q);
  if (o.length > 2 && Math.hypot(o[0][0] - o[o.length - 1][0], o[0][1] - o[o.length - 1][1]) <= eps) o.pop();
  return o;
}
/** Inset a convex CCW polygon by d (mitred). */
function inset(p: P2[], d: number): P2[] {
  const n = p.length;
  const lines = p.map((a, i) => {
    const q = p[(i + 1) % n], L = Math.hypot(q[0] - a[0], q[1] - a[1]) || 1;
    const nx = -(q[1] - a[1]) / L, ny = (q[0] - a[0]) / L; // left normal = inward for CCW
    return { p: [a[0] + nx * d, a[1] + ny * d] as P2, r: [q[0] - a[0], q[1] - a[1]] as P2 };
  });
  return p.map((_, i) => {
    const A = lines[(i + n - 1) % n], B = lines[i];
    const rxs = A.r[0] * B.r[1] - A.r[1] * B.r[0];
    if (Math.abs(rxs) < 1e-9) return B.p;
    const t = ((B.p[0] - A.p[0]) * B.r[1] - (B.p[1] - A.p[1]) * B.r[0]) / rxs;
    return [A.p[0] + A.r[0] * t, A.p[1] + A.r[1] * t] as P2;
  });
}

/** Convex polygon (x, y) extruded along z from zb to zf, edges chamfered by `bev` on both faces. */
export function slab(b: PartBin, poly: P2[], zb: number, zf: number, bev: number, uvf: UvFn = NOUV, caps: { front?: boolean; back?: boolean } = {}) {
  const P = ccw(clean(poly));
  if (P.length < 3) return;
  bev = Math.min(bev, (zf - zb) * 0.3);
  const cx = P.reduce((s, q) => s + q[0], 0) / P.length, cy = P.reduce((s, q) => s + q[1], 0) / P.length;
  const I = bev > 0 ? inset(P, bev) : P;
  const rings: { r: P2[]; z: number }[] = bev > 0
    ? [{ r: I, z: zf }, { r: P, z: zf - bev }, { r: P, z: zb + bev }, { r: I, z: zb }]
    : [{ r: P, z: zf }, { r: P, z: zb }];
  const zm = (zb + zf) / 2;
  for (let k = 0; k < rings.length - 1; k++) {
    const A = rings[k], B = rings[k + 1];
    for (let i = 0; i < P.length; i++) {
      const j = (i + 1) % P.length;
      const a: V3 = [A.r[i][0], A.r[i][1], A.z], c: V3 = [A.r[j][0], A.r[j][1], A.z], d: V3 = [B.r[j][0], B.r[j][1], B.z], e: V3 = [B.r[i][0], B.r[i][1], B.z];
      const mx = (a[0] + c[0] + d[0] + e[0]) / 4, my = (a[1] + c[1] + d[1] + e[1]) / 4, mz = (a[2] + c[2] + d[2] + e[2]) / 4;
      quad(b, a, c, d, e, [mx - cx, my - cy, (mz - zm) * 4], uvf);
    }
  }
  const F = rings[0].r, Bk = rings[rings.length - 1].r;
  if (caps.front !== false) for (let i = 1; i < F.length - 1; i++) tri(b, [F[0][0], F[0][1], zf], [F[i][0], F[i][1], zf], [F[i + 1][0], F[i + 1][1], zf], [0, 0, 1], uvf);
  if (caps.back !== false) for (let i = 1; i < Bk.length - 1; i++) tri(b, [Bk[0][0], Bk[0][1], zb], [Bk[i][0], Bk[i][1], zb], [Bk[i + 1][0], Bk[i + 1][1], zb], [0, 0, -1], uvf);
}
const rectP = (x0: number, y0: number, x1: number, y1: number): P2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** Nail / stud head: low pyramid on a face at z, pointing toward dir (±1). */
function stud(b: PartBin, x: number, y: number, z: number, dir: 1 | -1, a: number, h: number) {
  const tip: V3 = [x, y, z + dir * h];
  const c: V3[] = [[x - a, y - a, z], [x + a, y - a, z], [x + a, y + a, z], [x - a, y + a, z]];
  for (let i = 0; i < 4; i++) {
    const p = c[i], q = c[(i + 1) % 4];
    tri(b, p, q, tip, [(p[0] + q[0]) / 2 - x, (p[1] + q[1]) / 2 - y, dir * a], NOUV);
  }
}
/** Vertical cylinder (knuckles, pintles). */
function cylY(b: PartBin, x: number, z: number, r: number, y0: number, y1: number, seg = 8) {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p = (a: number, y: number): V3 => [x + Math.cos(a) * r, y, z + Math.sin(a) * r];
    const am = (a0 + a1) / 2;
    quad(b, p(a0, y0), p(a1, y0), p(a1, y1), p(a0, y1), [Math.cos(am), 0, Math.sin(am)], NOUV);
    tri(b, [x, y1, z], p(a0, y1), p(a1, y1), [0, 1, 0], NOUV);
    tri(b, [x, y0, z], p(a0, y0), p(a1, y0), [0, -1, 0], NOUV);
  }
}
/** Ring (torus) lying in the x-y plane at depth z: a door ring hanging flat on the leaf. */
function torus(b: PartBin, cx: number, cy: number, z: number, R: number, r: number, su = 10, sv = 4) {
  const P = (u: number, v: number): V3 => { const a = (u / su) * Math.PI * 2, t = (v / sv) * Math.PI * 2; const rr = R + Math.cos(t) * r; return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, z + Math.sin(t) * r]; };
  const C = (u: number): V3 => { const a = (u / su) * Math.PI * 2; return [cx + Math.cos(a) * R, cy + Math.sin(a) * R, z]; };
  for (let i = 0; i < su; i++) for (let j = 0; j < sv; j++) {
    const a = P(i, j), c = P(i + 1, j), d = P(i + 1, j + 1), e = P(i, j + 1);
    const m = C(i + 0.5), q = P(i + 0.5, j + 0.5);
    quad(b, a, c, d, e, sub3(q, m), NOUV);
  }
}
/** Polygonal disc plate on a face (escutcheon, ring plate). */
function plate(b: PartBin, cx: number, cy: number, z0: number, z1: number, r: number, seg = 8) {
  const pts: P2[] = Array.from({ length: seg }, (_, i) => [cx + Math.cos((i / seg) * Math.PI * 2) * r, cy + Math.sin((i / seg) * Math.PI * 2) * r]);
  slab(b, pts, Math.min(z0, z1), Math.max(z0, z1), 0.002);
}

// ---------------------------------------------------------------- layout helpers

/** Board edges across [0, W]: seeded widths 0.17–0.30 m, gap between boards. */
function boardEdges(W: number, r: Rng, gap: number, target = 0.23): [number, number][] {
  const n = Math.max(2, Math.round(W / target));
  const ws = Array.from({ length: n }, () => 0.8 + r() * 0.4);
  const sum = ws.reduce((a, b) => a + b, 0), avail = W - gap * (n - 1);
  const out: [number, number][] = [];
  let x = 0;
  for (let i = 0; i < n; i++) { const w = (ws[i] / sum) * avail; out.push([x, x + w]); x += w + gap; }
  out[n - 1][1] = W;
  return out;
}
/** Polygon of the part of [x0, x1] × [y0, top(x)] (top sampled, apex kept). */
function underTop(x0: number, x1: number, y0: number, top: (x: number) => number, flat: boolean, apexX: number | null, yCap = Infinity): P2[] {
  const xs: number[] = [];
  const k = flat ? 1 : Math.max(2, Math.ceil((x1 - x0) / 0.06));
  for (let i = 0; i <= k; i++) xs.push(x0 + ((x1 - x0) * i) / k);
  if (apexX !== null && apexX > x0 + 1e-3 && apexX < x1 - 1e-3) { xs.push(apexX); xs.sort((a, b) => a - b); }
  const pts: P2[] = [[x0, y0], [x1, y0]];
  for (let i = xs.length - 1; i >= 0; i--) pts.push([xs[i], Math.min(yCap, top(xs[i]))]);
  return pts;
}

/** Plank texture: six planks per tile across u, grain along v; each board gets one whole plank. */
const boardUV = (x0: number, x1: number, plank: number, vOff: number): UvFn => (p) => [(plank + 0.08 + 0.84 * Math.min(1, Math.max(0, (p[0] - x0) / (x1 - x0)))) / 6, p[1] / 2 + vOff];
const ledgeUV = (y0: number, y1: number, plank: number, uOff: number): UvFn => (p) => [(plank + 0.08 + 0.84 * Math.min(1, Math.max(0, (p[1] - y0) / (y1 - y0)))) / 6, p[0] / 2 + uOff];

// ---------------------------------------------------------------- leaves

interface PlankOpts { W: number; H: number; top: (x: number) => number; flat: boolean; apexX: number | null; kind: LeafKind; r: Rng }

/** Ledges' (y0, y1) pairs for a leaf: bottom, top below the lowest edge of the head, and middles. */
function ledgeRows(edgeTop: number, kind: LeafKind): [number, number][] {
  const lh = kind === 'postern' ? 0.16 : 0.15;
  const bottom = 0.14;
  const topY1 = edgeTop - 0.1, top0 = topY1 - lh;
  const base: [number, number][] = [[bottom, bottom + lh]];
  if (top0 > base[base.length - 1][1] + 0.25) base.push([top0, topY1]);
  // middle ledges keep spans ≤ ~1 m and stay clear of the latch height
  const rows = [...base];
  const maxSpan = 1.05;
  for (let i = 0; i < base.length - 1; i++) {
    const a = base[i][1], b = base[i + 1][0], span = b - a, n = Math.floor(span / maxSpan);
    for (let k = 1; k <= n; k++) {
      let y = a + (span * k) / (n + 1) - lh / 2;
      if (y + lh > 0.88 && y < 1.2) y = Math.max(a + 0.25, 0.88 - lh - 0.02);
      rows.push([y, y + lh]);
    }
  }
  return rows.sort((a, b) => a[0] - b[0]);
}

function plankLeaf(o: PlankOpts, g: LeafGeom) {
  const { W, top, kind, r } = o;
  const { t, ledge: L } = KIND[kind];
  const { zFront: zf, zBack: zb } = leafDepth(kind);
  const boards = boardEdges(W, r, 0.004, kind === 'postern' ? 0.2 : 0.23);
  const bev = Math.min(0.012, t * 0.15);
  const planks = boards.map(() => Math.floor(r() * 6)), vOffs = boards.map(() => r() * 4);
  // whole boards, each shaped to the head
  boards.forEach(([x0, x1], i) => slab(g.wood, underTop(x0, x1, 0, top, o.flat, o.apexX), zb, zf, bev, boardUV(x0, x1, planks[i], vOffs[i])));
  const edgeTop = Math.min(top(0.04), top(W - 0.04));
  const rows = ledgeRows(edgeTop, kind);
  const lx0 = 0.04, lx1 = W - lx0;
  const lb = 0.006;
  rows.forEach(([y0, y1], i) => slab(g.wood, rectP(lx0, y0, lx1, y1), zf, zf + L, lb, ledgeUV(y0, y1, (i * 2 + 1) % 6, r() * 3)));
  // braces between ledges, foot on the hinge side (x small), head on the latch side
  const bw = 0.15;
  for (let i = 0; i < rows.length - 1; i++) {
    const ya = rows[i][1], yb = rows[i + 1][0];
    if (yb - ya < 0.35) continue;
    const xa = lx0 + 0.02, xb = lx1 - 0.02;
    const poly: P2[] = [[xa, ya], [xa + bw, ya], [xb, yb], [xb - bw, yb]];
    const dx = xb - xa, dy = yb - ya, l = Math.hypot(dx, dy);
    const across = (bw * dy) / l;
    const uvf: UvFn = (p) => [(4 + 0.08 + 0.84 * Math.min(1, Math.max(0, -((p[0] - xa) * -dy + (p[1] - ya) * dx) / l / across))) / 6, ((p[0] - xa) * dx + (p[1] - ya) * dy) / l / 2];
    slab(g.wood, poly, zf, zf + L * 0.85, lb, uvf);
  }
  // iron: strap hinges with spear tips on chosen ledges, knuckles on the pintle axis
  // plank doors hang on two straps, posterns on every ledge
  const strapRows = kind === 'postern' ? rows : [rows[0], rows[rows.length - 1]];
  const sw = 0.06, st = 0.007;
  const sLen = W * 0.78;
  const zs0 = zf + L, zs1 = zf + L + st;
  for (const [y0, y1] of strapRows) {
    const yc = (y0 + y1) / 2, hw = sw / 2, tip = sw * 1.4;
    const len = sLen;
    slab(g.iron, [[0, yc - hw], [len - tip, yc - hw], [len - tip * 0.55, yc - hw * 1.5], [len, yc], [len - tip * 0.55, yc + hw * 1.5], [len - tip, yc + hw]], zs0, zs1, 0.0015);
    slab(g.iron, [[0, yc - hw], [0.02, yc - hw], [0.02, yc + hw], [0, yc + hw]], zs0 - 0.004, zs1, 0); // wrap to the knuckle
    cylY(g.iron, 0, 0, 0.017, yc - hw * 0.95, yc + hw * 0.95, 8);
    for (let x = 0.12; x < len - tip; x += 0.2) stud(g.iron, x, yc, zs1, 1, 0.009, 0.006);
    // pintle on the jamb: pin through the knuckle, arm leaded into the stone
    cylY(g.fixed, 0, 0, 0.007, yc - hw - 0.04, yc + hw + 0.02, 6);
    slab(g.fixed, rectP(-0.14, yc - hw - 0.075, 0.004, yc - hw - 0.035), -0.018, 0.018, 0.002);
  }
  // show face: clinched nail heads, two rows on every ledge, one per board each
  const sa = 0.014, sh = 0.01;
  for (const [y0, y1] of rows) for (const yy of [y0 + 0.045, y1 - 0.045]) for (const [x0, x1] of boards) stud(g.iron, (x0 + x1) / 2, yy, zb, -1, sa, sh);
  if (kind === 'postern') {
    // iron bands across the show face, studded where they cross boards
    const bands = rows.map(([y0, y1]) => (y0 + y1) / 2);
    for (const y of bands) {
      const hw = 0.035;
      slab(g.iron, rectP(0.01, y - hw, W - 0.01, y + hw), zb - 0.006, zb, 0.0015);
      for (const [x0, xb] of boards) stud(g.iron, (x0 + xb) / 2, y, zb - 0.006, -1, 0.016, 0.012);
    }
    // diamond grid of studs between the bands
    for (let y = 0.3; y < o.H - 0.1; y += 0.13) for (let x = 0.08 + ((Math.round(y / 0.13) % 2) * 0.065); x < W - 0.05; x += 0.13) {
      if (y > top(x) - 0.08 || bands.some((b) => Math.abs(b - y) < 0.07)) continue;
      stud(g.iron, x, y, zb, -1, 0.013, 0.01);
    }
  }
  // handles: ring and escutcheon outside, thumb latch, keeper and pull ring inside
  const hy = kind === 'postern' ? 0.9 : 1.0;
  const hx = W - 0.15;
  const ringR = 0.07;
  plate(g.iron, hx, hy, zb - 0.006, zb, ringR * 0.75, 8);
  slab(g.iron, rectP(hx - 0.012, hy - 0.03, hx + 0.012, hy + 0.012), zb - 0.022, zb - 0.006, 0.002);
  torus(g.iron, hx, hy - ringR, zb - 0.022, ringR, 0.009, 10, 3);
  {
    slab(g.iron, rectP(hx - 0.03, hy + 0.13, hx + 0.03, hy + 0.25), zb - 0.003, zb, 0.001);
    slab(g.iron, rectP(hx - 0.006, hy + 0.165, hx + 0.006, hy + 0.205), zb - 0.0045, zb - 0.003, 0); // keyhole (dark slot)
    const ly = hy + 0.04, lz0 = zf + 0.012, lz1 = zf + 0.022;
    slab(g.iron, rectP(W - 0.36, ly - 0.012, W + 0.03, ly + 0.012), lz0, lz1, 0.002);
    slab(g.iron, rectP(W - 0.36, ly - 0.025, W - 0.33, ly + 0.025), zf, lz1, 0.001);
    slab(g.iron, rectP(W - 0.14, ly - 0.035, W - 0.11, ly + 0.035), zf, lz1 + 0.01, 0.001); // staple guiding the bar
    slab(g.fixed, rectP(W - 0.005, ly - 0.03, W + 0.07, ly + 0.03), zf, lz1 + 0.012, 0.002); // keeper on the jamb
    plate(g.iron, W - 0.22, hy - 0.1, zf, zf + 0.005, 0.035, 6);
    torus(g.iron, W - 0.22, hy - 0.1 - 0.045, zf + 0.012, 0.045, 0.007, 10, 3);
  }
}

function grilleLeaf(W: number, H: number, top: (x: number) => number, g: LeafGeom) {
  const { zFront: zf, zBack: zb } = leafDepth('grille');
  const s = 0.035, h = s / 2, sp = 0.2;
  const zh0 = zf, zh1 = zf + KIND.grille.ledge;
  const n = Math.max(2, Math.round((W - 2 * h) / sp));
  for (let i = 0; i <= n; i++) {
    const x = h + ((W - 2 * h) * i) / n;
    const yt = Math.min(top(Math.max(0, x - h)), top(Math.min(W, x + h)));
    slab(g.iron, rectP(x - h, 0, x + h, yt - (i === 0 || i === n ? 0 : 0.01)), zb, zf, 0.003);
  }
  const m = Math.max(2, Math.round((H - 0.1) / sp));
  for (let j = 0; j <= m; j++) {
    const y = h + 0.02 + j * sp;
    let xa = -1, xb = -1;
    for (let x = 0; x <= W + 1e-6; x += 0.005) if (top(x) - h - 0.01 >= y + h) { if (xa < 0) xa = x; xb = x; }
    if (xa < 0 || xb - xa < 0.1) continue;
    slab(g.iron, rectP(xa, y - h, xb, y + h), zh0, zh1, 0.003);
  }
  // head bar following the outline
  const k = 18;
  for (let i = 0; i < k; i++) {
    const xa = (W * i) / k, xb = (W * (i + 1)) / k, ya = top(xa), yb = top(xb);
    slab(g.iron, [[xa, ya - s], [xb, yb - s], [xb, yb], [xa, ya]], zb, zf, 0.003);
  }
  // hinge plates, knuckles and pintles; a drop bolt at the latch side
  for (const yc of [0.25, Math.min(H, top(0)) - 0.25]) {
    slab(g.iron, rectP(0, yc - 0.03, 0.42, yc + 0.03), zh1 - 0.01, zh1 + 0.002, 0.0015);
    cylY(g.iron, 0, 0, 0.017, yc - 0.03, yc + 0.03, 8);
    cylY(g.fixed, 0, 0, 0.007, yc - 0.07, yc + 0.05, 6);
    slab(g.fixed, rectP(-0.14, yc - 0.1, 0.004, yc - 0.06), -0.018, 0.018, 0.002);
  }
  slab(g.iron, rectP(W - 0.1, 0.9, W - 0.07, 1.25), zh1, zh1 + 0.02, 0.002);
}

/** Geometry for one leaf class. `r` seeds board widths and grain offsets. */
export function leafGeometry(cls: LeafClass, r: Rng): LeafGeom {
  const kind = cls.kind;
  const sill = KIND[kind].sill;
  const topO = headTop(cls.head, cls.ow, cls.oh, -GROW);
  const top = (x: number) => topO(cls.sOff + x) - sill; // leaf local x → opening s
  const W = cls.width;
  const apexS = 0, apexX = cls.head === 'pointed' && apexS - cls.sOff <= W ? apexS - cls.sOff : null;
  let H = 0; for (let x = 0; x <= W; x += W / 40) H = Math.max(H, top(x));
  const { zBack } = leafDepth(kind);
  const g: LeafGeom = { wood: bin(), iron: bin(), fixed: bin(), boxes: [], width: W, height: H };
  if (kind === 'grille') {
    grilleLeaf(W, H, top, g);
    g.boxes.push({ min: [0, 0, zBack], max: [W, H, 0] });
    return g;
  }
  plankLeaf({ W, H, top, flat: cls.head === 'flat', apexX, kind, r }, g);
  g.boxes.push({ min: [0, 0, zBack], max: [W, H, 0] });
  return g;
}

/** Mirror a bin in x (for leaves hinged on the other hand): flip x, normals and winding. */
export function mirrorX(b: PartBin): PartBin {
  const o = bin();
  for (let i = 0; i < b.pos.length; i += 9) {
    for (const k of [0, 2, 1]) {
      o.pos.push(-b.pos[i + k * 3], b.pos[i + k * 3 + 1], b.pos[i + k * 3 + 2]);
      o.nor.push(-b.nor[i + k * 3], b.nor[i + k * 3 + 1], b.nor[i + k * 3 + 2]);
    }
    const j = (i / 9) * 6;
    for (const k of [0, 2, 1]) o.uv.push(b.uv[j + k * 2], b.uv[j + k * 2 + 1]);
  }
  return o;
}
