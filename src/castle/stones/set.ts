// The castle's stones as one queryable set (D.1): laid out once from the Builder's stone faces and
// exclusion solids, then shared by rendering (StoneField), and later physics and NPC navigation.
// Pure: no three.js. Everything comes in as parameters (faces, solids, masonry specs, seed).
import { type Stone, type StoneFace, type Exclusion, type V3, type SpecFor, masonrySpec, ExclusionIndex, exclusionShapes, faceBounds, layoutFace, faceToWorld, faceNormal, STONE_SALT } from './layout';

/** A stone with its face and world placement. */
export interface StoneRef { stone: Stone; face: StoneFace; centre: V3; normal: V3 }

export interface StoneSetOpts { specFor?: SpecFor; salt?: number; cell?: number }

/** Lay out every stone of every face (the slow part of a StoneSet: ~0.6 s for the castle on an M-series Mac). */
export function layoutStones(faces: StoneFace[], exclusions: Exclusion[], o: Pick<StoneSetOpts, 'specFor' | 'salt'> = {}): Stone[] {
  const specFor = o.specFor ?? masonrySpec, out: Stone[] = [];
  const index = new ExclusionIndex(exclusions);
  faces.forEach((f, fi) => {
    const [lo, hi] = faceBounds(f);
    for (const st of layoutFace(f, fi, exclusionShapes(f, index.query(lo, hi)), specFor(f.mat), o.salt ?? STONE_SALT)) out.push(st);
  });
  return out;
}

const FIELDS = ['face', 'a', 'b', 'ya', 'yb', 'course', 'flags', 'id', 'bulge', 'tilt', 'seed'] as const;

/** Stones as one flat Float64Array (transferable from a worker without cloning 140k objects). */
export function packStones(stones: Stone[]): Float64Array {
  const n = FIELDS.length, out = new Float64Array(stones.length * n);
  stones.forEach((st, i) => { for (let k = 0; k < n; k++) out[i * n + k] = st[FIELDS[k]]; });
  return out;
}

export function unpackStones(buf: Float64Array): Stone[] {
  const n = FIELDS.length, out: Stone[] = new Array(buf.length / n);
  for (let i = 0, j = 0; i < out.length; i++, j += n) {
    out[i] = { face: buf[j], a: buf[j + 1], b: buf[j + 2], ya: buf[j + 3], yb: buf[j + 4], course: buf[j + 5], flags: buf[j + 6], id: buf[j + 7], bulge: buf[j + 8], tilt: buf[j + 9], seed: buf[j + 10] };
  }
  return out;
}

export class StoneSet {
  readonly stones: Stone[];
  readonly centres: Float64Array;
  private cells = new Map<string, number[]>();
  private cell: number;
  readonly specFor: SpecFor;

  /** `laid`: the stones already laid out by layoutStones (e.g. in a worker) for these faces and options. */
  constructor(readonly faces: StoneFace[], exclusions: Exclusion[], o: StoneSetOpts = {}, laid?: Stone[]) {
    this.specFor = o.specFor ?? masonrySpec;
    this.cell = o.cell ?? 4;
    this.stones = laid ?? layoutStones(faces, exclusions, o);
    this.centres = new Float64Array(this.stones.length * 3);
    this.stones.forEach((st, i) => {
      const p = faceToWorld(faces[st.face], (st.a + st.b) / 2, (st.ya + st.yb) / 2, 0);
      this.centres.set(p, i * 3);
      const key = this.key(p[0], p[1], p[2]);
      let c = this.cells.get(key);
      if (!c) this.cells.set(key, (c = []));
      c.push(i);
    });
  }

  private key(x: number, y: number, z: number) {
    const c = this.cell;
    return `${Math.floor(x / c)},${Math.floor(y / c)},${Math.floor(z / c)}`;
  }

  /** World centre of stone i (on the wall plane, at the middle of its cell). */
  centre(i: number): V3 { return [this.centres[i * 3], this.centres[i * 3 + 1], this.centres[i * 3 + 2]]; }

  /** World points of the cell's bottom-left and top-right corners on the wall plane. */
  cornerA(i: number): V3 { const st = this.stones[i]; return faceToWorld(this.faces[st.face], st.a, st.ya, 0); }
  cornerB(i: number): V3 { const st = this.stones[i]; return faceToWorld(this.faces[st.face], st.b, st.yb, 0); }

  ref(i: number): StoneRef {
    const st = this.stones[i], f = this.faces[st.face];
    return { stone: st, face: f, centre: this.centre(i), normal: faceNormal(f, (st.a + st.b) / 2) };
  }

  /** Stones whose centre lies within r of p, nearest first. */
  stonesNear(p: V3, r: number): StoneRef[] {
    const c = this.cell, r2 = r * r, hits: [number, number][] = [];
    for (let x = Math.floor((p[0] - r) / c); x <= Math.floor((p[0] + r) / c); x++)
      for (let y = Math.floor((p[1] - r) / c); y <= Math.floor((p[1] + r) / c); y++)
        for (let z = Math.floor((p[2] - r) / c); z <= Math.floor((p[2] + r) / c); z++)
          for (const i of this.cells.get(`${x},${y},${z}`) ?? []) {
            const dx = this.centres[i * 3] - p[0], dy = this.centres[i * 3 + 1] - p[1], dz = this.centres[i * 3 + 2] - p[2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= r2) hits.push([d2, i]);
          }
    return hits.sort((a, b) => a[0] - b[0]).map(([, i]) => this.ref(i));
  }
}
