// 19th-century furnishing of the medieval rooms (docs: castle-plan/furnishing/style-guide.md): the
// castle as a Gothic Revival / Victorian / Scottish Baronial family would have lived in it. Same contract
// as kit.ts: pure generators of (mesh, rng, variant), local frame on the floor (or wall) at the centre of
// the footprint, front +z, metres. Detail goes into textures (the paint atlas: carpets, canvases, pelts)
// and vertex tints rather than triangles.
import { PropMesh, translate, rotX, rotY, rotZ, compose, ATLAS, type RGB, type V3 } from './geom';
import { range, pick, type Rng } from '../core/rng';
import { IRON, FLAME, jitterTint, boxCollider, hull, none, candle, type PropKind, type Emitter } from './parts';

// ---------- period palettes (multipliers over the shared textures, style guide §2) ----------
export const PWOOD: Record<string, RGB> = {
  oak: [0.8, 0.58, 0.38], bog: [0.3, 0.24, 0.19], mahogany: [0.72, 0.34, 0.2], walnut: [0.62, 0.44, 0.3], deal: [1.15, 1.05, 0.88],
};
export const PCLOTH: Record<string, RGB> = {
  crimson: [0.42, 0.05, 0.06], green: [0.07, 0.2, 0.12], blue: [0.08, 0.12, 0.3], gold: [0.6, 0.45, 0.16],
  oxblood: [0.3, 0.08, 0.05], blackLeather: [0.08, 0.07, 0.06], white: [0.86, 0.84, 0.78], ivory: [0.78, 0.72, 0.58],
};
export const METAL: Record<string, RGB> = {
  brass: [0.95, 0.7, 0.36], gilt: [0.85, 0.62, 0.26], copper: [0.9, 0.46, 0.26], steel: [0.66, 0.67, 0.7], mirror: [0.5, 0.52, 0.55],
};
export const STONE: Record<string, RGB> = { lime: [1, 0.98, 0.94], grey: [0.86, 0.85, 0.82], sand: [1.02, 0.86, 0.72], marble: [0.4, 0.38, 0.38] }; // warm greys, never blue
/** One dominant textile per room (style guide §2): the variant seed picks it, v % 3. */
export const TONES: readonly RGB[] = [PCLOTH.crimson, PCLOTH.green, PCLOTH.blue];
/** Upholstery: velvet in the room's tone, or oxblood leather for tone 2 (libraries and studies). */
export const UPHOLSTERY: readonly RGB[] = [PCLOTH.crimson, PCLOTH.green, PCLOTH.oxblood];
export const tone = (v: number) => ((v % 3) + 3) % 3;
const SOOT: RGB = [0.07, 0.06, 0.055];
const EMBER: RGB = [1.5, 1.07, 1.0]; // wax tint above 1 glows (render.ts): the ember bed

const turned = (m: PropMesh, mat: 'wood' | 'brass', h: number, r: number, seg = 8) =>
  m.lathe(mat, [[r, 0], [r * 0.65, h * 0.14], [r * 0.6, h * 0.3], [r * 1.05, h * 0.45], [r * 0.6, h * 0.62], [r * 0.6, h * 0.88], [r * 0.8, h]], seg);

/** A solid extruded along x from a convex polygon in (y, z), with flat normals. */
function prismX(m: PropMesh, mat: 'stone' | 'wood', poly: [number, number][], x0: number, x1: number) {
  const n = poly.length, P = (x: number, i: number): V3 => [x, poly[i][0], poly[i][1]];
  for (const [x, sx] of [[x0, -1], [x1, 1]] as const) for (let i = 1; i < n - 1; i++) m.tri(mat, [P(x, 0), P(x, i), P(x, i + 1)], [[sx, 0, 0], [sx, 0, 0], [sx, 0, 0]], [[poly[0][1], poly[0][0]], [poly[i][1], poly[i][0]], [poly[i + 1][1], poly[i + 1][0]]]);
  let cy = 0, cz = 0; for (const p of poly) { cy += p[0] / n; cz += p[1] / n; }
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n], dy = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dy, dz);
    let nn: V3 = [0, -dz / L, dy / L];
    if (nn[1] * ((a[0] + b[0]) / 2 - cy) + nn[2] * ((a[1] + b[1]) / 2 - cz) < 0) nn = [0, -nn[1], -nn[2]];
    m.quad(mat, P(x0, i), P(x1, i), P(x1, (i + 1) % n), P(x0, (i + 1) % n), nn, [x0, 0], [x1, 0], [x1, L], [x0, L]);
  }
}

/** A solid extruded along z from a polygon in (x, y) that is star-shaped from its first point. */
function prismZ(m: PropMesh, mat: 'stone' | 'wood', poly: [number, number][], z0: number, z1: number) {
  const n = poly.length, P = (z: number, i: number): V3 => [poly[i][0], poly[i][1], z];
  for (const [z, sz] of [[z0, -1], [z1, 1]] as const) for (let i = 1; i < n - 1; i++) m.tri(mat, [P(z, 0), P(z, i), P(z, i + 1)], [[0, 0, sz], [0, 0, sz], [0, 0, sz]], [[poly[0][0], poly[0][1]], [poly[i][0], poly[i][1]], [poly[i + 1][0], poly[i + 1][1]]]);
  let cx = 0, cy = 0; for (const p of poly) { cx += p[0] / n; cy += p[1] / n; }
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    let nn: V3 = [dy / L, -dx / L, 0];
    if (nn[0] * ((a[0] + b[0]) / 2 - cx) + nn[1] * ((a[1] + b[1]) / 2 - cy) < 0) nn = [-nn[0], -nn[1], 0];
    m.quad(mat, P(z0, i), P(z1, i), P(z1, (i + 1) % n), P(z0, (i + 1) % n), nn, [z0, 0], [z1, 0], [z1, L], [z0, L]);
  }
}

// ---------- the hearth ----------
/** Fire dogs, logs on them, a glowing ember bed and the flames; returns the top of the logs. */
function fire(m: PropMesh, r: Rng, w: number, z: number, big: boolean, dogs: RGB) {
  const s = big ? 1.35 : 1;
  m.tinted(EMBER, () => m.box('wax', [0, 0.012, z], [w * 0.45, 0.016, 0.18 * s], { noBottom: true }));
  for (const sx of [-1, 1]) m.with(translate(sx * w * 0.3, 0, z), () => {
    m.tinted(IRON, () => { m.box('iron', [0, 0.09 * s, -0.05], [0.025, 0.025, 0.42 * s]); m.box('iron', [0, 0.16 * s, 0.17 * s], [0.03, 0.32 * s, 0.03]); });
    m.tinted(dogs, () => m.with(translate(0, 0.32 * s, 0.17 * s), () => m.lathe(dogs === IRON ? 'iron' : 'brass', [[0.012, 0], [0.045 * s, 0.03], [0.05 * s, 0.07 * s], [0.02, 0.1 * s], [0.001, 0.16 * s]], 8)));
  });
  const logs = big ? 4 : 3;
  for (let i = 0; i < logs; i++) {
    // the bottom three side by side across the dogs (they lay inside one another along one line), one on top
    const y = i < 3 ? 0.12 * s + 0.05 : 0.24 * s, x = i < 3 ? (i - 1) * 0.11 * s : 0, rr = range(r, 0.045, 0.065) * s, lz = z + (i < 3 ? (i - 1) * 0.09 * s : 0);
    m.tinted(jitterTint(r, [0.28, 0.22, 0.17], 0.2), () => m.tube('wood', [[x + range(r, -0.07, -0.02) - w * 0.3, y, lz + range(r, -0.02, 0.02)], [x + w * 0.3 + i * 0.015, y + range(r, -0.02, 0.03), lz + range(r, -0.025, 0.025)]], rr, i < 3 ? 6 : 7));
    m.tinted(EMBER, () => m.tube('wax', [[x - w * 0.18, y - rr * 0.75, lz], [x + w * 0.18, y - rr * 0.75, lz]], rr * 0.35, 3, [false, false])); // glowing underside
  }
  const top = 0.32 * s;
  m.addFlame('hearth', [0, top - 0.06, z], 0.42 * s);
  for (const sx of [-1, 1]) m.addFlame('hearth', [sx * w * 0.14, top - 0.08, z + 0.02], 0.26 * s);
  return top;
}

/**
 * Chimneypiece for a family room: a carved stone surround (jambs on plinths, a frieze with sunk panels
 * and a four-centred opening, a moulded mantel shelf) standing on a hearth slab, a chimney breast above to
 * carry an overmantel mirror or portrait, and a sooty firebox with an iron fireback, fire dogs, logs,
 * embers, a brass fender and fire irons. Stands against the wall: it cuts nothing.
 */
export const chimneypiece: PropKind = {
  name: 'chimneypiece', placement: 'floor', blocksNav: true,
  build(m, r) {
    const W = range(r, 1.9, 2.3), H = range(r, 1.3, 1.45), D = 0.5, Wo = W * range(r, 0.5, 0.56), Ho = H * range(r, 0.66, 0.72), top = range(r, 2.85, 3.05);
    const zb = -0.48, zf = zb + D, jw = (W - Wo) / 2, st = pick(r, [STONE.lime, STONE.grey, STONE.sand, STONE.lime, STONE.marble]);
    const emit: Emitter[] = [];
    m.tinted(jitterTint(r, st, 0.05), () => {
      m.box('stone', [0, 0.04, zf + 0.22], [W + 0.25, 0.08, 0.48], { bevel: 0.01, noBottom: true });            // hearth slab
      for (const sx of [-1, 1]) {
        const x = sx * (Wo / 2 + jw / 2);
        m.box('stone', [x, 0.1, zb + D / 2 + 0.02], [jw + 0.05, 0.2, D + 0.04], { noBottom: true }); // plinth
        m.box('stone', [x, (Ho + 0.2) / 2, zb + D / 2], [jw, Ho - 0.2, D], { bevel: 0.015 });                       // jamb
        m.box('stone', [x + sx * 0.005, Ho - 0.03, zb + D / 2 + 0.0175], [jw + 0.04, 0.08, D + 0.025]); // capital, its back 5 mm off the jamb's
      }
      m.box('stone', [0, (Ho + H - 0.1) / 2, zb + D / 2], [W, H - 0.1 - Ho, D], { bevel: 0.012 });                 // frieze
      for (const sx of [-1, 1]) { // four-centred (Tudor) arch: a spandrel in each top corner of the opening
        const x0 = sx * (Wo / 2 + 0.01), rise = Ho * 0.22, pts: [number, number][] = [[x0, Ho]]; // starts 1 cm inside the jamb
        for (let i = 0; i <= 8; i++) { const a = (i / 8) * Math.PI / 2; pts.push([x0 - sx * (Wo / 2) * (1 - Math.cos(a)) * 0.98, Ho - rise * (1 - Math.sin(a)) - 0.001]); }
        m.with(translate(0, 0.006, 0), () => prismZ(m, 'stone', sx > 0 ? pts : [pts[0], ...pts.slice(1).reverse()], zb + 0.025, zf - 0.005)); // top 6 mm up inside the frieze, back off the soffit's
      }
      m.box('stone', [0, H - 0.075, zf - 0.21], [W + 0.08, 0.05, 0.47]);                                            // bed mould
      m.box('stone', [0, H - 0.025, zf - 0.19], [W + 0.2, 0.06, 0.56], { bevel: 0.015 });                          // shelf
      m.box('stone', [0, (H + top - 0.005) / 2, zb + 0.15], [W - 0.12, top - H - 0.005, 0.3], { noBottom: true });                 // breast, its top inside the cornice
      m.box('stone', [0, top - 0.04, zb + 0.17], [W - 0.02, 0.08, 0.36]);                                           // cornice
    });
    // frieze panels and a carved boss, a shade darker
    m.tinted(jitterTint(r, [st[0] * 0.8, st[1] * 0.8, st[2] * 0.8], 0.04), () => {
      for (const sx of [-1, 1]) m.box('stone', [sx * W * 0.27, (Ho + H - 0.1) / 2, zf + 0.004], [W * 0.26, (H - 0.1 - Ho) * 0.6, 0.012]);
      m.with(compose(translate(0, (Ho + H - 0.1) / 2, zf), rotX(Math.PI / 2)), () => m.lathe('stone', [[0.09, 0], [0.085, 0.02], [0.05, 0.035], [0.001, 0.04]], 10));
    });
    // firebox: sooty back and splayed cheeks, iron fireback, then the fire
    const fz = zb + 0.17;
    m.tinted(SOOT, () => {
      m.box('stone', [0, Ho / 2, zb + 0.02], [Wo, Ho, 0.04]);
      for (const sx of [-1, 1]) m.with(compose(translate(sx * (Wo / 2 - 0.09), Ho / 2, zb + D / 2 - 0.01), rotY(sx * 0.35)), () => m.box('stone', [0, 0, 0], [0.04, Ho, D - 0.04]));
      m.box('stone', [0, Ho - 0.025, zb + D / 2], [Wo, 0.04, D - 0.04]); // soffit 5 mm under the frieze
      m.box('stone', [0, 0.085, zb + D / 2], [Wo, 0.01, D - 0.04]);
    });
    m.tinted(IRON, () => {
      m.box('iron', [0, Ho * 0.38, zb + 0.05], [Wo * 0.7, Ho * 0.62, 0.02]);
      m.with(compose(translate(0, Ho * 0.69, zb + 0.05), rotX(Math.PI / 2)), () => m.lathe('iron', [[Wo * 0.35, -0.008], [Wo * 0.35, 0.008]], 12, { capTop: true, capBottom: true })); // arched head, 2 mm thinner than the plate
    });
    m.with(translate(0, 0.09, 0), () => fire(m, r, Wo * 0.8, fz, false, r() < 0.7 ? METAL.brass : IRON));
    // brass fender round the hearth and a stand of fire irons
    const fender = jitterTint(r, METAL.brass, 0.05);
    m.tinted(fender, () => {
      const fx = Wo / 2 + 0.2, fzf = zf + 0.38;
      m.tube('brass', [[-fx, 0.13, zf + 0.02], [-fx, 0.13, fzf], [fx, 0.13, fzf], [fx, 0.13, zf + 0.02]], 0.014, 6);
      m.box('brass', [0, 0.05, fzf], [2 * fx, 0.1, 0.012], { noBottom: true });
      for (const sx of [-1, 1]) m.box('brass', [sx * fx, 0.05, (zf + fzf) / 2], [0.012, 0.1, fzf - zf], { noBottom: true });
      const ix = W / 2 + 0.05;
      m.with(translate(ix, 0.08, zf + 0.2), () => {
        m.lathe('brass', [[0.08, 0], [0.02, 0.03], [0.015, 0.6], [0.03, 0.62], [0.001, 0.66]], 8);
        for (const a of [-0.25, 0, 0.25]) m.tube('iron', [[Math.sin(a) * 0.03, 0.05 + a * 0.04, Math.cos(a) * 0.03], [Math.sin(a) * 0.06, 0.62, Math.cos(a) * 0.05]], 0.007, 4);
      });
    });
    emit.push({ kind: 'hearth', position: [0, 0.6, zf + 0.35], colour: FLAME, intensity: 2.2, flicker: 0.2 });
    const b = m.bounds();
    return { colliders: [boxCollider([b.min[0], 0, b.min[2]], [b.max[0], top, b.max[2]])], emitters: emit, mantel: { y: H + 0.005, z: zf - 0.19, w: W }, above: [0, H + 0.12, zb + 0.305] };
  },
};

/** Hall or kitchen hearth: a wide opening under a stone hood that slopes back to the wall, on clustered
 * shafts; big iron fire dogs and logs. */
export const hoodedHearth: PropKind = {
  name: 'hooded-hearth', placement: 'floor', blocksNav: true,
  build(m, r) {
    const W = range(r, 2.6, 3.0), Wo = W - 0.7, Ho = range(r, 1.45, 1.6), hood = 0.95, top = range(r, 3.1, 3.3), zb = -0.55, zf = zb + hood;
    const st = jitterTint(r, pick(r, [STONE.lime, STONE.grey, STONE.sand]), 0.05), emit: Emitter[] = [];
    m.tinted(st, () => {
      m.box('stone', [0, 0.04, zf + 0.25], [W + 0.3, 0.08, 0.5], { bevel: 0.01, noBottom: true });
      for (const sx of [-1, 1]) {
        const x = sx * (W / 2 - 0.17);
        m.box('stone', [x, 0.12, zf - 0.2], [0.36, 0.24, 0.4], { bevel: 0.015, noBottom: true });
        m.with(translate(x, 0.24, zf - 0.2), () => m.lathe('stone', [[0.13, 0], [0.12, 0.05], [0.11, 0.1], [0.11, Ho - 0.4], [0.13, Ho - 0.33], [0.18, Ho - 0.26], [0.18, Ho - 0.2]], 12));
        m.box('stone', [x, Ho / 2, zb + (hood - 0.4) / 2], [0.34, Ho, hood - 0.4], { bevel: 0.01 }); // cheek wall behind the shaft
      }
      m.box('stone', [0, Ho + 0.12, zb + hood / 2], [W, 0.24, hood], { bevel: 0.015 });               // lintel
      m.box('stone', [0, Ho + 0.27, zb + hood / 2 + 0.02], [W + 0.08, 0.07, hood + 0.04], { bevel: 0.015 }); // moulding
      prismX(m, 'stone', [[Ho + 0.3, zb], [Ho + 0.3, zf], [top, zb + 0.3], [top, zb]], -W / 2 + 0.05, W / 2 - 0.05); // the hood
      m.box('stone', [0, top + 0.04, zb + 0.16], [W - 0.05, 0.08, 0.34], { bevel: 0.015 });
    });
    m.tinted(SOOT, () => {
      m.box('stone', [0, Ho / 2, zb + 0.02], [Wo, Ho, 0.04]);
      m.box('stone', [0, Ho + 0.015, zb + hood / 2], [Wo, 0.04, hood - 0.04]); // soffit 5 mm under the lintel
      m.box('stone', [0, 0.085, zb + hood / 2], [Wo, 0.01, hood - 0.04]);
    });
    m.tinted(IRON, () => m.box('iron', [0, 0.085 + Ho * 0.35, zb + 0.05], [Wo * 0.55, Ho * 0.7, 0.025], { bevel: 0.008 })); // foot 5 mm into the hearth floor
    m.with(translate(0, 0.09, 0), () => fire(m, r, Wo * 0.75, zb + 0.4, true, IRON));
    emit.push({ kind: 'hearth', position: [0, 0.75, zf + 0.4], colour: FLAME, intensity: 3.5, flicker: 0.22 });
    const b = m.bounds();
    return { colliders: [boxCollider([b.min[0], 0, b.min[2]], [b.max[0], b.max[1], b.max[2]])], emitters: emit };
  },
};

// ---------- lights ----------
/** Brass candle sconce with a back plate (a mirror glass in a gilt rim one time in three): one or two
 * S-scroll arms with drip pans and candles. Rooms get these; torches stay in tunnels and cellars. */
export const candleSconce: PropKind = {
  name: 'candle-sconce', placement: 'wall', mount: 1.6, blocksNav: false,
  build(m, r) {
    const two = r() < 0.6, mirror = r() < 0.33, rx = range(r, 0.09, 0.12), ry = range(r, 0.15, 0.2), emit: Emitter[] = [];
    const metal = jitterTint(r, mirror ? METAL.gilt : METAL.brass, 0.05);
    const oval = (k: number, z: number) => (s: number, t: number): V3 => [Math.cos(s * Math.PI * 2) * rx * t * k, Math.sin(s * Math.PI * 2) * ry * t * k, z];
    m.tinted(mirror ? METAL.mirror : metal, () => m.sheet('brass', oval(1, 0.012), 12, 1, [rx * 2, ry * 2], true));
    m.tinted(metal, () => {
      m.tube('brass', Array.from({ length: 13 }, (_, i) => { const a = (i / 12) * Math.PI * 2; return [Math.cos(a) * rx, Math.sin(a) * ry, 0.014] as V3; }), 0.009, 4, [false, false]);
      m.with(translate(0, ry + 0.02, 0.03), () => m.lathe('brass', [[0.001, 0], [0.025, 0.01], [0.012, 0.04], [0.001, 0.06]], 8));
    });
    const cs: Emitter[] = [];
    for (const sx of two ? [-1, 1] : [0]) {
      const ex = sx * 0.13, ez = 0.17;
      m.tinted(metal, () => {
        m.tube('brass', [[sx * 0.02, -ry * 0.6, 0.02], [sx * 0.05, -ry * 0.85, 0.08], [ex * 0.8, -ry * 0.55, ez * 0.8], [ex, -0.02, ez]], 0.008, 4);
        m.with(translate(ex, -0.02, ez), () => m.lathe('brass', [[0.001, -0.01], [0.05, 0], [0.052, 0.008], [0.016, 0.01], [0.018, 0.05], [0.001, 0.05]], 6));
      });
      candle(m, r, [ex, 0.03, ez], range(r, 0.13, 0.18), 0.012, cs, 0.8);
    }
    emit.push({ kind: 'candle', position: [0, 0.25, 0.22], colour: FLAME, intensity: cs.reduce((s, e) => s + e.intensity, 0), flicker: 0.12 });
    return { colliders: [hull(m)], emitters: emit };
  },
};

/** Table oil lamp (paraffin, c. 1860): brass foot and column, a glass font, the burner and an opal
 * globe that glows, a clear chimney above it. A steady light. */
export const oilLamp: PropKind = {
  name: 'oil-lamp', placement: 'floor', blocksNav: false,
  build(m, r) {
    const h = range(r, 0.34, 0.42), emit: Emitter[] = [], metal = jitterTint(r, METAL.brass, 0.06);
    m.tinted(metal, () => m.lathe('brass', [[0, 0], [0.075, 0], [0.078, 0.012], [0.05, 0.03], [0.045, 0.05], [0.02, 0.07], [0.018, h * 0.45], [0.03, h * 0.5], [0.02, h * 0.55], [0.022, h * 0.6], [0.001, h * 0.6]], 10));
    m.tinted(pick(r, [[0.55, 0.12, 0.1], [0.12, 0.25, 0.15], [0.8, 0.78, 0.72]] as RGB[]), () => m.with(translate(0, h * 0.6, 0), () => m.lathe('ceramic', [[0.022, 0], [0.07, 0.03], [0.08, 0.07], [0.06, 0.11], [0.025, 0.13]], 10))); // font
    m.tinted(metal, () => m.with(translate(0, h * 0.6 + 0.13, 0), () => m.lathe('brass', [[0.025, 0], [0.032, 0.02], [0.03, 0.045], [0.045, 0.05], [0.045, 0.06]], 10)));
    const gy = h * 0.6 + 0.19;
    m.tinted([1.75, 1.6, 1.35], () => m.with(translate(0, gy, 0), () => m.lathe('wax', [[0.04, 0], [0.09, 0.04], [0.105, 0.09], [0.09, 0.14], [0.045, 0.17], [0.042, 0.175]], 12)));
    m.tinted([1.25, 1.22, 1.15], () => m.with(translate(0, gy + 0.17, 0), () => m.lathe('wax', [[0.022, 0], [0.024, 0.06], [0.02, 0.14]], 10)));
    m.addFlame('lantern', [0, gy + 0.03, 0], 0.05);
    emit.push({ kind: 'lantern', position: [0, gy + 0.09, 0], colour: FLAME, intensity: 1.3, flicker: 0.04 });
    return { colliders: [hull(m)], emitters: emit };
  },
};

/** Brass candelabrum, three or five lights on scrolled arms. One light for all its candles. */
export const candelabrum: PropKind = {
  name: 'candelabrum', placement: 'floor', blocksNav: false,
  build(m, r) {
    const five = r() < 0.3, h = range(r, 0.3, 0.4), R = range(r, 0.14, 0.18), metal = jitterTint(r, METAL.brass, 0.05), cs: Emitter[] = [];
    m.tinted(metal, () => {
      m.lathe('brass', [[0, 0], [0.09, 0], [0.09, 0.012], [0.04, 0.03], [0.022, 0.06], [0.016, h * 0.4], [0.03, h * 0.45], [0.016, h * 0.5], [0.016, h], [0.001, h]], 8);
    });
    const arms = five ? 4 : 2;
    for (let i = 0; i < arms; i++) {
      const a = (i / arms) * Math.PI * 2 + (five ? Math.PI / 4 : 0), c = Math.cos(a), s = Math.sin(a);
      m.tinted(metal, () => {
        m.tube('brass', [[0, h * 0.72, 0], [c * R * 0.5, h * 0.66, s * R * 0.5], [c * R * 0.95, h * 0.78, s * R * 0.95], [c * R, h * 0.95, s * R]], 0.008, 4, [false, false]);
        m.with(translate(c * R, h * 0.95, s * R), () => m.lathe('brass', [[0.001, 0], [0.035, 0.005], [0.013, 0.014], [0.014, 0.04], [0.001, 0.04]], 6));
      });
      candle(m, r, [c * R, h * 0.95 + 0.04, s * R], range(r, 0.14, 0.2), 0.011, cs, 0.6);
    }
    m.tinted(metal, () => m.with(translate(0, h, 0), () => m.lathe('brass', [[0.001, 0], [0.035, 0.005], [0.013, 0.014], [0.014, 0.04], [0.001, 0.04]], 6)));
    candle(m, r, [0, h + 0.04, 0], range(r, 0.16, 0.22), 0.012, cs, 0.6);
    return { colliders: [hull(m)], emitters: [{ kind: 'candle', position: [0, h + 0.3, 0], colour: FLAME, intensity: cs.reduce((s, e) => s + e.intensity, 0), flicker: 0.1 }] };
  },
};

// ---------- pictures ----------
/** Gilt frame (rails with a moulded slip and corner bosses) round a rectangle w × h centred on the origin. */
function giltFrame(m: PropMesh, r: Rng, w: number, h: number, rail: number, depth: number) {
  m.tinted(jitterTint(r, METAL.gilt, 0.06), () => {
    for (const sy of [-1, 1]) m.box('brass', [0, sy * (h / 2 + rail / 2), depth / 2], [w + 2 * rail, rail, depth], { bevel: rail * 0.25 });
    for (const sx of [-1, 1]) m.box('brass', [sx * (w / 2 + rail / 2), 0, depth / 2], [rail, h, depth], { bevel: rail * 0.25 });
    // sight-edge mouldings lap 5 mm over the canvas, so their inner faces never lie on the rails' inner faces
    for (const sy of [-1, 1]) m.box('brass', [0, sy * (h / 2 + 0.005), depth * 0.55], [w + 0.01, 0.02, depth * 0.5]);
    for (const sx of [-1, 1]) m.box('brass', [sx * (w / 2 + 0.005), 0, depth * 0.55], [0.02, h, depth * 0.5]);
    if (rail > 0.08) for (const sx of [-1, 1]) for (const sy of [-1, 1]) m.with(compose(translate(sx * (w / 2 + rail / 2), sy * (h / 2 + rail / 2), depth), rotX(Math.PI / 2)), () => m.lathe('brass', [[rail * 0.45, 0], [rail * 0.35, 0.015], [0.001, 0.025]], 8));
  });
}

/** Oil painting in a gilt frame, hung from a picture rail on two cords and tilted forward (3-5 deg).
 * The variant picks the canvas (v % 6: the four sitters, then the two landscapes) and the size (v % 3:
 * 0.55 × 0.7, 0.8 × 1.05, 1.05 × 1.4 m), so consecutive variants are all different pictures. */
export const portrait: PropKind = {
  name: 'portrait', placement: 'wall', mount: 2.1, blocksNav: false,
  build(m, r, v) {
    const c = ((v % 6) + 6) % 6, size = [[0.55, 0.7], [0.8, 1.05], [1.05, 1.4]][c % 3], scene = c >= ATLAS.portraits.length;
    const w = scene ? size[1] : size[0], h = scene ? size[0] : size[1], rail = 0.06 + w * 0.06, depth = 0.05 + w * 0.02, tilt = range(r, 0.05, 0.085);
    const rect = scene ? ATLAS.scenes[c - ATLAS.portraits.length] : ATLAS.portraits[c];
    const H = h + 2 * rail;
    m.with(compose(translate(0, -H / 2, 0), compose(rotX(tilt), translate(0, H / 2, 0))), () => {
      giltFrame(m, r, w, h, rail, depth);
      m.tinted(jitterTint(r, [1, 1, 1], 0.05), () => m.atlasSheet((s, t) => [(s - 0.5) * w, (t - 0.5) * h, depth * 0.35], 1, 1, rect));
      m.tinted([0.1, 0.08, 0.06], () => m.box('wood', [0, 0, 0.01], [w + rail, h + rail, 0.016], { noBottom: true })); // stretcher behind, its face 3 mm or more behind the canvas
    });
    // cords from the frame's top corners up to a rosette on the rail
    const topZ = Math.sin(tilt) * H + depth * 0.5, topY = H / 2;
    m.tinted(METAL.gilt, () => {
      for (const sx of [-1, 1]) m.tube('brass', [[sx * w * 0.35, topY - 0.02, topZ * 0.8], [0, topY + 0.35, 0.012]], 0.004, 4, [false, false]);
      m.with(compose(translate(0, topY + 0.35, 0), rotX(Math.PI / 2)), () => m.lathe('brass', [[0.025, 0], [0.02, 0.012], [0.001, 0.02]], 8));
    });
    return { colliders: [hull(m)], emitters: [] };
  },
};

/** Overmantel mirror: an arched gilt frame (two mouldings and a cresting finial) round a foxed glass. */
export const overmantelMirror: PropKind = {
  name: 'overmantel-mirror', placement: 'wall', mount: 1.55, blocksNav: false,
  build(m, r) {
    const w = range(r, 0.8, 1.05), hs = range(r, 0.3, 0.45), rise = w / 2, frame = jitterTint(r, METAL.gilt, 0.05);
    // outline: bottom edge, up the sides to the springing, a semicircular head; local y from 0 (bottom)
    const outline = (k: number): V3[] => {
      const hw = w / 2 + k, pts: V3[] = [[-hw, -k, 0], [hw, -k, 0], [hw, hs, 0]];
      for (let i = 1; i < 12; i++) { const a = (i / 12) * Math.PI; pts.push([Math.cos(a) * hw, hs + Math.sin(a) * (rise + k), 0]); }
      pts.push([-hw, hs, 0], [-hw, -k, 0]);
      return pts;
    };
    m.tinted(METAL.mirror, () => m.sheet('brass', (s, t) => { const x = (s - 0.5) * w, top = hs + Math.sqrt(Math.max(0, (w / 2) ** 2 - x * x)); return [x, t * top, 0.02]; }, 10, 2, [w, hs + rise]));
    m.tinted(frame, () => {
      for (const [k, rr, z] of [[0.045, 0.04, 0.04], [0.0, 0.016, 0.05]] as const) m.with(translate(0, 0, z), () => m.tube('brass', outline(k), rr, 4, [false, false]));
      m.with(translate(0, hs + rise + 0.07, 0.04), () => m.lathe('brass', [[0.001, 0], [0.04, 0.03], [0.02, 0.07], [0.035, 0.1], [0.001, 0.16]], 10));
      m.box('brass', [0, -0.07, 0.035], [w + 0.14, 0.06, 0.07], { bevel: 0.015 });
    });
    return { colliders: [hull(m)], emitters: [] };
  },
};

// ---------- beds ----------
/** Victorian tester bed: turned foot posts, a moulded cornice with a pleated valance and gold fringe, a
 * pleated headcloth, four curtains tied back at the posts, a valance skirt, white linen, two pillows, a
 * bolster and a counterpane. Hangings in the room's tone (v % 3: crimson, green, blue). */
export const testerBed: PropKind = {
  name: 'four-poster', placement: 'floor', blocksNav: true,
  build(m, r, v) {
    const L = range(r, 2.05, 2.2), W = range(r, 1.45, 1.65), H = range(r, 2.35, 2.55), top = 0.62;
    const wood = jitterTint(r, pick(r, [PWOOD.mahogany, PWOOD.mahogany, PWOOD.oak, PWOOD.walnut]), 0.06), hang = jitterTint(r, TONES[tone(v)], 0.06), gold = jitterTint(r, PCLOTH.gold, 0.05);
    m.tinted(wood, () => {
      for (const sx of [-1, 1]) m.box('wood', [sx * (W / 2 - 0.04), 0.3, 0], [0.06, 0.2, L - 0.1], { grain: 2 });
      m.box('wood', [0, 0.3, L / 2 - 0.05], [W - 0.08, 0.2, 0.05]);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.with(translate(sx * (W / 2 - 0.05), 0, sz * (L / 2 - 0.05)), () => (sz > 0 ? turned(m, 'wood', H - 0.12, 0.05, 10) : m.box('wood', [0, (H - 0.12) / 2, 0], [0.08, H - 0.12, 0.08], { bevel: 0.01, noBottom: true })));
      for (const sx of [-1, 1]) m.box('wood', [sx * (W / 2 - 0.02), H - 0.06, 0], [0.08, 0.14, L + 0.04], { bevel: 0.015, grain: 2 }); // cornice
      for (const sz of [-1, 1]) m.box('wood', [0, H - 0.06, sz * (L / 2 + 0.01)], [W + 0.05, 0.14, 0.08], { bevel: 0.015 }); // 5 mm past the side cornices
      m.box('wood', [0, 1.05, -L / 2 + 0.035], [W - 0.1, 0.55, 0.04], { bevel: 0.01, grain: 1 }); // headboard, 5 mm in from the posts' backs
    });
    m.tinted(PCLOTH.white, () => {
      m.box('cloth', [0, 0.47, 0.02], [W - 0.12, 0.2, L - 0.12], { bevel: 0.06 });                                   // mattress
      for (const sx of [-1, 1]) m.with(compose(translate(sx * W * 0.22, top + 0.1, -L / 2 + 0.3), rotX(-0.35)), () => m.lathe('cloth', [[0.001, -0.07], [0.12, -0.06], [0.17, -0.02], [0.18, 0.02], [0.13, 0.06], [0.001, 0.07]], 8, { wobble: (th) => 1 + 0.25 * Math.cos(th * 2) }));
      m.tube('cloth', [[-W / 2 + 0.1, top + 0.02, -L / 2 + 0.55], [W / 2 - 0.1, top + 0.02, -L / 2 + 0.55]], 0.09, 10);           // bolster
    });
    // counterpane over the bed, falling over the sides and foot; a turned-down sheet at the head
    const bw = W - 0.06, z0 = -L / 2 + 0.7, cover = jitterTint(r, r() < 0.5 ? PCLOTH.ivory : [hang[0] * 1.2, hang[1] * 1.2, hang[2] * 1.2], 0.04);
    m.tinted(cover, () => m.sheet('cloth', (s, t) => {
      const x = (s - 0.5) * (bw + 0.5), edge = Math.max(0, Math.abs(x) - bw / 2);
      return [Math.sign(x) * Math.min(Math.abs(x), bw / 2 + 0.015), top - 0.03 + 0.012 * Math.sin(s * 13 + t * 7) - edge * 1.6, z0 + t * (L / 2 - z0 - 0.04)];
    }, 8, 5, [bw, L]));
    m.tinted(cover, () => m.sheet('cloth', (s, t) => [(s - 0.5) * bw, top - 0.03 - t * 0.38, L / 2 - 0.035 + Math.sin(s * 19) * 0.01], 12, 1, [bw, 0.4]));
    m.tinted(PCLOTH.white, () => m.box('cloth', [0, top - 0.005, z0 + 0.05], [bw + 0.02, 0.03, 0.18], { bevel: 0.012 }));
    // valance skirt to the floor
    m.tinted(hang, () => {
      for (const sx of [-1, 1]) m.sheet('cloth', (s, t) => [sx * (W / 2 + 0.005) + sx * Math.abs(Math.sin(s * 40)) * 0.012, 0.4 - t * 0.38, (s - 0.5) * (L - 0.16)], 16, 1, [L, 0.4]);
      m.sheet('cloth', (s, t) => [(s - 0.5) * (W - 0.1), 0.4 - t * 0.38, L / 2 + 0.005 + Math.abs(Math.sin(s * 30)) * 0.012], 12, 1, [W, 0.4]);
      // tester: ceiling cloth, pleated valance round three sides and the headcloth
      m.sheet('cloth', (s, t) => [(s - 0.5) * (W - 0.12), H - 0.13, (t - 0.5) * (L - 0.06)], 2, 2, [W, L], true); // between the cornices, not under them (it z-fought with their soffits)
      const val = 0.3;
      for (const sx of [-1, 1]) m.sheet('cloth', (s, t) => [sx * (W / 2 + 0.035 + Math.abs(Math.sin(s * 44)) * 0.015), H - 0.02 - t * val, (s - 0.5) * (L + 0.08)], 18, 1, [L, val]);
      m.sheet('cloth', (s, t) => [(s - 0.5) * (W + 0.08), H - 0.02 - t * val, L / 2 + 0.035 + Math.abs(Math.sin(s * 34)) * 0.015], 14, 1, [W, val]);
      m.sheet('cloth', (s, t) => [(s - 0.5) * (W - 0.12), H - 0.14 - t * (H - 1.35), -L / 2 + 0.03 + Math.abs(Math.sin(s * 26)) * 0.025], 16, 1, [W, H]);
      // curtains at the four posts, hanging along the sides from the cornice, gathered by a tie-back at
      // 1.05 m and spreading again to the floor: width along z, folds across it
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const px = sx * (W / 2 + 0.01), pz = sz * (L / 2 - 0.02), tie = 1.05, yt = H - 0.14;
        const width = (y: number) => (y > tie ? 0.16 + 0.62 * ((y - tie) / (yt - tie)) ** 1.3 : 0.16 + 0.26 * ((tie - y) / tie) ** 1.2);
        m.sheet('cloth', (s, t) => {
          const y = yt - t * (yt - 0.01), w = width(y), z = pz - sz * s * w;
          return [px + sx * (0.03 + Math.sin(s * Math.PI * 6) * 0.035 * (w / 0.7 + 0.4)), y, z];
        }, 8, 5, [0.8, H]);
      }
    });
    m.tinted(gold, () => {
      for (const sx of [-1, 1]) m.box('cloth', [sx * (W / 2 + 0.05), H - 0.02 - 0.3, 0], [0.012, 0.035, L + 0.08]);
      m.box('cloth', [0, H - 0.02 - 0.3, L / 2 + 0.05], [W + 0.08, 0.035, 0.012]);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.tube('cloth', Array.from({ length: 7 }, (_, i) => { const a = (i / 6) * Math.PI * 2; return [sx * (W / 2 + 0.03) + Math.cos(a) * 0.06, 1.05 + Math.sin(a * 2) * 0.01, sz * (L / 2 - 0.09) + Math.sin(a) * 0.08] as V3; }), 0.01, 3, [false, false]);
    });
    return none(m);
  },
};

// ---------- seating ----------
function bunFeet(m: PropMesh, r: Rng, w: number, d: number, h: number, wood: RGB, castors: boolean) {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.with(translate(sx * w, 0, sz * d), () => {
    m.tinted(wood, () => m.lathe('wood', [[castors ? 0.02 : 0.03, castors ? 0.03 : 0], [0.035, h * 0.4], [0.03, h * 0.75], [0.04, h]], 6));
    if (castors) m.tinted(METAL.brass, () => m.lathe('brass', [[0.001, 0], [0.022, 0.012], [0.015, 0.032]], 6));
  });
  void r;
}

/** Upholstered armchair (deep seat, rolled arms, a raked buttoned back) in the room's tone; velvet or
 * oxblood leather (v % 3), turned front legs on brass castors. */
export const armchair: PropKind = {
  name: 'armchair', placement: 'floor', blocksNav: true,
  build(m, r, v) {
    const W = range(r, 0.78, 0.86), D = range(r, 0.8, 0.88), H = range(r, 0.95, 1.05), seat = 0.44;
    const cloth = jitterTint(r, UPHOLSTERY[tone(v)], 0.06), wood = jitterTint(r, pick(r, [PWOOD.mahogany, PWOOD.walnut]), 0.05);
    bunFeet(m, r, W / 2 - 0.07, D / 2 - 0.07, 0.12, wood, true);
    m.tinted(cloth, () => {
      m.box('cloth', [0, 0.27, 0], [W, 0.3, D], { bevel: 0.035 });
      m.box('cloth', [0, seat - 0.02, 0.04], [W - 0.26, 0.14, D - 0.14], { bevel: 0.05, skew: [0, -0.01] });
      m.with(compose(translate(0, seat, -D / 2 + 0.11), rotX(-0.2)), () => m.box('cloth', [0, (H - seat) / 2, 0], [W - 0.08, H - seat, 0.2], { bevel: 0.07, taper: 0.06 }));
      for (const sx of [-1, 1]) {
        m.box('cloth', [sx * (W / 2 - 0.07), 0.48, 0.02], [0.14, 0.32, D - 0.04], { bevel: 0.03 });
        m.tube('cloth', [[sx * (W / 2 - 0.06), 0.66, -D / 2 + 0.12], [sx * (W / 2 - 0.05), 0.665, D / 2 - 0.02]], 0.075, 10);
      }
    });
    m.tinted([cloth[0] * 0.5, cloth[1] * 0.5, cloth[2] * 0.5], () => { // buttoning on the back
      for (let i = 0; i < 2; i++) for (let j = -1; j <= 1; j++) m.with(compose(translate(0, seat, -D / 2 + 0.11), rotX(-0.2)), () => m.box('cloth', [j * 0.17 + (i ? 0.085 : 0) * (j < 1 ? 1 : 0), 0.24 + i * 0.16, 0.1], [0.022, 0.022, 0.012]));
    });
    return none(m);
  },
};

/** Chesterfield sofa: arms rolled at the height of the buttoned back, three seat cushions, bun feet. */
export const sofa: PropKind = {
  name: 'sofa', placement: 'floor', blocksNav: true,
  build(m, r, v) {
    const W = range(r, 1.8, 2.1), D = range(r, 0.85, 0.92), H = range(r, 0.74, 0.8), seat = 0.44;
    const cloth = jitterTint(r, UPHOLSTERY[tone(v)], 0.06), wood = jitterTint(r, PWOOD.mahogany, 0.05);
    bunFeet(m, r, W / 2 - 0.08, D / 2 - 0.08, 0.1, wood, false);
    m.tinted(cloth, () => {
      m.box('cloth', [0, 0.25, 0], [W, 0.3, D], { bevel: 0.035 });
      m.box('cloth', [0, (H + 0.11) / 2, -D / 2 + 0.115], [W - 0.01, H - 0.11, 0.22], { bevel: 0.05 }); // back: ends inside the arms, 5 mm in from the base's back and bottom
      m.tube('cloth', [[-W / 2 + 0.05, H - 0.04, -D / 2 + 0.11], [W / 2 - 0.05, H - 0.04, -D / 2 + 0.11]], 0.1, 10);
      for (const sx of [-1, 1]) {
        m.box('cloth', [sx * (W / 2 - 0.095), (H - 0.06) / 2 + 0.06, 0.025], [0.2, H - 0.16, D - 0.03], { bevel: 0.04 }); // arms: 5 mm proud of the base's sides, 10 mm of its front, 10 mm above its bottom
        m.tube('cloth', [[sx * (W / 2 - 0.1), H - 0.06, -D / 2 + 0.1], [sx * (W / 2 - 0.1), H - 0.06, D / 2 - 0.02]], 0.12, 12);
      }
      const n = 3, cw = (W - 0.4) / n;
      for (let i = 0; i < n; i++) m.box('cloth', [-W / 2 + 0.2 + cw * (i + 0.5), seat, 0.06], [cw - 0.015, 0.13, D - 0.26], { bevel: 0.05, skew: [range(r, -0.008, 0.008), 0] });
    });
    m.tinted([cloth[0] * 0.45, cloth[1] * 0.45, cloth[2] * 0.45], () => {
      for (let i = 0; i < 3; i++) for (let j = 0; j < 9; j++) { const x = -W / 2 + 0.3 + (j + (i % 2) * 0.5) * ((W - 0.6) / 9); if (x < W / 2 - 0.28) m.box('cloth', [x, 0.56 + i * 0.075, -D / 2 + 0.225], [0.02, 0.02, 0.012]); }
    });
    return none(m);
  },
};

/** Footstool: a buttoned cushion with a gold fringe on four turned legs. */
export const footstool: PropKind = {
  name: 'footstool', placement: 'floor', blocksNav: true,
  build(m, r, v) {
    const W = range(r, 0.45, 0.6), D = range(r, 0.35, 0.42), H = range(r, 0.3, 0.38), wood = jitterTint(r, PWOOD.mahogany, 0.05);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.with(translate(sx * (W / 2 - 0.05), 0, sz * (D / 2 - 0.05)), () => m.tinted(wood, () => turned(m, 'wood', H - 0.1, 0.022, 8)));
    m.tinted(wood, () => m.box('wood', [0, H - 0.1, 0], [W, 0.06, D], { bevel: 0.01 }));
    m.tinted(jitterTint(r, UPHOLSTERY[tone(v)], 0.06), () => m.box('cloth', [0, H - 0.03, 0], [W + 0.01, 0.1, D + 0.01], { bevel: 0.04 }));
    m.tinted(PCLOTH.gold, () => m.box('cloth', [0, H - 0.09, 0], [W + 0.03, 0.03, D + 0.03]));
    return none(m);
  },
};

/** Gothic Revival hall chair: carved bog oak, a solid seat, a tall back with a lancet panel and finials. */
export const hallChair: PropKind = {
  name: 'hall-chair', placement: 'floor', blocksNav: true,
  build(m, r) {
    const W = range(r, 0.44, 0.5), D = range(r, 0.42, 0.48), seat = 0.46, H = range(r, 1.05, 1.2), wood = jitterTint(r, PWOOD.bog, 0.08);
    m.tinted(wood, () => {
      for (const sx of [-1, 1]) {
        m.box('wood', [sx * (W / 2 - 0.025), (seat - 0.008) / 2, D / 2 - 0.03], [0.045, seat - 0.008, 0.045], { bevel: 0.008, grain: 1, noBottom: true }); // top inside the seat
        m.box('wood', [sx * (W / 2 - 0.025), H / 2, -D / 2 + 0.03], [0.05, H, 0.05], { bevel: 0.008, grain: 1, noBottom: true });
        m.with(translate(sx * (W / 2 - 0.025), H, -D / 2 + 0.03), () => m.lathe('wood', [[0.026, 0], [0.03, 0.02], [0.012, 0.05], [0.02, 0.07], [0.001, 0.12]], 8));
      }
      m.box('wood', [0, seat - 0.02, 0.0075], [W + 0.01, 0.04, D - 0.009], { bevel: 0.01 }); // overhangs the legs' sides and front, back edge inside the back posts
      m.box('wood', [0, seat - 0.08, D / 2 - 0.024], [W - 0.04, 0.08, 0.025], { bevel: 0.005 }); // rail set back from the legs' faces
      for (const sz of [-1, 1]) m.box('wood', [0, 0.12, sz * (D / 2 - 0.03)], [W - 0.05, 0.04, 0.03], { bevel: 0.004 });
      m.box('wood', [0, (seat + H) / 2, -D / 2 + 0.03], [W - 0.05, H - seat - 0.06, 0.02], { bevel: 0.004, grain: 1 });
      m.box('wood', [0, H - 0.05, -D / 2 + 0.03], [W - 0.04, 0.08, 0.04], { bevel: 0.008 });
    });
    // the lancet panel carved in the back: an arched moulding
    m.tinted([wood[0] * 0.75, wood[1] * 0.75, wood[2] * 0.75], () => {
      const hw = (W - 0.16) / 2, y0 = seat + 0.1, ys = H - 0.32;
      const path: V3[] = [[-hw, y0, -D / 2 + 0.045], [-hw, ys, -D / 2 + 0.045]];
      for (let i = 1; i < 6; i++) { const t = i / 6; path.push([-hw + t * hw, ys + Math.sin(t * Math.PI / 2) * 0.18, -D / 2 + 0.045]); }
      path.push([0, ys + 0.2, -D / 2 + 0.045]);
      for (let i = 5; i >= 1; i--) { const t = i / 6; path.push([hw - t * hw, ys + Math.sin(t * Math.PI / 2) * 0.18, -D / 2 + 0.045]); }
      path.push([hw, ys, -D / 2 + 0.045], [hw, y0, -D / 2 + 0.045], [-hw, y0, -D / 2 + 0.045]);
      m.tube('wood', path, 0.01, 4, [false, false]);
    });
    return none(m);
  },
};

// ---------- tables ----------
/** Round centre ("loo") table on a turned pedestal and tripod, under a fringed cloth in the room's tone. */
export const roundTable: PropKind = {
  name: 'round-table', placement: 'floor', blocksNav: true,
  build(m, r, v) {
    const R = range(r, 0.5, 0.6), H = range(r, 0.72, 0.76), drop = range(r, 0.3, 0.42), wood = jitterTint(r, pick(r, [PWOOD.mahogany, PWOOD.walnut]), 0.05);
    m.tinted(wood, () => {
      for (let i = 0; i < 3; i++) m.with(rotY((i / 3) * Math.PI * 2), () => m.tube('wood', [[0, 0.18, 0], [0.18, 0.1, 0], [0.3, 0.03, 0], [0.34, 0.03, 0]], [0.04, 0.035, 0.03, 0.025], 6));
      m.lathe('wood', [[0.07, 0.12], [0.08, 0.2], [0.05, 0.3], [0.09, H * 0.5], [0.045, H * 0.75], [0.05, H - 0.04], [0.001, H - 0.04]], 10);
    });
    const cloth = jitterTint(r, r() < 0.4 ? PCLOTH.green : TONES[tone(v)], 0.06);
    m.tinted(cloth, () => m.sheet('cloth', (s, t) => {
      const a = s * Math.PI * 2, rr = 0.03 + t * (R + drop - 0.03), over = Math.max(0, rr - R);
      const fold = over > 0 ? Math.sin(a * 11) * 0.025 * (over / drop) : 0;
      return [Math.cos(a) * (Math.min(rr, R) + fold + over * 0.08), H + 0.005 - over, Math.sin(a) * (Math.min(rr, R) + fold + over * 0.08)];
    }, 24, 5, [R * 6.3, R + drop], true));
    m.with(translate(0, H + 0.007, 0), () => m.lathe('cloth', [[0.034, 0], [0, 0]], 8)); // a button over the hole in the cloth's centre: one disc facing up (a ring facing down under a cap facing up z-fought)
    m.tinted(PCLOTH.gold, () => m.tube('cloth', Array.from({ length: 25 }, (_, i) => { const a = (i / 24) * Math.PI * 2; return [Math.cos(a) * (R + drop * 0.08 + Math.sin(a * 11) * 0.025), H + 0.005 - drop, Math.sin(a) * (R + drop * 0.08 + Math.sin(a * 11) * 0.025)] as V3; }), 0.012, 4, [false, false]));
    return { colliders: [boxCollider([-R - 0.05, 0, -R - 0.05], [R + 0.05, H, R + 0.05])], emitters: [] };
  },
};

/** Small tripod side table (a wine table) for a lamp or a book beside a chair. */
export const sideTable: PropKind = {
  name: 'side-table', placement: 'floor', blocksNav: true,
  build(m, r) {
    const R = range(r, 0.22, 0.28), H = range(r, 0.62, 0.7);
    m.tinted(jitterTint(r, pick(r, [PWOOD.mahogany, PWOOD.walnut, PWOOD.oak]), 0.05), () => {
      for (let i = 0; i < 3; i++) m.with(rotY((i / 3) * Math.PI * 2), () => m.tube('wood', [[0, 0.16, 0], [0.12, 0.06, 0], [0.2, 0.02, 0]], [0.025, 0.02, 0.016], 5));
      m.lathe('wood', [[0.04, 0.1], [0.035, 0.25], [0.05, H * 0.55], [0.025, H * 0.8], [0.03, H - 0.03]], 8);
      m.lathe('wood', [[0.001, H - 0.03], [R, H - 0.03], [R + 0.008, H - 0.012], [R, H], [0.001, H]], 18);
    });
    return none(m);
  },
};

/** Pedestal desk: two pedestals of three drawers with brass handles, a kneehole, a leather-lined top. */
export const pedestalDesk: PropKind = {
  name: 'pedestal-desk', placement: 'floor', blocksNav: true,
  build(m, r, v) {
    const W = range(r, 1.4, 1.6), D = range(r, 0.75, 0.85), H = 0.76, pw = W * 0.3, wood = jitterTint(r, pick(r, [PWOOD.walnut, PWOOD.mahogany, PWOOD.oak]), 0.05);
    m.tinted(wood, () => {
      for (const sx of [-1, 1]) {
        const x = sx * (W / 2 - pw / 2);
        m.box('wood', [x, 0.04, 0], [pw + 0.03, 0.08, D - 0.02], { bevel: 0.01, noBottom: true });
        m.box('wood', [x, (H - 0.04) / 2 + 0.04, -0.01], [pw, H - 0.12, D - 0.06], { bevel: 0.006 });
        for (let i = 0; i < 3; i++) m.box('wood', [x, 0.16 + i * 0.18, D / 2 - 0.035], [pw - 0.05, 0.15, 0.02], { bevel: 0.006 });
      }
      m.box('wood', [0, H - 0.1, -D / 2 + 0.04], [W - 2 * pw, 0.18, 0.02], { bevel: 0.004 });
      m.box('wood', [0, H - 0.07, D / 2 - 0.035], [W - 2 * pw - 0.02, 0.1, 0.02], { bevel: 0.004 });
      m.box('wood', [0, H - 0.02, 0], [W + 0.04, 0.04, D + 0.02], { bevel: 0.012 });
    });
    m.tinted(jitterTint(r, tone(v) === 1 ? PCLOTH.green : PCLOTH.oxblood, 0.05), () => m.box('cloth', [0, H + 0.0015, 0], [W - 0.12, 0.003, D - 0.12], { noBottom: true }));
    m.tinted(METAL.brass, () => {
      for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) m.tube('brass', [[sx * (W / 2 - pw / 2) - 0.05, 0.16 + i * 0.18, D / 2 - 0.02], [sx * (W / 2 - pw / 2) - 0.045, 0.14 + i * 0.18, D / 2 + 0.005], [sx * (W / 2 - pw / 2) + 0.045, 0.14 + i * 0.18, D / 2 + 0.005], [sx * (W / 2 - pw / 2) + 0.05, 0.16 + i * 0.18, D / 2 - 0.02]], 0.005, 4);
      m.tube('brass', [[-0.06, H - 0.07, D / 2 - 0.02], [-0.05, H - 0.09, D / 2 + 0.005], [0.05, H - 0.09, D / 2 + 0.005], [0.06, H - 0.07, D / 2 - 0.02]], 0.005, 4);
    });
    return none(m);
  },
};

/** Bookcase full of books: walnut or oak case with cornice and plinth, five or six shelves of spines
 * (leather and cloth bindings, some gilt bands, a few leaning, the odd gap). */
export const bookcase: PropKind = {
  name: 'bookcase', placement: 'floor', blocksNav: true,
  build(m, r) {
    const W = range(r, 1.15, 1.45), D = 0.4, H = range(r, 2.15, 2.4), n = H > 2.3 ? 6 : 5, wood = jitterTint(r, pick(r, [PWOOD.walnut, PWOOD.oak, PWOOD.mahogany]), 0.05);
    const y0 = 0.14, gap = (H - 0.14 - y0) / n;
    m.tinted(wood, () => {
      for (const sx of [-1, 1]) m.box('wood', [sx * (W / 2 - 0.02), (H - 0.004) / 2, 0], [0.04, H - 0.004, D], { bevel: 0.006, grain: 1, noBottom: true }); // tops inside the cornice
      m.box('wood', [0, y0 / 2, 0.01], [W + 0.01, y0, D], { bevel: 0.008, noBottom: true }); // plinth 5 mm proud of the sides
      m.box('wood', [0, H - 0.06, 0.015], [W + 0.08, 0.12, D + 0.05], { bevel: 0.015 });
      m.box('wood', [0, H / 2, -D / 2 + 0.012], [W - 0.08, H - 0.1, 0.02], { grain: 1 }); // between the sides, 2 mm in from their backs
      for (let i = 1; i < n; i++) m.box('wood', [0, y0 + i * gap - 0.01, 0], [W - 0.08, 0.025, D - 0.03], { bevel: 0.004 });
    });
    const bind: RGB[] = [PCLOTH.oxblood, [0.36, 0.2, 0.1], [0.14, 0.09, 0.06], PCLOTH.green, [0.3, 0.22, 0.12], [0.1, 0.12, 0.2], [0.42, 0.3, 0.16]];
    for (let i = 0; i < n; i++) {
      const y = y0 + i * gap + (i ? 0.0025 : 0);
      let x = -W / 2 + 0.045 + range(r, 0, 0.04), leanBack = NaN;
      const hmax = gap - 0.05;
      while (x < W / 2 - 0.08) {
        if (r() < 0.06) { x += range(r, 0.08, 0.2); continue; }
        const t = range(r, 0.03, 0.065), h = Math.min(hmax, range(r, 0.19, 0.34)), d0 = Math.min(D - 0.08, h * range(r, 0.6, 0.75)), lean = r() < 0.08 ? range(r, 0.1, 0.25) : 0;
        // a leaning book rests on the next one: it is set back so their fronts never share a plane, and the
        // next one is made shallower when their backs would
        const c = jitterTint(r, pick(r, bind), 0.15), front = D / 2 - 0.03 - (lean ? 0.012 : 0);
        const d = !lean && Math.abs(front - d0 - leanBack) < 0.004 ? d0 - 0.008 : d0;
        leanBack = lean ? front - d : NaN;
        const at = lean ? compose(translate(x + t / 2 + Math.sin(lean) * h, y, front - d / 2), rotZ(-lean)) : translate(x + t / 2, y, front - d / 2);
        m.with(at, () => {
          m.tinted(c, () => m.box('cloth', [0, h / 2, 0], [t, h, d], { noBottom: true }));
          if (r() < 0.22) m.tinted(METAL.gilt, () => m.box('brass', [0, h * range(r, 0.72, 0.85), d / 2 + 0.001], [t * 0.9, 0.012, 0.003]));
        });
        x += t + 0.002 + (lean ? Math.sin(lean) * h : 0);
      }
    }
    return { colliders: [boxCollider([-W / 2 - 0.04, 0, -D / 2], [W / 2 + 0.04, H, D / 2 + 0.03])], emitters: [] };
  },
};

// ---------- floor textiles ----------
/** Turkey carpet from the paint atlas: border, field and medallion; v % 3 = 2 is a tartan carpet. */
function carpetSheet(m: PropMesh, r: Rng, W: number, L: number, tartan: boolean) {
  const ph = r() * 6, rect = tartan ? ATLAS.tartan : ATLAS.carpet;
  m.tinted(jitterTint(r, [1, 1, 1], 0.05), () => m.atlasSheet((s, t) => {
    const e = Math.min(s, 1 - s, t, 1 - t), lift = Math.min(1, e * 30);
    return [(s - 0.5) * W, 0.003 + 0.007 * lift + Math.max(0, Math.sin(s * 5 + t * 3 + ph)) * 0.006 * lift, (t - 0.5) * L];
  }, 6, 8, rect));
  if (!tartan) m.tinted(PCLOTH.ivory, () => { // knotted fringe at the ends
    for (const sz of [-1, 1]) m.sheet('cloth', (s, t) => [(s - 0.5) * (W - 0.06), 0.004, sz * (L / 2 + t * 0.07)], 2, 1, [W, 0.07], sz < 0);
  });
}

/** Hearth or bedside rug: a smaller Turkey carpet. */
export const rug: PropKind = {
  name: 'rug', placement: 'floor', blocksNav: false,
  build(m, r) {
    carpetSheet(m, r, range(r, 1.3, 1.9), range(r, 1.9, 2.8), false);
    return { colliders: [hull(m)], emitters: [] };
  },
};

export const carpet: PropKind = {
  name: 'carpet', placement: 'floor', blocksNav: false,
  build(m, r, v) {
    const W = range(r, 2.8, 3.6), L = range(r, 3.6, 4.6);
    carpetSheet(m, r, W, L, tone(v) === 2 && r() < 0.5);
    return { colliders: [hull(m)], emitters: [] };
  },
};

/** Corridor runner: the atlas runner repeated every 4 m, 0.9-1.05 m wide. */
export const runner: PropKind = {
  name: 'runner', placement: 'floor', blocksNav: false,
  build(m, r) {
    const W = range(r, 0.9, 1.05), L = range(r, 3.5, 6.5), n = Math.max(1, Math.round(L / 4)), seg = L / n;
    for (let i = 0; i < n; i++) m.atlasSheet((s, t) => [(s - 0.5) * W, 0.006 + 0.002 * Math.sin(t * 9 + i), -L / 2 + (i + t) * seg], 4, 16, ATLAS.runner);
    return { colliders: [hull(m)], emitters: [] };
  },
};

/** Animal skin by the fire: a bear or deer hide laid flat, its outline the classic rug's (four splayed legs
 * with paws, a head, a short tail), a little thickness that rolls down to soft edges, fur from the paint
 * atlas mapped flat in metres (no stretching into the legs); a raised bear's head one time in two. */
export const skin: PropKind = {
  name: 'skin', placement: 'floor', blocksNav: false,
  build(m, r) {
    const bear = r() < 0.5, L = bear ? range(r, 1.8, 2.2) : range(r, 1.3, 1.6), W = L * 0.62;
    const tint = bear ? jitterTint(r, [0.55, 0.45, 0.38], 0.1) : jitterTint(r, [0.74, 0.56, 0.4], 0.08);
    // outline in polar form from the middle (head toward +z): an oval body, four legs, a head and a tail
    // super-Gaussian lobes: square-ended legs (paws), not the points of a star
    const lobe = (th: number, c: number, w: number, p = 2) => { const d = Math.atan2(Math.sin(th - c), Math.cos(th - c)); return Math.exp(-(Math.abs(d / w) ** p)); };
    const legs = [0.9, -0.9, 2.25, -2.25].map((c) => c + range(r, -0.06, 0.06));
    const R = (th: number) => {
      const body = 1 / Math.hypot(Math.sin(th) / (W * 0.34), Math.cos(th) / (L * 0.33));
      return body + legs.reduce((s, c, i) => s + lobe(th, c, 0.19, 4) * L * (i < 2 ? 0.2 : 0.19), 0) + lobe(th, 0, 0.22, 3) * L * (bear ? 0.1 : 0.14)
        + (bear ? 0 : (lobe(th, 0.3, 0.06) + lobe(th, -0.3, 0.06)) * L * 0.1) + lobe(th, Math.PI, 0.08) * L * (bear ? 0.05 : 0.07);
    };
    const N = 72, rings = [0, 0.4, 0.75, 0.93, 1], lift = [0.024, 0.023, 0.019, 0.012, 0.003];
    const pts = rings.map((f, k) => Array.from({ length: N }, (_, i) => { const th = (i / N) * Math.PI * 2, rr = R(th) * f; return [Math.sin(th) * rr, lift[k], Math.cos(th) * rr] as V3; }));
    const X = W * 0.9, Z = L * 0.6, uv = (p: V3): [number, number] => [ATLAS.fur[0] + (ATLAS.fur[2] - ATLAS.fur[0]) * (p[0] / (2 * X) + 0.5), ATLAS.fur[1] + (ATLAS.fur[3] - ATLAS.fur[1]) * (p[2] / (2 * Z) + 0.5)];
    m.tinted(tint, () => {
      for (let k = 0; k < rings.length - 1; k++) for (let i = 0; i < N; i++) {
        const j = (i + 1) % N, a = pts[k][i], b = pts[k][j], c = pts[k + 1][j], d = pts[k + 1][i];
        const nn = (p: V3, q: V3, s: V3): V3 => { const u: V3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v: V3 = [s[0] - p[0], s[1] - p[1], s[2] - p[2]]; const c3: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const l = Math.hypot(...c3) || 1; return c3[1] < 0 ? [-c3[0] / l, -c3[1] / l, -c3[2] / l] : [c3[0] / l, c3[1] / l, c3[2] / l]; };
        if (k > 0) { const n1 = nn(a, c, b); m.tri('paint', [a, b, c], [n1, n1, n1], [uv(a), uv(b), uv(c)]); }
        const n2 = nn(a, d, c); m.tri('paint', [a, c, d], [n2, n2, n2], [uv(a), uv(c), uv(d)]);
      }
    });
    const before = m.bins.paint.uv.length;
    if (bear) m.tinted(tint, () => m.with(translate(0, 0.06, R(0) - 0.12), () => {
      m.tube('paint', [[0, 0.04, -0.12], [0, 0.11, 0.0], [0, 0.1, 0.16], [0, 0.07, 0.27]], [0.1, 0.13, 0.09, 0.05], 10);
      for (const sx of [-1, 1]) m.with(translate(sx * 0.08, 0.17, -0.04), () => m.lathe('paint', [[0.001, 0], [0.035, 0.01], [0.03, 0.035], [0.001, 0.045]], 6));
      m.tinted([0.15, 0.12, 0.1], () => m.with(translate(0, 0.07, 0.31), () => m.lathe('ceramic', [[0.001, -0.02], [0.025, -0.01], [0.022, 0.015], [0.001, 0.02]], 6)));
    }));
    // the head's metre UVs folded into the fur's corner of the atlas
    const uvs = m.bins.paint.uv, fr = (x: number) => x - Math.floor(x);
    for (let i = before; i < uvs.length; i += 2) { uvs[i] = ATLAS.fur[0] + (ATLAS.fur[2] - ATLAS.fur[0]) * fr(uvs[i] * 2); uvs[i + 1] = ATLAS.fur[1] + (ATLAS.fur[3] - ATLAS.fur[1]) * 0.5 * fr(uvs[i + 1] * 2); }
    return { colliders: [hull(m)], emitters: [] };
  },
};

// ---------- wall trophies and armour ----------
/** Stag's head on an oak shield: neck, head and ears in hide, glass eyes, two antlers of six tines. */
export const stagHead: PropKind = {
  name: 'stag-head', placement: 'wall', mount: 2.55, blocksNav: false,
  build(m, r) {
    const hide = jitterTint(r, [0.42, 0.28, 0.17], 0.08), bone = jitterTint(r, [1.35, 1.15, 0.88], 0.06), span = range(r, 0.85, 1.05);
    m.tinted(jitterTint(r, PWOOD.oak, 0.06), () => {
      m.sheet('wood', (s, t) => { const a = s * Math.PI * 2; return [Math.cos(a) * 0.17 * t, -0.04 + Math.sin(a) * 0.24 * t - (Math.sin(a) < 0 ? 0.06 * t * Math.abs(Math.sin(a)) ** 4 : 0), 0.03]; }, 16, 2, [0.4, 0.5], true);
      m.tube('wood', Array.from({ length: 17 }, (_, i) => { const a = (i / 16) * Math.PI * 2; return [Math.cos(a) * 0.17, -0.04 + Math.sin(a) * 0.24 - (Math.sin(a) < 0 ? 0.06 * Math.abs(Math.sin(a)) ** 4 : 0), 0.02] as V3; }), 0.018, 5, [false, false]);
    });
    m.tinted(hide, () => {
      m.tube('cloth', [[0, -0.12, 0.06], [0, -0.05, 0.2], [0, 0.05, 0.31], [0, 0.04, 0.42], [0, -0.04, 0.55], [0, -0.09, 0.6]], [0.13, 0.125, 0.1, 0.085, 0.055, 0.035], 10);
      for (const sx of [-1, 1]) m.with(compose(translate(sx * 0.08, 0.12, 0.33), compose(rotZ(-sx * 0.9), rotX(-0.3))), () => m.lathe('cloth', [[0.001, 0], [0.03, 0.03], [0.025, 0.09], [0.001, 0.13]], 6));
    });
    m.tinted([0.03, 0.025, 0.02], () => {
      for (const sx of [-1, 1]) m.with(translate(sx * 0.075, 0.05, 0.43), () => m.lathe('ceramic', [[0.001, -0.014], [0.014, -0.008], [0.014, 0.008], [0.001, 0.014]], 6));
      m.with(translate(0, -0.09, 0.61), () => m.lathe('ceramic', [[0.001, -0.02], [0.025, -0.01], [0.022, 0.012], [0.001, 0.02]], 6));
    });
    m.tinted(bone, () => {
      for (const sx of [-1, 1]) {
        const beam: V3[] = [[sx * 0.05, 0.12, 0.34], [sx * 0.16, 0.22, 0.3], [sx * span * 0.38, 0.36, 0.2], [sx * span * 0.48, 0.55, 0.16], [sx * span * 0.45, 0.72, 0.18]];
        m.tube('wood', beam, [0.025, 0.022, 0.018, 0.014, 0.008], 6);
        for (const [i, k] of [[1, 0.15], [2, 0.12], [3, 0.1], [3, 0.09]] as const) {
          const b = beam[i], tip: V3 = [b[0] - sx * 0.03, b[1] + k * 1.2, b[2] + k * (i === 3 ? -0.6 : 0.5)];
          m.tube('wood', [b, tip], [0.013, 0.004], 5, [false, true]);
        }
      }
    });
    return { colliders: [hull(m)], emitters: [] };
  },
};

/** Wall trophy of arms: a Highland targe with brass studs and boss over a fan of swords and two crossed
 * pole-arms (Inveraray, Windsor). */
export const weaponTrophy: PropKind = {
  name: 'weapon-trophy', placement: 'wall', mount: 2.45, blocksNav: false,
  build(m, r) {
    const R = range(r, 0.24, 0.3), n = 6 + 2 * Math.floor(r() * 2), steel = jitterTint(r, METAL.steel, 0.05);
    for (const sx of [-1, 1]) {
      const a = sx * 0.75, c = Math.cos(a), s = Math.sin(a), L = range(r, 1.6, 1.9);
      m.tinted(jitterTint(r, PWOOD.oak, 0.08), () => m.tube('wood', [[-s * L / 2, -c * L / 2, 0.03], [s * L / 2, c * L / 2, 0.03]], 0.014, 5));
      m.tinted(steel, () => m.with(compose(translate(s * L / 2, c * L / 2, 0.03), rotZ(-a)), () => { m.box('brass', [0, 0.12, 0], [0.02, 0.24, 0.006]); m.box('brass', [0.065, 0.02, 0], [0.14, 0.12, 0.01], { bevel: 0.002 }); })); // thicker than the blade and starting inside it: no shared faces
    }
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.PI / n, c = Math.cos(a), s = Math.sin(a), L = range(r, 0.75, 0.9);
      m.with(compose(translate(c * R * 0.5, s * R * 0.5, 0.045), rotZ(a - Math.PI / 2)), () => {
        m.tinted(steel, () => m.box('brass', [0, L / 2 + 0.12, 0], [0.035, L, 0.006], { taper: 0.6 }));
        m.tinted(METAL.brass, () => m.box('brass', [0, 0.12, 0], [0.12, 0.015, 0.015]));
        m.tinted([0.15, 0.1, 0.07], () => m.tube('wood', [[0, -0.02, 0], [0, 0.11, 0]], 0.012, 4, [true, false]));
      });
    }
    m.tinted(jitterTint(r, PWOOD.oak, 0.05), () => m.with(compose(translate(0, 0, 0.06), rotX(Math.PI / 2)), () => m.lathe('wood', [[R, 0], [R, 0.025], [0.001, 0.03]], 20)));
    m.tinted(jitterTint(r, PCLOTH.blackLeather, 0.1), () => m.with(compose(translate(0, 0, 0.088), rotX(Math.PI / 2)), () => m.lathe('cloth', [[R - 0.005, 0], [R * 0.6, 0.012], [0.001, 0.02]], 20)));
    m.tinted(METAL.brass, () => {
      m.with(compose(translate(0, 0, 0.1), rotX(Math.PI / 2)), () => m.lathe('brass', [[0.07, 0], [0.06, 0.02], [0.03, 0.04], [0.008, 0.05], [0.002, 0.13]], 10));
      for (const k of [0.45, 0.78]) for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2 + k; m.box('brass', [Math.cos(a) * R * k, Math.sin(a) * R * k, 0.095 + (1 - k) * 0.01], [0.018, 0.018, 0.01], { noBottom: true }); }
    });
    return { colliders: [hull(m)], emitters: [] };
  },
};

/** A full suit of plate armour on an oak plinth, holding a halberd: the castle signature by the doors. */
export const armour: PropKind = {
  name: 'armour', placement: 'floor', blocksNav: true,
  build(m, r) {
    const steel = jitterTint(r, METAL.steel, 0.05), ph = 0.22, wood = jitterTint(r, PWOOD.bog, 0.08);
    m.tinted(wood, () => {
      m.box('wood', [0, ph / 2, 0], [0.62, ph, 0.52], { bevel: 0.012, noBottom: true });
      m.box('wood', [0, ph + 0.015, 0], [0.66, 0.03, 0.56], { bevel: 0.01 });
    });
    m.with(translate(0, ph + 0.03, 0), () => m.tinted(steel, () => {
      for (const sx of [-1, 1]) {
        const x = sx * 0.11;
        m.box('brass', [x, 0.035, 0.05], [0.1, 0.07, 0.26], { bevel: 0.02, taper: 0.3 });          // sabaton
        m.tube('brass', [[x, 0.07, 0], [x, 0.3, -0.005], [x, 0.48, 0]], [0.055, 0.06, 0.06], 9);     // greave
        m.with(translate(x, 0.5, 0.02), () => m.lathe('brass', [[0.04, -0.04], [0.07, -0.02], [0.075, 0.01], [0.05, 0.04]], 9)); // knee
        m.tube('brass', [[x, 0.53, 0], [x * 1.05, 0.78, -0.01], [x * 0.9, 0.9, 0]], [0.065, 0.08, 0.085], 9); // cuisse
      }
      // torso: a breastplate with a keel, waist and fauld, as a closed sheet of elliptic sections
      const rx = (y: number) => 0.18 + 0.05 * Math.sin(Math.min(1, (y - 0.85) / 0.55) * Math.PI) - (y > 1.35 ? (y - 1.35) * 1.2 : 0);
      m.sheet('brass', (s, t) => { const a = s * Math.PI * 2, y = 0.85 + t * 0.6, k = 1 + 0.25 * Math.max(0, Math.sin(a)) * Math.sin(t * Math.PI); return [Math.cos(a) * rx(y), y, Math.sin(a) * rx(y) * 0.72 * k]; }, 16, 8, [1.4, 0.6], true);
      for (let i = 0; i < 3; i++) m.with(translate(0, 0.94 - i * 0.05, 0), () => m.lathe('brass', [[0.2 + i * 0.012, -0.03], [0.205 + i * 0.012, 0.03]], 16)); // fauld lames
      for (const sx of [-1, 1]) {
        m.with(compose(translate(sx * 0.21, 1.38, 0), rotZ(-sx * 0.5)), () => m.lathe('brass', [[0.11, -0.06], [0.11, 0], [0.08, 0.06], [0.001, 0.09]], 10)); // pauldron
        m.tube('brass', [[sx * 0.25, 1.32, 0], [sx * 0.29, 1.08, -0.01], [sx * 0.27, 0.86, 0.06]], [0.05, 0.048, 0.042], 8);
        m.with(translate(sx * 0.29, 1.08, -0.01), () => m.lathe('brass', [[0.03, -0.05], [0.06, -0.02], [0.06, 0.02], [0.03, 0.05]], 8)); // couter
        m.box('brass', [sx * 0.27, 0.8, 0.08], [0.06, 0.1, 0.07], { bevel: 0.02 }); // gauntlet
      }
      m.tube('brass', [[0, 1.42, 0], [0, 1.5, 0]], 0.05, 8);
      m.with(translate(0, 1.5, 0), () => m.lathe('brass', [[0.08, 0], [0.11, 0.06], [0.115, 0.14], [0.1, 0.22], [0.05, 0.27], [0.001, 0.28]], 12)); // close helm
      m.box('brass', [0, 1.62, 0.1], [0.14, 0.035, 0.03], { bevel: 0.01 });
      m.tinted([0.05, 0.05, 0.05], () => m.box('iron', [0, 1.655, 0.108], [0.12, 0.012, 0.012]));
    }));
    // halberd in the right gauntlet
    m.tinted(jitterTint(r, PWOOD.oak, 0.06), () => m.tube('wood', [[0.3, ph + 0.03, 0.12], [0.3, ph + 2.15, 0.07]], 0.016, 6));
    m.tinted(steel, () => m.with(translate(0.3, ph + 2.1, 0.07), () => { m.box('brass', [0, 0.14, 0], [0.022, 0.28, 0.022], { taper: 0.8 }); m.box('brass', [0.07, 0, 0], [0.14, 0.16, 0.006], { taper: 0.3 }); m.box('brass', [-0.05, 0.02, 0], [0.1, 0.03, 0.006], { taper: 0.6 }); }));
    return none(m);
  },
};

export const PERIOD: readonly PropKind[] = [
  chimneypiece, hoodedHearth, candleSconce, oilLamp, candelabrum, portrait, overmantelMirror, testerBed,
  armchair, sofa, footstool, hallChair, roundTable, sideTable, pedestalDesk, bookcase,
  rug, carpet, runner, skin, stagHead, weaponTrophy, armour,
];
