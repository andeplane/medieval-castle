// Medieval room sets (Anders, 2026-11-08: the new sets are medieval, not 19th-century): window shutters,
// the hall's refectory set (long trestle tables, a high-table chair, a stepped dresser of pewter), the
// chapel (a stone altar with its cloth, prickets and a plain cross, a prie-dieu) and the kitchen (an open
// hearth with a spit and a cauldron on a crane, a big work table). Same contract as kit.ts: pure
// generators of (mesh, rng, variant), local frame on the floor (or wall) at the centre of the footprint,
// front +z, metres.
import { PropMesh, translate, rotX, rotZ, compose, type RGB, type V3 } from './geom';
import { range, pick, type Rng } from '../core/rng';
import { WOOD, CLOTH, IRON, jitterTint, woodTint, boxCollider, hull, none, planks, leg, jug, bowl, candle, type PropKind, type PropMeta, type Emitter } from './parts';
import { hoodedHearth } from './period';

const PEWTER: RGB = [0.62, 0.62, 0.6];
const STONE_GREY: RGB = [0.82, 0.8, 0.76];
const DEAL: RGB = [1.15, 1.05, 0.88]; // scrubbed table tops

// ---------- windows ----------
/**
 * One leaf of a pair of window shutters standing open flat against the wall beside an embrasure: upright
 * boards on two ledges, iron strap hinges running from the hinge edge (x = hinge · w/2), a ring pull.
 * Local frame: the wall is z = 0, the leaf's bottom middle at the origin.
 */
export function buildShutter(m: PropMesh, r: Rng, w: number, h: number, hinge: 1 | -1): PropMeta {
  const t = 0.035, z0 = 0.01, n = Math.max(2, Math.round(w / range(r, 0.18, 0.26))), bw = w / n;
  m.tinted(jitterTint(r, pick(r, [WOOD.oak, WOOD.grey, WOOD.dark]), 0.06), () => {
    for (let i = 0; i < n; i++) m.box('wood', [-w / 2 + bw * (i + 0.5), h / 2, z0 + t / 2], [bw - 0.004, h * range(r, 0.995, 1), t * range(r, 0.9, 1)], { bevel: 0.004, grain: 1 });
    for (const y of [0.18, h - 0.18]) m.box('wood', [0, Math.min(h / 2, y), z0 + t + 0.012], [w - 0.06, 0.1, 0.024], { bevel: 0.005, grain: 0 });
  });
  m.tinted(IRON, () => {
    for (const y of [0.18, h - 0.18]) m.box('iron', [hinge * (w / 2 - w * 0.33), Math.min(h / 2, y), z0 + t + 0.027], [w * 0.66, 0.035, 0.006], { taper: 0.2 });
    m.tube('iron', Array.from({ length: 9 }, (_, i) => { const a = (i / 8) * Math.PI * 2; return [-hinge * (w / 2 - 0.1) + Math.cos(a) * 0.035, h * 0.5 - 0.035 + Math.sin(a) * 0.035, z0 + t + 0.012] as V3; }), 0.005, 4, [false, false]);
  });
  return { colliders: [hull(m)], emitters: [] };
}

/** A shutter leaf of the kit's default size (props.html, kit tests); dress.ts sizes them to each window. */
export const shutter: PropKind = {
  name: 'shutter', placement: 'wall', mount: 1.2, blocksNav: false,
  build: (m, r) => buildShutter(m, r, range(r, 0.55, 0.75), range(r, 1.4, 1.9), r() < 0.5 ? 1 : -1),
};

// ---------- the hall ----------
/** A trestle frame: two splayed legs on a foot, a bearer under the top. */
function trestle(m: PropMesh, r: Rng, x: number, W: number, H: number) {
  m.box('wood', [x, H - 0.05, 0], [0.09, 0.08, W * 0.9], { bevel: 0.006, grain: 2 });
  m.box('wood', [x, 0.045, 0], [0.1, 0.09, W * 0.82], { bevel: 0.008, grain: 2, noBottom: true });
  for (const sz of [-1, 1]) leg(m, x, sz * W * 0.16, H - 0.09, 0.08, range(r, -0.01, 0.01), sz * W * 0.2);
}

/** Long refectory table on three trestles with a through stretcher, pegged; half of them under a linen
 * cloth laid down the middle (a laid table). */
export const refectoryTable: PropKind = {
  name: 'refectory-table', placement: 'floor', blocksNav: true,
  build(m, r) {
    const L = range(r, 3.0, 3.6), W = range(r, 0.82, 0.95), H = range(r, 0.74, 0.78), t = 0.06;
    m.tinted(jitterTint(r, pick(r, [WOOD.oak, WOOD.dark, WOOD.oak]), 0.06), () => {
      planks(m, r, L, W, H - t, t);
      for (const x of [-L / 2 + 0.35, 0, L / 2 - 0.35]) trestle(m, r, x, W, H - t + 0.01);
      m.box('wood', [0, 0.36, 0], [L - 0.4, 0.08, 0.06], { bevel: 0.008 });
      for (const sx of [-1, 1]) m.box('wood', [sx * (L / 2 - 0.35 + 0.08), 0.36, 0], [0.04, 0.05, 0.1], { bevel: 0.004 }); // pegs
    });
    if (r() < 0.5) m.tinted(jitterTint(r, CLOTH.linen, 0.04), () => m.sheet('cloth', (s, tt) => {
      const z = (tt - 0.5) * (W + 0.5), over = Math.max(0, Math.abs(z) - W / 2);
      return [(s - 0.5) * (L - 0.5), H + 0.004 - over * 1.4, Math.sign(z) * Math.min(Math.abs(z), W / 2 + 0.01)];
    }, 4, 8, [L, W + 0.5]));
    return { colliders: [boxCollider([-L / 2, 0, -W / 2 - 0.03], [L / 2, H, W / 2 + 0.03])], emitters: [] };
  },
};

/** The lord's chair at the high table: a panelled box chair (the seat a chest), solid arms, a tall
 * panelled back with a cresting, a cushion in madder or woad. */
export const boxChair: PropKind = {
  name: 'box-chair', placement: 'floor', blocksNav: true,
  build(m, r) {
    const W = range(r, 0.7, 0.8), D = range(r, 0.56, 0.62), seat = 0.48, H = range(r, 1.55, 1.75), wood = jitterTint(r, WOOD.dark, 0.06);
    m.tinted(wood, () => {
      m.box('wood', [0, seat / 2, 0.02], [W, seat, D - 0.04], { bevel: 0.01, noBottom: true });                 // the box
      m.box('wood', [0, H / 2, -D / 2 + 0.03], [W, H, 0.06], { bevel: 0.01, grain: 1, noBottom: true });       // back
      for (const sx of [-1, 1]) {
        m.box('wood', [sx * (W / 2 - 0.03), 0.375, 0], [0.06, 0.75, D], { bevel: 0.008, noBottom: true }); // arm panel
        m.with(translate(sx * (W / 2 - 0.03), H, -D / 2 + 0.03), () => m.lathe('wood', [[0.035, 0], [0.04, 0.03], [0.015, 0.07], [0.025, 0.09], [0.001, 0.15]], 8));
      }
      m.box('wood', [0, H - 0.04, -D / 2 + 0.05], [W + 0.06, 0.1, 0.1], { bevel: 0.012 }); // cresting
    });
    // sunk panels on the back and the box front, a shade darker
    m.tinted([wood[0] * 0.7, wood[1] * 0.7, wood[2] * 0.7], () => {
      for (let i = 0; i < 2; i++) for (const sx of [-1, 1]) m.box('wood', [sx * W * 0.2, seat + 0.2 + i * (H - seat - 0.35) / 2 + (H - seat - 0.35) / 4, -D / 2 + 0.062], [W * 0.32, (H - seat - 0.35) / 2 - 0.06, 0.008]);
      for (const sx of [-1, 1]) m.box('wood', [sx * W * 0.2, seat / 2, D / 2 + 0.002], [W * 0.32, seat - 0.14, 0.008]);
    });
    m.tinted(jitterTint(r, pick(r, [CLOTH.madder, CLOTH.woad, CLOTH.green])), () => m.box('cloth', [0, seat + 0.04, 0.03], [W - 0.14, 0.08, D - 0.14], { bevel: 0.03 }));
    return none(m);
  },
};

/** A stepped dresser (a "cup-board" in the medieval sense): a cupboard base with two doors, and above it
 * two open stages showing pewter plates on edge and flagons. */
export const dresser: PropKind = {
  name: 'dresser', placement: 'floor', blocksNav: true,
  build(m, r) {
    const W = range(r, 1.3, 1.6), D = range(r, 0.48, 0.55), base = 0.9, H = range(r, 1.75, 1.95);
    m.tinted(woodTint(r), () => {
      m.box('wood', [0, base / 2, 0], [W, base, D], { bevel: 0.01, noBottom: true });
      for (const sx of [-1, 1]) m.box('wood', [sx * (W / 4), base / 2, D / 2 + 0.01], [W / 2 - 0.08, base - 0.2, 0.02], { bevel: 0.006, grain: 1 });
      for (const sx of [-1, 1]) m.box('wood', [sx * (W / 2 - 0.03), (base + H) / 2, -D * 0.15], [0.05, H - base, D * 0.7], { bevel: 0.006, grain: 1 });
      m.box('wood', [0, (base + H) / 2, -D / 2 + 0.03], [W - 0.06, H - base, 0.02], { grain: 1 });
      const s1 = base + (H - base) * 0.5;
      m.box('wood', [0, s1, -D * 0.12], [W - 0.06, 0.03, D * 0.66], { bevel: 0.004 });
      m.box('wood', [0, H - 0.03, -D * 0.15], [W + 0.04, 0.06, D * 0.75], { bevel: 0.01 });
    });
    m.tinted(IRON, () => { for (const sx of [-1, 1]) m.box('iron', [sx * 0.08, base * 0.55, D / 2 + 0.025], [0.02, 0.1, 0.01]); });
    // plates on edge against the back of each stage, flagons and cups in front
    const s1 = base + (H - base) * 0.5;
    for (const [y, z] of [[base, -D / 2 + 0.07], [s1 + 0.015, -D / 2 + 0.07]] as [number, number][]) {
      const n = Math.max(3, Math.floor((W - 0.2) / 0.3));
      for (let i = 0; i < n; i++) {
        const x = -W / 2 + 0.15 + (i + 0.5) * ((W - 0.3) / n), R = range(r, 0.11, 0.14);
        m.tinted(jitterTint(r, PEWTER, 0.06), () => m.with(compose(translate(x, y + R + 0.005, z), rotX(Math.PI / 2 - 0.15)), () => m.lathe('brass', [[0.001, 0], [R * 0.6, 0], [R, 0.012], [R, 0.016], [0.001, 0.008]], 12)));
      }
    }
    for (let i = 0; i < 3; i++) {
      const x = (i - 1) * W * 0.3 + range(r, -0.05, 0.05), h = range(r, 0.18, 0.26);
      m.tinted(jitterTint(r, PEWTER, 0.06), () => m.with(translate(x, base, D * 0.2), () => m.lathe('brass', [[0.001, 0], [h * 0.3, 0], [h * 0.34, h * 0.2], [h * 0.22, h * 0.75], [h * 0.25, h], [0.001, h]], 10)));
    }
    return { colliders: [boxCollider([-W / 2, 0, -D / 2], [W / 2, H, D / 2])], emitters: [] };
  },
};

// ---------- the chapel ----------
/** An iron pricket candlestick (a spike for the candle on a drip pan) with its candle. */
function pricket(m: PropMesh, r: Rng, at: V3, h: number, emit: Emitter[]) {
  m.tinted(IRON, () => m.with(translate(at[0], at[1], at[2]), () => m.lathe('iron', [[0.001, 0], [0.08, 0], [0.07, 0.02], [0.016, 0.05], [0.012, h * 0.5], [0.024, h * 0.55], [0.012, h * 0.6], [0.012, h - 0.02], [0.06, h - 0.01], [0.06, h], [0.001, h]], 8)));
  candle(m, r, [at[0], at[1] + h, at[2]], range(r, 0.24, 0.32), 0.024, emit, 0.9);
}

/**
 * Stone altar: a block of dressed stone with a moulded mensa on a one-step footpace, under a white linen
 * cloth that falls over the front and ends with a woven band of colour; two iron prickets and a plain
 * wooden cross on a stepped foot stand on it.
 */
export const stoneAltar: PropKind = {
  name: 'stone-altar', placement: 'floor', blocksNav: true,
  build(m, r) {
    const W = range(r, 0.9, 1.3), D = range(r, 0.56, 0.64), H = 1.0, step = 0.14, pace = 0.32, emit: Emitter[] = [];
    m.tinted(jitterTint(r, STONE_GREY, 0.05), () => {
      m.box('stone', [0, step / 2, pace / 2], [W + 0.2, step, D + pace], { bevel: 0.01, noBottom: true }); // footpace
      m.box('stone', [0, step + (H - step - 0.08) / 2, 0], [W - 0.1, H - step - 0.08, D - 0.1], { bevel: 0.012 });
      m.box('stone', [0, H - 0.04, 0], [W, 0.08, D], { bevel: 0.015 }); // mensa
    });
    const drop = 0.45;
    m.tinted(jitterTint(r, CLOTH.linen, 0.03), () => m.sheet('cloth', (s, t) => {
      const z = t * (D + drop) - D / 2, over = Math.max(0, z - D / 2);
      return [(s - 0.5) * (W + 0.02), H + 0.003 - over, Math.min(z, D / 2 + 0.008)];
    }, 6, 8, [W, D + drop]));
    m.tinted(jitterTint(r, pick(r, [CLOTH.madder, CLOTH.woad, CLOTH.green])), () => m.box('cloth', [0, H - drop + 0.07, D / 2 + 0.012], [W + 0.02, 0.09, 0.004]));
    for (const sx of [-1, 1]) pricket(m, r, [sx * W * 0.36, H, -D * 0.2], range(r, 0.34, 0.4), emit);
    m.tinted(jitterTint(r, WOOD.dark, 0.05), () => m.with(translate(0, H, -D * 0.25), () => {
      m.box('wood', [0, 0.03, 0], [0.18, 0.06, 0.12], { bevel: 0.006 });
      m.box('wood', [0, 0.08, 0], [0.12, 0.04, 0.08], { bevel: 0.004 });
      m.box('wood', [0, 0.36, 0], [0.04, 0.56, 0.035], { bevel: 0.004, grain: 1 });
      m.box('wood', [0, 0.5, 0], [0.26, 0.04, 0.035], { bevel: 0.004 });
    }));
    return { colliders: [hull(m)], emitters: emit };
  },
};

/** A prie-dieu: a kneeling board and a sloped book rest on two panelled ends. Its front (+z) faces the
 * altar: the one kneeling looks along +z. */
export const prieDieu: PropKind = {
  name: 'prie-dieu', placement: 'floor', blocksNav: true,
  build(m, r) {
    const W = range(r, 0.55, 0.65), D = 0.55, H = range(r, 0.85, 0.92);
    m.tinted(woodTint(r), () => {
      for (const sx of [-1, 1]) m.box('wood', [sx * (W / 2 - 0.02), H / 2, 0.12], [0.04, H, 0.22], { bevel: 0.006, grain: 1, noBottom: true }); // ends
      m.box('wood', [0, 0.06, -0.12], [W, 0.12, 0.3], { bevel: 0.008, noBottom: true }); // kneeler
      m.with(compose(translate(0, H - 0.02, 0.12), rotX(0.35)), () => m.box('wood', [0, 0, 0], [W + 0.04, 0.03, 0.3], { bevel: 0.006 }));
      m.box('wood', [0, H * 0.55, 0.2], [W - 0.04, H * 0.7, 0.02], { bevel: 0.004, grain: 1 });
    });
    m.tinted(jitterTint(r, pick(r, [CLOTH.madder, CLOTH.woad])), () => m.box('cloth', [0, 0.14, -0.12], [W - 0.08, 0.05, 0.24], { bevel: 0.02 }));
    void D;
    return none(m);
  },
};

// ---------- the kitchen ----------
/**
 * The kitchen's open hearth: the hooded hearth (period.ts) with a spit on tall iron spit-dogs and a joint
 * on it, turned by a crank wheel, and an iron crane swinging from one cheek with a cauldron hung over the
 * fire on a chain.
 */
export const spitHearth: PropKind = {
  name: 'spit-hearth', placement: 'floor', blocksNav: true,
  build(m, r, v) {
    const meta = hoodedHearth.build(m, r, v);
    const b0 = m.bounds(), W = b0.max[0] - b0.min[0] - 0.3, Wo = W - 0.7, sz = 0.2, sy = 0.62;
    m.tinted(IRON, () => {
      for (const sx of [-1, 1]) {
        const x = sx * (Wo / 2 - 0.12);
        m.box('iron', [x, 0.04, sz], [0.05, 0.03, 0.4]);
        m.box('iron', [x, sy / 2 + 0.02, sz], [0.03, sy, 0.03]);
        for (const y of [sy - 0.15, sy]) m.tube('iron', [[x, y, sz - 0.03], [x + sx * 0.0, y + 0.04, sz + 0.05]], 0.008, 4); // hooks
      }
      m.tube('iron', [[-Wo / 2 + 0.05, sy + 0.03, sz], [Wo / 2 - 0.02, sy + 0.03, sz]], 0.01, 5);
      m.with(compose(translate(Wo / 2 - 0.02, sy + 0.03, sz), rotZ(Math.PI / 2)), () => {
        m.lathe('iron', [[0.16, -0.01], [0.17, 0], [0.17, 0.02], [0.16, 0.03]], 12, { capTop: false });
        for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; m.tube('iron', [[0, 0.01, 0], [Math.cos(a) * 0.16, 0.01, Math.sin(a) * 0.16]], 0.006, 4, [false, false]); }
      });
    });
    // the joint on the spit
    m.tinted(jitterTint(r, [0.42, 0.22, 0.12], 0.1), () => m.with(compose(translate(range(r, -0.15, 0.15), sy + 0.03, sz), rotZ(Math.PI / 2)), () => m.lathe('ceramic', [[0.03, -0.22], [0.09, -0.15], [0.11, 0], [0.09, 0.14], [0.04, 0.22]], 10)));
    // the crane: a post by the left cheek, an arm over the fire with a brace, a chain and the cauldron
    const px = -Wo / 2 + 0.1, pz = -0.15, arm = 1.3, reach = Wo * 0.42, R = range(r, 0.22, 0.27);
    m.tinted(IRON, () => {
      m.box('iron', [px, arm / 2 + 0.05, pz], [0.04, arm + 0.1, 0.04]);
      m.box('iron', [px + reach / 2, arm, pz], [reach, 0.04, 0.03]);
      m.tube('iron', [[px, arm - 0.5, pz], [px + reach * 0.6, arm - 0.02, pz]], 0.012, 4);
      const cx = px + reach - 0.03, top = 0.6 + R * 1.1;
      m.tube('iron', [[cx, arm - 0.02, pz], [cx, top + 0.18, pz]], 0.008, 4);
      m.tube('iron', Array.from({ length: 9 }, (_, i) => { const a = (i / 8) * Math.PI; return [cx + Math.cos(a) * R * 0.95, top + Math.sin(a) * 0.18, pz] as V3; }), 0.008, 4, [false, false]);
      m.with(translate(cx, 0.6, pz), () => m.lathe('iron', [[0, 0], [R * 0.6, 0.02], [R * 0.95, R * 0.4], [R, R * 0.8], [R * 0.9, R * 1.05], [R * 0.96, R * 1.1], [R * 0.86, R * 1.08], [R * 0.82, R * 0.9]], 14));
    });
    m.tinted([0.25, 0.2, 0.14], () => m.with(translate(px + reach - 0.03, 0.6 + R * 0.85, pz), () => m.lathe('ceramic', [[0, 0], [R * 0.86, 0]], 14, { capTop: true })));
    const b = m.bounds();
    return { ...meta, colliders: [boxCollider([b.min[0], 0, b.min[2]], [b.max[0], b.max[1], b.max[2]])] };
  },
};

/** The big kitchen work table: a thick scrubbed top on four square legs, a pot board below, and the
 * day's work on it (a chopping board and cleaver, bowls, a jug, loaves). Taller than a dining table. */
export const workTable: PropKind = {
  name: 'work-table', placement: 'floor', blocksNav: true,
  build(m, r) {
    const L = range(r, 2.1, 2.5), W = range(r, 0.9, 1.0), H = range(r, 0.84, 0.88), t = 0.08;
    m.tinted(jitterTint(r, DEAL, 0.04), () => planks(m, r, L, W, H - t, t));
    m.tinted(woodTint(r), () => {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.box('wood', [sx * (L / 2 - 0.12), (H - t) / 2, sz * (W / 2 - 0.1)], [0.1, H - t, 0.1], { bevel: 0.008, grain: 1, noBottom: true });
      for (const sz of [-1, 1]) m.box('wood', [0, H - t - 0.06, sz * (W / 2 - 0.1)], [L - 0.3, 0.1, 0.04], { bevel: 0.005 });
      m.box('wood', [0, 0.18, 0], [L - 0.3, 0.03, W - 0.25], { bevel: 0.004 }); // pot board
    });
    m.with(translate(0, H, 0), () => {
      m.tinted(woodTint(r), () => m.box('wood', [-L * 0.25, 0.02, 0.05], [0.5, 0.04, 0.32], { bevel: 0.008, noBottom: true }));
      m.tinted(IRON, () => m.box('iron', [-L * 0.25 + 0.05, 0.045, 0.08], [0.24, 0.01, 0.09], { taper: 0.2 }));
      m.with(translate(L * 0.1, 0, -0.15), () => jug(m, r, range(r, 0.22, 0.3)));
      for (let i = 0; i < 2; i++) m.with(translate(L * 0.25 + i * 0.25, 0, 0.12), () => bowl(m, r, range(r, 0.1, 0.15)));
      m.tinted(jitterTint(r, [0.7, 0.48, 0.28], 0.08), () => { for (let i = 0; i < 2; i++) m.with(translate(L * 0.38, 0, -0.2 + i * 0.16), () => m.lathe('ceramic', [[0.001, 0], [0.08, 0], [0.085, 0.04], [0.05, 0.08], [0.001, 0.09]], 10)); });
    });
    return { colliders: [boxCollider([-L / 2, 0, -W / 2], [L / 2, H, W / 2])], emitters: [] };
  },
};

export const MEDIEVAL: readonly PropKind[] = [shutter, refectoryTable, boxChair, dresser, stoneAltar, prieDieu, spitHearth, workTable];
