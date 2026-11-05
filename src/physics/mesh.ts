// Pure helpers that turn render geometry into collider input (game-physics recipe 5): bake world
// matrices, weld the triangle soup the Builder emits into an indexed mesh, drop degenerate triangles,
// and lay out a terrain grid for Rapier's heightfield. No Rapier import, so Vitest runs them plainly.
import type * as THREE from 'three/webgpu';
import type { V2 } from '../core/math2d';

export interface TriSoup { vertices: Float32Array; indices: Uint32Array }

/** World-space positions (and index, if any) of a geometry under a matrix (column-major 4×4). */
/** Column-major 4×4 product a·b (Matrix4.elements layout); b is read from `bo` on (instance arrays). */
export function mul4(a: ArrayLike<number>, b: ArrayLike<number>, bo = 0): number[] {
  const o = new Array<number>(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[bo + c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

export function bakePositions(geometry: THREE.BufferGeometry, m?: ArrayLike<number>): { pos: Float32Array; index: ArrayLike<number> | null } {
  const a = geometry.getAttribute('position') as THREE.BufferAttribute;
  const n = a.count, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = a.getX(i), y = a.getY(i), z = a.getZ(i);
    if (m) {
      pos[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
      pos[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      pos[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    } else { pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z; }
  }
  const idx = geometry.getIndex();
  return { pos, index: idx ? (idx.array as ArrayLike<number>) : null };
}

/**
 * Weld vertices that fall in the same `q`-metre cell and drop triangles that collapse. The Builder
 * writes three fresh vertices per triangle, so this shrinks a castle bin by ~5× and gives Rapier the
 * shared edges it needs. Keys pack (x, y, z) cells into one safe integer (±650 m, ±160 m at 5 mm).
 */
export function weld(pos: Float32Array, index: ArrayLike<number> | null, q = 0.005): TriSoup {
  const n = pos.length / 3;
  const remap = new Uint32Array(n);
  const seen = new Map<number, number>();
  const out: number[] = [];
  const OX = 131072, OY = 32768, NY = 65536, NZ = 262144;
  for (let i = 0; i < n; i++) {
    const ix = Math.round(pos[i * 3] / q) + OX, iy = Math.round(pos[i * 3 + 1] / q) + OY, iz = Math.round(pos[i * 3 + 2] / q) + OX;
    const key = (ix * NY + iy) * NZ + iz;
    let j = seen.get(key);
    if (j === undefined) { j = out.length / 3; seen.set(key, j); out.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); }
    remap[i] = j;
  }
  const triCount = index ? index.length / 3 : n / 3;
  const idx = new Uint32Array(triCount * 3);
  let k = 0;
  for (let t = 0; t < triCount; t++) {
    const a = remap[index ? index[t * 3] : t * 3], b = remap[index ? index[t * 3 + 1] : t * 3 + 1], c = remap[index ? index[t * 3 + 2] : t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    idx[k++] = a; idx[k++] = b; idx[k++] = c;
  }
  return { vertices: new Float32Array(out), indices: idx.slice(0, k) };
}

/** Concatenate several soups into one (one collider per material is plenty). */
export function mergeSoups(parts: TriSoup[]): TriSoup {
  let nv = 0, ni = 0;
  for (const p of parts) { nv += p.vertices.length; ni += p.indices.length; }
  const vertices = new Float32Array(nv), indices = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const p of parts) {
    vertices.set(p.vertices, ov);
    const base = ov / 3;
    for (let i = 0; i < p.indices.length; i++) indices[oi + i] = p.indices[i] + base;
    ov += p.vertices.length; oi += p.indices.length;
  }
  return { vertices, indices };
}

/**
 * A regular height grid (X fastest, Z rows increasing south, like a rotated PlaneGeometry), cropped to
 * [x0, x1] × [z0, z1], as an open triangle mesh. Not a Rapier heightfield on purpose: a heightfield
 * treats everything under it as inside, and the cellars and the moat tunnel run below the ground.
 * Triangles whose centre is in a hole (stair openings down into the cellars) are left out.
 */
export interface HeightGrid { heights: Float32Array; nx: number; nz: number; dx: number; dz: number; ox: number; oz: number }
export function gridSoup(g: HeightGrid, crop: { x0: number; x1: number; z0: number; z1: number }, hole?: (x: number, z: number) => boolean): TriSoup {
  const ix0 = Math.max(0, Math.floor((crop.x0 - g.ox) / g.dx)), ix1 = Math.min(g.nx - 1, Math.ceil((crop.x1 - g.ox) / g.dx));
  const iz0 = Math.max(0, Math.floor((crop.z0 - g.oz) / g.dz)), iz1 = Math.min(g.nz - 1, Math.ceil((crop.z1 - g.oz) / g.dz));
  const cx = ix1 - ix0 + 1, cz = iz1 - iz0 + 1;
  const vertices = new Float32Array(cx * cz * 3);
  for (let iz = 0; iz < cz; iz++) for (let ix = 0; ix < cx; ix++) {
    const o = (iz * cx + ix) * 3;
    vertices[o] = g.ox + (ix + ix0) * g.dx; vertices[o + 1] = g.heights[(iz + iz0) * g.nx + (ix + ix0)]; vertices[o + 2] = g.oz + (iz + iz0) * g.dz;
  }
  const idx: number[] = [];
  for (let iz = 0; iz < cz - 1; iz++) for (let ix = 0; ix < cx - 1; ix++) {
    // same diagonal as PlaneGeometry (a b d / b c d), so the collider matches the rendered ground
    const a = iz * cx + ix, b = a + cx, c = b + 1, d = a + 1;
    if (hole && hole(g.ox + (ix + ix0 + 0.5) * g.dx, g.oz + (iz + iz0 + 0.5) * g.dz)) continue;
    idx.push(a, b, d, b, c, d);
  }
  return { vertices, indices: new Uint32Array(idx) };
}

/** Vertical ribbon along a closed or open polyline from y0(point) to y1 (an invisible wall). */
export function ribbon(pts: V2[], y0: number | ((p: V2) => number), y1: number, closed = true): TriSoup {
  const n = pts.length, vertices = new Float32Array(n * 6), idx: number[] = [];
  for (let i = 0; i < n; i++) { const b = typeof y0 === 'number' ? y0 : y0(pts[i]); vertices.set([pts[i][0], b, pts[i][1], pts[i][0], y1, pts[i][1]], i * 6); }
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = i * 2, b = ((i + 1) % n) * 2;
    idx.push(a, b, b + 1, a, b + 1, a + 1);
  }
  return { vertices, indices: new Uint32Array(idx) };
}
