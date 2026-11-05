// Geometry for real stones: each stone is a slightly irregular block proud of the wall, following the
// texture's (warped) joints so the stone sits exactly on its texture stone. The flat wall behind is the
// mortar. Faces sample only the interior of their texture stone, so the texture's joint lines, bevel
// shading and mortar mask never land on the geometry.
// lo (10 tris): slab. mid (22): chamfered, crisp arris. hi (84): 12-point outline, rounded and
// chipped arris, domed irregular face.
import { type Stone, type StoneFace, type V3, type MasonrySpec, masonrySpec, faceToWorld, F_EXT_L, F_EXT_R, F_CUT_L, F_CUT_R } from './layout';

export class GeoBuf {
  pos: number[] = []; nor: number[] = []; uv: number[] = []; idx: number[] = [];
  get verts() { return this.pos.length / 3; }
}

/** Integer hash of (stone seed, k) → [0, 1). */
const h1 = (s: number, k: number) => {
  let h = Math.imul(((s * 4294967296) >>> 0) ^ Math.imul(k + 1, 0x9e3779b9), 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

// scratch
const ring = new Float64Array(24); // up to 12 (s, y) points
const P = new Float64Array(24);
const side = new Uint8Array(12); // 1: on the left end, 2: on the right end (may be locked straight)
const chip = new Float64Array(12);

/** +1 when (s, y, out) is right-handed in world space, else -1 (then triangles are flipped). */
function handed(f: StoneFace) {
  const g = f.geom;
  return g.kind === 'cyl' ? -1 : -g.r[2] * g.n[0] + g.r[0] * g.n[2] > 0 ? 1 : -1;
}

/** level 0: slab (10 tris), 1: chamfered (22), 2: rounded, chipped, domed (84). */
export function writeStone(out: GeoBuf, f: StoneFace, st: Stone, level: 0 | 1 | 2, M: MasonrySpec = masonrySpec(f.mat)) {
  const hi = level === 2, K = level === 0 ? 4 : hi ? 12 : 8;
  const t0 = out.idx.length;
  const T = M.tile, old = f.mat === 'old';
  const sd = st.seed;
  const jh = M.joint * 0.5;
  // outline: the cell inset by half a joint; extended ends reach past the corner
  let x0 = st.a + (st.flags & F_EXT_L ? -M.ext : jh * (0.8 + 0.5 * h1(sd, 1)));
  let x1 = st.b - (st.flags & F_EXT_R ? -M.ext : jh * (0.8 + 0.5 * h1(sd, 2)));
  const y0 = st.ya + jh * (0.8 + 0.5 * h1(sd, 3)), y1 = st.yb - jh * (0.8 + 0.5 * h1(sd, 4));
  if (x1 - x0 < 0.05) { const m = (x0 + x1) / 2; x0 = m - 0.025; x1 = m + 0.025; }
  const w = x1 - x0, h = y1 - y0;
  const D = M.depth[0] + (M.depth[1] - M.depth[0]) * h1(sd, 5);
  const bevel = old ? M.bevel * (0.9 + 0.6 * h1(sd, 6)) : M.bevel * (0.8 + 0.5 * h1(sd, 6));
  const bw = Math.min(bevel, w * 0.3, h * 0.3);
  // corner chamfers, irregular on rubble
  const cr = (k: number) => Math.min(w * 0.3, h * 0.3, (old ? 0.04 + 0.07 * h1(sd, 10 + k) : 0.012 + 0.012 * h1(sd, 10 + k)));
  if (K === 4) {
    P.set([x0, y0, x1, y0, x1, y1, x0, y1]); side.set([1, 2, 2, 1]);
  } else {
    const c0 = cr(0), c1 = cr(1), c2 = cr(2), c3 = cr(3);
    const P8 = [x0 + c0, y0, x1 - c1, y0, x1, y0 + c1, x1, y1 - c2, x1 - c2, y1, x0 + c3, y1, x0, y1 - c3, x0, y0 + c0];
    const S8 = [0, 0, 2, 2, 0, 0, 1, 1];
    let n = 0;
    for (let i = 0; i < 8; i++) {
      P[n * 2] = P8[i * 2]; P[n * 2 + 1] = P8[i * 2 + 1]; side[n++] = S8[i];
      // hi: an extra point part-way along each long edge (bottom, right, top, left) breaks the ruled sides
      if (hi && i % 2 === 0) {
        const j = i + 1, t = 0.35 + 0.3 * h1(sd, 90 + i);
        P[n * 2] = P8[i * 2] + (P8[j * 2] - P8[i * 2]) * t; P[n * 2 + 1] = P8[i * 2 + 1] + (P8[j * 2 + 1] - P8[i * 2 + 1]) * t;
        side[n++] = i === 2 ? 2 : i === 6 ? 1 : 0;
      }
    }
  }
  // follow the texture's warped joints (not on cut or extended ends, which must stay straight)
  const wp = M.warp, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hw = w / 2, hh = h / 2;
  let us = 0, uy = 0;
  for (let i = 0; i < K; i++) {
    let s = P[i * 2], y = P[i * 2 + 1];
    const lockS = (side[i] === 1 && st.flags & (F_EXT_L | F_CUT_L)) || (side[i] === 2 && st.flags & (F_EXT_R | F_CUT_R));
    const S = s + f.u0;
    let qs = S, qy = y;
    for (let it = 0; it < 2; it++) { const W = M.warpAt(qs / T, qy / T); qs = S - wp * W[0]; qy = y - wp * W[1]; }
    if (!lockS) s = qs - f.u0;
    y = qy;
    // a little inward wobble so outlines are not ruled (more on rubble and on the hi edge points)
    const k = (old ? 0.012 : 0.003) * (hi && i % 3 === 1 ? 1.8 : 1) * h1(sd, 20 + i);
    if (!lockS) s += Math.sign(cx - s) * k;
    y += Math.sign(cy - y) * k * 0.6;
    ring[i * 2] = s; ring[i * 2 + 1] = y;
    us += s; uy += y;
  }
  // UVs: squeeze the stone toward its centre so every vertex samples the texture stone's interior,
  // clear of the joint, the texture's own bevel and its edge shading (an extended corner stone maps
  // onto its own cell, not past it)
  us /= K; uy /= K;
  const E = jh + M.bevel + 0.02, cs = (st.b - st.a) / 2, cv = (st.yb - st.ya) / 2;
  const ku = Math.min(1, Math.max(0.25 * cs, cs - E) / hw), kv = Math.min(1, Math.max(0.25 * cv, cv - E) / hh);
  const ucs = us + (st.a + st.b) / 2 - cx, ucy = uy + (st.ya + st.yb) / 2 - cy; // the cell's centre, shifted with the joints

  const inset = (i: number, t: number): [number, number] => {
    const s = ring[i * 2], y = ring[i * 2 + 1];
    const kx = Math.max(0.2, (hw - t) / hw), ky = Math.max(0.2, (hh - t) / hh);
    return [cx + (s - cx) * kx, cy + (y - cy) * ky];
  };
  const tilt = st.tilt * 0.12;
  const faceD = (s: number, y: number, k: number) => D * (old ? 0.88 + 0.12 * h1(sd, 30 + k) : 0.96 + 0.04 * h1(sd, 30 + k)) + tilt * (y - cy) + (old ? 0.01 * (h1(sd, 40) - 0.5) * (s - cx) : 0);

  const base = out.verts;
  // the sides (from the back up to the face) fold the texture inward by their depth below the face, so
  // they carry stone at its real texel density instead of one texel smeared over 6-9 cm
  const push = (s: number, y: number, d: number) => {
    const p = faceToWorld(f, s, y, d);
    out.pos.push(p[0], p[1], p[2]);
    const du = (s - us) * ku, dv = (y - uy) * kv, r = Math.hypot(du, dv);
    const k = r > 0 ? 1 - Math.min(Math.max(0, D - d), 0.7 * r) / r : 1;
    out.uv.push((ucs + du * k + f.u0) / T, (ucy + dv * k) / T);
    out.nor.push(0, 0, 0);
  };
  const back = -0.012;
  // ring 0 (back)
  for (let i = 0; i < K; i++) push(ring[i * 2], ring[i * 2 + 1], back);
  if (hi) {
    // chipped arris: some edge points are knocked back and down
    const pc = old ? 0.32 : 0.14;
    for (let i = 0; i < K; i++) chip[i] = h1(sd, 60 + i) < pc ? 0.5 + 0.5 * h1(sd, 75 + i) : 0;
    const a0 = out.verts; // arris: half-way round the rounding
    for (let i = 0; i < K; i++) { const [s, y] = inset(i, bw * (0.3 + 0.3 * chip[i])); push(s, y, faceD(s, y, i) * (0.78 - 0.12 * chip[i])); }
    strip(out, base, a0, K);
    const f0 = out.verts; // face edge (smooth normals with the arris, so it reads rounded, not bevelled)
    for (let i = 0; i < K; i++) { const [s, y] = inset(i, bw * (1 + 0.8 * chip[i])); push(s, y, faceD(s, y, i) - D * 0.2 * chip[i]); }
    strip(out, a0, f0, K);
    const bulge = D * (old ? 0.32 : 0.1) * st.bulge;
    const d0 = out.verts; // dome: an inner ring, unevenly raised, then the crown
    const dm = Math.min(hw, hh) * 0.45;
    for (let i = 0; i < K; i++) { const [s, y] = inset(i, bw + dm); push(s, y, faceD(s, y, i) + bulge * 0.7 + D * (old ? 0.16 : 0.04) * (h1(sd, 100 + i) - 0.5)); }
    strip(out, f0, d0, K);
    const centre = out.verts;
    push(cx + (h1(sd, 50) - 0.5) * w * 0.2, cy + (h1(sd, 51) - 0.5) * h * 0.2, faceD(cx, cy, 8) + bulge);
    for (let i = 0; i < K; i++) out.idx.push(centre, d0 + i, d0 + ((i + 1) % K));
  } else {
    // face ring as seen from the bevel side
    const f0 = out.verts;
    const fr: [number, number, number][] = [];
    for (let i = 0; i < K; i++) { const [s, y] = inset(i, bw); const d = faceD(s, y, i); fr.push([s, y, d]); push(s, y, d); }
    strip(out, base, f0, K);
    // face: separate vertices so the arris stays crisp
    const fc = out.verts;
    for (const [s, y, d] of fr) push(s, y, d);
    for (let i = 1; i < K - 1; i++) out.idx.push(fc, fc + i, fc + i + 1);
  }
  // extended corner stones are visible from the side: close the back
  if (st.flags & (F_EXT_L | F_EXT_R)) for (let i = 1; i < K - 1; i++) out.idx.push(base, base + i + 1, base + i);
  if (handed(f) < 0) for (let t = t0; t < out.idx.length; t += 3) { const k = out.idx[t + 1]; out.idx[t + 1] = out.idx[t + 2]; out.idx[t + 2] = k; }
  smoothNormals(out, base, t0);
}

/** Quad strip between two K-rings (outward = toward the face). */
function strip(out: GeoBuf, a: number, b: number, K: number) {
  for (let i = 0; i < K; i++) {
    const j = (i + 1) % K;
    out.idx.push(a + i, a + j, b + j, a + i, b + j, b + i);
  }
}

const tmpA: V3 = [0, 0, 0];
/** Area-weighted vertex normals for the vertices from `base` on. Triangle winding is fixed so the
 *  ring order (counter-clockwise in (s, y)) faces out of the wall. */
function smoothNormals(out: GeoBuf, base: number, t0: number) {
  const P = out.pos, N = out.nor, I = out.idx;
  for (let t = t0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    tmpA[0] = uy * vz - uz * vy; tmpA[1] = uz * vx - ux * vz; tmpA[2] = ux * vy - uy * vx;
    for (const k of [a, b, c]) { N[k] += tmpA[0]; N[k + 1] += tmpA[1]; N[k + 2] += tmpA[2]; }
  }
  for (let v = base * 3; v < N.length; v += 3) {
    const l = Math.hypot(N[v], N[v + 1], N[v + 2]) || 1;
    N[v] /= l; N[v + 1] /= l; N[v + 2] /= l;
  }
}
