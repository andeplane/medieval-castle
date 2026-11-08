// A uniform x/z grid over triangles, so whole-castle checks look at the triangles near a door or a wall
// instead of scanning every triangle of the castle for each one (test speed only: the checks still run
// over the whole castle). `near(x0, z0, x1, z1)` returns, in their original order, every triangle whose
// bounding box overlaps the rectangle, and every triangle whose bounding-box centre lies within its
// half-diagonal of it, so a caller can apply its own exact test to the result and get the same answer as
// over the whole list.
export interface Boxed { lo: ArrayLike<number>; hi: ArrayLike<number> }

export function triGrid<T extends Boxed>(tris: T[], cell = 2) {
  const cells = new Map<number, number[]>();
  const key = (i: number, k: number) => i * 65536 + k;
  const ix = (v: number) => Math.floor(v / cell);
  tris.forEach((t, n) => {
    // each triangle goes in every cell of the square of its half-diagonal round its box's centre (that square holds the box)
    const cx = (t.lo[0] + t.hi[0]) / 2, cz = (t.lo[2] + t.hi[2]) / 2, h = Math.hypot(t.hi[0] - t.lo[0], t.hi[2] - t.lo[2]) / 2;
    for (let i = ix(cx - h); i <= ix(cx + h); i++) for (let k = ix(cz - h); k <= ix(cz + h); k++) {
      const c = cells.get(key(i, k));
      if (c) c.push(n); else cells.set(key(i, k), [n]);
    }
  });
  const seen = new Uint32Array(tris.length);
  let stamp = 0;
  return {
    near(x0: number, z0: number, x1: number, z1: number): T[] {
      stamp++;
      const out: number[] = [];
      for (let i = ix(x0); i <= ix(x1); i++) for (let k = ix(z0); k <= ix(z1); k++) {
        for (const n of cells.get(key(i, k)) ?? []) if (seen[n] !== stamp) { seen[n] = stamp; out.push(n); }
      }
      return out.sort((a, b) => a - b).map((n) => tris[n]);
    },
  };
}
