// Procedural texture generation on the CPU (typed arrays, no canvas): tileable masonry, slate, ground,
// noise and water normals. Asset order from game-asset-pipeline: procedural first, nothing downloaded.
// Masonry is laid out like the real wall will be (irregular courses, stone lengths 0.3–1.0 m), so the
// look we approve now matches the breakable stones later.
import { mulberry32, hashSeed, type Rng } from '../core/rng';

/** Tileable value noise. Coordinates in [0,1) wrap; `freq` must be an integer. */
export class TileNoise {
  private tables = new Map<number, Float32Array>();
  constructor(private seed: number) {}
  private table(f: number) {
    let t = this.tables.get(f);
    if (!t) { const r = mulberry32(this.seed + f * 7919); t = new Float32Array(f * f); for (let i = 0; i < t.length; i++) t[i] = r() * 2 - 1; this.tables.set(f, t); }
    return t;
  }
  /** one octave, range about -1..1 */
  n(u: number, v: number, f: number) {
    const t = this.table(f);
    const x = (u - Math.floor(u)) * f, y = (v - Math.floor(v)) * f;
    const xi = x | 0, yi = y | 0, xf = x - xi, yf = y - yi;
    const x1 = xi + 1 === f ? 0 : xi + 1, y1 = yi + 1 === f ? 0 : yi + 1;
    const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
    const a = t[yi * f + xi], b = t[yi * f + x1], c = t[y1 * f + xi], d = t[y1 * f + x1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
  fbm(u: number, v: number, f: number, oct: number, gain = 0.5) {
    let s = 0, a = 1, n = 0;
    for (let i = 0; i < oct; i++) { s += a * this.n(u, v, f); n += a; a *= gain; f *= 2; }
    return s / n;
  }
}

export interface TexSet { size: number; albedo: Uint8Array; normal: Uint8Array; data: Uint8Array }


/** Height (0..1) to a tangent-space normal map. `alpha` (optional) fills the A channel. */
function heightToNormal(h: Float32Array, N: number, strength: number, alpha?: Uint8Array) {
  const out = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const l = h[y * N + ((x + N - 1) % N)], r = h[y * N + ((x + 1) % N)];
    const u = h[((y + N - 1) % N) * N + x], d = h[((y + 1) % N) * N + x];
    // DataTexture row 0 is v = 0 (bottom of the tile), so row y+1 is further up the wall
    let nx = (l - r) * strength, ny = (u - d) * strength, nz = 1;
    const il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz); nx *= il; ny *= il; nz *= il;
    const i = (y * N + x) * 4;
    out[i] = (nx * 0.5 + 0.5) * 255; out[i + 1] = (ny * 0.5 + 0.5) * 255; out[i + 2] = (nz * 0.5 + 0.5) * 255; out[i + 3] = alpha ? alpha[y * N + x] : 255;
  }
  return out;
}

// --------------------------------------------------------------------------------------- masonry

type RGB = [number, number, number];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const toByte = (v: number) => Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, v), 1 / 2.2) * 255)));
const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

/**
 * Stone kinds mixed in the walls (linear albedo). Grey overall, some warm and some cool, never blue:
 * Gravensteen's pale limestone, the rubble photo's darker split stones, a little brown sandstone.
 * The shader reads the kind back from the stone id (data.b) to pick grain, flecks and pitting.
 */
export const LITHS = ['granite', 'limestone', 'sandstone', 'whin', 'greywacke'] as const;
export const LITH_COL: RGB[] = [[0.285, 0.278, 0.268], [0.335, 0.322, 0.298], [0.305, 0.275, 0.24], [0.205, 0.203, 0.198], [0.255, 0.252, 0.238]];
/**
 * Close-up character per lithology, read by the shader (materials.ts): crystal grain strength, mineral
 * fleck contrast and weathering pit density. Granite is grainy and flecked, limestone pitted and smooth.
 */
export const LITH_DETAIL = {
  grain: [1.0, 0.45, 0.8, 0.35, 0.6],
  fleck: [0.5, 0.1, 0.16, 0.12, 0.22],
  pits: [0.18, 0.4, 0.26, 0.1, 0.22],
};
/** id byte = lith * 51 + 0..49, so the shader recovers the kind with floor(id * 5). */
export const encodeId = (lith: number, rand: number) => lith * 51 + Math.min(49, Math.floor(rand * 50));
export const lithOf = (idByte: number) => Math.floor(idByte / 51);

export interface MasonryOpts {
  name: string; size: number; tile: number;            // px, metres per tile
  course: [number, number]; stone: [number, number];   // course heights and stone lengths (m)
  joint: number;                                        // nominal joint width (m)
  jointVar: number;                                     // extra random inset per edge, fraction of the joint (rubble: wide, irregular joints)
  tilt: number;                                         // max slope of a stone edge (m per m): stones are not ruled rectangles
  corner: [number, number];                             // rounded corner radius range (m)
  chamfer: number;                                      // chance each corner is knocked off
  bevel: number;                                        // width of the rounded arris (m)
  warp: number;                                         // low-frequency undulation of the courses (m)
  edge: number;                                         // smooth irregularity of the outline (m)
  chip: number;                                         // depth of chipped arrises (m)
  split: number;                                        // chance a slot holds two stacked stones
  liths: number[];                                      // weight of each LITHS entry
  bright: number;                                       // per-stone brightness spread
  face: number; facets: number; dome: number;           // face roughness, split-face facets, pillowing (height units)
  pinning: number;                                      // pinning stones in wide joints
  mortarLevel: number;                                  // height of the mortar bed (0..1): rubble deep-raked, ashlar nearly flush
  cracks: number; veins: number; iron: number;          // fraction of stones with a crack / quartz vein / iron staining
  depth: number;                                        // metres spanned by height 0..1 (normal strength follows it)
  sdfRange: number;                                     // metres encoded either side of the outline in data.a
}

interface Stone {
  y0: number; y1: number;                              // course-local fraction (split stones)
  id: number; lith: number; col: RGB; bulge: number; tilt: number; face0: number;
  inset: [number, number, number, number];              // px: left, right, bottom, top
  slope: [number, number, number, number];
  rc: number; cham: [number, number, number, number]; jh: number;
  planes: number[];                                     // 3 × (a, gx, gy) split-face facets
  iron: number; vein: number[] | null; crack: number[] | null;
}
interface Slot { x0: number; x1: number; parts: Stone[] }

/** Distance (px, positive inside) from local cell coords to a stone's outline, before edge noise. */
export function stoneDistance(s: Stone, lx: number, ly: number, W: number, H: number) {
  const cx = lx - W / 2, cy = ly - H / 2;
  const dL = lx - s.inset[0] - s.slope[0] * cy, dR = W - lx - s.inset[1] - s.slope[1] * cy;
  const dB = ly - s.inset[2] - s.slope[2] * cx, dT = H - ly - s.inset[3] - s.slope[3] * cx;
  const dx = Math.min(dL, dR), dy = Math.min(dB, dT);
  const ex = s.rc - dx, ey = s.rc - dy;
  let d = ex > 0 && ey > 0 ? s.rc - Math.sqrt(ex * ex + ey * ey) : Math.min(dx, dy);
  // knocked-off corners: a chamfer plane across the corner (0 = intact). Order: BL, BR, TR, TL.
  const cs = s.cham;
  if (cs[0] > 0) d = Math.min(d, (dL + dB - cs[0]) * Math.SQRT1_2);
  if (cs[1] > 0) d = Math.min(d, (dR + dB - cs[1]) * Math.SQRT1_2);
  if (cs[2] > 0) d = Math.min(d, (dR + dT - cs[2]) * Math.SQRT1_2);
  if (cs[3] > 0) d = Math.min(d, (dL + dT - cs[3]) * Math.SQRT1_2);
  return d;
}

/** Distance from p to the segment a–b. */
const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const vx = bx - ax, vy = by - ay, t = clamp01(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1));
  const ex = px - ax - vx * t, ey = py - ay - vy * t;
  return Math.sqrt(ex * ex + ey * ey);
};

/** Lay out courses and stones (deterministic in `r`). Exported for tests. */
export function layCourses(o: MasonryOpts, r: Rng) {
  const N = o.size, px = N / o.tile;
  let hs: number[] = [], sum = 0;
  while (sum < N) { const h = (o.course[0] + r() * (o.course[1] - o.course[0])) * px; hs.push(h); sum += h; }
  hs = hs.map((h) => (h * N) / sum);
  const cy = [0]; for (const h of hs) cy.push(cy[cy.length - 1] + h);
  const wsum = o.liths.reduce((a, b) => a + b, 0);
  const pickLith = () => { let t = r() * wsum; for (let i = 0; i < o.liths.length; i++) { t -= o.liths[i]; if (t <= 0) return i; } return 0; };
  const jw = (o.joint * px) / 2;
  const mkStone = (W: number, H: number, y0: number, y1: number): Stone => {
    const lith = pickLith(), b = 1 - o.bright / 2 + r() * o.bright, base = LITH_COL[lith];
    const jh = jw * (0.8 + 0.4 * r());
    const hh = H * (y1 - y0);
    const slope = [0, 1, 2, 3].map(() => (r() * 2 - 1) * o.tilt) as Stone['slope'];
    const inset = [0, 1, 2, 3].map((i) => jh + r() * o.jointVar * jw * 2 + Math.abs(slope[i]) * (i < 2 ? hh : W) / 2 + o.edge * px) as Stone['inset'];
    const minSide = Math.min(W - inset[0] - inset[1], hh - inset[2] - inset[3]);
    const rc = Math.min((o.corner[0] + r() * (o.corner[1] - o.corner[0])) * px, minSide * 0.45);
    const cham = [0, 1, 2, 3].map(() => (r() < o.chamfer ? (0.12 + r() * 0.25) * minSide : 0)) as Stone['cham'];
    const planes: number[] = []; for (let k = 0; k < 3; k++) planes.push(0.45 + r() * 0.35, (r() * 2 - 1) * 1.6, (r() * 2 - 1) * 1.6);
    const vein = r() < o.veins ? [r() * W, (0.3 + r() * 0.4) * hh, r() * Math.PI, (0.0015 + r() * 0.0025) * px] : null;
    const cr = r() < o.cracks ? [r() < 0.5 ? 0 : 1, r(), r() * 2 - 1, 0.3 + r() * 0.5] : null; // from bottom/top edge, start u, lean, length fraction
    return {
      y0, y1, id: encodeId(lith, r()) / 255, lith, col: [base[0] * b, base[1] * b, base[2] * b], bulge: 0.55 + r() * 0.45,
      tilt: (r() - 0.5) * 0.12, face0: 0.62 + r() * 0.1, inset, slope, rc, cham, jh, planes,
      iron: r() < o.iron ? 0.35 + r() * 0.65 : 0, vein, crack: cr,
    };
  };
  const courses: { off: number; slots: Slot[] }[] = [];
  for (let c = 0; c < hs.length; c++) {
    const off = r() * N, slots: Slot[] = [];
    let x = off;
    while (x < off + N - 1) {
      let L = (o.stone[0] + r() * (o.stone[1] - o.stone[0])) * px;
      if (x + L > off + N - o.stone[0] * px) L = off + N - x; // no stone shorter than stone[0] (the 3D stones drop slivers)
      const sp = r() < o.split ? 0.35 + r() * 0.3 : 0;
      slots.push({ x0: x, x1: x + L, parts: sp ? [mkStone(L, hs[c], 0, sp), mkStone(L, hs[c], sp, 1)] : [mkStone(L, hs[c], 0, 1)] });
      x += L;
    }
    courses.push({ off, slots });
  }
  return { hs, cy, courses, px, jw };
}

export interface LayoutStone { x0: number; x1: number; split: number; id: number; col: RGB; bulge: number; tilt: number }
export interface MasonryLayout { N: number; px: number; hs: number[]; cy: number[]; courses: { off: number; stones: LayoutStone[] }[] }

/** The course/stone layout of a masonry tile in texture pixels, shared with the 3D stones (src/castle/stones)
 *  so geometric stones sit exactly on the texture's stones. A split slot is one cell with `split` set. */
export function masonryLayout(o: MasonryOpts, r: Rng = mulberry32(hashSeed(o.name))): MasonryLayout {
  const L = layCourses(o, r);
  return {
    N: o.size, px: L.px, hs: L.hs, cy: L.cy,
    courses: L.courses.map((c) => ({
      off: c.off,
      stones: c.slots.map((sl) => {
        const st = sl.parts[0];
        return { x0: sl.x0, x1: sl.x1, split: sl.parts.length > 1 ? st.y1 : 0, id: st.id, col: st.col, bulge: st.bulge, tilt: st.tilt };
      }),
    })),
  };
}

/** Joint warp of masonry(): texture pixel (u, v) samples the layout at pixel + warp * px * (wx, wy).
 *  Low frequency only (courses undulate; joints do not wobble). */
export function masonryWarp(o: MasonryOpts, noise = new TileNoise(hashSeed(o.name + 'n'))) {
  const fT = Math.max(2, Math.round(o.tile * 5));
  return (u: number, v: number): [number, number] => [noise.fbm(u, v, fT, 2), noise.fbm(u + 0.37, v + 0.71, fT, 2)];
}

/**
 * Coursed masonry from a signed distance to each stone's outline. Channels:
 * - albedo: RGB = the stone's colour, carried on under the joints (the shader paints the mortar from the
 *   SDF, so edges stay crisp at any magnification and mips never mix mortar into stones); A = baked AO.
 * - normal: RGB tangent normal from the height; A = the stone's centre along u (per-instance variation).
 * - data: R = height (parallax), G = mortar coverage (for distant mips), B = stone id (lith * 51 + rand),
 *   A = signed distance to the outline, 0.5 + d / (2 * sdfRange), positive inside the stone.
 */
export function masonry(o: MasonryOpts, r: Rng = mulberry32(hashSeed(o.name)), noise = new TileNoise(hashSeed(o.name + 'n'))): TexSet {
  const N = o.size, { cy, hs, courses, px } = layCourses(o, r), warpAt = masonryWarp(o, noise);
  const height = new Float32Array(N * N), albedo = new Uint8Array(N * N * 4), data = new Uint8Array(N * N * 4), centre = new Uint8Array(N * N);
  const wp = o.warp * px, bevPx = Math.max(1, o.bevel * px), edgePx = o.edge * px, chipPx = o.chip * px, sdfPx = o.sdfRange * px;
  const fFace = Math.max(4, Math.round(o.tile * 16)), fMott = Math.max(4, Math.round(o.tile * 6));
  const fPin = Math.max(4, Math.round(o.tile * 14));
  for (let y = 0; y < N; y++) {
    const v = y / N;
    for (let x = 0; x < N; x++) {
      const u = x / N;
      // courses undulate gently (low frequency only: no wobbly joints)
      const [wu, wv] = warpAt(u, v), wx = x + wp * wu, wy = y + wp * wv;
      const yy = ((wy % N) + N) % N;
      let c = 0; while (c < hs.length - 1 && cy[c + 1] <= yy) c++;
      const course = courses[c];
      let xx = ((wx % N) + N) % N; if (xx < course.off) xx += N;
      let si = 0; while (si < course.slots.length - 1 && course.slots[si].x1 <= xx) si++;
      const slot = course.slots[si], H = hs[c], W = slot.x1 - slot.x0;
      const fy = (yy - cy[c]) / H;
      const st = slot.parts.length > 1 && fy >= slot.parts[0].y1 ? slot.parts[1] : slot.parts[0];
      const lx = xx - slot.x0, ly = yy - cy[c] - st.y0 * H, hh = H * (st.y1 - st.y0);
      centre[y * N + x] = (((slot.x0 + slot.x1) * 0.5) % N) / N * 255;
      const id = st.id;
      // signed distance to the outline (px): shape + smooth irregularity + chipped arrises
      let d = stoneDistance(st, lx, ly, W, hh);
      d += edgePx * noise.fbm(u + id * 3.1, v + id * 1.7, fFace, 2);
      d -= chipPx * Math.max(0, noise.fbm(u + id * 5.3, v + id * 2.9, fFace, 2) - 0.2) * 2.5;
      // pinning stones: small stones set in the wider joints, kept clear of their neighbours
      let pin = false;
      if (o.pinning > 0 && d < -1.3 * st.jh) {
        const pf = (noise.n(u + 0.13, v + 0.71, fPin) - (1 - o.pinning * 2)) * (N / fPin) / 1.6;
        const ps = Math.min(pf, -d - 3);
        if (ps > d) { d = ps; pin = ps > -2; }
      }
      const i4 = (y * N + x) * 4;
      const g = noise.fbm(u, v, fFace, 3);
      let h: number, ao: number, col: RGB;
      if (pin) {
        const k = 0.8 + 0.3 * g;
        col = [PIN_COL[0] * k, PIN_COL[1] * k, PIN_COL[2] * k];
        const pr = 1 - Math.pow(1 - clamp01(d / (bevPx * 0.6)), 2);
        h = 0.22 + 0.25 * pr + 0.05 * g; ao = 0.75 + 0.2 * pr;
      } else {
        // stone colour (carried under the joint): mottling, bedding, darker weathered patches, iron, veins
        const cxn = (lx - W / 2) / W, cyn = (ly - hh / 2) / Math.max(1, hh);
        const mott = noise.fbm(u + id * 13.7, v + id * 5.1, fMott * 4, 3);
        let k = 1 + mott * (st.lith === 1 ? 0.12 : 0.18) + g * 0.06;
        if (st.lith === 2 || st.lith === 4) k += 0.06 * Math.sin((ly / Math.max(1, hh)) * Math.PI * (5 + id * 6) + 3 * noise.fbm(u + id, v, fMott, 2));
        k *= 1 - 0.12 * sstep(0.1, 0.45, noise.fbm(u + id * 3.3, v + id * 1.1, fMott * 2, 2));
        col = [st.col[0] * k, st.col[1] * k, st.col[2] * k];
        if (st.iron > 0) {
          const s = st.iron * sstep(0.1, 0.5, noise.fbm(u + id * 7.1, v + id * 2.9, fMott * 3, 3));
          col = [col[0] * (1 + 0.16 * s), col[1] * (1 - 0.03 * s), col[2] * (1 - 0.2 * s)];
        }
        let vein = 0;
        if (st.vein) {
          const [vx, vy, a, w] = st.vein;
          const dist = Math.abs((lx - vx) * Math.sin(a) - (ly - vy) * Math.cos(a) + 0.02 * px * noise.fbm(u + id, v, fFace, 2));
          vein = 1 - sstep(w * 0.5, w * 1.3, dist);
          col = [col[0] + (0.5 - col[0]) * vein * 0.55, col[1] + (0.49 - col[1]) * vein * 0.55, col[2] + (0.46 - col[2]) * vein * 0.55];
        }
        let crack = 0;
        if (st.crack) {
          const [edge, su, lean, len] = st.crack;
          const ax = W * (0.2 + 0.6 * su), ay = edge ? hh : 0, bx = ax + lean * hh * 0.5, by = edge ? hh * (1 - len) : hh * len;
          const jag = 0.004 * px * noise.n(u + id * 9.1, v, fFace * 4);
          const dist = segDist(lx + jag, ly, ax, ay, bx, by);
          const along = clamp01(Math.abs(ly - ay) / Math.max(1, Math.abs(by - ay)));
          crack = (1 - sstep(0.35, 1.2, dist / Math.max(0.5, 1 - along))) * (1 - along * 0.6);
          col = [col[0] * (1 - 0.45 * crack), col[1] * (1 - 0.45 * crack), col[2] * (1 - 0.45 * crack)];
        }
        if (d > 0) {
          // rounded arris (quarter ellipse) up to the face; faces are split (facets) and pillowed (dome)
          const xb = clamp01(d / bevPx), prof = 1 - (1 - xb) * (1 - xb) * (1 - xb);
          let fz = 1; for (let q = 0; q < 9; q += 3) fz = Math.min(fz, st.planes[q] + st.planes[q + 1] * cxn + st.planes[q + 2] * cyn);
          const dome = Math.sqrt(clamp01(d / Math.max(1, 0.5 * Math.min(W, hh))));
          const top = st.face0 + o.dome * dome * st.bulge + o.facets * (clamp01(fz) - 0.5) + o.face * (0.75 * g + 0.25 * noise.fbm(u + id, v, fFace * 4, 2)) + st.tilt * cyn;
          const foot = o.mortarLevel + 0.16;
          h = foot + (top - foot) * prof + 0.015 * vein - 0.09 * crack;
          col = [col[0] * (1 + 0.05 * (1 - prof)), col[1] * (1 + 0.05 * (1 - prof)), col[2] * (1 + 0.05 * (1 - prof))];
          ao = 0.86 + 0.14 * prof - 0.25 * crack;
        } else {
          // lime mortar bed: set back, deepest mid-joint (raked), rough
          const dm = -d;
          h = o.mortarLevel + 0.1 * Math.exp(-dm / (0.7 * st.jh)) + 0.035 * noise.fbm(u, v, fFace * 2, 2);
          ao = 0.66 + 0.3 * (1 - Math.exp(-dm / (1.4 * st.jh)));
        }
      }
      h = Math.min(0.94, Math.max(0.07, h));
      height[y * N + x] = h;
      albedo[i4] = toByte(col[0]); albedo[i4 + 1] = toByte(col[1]); albedo[i4 + 2] = toByte(col[2]); albedo[i4 + 3] = byte(ao);
      data[i4] = byte(h); data[i4 + 1] = d <= 0 ? 255 : 0; data[i4 + 2] = pin ? encodeId(3, (Math.floor(u * fPin) * 0.6180339 + Math.floor(v * fPin) * 0.4142135) % 1) : Math.round(id * 255);
      data[i4 + 3] = byte(0.5 + (0.5 * d) / sdfPx);
    }
  }
  return { size: N, albedo, normal: heightToNormal(height, N, (o.depth * px) / 2, centre), data };
}

// ---------------------------------------------------------------------------------- close-up detail

/** Metres covered by one repeat of the detail texture (the shader rotates and offsets it per stone). */
export const DETAIL_TILE = 0.8;

/** Integer hash of a lattice cell to [0,1). */
const cellHash = (i: number, j: number, s: number) => {
  let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(s, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/**
 * Tileable Voronoi: nearest and second-nearest feature point to (x, y) in texels, cells of `cell`
 * texels on an `n` × `n` grid. Returns [F1, F2, hash of the nearest cell, dx, dy to its point].
 */
export function voronoi(x: number, y: number, cell: number, n: number, seed: number): [number, number, number, number, number] {
  const ci = Math.floor(x / cell), cj = Math.floor(y / cell);
  let f1 = 1e9, f2 = 1e9, best = 0, bx = 0, by = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const a = ci + i, b = cj + j, wa = ((a % n) + n) % n, wb = ((b % n) + n) % n;
    const px = (a + cellHash(wa, wb, seed)) * cell, py = (b + cellHash(wa, wb, seed + 1)) * cell;
    const ddx = x - px, ddy = y - py, d = Math.sqrt(ddx * ddx + ddy * ddy);
    if (d < f1) { f2 = f1; f1 = d; best = cellHash(wa, wb, seed + 2); bx = x - px; by = y - py; } else if (d < f2) f2 = d;
  }
  return [f1, f2, best, bx, by];
}

/**
 * Close-up detail for stone, one RGBA8 texture tiling every DETAIL_TILE metres (size px):
 * R = crystalline grain height (crystals ~2–3 mm, sunken grain boundaries); also the mortar's sand.
 * G = weathering pits: each pit's depth profile scaled by its rank, so the shader can ask for more or
 *     fewer pits per stone with one threshold (`smoothstep(1 - density, 1, G)`).
 * B = tooling: claw/boaster striations (rows of short grooves) for dressed faces; 1 = untouched.
 * A = mineral flecks: 0.5 neutral, low = dark mica/hornblende, high = quartz/feldspar, in clusters.
 * The shader builds the normal from R/G/B with three taps and per-stone weights.
 */
export function stoneDetail(size = 1024, seed = hashSeed('stone-detail'), noise = new TileNoise(seed)): Uint8Array {
  const N = size, out = new Uint8Array(N * N * 4);
  const crystal = Math.max(2, Math.round(N / 340)), nc = Math.round(N / crystal);
  const pitCell = Math.max(4, Math.round(N / 85)), np = Math.round(N / pitCell);
  const bigCell = pitCell * 4, nb = Math.round(N / bigCell);
  const sp = Math.max(4, Math.round(N / 128)), seg = Math.max(8, Math.round(N / 32)), rows = Math.round(N / sp);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, i = (y * N + x) * 4;
    // crystals: faceted cells with recessed boundaries, plus a little fine noise
    const [f1, f2, ch] = voronoi(x, y, crystal, nc, seed);
    const boundary = 1 - sstep(0, 0.35 * crystal, f2 - f1);
    const grain = 0.5 + 0.28 * (ch - 0.5) - 0.18 * boundary + 0.12 * noise.n(u, v, N >> 3) + 0.08 * noise.fbm(u, v, N >> 5, 2);
    // flecks cluster: dark minerals where a low-frequency field is high
    const cluster = noise.fbm(u + 0.4, v + 0.2, 16, 2);
    const t = cellHash(Math.floor(ch * 1e6), 7, seed);
    const fleck = t < 0.1 + 0.12 * cluster ? 0.1 + 0.15 * ch : t > 0.9 - 0.05 * cluster ? 0.85 + 0.15 * ch : 0.5 + 0.12 * (ch - 0.5);
    // pits: small and occasional larger solution hollows
    const [p1, , pr] = voronoi(x, y, pitCell, np, seed + 11);
    const rad = (0.12 + 0.35 * cellHash(Math.floor(pr * 1e6), 3, seed)) * pitCell;
    let pit = pr * clamp01(1 - (p1 / rad) ** 2);
    const [b1, , br] = voronoi(x, y, bigCell, nb, seed + 23);
    const brad = (0.15 + 0.3 * cellHash(Math.floor(br * 1e6), 5, seed)) * bigCell;
    pit = Math.max(pit, br * clamp01(1 - (b1 / brad) ** 2) * 0.9);
    // tooling: diagonal rows of short chisel grooves (period divides N, so it tiles)
    const q = y + x * 0.25, row = Math.floor(q / sp), rowW = ((row % rows) + rows) % rows;
    const a = (x + cellHash(rowW, 1, seed) * N) % N, sIdx = Math.floor(a / seg);
    const on = cellHash(rowW, sIdx, seed + 5), centre = sp * (0.5 + 0.3 * (cellHash(rowW, sIdx, seed + 6) - 0.5));
    const dq = Math.abs(q - row * sp - centre), w = sp * 0.32;
    const endFade = sstep(0, 0.2, (a % seg) / seg) * sstep(0, 0.2, 1 - (a % seg) / seg);
    const groove = on > 0.25 ? clamp01(1 - (dq / w) ** 2) * endFade * (0.5 + 0.5 * on) : 0;
    out[i] = byte(grain); out[i + 1] = byte(pit); out[i + 2] = byte(1 - 0.85 * groove); out[i + 3] = byte(fleck);
  }
  return out;
}

/** Lithology weights: [granite, limestone, sandstone, whin, greywacke]. */
const LITH_W = { ashlar: [2, 4, 1.4, 0.3, 1], rubble: [2.5, 1.5, 1.4, 2, 2], dressed: [0.8, 4, 1, 0, 0.3] };

export const ASHLAR: MasonryOpts = {
  name: 'ashlar', size: 2048, tile: 4, course: [0.26, 0.44], stone: [0.42, 1.05], joint: 0.014, jointVar: 0.15, tilt: 0.006,
  corner: [0.004, 0.014], chamfer: 0.06, bevel: 0.012, warp: 0.004, edge: 0.0015, chip: 0.008, split: 0.04,
  liths: LITH_W.ashlar, bright: 0.16, face: 0.1, facets: 0.05, dome: 0.05, pinning: 0, mortarLevel: 0.36, cracks: 0.07, veins: 0.08, iron: 0.15,
  depth: 0.05 / 0.89, sdfRange: 0.025,
};
export const RUBBLE: MasonryOpts = {
  name: 'rubble', size: 2048, tile: 4, course: [0.16, 0.4], stone: [0.18, 0.75], joint: 0.024, jointVar: 0.3, tilt: 0.02,
  corner: [0.02, 0.06], chamfer: 0.22, bevel: 0.016, warp: 0.022, edge: 0.005, chip: 0.012, split: 0.12,
  liths: LITH_W.rubble, bright: 0.24, face: 0.1, facets: 0.42, dome: 0.03, pinning: 0.03, mortarLevel: 0.2, cracks: 0.08, veins: 0.12, iron: 0.25,
  depth: 0.06 / 0.89, sdfRange: 0.04,
};
export const DRESSED: MasonryOpts = {
  name: 'dressed', size: 1024, tile: 2, course: [0.3, 0.42], stone: [0.55, 0.95], joint: 0.009, jointVar: 0.1, tilt: 0.003,
  corner: [0.003, 0.008], chamfer: 0.04, bevel: 0.008, warp: 0.002, edge: 0.001, chip: 0.006, split: 0,
  liths: LITH_W.dressed, bright: 0.12, face: 0.06, facets: 0.03, dome: 0.03, pinning: 0, mortarLevel: 0.42, cracks: 0.04, veins: 0.06, iron: 0.1,
  depth: 0.025 / 0.89, sdfRange: 0.015,
};
/** Pinning stones: small dark slate-like chips in the wider rubble joints. */
export const PIN_COL: RGB = [0.2, 0.198, 0.192];
/** Weighted stone colours per wall type (linear), e.g. for the loading tunnel's hand-drawn blocks. */
export const STONE_GREYS = {
  ashlar: LITHS.map((_, i) => ({ c: LITH_COL[i], w: ASHLAR.liths[i] })).filter((g) => g.w > 0),
  rubble: [...LITHS.map((_, i) => ({ c: LITH_COL[i], w: RUBBLE.liths[i] })), { c: PIN_COL, w: 0.5 }],
};
/** `size` overrides the texture size (tests use small ones); `tile` stays in metres. */
export const ashlarSet = (size = ASHLAR.size) => masonry({ ...ASHLAR, size });
export const rubbleSet = (size = RUBBLE.size) => masonry({ ...RUBBLE, size });
export const dressedSet = (size = DRESSED.size) => masonry({ ...DRESSED, size });

/** Overlapping slates: rows of 0.2 m exposure, staggered, varied widths and shades, moss in the laps. */
export function slate(N = 1024, r: Rng = mulberry32(hashSeed('slate')), noise = new TileNoise(hashSeed('slaten'))): TexSet {
  const tile = 2, px = N / tile;
  const rowH = 0.2 * px, rows = Math.round(N / rowH), rh = N / rows;
  const rowsData = Array.from({ length: rows }, () => { const off = r() * N, ws: { x0: number; x1: number; s: number; t: number }[] = []; let x = off; while (x < off + N - 1) { let w = (0.2 + r() * 0.16) * px; if (x + w > off + N - 0.12 * px) w = off + N - x; ws.push({ x0: x, x1: x + w, s: 0.8 + r() * 0.35, t: (r() - 0.5) * 0.1 }); x += w; } return { off, ws }; });
  const height = new Float32Array(N * N), albedo = new Uint8Array(N * N * 4), data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, row = Math.min(rows - 1, Math.floor(y / rh)), R = rowsData[row];
    let xx = x + noise.n(u, v, 32) * 2; if (xx < R.off) xx += N;
    let k = 0; while (k < R.ws.length - 1 && R.ws[k].x1 <= xx) k++;
    const s = R.ws[k], ly = 1 - (y - row * rh) / rh; // 0 top of exposed part .. 1 bottom (thick) edge
    const edge = Math.min(xx - s.x0, s.x1 - xx);
    const gap = edge < 1.4 ? 1 : 0;
    const g = noise.fbm(u, v, 64, 3);
    let h = 0.25 + 0.55 * ly + 0.05 * g + s.t * (xx - s.x0) / px; if (gap) h = 0.1;
    const moss = Math.max(0, noise.fbm(u, v, 8, 3) - 0.25) * 2.2 * (1 - ly * 0.6);
    const b = s.s * (0.88 + 0.12 * g) * (gap ? 0.4 : 1) * (0.85 + 0.15 * (1 - ly));
    let col: RGB = [0.19 * b, 0.205 * b, 0.235 * b];
    const m = Math.min(1, moss) * 0.7; col = [col[0] * (1 - m) + 0.26 * m, col[1] * (1 - m) + 0.27 * m, col[2] * (1 - m) + 0.17 * m];
    const i4 = (y * N + x) * 4;
    height[y * N + x] = h;
    albedo[i4] = toByte(col[0]); albedo[i4 + 1] = toByte(col[1]); albedo[i4 + 2] = toByte(col[2]); albedo[i4 + 3] = 255;
    data[i4] = h * 255; data[i4 + 1] = (0.6 + 0.4 * ly) * 255; data[i4 + 2] = k * 37 % 255; data[i4 + 3] = gap * 255;
  }
  return { size: N, albedo, normal: heightToNormal(height, N, 6), data };
}

/** Vertical oak planks for doors and the drawbridge. */
export function planks(N = 512, r: Rng = mulberry32(hashSeed('woodr')), noise = new TileNoise(hashSeed('wood'))): TexSet {
  const n = 6, shades = Array.from({ length: n }, () => 0.8 + r() * 0.35);
  const height = new Float32Array(N * N), albedo = new Uint8Array(N * N * 4), data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, p = Math.floor(u * n), lu = u * n - p;
    const grain = noise.fbm(u * 1 + p * 0.13, v, 4, 2) * 0.5 + noise.n(u * 1 + p * 0.31, v, 64) * 0.3 + Math.sin((u * n * 30 + noise.fbm(u, v, 8, 2) * 6)) * 0.08;
    const gap = lu < 0.025 || lu > 0.975;
    const b = shades[p] * (0.85 + 0.25 * grain) * (gap ? 0.3 : 1);
    const i4 = (y * N + x) * 4;
    height[y * N + x] = gap ? 0.1 : 0.6 + grain * 0.15;
    albedo[i4] = toByte(0.2 * b); albedo[i4 + 1] = toByte(0.14 * b); albedo[i4 + 2] = toByte(0.09 * b); albedo[i4 + 3] = 255;
    data[i4] = height[y * N + x] * 255; data[i4 + 1] = gap ? 120 : 230; data[i4 + 2] = p * 40; data[i4 + 3] = 0;
  }
  return { size: N, albedo, normal: heightToNormal(height, N, 4), data };
}

/** Four tileable fbm channels at different frequencies, for macro variation and breaking up tiling in shaders. */
export function macroNoise(N = 512, n = new TileNoise(hashSeed('macro'))): Uint8Array {
  const out = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, i = (y * N + x) * 4;
    out[i] = (n.fbm(u, v, 4, 5) * 0.5 + 0.5) * 255;
    out[i + 1] = (n.fbm(u + 0.3, v + 0.6, 8, 5) * 0.5 + 0.5) * 255;
    out[i + 2] = (n.fbm(u + 0.7, v + 0.1, 16, 4) * 0.5 + 0.5) * 255;
    out[i + 3] = (n.fbm(u + 0.2, v + 0.9, 64, 3) * 0.5 + 0.5) * 255;
  }
  return out;
}

/** Ground albedo layers (grass, dirt, rock, mud), tile 4 m. Packed as separate RGBA arrays. */
export function groundLayers() {
  const N = 1024, n = new TileNoise(hashSeed('ground'));
  const mk = (f: (u: number, v: number) => RGB) => { const a = new Uint8Array(N * N * 4); for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const c = f(x / N, y / N), i = (y * N + x) * 4; a[i] = toByte(c[0]); a[i + 1] = toByte(c[1]); a[i + 2] = toByte(c[2]); a[i + 3] = 255; } return a; };
  const grass = mk((u, v) => {
    const blades = n.n(u, v * 0.5, 512) * 0.5 + n.n(u, v, 256) * 0.3 + n.n(u + 0.3, v, 128) * 0.2;
    const patch = n.fbm(u, v, 8, 3), dry = Math.max(0, n.fbm(u + 0.5, v, 4, 3));
    const k = 0.75 + 0.35 * blades + 0.12 * patch;
    const clover = n.n(u + 0.11, v, 64) > 0.6 ? 0.85 : 1;
    return [(0.085 + 0.08 * dry) * k * clover, (0.125 + 0.03 * dry) * k, (0.028 + 0.012 * dry) * k * clover];
  });
  const dirt = mk((u, v) => { const g = n.fbm(u, v, 32, 4), peb = n.n(u, v, 256) > 0.55 ? 1.25 : 1; const k = (0.75 + 0.3 * g) * peb; return [0.16 * k, 0.13 * k, 0.095 * k]; });
  const rock = mk((u, v) => { const g = n.fbm(u, v, 8, 5), c = n.fbm(u * 1.0, v * 3.0, 16, 3); const k = 0.7 + 0.4 * g + 0.1 * c; const lich = Math.max(0, n.fbm(u + 0.4, v, 16, 3) - 0.3) * 1.5; return [0.3 * k * (1 - lich) + 0.28 * lich, 0.3 * k * (1 - lich) + 0.3 * lich, 0.29 * k * (1 - lich) + 0.2 * lich]; });
  const mud = mk((u, v) => { const g = n.fbm(u, v, 16, 4); const k = 0.7 + 0.3 * g; return [0.09 * k, 0.085 * k, 0.065 * k]; });
  // detail normal from a rock-ish height field
  const h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) h[y * N + x] = n.fbm(x / N, y / N, 32, 4) * 0.5 + 0.5;
  return { size: N, grass, dirt, rock, mud, normal: heightToNormal(h, N, 3) };
}

/** Tileable ripple normals for the moat water. */
export function waterNormals(N = 512, n = new TileNoise(hashSeed('water'))): Uint8Array {
  const h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const u = x / N, v = y / N; h[y * N + x] = n.fbm(u, v, 8, 5, 0.55) + 0.3 * n.fbm(u * 1, v * 1, 32, 2); }
  return heightToNormal(h, N, 14);
}

export type { Rng };
