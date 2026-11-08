// The procedural furniture and prop kit. Every generator is a pure function of (mesh, rng): it writes
// triangles in the prop's local frame and returns how the prop behaves in a room. Local frame: origin
// on the floor at the centre of the footprint (or on the wall / ceiling for mounted props), +y up,
// the front faces +z, metres. Sizes follow real medieval furniture (seat 0.45 m, table 0.76 m).
import { PropMesh, translate, rotX, rotY, rotZ, compose, type RGB, type V3 } from './geom';
import { mulberry32, hashSeed, range, pick, type Rng } from '../core/rng';
import { WOOD, CLOTH, IRON, FLAME, jitterTint, woodTint, boxCollider, hull, none, planks, leg, flame, jug, bowl, book, candle, v3dir, type PropKind, type PropMeta, type Emitter } from './parts';
import { PERIOD } from './period';
import { MEDIEVAL } from './medieval';
export { WOOD, CLOTH };
export type { Placement, Emitter, Collider, PropMeta, PropKind } from './parts';

// ---------- tables and seating ----------
export const trestleTable: PropKind = {
  name: 'trestle-table', placement: 'floor', blocksNav: true,
  build(m, r) {
    const L = range(r, 1.8, 3.0), W = range(r, 0.72, 0.9), H = range(r, 0.74, 0.78), t = 0.05;
    m.tinted(woodTint(r), () => {
      planks(m, r, L, W, H - t, t);
      for (const sx of [-1, 1]) {
        const x = sx * (L / 2 - range(r, 0.22, 0.32));
        m.box('wood', [x, H - t - 0.04, 0], [0.08, 0.08, W * 0.86], { bevel: 0.006, grain: 2 });  // bearer
        m.box('wood', [x, 0.04, 0], [0.09, 0.08, W * 0.8], { bevel: 0.008, grain: 2, noBottom: true }); // foot
        for (const sz of [-1, 1]) leg(m, x, sz * W * 0.18, H - t - 0.08, 0.075, 0, sz * W * 0.17);
      }
      m.box('wood', [0, 0.32, 0], [L * 0.66, 0.07, 0.05], { bevel: 0.006 }); // stretcher
    });
    return { colliders: [boxCollider([-L / 2, 0, -W / 2], [L / 2, H, W / 2])], emitters: [] };
  },
};

export const bench: PropKind = {
  name: 'bench', placement: 'floor', blocksNav: true,
  build(m, r) {
    const L = range(r, 1.3, 2.6), D = range(r, 0.26, 0.33), H = range(r, 0.43, 0.48), t = 0.055;
    m.tinted(woodTint(r), () => {
      m.box('wood', [0, H - t / 2, 0], [L, t, D], { bevel: 0.008, skew: [range(r, -0.004, 0.004), 0] });
      for (const sx of [-1, 1]) {
        const x = sx * (L / 2 - range(r, 0.12, 0.2));
        m.box('wood', [x, (H - t) / 2, 0], [0.05, H - t, D * 0.9], { bevel: 0.006, grain: 1, noBottom: true, taper: -0.15 });
      }
      m.box('wood', [0, 0.16, 0], [L * 0.7, 0.06, 0.035], { bevel: 0.005 });
    });
    return none(m);
  },
};

export const stool: PropKind = {
  name: 'stool', placement: 'floor', blocksNav: true,
  build(m, r) {
    const H = range(r, 0.4, 0.5), R = range(r, 0.15, 0.2), t = 0.045, three = r() < 0.6;
    m.tinted(woodTint(r), () => {
      if (three) m.with(translate(0, H - t, 0), () => m.lathe('wood', [[0, 0], [R, 0], [R + 0.005, t * 0.6], [R - 0.01, t], [0, t]], 12, {}));
      else m.box('wood', [0, H - t / 2, 0], [R * 1.8, t, R * 1.8], { bevel: 0.01 });
      const n = three ? 3 : 4;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + (three ? 0 : Math.PI / 4) + range(r, -0.1, 0.1);
        const x = Math.cos(a) * R * 0.62, z = Math.sin(a) * R * 0.62;
        leg(m, x, z, H - t, 0.045, Math.cos(a) * 0.07, Math.sin(a) * 0.07, true);
      }
    });
    return none(m);
  },
};

function chairBody(m: PropMesh, r: Rng, W: number, D: number, H: number, back: number, arms: boolean, cushion: RGB | null) {
  const post = 0.06, t = 0.04;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const h = sz < 0 ? back : arms ? H + 0.24 : H + 0.008; // front posts stand proud of the seat (no shared top face)
    m.box('wood', [sx * (W / 2 - post / 2), h / 2, sz * (D / 2 - post / 2)], [post, h, post], { bevel: 0.008, grain: 1, noBottom: true });
    if (sz < 0) m.with(translate(sx * (W / 2 - post / 2), h, sz * (D / 2 - post / 2)), () => m.lathe('wood', [[post * 0.5, 0], [post * 0.6, 0.03], [0.001, 0.07]], 8));
  }
  m.box('wood', [0, H - t / 2, 0], [W - 0.02, t, D - 0.02], { bevel: 0.006, grain: 0 });
  m.box('wood', [0, (H + back) / 2 + 0.03, -D / 2 + post / 2], [W - post * 2, back - H - 0.16, 0.025], { bevel: 0.004, grain: 1 });
  m.box('wood', [0, back - 0.07, -D / 2 + post / 2], [W - post, 0.08, 0.05], { bevel: 0.008 });
  for (const sz of [-1, 1]) m.box('wood', [0, 0.14, sz * (D / 2 - post / 2)], [W - post, 0.05, 0.035], { bevel: 0.004 });
  for (const sx of [-1, 1]) {
    m.box('wood', [sx * (W / 2 - post / 2), H - 0.1, 0], [0.035, 0.07, D - post], { bevel: 0.004, grain: 2 });
    if (arms) m.box('wood', [sx * (W / 2 - post / 2), H + 0.25, 0.02], [0.07, 0.035, D], { bevel: 0.008, grain: 2 }); // ends inside the back post
  }
  if (cushion) m.tinted(cushion, () => m.box('cloth', [0, H + 0.035, 0.01], [W - 0.1, 0.07, D - 0.1], { bevel: 0.03, skew: [range(r, -0.01, 0.01), range(r, -0.01, 0.01)] }));
}

export const chair: PropKind = {
  name: 'chair', placement: 'floor', blocksNav: true,
  build(m, r) {
    m.tinted(woodTint(r), () => chairBody(m, r, range(r, 0.5, 0.6), range(r, 0.45, 0.52), range(r, 0.44, 0.47), range(r, 1.0, 1.2), r() < 0.5, r() < 0.4 ? pick(r, [CLOTH.madder, CLOTH.woad, CLOTH.green]) : null));
    return none(m);
  },
};

export const throne: PropKind = {
  name: 'throne', placement: 'floor', blocksNav: true,
  build(m, r) {
    const W = range(r, 0.8, 0.95), D = range(r, 0.62, 0.7);
    m.tinted(jitterTint(r, WOOD.dark), () => {
      m.box('wood', [0, 0.06, 0.04], [W + 0.25, 0.12, D + 0.35], { bevel: 0.01, noBottom: true }); // dais step
      m.with(translate(0, 0.12, 0), () => chairBody(m, r, W, D, 0.46, range(r, 1.55, 1.75), true, jitterTint(r, pick(r, [CLOTH.madder, CLOTH.woad]))));
      // canopy board over the back
      m.box('wood', [0, 1.85, -D / 2 + 0.1], [W + 0.1, 0.06, 0.26], { bevel: 0.01 });
    });
    m.tinted(jitterTint(r, CLOTH.madder), () => m.sheet('cloth', (s, t) => [(s - 0.5) * (W - 0.14), 0.62 + t * 1.0, -D / 2 + 0.065 + Math.sin(s * Math.PI * 6) * 0.008], 12, 4, [W, 1]));
    return none(m);
  },
};

// ---------- beds ----------
function bedBody(m: PropMesh, r: Rng, L: number, W: number, cover: RGB) {
  const H = 0.4, rail = 0.06;
  m.tinted(woodTint(r), () => {
    for (const sx of [-1, 1]) m.box('wood', [sx * (W / 2 - rail / 2 - 0.005), H - 0.12, 0], [rail, 0.18, L - 0.02], { bevel: 0.008, grain: 2 }); // set back 5 mm from the posts' faces
    for (const sz of [-1, 1]) m.box('wood', [0, H - 0.12, sz * (L / 2 - rail / 2 - 0.005)], [W - rail * 2, 0.18, rail], { bevel: 0.008 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.box('wood', [sx * (W / 2 - 0.04), (sz < 0 ? 1.0 : 0.55) / 2, sz * (L / 2 - 0.04)], [0.08, sz < 0 ? 1.0 : 0.55, 0.08], { bevel: 0.01, grain: 1, noBottom: true });
    m.box('wood', [0, 0.72, -L / 2 + 0.04], [W - 0.1, 0.5, 0.03], { bevel: 0.006, grain: 1 }); // headboard
  });
  const top = H + 0.12;
  m.tinted(jitterTint(r, CLOTH.linen), () => {
    m.box('cloth', [0, H + 0.02, 0], [W - 0.14, 0.2, L - 0.14], { bevel: 0.05 });               // mattress
    m.box('cloth', [range(r, -0.05, 0.05), top + 0.05, -L / 2 + 0.28], [W * 0.62, 0.12, 0.32], { bevel: 0.05, skew: [range(r, -0.02, 0.02), 0] }); // bolster
  });
  // blanket: over the top, falling over the sides and foot, a little rumpled
  const bw = W + 0.02, bl = L * 0.72, z0 = L / 2 - bl, fold = range(r, 0.2, 0.32);
  m.tinted(jitterTint(r, cover), () => m.sheet('cloth', (s, t) => {
    const x = (s - 0.5) * (bw + 0.32), edge = Math.max(0, Math.abs(x) - bw / 2 + 0.06);
    const y = top + 0.035 - edge * 1.4 + Math.sin(s * 17 + t * 9) * 0.008 + Math.sin(t * 5) * 0.01;
    return [Math.sign(x) * Math.min(Math.abs(x), bw / 2 + 0.01), Math.max(y, top - fold), z0 + t * (bl - 0.04)];
  }, 14, 10, [bw, bl]));
  m.tinted(jitterTint(r, cover), () => m.sheet('cloth', (s, t) => [(s - 0.5) * (bw - 0.02), top + 0.03 - t * fold, L / 2 - 0.05 + t * 0.03 + Math.sin(s * 15) * 0.008], 10, 3, [bw, fold]));
}

export const bed: PropKind = {
  name: 'bed', placement: 'floor', blocksNav: true,
  build(m, r) {
    const L = range(r, 1.9, 2.1), W = range(r, 0.9, 1.4);
    bedBody(m, r, L, W, pick(r, [CLOTH.brown, CLOTH.undyed, CLOTH.woad, CLOTH.green]));
    return none(m);
  },
};

export const strawPallet: PropKind = {
  name: 'straw-pallet', placement: 'floor', blocksNav: false,
  build(m, r) {
    const L = range(r, 1.7, 1.9), W = range(r, 0.7, 0.85), ph = r() * 9;
    m.tinted(jitterTint(r, CLOTH.undyed), () => m.sheet('cloth', (s, t) => {
      const ex = Math.sin(s * Math.PI), ez = Math.sin(t * Math.PI);
      return [(s - 0.5) * W, 0.01 + 0.14 * Math.pow(ex * ez, 0.35) + Math.sin(s * 9 + t * 7 + ph) * 0.01, (t - 0.5) * L];
    }, 10, 14, [W, L]));
    m.tinted(jitterTint(r, CLOTH.brown), () => m.sheet('cloth', (s, t) => [(s - 0.5) * (W + 0.1), 0.175 + Math.sin(s * 11 + ph) * 0.012 - Math.pow(Math.abs(s - 0.5) * 2, 4) * 0.13, L * 0.05 + (t - 0.5) * L * 0.6], 10, 6, [W, L * 0.6]));
    return none(m);
  },
};

// ---------- storage ----------
export const chest: PropKind = {
  name: 'chest', placement: 'floor', blocksNav: true,
  build(m, r) {
    const L = range(r, 0.85, 1.3), D = range(r, 0.48, 0.6), H = range(r, 0.48, 0.62), lid = 0.07;
    m.tinted(woodTint(r), () => {
      m.box('wood', [0, (H - lid) / 2 + 0.03, 0], [L, H - lid - 0.06, D], { bevel: 0.01 });
      for (const sx of [-1, 1]) m.box('wood', [sx * (L / 2 - 0.03), (H - lid - 0.004) / 2, 0], [0.08, H - lid - 0.004, D + 0.02], { bevel: 0.01, grain: 1, noBottom: true }); // stiles, 10 mm proud of the ends, under the lid
      m.box('wood', [0, H - lid / 2, 0], [L + 0.03, lid, D + 0.03], { bevel: 0.015, skew: [range(r, -0.003, 0.003), 0] });
    });
    m.tinted(IRON, () => {
      const bands = 2 + Math.floor(r() * 2);
      for (let i = 0; i < bands; i++) {
        const x = (i / (bands - 1) - 0.5) * L * 0.7;
        m.box('iron', [x, H + 0.002, 0], [0.045, 0.006, D + 0.046]);
        for (const sz of [-1, 1]) m.box('iron', [x, H / 2 + 0.027, sz * (D / 2 + 0.017)], [0.041, H - 0.056, 0.006]); // under the lid band, not flush with it
      }
      m.box('iron', [0, H - 0.11, D / 2 + 0.024], [0.07, 0.12, 0.012], { bevel: 0.003 }); // hasp, over the strap
      for (const sx of [-1, 1]) m.tube('iron', Array.from({ length: 7 }, (_, i) => { const a = Math.PI * (i / 6); return [sx * (L / 2 + 0.03), H * 0.62 - Math.sin(a) * 0.06, Math.cos(a) * 0.08] as V3; }), 0.008, 5, [false, false]);
    });
    return none(m);
  },
};

export const cupboard: PropKind = {
  name: 'cupboard', placement: 'floor', blocksNav: true,
  build(m, r) {
    const W = range(r, 0.9, 1.25), D = range(r, 0.42, 0.52), H = range(r, 1.55, 1.9);
    m.tinted(woodTint(r), () => {
      m.box('wood', [0, 0.06, 0], [W + 0.04, 0.12, D + 0.03], { bevel: 0.01, noBottom: true });   // plinth
      m.box('wood', [0, H / 2, -0.01], [W, H - 0.2, D - 0.02], { bevel: 0.006, grain: 1 });          // carcass
      m.box('wood', [0, H - 0.05, 0.005], [W + 0.08, 0.1, D + 0.06], { bevel: 0.015 });              // cornice
      const dw = (W - 0.1) / 2 - 0.006;
      for (const sx of [-1, 1]) {
        m.box('wood', [sx * (dw / 2 + 0.006), H / 2 + 0.04, D / 2 - 0.01], [dw, H - 0.5, 0.03], { bevel: 0.008, grain: 1 });
        m.box('wood', [sx * (dw / 2 + 0.006), H / 2 + 0.04, D / 2 + 0.008], [dw - 0.12, H - 0.66, 0.01], { bevel: 0.004, grain: 1 });
      }
      m.box('wood', [0, 0.2, D / 2 - 0.01], [W - 0.06, 0.14, 0.03], { bevel: 0.006 });             // drawer front, below the doors
    });
    m.tinted(IRON, () => {
      for (const sx of [-1, 1]) for (const y of [0.55, H - 0.35]) m.box('iron', [sx * (W / 2 - 0.13), y, D / 2 + 0.008], [0.22, 0.03, 0.006]);
      for (const sx of [-1, 1]) m.tube('iron', [[sx * 0.04, H / 2 + 0.04, D / 2 + 0.01], [sx * 0.04, H / 2 + 0.01, D / 2 + 0.04], [sx * 0.04, H / 2 - 0.03, D / 2 + 0.02]], 0.007, 5);
    });
    return none(m);
  },
};

export const shelf: PropKind = {
  name: 'shelf', placement: 'floor', blocksNav: true,
  build(m, r) {
    const W = range(r, 1.0, 1.6), D = range(r, 0.3, 0.38), H = range(r, 1.5, 1.9), n = 3 + Math.floor(r() * 2);
    m.tinted(woodTint(r), () => {
      for (const sx of [-1, 1]) m.box('wood', [sx * (W / 2 - 0.025), H / 2, 0], [0.05, H, D], { bevel: 0.006, grain: 1, noBottom: true });
      for (let i = 0; i < n; i++) m.box('wood', [0, 0.12 + (i / (n - 1)) * (H - 0.18), 0], [W - 0.1, 0.035, D - 0.02], { bevel: 0.005 });
    });
    // clutter on each board: jugs, bowls and books, never past the ends
    for (let i = 0; i < n; i++) {
      const y = 0.12 + (i / (n - 1)) * (H - 0.18) + 0.0175;
      let x = -W / 2 + 0.1 + range(r, 0, 0.08);
      while (x < W / 2 - 0.18) {
        const k = r();
        if (k < 0.3) { const h = range(r, 0.16, 0.26); m.with(compose(translate(x + 0.06, y, range(r, -0.03, 0.03)), rotY(r() * 6)), () => jug(m, r, h)); x += 0.16; }
        else if (k < 0.55) { m.with(translate(x + 0.08, y, 0), () => bowl(m, r, range(r, 0.07, 0.1))); x += 0.2; }
        else if (k < 0.85) {
          const c = 2 + Math.floor(r() * 4);
          for (let j = 0; j < c; j++) {
            // on edge: the book's thickness runs along x from x to x + t, its width stands up from the board
            const t = range(r, 0.03, 0.06), w = range(r, 0.2, 0.3), h = range(r, 0.15, 0.22);
            m.with(compose(translate(x + t, y + w / 2 + 0.002, 0), rotZ(Math.PI / 2)), () => book(m, r, w, h, t)); x += t + 0.003;
          }
          x += 0.04;
        } else x += range(r, 0.1, 0.2);
      }
    }
    return none(m);
  },
};

export const barrel: PropKind = {
  name: 'barrel', placement: 'floor', blocksNav: true,
  build(m, r) {
    const H = range(r, 0.75, 0.95), R = range(r, 0.24, 0.29), B = R * range(r, 1.12, 1.2), ph = r() * 6;
    const prof: [number, number][] = Array.from({ length: 7 }, (_, i) => { const t = i / 6; return [R + (B - R) * Math.sin(t * Math.PI), t * H]; });
    m.tinted(woodTint(r), () => {
      m.lathe('wood', prof, 18, { grainUp: true, wobble: (th) => 1 + Math.sin(th * 18) * 0.004 + Math.sin(th + ph) * 0.006 });
      m.with(translate(0, H - 0.03, 0), () => m.lathe('wood', [[0, 0], [R * 0.97, 0]], 18, { capTop: true }));
    });
    m.tinted(IRON, () => {
      for (const t of [0.06, 0.28, 0.72, 0.94]) {
        const y = t * H, rr = R + (B - R) * Math.sin(t * Math.PI) + 0.004;
        m.lathe('iron', [[rr, y - 0.022], [rr + 0.002, y], [rr, y + 0.022]], 18);
      }
    });
    return { colliders: [boxCollider([-B, 0, -B], [B, H, B])], emitters: [] };
  },
};

export const crate: PropKind = {
  name: 'crate', placement: 'floor', blocksNav: true,
  build(m, r) {
    const S: V3 = [range(r, 0.5, 0.85), range(r, 0.4, 0.65), range(r, 0.45, 0.7)], b = 0.05;
    m.tinted(jitterTint(r, WOOD.grey, 0.12), () => {
      m.box('wood', [0, S[1] / 2, 0], [S[0] - 0.02, S[1] - 0.02, S[2] - 0.02], { bevel: 0.004 });
      for (const sy of [-1, 1]) for (const sz of [-1, 1]) m.box('wood', [0, S[1] / 2 + sy * (S[1] / 2 - b / 2), sz * (S[2] / 2 - b / 2)], [S[0], b, b], { bevel: 0.005 });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.box('wood', [sx * (S[0] / 2 - b / 2), S[1] / 2, sz * (S[2] / 2 - b / 2)], [b, S[1] - 2 * b, b], { bevel: 0.005, grain: 1 });
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) m.box('wood', [sx * (S[0] / 2 - b / 2), S[1] / 2 + sy * (S[1] / 2 - b / 2), 0], [b, b, S[2] - 2 * b], { bevel: 0.005, grain: 2 });
    });
    return none(m);
  },
};

export const sack: PropKind = {
  name: 'sack', placement: 'floor', blocksNav: true,
  build(m, r) {
    const R = range(r, 0.2, 0.26), H = range(r, 0.5, 0.72), lean = range(r, -0.06, 0.06), ph = r() * 6;
    // radius profile: flat base, a slumped belly, a tied neck and a short flared top
    const prof = (t: number) => t < 0.06 ? R * 1.15 * Math.sqrt(t / 0.06) : t < 0.72 ? R * (1.15 - 0.25 * (t - 0.06) / 0.66) : t < 0.86 ? R * (0.9 - 0.6 * (t - 0.72) / 0.14) : R * (0.3 + 0.25 * Math.sin((t - 0.86) / 0.14 * Math.PI)) * (t > 0.97 ? (1 - t) / 0.03 : 1);
    const yOf = (t: number) => (t < 0.06 ? 0.015 * t / 0.06 : t * H);
    m.tinted(jitterTint(r, CLOTH.undyed, 0.12), () => m.sheet('cloth', (s, t) => {
      const th = s * Math.PI * 2;
      const rr = Math.max(0.001, prof(t) * (1 + Math.sin(th * 3 + ph + t * 5) * 0.05 * Math.min(1, t * 4)));
      return [Math.cos(th) * rr * 1.08 + lean * t * t, yOf(t), Math.sin(th) * rr * 0.92];
    }, 14, 12, [R * 6.3, H], true));
    m.tinted([0.5, 0.42, 0.3], () => m.tube('straw', Array.from({ length: 9 }, (_, i) => { const a = (i / 8) * Math.PI * 2; return [Math.cos(a) * R * 0.33 * 1.08 + lean * 0.74, H * 0.86, Math.sin(a) * R * 0.33 * 0.92] as V3; }), 0.012, 4, [false, false]));
    return none(m);
  },
};

export const bucket: PropKind = {
  name: 'bucket', placement: 'floor', blocksNav: true,
  build(m, r) {
    const H = range(r, 0.28, 0.36), R0 = range(r, 0.12, 0.14), R1 = R0 * 1.2;
    m.tinted(woodTint(r), () => {
      m.lathe('wood', [[R0, 0], [R1, H], [R1 - 0.015, H], [R0 - 0.015, 0.03]], 14, { grainUp: true, wobble: (th) => 1 + Math.sin(th * 14) * 0.005 });
      m.lathe('wood', [[0, 0.03], [R0 - 0.015, 0.03]], 14, { capTop: true });
    });
    m.tinted(IRON, () => {
      for (const t of [0.15, 0.85]) { const rr = R0 + (R1 - R0) * t + 0.003; m.lathe('iron', [[rr, t * H - 0.015], [rr, t * H + 0.015]], 14); }
      m.tube('iron', Array.from({ length: 9 }, (_, i) => { const a = (i / 8) * Math.PI; return [Math.cos(a) * R1, H + Math.sin(a) * R1 * 0.9, 0] as V3; }), 0.005, 4, [false, false]);
    });
    return none(m);
  },
};

// ---------- kitchen ----------
export const cauldron: PropKind = {
  name: 'cauldron', placement: 'floor', blocksNav: true,
  build(m, r) {
    const R = range(r, 0.25, 0.38), legH = 0.12;
    m.tinted(IRON, () => {
      m.with(translate(0, legH, 0), () => m.lathe('iron', [[0, 0], [R * 0.6, 0.02], [R * 0.95, R * 0.4], [R, R * 0.8], [R * 0.9, R * 1.05], [R * 0.96, R * 1.1], [R * 0.86, R * 1.08], [R * 0.82, R * 0.9]], 18));
      for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2; leg(m, Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5, legH + 0.04, 0.03, Math.cos(a) * 0.03, Math.sin(a) * 0.03, true); }
      m.tube('iron', Array.from({ length: 11 }, (_, i) => { const a = (i / 10) * Math.PI; return [Math.cos(a) * R * 0.95, legH + R * 1.05 + Math.sin(a) * R * 0.7, 0] as V3; }), 0.008, 5, [false, false]);
    });
    // contents: a dark surface inside
    m.tinted([0.25, 0.2, 0.14], () => m.with(translate(0, legH + R * 0.78, 0), () => m.lathe('ceramic', [[0, 0], [R * 0.84, 0]], 18, { capTop: true })));
    return none(m);
  },
};

export const tableware: PropKind = {
  name: 'tableware', placement: 'floor', blocksNav: false,
  build(m, r) {
    // a small group for a table top: jug, bowls, a trencher board, a candlestick-less spread
    m.with(translate(range(r, -0.2, -0.1), 0, range(r, -0.05, 0.05)), () => jug(m, r, range(r, 0.2, 0.28)));
    // bowls side by side along x (they used to land inside one another, sharing their bottoms and rims)
    let bx = 0.01;
    for (let i = 0; i < 2 + Math.floor(r() * 2); i++) {
      const z = range(r, -0.15, 0.15), R = range(r, 0.06, 0.1);
      m.with(translate(bx + R, 0, z), () => bowl(m, r, R)); bx += 2 * R + 0.01;
    }
    m.tinted(woodTint(r), () => m.box('wood', [range(r, -0.45, -0.3), 0.01, 0.05], [0.26, 0.02, 0.18], { bevel: 0.004, noBottom: true }));
    return none(m);
  },
};

// ---------- lighting fixtures (meshes + emitters only) ----------
export const candlestick: PropKind = {
  name: 'candlestick', placement: 'floor', blocksNav: false,
  build(m, r) {
    // a turned brass baluster stick (style guide: brass pairs); one in four is the old iron pricket
    const H = range(r, 0.22, 0.34), emit: Emitter[] = [], brass = r() < 0.75;
    m.tinted(brass ? jitterTint(r, [0.95, 0.7, 0.36], 0.05) : IRON, () => m.lathe(brass ? 'brass' : 'iron', [[0, 0], [0.065, 0], [0.068, 0.012], [0.04, 0.025], [0.022, 0.04], [0.014, H * 0.3], [0.024, H * 0.42], [0.013, H * 0.55], [0.012, H - 0.03], [0.022, H - 0.02], [0.045, H - 0.008], [0.045, H + 0.005], [0, H + 0.005]], 8));
    candle(m, r, [0, H + 0.005, 0], range(r, 0.12, 0.2), 0.012, emit, 0.8);
    return { colliders: [hull(m)], emitters: emit };
  },
};

export const sconce: PropKind = {
  name: 'sconce', placement: 'wall', mount: 1.75, blocksNav: false,
  build(m, r) {
    const out = range(r, 0.14, 0.2), emit: Emitter[] = [];
    m.tinted(IRON, () => {
      m.box('iron', [0, 0, 0.006], [0.07, 0.22, 0.012], { bevel: 0.003 });
      m.tube('iron', [[0, -0.07, 0.01], [0, -0.04, out * 0.7], [0, 0.02, out]], 0.009, 5);
      m.tube('iron', Array.from({ length: 9 }, (_, i) => { const a = (i / 8) * Math.PI * 2; return [Math.cos(a) * 0.035, 0.02, out + Math.sin(a) * 0.035] as V3; }), 0.007, 4, [false, false]);
    });
    // torch: tapered handle with a pitch-soaked wrap
    const tilt = rotX(0.25);
    m.with(compose(translate(0, 0.02, out), tilt), () => {
      m.tinted(jitterTint(r, WOOD.dark), () => m.tube('wood', [[0, -0.18, 0], [0, 0.18, 0]], [0.016, 0.024], 6));
      m.tinted([0.06, 0.045, 0.035], () => m.lathe('straw', [[0.028, 0.14], [0.04, 0.18], [0.04, 0.25], [0.02, 0.28], [0, 0.285]], 8));
      flame(m, 'torch', [0, 0.255, 0], 0.24);
    });
    emit.push({ kind: 'torch', position: [0, 0.55, out + 0.2], colour: [1, 0.96, 0.92], intensity: 3, flicker: 0.25 });
    return { colliders: [hull(m)], emitters: emit };
  },
};

export const chandelier: PropKind = {
  name: 'chandelier', placement: 'ceiling', blocksNav: false,
  build(m, r) {
    const R = range(r, 0.4, 0.6), drop = range(r, 0.9, 1.4), n = 6 + 2 * Math.floor(r() * 3), emit: Emitter[] = [];
    const y = -drop;
    m.tinted(IRON, () => {
      m.tube('iron', Array.from({ length: 25 }, (_, i) => { const a = (i / 24) * Math.PI * 2; return [Math.cos(a) * R, y, Math.sin(a) * R] as V3; }), 0.014, 5, [false, false]);
      for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2 + 0.3; m.tube('iron', [[Math.cos(a) * R, y, Math.sin(a) * R], [0, y + 0.45, 0]], 0.005, 4); }
      m.tube('iron', [[0, y + 0.45, 0], [0, 0, 0]], 0.006, 4);
      m.lathe('iron', [[0, -0.02], [0.06, 0], [0.06, 0.005], [0, 0.005]], 8);
    });
    const cs: Emitter[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const at: V3 = [Math.cos(a) * R, y + 0.014, Math.sin(a) * R];
      m.tinted(IRON, () => m.with(translate(at[0], at[1], at[2]), () => m.lathe('iron', [[0, 0], [0.035, 0.005], [0.035, 0.015], [0, 0.015]], 8)));
      candle(m, r, [at[0], at[1] + 0.015, at[2]], range(r, 0.08, 0.16), 0.014, cs, 0.5);
    }
    // one light for the whole ring keeps the light count down
    emit.push({ kind: 'candle', position: [0, y + 0.2, 0], colour: FLAME, intensity: cs.reduce((s, e) => s + e.intensity, 0), flicker: 0.08 });
    return { colliders: [hull(m)], emitters: emit };
  },
};

// ---------- armoury ----------
export const weaponRack: PropKind = {
  name: 'weapon-rack', placement: 'floor', blocksNav: true,
  build(m, r) {
    const W = range(r, 1.1, 1.6), H = range(r, 1.5, 1.8), n = 3 + Math.floor(r() * 4);
    m.tinted(woodTint(r), () => {
      for (const sx of [-1, 1]) {
        m.box('wood', [sx * W / 2, H / 2, -0.1], [0.07, H, 0.07], { bevel: 0.008, grain: 1, noBottom: true });
        m.box('wood', [sx * W / 2, 0.04, 0], [0.09, 0.08, 0.5], { bevel: 0.01, grain: 2, noBottom: true });
      }
      m.box('wood', [0, H - 0.25, -0.1], [W + 0.05, 0.07, 0.06], { bevel: 0.008 }); // ends inside the posts
      m.box('wood', [0, 0.12, 0.08], [W, 0.06, 0.12], { bevel: 0.008 });
    });
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1) - 0.5) * (W - 0.25), len = range(r, 1.8, 2.3), lean = range(r, 0.05, 0.1);
      const top: V3 = [x + range(r, -0.03, 0.03), Math.cos(lean) * len, 0.08 - Math.sin(lean) * len];
      m.tinted(woodTint(r), () => m.tube('wood', [[x, 0.12, 0.1], top], 0.016, 6));
      const d = v3dir([x, 0.12, 0.1], top);
      m.tinted(IRON, () => m.with(compose(translate(top[0], top[1], top[2]), rotX(-Math.atan2(d[2], d[1]))), () => m.lathe('iron', [[0.018, -0.06], [0.02, 0], [0.03, 0.03], [0, 0.24]], 6)));
    }
    return none(m);
  },
};

export const armourStand: PropKind = {
  name: 'armour-stand', placement: 'floor', blocksNav: true,
  build(m, r) {
    const H = range(r, 1.45, 1.6);
    m.tinted(woodTint(r), () => {
      for (const a of [0, Math.PI / 2]) m.with(rotY(a + range(r, -0.1, 0.1)), () => m.box('wood', [0, 0.04, 0], [0.6, 0.08, 0.08], { bevel: 0.01, noBottom: true }));
      m.box('wood', [0, H / 2, 0], [0.06, H, 0.06], { bevel: 0.008, grain: 1, noBottom: true });
      m.box('wood', [0, H - 0.08, 0], [0.48, 0.06, 0.06], { bevel: 0.01 });
      m.with(translate(0, H, 0), () => m.lathe('wood', [[0.03, 0], [0.09, 0.08], [0.1, 0.16], [0.07, 0.24], [0, 0.27]], 10));
    });
    // a mail shirt on the cross bar: a slumped sheet in iron
    m.tinted([0.7, 0.7, 0.72], () => m.sheet('iron', (s, t) => {
      const th = s * Math.PI * 2, y = H - 0.05 - t * 0.75;
      const rr = (0.17 + 0.04 * Math.sin(t * Math.PI)) * (1 + 0.04 * Math.sin(th * 5 + t * 6));
      return [Math.cos(th) * rr * (t < 0.15 ? 1.45 : 1.15), y, Math.sin(th) * rr * 0.72];
    }, 16, 6, [1.2, 0.75], true));
    return none(m);
  },
};

// ---------- chapel and study ----------
export const lectern: PropKind = {
  name: 'lectern', placement: 'floor', blocksNav: true,
  build(m, r) {
    const H = range(r, 1.05, 1.2);
    m.tinted(woodTint(r), () => {
      m.box('wood', [0, 0.05, 0], [0.5, 0.1, 0.45], { bevel: 0.015, noBottom: true });
      m.with(translate(0, 0.1, 0), () => m.lathe('wood', [[0.07, 0], [0.05, 0.1], [0.045, H * 0.5], [0.06, H * 0.55], [0.045, H * 0.6], [0.05, H - 0.15]], 10));
      m.with(compose(translate(0, H - 0.02, 0), rotX(0.45)), () => m.box('wood', [0, 0, 0], [0.55, 0.03, 0.42], { bevel: 0.006 }));
    });
    m.with(compose(translate(0, H + 0.0, 0.0), rotX(0.45)), () => {
      for (const sx of [-1, 1]) m.tinted([0.95, 0.88, 0.72], () => m.sheet('wax', (s, t) => [sx * (0.01 + s * 0.2), 0.012 + Math.sin(s * Math.PI) * 0.015, (t - 0.5) * 0.28], 6, 2, [0.2, 0.28]));
      m.tinted(jitterTint(r, CLOTH.leather), () => m.box('cloth', [0, 0.004, 0], [0.44, 0.008, 0.3], { bevel: 0.002 }));
    });
    return none(m);
  },
};

export const altar: PropKind = {
  name: 'altar', placement: 'floor', blocksNav: true,
  build(m, r) {
    const W = range(r, 1.2, 2.0), D = range(r, 0.6, 0.8), H = 1.0, emit: Emitter[] = [];
    m.tinted(woodTint(r), () => m.box('wood', [0, H / 2, 0], [W, H, D], { bevel: 0.01, grain: 0 }));
    m.tinted(jitterTint(r, CLOTH.linen), () => m.sheet('cloth', (s, t) => {
      const x = (s - 0.5) * (W + 0.02), z = (t - 0.5) * (D + 0.5), over = Math.max(0, Math.abs(z) - D / 2);
      return [x, H + 0.003 - over * 1.3, Math.sign(z) * Math.min(Math.abs(z), D / 2 + 0.008)];
    }, 8, 10, [W, D + 0.5]));
    m.tinted(jitterTint(r, CLOTH.madder), () => m.sheet('cloth', (s, t) => [(s - 0.5) * W * 0.8, H - t * (H - 0.08), D / 2 + 0.02 + Math.sin(s * 25) * 0.006], 10, 3, [W * 0.8, H])); // frontal clear of the altar cloth's fall
    for (const sx of [-1, 1]) m.with(translate(sx * W * 0.32, H, -D * 0.2), () => {
      m.tinted(IRON, () => m.lathe('iron', [[0, 0], [0.08, 0], [0.02, 0.04], [0.014, 0.4], [0.05, 0.42], [0, 0.42]], 10));
      candle(m, r, [0, 0.42, 0], 0.28, 0.022, emit, 1);
    });
    m.tinted([0.35, 0.3, 0.2], () => m.with(translate(0, H, -D * 0.25), () => { m.box('iron', [0, 0.25, 0], [0.04, 0.5, 0.03]); m.box('iron', [0, 0.36, 0], [0.26, 0.04, 0.03]); }));
    return { colliders: [hull(m)], emitters: emit };
  },
};

export const bookStack: PropKind = {
  name: 'book-stack', placement: 'floor', blocksNav: false,
  build(m, r) {
    let y = 0;
    for (let i = 0; i < 2 + Math.floor(r() * 4); i++) {
      const t = range(r, 0.04, 0.08);
      m.with(compose(translate(range(r, -0.02, 0.02), y, range(r, -0.02, 0.02)), rotY(range(r, -0.4, 0.4))), () => book(m, r, range(r, 0.22, 0.34), range(r, 0.16, 0.26), t));
      y += t;
    }
    return none(m);
  },
};

// ---------- textiles ----------
/** Coarse woven pattern for tapestries and rugs, as vertex colours: border, field, lozenges. */
function pattern(r: Rng) {
  const field = jitterTint(r, pick(r, [CLOTH.madder, CLOTH.woad, CLOTH.green])), border = jitterTint(r, pick(r, [CLOTH.weld, CLOTH.black, CLOTH.linen]));
  const motif = jitterTint(r, pick(r, [CLOTH.weld, CLOTH.linen, CLOTH.madder])), k = 2 + Math.floor(r() * 3);
  return (s: number, t: number): RGB => {
    const e = Math.min(s, 1 - s, t, 1 - t);
    if (e < 0.06) return border;
    const u = (s * k) % 1, v = (t * k) % 1;
    return Math.abs(u - 0.5) + Math.abs(v - 0.5) < 0.22 ? motif : field;
  };
}

function patterned(m: PropMesh, r: Rng, f: (s: number, t: number) => V3, nu: number, nv: number, size: [number, number], flip = false) {
  const col = pattern(r);
  // split into cells so each cell carries its own colour
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const s0 = i / nu, t0 = j / nv;
    m.tinted(col(s0 + 0.5 / nu, t0 + 0.5 / nv), () => m.sheet('cloth', (s, t) => f(s0 + s / nu, t0 + t / nv), 1, 1, [size[0] / nu, size[1] / nv], flip));
  }
}

export const tapestry: PropKind = {
  name: 'tapestry', placement: 'wall', mount: 3.0, blocksNav: false,
  build(m, r) {
    const W = range(r, 1.6, 3.2), H = range(r, 1.4, 2.2), ph = r() * 6;
    m.tinted(jitterTint(r, WOOD.dark), () => m.tube('wood', [[-W / 2 - 0.08, 0, 0.05], [W / 2 + 0.08, 0, 0.05]], 0.022, 6));
    patterned(m, r, (s, t) => [(s - 0.5) * W, -0.03 - t * H + Math.sin(s * 3 + ph) * 0.01, 0.035 + Math.sin(s * Math.PI * 9 + ph) * 0.012 * (1 - t * 0.6) + t * 0.01], 18, 10, [W, H]);
    return { colliders: [hull(m)], emitters: [] };
  },
};

// ---------- fuel and floor litter ----------
export const firewood: PropKind = {
  name: 'firewood', placement: 'floor', blocksNav: true,
  build(m, r) {
    const rows = 2 + Math.floor(r() * 3), L = range(r, 0.5, 0.8), R = 0.055;
    for (let row = 0; row < rows; row++) {
      const n = rows - row + 2;
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * R * 2.05 + range(r, -0.01, 0.01), y = R + row * R * 1.75, rr = R * range(r, 0.8, 1.1);
        m.tinted(jitterTint(r, [0.55, 0.5, 0.44], 0.15), () => m.tube('wood', [[x, y, -L / 2 + range(r, -0.04, 0.04)], [x + range(r, -0.02, 0.02), y, L / 2 + range(r, -0.04, 0.04)]], rr, 6));
      }
    }
    return none(m);
  },
};

export const strawHeap: PropKind = {
  name: 'straw-heap', placement: 'floor', blocksNav: false,
  build(m, r) {
    const W = range(r, 1.0, 2.0), L = range(r, 0.8, 1.6), H = range(r, 0.15, 0.35), ph = r() * 6;
    m.tinted(jitterTint(r, [1, 1, 1], 0.1), () => m.sheet('straw', (s, t) => {
      const dx = (s - 0.5) * 2, dz = (t - 0.5) * 2, d = Math.min(1, Math.hypot(dx, dz));
      const h = H * Math.pow(Math.cos(d * Math.PI / 2), 1.5) * (1 + 0.25 * Math.sin(s * 11 + ph) * Math.sin(t * 9 + ph));
      const k = 1 + 0.15 * Math.sin(Math.atan2(dz, dx) * 3 + ph);
      return [dx * W / 2 * k, 0.005 + h, dz * L / 2 * k];
    }, 12, 12, [W, L]));
    return none(m);
  },
};

export const KIT: readonly PropKind[] = [
  trestleTable, bench, stool, chair, throne, bed, strawPallet,
  chest, cupboard, shelf, barrel, crate, sack, bucket,
  cauldron, tableware, candlestick, sconce, chandelier,
  weaponRack, armourStand, lectern, altar, bookStack,
  tapestry, firewood, strawHeap,
  ...PERIOD, ...MEDIEVAL,
];
export const KIND = Object.fromEntries(KIT.map((k) => [k.name, k])) as Record<string, PropKind>;

export interface Prop { kind: PropKind; seed: number; mesh: PropMesh; meta: PropMeta; bounds: { min: V3; max: V3 } }

/** Build one prop. Same (kind, seed) always gives the same triangles. */
export function makeProp(kind: PropKind | string, seed = 0): Prop {
  const k = typeof kind === 'string' ? KIND[kind] : kind;
  if (!k) throw new Error(`unknown prop kind ${String(kind)}`);
  const mesh = new PropMesh();
  const meta = k.build(mesh, mulberry32(hashSeed(`prop:${k.name}:${seed}`)), seed);
  return { kind: k, seed, mesh, meta, bounds: mesh.bounds() };
}

/** Floor footprint (x, z rectangle in local space) used for navmesh obstacles and placement. */
export function footprint(p: Prop): [number, number, number, number] {
  return [p.bounds.min[0], p.bounds.min[2], p.bounds.max[0], p.bounds.max[2]];
}
