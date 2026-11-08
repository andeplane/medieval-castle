// Placing props: merge placed props into one mesh per material, and the layout of the prop-kit
// review page (gallery cells and four dressed room vignettes). Pure data, unit-tested.
import { PropMesh, translate, rotY, compose, type V3 } from './geom';
import type { Flame } from '../light/types';
import { KIT, KIND, makeProp, type Prop, type Emitter, type PropKind } from './kit';

export interface Placed { prop: Prop; at: V3; yaw: number }

/** Local (x, z) rotated by yaw, the same rotation rotY applies. */
export const yawXZ = (x: number, z: number, yaw: number): [number, number] => [Math.cos(yaw) * x + Math.sin(yaw) * z, -Math.sin(yaw) * x + Math.cos(yaw) * z];

/** Merge placed props into one PropMesh (one draw call per material) and collect world emitters. */
export function mergePlaced(items: Placed[]): { mesh: PropMesh; emitters: Emitter[] } {
  const mesh = new PropMesh();
  for (const it of items) mesh.with(compose(translate(it.at[0], it.at[1], it.at[2]), rotY(it.yaw)), () => mesh.append(it.prop.mesh));
  return { mesh, emitters: placedFires(items).emitters };
}

/** The world emitters and flames of placed props without their triangles (the same as mergePlaced's):
 * a room's fires, known before its furniture is built. */
export function placedFires(items: Placed[]): { emitters: Emitter[]; flames: Flame[] } {
  const mesh = new PropMesh(), emitters: Emitter[] = [];
  for (const it of items) {
    mesh.with(compose(translate(it.at[0], it.at[1], it.at[2]), rotY(it.yaw)), () => mesh.appendFlames(it.prop.mesh));
    for (const e of it.prop.meta.emitters) {
      const [x, z] = yawXZ(e.position[0], e.position[2], it.yaw);
      emitters.push({ ...e, position: [it.at[0] + x, it.at[1] + e.position[1], it.at[2] + z] });
    }
  }
  return { emitters, flames: mesh.flames };
}

/** World-space footprint rectangle [minX, minZ, maxX, maxZ] of a placed prop (navmesh obstacle). */
export function placedFootprint(p: Placed): [number, number, number, number] {
  const b = p.prop.bounds, xs: number[] = [], zs: number[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const z of [b.min[2], b.max[2]]) { const [a, c] = yawXZ(x, z, p.yaw); xs.push(p.at[0] + a); zs.push(p.at[2] + c); }
  return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
}

export interface Stage { min: V3; max: V3; open: 'south' }
export interface PreviewView { name: string; label: string; pos: V3; target: V3 }
export interface PreviewLayout { placed: Placed[]; stages: Stage[]; walls: { min: V3; max: V3 }[]; views: PreviewView[] }

const CELL = 4.2, COLS = 6, CEIL = 3.4;

/** Where a kind sits in its gallery cell: floor props on the floor, wall props on the back wall. */
function cellPlacement(k: PropKind, cx: number, cz: number, seed: number): Placed {
  const prop = makeProp(k, seed);
  if (k.placement === 'wall') return { prop, at: [cx, k.mount ?? 1.8, cz - 1.6], yaw: 0 };
  if (k.placement === 'ceiling') return { prop, at: [cx, CEIL, cz], yaw: 0 };
  return { prop, at: [cx, 0, cz], yaw: 0 };
}

function frame(name: string, label: string, p: Placed): PreviewView {
  const b = p.prop.bounds, size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 0.5);
  const mid: V3 = [p.at[0] + (b.min[0] + b.max[0]) / 2, p.at[1] + (b.min[1] + b.max[1]) / 2, p.at[2] + (b.min[2] + b.max[2]) / 2];
  const d = size * 1.35 + 0.6;
  return { name, label, pos: [mid[0] + d * 0.55, mid[1] + d * 0.38, mid[2] + d * 0.8], target: mid };
}

/** Dressed vignettes, each a three-walled room open to the south (+z), origin at its north-west corner:
 * the great hall, a bedchamber and a drawing room in the 19th-century refit, and the store room. */
function vignettes(x0: number, z0: number): { placed: Placed[]; stages: Stage[]; views: PreviewView[] } {
  const placed: Placed[] = [], stages: Stage[] = [], views: PreviewView[] = [];
  const P = (kind: string, seed: number, at: V3, yaw = 0): Placed => { const p = { prop: makeProp(kind, seed), at, yaw }; placed.push(p); return p; };
  // backed against a wall: north (z = w, facing south), west (x = w, facing east) or east (x = w, facing west)
  const N = (kind: string, seed: number, x: number, w: number) => { const pr = makeProp(kind, seed); return P(kind, seed, [x, 0, w + 0.04 - pr.bounds.min[2]], 0); };
  const Wst = (kind: string, seed: number, z: number, w: number) => { const pr = makeProp(kind, seed); return P(kind, seed, [w + 0.04 - pr.bounds.min[2], 0, z], Math.PI / 2); };
  const E = (kind: string, seed: number, z: number, w: number) => { const pr = makeProp(kind, seed); return P(kind, seed, [w - 0.04 + pr.bounds.min[2], 0, z], -Math.PI / 2); };
  // hung on a wall at the kind's mount height: yaw 0 north, PI/2 west, -PI/2 east
  const hang = (kind: string, seed: number, at: [number, number], yaw: number, y = KIND[kind].mount!) => P(kind, seed, [at[0], y, at[1]], yaw);
  // things on a chimneypiece: a garniture on the mantel, a glass or picture above it
  const dressHearth = (h: Placed, garniture: string, xs: number[], above: string, seed: number) => {
    const mt = h.prop.meta.mantel!, ab = h.prop.meta.above!;
    for (const x of xs) { const [ox, oz] = yawXZ(x * mt.w / 2, mt.z, h.yaw); P(garniture, seed + x, [h.at[0] + ox, mt.y, h.at[2] + oz], h.yaw); }
    const pr = makeProp(above, seed), [ox, oz] = yawXZ(ab[0], ab[2], h.yaw);
    P(above, seed, [h.at[0] + ox, ab[1] - pr.bounds.min[1], h.at[2] + oz], h.yaw);
  };
  const facing = (from: V3, to: V3) => Math.atan2(to[0] - from[0], to[2] - from[2]);
  // great hall: the hooded hearth between suits of armour, the lord's table on the west wall, two long
  // tables under iron candle rings, stag heads and trophies, portraits, candle sconces
  {
    const ox = x0, oz = z0, W = 11, D = 9, H = 5.2;
    stages.push({ min: [ox, 0, oz], max: [ox + W, H, oz + D], open: 'south' });
    const h = N('hooded-hearth', 1, ox + W / 2, oz), hw = h.prop.bounds.max[0];
    for (const sx of [-1, 1]) N('armour', 2 + sx, ox + W / 2 + sx * (hw + 0.55), oz);
    P('skin', 3, [ox + W / 2, 0, h.at[2] + 1.9], Math.PI / 2);
    const throne = Wst('throne', 1, oz + 5, ox);
    const high = P('trestle-table', 2, [throne.at[0] + 1.4, 0, oz + 5], Math.PI / 2);
    P('candelabrum', 3, [high.at[0], 0.78, oz + 4.4]); P('tableware', 4, [high.at[0], 0.78, oz + 5.4], Math.PI / 2);
    for (const [i, x] of [ox + 5.0, ox + 8.2].entries()) {
      P('trestle-table', 10 + i, [x, 0, oz + 5.4], Math.PI / 2);
      P('bench', 20 + i, [x - 0.75, 0, oz + 5.4], Math.PI / 2);
      P('bench', 30 + i, [x + 0.75, 0, oz + 5.4], Math.PI / 2);
      P('tableware', 40 + i, [x, 0.78, oz + 4.9 + i * 0.8], Math.PI / 2);
      P('chandelier', 50 + i, [x, H, oz + 5.4]);
    }
    for (const [i, sx] of [-1, 1].entries()) hang('stag-head', 60 + i, [ox + W / 2 + sx * 3.4, oz + 0.02], 0);
    hang('tapestry', 62, [ox + 2.2, oz + 0.02], 0, 3.2);
    hang('portrait', 63, [ox + W - 2.0, oz + 0.02], 0, 2.6);
    for (const [i, z] of [oz + 2.6, oz + 6.4].entries()) hang('weapon-trophy', 64 + i, [ox + W - 0.02, z], -Math.PI / 2);
    hang('portrait', 66, [ox + 0.02, oz + 2.4], Math.PI / 2);
    for (const z of [oz + 3.4, oz + 7.4]) { hang('candle-sconce', 70 + z, [ox + 0.02, z], Math.PI / 2); hang('candle-sconce', 80 + z, [ox + W - 0.02, z + 1.0], -Math.PI / 2); }
    views.push({ name: 'hall', label: 'Hall', pos: [ox + W / 2 + 1.2, 1.7, oz + D + 2.6], target: [ox + W / 2, 1.6, oz + 2] });
  }
  // bedchamber: the tester bed in a corner, a chest at its foot and a candle at its side; a chimneypiece
  // on the east wall with a glass over it and an armchair at the fire; a rug, a portrait, a sconce
  {
    const ox = x0 + 13, oz = z0, W = 7, D = 6, H = 3.6;
    stages.push({ min: [ox, 0, oz], max: [ox + W, H, oz + D], open: 'south' });
    const bed = N('four-poster', 3, ox + 1.7, oz);
    P('chest', 2, [bed.at[0], 0, bed.at[2] + bed.prop.bounds.max[2] + 0.4], Math.PI / 2);
    const st = P('side-table', 4, [bed.at[0] + bed.prop.bounds.max[0] + 0.4, 0, oz + 0.45]);
    P('candlestick', 5, [st.at[0], st.prop.bounds.max[1], st.at[2]]);
    const h = E('chimneypiece', 6, oz + 2.6, ox + W);
    dressHearth(h, 'candlestick', [-0.72, 0.72], 'overmantel-mirror', 7);
    const fire: V3 = [h.at[0] - 0.5, 0, h.at[2]], chair: V3 = [h.at[0] - 1.8, 0, h.at[2] + 1.1];
    P('armchair', 9, chair, facing(chair, fire));
    P('skin', 10, [h.at[0] - 1.35, 0, h.at[2]], h.yaw + Math.PI / 2); // lying along the hearth, as in the castle
    P('rug', 12, [ox + 2.9, 0, oz + 3.9], Math.PI / 2);
    N('cupboard', 13, ox + W - 1.0, oz);
    hang('portrait', 14, [ox + 0.02, oz + 3.4], Math.PI / 2);
    hang('candle-sconce', 15, [ox + W - 0.02, oz + 4.6], -Math.PI / 2);
    views.push({ name: 'chamber', label: 'Bedchamber', pos: [ox + W / 2 + 0.8, 1.65, oz + D + 2.0], target: [ox + W / 2 - 0.2, 1.1, oz + 1.8] });
  }
  // store room: barrels, crates, sacks, firewood, straw, a bucket, the armoury rack, a cauldron
  {
    const ox = x0 + 22, oz = z0, W = 7, D = 6, H = 3.2;
    stages.push({ min: [ox, 0, oz], max: [ox + W, H, oz + D], open: 'south' });
    for (let i = 0; i < 4; i++) P('barrel', i, [ox + 0.5 + i * 0.66, 0, oz + 0.45], i);
    P('barrel', 9, [ox + 0.85, 0, oz + 1.15], 2);
    for (let i = 0; i < 3; i++) P('crate', i, [ox + W - 0.7, i === 2 ? 0.62 : 0, oz + 0.6 + (i === 1 ? 0.8 : 0)], i * 0.3);
    for (let i = 0; i < 5; i++) P('sack', i, [ox + 3.4 + (i % 3) * 0.45, 0, oz + 0.4 + Math.floor(i / 3) * 0.5], i);
    P('firewood', 1, [ox + 0.5, 0, oz + 3.2], Math.PI / 2);
    P('straw-heap', 1, [ox + 2.4, 0, oz + 3.4]);
    P('bucket', 1, [ox + 1.4, 0, oz + 2.2]);
    P('cauldron', 1, [ox + 4.6, 0, oz + 2.6]);
    P('weapon-rack', 1, [ox + W - 0.4, 0, oz + 3.4], -Math.PI / 2);
    P('armour-stand', 1, [ox + W - 1.4, 0, oz + 4.6], -0.4);
    P('sconce', 1, [ox + 0.02, 1.8, oz + 1.8], Math.PI / 2);
    views.push({ name: 'store', label: 'Store', pos: [ox + W / 2 + 0.6, 1.7, oz + D + 2.2], target: [ox + W / 2, 0.8, oz + 1.6] });
  }
  // drawing room: a carpet, the chimneypiece with a portrait over it, a sofa and two armchairs round the
  // fire, a lamp on a side table, a bookcase and a desk, pictures, candle sconces
  {
    const ox = x0 + 31, oz = z0, W = 8, D = 6.5, H = 4;
    stages.push({ min: [ox, 0, oz], max: [ox + W, H, oz + D], open: 'south' });
    P('carpet', 3, [ox + W / 2, 0, oz + 3.0]);
    const h = N('chimneypiece', 1, ox + W / 2, oz);
    dressHearth(h, 'candelabrum', [0], 'portrait', 2);
    const fire: V3 = [h.at[0], 0, h.at[2] + 0.2];
    for (const sx of [-1, 1]) { const c: V3 = [h.at[0] + sx * 1.05, 0, h.at[2] + 1.8]; P('armchair', 3, c, facing(c, fire)); }
    P('sofa', 6, [h.at[0], 0, h.at[2] + 3.1], Math.PI);
    P('footstool', 9, [h.at[0] + 0.6, 0, h.at[2] + 1.3], 0.3);
    const st = P('side-table', 5, [h.at[0] + 1.9, 0, h.at[2] + 2.9]);
    P('oil-lamp', 6, [st.at[0], st.prop.bounds.max[1], st.at[2]]);
    Wst('bookcase', 7, oz + 2.4, ox);
    const desk = E('pedestal-desk', 8, oz + 4.4, ox + W - 0.2);
    P('hall-chair', 9, [desk.at[0] - 0.85, 0, desk.at[2]], Math.PI / 2);
    P('book-stack', 10, [desk.at[0] + 0.05, desk.prop.bounds.max[1], desk.at[2] + 0.4], -Math.PI / 2);
    hang('portrait', 11, [ox + W - 0.02, oz + 2.2], -Math.PI / 2);
    hang('stag-head', 12, [ox + 0.02, oz + 4.8], Math.PI / 2);
    for (const sx of [-1, 1]) hang('candle-sconce', 13 + sx, [h.at[0] + sx * 2.3, oz + 0.02], 0);
    views.push({ name: 'drawing', label: 'Drawing room', pos: [ox + W / 2 + 0.6, 1.7, oz + D + 2.4], target: [ox + W / 2, 1.2, oz + 1.6] });
  }
  return { placed, stages, views };
}

/** The whole review page: one gallery cell per kind (seed-variant row behind it) and the vignettes. */
export function previewLayout(seed = 1): PreviewLayout {
  const placed: Placed[] = [], walls: { min: V3; max: V3 }[] = [], views: PreviewView[] = [];
  // wall-mounted kinds go first so they sit in the back row, against the one gallery wall
  const order = [...KIT].sort((a, b) => Number(b.placement === 'wall') - Number(a.placement === 'wall'));
  order.forEach((k, i) => {
    const cx = (i % COLS) * CELL, cz = Math.floor(i / COLS) * CELL;
    const p = cellPlacement(k, cx, cz, seed);
    placed.push(p);
    views.push(frame(`p-${k.name}`, k.name, p));
  });
  walls.push({ min: [-CELL / 2, 0, -1.9], max: [(COLS - 0.5) * CELL, CEIL + 0.6, -1.6] });
  const v = vignettes(-1, -14);
  placed.push(...v.placed);
  const rows = Math.ceil(KIT.length / COLS);
  views.unshift(
    { name: 'kit', label: 'Kit', pos: [((COLS - 1) * CELL) / 2, 9, rows * CELL + 7], target: [((COLS - 1) * CELL) / 2, 0.5, (rows - 1) * CELL / 2] },
    ...v.views,
  );
  return { placed, stages: v.stages, walls, views };
}

/** World-space triangle soup (non-indexed xyz) of the box colliders of placed props, for static physics. */
export function colliderSoup(items: Placed[]): number[] {
  const out: number[] = [];
  const F = [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]];
  for (const it of items) {
    if (!it.prop.kind.blocksNav) continue;
    for (const c of it.prop.meta.colliders) {
      const v: V3[] = [];
      for (const y of [-1, 1]) for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const [x, z] = yawXZ(c.centre[0] + sx * c.half[0], c.centre[2] + sz * c.half[2], it.yaw);
        v.push([it.at[0] + x, it.at[1] + c.centre[1] + y * c.half[1], it.at[2] + z]);
      }
      for (const [a, b, cc, d] of F) out.push(...v[a], ...v[b], ...v[cc], ...v[a], ...v[cc], ...v[d]);
    }
  }
  return out;
}
