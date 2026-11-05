// Real stones near the camera (game-performance-optimization: LOD + chunking). The stones of the
// whole castle (a StoneSet, plain numbers) are bucketed into chunks (12 m cell × material × facing);
// geometry is built lazily per chunk in three levels: hi (rounded, chipped, domed) within lod.hi,
// mid (chamfered) within lod.mid, lo (slabs) within lod.lo. Silhouette stones (parapets, merlons,
// buttresses, turrets, corners, revetment) are sorted to the end of each chunk and stay, as lo slabs,
// out to lod.sil through a draw range. Beyond that the flat textured wall, which shows the very same
// stones, is all there is. Chunks facing away from the camera are hidden.
// Plain (non-silhouette) stones are only built within lod.plain. By default that is 0: on a flat wall the
// GPU does the depth (parallax occlusion, SDF joints, detail normals in materials.ts), and real geometry
// is kept for the silhouettes, where parallax cannot change the outline (Anders, 2026-11-05: "smart
// tricks to add depth on GPU rather than high detailed vertices"). `?stones=all` restores every stone.
// Inputs are parameters (the stone set, materials, LOD distances, camera position, clock), so tests
// drive it with plain fakes.
import * as THREE from 'three/webgpu';
import { type Stone, type StoneMat, type V3, F_SIL } from './layout';
import type { StoneSet } from './set';
import { GeoBuf, writeStone } from './mesh';

export interface LodParams { hi: number; mid: number; lo: number; sil: number; plain: number; hyst: number; cell: number; minChunk: number; ashlar: number }
export const LOD: LodParams = { hi: 8, mid: 20, lo: 32, sil: 45, plain: 0, hyst: 3, cell: 12, minChunk: 150, ashlar: 1.25 };

export type Level = 0 | 1 | 2 | 3; // off, lo, mid, hi
export interface LodState { level: Level; silOnly: boolean }
export interface Point3 { readonly x: number; readonly y: number; readonly z: number }

/** The level a chunk wants at distance d, with hysteresis around its current level. Plain stones are
 *  drawn only within lod.plain; otherwise a chunk with silhouette stones draws just those, at the level
 *  for d, or as lo slabs out to lod.sil. */
export function pickLevel(d: number, cur: LodState, hasSil: boolean, lod: LodParams = LOD): LodState {
  const h = lod.hyst;
  const band = (r: number, lv: Level) => d < r + (cur.level >= lv ? h : -h);
  const level: Level = band(lod.hi, 3) ? 3 : band(lod.mid, 2) ? 2 : band(lod.lo, 1) ? 1 : 0;
  if (level && d < lod.plain + (cur.level && !cur.silOnly ? h : -h)) return { level, silOnly: false };
  if (hasSil && (level || d < lod.sil + (cur.level ? h : -h))) return { level: level || 1, silOnly: true };
  return { level: 0, silOnly: false };
}

/** A chunk whose stones all face away from the camera (only for single-facing chunks, not right next to it). */
export function facingAway(cam: Point3, centre: V3, n: V3, d: number) {
  if (d <= 4 || (n[0] === 0 && n[1] === 0 && n[2] === 0)) return false;
  const dx = cam.x - centre[0], dy = cam.y - centre[1], dz = cam.z - centre[2], l = Math.hypot(dx, dy, dz) || 1;
  return (dx * n[0] + dy * n[1] + dz * n[2]) / l < -0.45;
}

/** Distance from p to the box [lo, hi]. */
export function boxDistance(p: Point3, lo: V3, hi: V3) {
  const dx = Math.max(lo[0] - p.x, 0, p.x - hi[0]), dy = Math.max(lo[1] - p.y, 0, p.y - hi[1]), dz = Math.max(lo[2] - p.z, 0, p.z - hi[2]);
  return Math.hypot(dx, dy, dz);
}

export interface Chunk extends LodState {
  mat: StoneMat; stones: Stone[]; silFrom: number; // stones[silFrom..] are silhouette stones
  lo: V3; hi: V3; centre: V3; n: V3;               // n = [0, 0, 0]: mixed facings, never culled
  mesh: THREE.Mesh | null;
  geo: (THREE.BufferGeometry | null)[]; silIndex: number[]; // per level: first index of the silhouette stones
}

/** Bucket stones into chunks: cell × material × one of 8 facings; small chunks merge per cell. */
export function makeChunks(set: StoneSet, lod: LodParams = LOD): Chunk[] {
  const map = new Map<string, Chunk>(), C = lod.cell;
  set.stones.forEach((st, i) => {
    const f = set.faces[st.face], { centre: p, normal: n } = set.ref(i);
    const bucket = (Math.round((Math.atan2(n[2], n[0]) / (Math.PI * 2)) * 8) + 8) % 8;
    const key = `${f.mat}|${Math.floor(p[0] / C)},${Math.floor(p[1] / C)},${Math.floor(p[2] / C)}|${bucket}`;
    let ch = map.get(key);
    if (!ch) {
      const a = (bucket / 8) * Math.PI * 2;
      ch = { mat: f.mat, stones: [], silFrom: 0, lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], centre: [0, 0, 0], n: [Math.cos(a), 0, Math.sin(a)], level: 0, silOnly: false, mesh: null, geo: [null, null, null], silIndex: [0, 0, 0] };
      map.set(key, ch);
    }
    ch.stones.push(st);
    grow(ch, set.cornerA(i)); grow(ch, set.cornerB(i));
  });
  // small chunks (merlons, buttress sides, turret facets…) go into one mixed chunk per cell, never facing-culled
  const merged = new Map<string, Chunk>();
  for (const [key, ch] of map) {
    if (ch.stones.length >= lod.minChunk) continue;
    const cell = key.slice(0, key.lastIndexOf('|'));
    let m = merged.get(cell);
    if (!m) merged.set(cell, (m = { ...ch, stones: [], lo: [...ch.lo], hi: [...ch.hi], n: [0, 0, 0], geo: [null, null, null], silIndex: [0, 0, 0] }));
    m.stones.push(...ch.stones); grow(m, ch.lo); grow(m, ch.hi);
    map.delete(key);
  }
  const chunks = [...map.values(), ...merged.values()];
  for (const ch of chunks) {
    const plain = ch.stones.filter((s) => !(s.flags & F_SIL)), sil = ch.stones.filter((s) => s.flags & F_SIL);
    ch.stones = [...plain, ...sil]; ch.silFrom = plain.length;
    for (let k = 0; k < 3; k++) { ch.lo[k] -= 0.15; ch.hi[k] += 0.15; ch.centre[k] = (ch.lo[k] + ch.hi[k]) / 2; }
  }
  return chunks;
}
function grow(ch: Chunk, p: V3) {
  for (let k = 0; k < 3; k++) { ch.lo[k] = Math.min(ch.lo[k], p[k]); ch.hi[k] = Math.max(ch.hi[k], p[k]); }
}

export interface StoneStats { stones: number; chunks: number; visibleChunks: number; hiChunks: number; stoneTriangles: number; buildMs: number; geometryMB: number }

export class StoneField {
  group = new THREE.Group();
  chunks: Chunk[];
  private buildMs = 0;

  constructor(
    private set: StoneSet,
    private materials: Record<StoneMat, THREE.Material>,
    private lod: LodParams = LOD,
    private now: () => number = () => performance.now(),
  ) {
    this.group.name = 'stones';
    this.chunks = makeChunks(set, lod);
  }

  /** Geometry of one chunk at one level (built once, kept until evicted). */
  geometry(ch: Chunk, level: 1 | 2 | 3) {
    const k = level - 1;
    if (ch.geo[k]) return ch.geo[k]!;
    const t0 = this.now();
    const b = new GeoBuf();
    ch.stones.forEach((st, i) => {
      if (i === ch.silFrom) ch.silIndex[k] = b.idx.length;
      const f = this.set.faces[st.face];
      writeStone(b, f, st, k as 0 | 1 | 2, this.set.specFor(f.mat));
    });
    if (ch.silFrom === ch.stones.length) ch.silIndex[k] = b.idx.length;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.setIndex(b.verts > 65535 ? new THREE.Uint32BufferAttribute(b.idx, 1) : new THREE.Uint16BufferAttribute(b.idx, 1));
    g.computeBoundingSphere();
    ch.geo[k] = g;
    this.buildMs += this.now() - t0;
    return g;
  }

  /** Pick each chunk's level for a camera at `cam`; build missing geometry within `budgetMs`. */
  update(cam: Point3, budgetMs = 4) {
    if (!this.group.visible) return;
    const t0 = this.now(), lod = this.lod;
    let built = 0;
    for (const ch of this.chunks) {
      // ashlar has about half as many stones per m² as rubble, so it keeps real stones further out
      const d = boxDistance(cam, ch.lo, ch.hi) / (ch.mat === 'new' ? lod.ashlar : 1);
      let want = pickLevel(d, ch, ch.silFrom < ch.stones.length, lod);
      if (want.level && facingAway(cam, ch.centre, ch.n, d)) want = { level: 0, silOnly: false };
      if (!want.level) { if (ch.mesh) ch.mesh.visible = false; ch.level = 0; ch.silOnly = false; this.evict(ch, d); continue; }
      if (want.level === ch.level && want.silOnly === ch.silOnly) continue;
      if (!ch.geo[want.level - 1]) {
        if (built && this.now() - t0 > budgetMs) continue; // build it on a later frame (at least one per frame)
        built++;
      }
      const g = this.geometry(ch, want.level);
      g.setDrawRange(want.silOnly ? ch.silIndex[want.level - 1] : 0, Infinity);
      if (!ch.mesh) {
        ch.mesh = new THREE.Mesh(g, this.materials[ch.mat]);
        ch.mesh.name = 'stones';
        ch.mesh.castShadow = false; ch.mesh.receiveShadow = true; // 3–9 cm relief is below shadow-map resolution
        ch.mesh.matrixAutoUpdate = false;
        this.group.add(ch.mesh);
      } else ch.mesh.geometry = g;
      ch.mesh.visible = true;
      ch.level = want.level; ch.silOnly = want.silOnly;
    }
  }

  /** Free geometry of chunks well out of range, so memory stays bounded when flying around. */
  private evict(ch: Chunk, d: number) {
    const lod = this.lod, lim = [lod.sil + 15, lod.mid + 15, lod.hi + 10];
    for (let k = 0; k < 3; k++) if (d > lim[k] && ch.geo[k]) { ch.geo[k]!.dispose(); ch.geo[k] = null; }
  }

  stats(): StoneStats {
    let vis = 0, hi = 0, tris = 0, bytes = 0;
    for (const ch of this.chunks) {
      const g = ch.level ? ch.geo[ch.level - 1] : null;
      if (g) { vis++; if (ch.level === 3) hi++; tris += (g.index!.count - (ch.silOnly ? ch.silIndex[ch.level - 1] : 0)) / 3; }
      for (const gg of ch.geo) if (gg) { for (const a of Object.values(gg.attributes)) bytes += (a as THREE.BufferAttribute).array.byteLength; bytes += gg.index!.array.byteLength; }
    }
    return { stones: this.set.stones.length, chunks: this.chunks.length, visibleChunks: vis, hiChunks: hi, stoneTriangles: Math.round(tris), buildMs: Math.round(this.buildMs), geometryMB: Math.round(bytes / 1e5) / 10 };
  }
}
