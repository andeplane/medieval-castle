// Medieval room sets (Anders, 2026-11-08: the new sets are medieval, not 19th-century): window shutters,
// the hall's refectory set (long trestle tables, a high-table chair, a stepped dresser of pewter), the
// chapel (a stone altar with its cloth, prickets and a plain cross, a prie-dieu) and the kitchen (an open
// hearth with a spit and a cauldron on a crane, a big work table). Same contract as kit.ts: pure
// generators of (mesh, rng, variant), local frame on the floor (or wall) at the centre of the footprint,
// front +z, metres.
import { PropMesh, translate, rotX, rotY, rotZ, compose, type RGB, type V3 } from './geom';
import { range, pick, type Rng } from '../core/rng';
import { WOOD, CLOTH, IRON, jitterTint, woodTint, boxCollider, hull, none, planks, leg, jug, bowl, candle, type PropKind, type PropMeta, type Emitter } from './parts';
import { hoodedHearth } from './period';

const PEWTER: RGB = [0.62, 0.62, 0.6];
const STONE_GREY: RGB = [0.82, 0.8, 0.76];
const DEAL: RGB = [1.15, 1.05, 0.88]; // scrubbed table tops
const EMBERS: RGB = [1.6, 0.9, 0.5]; // wax tint above 1 glows (render.ts): live coals

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
      m.box('wood', [0, seat / 2, 0.015], [W - 0.01, seat, D - 0.04], { bevel: 0.01, noBottom: true });          // the box
      m.box('wood', [0, H / 2, -D / 2 + 0.035], [W - 0.02, H, 0.06], { bevel: 0.01, grain: 1, noBottom: true }); // back
      for (const sx of [-1, 1]) {
        m.box('wood', [sx * (W / 2 - 0.025), 0.375, 0], [0.06, 0.75, D], { bevel: 0.008, noBottom: true }); // arm panel, proud of the box
        m.with(translate(sx * (W / 2 - 0.03), H, -D / 2 + 0.03), () => m.lathe('wood', [[0.035, 0], [0.04, 0.03], [0.015, 0.07], [0.025, 0.09], [0.001, 0.15]], 8));
      }
      m.box('wood', [0, H - 0.035, -D / 2 + 0.056], [W + 0.06, 0.1, 0.1], { bevel: 0.012 }); // cresting
    });
    // sunk panels on the back and the box front, a shade darker
    m.tinted([wood[0] * 0.7, wood[1] * 0.7, wood[2] * 0.7], () => {
      for (let i = 0; i < 2; i++) for (const sx of [-1, 1]) m.box('wood', [sx * W * 0.2, seat + 0.2 + i * (H - seat - 0.35) / 2 + (H - seat - 0.35) / 4, -D / 2 + 0.067], [W * 0.32, (H - seat - 0.35) / 2 - 0.06, 0.008]);
      for (const sx of [-1, 1]) m.box('wood', [sx * W * 0.2, seat / 2, D / 2 - 0.006], [W * 0.32, seat - 0.14, 0.008]);
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
      for (const sx of [-1, 1]) m.box('wood', [sx * (W / 2 - 0.03), (base + H - 0.03) / 2, -D * 0.15], [0.05, H - base - 0.03, D * 0.7], { bevel: 0.006, grain: 1 });
      m.box('wood', [0, (base + H - 0.03) / 2, -D / 2 + 0.03], [W - 0.06, H - base - 0.03, 0.02], { grain: 1 });
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

// ---------- service rooms, cellars, chambers and towers (one focal piece per room role, dress.ts) ----------
/** Staves round a lathe profile, with iron hoops: casks, tubs and vats. */
function staved(m: PropMesh, r: Rng, prof: [number, number][], hoops: number[], seg = 14) {
  m.tinted(woodTint(r), () => m.lathe('wood', prof, seg, { grainUp: true, wobble: (th) => 1 + Math.sin(th * seg) * 0.012 }));
  const R = (y: number) => { for (let i = 1; i < prof.length; i++) if (prof[i][1] >= y) { const [r0, y0] = prof[i - 1], [r1, y1] = prof[i]; return r0 + (r1 - r0) * (y - y0) / Math.max(1e-6, y1 - y0); } return prof[prof.length - 1][0]; };
  m.tinted(IRON, () => { for (const y of hoops) m.with(translate(0, y, 0), () => m.lathe('iron', [[R(y) + 0.006, -0.02], [R(y) + 0.008, 0], [R(y) + 0.006, 0.02]], seg)); });
}

/** A stillage: a low timber cradle with two or three casks lying on it, ends to the room. */
export const caskRack: PropKind = {
  name: 'cask-rack', placement: 'floor', blocksNav: true,
  build(m, r) {
    const n = r() < 0.5 ? 2 : 3, R = range(r, 0.3, 0.36), L = range(r, 0.8, 0.95), gap = 2 * R + 0.08, W = n * gap;
    m.tinted(woodTint(r), () => { for (const sz of [-1, 1]) m.box('wood', [0, 0.08, sz * L * 0.32], [W + 0.1, 0.16, 0.12], { bevel: 0.01, noBottom: true }); });
    for (let i = 0; i < n; i++) m.with(compose(translate(-W / 2 + gap * (i + 0.5), 0.16 + R * 0.92, -L / 2), rotX(Math.PI / 2)), () =>
      staved(m, r, [[R * 0.86, 0], [R, L * 0.25], [R * 1.04, L * 0.5], [R, L * 0.75], [R * 0.86, L]], [0.06, L * 0.3, L * 0.7, L - 0.06]));
    m.tinted(IRON, () => m.tube('iron', [[-W / 2 + gap * 0.5, 0.16 + R, L / 2], [-W / 2 + gap * 0.5, 0.16 + R, L / 2 + 0.07], [-W / 2 + gap * 0.5, 0.16 + R - 0.04, L / 2 + 0.08]], 0.012, 5)); // a tap
    return { colliders: [hull(m)], emitters: [] };
  },
};

/** A brewer's mash tun: a big staved vat on blocks, a wooden lid half off, a mash paddle. */
export const mashTun: PropKind = {
  name: 'mash-tun', placement: 'floor', blocksNav: true,
  build(m, r) {
    const R = range(r, 0.55, 0.7), H = range(r, 0.9, 1.05);
    m.tinted(woodTint(r), () => { for (const sx of [-1, 1]) m.box('wood', [sx * R * 0.5, 0.06, 0], [0.14, 0.12, R * 1.8], { bevel: 0.01, noBottom: true }); });
    m.with(translate(0, 0.12, 0), () => staved(m, r, [[R * 0.92, 0], [R, H * 0.5], [R * 1.04, H]], [0.1, H * 0.5, H - 0.08], 18));
    m.tinted([0.45, 0.33, 0.18], () => m.with(translate(0, 0.12 + H * 0.8, 0), () => m.lathe('ceramic', [[0, 0], [R * 0.98, 0]], 18, { capTop: true })));
    m.tinted(woodTint(r), () => {
      m.with(translate(R * 0.35, 0.12 + H + 0.02, -R * 0.2), () => m.box('wood', [0, 0, 0], [R * 1.1, 0.04, R * 0.9], { bevel: 0.008 }));
      m.tube('wood', [[-R * 0.3, 0.12 + H * 0.7, 0.1], [-R * 0.6, 0.12 + H + 0.6, 0.25]], 0.025, 6);
    });
    return { colliders: [hull(m)], emitters: [] };
  },
};

/** A bread oven: a domed stone oven on a plinth with an arched mouth, an iron door leaning by it and a
 * peel. Cold (it is not baking now). */
export const breadOven: PropKind = {
  name: 'bread-oven', placement: 'floor', blocksNav: true,
  build(m, r) {
    const W = range(r, 1.4, 1.7), D = range(r, 1.1, 1.3), P = 0.8, st = jitterTint(r, STONE_GREY, 0.06);
    m.tinted(st, () => {
      m.box('stone', [0, P / 2, 0], [W, P, D], { bevel: 0.02, noBottom: true });
      m.with(compose(translate(0, P, 0), rotX(0)), () => m.lathe('stone', [[W * 0.46, 0], [W * 0.45, 0.25], [W * 0.36, 0.5], [W * 0.2, 0.68], [0.001, 0.72]], 16));
    });
    m.tinted([0.08, 0.07, 0.06], () => m.box('stone', [0, P + 0.18, D / 2 - 0.02], [0.42, 0.32, 0.03]));
    m.tinted(IRON, () => m.with(compose(translate(W * 0.36, P * 0.5, D / 2 + 0.05), rotX(-0.25)), () => m.box('iron', [0, 0, 0], [0.4, 0.34, 0.02], { bevel: 0.005 })));
    m.tinted(woodTint(r), () => m.tube('wood', [[-W * 0.45, 0.02, D / 2 + 0.05], [-W * 0.4, P + 0.9, D / 2 + 0.02]], 0.018, 5));
    return { colliders: [hull(m)], emitters: [] };
  },
};

/** A laundry tub: a low staved tub half full of water, a washboard leaning in it, linen over the rim. */
export const washTub: PropKind = {
  name: 'wash-tub', placement: 'floor', blocksNav: true,
  build(m, r) {
    const R = range(r, 0.4, 0.5), H = range(r, 0.4, 0.5);
    staved(m, r, [[R * 0.88, 0], [R, H]], [0.06, H - 0.05], 16);
    m.tinted([0.5, 0.55, 0.55], () => m.with(translate(0, H * 0.7, 0), () => m.lathe('ceramic', [[0, 0], [R * 0.95, 0]], 16, { capTop: true })));
    m.tinted(woodTint(r), () => m.with(compose(translate(R * 0.3, 0.36, 0), rotZ(0.4)), () => m.box('wood', [0, 0, 0], [0.04, 0.6, 0.35], { bevel: 0.004 })));
    m.tinted(jitterTint(r, CLOTH.linen, 0.04), () => m.sheet('cloth', (s, t) => [(s - 0.5) * 0.45, H + 0.01 - Math.max(0, t - 0.4) * 0.5, -R + 0.15 - t * 0.3], 4, 4, [0.45, 0.5]));
    return { colliders: [hull(m)], emitters: [] };
  },
};

/** A drying rack: two A-frame ends and three rails with linens (or gowns, in a wardrobe) hung over them. */
export const dryingRack: PropKind = {
  name: 'drying-rack', placement: 'floor', blocksNav: true,
  build(m, r) {
    const L = range(r, 1.4, 1.9), H = range(r, 1.4, 1.65);
    m.tinted(woodTint(r), () => {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.tube('wood', [[sx * L / 2, 0, sz * 0.3], [sx * L / 2, H, 0]], 0.022, 5);
      for (const y of [H * 0.55, H]) m.tube('wood', [[-L / 2 - 0.05, y, 0], [L / 2 + 0.05, y, 0]], 0.018, 5);
    });
    const cols: RGB[] = [CLOTH.linen, CLOTH.undyed, CLOTH.madder, CLOTH.woad, CLOTH.green, CLOTH.weld];
    let x = -L / 2 + 0.1;
    while (x < L / 2 - 0.3) {
      const w = range(r, 0.3, 0.55), drop = range(r, 0.5, 0.9), c = jitterTint(r, pick(r, cols), 0.08);
      if (x + w > L / 2 - 0.05) break;
      m.tinted(c, () => m.sheet('cloth', (s, t) => { const a = t * Math.PI; return [x + s * w, H - Math.sin(a) * 0.02 - Math.max(0, Math.abs(t - 0.5) - 0.05) * drop * 2, Math.cos(a) * 0.04]; }, 3, 6, [w, drop]));
      x += w + range(r, 0.03, 0.1);
    }
    return { colliders: [boxCollider([-L / 2 - 0.05, 0, -0.32], [L / 2 + 0.05, H, 0.32])], emitters: [] };
  },
};

/** A grindstone: a sandstone wheel in a timber frame with a crank and a water trough. */
export const grindstone: PropKind = {
  name: 'grindstone', placement: 'floor', blocksNav: true,
  build(m, r) {
    const R = range(r, 0.3, 0.38), L = 1.0;
    m.tinted(woodTint(r), () => {
      for (const sz of [-1, 1]) m.box('wood', [0, 0.35, sz * 0.18], [L, 0.08, 0.08], { bevel: 0.008 });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.box('wood', [sx * 0.42, 0.18, sz * 0.18], [0.07, 0.36, 0.07], { bevel: 0.006, grain: 1, noBottom: true });
      m.box('wood', [0, 0.47, 0], [0.5, 0.14, 0.3], { bevel: 0.01 });
    });
    m.tinted(jitterTint(r, [1.0, 0.85, 0.68], 0.05), () => m.with(compose(translate(0, 0.42 + R * 0.75, 0), rotX(Math.PI / 2)), () => m.lathe('stone', [[0.001, -0.06], [R, -0.06], [R + 0.005, 0], [R, 0.06], [0.001, 0.06]], 18)));
    m.tinted(IRON, () => m.tube('iron', [[0, 0.42 + R * 0.75, -0.25], [0, 0.42 + R * 0.75, 0.28], [0, 0.42 + R * 0.75 - 0.15, 0.3], [0.08, 0.42 + R * 0.75 - 0.15, 0.32]], 0.012, 5));
    return { colliders: [hull(m)], emitters: [] };
  },
};

/** A well head: a ring of dressed stone with a coping, two posts and a windlass with rope and bucket. */
export const wellHead: PropKind = {
  name: 'well', placement: 'floor', blocksNav: true,
  build(m, r) {
    const R = range(r, 0.6, 0.75), H = range(r, 0.7, 0.85), st = jitterTint(r, STONE_GREY, 0.05);
    m.tinted(st, () => m.lathe('stone', [[R, 0], [R, H - 0.1], [R + 0.06, H - 0.08], [R + 0.06, H], [R - 0.2, H], [R - 0.2, 0.2]], 18));
    m.tinted([0.05, 0.06, 0.07], () => m.with(translate(0, H - 0.25, 0), () => m.lathe('ceramic', [[0, 0], [R - 0.2, 0]], 16, { capTop: true }))); // the dark water far down
    m.tinted(woodTint(r), () => {
      for (const sx of [-1, 1]) m.box('wood', [sx * (R + 0.02), H + 0.55, 0], [0.1, 1.1, 0.1], { bevel: 0.01, grain: 1 });
      m.with(compose(translate(0, H + 0.95, 0), rotZ(Math.PI / 2)), () => m.lathe('wood', [[0.07, -R], [0.08, 0], [0.07, R]], 10, { capTop: true, capBottom: true }));
      m.box('wood', [0, H + 1.15, 0], [2 * R + 0.3, 0.06, 0.2], { bevel: 0.01 });
    });
    m.tinted(IRON, () => m.tube('iron', [[R + 0.08, H + 0.95, 0], [R + 0.2, H + 0.95, 0], [R + 0.2, H + 0.75, 0.05]], 0.012, 5));
    m.tinted(jitterTint(r, CLOTH.undyed, 0.06), () => m.tube('cloth', [[0.05, H + 0.95, 0.07], [0.05, H + 0.35, 0.07]], 0.01, 4));
    m.with(translate(0.05, H + 0.15, 0.07), () => staved(m, r, [[0.1, 0], [0.13, 0.22]], [0.03, 0.19], 10));
    return { colliders: [hull(m)], emitters: [] };
  },
};

/** Shackles on the wall: an iron plate with a ring, two chains hanging to cuffs. */
export const shackles: PropKind = {
  name: 'shackles', placement: 'wall', mount: 1.4, blocksNav: false,
  build(m, r) {
    const sp = range(r, 0.45, 0.6);
    m.tinted(IRON, () => {
      for (const sx of [-1, 1]) {
        m.box('iron', [sx * sp / 2, 0, 0.01], [0.12, 0.12, 0.02], { bevel: 0.004 });
        // a chain of interlocking links hanging straight down, each turned a quarter from the last, to a cuff
        const links = Math.round(range(r, 15, 22)), pitch = 0.028, drop = links * pitch;
        for (let i = 0; i < links; i++) {
          m.with(compose(compose(translate(sx * sp / 2, -0.04 - i * pitch, 0.035), rotY(i % 2 ? Math.PI / 2 : 0)), rotX(Math.PI / 2)),
            () => m.lathe('iron', [[0.012, -0.004], [0.018, 0], [0.012, 0.004], [0.012, -0.004]], 6));
        }
        m.with(compose(translate(sx * sp / 2, -drop - 0.08, 0.035), rotX(Math.PI / 2)), () => m.lathe('iron', [[0.045, -0.02], [0.05, 0], [0.045, 0.02], [0.045, -0.02]], 10));
      }
    });
    return { colliders: [hull(m)], emitters: [] };
  },
};

/** A garderobe seat: a boarded box against the wall with a round hole in a lid, a bucket of water by it. */
export const privy: PropKind = {
  name: 'privy', placement: 'floor', blocksNav: true,
  build(m, r) {
    const W = range(r, 0.8, 1.0), D = 0.55, H = 0.46;
    m.tinted(woodTint(r), () => { m.box('wood', [0, H / 2, 0], [W, H, D], { bevel: 0.01, grain: 0, noBottom: true }); m.box('wood', [0, H + 0.015, 0], [W + 0.04, 0.03, D + 0.02], { bevel: 0.008 }); });
    m.tinted([0.04, 0.035, 0.03], () => m.with(translate(0, H + 0.032, 0.03), () => m.lathe('ceramic', [[0, 0], [0.13, 0]], 14, { capTop: true })));
    m.with(translate(W / 2 + 0.25, 0, 0.05), () => staved(m, r, [[0.14, 0], [0.17, 0.3]], [0.04, 0.26], 10));
    return { colliders: [hull(m)], emitters: [] };
  },
};

/** A rocking cradle: a boarded box on curved rockers, a hood at the head, a blanket. */
export const cradle: PropKind = {
  name: 'cradle', placement: 'floor', blocksNav: true,
  build(m, r) {
    const L = range(r, 0.85, 1.0), W = 0.45, H = 0.45;
    m.tinted(woodTint(r), () => {
      for (const sz of [-1, 1]) m.tube('wood', Array.from({ length: 7 }, (_, i) => { const a = (i / 6 - 0.5) * 1.2; return [Math.sin(a) * 0.45, 0.04 + (1 - Math.cos(a)) * 0.45, sz * L * 0.35] as V3; }), 0.025, 5);
      m.box('wood', [0, 0.1 + H / 2, 0], [W, H, L], { bevel: 0.01, grain: 2 });
      m.box('wood', [0, 0.1 + H + 0.12, -L / 2 + 0.15], [W + 0.04, 0.24, 0.3], { bevel: 0.01 });
    });
    m.tinted(jitterTint(r, pick(r, [CLOTH.woad, CLOTH.madder, CLOTH.weld]), 0.06), () => m.box('cloth', [0, 0.1 + H + 0.01, 0.1], [W - 0.04, 0.05, L * 0.6], { bevel: 0.02 }));
    return { colliders: [hull(m)], emitters: [] };
  },
};

/** A scribe's desk: a sloped writing board on a stand with a book open on it, an inkhorn and a quill, a
 * shelf under the slope with more books. */
export const writingDesk: PropKind = {
  name: 'writing-desk', placement: 'floor', blocksNav: true,
  build(m, r) {
    const W = range(r, 0.8, 1.0), D = 0.6, H = range(r, 0.85, 0.95);
    m.tinted(woodTint(r), () => {
      for (const sx of [-1, 1]) m.box('wood', [sx * (W / 2 - 0.04), H / 2, 0], [0.06, H, D - 0.1], { bevel: 0.008, grain: 1, noBottom: true });
      m.box('wood', [0, 0.35, 0], [W - 0.08, 0.03, D - 0.15], { bevel: 0.004 });
      m.with(compose(translate(0, H + 0.08, 0), rotX(0.35)), () => m.box('wood', [0, 0, 0], [W + 0.04, 0.035, D], { bevel: 0.008 }));
    });
    m.with(compose(translate(0, H + 0.105, 0.03), rotX(0.35)), () => {
      m.tinted([0.95, 0.88, 0.72], () => { for (const sx of [-1, 1]) m.sheet('wax', (s, t) => [sx * (0.005 + s * 0.22), 0.012 + Math.sin(s * Math.PI) * 0.012, (t - 0.5) * 0.3], 5, 2, [0.22, 0.3]); });
      m.tinted(jitterTint(r, CLOTH.leather), () => m.box('cloth', [0, 0.004, 0], [0.47, 0.008, 0.32], { bevel: 0.002 }));
    });
    m.tinted([0.15, 0.12, 0.1], () => m.with(translate(W / 2 - 0.08, H + 0.18, -D / 2 + 0.05), () => m.lathe('ceramic', [[0.001, 0], [0.03, 0], [0.025, 0.06], [0.012, 0.07]], 8)));
    m.tinted([0.92, 0.9, 0.85], () => m.tube('cloth', [[W / 2 - 0.08, H + 0.24, -D / 2 + 0.05], [W / 2 - 0.02, H + 0.42, -D / 2 + 0.02]], [0.004, 0.012], 4));
    m.tinted(jitterTint(r, CLOTH.madder), () => { for (let i = 0; i < 4; i++) m.box('cloth', [-W / 2 + 0.12 + i * 0.06, 0.365 + 0.12, -0.05], [0.045, 0.24, 0.2]); });
    return { colliders: [hull(m)], emitters: [] };
  },
};

/** The steward's counting table: a table under a chequered cloth (the exchequer board), stacks of coin,
 * a tally box and a pair of scales. */
export const countingTable: PropKind = {
  name: 'counting-table', placement: 'floor', blocksNav: true,
  build(m, r) {
    const L = range(r, 1.5, 1.8), W = range(r, 0.8, 0.9), H = 0.76;
    m.tinted(woodTint(r), () => {
      m.box('wood', [0, H - 0.025, 0], [L, 0.05, W], { bevel: 0.01 });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.box('wood', [sx * (L / 2 - 0.08), (H - 0.05) / 2, sz * (W / 2 - 0.08)], [0.07, H - 0.05, 0.07], { bevel: 0.006, grain: 1, noBottom: true });
    });
    const nx = 8, nz = 4, cw = (L - 0.2) / nx, cd = (W - 0.2) / nz;
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) m.tinted((i + j) % 2 ? CLOTH.green : CLOTH.black, () => m.box('cloth', [-L / 2 + 0.1 + cw * (i + 0.5), H + 0.002, -W / 2 + 0.1 + cd * (j + 0.5)], [cw, 0.004, cd], { noBottom: true }));
    m.tinted([0.85, 0.7, 0.35], () => { for (let k = 0; k < 6; k++) { const h = range(r, 0.01, 0.05); m.with(translate(range(r, -L / 2 + 0.2, L / 2 - 0.2), H + 0.004, range(r, -W / 2 + 0.15, W / 2 - 0.15)), () => m.lathe('brass', [[0.001, 0], [0.012, 0], [0.012, h], [0.001, h]], 8)); } });
    m.tinted(IRON, () => m.with(translate(L * 0.3, H, -W * 0.3), () => {
      m.box('iron', [0, 0.18, 0], [0.015, 0.36, 0.015]); m.box('iron', [0, 0.35, 0], [0.32, 0.012, 0.012]);
      for (const sx of [-1, 1]) m.with(translate(sx * 0.15, 0.2, 0), () => m.lathe('iron', [[0.001, 0], [0.06, 0.02], [0.065, 0.025]], 8));
    }));
    m.tinted(woodTint(r), () => m.box('wood', [-L * 0.32, H + 0.06, -W * 0.25], [0.3, 0.12, 0.2], { bevel: 0.008 }));
    return { colliders: [hull(m)], emitters: [] };
  },
};

/** An upright loom: two uprights leaning on the wall, a cloth beam at the top, the warp hanging down
 * weighted by a row of clay loom weights, and woven cloth growing at the top. */
export const loom: PropKind = {
  name: 'loom', placement: 'floor', blocksNav: true,
  build(m, r) {
    const W = range(r, 1.3, 1.6), H = range(r, 1.9, 2.1), lean = 0.35, c = jitterTint(r, pick(r, [CLOTH.madder, CLOTH.woad, CLOTH.undyed, CLOTH.green]), 0.06);
    m.tinted(woodTint(r), () => {
      for (const sx of [-1, 1]) m.tube('wood', [[sx * W / 2, 0, lean], [sx * W / 2, H, 0]], 0.035, 6);
      m.tube('wood', [[-W / 2 - 0.08, H - 0.12, 0.03], [W / 2 + 0.08, H - 0.12, 0.03]], 0.05, 8);
      m.tube('wood', [[-W / 2, H * 0.55, lean * 0.45 + 0.02], [W / 2, H * 0.55, lean * 0.45 + 0.02]], 0.02, 5);
    });
    const top = H - 0.12, woven = range(r, 0.4, 0.8);
    m.tinted(c, () => m.sheet('cloth', (s, t) => [(s - 0.5) * (W - 0.15), top - t * woven, 0.03 + (t * woven / H) * lean + 0.03], 4, 3, [W, woven]));
    m.tinted(jitterTint(r, [0.85, 0.8, 0.68], 0.05), () => m.sheet('cloth', (s, t) => [(s - 0.5) * (W - 0.15), top - woven - t * (top - woven - 0.3), 0.06 + ((woven + t * (top - woven - 0.3)) / H) * lean], 4, 3, [W, 1]));
    m.tinted(jitterTint(r, [0.62, 0.42, 0.3], 0.08), () => { for (let i = 0; i < 9; i++) m.with(translate(-W / 2 + 0.12 + i * ((W - 0.24) / 8), 0.24, 0.06 + ((top - 0.3) / H) * lean), () => m.lathe('ceramic', [[0.001, 0], [0.05, 0.02], [0.04, 0.09], [0.001, 0.1]], 6)); });
    return { colliders: [boxCollider([-W / 2 - 0.1, 0, -0.05], [W / 2 + 0.1, H, lean + 0.05])], emitters: [] };
  },
};

/** A falconer's perch: a padded bow perch on a block and a T-perch on a post, hooded hawks on both. */
export const perch: PropKind = {
  name: 'perch', placement: 'floor', blocksNav: true,
  build(m, r) {
    const W = range(r, 1.1, 1.4);
    m.tinted(woodTint(r), () => {
      m.box('wood', [0, 0.05, 0], [W, 0.1, 0.4], { bevel: 0.01, noBottom: true });
      for (const sx of [-1, 1]) m.box('wood', [sx * (W / 2 - 0.1), 0.6, 0], [0.06, 1.0, 0.06], { bevel: 0.006, grain: 1 });
      m.tube('wood', [[-W / 2 + 0.05, 1.1, 0], [W / 2 - 0.05, 1.1, 0]], 0.025, 6);
    });
    m.tinted(jitterTint(r, CLOTH.undyed, 0.05), () => m.tube('cloth', [[-W / 2 + 0.12, 1.1, 0], [W / 2 - 0.12, 1.1, 0]], 0.034, 6));
    const birds = 1 + Math.floor(r() * 2);
    for (let i = 0; i < birds; i++) {
      const x = (i - (birds - 1) / 2) * 0.45, plum = jitterTint(r, pick(r, [[0.42, 0.33, 0.24], [0.55, 0.5, 0.45], [0.3, 0.25, 0.2]] as RGB[]), 0.08);
      m.with(translate(x, 1.13, 0), () => {
        m.tinted(plum, () => { m.with(rotX(0.15), () => m.lathe('cloth', [[0.001, 0], [0.06, 0.04], [0.08, 0.15], [0.06, 0.25], [0.001, 0.29]], 10)); m.tube('cloth', [[0, 0.06, -0.05], [0, -0.12, -0.12]], [0.04, 0.015], 5); });
        m.tinted(CLOTH.leather, () => m.with(translate(0, 0.3, 0.02), () => m.lathe('cloth', [[0.045, 0], [0.05, 0.04], [0.03, 0.08], [0.008, 0.11]], 8)));
        m.tinted([0.85, 0.75, 0.3], () => { for (const sx of [-1, 1]) m.tube('brass', [[sx * 0.025, 0.01, 0.02], [sx * 0.03, -0.03, 0.04]], 0.006, 4); });
      });
    }
    return { colliders: [hull(m)], emitters: [] };
  },
};

/** An iron brazier of coals on a tripod: the watch's fire, glowing coals and a low flame. */
export const brazier: PropKind = {
  name: 'brazier', placement: 'floor', blocksNav: true,
  build(m, r) {
    const R = range(r, 0.26, 0.32), H = range(r, 0.62, 0.72);
    m.tinted(IRON, () => {
      for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2; m.tube('iron', [[Math.cos(a) * R * 1.1, 0, Math.sin(a) * R * 1.1], [Math.cos(a) * R * 0.6, H * 0.6, Math.sin(a) * R * 0.6], [Math.cos(a) * R * 0.9, H, Math.sin(a) * R * 0.9]], 0.016, 5); }
      m.with(translate(0, H * 0.75, 0), () => m.lathe('iron', [[0.001, 0], [R * 0.6, 0.03], [R, H * 0.25], [R * 1.05, H * 0.27]], 14));
    });
    m.tinted(EMBERS, () => m.with(translate(0, H * 0.75 + H * 0.2, 0), () => m.lathe('wax', [[0.001, 0.04], [R * 0.6, 0.02], [R * 0.95, 0]], 12)));
    m.tinted([0.15, 0.12, 0.1], () => { for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2 + range(r, -0.2, 0.2), d = R * (0.15 + 0.1 * i); m.with(compose(translate(Math.cos(a) * d, H * 0.97 + i * 0.005, Math.sin(a) * d), rotY(a)), () => m.box('stone', [0, 0, 0], [0.07 + i * 0.005, 0.04, 0.06], { bevel: 0.01 })); } });
    m.addFlame('brazier', [0, H * 0.98, 0], 0.32);
    return { colliders: [hull(m)], emitters: [{ kind: 'brazier', position: [0, H + 0.25, 0], colour: [1, 1, 1], intensity: 1.6, flicker: 0.3 }] };
  },
};

export const MEDIEVAL: readonly PropKind[] = [shutter, refectoryTable, boxChair, dresser, stoneAltar, prieDieu, spitHearth, workTable,
  caskRack, mashTun, breadOven, washTub, dryingRack, grindstone, wellHead, shackles, privy, cradle, writingDesk, countingTable, loom, perch, brazier];
