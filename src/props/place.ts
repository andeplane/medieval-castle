// Placing props: merge placed props into one mesh per material, and the layout of the prop-kit
// review page (gallery cells and three dressed room vignettes). Pure data, unit-tested.
import { PropMesh, translate, rotY, compose, type V3 } from './geom';
import { KIT, makeProp, type Prop, type Emitter, type PropKind } from './kit';

export interface Placed { prop: Prop; at: V3; yaw: number }

/** Local (x, z) rotated by yaw, the same rotation rotY applies. */
export const yawXZ = (x: number, z: number, yaw: number): [number, number] => [Math.cos(yaw) * x + Math.sin(yaw) * z, -Math.sin(yaw) * x + Math.cos(yaw) * z];

/** Merge placed props into one PropMesh (one draw call per material) and collect world emitters. */
export function mergePlaced(items: Placed[]): { mesh: PropMesh; emitters: Emitter[] } {
  const mesh = new PropMesh(), emitters: Emitter[] = [];
  for (const it of items) {
    mesh.with(compose(translate(it.at[0], it.at[1], it.at[2]), rotY(it.yaw)), () => mesh.append(it.prop.mesh));
    for (const e of it.prop.meta.emitters) {
      const [x, z] = yawXZ(e.position[0], e.position[2], it.yaw);
      emitters.push({ ...e, position: [it.at[0] + x, it.at[1] + e.position[1], it.at[2] + z] });
    }
  }
  return { mesh, emitters };
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

/** Dressed vignettes, each a three-walled room open to the south (+z), origin at its north-west corner. */
function vignettes(x0: number, z0: number): { placed: Placed[]; stages: Stage[]; views: PreviewView[] } {
  const P = (kind: string, seed: number, at: V3, yaw = 0): Placed => ({ prop: makeProp(kind, seed), at, yaw });
  const placed: Placed[] = [], stages: Stage[] = [], views: PreviewView[] = [];
  // great hall: high table on a dais with the throne, two long tables with benches, chandeliers, tapestries
  {
    const ox = x0, oz = z0, W = 11, D = 9, H = 5.2;
    stages.push({ min: [ox, 0, oz], max: [ox + W, H, oz + D], open: 'south' });
    placed.push(P('throne', 1, [ox + W / 2, 0, oz + 1.0]));
    placed.push(P('trestle-table', 2, [ox + W / 2, 0, oz + 2.3]));
    placed.push(P('tableware', 3, [ox + W / 2 - 0.4, 0.78, oz + 2.3]));
    placed.push(P('candlestick', 4, [ox + W / 2 + 0.7, 0.78, oz + 2.25]));
    for (const [i, x] of [ox + 3, ox + W - 3].entries()) {
      placed.push(P('trestle-table', 10 + i, [x, 0, oz + 5.6], Math.PI / 2));
      placed.push(P('bench', 20 + i, [x - 0.75, 0, oz + 5.6], Math.PI / 2));
      placed.push(P('bench', 30 + i, [x + 0.75, 0, oz + 5.6], Math.PI / 2));
      placed.push(P('tableware', 40 + i, [x, 0.78, oz + 5.0 + i * 0.8], Math.PI / 2));
      placed.push(P('chandelier', 50 + i, [x, H, oz + 5.2]));
    }
    placed.push(P('tapestry', 60, [ox + 2.6, 3.4, oz + 0.02]));
    placed.push(P('tapestry', 61, [ox + W - 2.6, 3.4, oz + 0.02]));
    for (const z of [oz + 3.2, oz + 6.8]) { placed.push(P('sconce', 70 + z, [ox + 0.02, 2.1, z], Math.PI / 2)); placed.push(P('sconce', 80 + z, [ox + W - 0.02, 2.1, z], -Math.PI / 2)); }
    placed.push(P('rug', 90, [ox + W / 2, 0, oz + 3.8]));
    views.push({ name: 'hall', label: 'Hall', pos: [ox + W / 2 + 1.2, 1.7, oz + D + 2.6], target: [ox + W / 2, 1.4, oz + 2] });
  }
  // chamber: four-poster, chest at its foot, chair, cupboard, rug, candle
  {
    const ox = x0 + 13, oz = z0, W = 7, D = 6, H = 3.6;
    stages.push({ min: [ox, 0, oz], max: [ox + W, H, oz + D], open: 'south' });
    placed.push(P('four-poster', 1, [ox + 2.0, 0, oz + 1.15]));
    placed.push(P('chest', 2, [ox + 2.0, 0, oz + 2.75]));
    placed.push(P('candlestick', 3, [ox + 2.3, 0.56, oz + 2.75]));
    placed.push(P('cupboard', 4, [ox + W - 1.0, 0, oz + 0.3]));
    placed.push(P('chair', 5, [ox + W - 1.6, 0, oz + 2.6], -0.6));
    placed.push(P('rug', 6, [ox + 3.6, 0, oz + 3.4], Math.PI / 2));
    placed.push(P('book-stack', 7, [ox + W - 0.9, 0, oz + 1.2]));
    placed.push(P('tapestry', 8, [ox + 0.02, 2.6, oz + 3.6], Math.PI / 2));
    placed.push(P('sconce', 9, [ox + W - 0.02, 1.9, oz + 3.2], -Math.PI / 2));
    views.push({ name: 'chamber', label: 'Chamber', pos: [ox + W / 2 + 0.8, 1.65, oz + D + 2.0], target: [ox + W / 2 - 0.4, 0.9, oz + 1.6] });
  }
  // store room: barrels, crates, sacks, firewood, straw, a bucket, the armoury rack, a cauldron
  {
    const ox = x0 + 22, oz = z0, W = 7, D = 6, H = 3.2;
    stages.push({ min: [ox, 0, oz], max: [ox + W, H, oz + D], open: 'south' });
    for (let i = 0; i < 4; i++) placed.push(P('barrel', i, [ox + 0.5 + i * 0.66, 0, oz + 0.45], i));
    placed.push(P('barrel', 9, [ox + 0.85, 0, oz + 1.15], 2));
    for (let i = 0; i < 3; i++) placed.push(P('crate', i, [ox + W - 0.7, i === 2 ? 0.62 : 0, oz + 0.6 + (i === 1 ? 0.8 : 0)], i * 0.3));
    for (let i = 0; i < 5; i++) placed.push(P('sack', i, [ox + 3.4 + (i % 3) * 0.45, 0, oz + 0.4 + Math.floor(i / 3) * 0.5], i));
    placed.push(P('firewood', 1, [ox + 0.5, 0, oz + 3.2], Math.PI / 2));
    placed.push(P('straw-heap', 1, [ox + 2.4, 0, oz + 3.4]));
    placed.push(P('bucket', 1, [ox + 1.4, 0, oz + 2.2]));
    placed.push(P('cauldron', 1, [ox + 4.6, 0, oz + 2.6]));
    placed.push(P('weapon-rack', 1, [ox + W - 0.4, 0, oz + 3.4], -Math.PI / 2));
    placed.push(P('armour-stand', 1, [ox + W - 1.4, 0, oz + 4.6], -0.4));
    placed.push(P('sconce', 1, [ox + 0.02, 1.8, oz + 1.8], Math.PI / 2));
    views.push({ name: 'store', label: 'Store', pos: [ox + W / 2 + 0.6, 1.7, oz + D + 2.2], target: [ox + W / 2, 0.8, oz + 1.6] });
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
