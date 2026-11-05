// 2D helpers for the interior plan: convex clipping by half-planes, areas, outlines for door and niche
// heads with a fixed vertex count (so front and back outlines of a reveal can be joined index by index).
import { type V2, add, sub, scale, dot, norm, signedArea } from '../../core/math2d';

/** Half-plane: keep points p with dot(n, p) >= c. */
export interface Half { n: V2; c: number }

export const halfFrom = (p: V2, n: V2): Half => ({ n, c: dot(n, p) });

/** Sutherland–Hodgman clip of a convex polygon (any winding is preserved). */
export function clip(poly: V2[], h: Half): V2[] {
  const out: V2[] = [];
  const f = (p: V2) => dot(h.n, p) - h.c;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return dedupe(out);
}
export const clipAll = (poly: V2[], hs: Half[]) => hs.reduce((p, h) => (p.length ? clip(p, h) : p), poly);

export function dedupe(p: V2[], eps = 1e-4): V2[] {
  const out: V2[] = [];
  for (const q of p) { const l = out[out.length - 1]; if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > eps) out.push(q); }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= eps) out.pop();
  return out;
}

export const area = (p: V2[]) => (p.length < 3 ? 0 : Math.abs(signedArea(p)));
/** Positive signed area (CCW in x,z maths = clockwise seen from above with z south, as layout.ts). */
export const orient = (p: V2[]): V2[] => (signedArea(p) < 0 ? [...p].reverse() : p);
export const leftN = (a: V2, b: V2): V2 => { const d = norm(sub(b, a)); return [-d[1], d[0]]; };

export function circlePoly(c: V2, r: number, n = 48, a0 = 0): V2[] {
  return Array.from({ length: n }, (_, i) => [c[0] + Math.cos(a0 + (i / n) * Math.PI * 2) * r, c[1] + Math.sin(a0 + (i / n) * Math.PI * 2) * r] as V2);
}

/** Separating-axis overlap test for convex polygons (touching counts as apart within eps). */
export function convexOverlap(a: V2[], b: V2[], eps = 0.02): boolean {
  for (const P of [a, b]) for (let i = 0; i < P.length; i++) {
    const p = P[i], q = P[(i + 1) % P.length], n: V2 = [-(q[1] - p[1]), q[0] - p[0]];
    const l = Math.hypot(n[0], n[1]); if (l < 1e-9) continue;
    const u: V2 = [n[0] / l, n[1] / l];
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const v of a) { const t = dot(u, v); a0 = Math.min(a0, t); a1 = Math.max(a1, t); }
    for (const v of b) { const t = dot(u, v); b0 = Math.min(b0, t); b1 = Math.max(b1, t); }
    if (a1 <= b0 + eps || b1 <= a0 + eps) return false;
  }
  return true;
}

export const centroidOf = (p: V2[]): V2 => {
  let x = 0, z = 0, A = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length], c = a[0] * b[1] - b[0] * a[1]; A += c; x += (a[0] + b[0]) * c; z += (a[1] + b[1]) * c; }
  if (Math.abs(A) < 1e-9) return p[0];
  return [x / (3 * A), z / (3 * A)];
};

/** Point on a local frame: origin o, unit along u, unit inward v. */
export const local = (o: V2, u: V2, v: V2, s: number, d: number): V2 => add(add(o, scale(u, s)), scale(v, d));

export type Head = 'round' | 'pointed' | 'flat' | 'segmental';
export const HEAD_SEG = 8;

/**
 * Opening outline in a wall's (s, y) coordinates with a fixed vertex count (HEAD_SEG + 3):
 * bottom-left, bottom-right, right springing, head points, left springing. `h` is the height to the
 * springing; the head rises `rise` above it (round: w/2, pointed ≈ 0.6 w, segmental ≈ 0.22 w).
 */
export function archOutline(cx: number, y0: number, w: number, h: number, head: Head, rise = headRise(head, w)): V2[] {
  const pts: V2[] = [[cx - w / 2, y0], [cx + w / 2, y0], [cx + w / 2, y0 + h]];
  const N = HEAD_SEG;
  for (let i = 1; i < N; i++) {
    const t = i / N; // 0 at right springing, 1 at left springing
    let x: number, y: number;
    if (head === 'flat' || rise <= 1e-3) { x = cx + w / 2 - w * t; y = y0 + h; }
    else if (head === 'round' || head === 'segmental') {
      // circular arc through both springings with the given rise
      const R = (w * w / 4 + rise * rise) / (2 * rise), yc = y0 + h + rise - R;
      const a0 = Math.atan2(y0 + h - yc, w / 2), a1 = Math.PI - a0, a = a0 + (a1 - a0) * t;
      x = cx + Math.cos(a) * R; y = yc + Math.sin(a) * R;
    } else {
      // two-centred pointed arch
      const R = (w * w / 4 + rise * rise) / w;
      const right = t <= 0.5, tt = right ? t * 2 : (1 - t) * 2;
      const ccx = right ? cx + w / 2 - R : cx - w / 2 + R;
      const aEnd = Math.atan2(rise, Math.abs(cx - ccx));
      const a = aEnd * tt;
      x = right ? ccx + Math.cos(a) * R : ccx - Math.cos(a) * R; y = y0 + h + Math.sin(a) * R;
    }
    pts.push([x, y]);
  }
  pts.push([cx - w / 2, y0 + h]);
  return pts;
}
export function headRise(head: Head, w: number) {
  return head === 'round' ? w / 2 : head === 'pointed' ? w * 0.62 : head === 'segmental' ? w * 0.22 : 0;
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export { add, sub, scale, dot, norm };
