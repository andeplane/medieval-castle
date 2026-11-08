// Chimneypieces and hooded hearths sit in tone with the walls they stand against (2026-11-08: the hall's
// hood and shafts read near-white against the rubble on Anders' Mac). Over every fireplace the game
// furnishes, the stone of its surround (the faces that look into the room: fronts, the hood's slope, tops)
// is lit with the interior shader's own daylight (tableDaylight, from the baked room table) and the
// readability floor, and compared with the room's wall beside it under the same light, each with the
// albedo it renders with: the prop stone texture × the piece's tint, and the walls as their shader draws
// them (WALL_STONE). Firelight is left out on both sides: a fire lighting the flank it burns beside is
// meant, and its own front is roomLight.test's rule.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { bakeInteriorLight, bvhOccluder, createInteriorLight, MAX_AP } from '../src/render/interiorLight';
import { buildInterior } from '../src/castle/interior/index';
import { buildCastle } from '../src/castle/castle';
import type { MatKey } from '../src/castle/builder';
import { AP_TEXELS, inPoly, nearestRoom, tableDaylight, type WindowInput } from '../src/render/interiorMath';
import { dressRoom, groupKey, variantPool } from '../src/props/dress';
import { mergePlaced, yawXZ } from '../src/props/place';
import { stoneTex, WALL_STONE } from '../src/props/textures';
import type { V3 } from '../src/castle/interior/types';

const lum = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/** Mean linear albedo of the prop stone texture (the prop material is its map × the vertex tint, no AO). */
function stoneAlbedo(): V3 {
  const t = stoneTex(128), s: V3 = [0, 0, 0], n = t.size * t.size;
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) s[k] += Math.pow(t.albedo[i * 4 + k] / 255, 2.2);
  return [s[0] / n, s[1] / n, s[2] / n];
}

/** Most a surround may render against the wall beside it under the same light. */
const MAX_RATIO = 1.3;

describe('fireplace stone in tone with the walls', () => {
  it('renders dressed stone a little lighter than the rubble, no lighter than the castle\'s ashlar', () => {
    const a = lum(stoneAlbedo());
    expect(a).toBeGreaterThan(lum(WALL_STONE.old));
    expect(a).toBeLessThanOrEqual(lum(WALL_STONE.new));
  });

  it('lights every chimneypiece and hood no brighter than 1.3 × the wall beside it', () => {
    const { builder, lights } = buildCastle();
    const mats = Object.fromEntries(['old', 'new', 'trim', 'slate', 'lead', 'wood', 'iron', 'void', 'glass', 'pave', 'rock', 'pool', 'glow'].map((k) => [k, new THREE.MeshStandardNodeMaterial()])) as unknown as Record<MatKey, THREE.Material>;
    const res = buildInterior(mats, builder, { heightAt: () => 2.6 });
    const castle = builder.build(mats);
    const light = createInteriorLight(1024, res.plan.rooms);
    // a high afternoon sun, as the shell bake test: the south-facing halls get daylight through every window
    bakeInteriorLight(res.groups, bvhOccluder([castle, ...res.groups.map((g) => g.object)]), { plan: res.plan, windows: lights as WindowInput[], sun: () => ({ dir: [-0.4, 0.63, 0.66], irradiance: [3.2, 3.1, 2.9] }), light });
    const plan = res.plan, rooms = plan.rooms.slice(0, light.maxRooms), make = variantPool();
    const data = light.table.image.data as Float32Array, texW = 1 + MAX_AP * AP_TEXELS, gain = light.gain.value;
    const floor = lum(light.floor.value.toArray()), stone = stoneAlbedo();
    /** The interior shader's daylight + floor at a point, as luminance, in the room its triangle would be tagged with. */
    const ambient = (P: V3, N: V3, prefer: Set<number>) => {
      const row = nearestRoom(rooms, [P[0] + N[0] * 0.25, P[1] + N[1] * 0.25, P[2] + N[2] * 0.25], 4.5, prefer);
      if (row < 0) return floor;
      const d = tableDaylight(data, texW, row, P, N, gain);
      return floor + lum(d.apertures) + lum(d.bounce);
    };
    const faults: string[] = [], seen = new Set<string>();
    const hoods: string[] = [];
    let pieces = 0, daylit = 0, worstAll = 0;
    for (const r of plan.rooms) {
      const d = dressRoom(r, plan, { make, windows: res.windows });
      const prefer = new Set(plan.rooms.flatMap((x, i) => (groupKey(x) === groupKey(r) && i < rooms.length ? [i] : [])));
      const wallAlbedo = lum(plan.phase[r.id] === 'old' ? WALL_STONE.old : WALL_STONE.new);
      for (const p of d.placed) {
        if (!['chimneypiece', 'hooded-hearth', 'spit-hearth'].includes(p.prop.kind.name)) continue;
        pieces++; seen.add(p.prop.kind.name);
        const [fx, fz] = yawXZ(0, 1, p.yaw), fwd: V3 = [fx, 0, fz];
        const world = (x: number, y: number, z: number): V3 => { const [wx, wz] = yawXZ(x, z, p.yaw); return [p.at[0] + wx, p.at[1] + y, p.at[2] + wz]; };
        const { min, max } = p.prop.bounds;
        // the wall it stands against, 0.6 m clear of it on either side, at 1.0, 1.6 and 2.4 m; points inside the room only
        const wall: number[] = [];
        for (const x of [min[0] - 0.6, max[0] + 0.6]) for (const y of [1, 1.6, 2.4]) {
          const P = world(x, y, min[2] + 0.01);
          if (inPoly(r.poly, P[0] + fwd[0] * 0.05, P[2] + fwd[2] * 0.05)) wall.push(ambient(P, fwd, prefer) * wallAlbedo);
        }
        if (!wall.length) continue;
        wall.sort((a, b) => a - b);
        const ref = wall[Math.floor(wall.length / 2)]; // the median: a point in a window's embrasure says nothing of the wall
        if (ref > floor * wallAlbedo * 1.5) daylit++;
        // its surround: the stone faces looking into the room (fronts, the hood's slope, tops), above the hearth slab
        const b = mergePlaced([p]).mesh.bins.stone;
        const lits: [number, number][] = []; // (ratio to the wall, area)
        for (let t = 0; t * 9 < b.pos.length; t++) {
          const v = (k: number): V3 => [b.pos[t * 9 + k * 3], b.pos[t * 9 + k * 3 + 1], b.pos[t * 9 + k * 3 + 2]];
          const [A, B, C] = [v(0), v(1), v(2)], c: V3 = [0, 1, 2].map((j) => (A[j] + B[j] + C[j]) / 3) as V3;
          const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
          const area = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
          const n: V3 = [0, 1, 2].map((j) => b.nor[t * 9 + j]) as V3;
          const tint: V3 = [0, 1, 2].map((j) => b.col[t * 9 + j]) as V3;
          // the faces turned into the room (fronts, the hood's slope, the fronts of the shafts), above the slab; not the soot
          if (n[0] * fwd[0] + n[2] * fwd[2] < 0.5 || c[1] < p.at[1] + 0.3 || lum(tint) < 0.25) continue;
          lits.push([ambient(c, n, prefer) * lum([tint[0] * stone[0], tint[1] * stone[1], tint[2] * stone[2]]) / ref, area]);
        }
        const total = lits.reduce((s, l) => s + l[1], 0), mean = lits.reduce((s, l) => s + l[0] * l[1], 0) / total;
        lits.sort((a, b) => a[0] - b[0]);
        // nine tenths of it by area (a bevel turned square to a window may catch more, as it would)
        let acc = 0, p90 = 0;
        for (const [k, w] of lits) { acc += w; if (acc >= total * 0.9) { p90 = k; break; } }
        if (p.prop.kind.name !== 'chimneypiece') hoods.push(`${r.id} ${p.prop.kind.name} ${p90.toFixed(2)} (mean ${mean.toFixed(2)})`);
        worstAll = Math.max(worstAll, p90);
        if (p90 > MAX_RATIO) faults.push(`${r.id} ${p.prop.kind.name}: ${p90.toFixed(2)} × the wall beside it (mean ${mean.toFixed(2)})`);
      }
    }
    console.info(`hearth stone: ${pieces} pieces, ${daylit} with daylit walls, worst ${worstAll.toFixed(2)} × the wall; hoods: ${hoods.join('; ')}`);
    expect(seen).toEqual(new Set(['chimneypiece', 'hooded-hearth', 'spit-hearth']));
    expect(pieces).toBeGreaterThan(40);
    expect(daylit).toBeGreaterThan(10);
    expect(faults).toEqual([]);
  }, 180_000);
});
