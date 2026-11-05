// Field patchwork (game-world-generation, scatter/biomes): a warped, jittered quad lattice of fields with
// a regional grain, as in Irish and Scottish lowland farmland. Lattice edges are hedgerows; a few runs
// of edges are lanes with a hedge on each side (boreens). Pure functions of the injected deps, no
// three.js, so the terrain, the field-map bake and other generators (hedges, walls, gates) all see the
// same layout. Terrain-aware filtering (no hedges in the moat, the lake, on mountains or steep ground)
// lives in terrain.ts: use `hedgerowLines()` / `fieldAt()` from there.
import { type V2 } from '../core/math2d';
import type { GenDeps } from './deps';

/** Crops, in the order the terrain shader decodes them. */
export const CROPS = ['pasture', 'rough', 'hay', 'stubble', 'ploughed', 'grazed'] as const;
export type Crop = (typeof CROPS)[number];
const CROP_WEIGHTS = [0.3, 0.22, 0.17, 0.12, 0.06, 0.13];

export interface Field { id: number; crop: number; rand: number; angle: number }
export interface FieldLayout {
  /** lattice points, (cols + 1) × (rows + 1), row-major */
  pts: V2[]; cols: number; rows: number;
  /** quad (i, j) → merged field */
  quadField: Int32Array; fields: Field[];
  /** hedges[k] = lattice edge [a, b] point indices; lane edges carry two hedges (± LANE_HALF) */
  hedges: { a: number; b: number; lane: boolean }[];
  /** lanes as polylines (centre lines) */
  lanes: V2[][];
  angle: number;
}

export const FIELD_EXTENT = 3200;     // lattice covers |x|, |z| ≤ this
export const LANE_HALF = 3.2;         // hedge offset either side of a lane centre line
const SU = 158, SV = 104;             // field size along / across the grain, metres

/** The lattice, merged fields, crops, hedges and lanes. Not cached: the caller (a terrain) keeps it. */
export function fieldLayout(deps: GenDeps): FieldLayout {
  const r = deps.rng('fields');
  const warpA = deps.noise2('fields-warp-a');
  const warpB = deps.noise2('fields-warp-b');
  const angle = 0.42 + (r() - 0.5) * 0.2;            // regional grain, radians from +x
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const half = Math.ceil((FIELD_EXTENT * 1.45) / SV);
  const cols = 2 * Math.ceil((FIELD_EXTENT * 1.45) / SU), rows = 2 * half;
  const pts: V2[] = [];
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
    // lattice coordinates, jittered, then warped at a scale of several fields so the lines bend
    const u = (i - cols / 2) * SU + (r() - 0.5) * SU * 0.42 + (j % 2) * SU * 0.18;
    const v = (j - rows / 2) * SV + (r() - 0.5) * SV * 0.38;
    let x = u * ca - v * sa, z = u * sa + v * ca;
    x += 70 * warpA(x / 900, z / 900) + 18 * warpB(x / 230, z / 230);
    z += 70 * warpB(x / 900 + 5, z / 900) + 18 * warpA(x / 230 + 9, z / 230);
    pts.push([x, z]);
  }
  const P = (i: number, j: number) => j * (cols + 1) + i;

  // merge some neighbouring quads into L-shaped and long fields (union-find)
  const nq = cols * rows, parent = Int32Array.from({ length: nq }, (_, k) => k);
  const find = (k: number): number => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
  const removedU = new Uint8Array((cols + 1) * rows); // vertical edges (constant i)
  const removedV = new Uint8Array(cols * (rows + 1)); // horizontal edges (constant j)
  for (let j = 0; j < rows; j++) for (let i = 1; i < cols; i++) if (r() < 0.2) { removedU[j * (cols + 1) + i] = 1; parent[find(j * cols + i)] = find(j * cols + i - 1); }
  for (let j = 1; j < rows; j++) for (let i = 0; i < cols; i++) if (r() < 0.14) { removedV[j * cols + i] = 1; parent[find(j * cols + i)] = find((j - 1) * cols + i); }

  // lanes: one row and one column of lattice edges near the castle, plus their continuations
  const laneRow = rows / 2 + 2, laneCol = cols / 2 + 2;
  const quadField = new Int32Array(nq), fields: Field[] = [], byRoot = new Map<number, number>();
  for (let k = 0; k < nq; k++) {
    const root = find(k);
    let f = byRoot.get(root);
    if (f === undefined) {
      let x = r(), crop = 0;
      while (crop < CROP_WEIGHTS.length - 1 && x > CROP_WEIGHTS[crop]) { x -= CROP_WEIGHTS[crop]; crop++; }
      f = fields.length; byRoot.set(root, f);
      fields.push({ id: f, crop, rand: r(), angle: angle + (r() < 0.5 ? 0 : Math.PI / 2) + (r() - 0.5) * 0.15 });
    }
    quadField[k] = f;
  }
  const hedges: FieldLayout['hedges'] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i <= cols; i++) {
    const lane = i === laneCol;
    if (lane || (!removedU[j * (cols + 1) + i] && r() > 0.03)) hedges.push({ a: P(i, j), b: P(i, j + 1), lane });
  }
  for (let j = 0; j <= rows; j++) for (let i = 0; i < cols; i++) {
    const lane = j === laneRow;
    if (lane || (!removedV[j * cols + i] && r() > 0.03)) hedges.push({ a: P(i, j), b: P(i + 1, j), lane });
  }
  const lanes: V2[][] = [
    Array.from({ length: cols + 1 }, (_, i) => pts[P(i, laneRow)]),
    Array.from({ length: rows + 1 }, (_, j) => pts[P(laneCol, j)]),
  ];
  return { pts, cols, rows, quadField, fields, hedges, lanes, angle };
}

/** Distance from p to segment ab. */
export function segDist(px: number, pz: number, a: V2, b: V2) {
  const abx = b[0] - a[0], abz = b[1] - a[1];
  let t = ((px - a[0]) * abx + (pz - a[1]) * abz) / (abx * abx + abz * abz || 1);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - a[0] - abx * t, dz = pz - a[1] - abz * t;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Raster of the layout for the terrain shader. RGBA8, `size`², covering ±FIELD_EXTENT:
 *  R = crop index / 8 (+ 1/16 so it decodes with floor), G = hedge distance (0..16 m → 0..1),
 *  B = lane distance (0..16 m → 0..1), A = per-field random. Terrain masks it out off the farmland. */
export function bakeFieldMap(L: FieldLayout, size: number) {
  const { pts, cols, rows } = L;
  const out = new Uint8Array(size * size * 4);
  for (let k = 0; k < size * size; k++) { out[k * 4 + 1] = 255; out[k * 4 + 2] = 255; }
  const texel = (2 * FIELD_EXTENT) / size;
  const toT = (v: number) => (v + FIELD_EXTENT) / texel - 0.5;
  // edge kinds: 0 none, 1 hedge, 2 lane (vertical edges keyed by their lower point, horizontal likewise)
  const P = (i: number, j: number) => j * (cols + 1) + i;
  const kindV = new Uint8Array((cols + 1) * (rows + 1)), kindH = new Uint8Array((cols + 1) * (rows + 1));
  for (const h of L.hedges) (h.b === h.a + cols + 1 ? kindV : kindH)[h.a] = h.lane ? 2 : 1;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const q = [pts[P(i, j)], pts[P(i + 1, j)], pts[P(i + 1, j + 1)], pts[P(i, j + 1)]];
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of q) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    const tx0 = Math.max(0, Math.floor(toT(x0))), tx1 = Math.min(size - 1, Math.ceil(toT(x1)));
    const tz0 = Math.max(0, Math.floor(toT(z0))), tz1 = Math.min(size - 1, Math.ceil(toT(z1)));
    if (tx0 > tx1 || tz0 > tz1) continue;
    const f = L.fields[L.quadField[j * cols + i]];
    // signed area sign so the inside test works for either winding
    let sgn = 0; for (let k = 0; k < 4; k++) { const a = q[k], b = q[(k + 1) % 4]; sgn += a[0] * b[1] - b[0] * a[1]; }
    sgn = Math.sign(sgn);
    // edges 0..3 in loop order; kind 0 none, 1 hedge, 2 lane. Inside a convex quad the distance to an
    // edge is (almost exactly) the half-plane distance, which the inside test computes anyway.
    const kinds = [kindH[P(i, j)], kindV[P(i + 1, j)], kindH[P(i, j + 1)], kindV[P(i, j)]];
    const ex = new Float64Array(4), ez = new Float64Array(4), il = new Float64Array(4);
    for (let k = 0; k < 4; k++) { const a = q[k], b = q[(k + 1) % 4]; ex[k] = b[0] - a[0]; ez[k] = b[1] - a[1]; il[k] = sgn / Math.sqrt(ex[k] * ex[k] + ez[k] * ez[k]); }
    for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) {
      const x = (tx + 0.5) * texel - FIELD_EXTENT, z = (tz + 0.5) * texel - FIELD_EXTENT;
      let hd = 16, ld = 16, inside = true;
      for (let k = 0; k < 4; k++) {
        const a = q[k], d = (ex[k] * (z - a[1]) - ez[k] * (x - a[0])) * il[k];
        if (d < 0) { inside = false; break; }
        if (kinds[k] === 1) hd = Math.min(hd, d);
        else if (kinds[k] === 2) { ld = Math.min(ld, d); hd = Math.min(hd, Math.abs(d - LANE_HALF)); }
      }
      if (!inside) continue;
      const o = (tz * size + tx) * 4;
      out[o] = Math.round((f.crop / 8 + 1 / 16) * 255);
      out[o + 1] = Math.round(Math.min(1, hd / 16) * 255);
      out[o + 2] = Math.round(Math.min(1, ld / 16) * 255);
      out[o + 3] = Math.round(f.rand * 255);
    }
  }
  return out;
}

/** Quad lookup: the field containing (x, z), searching the lattice cell guess and its neighbours. */
export function fieldIndexAt(L: FieldLayout, x: number, z: number): number {
  const { pts, cols, rows } = L;
  const ca = Math.cos(L.angle), sa = Math.sin(L.angle);
  const u = x * ca + z * sa, v = -x * sa + z * ca;
  const gi = Math.floor(u / SU + cols / 2), gj = Math.floor(v / SV + rows / 2);
  const P = (i: number, j: number) => j * (cols + 1) + i;
  for (let rad = 0; rad <= 2; rad++) for (let dj = -rad; dj <= rad; dj++) for (let di = -rad; di <= rad; di++) {
    if (Math.max(Math.abs(di), Math.abs(dj)) !== rad) continue;
    const i = gi + di, j = gj + dj;
    if (i < 0 || j < 0 || i >= cols || j >= rows) continue;
    const q = [pts[P(i, j)], pts[P(i + 1, j)], pts[P(i + 1, j + 1)], pts[P(i, j + 1)]];
    let pos = 0, neg = 0;
    for (let k = 0; k < 4; k++) { const a = q[k], b = q[(k + 1) % 4]; const c = (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]); if (c > 0) pos++; else if (c < 0) neg++; }
    if (pos === 0 || neg === 0) return L.quadField[j * cols + i];
  }
  return -1;
}
