// Shared pieces of the prop kit (kit.ts: the medieval kinds, period.ts: the 19th-century ones):
// the prop contract, palettes, colliders and small turned and joined parts. Pure, no three.js.
import { PropMesh, translate, rotX, rotZ, compose, type RGB, type V3 } from './geom';
import type { LightEmitter } from '../light/types';
import { range, pick, type Rng } from '../core/rng';

export type Placement = 'floor' | 'wall' | 'ceiling';

/** A light source on a fixture; src/light turns these into flickering lights. Local space. */
export type Emitter = LightEmitter;

/** Solid parts for physics and NPC navigation, as boxes in local space. */
export interface Collider { centre: V3; half: V3 }

export interface PropMeta {
  colliders: Collider[];
  emitters: Emitter[];
  /** A chimneypiece's mantel shelf (local height, depth of its middle, usable width) for the garniture. */
  mantel?: { y: number; z: number; w: number };
  /** Local point on its front where a wall piece hangs over it (an overmantel mirror or portrait). */
  above?: V3;
}

export interface PropKind {
  name: string;
  placement: Placement;
  /** Height above the floor for wall-mounted props (sconces, tapestries). */
  mount?: number;
  /** False for things you can walk over (rugs, straw). True props are navmesh obstacles. */
  blocksNav: boolean;
  /** v is the prop's variant seed (dress.ts picks it to keep one textile colour per room). */
  build(m: PropMesh, r: Rng, v: number): PropMeta;
}

// ---------- palettes (vertex tints over the shared materials) ----------
export const WOOD: Record<string, RGB> = { oak: [1, 1, 1], dark: [0.55, 0.5, 0.46], grey: [0.8, 0.78, 0.72], pale: [1.25, 1.15, 1.0] };
export const CLOTH: Record<string, RGB> = {
  linen: [0.72, 0.67, 0.56], undyed: [0.5, 0.44, 0.34], madder: [0.42, 0.14, 0.1], woad: [0.15, 0.2, 0.3],
  weld: [0.5, 0.41, 0.2], green: [0.2, 0.26, 0.16], brown: [0.36, 0.26, 0.18], black: [0.09, 0.08, 0.08],
  leather: [0.32, 0.2, 0.12],
};
export const IRON: RGB = [1, 1, 1];
export const FLAME: Emitter['colour'] = [1, 1, 1]; // tint over the flame kind's black-body colour

export const jitterTint = (r: Rng, c: RGB, k = 0.08): RGB => { const f = 1 + (r() - 0.5) * 2 * k; return [c[0] * f, c[1] * f, c[2] * f]; };
export const woodTint = (r: Rng) => jitterTint(r, pick(r, [WOOD.oak, WOOD.oak, WOOD.dark, WOOD.grey]));
export const boxCollider = (min: V3, max: V3): Collider => ({ centre: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], half: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2] });
/** One collider around everything built so far. */
export const hull = (m: PropMesh): Collider => { const b = m.bounds(); return boxCollider(b.min, b.max); };
export const none = (m: PropMesh): PropMeta => ({ colliders: [hull(m)], emitters: [] });

/** A plank top made of several boards with small gaps and uneven thickness. */
export function planks(m: PropMesh, r: Rng, L: number, W: number, y: number, t: number, along: 0 | 2 = 0) {
  const n = Math.max(2, Math.round(W / range(r, 0.22, 0.32)));
  const gap = 0.004, bw = (W - gap * (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    const off = -W / 2 + bw / 2 + i * (bw + gap), tt = t * range(r, 0.92, 1.05), dy = range(r, -0.003, 0.003);
    const len = L * range(r, 0.985, 1);
    const c: V3 = along === 0 ? [range(r, -0.01, 0.01), y + tt / 2 + dy, off] : [off, y + tt / 2 + dy, range(r, -0.01, 0.01)];
    const s: V3 = along === 0 ? [len, tt, bw] : [bw, tt, len];
    m.box('wood', c, s, { bevel: 0.006, grain: along, skew: [range(r, -0.002, 0.002), range(r, -0.002, 0.002)] });
  }
}

/** A splayed leg from the floor to height h, foot pushed out by (dx, dz). */
export function leg(m: PropMesh, x: number, z: number, h: number, w: number, dx = 0, dz = 0, round = false) {
  if (round) { m.tube('wood', [[x + dx, 0, z + dz], [x, h, z]], [w * 0.55, w * 0.48], 7, [false, false]); return; }
  const len = Math.hypot(h, dx, dz), ax = Math.atan2(dz, h), az = -Math.atan2(dx, h);
  m.with(compose(translate(x + dx / 2, h / 2, z + dz / 2), compose(rotZ(az), rotX(ax))), () => m.box('wood', [0, 0, 0], [w, len, w], { bevel: 0.006, grain: 1, noBottom: true }));
}

/** A charred wick or char stub and a flame marker; the flame itself is drawn by src/light. */
export const flame = (m: PropMesh, kind: Emitter['kind'], at: V3, size: number) => {
  if (kind === 'candle') m.tinted([0.05, 0.04, 0.035], () => m.with(translate(at[0], at[1], at[2]), () => m.tube('iron', [[0, -0.004, 0], [0.001, size * 0.35, 0.0005]], 0.0012, 3)));
  m.addFlame(kind, at, size * 1.6);
};

export function jug(m: PropMesh, r: Rng, h: number) {
  const R = h * range(r, 0.3, 0.38), ph = r() * 6;
  m.tinted(jitterTint(r, pick(r, [[0.62, 0.42, 0.3], [0.5, 0.48, 0.42], [0.35, 0.4, 0.3]] as RGB[])), () => {
    m.lathe('ceramic', [[0, 0], [R * 0.7, 0], [R, h * 0.35], [R * 0.9, h * 0.6], [R * 0.45, h * 0.85], [R * 0.5, h], [R * 0.42, h]], 12,
      { wobble: (th, y) => 1 + Math.sin(th * 3 + ph + y * 9) * 0.02 });
    m.tube('ceramic', Array.from({ length: 6 }, (_, i) => { const a = (i / 5) * Math.PI; return [-R * 0.55 - Math.sin(a) * R * 0.45, h * 0.88 - (i / 5) * h * 0.45, 0] as V3; }), h * 0.035, 5, [false, false]);
  });
}
export function bowl(m: PropMesh, r: Rng, R: number) {
  m.tinted(jitterTint(r, pick(r, [[0.6, 0.45, 0.32], [0.7, 0.66, 0.6]] as RGB[])), () =>
    m.lathe('ceramic', [[0, 0], [R * 0.5, 0], [R, R * 0.45], [R * 0.93, R * 0.47], [R * 0.45, R * 0.06], [0, R * 0.06]], 12));
}
/** A bound book lying flat, spine on -x: two boards and a spine standing out, the page block set back
 * 3 mm between them. No face of the pages lies on a face of the cover (they z-fought when the page
 * block's fore-edge sat flush with a closed cover box). */
export function book(m: PropMesh, r: Rng, w: number, h: number, t: number) {
  const bt = Math.min(0.004, t * 0.12);
  m.tinted(jitterTint(r, pick(r, [CLOTH.leather, CLOTH.madder, CLOTH.brown, CLOTH.black])), () => {
    for (const y of [bt / 2, t - bt / 2]) m.box('cloth', [0, y, 0], [w, bt, h]);
    m.box('cloth', [-w / 2 + bt / 2 - 0.002, t / 2, 0], [bt, t - 0.004, h - 0.004]); // spine, 2 mm proud, ends inside the boards
  });
  m.tinted([0.95, 0.88, 0.72], () => m.box('wax', [bt / 2 - 0.0015, t / 2, 0], [w - bt - 0.003, t - 2 * bt + 0.002, h - 0.006]));
}

export function candle(m: PropMesh, r: Rng, at: V3, h: number, R: number, emit: Emitter[], intensity: number) {
  m.tinted(jitterTint(r, [0.92, 0.86, 0.7], 0.05), () => m.with(translate(at[0], at[1], at[2]), () =>
    m.lathe('wax', [[R, 0], [R, h * 0.85], [R * 0.9, h], [R * 0.3, h * 0.97], [0, h * 0.97]], 6, { wobble: (th, y) => 1 + Math.sin(th * 2 + y * 30) * 0.06 * (y / h) })));
  flame(m, 'candle', [at[0], at[1] + h * 0.97, at[2]], R * 1.6);
  emit.push({ kind: 'candle', position: [at[0], at[1] + h + R * 1.2, at[2]], colour: FLAME, intensity, flicker: 0.12 });
}


export const v3dir = (a: V3, b: V3): V3 => { const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; const l = Math.hypot(...d); return [d[0] / l, d[1] / l, d[2] / l]; };
