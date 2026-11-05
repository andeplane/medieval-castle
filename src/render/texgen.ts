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
    const x1 = (xi + 1) % f, y1 = (yi + 1) % f;
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

const sstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Height (0..1) to a tangent-space normal map. */
function heightToNormal(h: Float32Array, N: number, strength: number) {
  const out = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const l = h[y * N + ((x + N - 1) % N)], r = h[y * N + ((x + 1) % N)];
    const u = h[((y + N - 1) % N) * N + x], d = h[((y + 1) % N) * N + x];
    // DataTexture row 0 is v = 0 (bottom of the tile), so row y+1 is further up the wall
    let nx = (l - r) * strength, ny = (u - d) * strength, nz = 1;
    const il = 1 / Math.hypot(nx, ny, nz); nx *= il; ny *= il; nz *= il;
    const i = (y * N + x) * 4;
    out[i] = (nx * 0.5 + 0.5) * 255; out[i + 1] = (ny * 0.5 + 0.5) * 255; out[i + 2] = (nz * 0.5 + 0.5) * 255; out[i + 3] = 255;
  }
  return out;
}

type RGB = [number, number, number];
const toByte = (v: number) => Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, v), 1 / 2.2) * 255)));

export interface MasonryOpts {
  name: string; size: number; tile: number;           // px, metres per tile
  course: [number, number]; stone: [number, number];  // metres
  joint: number; bevel: number; warp: number;          // metres
  split: number;                                       // chance a stone is two smaller stacked ones (rubble)
  palette: { c: RGB; w: number }[]; mortar: RGB; bright: number;
  face: number;                                        // face roughness (height noise)
  pinning: number;                                     // small pinning stones in wide joints (rubble)
  chip: number; cracks: number;                        // arris chipping (m), crack frequency
  strength: number;
}

export interface LayoutStone { x0: number; x1: number; split: number; id: number; col: RGB; bulge: number; tilt: number }
export interface MasonryLayout { N: number; px: number; hs: number[]; cy: number[]; courses: { off: number; stones: LayoutStone[] }[] }

/** The course/stone layout of a masonry tile, in texture pixels. Shared with the 3D stones
 *  (src/castle/stones), so the geometric stones sit exactly on the texture's stones. */
export function masonryLayout(o: MasonryOpts, r: Rng = mulberry32(hashSeed(o.name))): MasonryLayout {
  const N = o.size, px = N / o.tile;
  // Courses: heights in px summing exactly to N.
  let hs: number[] = [], sum = 0;
  while (sum < N) { const h = (o.course[0] + r() * (o.course[1] - o.course[0])) * px; hs.push(h); sum += h; }
  hs = hs.map((h) => (h * N) / sum);
  const cy = [0]; for (const h of hs) cy.push(cy[cy.length - 1] + h);

  // Stones per course: boundaries starting at an offset, wrapping at N.
  const courses: { off: number; stones: LayoutStone[] }[] = [];
  const pickCol = (): RGB => {
    let t = r() * o.palette.reduce((a, p) => a + p.w, 0);
    for (const p of o.palette) { t -= p.w; if (t <= 0) return p.c; }
    return o.palette[0].c;
  };
  for (let c = 0; c < hs.length; c++) {
    const off = r() * N, stones: LayoutStone[] = [];
    let x = off;
    while (x < off + N - 1) {
      let L = (o.stone[0] + r() * (o.stone[1] - o.stone[0])) * px;
      if (x + L > off + N - o.stone[0] * px * 0.6) L = off + N - x;
      const b = 1 - o.bright / 2 + r() * o.bright, base = pickCol();
      stones.push({ x0: x, x1: x + L, split: r() < o.split ? 0.35 + r() * 0.3 : 0, id: r(), col: [base[0] * b, base[1] * b, base[2] * b], bulge: 0.55 + r() * 0.45, tilt: (r() - 0.5) * 0.25 });
      x += L;
    }
    courses.push({ off, stones });
  }
  return { N, px, hs, cy, courses };
}

/** Joint warp field of masonry(): texture pixel (u, v) samples the layout at pixel + warp * (wx, wy). */
export function masonryWarp(o: MasonryOpts) {
  const noise = new TileNoise(hashSeed(o.name + 'n'));
  return (u: number, v: number): [number, number] => [
    noise.fbm(u, v, 16, 3) * 0.7 + noise.n(u, v, 64) * 0.3,
    noise.fbm(u + 0.37, v + 0.71, 16, 3) * 0.7 + noise.n(u + 0.5, v, 64) * 0.3,
  ];
}

export function masonry(o: MasonryOpts): TexSet {
  const { N, px, hs, cy, courses } = masonryLayout(o);
  const noise = new TileNoise(hashSeed(o.name + 'n'));

  const height = new Float32Array(N * N), albedo = new Uint8Array(N * N * 4), data = new Uint8Array(N * N * 4);
  const jw = o.joint * px * 0.5, bev = o.bevel * px, wp = o.warp * px;
  for (let y = 0; y < N; y++) {
    const v = y / N;
    for (let x = 0; x < N; x++) {
      const u = x / N;
      // warp so joints wander instead of being ruled lines
      const wx = x + wp * (noise.fbm(u, v, 16, 3) * 0.7 + noise.n(u, v, 64) * 0.3), wy = y + wp * (noise.fbm(u + 0.37, v + 0.71, 16, 3) * 0.7 + noise.n(u + 0.5, v, 64) * 0.3);
      const yy = ((wy % N) + N) % N;
      let c = 0; while (c < hs.length - 1 && cy[c + 1] <= yy) c++;
      const course = courses[c];
      let xx = ((wx % N) + N) % N; if (xx < course.off) xx += N;
      let s = 0; while (s < course.stones.length - 1 && course.stones[s].x1 <= xx) s++;
      const st = course.stones[s];
      let top = cy[c], bot = cy[c + 1], id = st.id;
      if (st.split) { const m = top + (bot - top) * st.split; if (yy < m) bot = m; else { top = m; id = (id * 7.31) % 1; } }
      const dx = Math.min(xx - st.x0, st.x1 - xx), dy = Math.min(yy - top, bot - yy);
      const jv = jw * (0.7 + 0.6 * (noise.n(u * 3 + id, v * 3, 8) * 0.5 + 0.5));
      // rounded corners: distance to a rounded rectangle, then chipped arrises
      const rc = Math.min(bev * 1.4, (bot - top) * 0.3);
      const ex = Math.max(0, rc - dx), ey = Math.max(0, rc - dy);
      const dr = ex > 0 && ey > 0 ? rc - Math.hypot(ex, ey) : Math.min(dx, dy);
      const chip = o.chip * px * (noise.fbm(u + id * 3.1, v + id * 1.7, 48, 3) * 0.7 + noise.n(u, v, 192) * 0.3);
      const d = dr - jv + chip;
      const g = noise.fbm(u, v, 64, 3), grain = noise.n(u, v, 512) * 0.5 + noise.n(u + 0.5, v, 256) * 0.5;
      const i4 = (y * N + x) * 4;
      let h: number, col: RGB, ao: number, mortar = 0;
      if (d <= 0) {
        mortar = 1;
        h = 0.1 + 0.06 * grain + 0.05 * g;
        const pin = o.pinning > 0 && noise.n(u, v, 128) > 1 - o.pinning * 2 && -d < jv * 0.9;
        if (pin) { h = 0.33 + 0.1 * grain; col = [0.2, 0.2, 0.195]; mortar = 0; }
        else { const k = 0.8 + 0.14 * grain + 0.1 * g; col = [o.mortar[0] * k, o.mortar[1] * k, o.mortar[2] * k]; }
        ao = 0.4 + 0.25 * Math.min(1, -d / Math.max(1, jv));
      } else {
        const prof = Math.pow(sstep(0, bev, d), 0.55);
        const facey = (yy - (top + bot) / 2) / Math.max(1, bot - top);
        const mott = noise.fbm(u + id * 13.7, v + id * 5.1, 24, 3);
        const crack = id < 0.3 * o.cracks && Math.abs(noise.fbm(u + id * 7.7, v + id * 2.3, 12, 2)) < 0.01 ? 1 : 0;
        h = 0.3 + 0.5 * prof * st.bulge + o.face * (0.5 * g + 0.3 * noise.fbm(u + id, v, 128, 2) + 0.2 * mott) + st.tilt * facey * prof - crack * 0.12;
        const pit = noise.n(u * 1.0 + id, v, 1024) > 0.8 ? -0.07 : 0;
        h += pit;
        const k = (0.86 + 0.1 * g + 0.06 * grain + 0.2 * mott) * (0.7 + 0.3 * prof) + pit * 1.5 - crack * 0.25;
        col = [st.col[0] * k, st.col[1] * k, st.col[2] * k];
        ao = 0.5 + 0.5 * prof - crack * 0.3;
      }
      height[y * N + x] = h;
      albedo[i4] = toByte(col[0]); albedo[i4 + 1] = toByte(col[1]); albedo[i4 + 2] = toByte(col[2]); albedo[i4 + 3] = 255;
      data[i4] = Math.max(0, Math.min(255, h * 255)); data[i4 + 1] = ao * 255; data[i4 + 2] = id * 255; data[i4 + 3] = mortar * 255;
    }
  }
  return { size: N, albedo, normal: heightToNormal(height, N, o.strength), data };
}

export const STONE_GREYS = {
  ashlar: [
    { c: [0.30, 0.295, 0.285] as RGB, w: 5 }, { c: [0.28, 0.28, 0.28] as RGB, w: 3 }, { c: [0.32, 0.305, 0.285] as RGB, w: 1.5 },
    { c: [0.25, 0.245, 0.24] as RGB, w: 0.8 }, { c: [0.335, 0.33, 0.32] as RGB, w: 1 },
  ],
  rubble: [
    { c: [0.255, 0.25, 0.24] as RGB, w: 4 }, { c: [0.235, 0.235, 0.235] as RGB, w: 3 }, { c: [0.285, 0.27, 0.25] as RGB, w: 1.6 },
    { c: [0.21, 0.205, 0.2] as RGB, w: 0.8 }, { c: [0.3, 0.29, 0.28] as RGB, w: 1 }, { c: [0.27, 0.255, 0.235] as RGB, w: 0.8 },
  ],
};

export const ASHLAR: MasonryOpts = {
  name: 'ashlar', size: 2048, tile: 4, course: [0.26, 0.44], stone: [0.42, 1.05], joint: 0.016, bevel: 0.03, warp: 0.014,
  split: 0.04, palette: STONE_GREYS.ashlar, mortar: [0.33, 0.32, 0.3], bright: 0.14, face: 0.2, pinning: 0, chip: 0.022, cracks: 1, strength: 8,
};
export const RUBBLE: MasonryOpts = {
  name: 'rubble', size: 2048, tile: 4, course: [0.16, 0.4], stone: [0.18, 0.75], joint: 0.035, bevel: 0.05, warp: 0.05,
  split: 0.12, palette: STONE_GREYS.rubble, mortar: [0.31, 0.3, 0.28], bright: 0.18, face: 0.3, pinning: 0.07, chip: 0.05, cracks: 1.5, strength: 10,
};
export const DRESSED: MasonryOpts = {
  name: 'dressed', size: 1024, tile: 2, course: [0.3, 0.42], stone: [0.55, 0.95], joint: 0.01, bevel: 0.015, warp: 0.004,
  split: 0, palette: [{ c: [0.36, 0.355, 0.34], w: 3 }, { c: [0.32, 0.32, 0.315], w: 2 }, { c: [0.39, 0.375, 0.35], w: 1 }],
  mortar: [0.34, 0.335, 0.31], bright: 0.12, face: 0.1, pinning: 0, chip: 0.008, cracks: 0.5, strength: 6,
};
export const ashlarSet = () => masonry(ASHLAR);
export const rubbleSet = () => masonry(RUBBLE);
export const dressedSet = () => masonry(DRESSED);

/** Overlapping slates: rows of 0.2 m exposure, staggered, varied widths and shades, moss in the laps. */
export function slate(): TexSet {
  const N = 1024, tile = 2, px = N / tile, r = mulberry32(hashSeed('slate')), noise = new TileNoise(hashSeed('slaten'));
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
export function planks(): TexSet {
  const N = 512, noise = new TileNoise(hashSeed('wood')), r = mulberry32(hashSeed('woodr'));
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
export function macroNoise(): Uint8Array {
  const N = 512, out = new Uint8Array(N * N * 4), n = new TileNoise(hashSeed('macro'));
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
export function waterNormals(): Uint8Array {
  const N = 512, n = new TileNoise(hashSeed('water'));
  const h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const u = x / N, v = y / N; h[y * N + x] = n.fbm(u, v, 8, 5, 0.55) + 0.3 * n.fbm(u * 1, v * 1, 32, 2); }
  return heightToNormal(h, N, 14);
}

export type { Rng };
