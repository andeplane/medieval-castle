// The castle exterior, generated from spec.ts + layout.ts (plan → layout → geometry → dressing).
// Exterior only for now: walls with real window openings, buttresses and blind arches, corbel tables
// with machicolations, crenellations, roofs, chimneys, towers, gatehouse, stair tower.
import { rngFor, type Rng } from '../core/rng';
import { type V2, add, scale, sub, norm, lerp2, len } from '../core/math2d';
import { Builder, offsetPoly, pointedArch, roundArch, rect, at, wallFrame, type MatKey, type Opening, type Frame } from './builder';
import { GROUND, floorBase, FLOOR_HEIGHTS, TOWERS, GATEHOUSE, EAST_TURRET, STAIR_TOWER, type TowerSpec } from './spec';
import { wingQuads, towerCentre, squareTowerPoly, gatehouseFrame, eastTurretFrame, stairTowerCentre, stairTowerPoly, type WingQuad } from './layout';
import { buildPaving, wellCentre } from './paving';
import { OPEN_W, OPEN_H, dressed, boxOf, fits, fitOpening, masses, doorHoleOn, doorBox, type Box, type Dressed, type Face, type Mass, type DoorHole } from './openings';
import { planInterior, doorHoles, GATE } from './interior/plan';

const G0 = GROUND - 1.6; // walls start below the ground so the terrain never shows a gap
const BATTER_TOP = GROUND + 2.6;
type V3 = [number, number, number];

export interface WindowLight { p: V3; n: V3; w: number; h: number }

/** Every window, slit and loop the generator planned: where it was planned and where it went (null: left out). */
export interface PlacedOpening { face: Face; kind: string; d: Dressed; s: number; y: number; at: { s: number; y: number } | null }
interface Ctx { others: Mass[]; log: PlacedOpening[]; doors: DoorHole[]; seeded: WeakSet<Box[]> }

/**
 * The castle's exterior. `doors` are the interior plan's doors (openings.ts DoorHole): every wall face a
 * door passes through is cut with the door's own outline, and windows are placed around them. Pass []
 * for a castle without interiors.
 */
export function buildCastle(r: Rng = rngFor('castle'), doors: DoorHole[] = doorHoles(planInterior())) {
  const B = new Builder();
  B.doorHoles = doors;
  const lights: WindowLight[] = [];
  const ctx: Ctx = { others: masses(), log: [], doors, seeded: new WeakSet() };
  B.stoneFloor = GROUND - 0.5; // walls run 1.6 m into the ground; no stones where nobody can see them
  for (const w of wingQuads()) wing(B, r, w, lights, ctx);
  for (const t of TOWERS) t.kind === 'square' ? squareTower(B, r, t, lights, ctx) : roundTower(B, r, t, lights, ctx);
  gatehouse(B, r, lights, ctx);
  eastTurret(B, r, lights, ctx);
  stairTower(B, r, ctx);
  courtyardDressing(B);
  B.stoneFloor = -0.35;
  return { builder: B, lights, openings: ctx.log };
}

// ---------------------------------------------------------------- helpers

const dir2 = (f: Frame): V2 => [f.r[0], f.r[2]];

/** The doors through a face, as taken boxes in its list (once per list): windows are placed around them. */
function withDoors(ctx: Ctx, face: Face, taken: Box[]) {
  if (ctx.seeded.has(taken)) return taken;
  ctx.seeded.add(taken);
  for (const h of ctx.doors) { const pts = doorHoleOn(face, h); if (pts) taken.push(doorBox(pts)); }
  return taken;
}

/** Fit an opening planned at (s, y) on a face (openings.ts); logs it and marks its box taken. */
function place(ctx: Ctx, face: Face, taken: Box[], kind: string, s: number, y: number, d = dressed(kind), maxShift?: number) {
  withDoors(ctx, face, taken);
  const p = fitOpening(face, ctx.others, taken, d, s, y, maxShift);
  ctx.log.push({ face, kind, d, s, y, at: p });
  if (p) taken.push(boxOf(d, p.s, p.y));
  return p;
}
/** Strips of a face to keep openings off: plinth top, string courses (0.26 m), floors, parapet. */
function bands(plinthTop: number, courses: number[], floors: number[], parapet: number): [number, number][] {
  return [[G0, plinthTop], ...courses.map((y) => [y, y + 0.26] as [number, number]), ...floors.map((y) => [y, y] as [number, number]), [parapet, parapet + 4]];
}
const floorLines = (f0: number, f1: number) => Array.from({ length: f1 - f0 }, (_, i) => floorBase(f0 + i));
const PARAPET_DROP = 1.5; // bottom of the corbel table below the wall top

/** Faces made inside fn are silhouette elements: their real stones are kept further from the camera. */
function sil(B: Builder, fn: () => void) {
  const was = B.stoneSil; B.stoneSil = true;
  try { fn(); } finally { B.stoneSil = was; }
}

/** A coping or capping course as separate dressed stones (real joints along the skyline). */
function copingOn(B: Builder, r: Rng, f: Frame, s0: number, s1: number, y: number, d: number, h: number, depth: number) {
  let s = s0;
  while (s < s1 - 0.05) {
    let L = 0.6 + r() * 0.45; if (s1 - s - L < 0.35) L = s1 - s;
    const hh = h + (r() - 0.5) * 0.025;
    boxOn(B, 'trim', f, s + L / 2, y + (hh - h) / 2, d + (r() - 0.5) * 0.02, L - 0.018, hh, depth);
    s += L;
  }
}

/** Box placed on a wall frame: s along, y up, d out from the face (centre), sizes along/up/out. */
function boxOn(B: Builder, mat: MatKey, f: Frame, s: number, y: number, d: number, sx: number, sy: number, sz: number) {
  B.box(mat, at(f, s, y, d), [sx, sy, sz], dir2(f));
}

/** Window opening shapes. Returns the openings and dressing (sill, jambs, hood) to add. */
function windowOpenings(kind: 'slit' | 'loop' | 'lancet' | 'twin' | 'rect' | 'round' | 'small', s: number, y: number): Opening[] {
  const g = (pts: V2[], depth = 0.55): Opening => ({ pts, depth, fill: 'glass', reveal: 'trim' });
  switch (kind) {
    case 'slit': return [{ pts: rect(s, y, 0.16, 1.5), depth: 0.9, fill: 'void', reveal: 'trim' }];
    case 'loop': { // cruciform arrow loop as one outline (overlapping holes break triangulation)
      const a = 0.08, b = 0.31, y1 = y + 0.95, y2 = y + 1.1, top = y + 1.7;
      return [{ pts: [[s - a, y], [s + a, y], [s + a, y1], [s + b, y1], [s + b, y2], [s + a, y2], [s + a, top], [s - a, top], [s - a, y2], [s - b, y2], [s - b, y1], [s - a, y1]], depth: 0.9, fill: 'void', reveal: 'trim' }];
    }
    case 'lancet': return [g(pointedArch(s, y, 1.0, 2.4, 0.75))];
    case 'twin': return [g(pointedArch(s - 0.44, y, 0.66, 2.5, 0.55)), g(pointedArch(s + 0.44, y, 0.66, 2.5, 0.55))];
    case 'rect': return [g(rect(s - 0.36, y, 0.56, 1.75)), g(rect(s + 0.36, y, 0.56, 1.75))];
    case 'round': return [g(roundArch(s, y, 0.78, 1.25))];
    case 'small': return [g(rect(s, y, 0.62, 0.85), 0.45)];
  }
}

function windowDressing(B: Builder, r: Rng, f: Frame, kind: string, s: number, y: number, phase: 'old' | 'new', lights: WindowLight[]) {
  const w = OPEN_W[kind], h = OPEN_H[kind];
  if (kind !== 'slit' && kind !== 'loop') {
    // sill, slightly projecting and sloped
    boxOn(B, 'trim', f, s, y - 0.09, 0.09, w + 0.36, 0.18, 0.18);
    lights.push({ p: at(f, s, y + h / 2, -0.5), n: f.n, w, h });
  }
  // jamb stones (alternating long and short), proud of rubble walls, flush-ish on ashlar
  const proud = phase === 'old' ? 0.11 : 0.085; // proud of the real stones (rubble 5–9 cm, ashlar 4–6.5 cm)
  let yy = y, k = 0;
  const top = y + (kind === 'twin' || kind === 'lancet' ? h - 0.6 : h);
  while (yy < top - 0.05) {
    const sh = Math.min(top - yy, 0.32 + r() * 0.12), long = k % 2 === 0;
    const ww = long ? 0.42 : 0.26;
    for (const side of [-1, 1]) boxOn(B, 'trim', f, s + side * (w / 2 + ww / 2), yy + sh / 2, proud / 2, ww, sh - 0.012, proud);
    yy += sh; k++;
  }
  if (kind === 'rect' || kind === 'small') {
    boxOn(B, 'trim', f, s, y + h + 0.17, proud / 2, w + 0.5, 0.34, proud); // lintel
    if (phase === 'new' && kind === 'rect') { // hood mould with label stops
      boxOn(B, 'trim', f, s, y + h + 0.42, 0.08, w + 0.9, 0.12, 0.16);
      for (const side of [-1, 1]) boxOn(B, 'trim', f, s + side * (w / 2 + 0.4), y + h + 0.26, 0.08, 0.12, 0.34, 0.16);
    }
  }
  if (kind === 'lancet' || kind === 'twin' || kind === 'round') {
    // voussoirs following the head
    const pts = kind === 'round' ? roundArch(s, y, w + 0.02, h - w / 2) : kind === 'lancet' ? pointedArch(s, y, w + 0.02, 2.4, 0.75) : pointedArch(s, y, w + 0.3, 2.5, 0.85);
    const head = pts.slice(2, pts.length - 1);
    for (let i = 0; i < head.length - 1; i++) {
      const a = head[i], b = head[i + 1], m = lerp2(a, b, 0.5), d = norm(sub(b, a)), nrm: V2 = [-d[1], d[0]];
      const c = add(m, scale(nrm, -0.2));
      const L = len(sub(b, a)) - 0.02;
      // voussoir as a small box aligned to the arc in the wall plane
      const p = at(f, c[0], c[1], proud / 2);
      const along3: V3 = [f.r[0] * d[0], d[1], f.r[2] * d[0]];
      voussoir(B, p, along3, f.n, L, 0.42, proud);
    }
  }
}

/** A box with arbitrary in-plane rotation (for arch voussoirs). */
function voussoir(B: Builder, c: V3, along: V3, n: V3, L: number, H: number, D: number) {
  const al = Math.hypot(...along); const a: V3 = [along[0] / al, along[1] / al, along[2] / al];
  const up: V3 = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
  const P = (s: number, t: number, d: number): V3 => [c[0] + a[0] * s + up[0] * t + n[0] * d, c[1] + a[1] * s + up[1] * t + n[1] * d, c[2] + a[2] * s + up[2] * t + n[2] * d];
  const bin = B.bins.trim;
  const quad = (p: V3[], nn: V3) => { bin.tri(p[0], p[1], p[2], nn, [0, 0], [L / 2, 0], [L / 2, H / 2]); bin.tri(p[0], p[2], p[3], nn, [0, 0], [L / 2, H / 2], [0, H / 2]); };
  const hs = L / 2, ht = H / 2, hd = D / 2;
  B.exclude([P(-hs, -ht, -hd), P(hs, -ht, -hd), P(hs, ht, -hd), P(-hs, ht, -hd), P(-hs, -ht, hd), P(hs, -ht, hd), P(hs, ht, hd), P(-hs, ht, hd)]);
  quad([P(-hs, -ht, hd), P(hs, -ht, hd), P(hs, ht, hd), P(-hs, ht, hd)], n);
  quad([P(-hs, ht, -hd), P(hs, ht, -hd), P(hs, ht, hd), P(-hs, ht, hd)], up);
  quad([P(-hs, -ht, -hd), P(hs, -ht, -hd), P(hs, -ht, hd), P(-hs, -ht, hd)], [-up[0], -up[1], -up[2]]);
  quad([P(hs, -ht, -hd), P(hs, ht, -hd), P(hs, ht, hd), P(hs, -ht, hd)], a);
  quad([P(-hs, -ht, -hd), P(-hs, ht, -hd), P(-hs, ht, hd), P(-hs, -ht, hd)], [-a[0], -a[1], -a[2]]);
}

/** Corbel table + machicolated, crenellated parapet along a straight wall top. */
function corbelParapet(B: Builder, r: Rng, f: Frame, L: number, top: number, mat: MatKey, opts: { overhang?: number; merlon?: [number, number]; ext?: [number, number]; corbels?: boolean } = {}) {
  sil(B, () => corbelParapetInner(B, r, f, L, top, mat, opts));
}
function corbelParapetInner(B: Builder, r: Rng, f: Frame, L: number, top: number, mat: MatKey, opts: { overhang?: number; merlon?: [number, number]; ext?: [number, number]; corbels?: boolean }) {
  const oh = opts.overhang ?? 0.8, [mw, gap] = opts.merlon ?? [1.15, 0.72];
  const [e0, e1] = opts.ext ?? [0.6, 0.6];
  const s0 = -e0, s1 = L + e1, LL = s1 - s0;
  const yb = top - 0.38;
  if (opts.corbels !== false) {
    const n = Math.floor(LL / 0.95);
    for (let i = 0; i <= n; i++) {
      const s = s0 + (LL * i) / n;
      for (let k = 0; k < 3; k++) boxOn(B, 'trim', f, s, yb - 0.38 * (2.5 - k) + 0.01, (oh * (k + 1)) / 3 / 2, 0.42, 0.37, (oh * (k + 1)) / 3);
      if (i < n) {
        const sm = s + LL / n / 2;
        boxOn(B, 'void', f, sm, yb - 0.02, oh * 0.35, LL / n - 0.42, 0.02, oh * 0.6); // machicolation hole seen from below
      }
    }
  }
  // parapet wall
  const thick = 0.6;
  boxOn(B, mat, f, (s0 + s1) / 2, (yb + top + 1.05) / 2, oh - thick / 2 + 0.02, LL, top + 1.05 - yb, thick);
  if (oh > thick) boxOn(B, mat, f, (s0 + s1) / 2, yb + 0.06, (oh - thick) / 2, LL, 0.12, oh - thick + 0.02);
  // coping and merlons
  copingOn(B, r, f, s0 - 0.025, s1 + 0.025, top + 1.1, oh - thick / 2 + 0.02, 0.1, thick + 0.1);
  const m = Math.floor((LL + gap) / (mw + gap)), off = (LL - (m * (mw + gap) - gap)) / 2;
  for (let i = 0; i < m; i++) {
    if (r() < 0.035) continue; // a lost merlon here and there
    const s = s0 + off + i * (mw + gap) + mw / 2;
    const h = 1.25 + (r() - 0.5) * 0.14 - (r() < 0.05 ? 0.5 : 0);
    boxOn(B, mat, f, s, top + 1.15 + h / 2, oh - thick / 2 + 0.02, mw, h, thick);
    boxOn(B, 'trim', f, s, top + 1.15 + h + 0.05, oh - thick / 2 + 0.02, mw + 0.08, 0.1, thick + 0.08);
    if (r() < 0.4) boxOn(B, 'void', f, s, top + 1.15 + h * 0.48, oh + 0.03, 0.1, 0.75, 0.02);
  }
}

/** Corbelled, crenellated parapet ring for a round tower. */
function roundParapet(B: Builder, r: Rng, cx: number, cz: number, R: number, top: number, mat: MatKey, oh = 0.8) {
  sil(B, () => roundParapetInner(B, r, cx, cz, R, top, mat, oh));
}
function roundParapetInner(B: Builder, r: Rng, cx: number, cz: number, R: number, top: number, mat: MatKey, oh: number) {
  const n = Math.max(12, Math.round((2 * Math.PI * R) / 0.95));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, d: V2 = [Math.cos(a), Math.sin(a)];
    for (let k = 0; k < 3; k++) {
      const rr = R + (oh * (k + 1)) / 3 / 2 - 0.05;
      B.box('trim', [cx + d[0] * rr, top - 0.38 - 0.38 * (2.5 - k), cz + d[1] * rr], [(oh * (k + 1)) / 3 + 0.05, 0.37, 0.42], [d[0], d[1]]);
    }
    const am = ((i + 0.5) / n) * Math.PI * 2;
    B.box('void', [cx + Math.cos(am) * (R + oh * 0.35), top - 0.4, cz + Math.sin(am) * (R + oh * 0.35)], [oh * 0.6, 0.02, 0.4], [Math.cos(am), Math.sin(am)]);
  }
  const seg = Math.max(24, Math.round(R * 7));
  const circ = (rad: number): V2[] => Array.from({ length: seg }, (_, i) => [cx + Math.cos((i / seg) * Math.PI * 2) * rad, cz + Math.sin((i / seg) * Math.PI * 2) * rad]);
  B.ringPrism(mat, circ(R + oh), circ(R + oh - 0.6), top - 0.38, top + 1.05);
  B.ringPrism(mat, circ(R + oh - 0.55), circ(R - 0.2), top - 0.38, top - 0.26);
  B.ringPrism('trim', circ(R + oh + 0.05), circ(R + oh - 0.65), top + 1.05, top + 1.15, false);
  const mw = 1.05, gap = 0.7, Rm = R + oh - 0.3;
  const m = Math.floor((2 * Math.PI * Rm) / (mw + gap));
  for (let i = 0; i < m; i++) {
    if (r() < 0.03) continue;
    const a = (i / m) * Math.PI * 2, h = 1.2 + (r() - 0.5) * 0.12;
    const tan: V2 = [-Math.sin(a), Math.cos(a)];
    B.box(mat, [cx + Math.cos(a) * Rm, top + 1.15 + h / 2, cz + Math.sin(a) * Rm], [mw, h, 0.6], tan);
    B.box('trim', [cx + Math.cos(a) * Rm, top + 1.2 + h, cz + Math.sin(a) * Rm], [mw + 0.08, 0.1, 0.68], tan);
  }
}

/** Surface-mounted opening for curved walls: dark slit/window with a dressed surround. */
function curvedOpening(B: Builder, cx: number, cz: number, R: number, a: number, y: number, w: number, h: number, glass: boolean, lights: WindowLight[]) {
  const n: V2 = [Math.cos(a), Math.sin(a)], tan: V2 = [-Math.sin(a), Math.cos(a)];
  const p = (d: number): V3 => [cx + n[0] * (R + d), y + h / 2, cz + n[1] * (R + d)];
  B.curved.push({ c: [cx, cz], R, a, y, w, h, glass });
  B.box('trim', p(0.03), [w + 0.5, h + 0.5, 0.14], tan);
  B.box(glass ? 'glass' : 'void', p(0.11), [w, h, 0.02], tan);
  B.box('trim', [cx + n[0] * (R + 0.12), y - 0.1, cz + n[1] * (R + 0.12)], [w + 0.6, 0.16, 0.3], tan);
  if (glass) lights.push({ p: [cx + n[0] * R, y + h / 2, cz + n[1] * R], n: [n[0], 0, n[1]], w, h });
}

function stringCourse(B: Builder, poly: V2[], y: number, out = 0.13) {
  B.prism('trim', offsetPoly(poly, out), y, y + 0.26);
}

function quoins(B: Builder, r: Rng, corner: V2, d1: V2, d2: V2, y0: number, y1: number) {
  // alternating long and short dressed stones on a vertical corner, faces along d1 and d2
  let y = y0, k = 0;
  while (y < y1 - 0.2) {
    const h = Math.min(y1 - y, 0.36 + r() * 0.1), long = k % 2 === 0;
    const l1 = long ? 0.75 : 0.42, l2 = long ? 0.42 : 0.75;
    const c1 = add(corner, scale(d1, l1 / 2)), c2 = add(corner, scale(d2, l2 / 2));
    const n1: V2 = [d1[1], -d1[0]], n2: V2 = [-d2[1], d2[0]];
    const o1 = scale(n1, 0.055), o2 = scale(n2, 0.055);
    B.box('trim', [c1[0] + o1[0], y + h / 2, c1[1] + o1[1]], [l1, h - 0.012, 0.11], d1);
    B.box('trim', [c2[0] + o2[0], y + h / 2, c2[1] + o2[1]], [l2, h - 0.012, 0.11], d2);
    y += h; k++;
  }
}

// ---------------------------------------------------------------- wings

function wing(B: Builder, r: Rng, w: WingQuad, lights: WindowLight[], ctx: Ctx) {
  const mat: MatKey = w.phase;
  const [a, b, ib, ia] = w.quad;
  const L = w.length;
  const margin0 = w.a === 'A' ? 9.5 : 7.5, margin1 = w.b === 'A' ? 9.5 : 7.5;

  // bays: buttressed old wings put windows between buttresses
  const buttress: number[] = [];
  if (w.buttresses) { let s = margin0 + 1.5; while (s < L - margin1 - 1) { buttress.push(s); s += 5.6 + r() * 1.4; } }
  const bays: number[] = [];
  if (buttress.length > 1) for (let i = 0; i < buttress.length - 1; i++) bays.push((buttress[i] + buttress[i + 1]) / 2);
  else { const n = Math.floor((L - margin0 - margin1) / 4.2); for (let i = 0; i < n; i++) bays.push(margin0 + ((i + 0.5) * (L - margin0 - margin1)) / n); }

  const outerOpen: Opening[] = [], courtOpen: Opening[] = [];
  const outerF = wallFrame(a, b, w.out);
  const plans: { f: Frame; kind: string; s: number; y: number }[] = [];
  const wb = bands(BATTER_TOP + 0.2, w.phase === 'new' ? [floorBase(1) - 0.2, floorBase(4) - 0.15] : [floorBase(1) - 0.2], floorLines(1, 7), w.top - PARAPET_DROP);
  const outerFace: Face = { owner: w.id, a, b, out: w.out, bands: wb };
  const outerTaken: Box[] = buttress.map((s) => ({ s0: s - 1.0, s1: s + 1.0, y0: G0, y1: w.top })); // widest buttress foot
  const kindFor = (fl: number, old: boolean) => fl === 0 ? (old ? 'slit' : 'loop') : fl === 1 ? (old ? 'lancet' : 'twin') : fl === 6 ? 'small' : old ? 'round' : 'rect';
  bays.forEach((s0, bi) => {
    for (let fl = 0; fl < FLOOR_HEIGHTS.length; fl++) {
      const old = w.phase === 'old';
      if (fl === 0 && bi % 2 === 1) continue;
      if (r() < (old ? 0.16 : 0.08)) continue; // irregular: not every bay has a window
      const kind = kindFor(fl, old);
      const jit = old ? (r() - 0.5) * 0.9 : (r() - 0.5) * 0.25;
      const yb = floorBase(fl) + (fl === 0 ? 2.9 : fl === 1 ? 1.4 : 1.0) + (old ? (r() - 0.5) * 0.35 : 0);
      const blocked = r() < 0.06 && fl > 1; // blocked-up window: frame survives, filled with newer stone
      const p = place(ctx, outerFace, outerTaken, kind, s0 + jit, yb);
      if (!p) continue;
      const { s, y } = p;
      plans.push({ f: outerF, kind, s, y });
      if (blocked) boxOn(B, old ? 'new' : 'old', outerF, s, y + OPEN_H[kind] / 2 - 0.1, 0.015, OPEN_W[kind], OPEN_H[kind] - 0.2, 0.03);
      else outerOpen.push(...windowOpenings(kind as never, s, y));
    }
  });
  // courtyard side: more regular, larger windows (sheltered)
  const cL = Math.hypot(ia[0] - ib[0], ia[1] - ib[1]);
  const courtF = wallFrame(ib, ia, [-w.out[0], -w.out[1]]);
  const courtBands = [...wb.slice(0, -1), [w.top, w.top + 4] as [number, number]]; // plain parapet on the wall head
  const courtFace: Face = { owner: w.id, a: ib, b: ia, out: [-w.out[0], -w.out[1]], bands: courtBands }, courtTaken: Box[] = [];
  { const n = Math.max(1, Math.floor((cL - 4) / 3.6)); for (let i = 0; i < n; i++) for (let fl = 1; fl < 7; fl++) {
    if (r() < 0.1) continue;
    const s0 = 2 + ((i + 0.5) * (cL - 4)) / n + (r() - 0.5) * 0.3, kind = fl === 1 ? 'twin' : fl === 6 ? 'small' : 'rect';
    const p = place(ctx, courtFace, courtTaken, kind, s0, floorBase(fl) + (fl === 1 ? 1.4 : 1.0));
    if (p) { courtOpen.push(...windowOpenings(kind as never, p.s, p.y)); plans.push({ f: courtF, kind, s: p.s, y: p.y }); }
  } }

  B.wall(mat, a, b, w.out, G0, w.top, outerOpen);
  B.wall(mat, ib, ia, [-w.out[0], -w.out[1]], G0, w.top, courtOpen);
  // end walls (mostly hidden by neighbours and towers)
  const endOut = (p: V2, q: V2): V2 => { const d = norm(sub(q, p)); return [d[1], -d[0]]; };
  B.wall(mat, b, ib, endOut(b, ib), G0, w.top);
  B.wall(mat, ia, a, endOut(ia, a), G0, w.top);
  B.cap('lead', [a, b, ib, ia], w.top - 0.3, true);
  for (const p of plans) windowDressing(B, r, p.f, p.kind, p.s, p.y, w.phase, lights);

  // battered plinth on the outer face and the (buried) ends; the courtyard face (edge 2, ib → ia) rises
  // straight from the paving: a batter there was carved away along the faces but left a leaning slab
  // where the carve stops short of the stair tower. Its plinth course stays inside the wall there too.
  B.loft(mat, offsetPoly(w.quad, [1.1, 1.1, 0, 1.1]), G0, w.quad, BATTER_TOP, [2]);
  B.prism('trim', offsetPoly(w.quad, [0.08, 0.08, -0.2, 0.08]), BATTER_TOP - 0.05, BATTER_TOP + 0.2);
  // string courses over the undercroft and under the top floor
  stringCourse(B, w.quad, floorBase(1) - 0.2);
  if (w.phase === 'new') stringCourse(B, w.quad, floorBase(4) - 0.15, 0.1);

  // buttresses with set-offs and blind pointed arches between their heads (Gravensteen)
  if (w.buttresses) sil(B, () => {
    const headY = w.top - 3.2;
    for (const s of buttress) {
      const bw = 1.5 + r() * 0.2;
      boxOn(B, mat, outerF, s, (G0 + headY) / 2, 0.55, bw, headY - G0, 1.1);
      boxOn(B, mat, outerF, s, (G0 + GROUND + 8) / 2, 1.0, bw + 0.3, GROUND + 8 - G0, 2.0);
      // sloped weatherings
      setOff(B, mat, outerF, s, GROUND + 8, bw + 0.3, 2.0, 1.1, 0.9);
      boxOn(B, 'trim', outerF, s, BATTER_TOP + 0.1, 1.05, bw + 0.42, 0.25, 2.12);
    }
    for (let i = 0; i < buttress.length - 1; i++) {
      const s0 = buttress[i] + 0.8, s1 = buttress[i + 1] - 0.8, span = s1 - s0, cx = (s0 + s1) / 2;
      const pts = pointedArch(cx, headY - 2.2, span, 2.2, span * 0.45, 8).slice(2, -1);
      for (let k = 0; k < pts.length - 1; k++) {
        const p = pts[k], q = pts[k + 1], m = lerp2(p, q, 0.5), d = norm(sub(q, p));
        voussoirMat(B, mat, at(outerF, m[0], m[1] - 0.25, 0.4), [outerF.r[0] * d[0], d[1], outerF.r[2] * d[0]], outerF.n, len(sub(q, p)) + 0.05, 0.6, 0.8);
      }
      // spandrel infill above the arch, flush with buttress faces
      boxOn(B, mat, outerF, cx, headY + (w.top - 0.4 - headY) / 2 + 0.25, 0.4, span + 1.6, w.top - 0.4 - headY - 0.5, 0.8);
    }
  });

  corbelParapet(B, r, outerF, L, w.top, mat, { ext: [0.8, 0.8] });
  // courtyard side: plain parapet on the wall head
  sil(B, () => boxOn(B, mat, courtF, cL / 2, w.top + 0.55, -0.3, cL, 1.1, 0.55));
  copingOn(B, r, courtF, -0.025, cL + 0.025, w.top + 1.15, -0.3, 0.1, 0.65);

  // roofs
  if (w.roof === 'gable') hipRoof(B, r, w);
  chimneys(B, r, w);
}

function setOff(B: Builder, mat: MatKey, f: Frame, s: number, y: number, bw: number, d0: number, d1: number, h: number) {
  // sloped weathering from depth d0 at y to d1 at y + h
  const q = (dd: number, yy: number, ss: number) => at(f, ss, yy, dd);
  const pts0: V2[] = [], pts1: V2[] = [];
  for (const [ss, dd] of [[s - bw / 2, 0], [s + bw / 2, 0], [s + bw / 2, d0], [s - bw / 2, d0]] as V2[]) { const p = q(dd, y, ss); pts0.push([p[0], p[2]]); }
  for (const [ss, dd] of [[s - bw / 2, 0], [s + bw / 2, 0], [s + bw / 2, d1], [s - bw / 2, d1]] as V2[]) { const p = q(dd, y + h, ss); pts1.push([p[0], p[2]]); }
  B.loft(mat, pts0, y, pts1, y + h);
}

function voussoirMat(B: Builder, mat: MatKey, c: V3, along: V3, n: V3, L: number, H: number, D: number) {
  const save = B.bins.trim; (B.bins as Record<string, unknown>).trim = B.bins[mat];
  voussoir(B, c, along, n, L, H, D);
  (B.bins as Record<string, unknown>).trim = save;
}

function hipRoof(B: Builder, r: Rng, w: WingQuad) {
  const base = offsetPoly(w.quad, -0.95); // [outerA, outerB, innerB, innerA]
  const [P0, P1, P2, P3] = base;
  const y = w.top + 0.15;
  const depth = len(sub(lerp2(P0, P1, 0.5), lerp2(P3, P2, 0.5)));
  const rise = (depth / 2) * Math.tan((52 * Math.PI) / 180);
  const M0 = lerp2(P0, P3, 0.5), M1 = lerp2(P1, P2, 0.5);
  const d = norm(sub(M1, M0)), hd = depth / 2;
  const R0 = add(M0, scale(d, hd)), R1 = add(M1, scale(d, -hd));
  const v = (p: V2, yy: number): V3 => [p[0], yy, p[1]];
  B.roofPlane('slate', [v(P0, y), v(P1, y), v(R1, y + rise), v(R0, y + rise)]);
  B.roofPlane('slate', [v(P2, y), v(P3, y), v(R0, y + rise), v(R1, y + rise)]);
  B.roofPlane('slate', [v(P1, y), v(P2, y), v(R1, y + rise)]);
  B.roofPlane('slate', [v(P3, y), v(P0, y), v(R0, y + rise)]);
  B.box('lead', [(R0[0] + R1[0]) / 2, y + rise + 0.05, (R0[1] + R1[1]) / 2], [len(sub(R1, R0)) + 0.3, 0.18, 0.32], d);
  // a few dormers on the courtyard slope
  const n = 2 + Math.floor(r() * 2);
  for (let i = 0; i < n; i++) {
    const t = 0.25 + (0.5 * (i + 0.5)) / n + (r() - 0.5) * 0.05;
    const e = lerp2(P3, P2, t), m = lerp2(R0, R1, t);
    const p = lerp2(e, m, 0.35), yy = y + rise * 0.35;
    const out = norm(sub(e, m));
    const f = wallFrame(add(p, scale(d, -0.8)), add(p, scale(d, 0.8)), out);
    B.wall('trim', add(p, scale(d, -0.8)), add(p, scale(d, 0.8)), out, yy - 0.4, yy + 1.4, [{ pts: rect(0.8, yy, 0.7, 1.05), depth: 0.3, fill: 'glass', reveal: 'trim' }]);
    for (const side of [-1, 1]) {
      const a0 = add(p, scale(d, side * 0.8));
      B.roofPlane('slate', [v(a0, yy + 1.4), v(add(a0, scale(out, -2.2)), yy + 1.4), v(add(p, scale(out, -2.2)), yy + 2.3), v(p, yy + 2.3)]);
      B.wall('slate', add(a0, scale(out, -2.2)), a0, scale(d, side) as V2, yy - 0.4, yy + 1.4);
    }
    void f;
  }
}

function chimneys(B: Builder, r: Rng, w: WingQuad) {
  const n = w.roof === 'gable' ? 3 : 2;
  const [a, b] = w.quad;
  for (let k = 0; k < n; k++) {
    const t = 0.22 + (0.56 * k) / Math.max(1, n - 1) + (r() - 0.5) * 0.08;
    const onOuter = r() < 0.5;
    const p = add(lerp2(a, b, t), scale(w.out, -(onOuter ? 1.6 : w.depth * 0.5)));
    const h = (w.roof === 'gable' ? w.depth * 0.5 * 1.28 + 2 : 3.5) + r() * 2.2;
    const wv: V2 = w.dir;
    const mat: MatKey = w.phase;
    sil(B, () => B.box(mat, [p[0], w.top + h / 2 - 0.5, p[1]], [1.5, h + 1, 1.0], wv));
    B.box('trim', [p[0], w.top + h + 0.1, p[1]], [1.75, 0.22, 1.25], wv);
    for (const s of [-0.38, 0.38]) B.cyl('trim', p[0] + wv[0] * s, p[1] + wv[1] * s, 0.17, 0.14, w.top + h + 0.2, w.top + h + 0.75, 10, { top: 'void' });
  }
}

// ---------------------------------------------------------------- towers

function towerFloors(top: number) {
  const ys: number[] = [];
  for (let f = 0; f < 7; f++) ys.push(floorBase(f));
  let y = floorBase(7); while (y < top - 4.5) { ys.push(y); y += 4.4; }
  return ys;
}

function squareTower(B: Builder, r: Rng, t: Extract<TowerSpec, { kind: 'square' }>, lights: WindowLight[], ctx: Ctx) {
  const mat: MatKey = t.phase;
  const poly = squareTowerPoly(t); // corners in order; may be CW or CCW — fix to the wing winding
  const p = signedOrder(poly);
  const floors = towerFloors(t.top);
  const tb = bands(BATTER_TOP + 1.2, [floorBase(2) - 0.2, floorBase(7) - 0.2], floors.slice(1), t.top - PARAPET_DROP);
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4], L = len(sub(b, a)), d = norm(sub(b, a)), out: V2 = [d[1], -d[0]];
    const f = wallFrame(a, b, out), face: Face = { owner: t.id, a, b, out, bands: tb }, taken: Box[] = [];
    const ops: Opening[] = [], plans: { kind: string; s: number; y: number }[] = [];
    floors.forEach((y, fl) => {
      const kind = fl === 0 ? 'loop' : fl === 1 ? 'lancet' : fl >= floors.length - 1 ? 'small' : fl % 3 === 0 ? 'lancet' : 'round';
      const count = L > 11 && fl > 0 && fl % 2 === 0 ? 2 : 1;
      for (let c = 0; c < count; c++) {
        if (r() < 0.12) continue;
        const s0 = count === 1 ? L / 2 + (r() - 0.5) * 1.2 : L * (c === 0 ? 0.3 : 0.7) + (r() - 0.5) * 0.5;
        const q = place(ctx, face, taken, kind, s0, y + (fl === 0 ? 2.9 : 1.2));
        if (q) { ops.push(...windowOpenings(kind as never, q.s, q.y)); plans.push({ kind, ...q }); }
      }
    });
    B.wall(mat, a, b, out, G0, t.top, ops);
    for (const q of plans) windowDressing(B, r, f, q.kind, q.s, q.y, t.phase, lights);
    corbelParapet(B, r, f, L, t.top, mat, { ext: [0.85, 0.85] });
    quoins(B, r, a, d, norm(sub(p[(i + 3) % 4], a)), BATTER_TOP + 0.2, t.top - 2.5);
  }
  B.cap('lead', p, t.top - 0.3, true);
  B.loft(mat, offsetPoly(p, 1.4), G0, p, BATTER_TOP + 1);
  B.prism('trim', offsetPoly(p, 0.1), BATTER_TOP + 0.95, BATTER_TOP + 1.2);
  stringCourse(B, p, floorBase(2) - 0.2);
  stringCourse(B, p, floorBase(7) - 0.2);

  const c = towerCentre(t);
  if (t.bartizans) sil(B, () => {
    const oc = offsetPoly(p, 0.85);
    for (const q of oc) {
      const dd = norm(sub(q, c)), bc = add(q, scale(dd, 0.35));
      B.cyl('trim', bc[0], bc[1], 0.25, 1.35, t.top - 5.0, t.top - 1.0, 20, { top: null });
      B.cyl(mat, bc[0], bc[1], 1.3, 1.3, t.top - 1.0, t.top + 3.2, 20, { top: null });
      B.cyl('trim', bc[0], bc[1], 1.42, 1.42, t.top + 3.2, t.top + 3.45, 20, { top: null });
      B.cone('slate', bc[0], bc[1], 1.55, t.top + 3.4, 3.8, 20, 0.12);
      for (let k = 0; k < 2; k++) { const aa = Math.atan2(dd[1], dd[0]) + (k - 0.5) * 1.3; curvedOpening(B, bc[0], bc[1], 1.3, aa, t.top + 0.8, 0.12, 1.0, false, lights); }
    }
  });
  if (t.capHouse) {
    const hw = 2.4, hd = 2.0, cy = t.top;
    const ax = norm([Math.cos(t.rot), Math.sin(t.rot)]);
    const hc = add(c, scale(ax, 1.5));
    sil(B, () => B.box(mat, [hc[0], cy + 2.2, hc[1]], [hw * 2, 4.4, hd * 2], ax));
    const v = (pp: V2, yy: number): V3 => [pp[0], yy, pp[1]];
    const nx: V2 = [ax[1], -ax[0]];
    const e = (sx: number, sz: number) => add(hc, add(scale(ax, sx), scale(nx, sz)));
    const ry = cy + 4.4, rh = 2.6;
    B.roofPlane('slate', [v(e(-hw - 0.2, -hd - 0.3), ry), v(e(hw + 0.2, -hd - 0.3), ry), v(e(hw + 0.2, 0), ry + rh), v(e(-hw - 0.2, 0), ry + rh)]);
    B.roofPlane('slate', [v(e(hw + 0.2, hd + 0.3), ry), v(e(-hw - 0.2, hd + 0.3), ry), v(e(-hw - 0.2, 0), ry + rh), v(e(hw + 0.2, 0), ry + rh)]);
    for (const sx of [-hw, hw]) { const bin = B.bins[mat]; const n3: V3 = [ax[0] * Math.sign(sx), 0, ax[1] * Math.sign(sx)]; bin.tri(v(e(sx, -hd), ry), v(e(sx, hd), ry), v(e(sx, 0), ry + rh), n3, [0, 0], [hd / 2, 0], [hd / 4, rh / 4]); }
    // flagpole
    B.cyl('wood', c[0] - ax[0] * 3, c[1] - ax[1] * 3, 0.09, 0.06, cy, cy + 9, 8, { top: null });
  }
}

function signedOrder(poly: V2[]): V2[] {
  let s = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s < 0 ? [...poly].reverse() : poly;
}

function roundTower(B: Builder, r: Rng, t: Extract<TowerSpec, { kind: 'round' }>, lights: WindowLight[], ctx: Ctx) {
  const mat: MatKey = t.phase;
  const [cx, cz] = towerCentre(t);
  const R = t.r, seg = 48;
  B.cyl(mat, cx, cz, R + 1.5, R, G0, BATTER_TOP + 1.4, seg, { top: null });
  B.cyl('trim', cx, cz, R + 0.12, R + 0.12, BATTER_TOP + 1.3, BATTER_TOP + 1.56, seg);
  B.cyl(mat, cx, cz, R, R, BATTER_TOP + 1.4, t.top - 0.3, seg, { top: 'lead' });
  for (const y of [floorBase(2) - 0.2, floorBase(5) - 0.2]) B.cyl('trim', cx, cz, R + 0.13, R + 0.13, y, y + 0.26, seg, { top: null });
  // openings: a stair spiral of slits plus windows on the outward side; each stays at its angle
  // (the face is the tangent strip there) and is left out where a wing or the batter would clip it
  const rb = bands(BATTER_TOP + 1.56, [floorBase(2) - 0.2, floorBase(5) - 0.2], [], t.top - PARAPET_DROP);
  const drum = (a: number, y: number, w: number, h: number, glass: boolean) => {
    const n: V2 = [Math.cos(a), Math.sin(a)], tan: V2 = [-n[1], n[0]], o: V2 = [cx + n[0] * R, cz + n[1] * R];
    const d: Dressed = { hw: w / 2 + 0.3, below: 0.25, above: h + 0.25 }, half = d.hw + 0.81; // trim surround and sill
    const q = place(ctx, { owner: t.id, a: add(o, scale(tan, -half)), b: add(o, scale(tan, half)), out: n, bands: rb }, [], glass ? 'window' : 'slit', half, y, d, 0);
    if (q) curvedOpening(B, cx, cz, R, a, q.y, w, h, glass, lights);
  };
  const outward = Math.atan2(cz, cx);
  let a = outward - 1.2;
  for (let y = GROUND + 4; y < t.top - 4; y += 2.6) { drum(a, y, 0.13, 1.25, false); a += 0.75; }
  towerFloors(t.top).forEach((y, fl) => {
    if (fl < 2) return;
    for (const off of [-0.5, 0.55]) { if (r() < 0.3) continue; drum(outward + off + (r() - 0.5) * 0.15, y + 1.2, 0.62, fl % 2 ? 1.5 : 1.15, true); }
  });
  roundParapet(B, r, cx, cz, R, t.top, mat);
  if (t.cone > 0) {
    B.cyl(mat, cx, cz, R - 0.25, R - 0.25, t.top - 0.3, t.top + 2.2, seg, { top: null });
    B.cyl('trim', cx, cz, R - 0.1, R - 0.1, t.top + 2.2, t.top + 2.45, seg, { top: null });
    B.cone('slate', cx, cz, R + 0.15, t.top + 2.4, t.cone, seg, 0.14);
    B.cyl('iron', cx, cz, 0.06, 0.03, t.top + 2.4 + t.cone - 0.3, t.top + 2.4 + t.cone + 2.0, 6, { top: null });
  }
  if (t.stairTurret) {
    const sa = Math.atan2(-cz, -cx) + 0.9; // toward the castle centre, rotated
    const sc: V2 = [cx + Math.cos(sa) * (R - 0.6), cz + Math.sin(sa) * (R - 0.6)];
    const top2 = t.top + 5.2;
    sil(B, () => B.cyl(mat, sc[0], sc[1], 2.1, 2.1, t.top - 6, top2 - 0.3, 28, { top: 'lead' }));
    roundParapet(B, r, sc[0], sc[1], 2.1, top2, mat, 0.55);
    for (let y = t.top - 3; y < top2 - 2; y += 2.4) curvedOpening(B, sc[0], sc[1], 2.1, sa + (y % 3), y, 0.12, 1.0, false, lights);
    B.cyl('wood', sc[0], sc[1], 0.09, 0.06, top2, top2 + 8, 8, { top: null });
  }
}

// ---------------------------------------------------------------- gatehouse, turret, stair tower

function gatehouse(B: Builder, r: Rng, lights: WindowLight[], ctx: Ctx) {
  const g = gatehouseFrame();
  const hw = GATEHOUSE.width / 2, P = GATEHOUSE.project, top = GATEHOUSE.top;
  const at2 = (s: number, d: number): V2 => add(add(g.base, scale(g.dir, s)), scale(g.out, d));
  const poly: V2[] = [at2(-hw, -1), at2(hw, -1), at2(hw, P), at2(-hw, P)];
  const p = signedOrder(poly);
  // front face with the gate arch
  const fa = at2(-hw, P), fb = at2(hw, P);
  const f = wallFrame(fa, fb, g.out);
  // the gate is the plan's gate-main door: it cuts this face (Builder.doorHoles); its voussoirs follow GATE
  const gateW = GATE.width, gateY = GATE.sill, archH = GATE.spring;
  // gate arch with its voussoirs, heraldic panel and bretèche are taken; floors 0–1 are the vaulted passage
  const face: Face = { owner: 'gate', a: fa, b: fb, out: g.out, bands: bands(BATTER_TOP, [floorBase(1) + 1.6], floorLines(2, 7), top - PARAPET_DROP) };
  const taken: Box[] = [{ s0: hw - gateW / 2 - 0.8, s1: hw + gateW / 2 + 0.8, y0: G0, y1: gateY + archH + 0.8 }, { s0: hw - 0.8, s1: hw + 0.8, y0: gateY + archH + 1.9, y1: gateY + archH + 3.9 }, { s0: hw - 1.45, s1: hw + 1.45, y0: floorBase(2) - 2.6, y1: floorBase(2) - 1.0 }];
  const ops: Opening[] = []; // the gate's portcullis and its groove: interior/portcullis.ts, shell.ts
  const plans: { kind: string; s: number; y: number }[] = [];
  for (const [kind, s0, y0] of [['twin', hw, floorBase(2) + 1.2], ['rect', hw, floorBase(4) + 1.0], ['small', hw, floorBase(6) + 1.1], ['slit', hw - 3.3, GROUND + 5.2], ['slit', hw + 3.3, GROUND + 5.2]] as [string, number, number][]) {
    const q = place(ctx, face, taken, kind, s0, y0);
    if (q) { ops.push(...windowOpenings(kind as never, q.s, q.y)); if (kind !== 'slit') plans.push({ kind, ...q }); }
  }
  B.wall('new', fa, fb, g.out, G0, top, ops);
  for (const q of plans) windowDressing(B, r, f, q.kind, q.s, q.y, 'new', lights);
  // side faces
  for (const [a, b] of [[p[1], p[2]], [p[3], p[0]]] as [V2, V2][]) { const d = norm(sub(b, a)); B.wall('new', a, b, [d[1], -d[0]], G0, top); }
  B.cap('lead', p, top - 0.3, true);
  // gate voussoirs and hood
  const head = pointedArch(hw, gateY, gateW + 0.05, archH, GATE.rise + 0.02, 10).slice(2, -1);
  for (let i = 0; i < head.length - 1; i++) {
    const a = head[i], b = head[i + 1], m = lerp2(a, b, 0.5), d = norm(sub(b, a)), nrm: V2 = [-d[1], d[0]];
    const c = add(m, scale(nrm, -0.32));
    voussoir(B, at(f, c[0], c[1], 0.05), [f.r[0] * d[0], d[1], f.r[2] * d[0]], f.n, len(sub(b, a)) - 0.025, 0.66, 0.1);
  }
  // heraldic panel and bretèche (box machicolation) over the gate
  boxOn(B, 'trim', f, hw, gateY + archH + 2.9, 0.05, 1.5, 1.9, 0.1);
  for (const s of [hw - 1.2, hw, hw + 1.2]) for (let k = 0; k < 3; k++) boxOn(B, 'trim', f, s, floorBase(2) - 2.4 + k * 0.38, 0.2 * (k + 1), 0.4, 0.37, 0.4 * (k + 1));
  // gatehouse top
  corbelParapet(B, r, f, 2 * hw, top, 'new', { ext: [0.6, 0.6] });
  gatehouseBatter(B, g, p, P, gateW);
  stringCourse(B, p, floorBase(1) + 1.6);
  // corbelled corner turrets on the gatehouse front (Gravensteen-style), no full-height drums
  for (const sgn of [-1, 1]) {
    const c = add(at2(sgn * (hw + 0.2), P + 0.2), [0, 0]);
    B.cyl('trim', c[0], c[1], 0.5, 1.55, top - 3.6, top - 1.4, 20, { top: null });
    for (let k = 0; k < 3; k++) B.cyl('trim', c[0], c[1], 0.62 + k * 0.3, 0.62 + k * 0.3, top - 3.5 + k * 0.7, top - 3.25 + k * 0.7, 20);
    sil(B, () => B.cyl('new', c[0], c[1], 1.5, 1.5, top - 1.4, top + 3.6, 20, { top: null }));
    B.cyl('trim', c[0], c[1], 1.62, 1.62, top + 3.6, top + 3.85, 20, { top: null });
    B.cone('slate', c[0], c[1], 1.75, top + 3.8, 4.6, 20, 0.12);
    const oa = Math.atan2(g.out[1], g.out[0]) + sgn * 0.6;
    curvedOpening(B, c[0], c[1], 1.5, oa, top + 0.9, 0.13, 1.1, false, lights);
  }
  // steps down from the gate threshold
  for (let k = 0; k < 3; k++) { const c = at2(hw - hw, P + 0.5 + k * 0.45); B.box('trim', [c[0], GROUND - 0.15 - k * 0.17, c[1]], [gateW + 1.6 + k * 0.6, 0.3, 0.5], g.dir); }
}

/** The gatehouse's battered plinth, with the gate passage cut through it so you can walk in. */
function gatehouseBatter(B: Builder, g: ReturnType<typeof gatehouseFrame>, p: V2[], P: number, gateW: number) {
  const sd = (q: V2) => { const d = sub(q, g.base); return [d[0] * g.dir[0] + d[1] * g.dir[1], d[0] * g.out[0] + d[1] * g.out[1]]; };
  const pt = (s: number, d: number): V2 => add(add(g.base, scale(g.dir, s)), scale(g.out, d));
  // split the front edge at the gate jambs so the gap is its own quad
  const inner: V2[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    inner.push(a);
    const [sa, da] = sd(a), [sb, db] = sd(b);
    if (Math.abs(da - P) < 1e-6 && Math.abs(db - P) < 1e-6) for (const s of sa < sb ? [-gateW / 2, gateW / 2] : [gateW / 2, -gateW / 2]) inner.push(pt(s, P));
  }
  const T = new Builder();
  T.loft('new', offsetPoly(inner, 1.2), G0, inner, BATTER_TOP);
  const src = T.bins.new, dst = B.bins.new;
  for (let i = 0; i < src.pos.length; i += 9) {
    const c: V2 = [(src.pos[i] + src.pos[i + 3] + src.pos[i + 6]) / 3, (src.pos[i + 2] + src.pos[i + 5] + src.pos[i + 8]) / 3];
    const [s, d] = sd(c);
    if (Math.abs(s) < gateW / 2 - 1e-3 && d > P - 0.01) continue; // the gap
    dst.pos.push(...src.pos.slice(i, i + 9)); dst.nor.push(...src.nor.slice(i, i + 9)); dst.uv.push(...src.uv.slice((i / 9) * 6, (i / 9) * 6 + 6));
  }
  // cheeks closing the plinth either side of the gap
  for (const sg of [-1, 1]) {
    const s = (sg * gateW) / 2, o = pt(s, P + 1.2), q = pt(s, P);
    dst.tri([o[0], G0, o[1]], [q[0], BATTER_TOP, q[1]], [q[0], G0, q[1]], [-sg * g.dir[0], 0, -sg * g.dir[1]], [0, G0 / 4], [1.2 / 4, BATTER_TOP / 4], [1.2 / 4, G0 / 4]);
  }
}

function eastTurret(B: Builder, r: Rng, lights: WindowLight[], ctx: Ctx) {
  const e = eastTurretFrame();
  const hw = EAST_TURRET.w / 2, P = EAST_TURRET.project, top = EAST_TURRET.top;
  const at2 = (s: number, d: number): V2 => add(add(e.base, scale(e.dir, s)), scale(e.out, d));
  const p = signedOrder([at2(-hw, -0.5), at2(hw, -0.5), at2(hw, P), at2(-hw, P)]);
  const fa = at2(-hw, P), fb = at2(hw, P), f = wallFrame(fa, fb, e.out);
  const ops: Opening[] = [], plans: { kind: string; s: number; y: number }[] = [];
  const face: Face = { owner: 'eturret', a: fa, b: fb, out: e.out, bands: bands(BATTER_TOP, [], floorLines(1, 7), top - 3.6) }, taken: Box[] = [];
  for (let fl = 1; fl < 7; fl++) {
    const kind = fl === 3 ? 'lancet' : fl === 1 ? 'slit' : 'small';
    const q = place(ctx, face, taken, kind, hw, floorBase(fl) + 1.2);
    if (q) { ops.push(...windowOpenings(kind as never, q.s, q.y)); plans.push({ kind, ...q }); }
  }
  B.wall('new', fa, fb, e.out, G0, top, ops);
  for (const q of plans) windowDressing(B, r, f, q.kind, q.s, q.y, 'new', lights);
  for (const [a, b] of [[p[1], p[2]], [p[3], p[0]]] as [V2, V2][]) { const d = norm(sub(b, a)); B.wall('new', a, b, [d[1], -d[0]], G0, top); }
  B.loft('new', offsetPoly(p, 0.9), G0, p, BATTER_TOP);
  // corbelled-out top storey with a pyramid roof
  const q = offsetPoly(p, 0.45);
  B.prism('trim', offsetPoly(p, 0.2), top - 3.6, top - 3.3);
  B.prism('trim', q, top - 3.3, top - 3.0);
  sil(B, () => B.prism('new', q, top - 3.0, top + 0.6, { top: 'lead' }));
  const cc: V2 = [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2];
  const v = (pp: V2, yy: number): V3 => [pp[0], yy, pp[1]];
  const eave = offsetPoly(q, 0.3);
  for (let i = 0; i < 4; i++) B.roofPlane('slate', [v(eave[i], top + 0.6), v(eave[(i + 1) % 4], top + 0.6), v(cc, top + 6.5)]);
  B.cap('slate', eave, top + 0.6, false); // soffit under the overhang
  B.cyl('iron', cc[0], cc[1], 0.05, 0.03, top + 6.3, top + 7.8, 6, { top: null });
}

function stairTower(B: Builder, r: Rng, ctx: Ctx) {
  const c = stairTowerCentre();
  const n = STAIR_TOWER.sides, top = STAIR_TOWER.top;
  const p = signedOrder(stairTowerPoly());
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n], d = norm(sub(b, a)), out: V2 = [d[1], -d[0]], L = len(sub(b, a));
    const ops: Opening[] = [], face: Face = { owner: 'stairtower', a, b, out, bands: [] }, taken = withDoors(ctx, face, []);
    // a spiral of slits, each where it fits (openings.ts) on its 2.2 m facet: open air in front, off the doors
    for (let y = GROUND + 2.5 + i * 0.55; y < top - 3; y += n * 0.55) {
      const box = boxOf(dressed('slit'), L / 2, y);
      if (fits(face, ctx.others, taken, box, 0.05)) { taken.push(box); ops.push({ pts: rect(L / 2, y, 0.14, 1.1), depth: 0.6, fill: 'void', reveal: 'trim' }); }
    }
    B.wall('new', a, b, out, G0, top, ops);
  }
  const op = offsetPoly(p, 0.45);
  B.prism('trim', offsetPoly(p, 0.2), top - 0.6, top - 0.3);
  sil(B, () => B.prism('new', op, top - 0.3, top + 1.0));
  const v = (pp: V2, yy: number): V3 => [pp[0], yy, pp[1]];
  const eave = offsetPoly(op, 0.25);
  for (let i = 0; i < n; i++) B.roofPlane('slate', [v(eave[i], top + 1.0), v(eave[(i + 1) % n], top + 1.0), v(c, top + 9.5)]);
  B.cap('slate', eave, top + 1.0, false); // soffit under the overhang
  B.cyl('iron', c[0], c[1], 0.05, 0.03, top + 9.3, top + 11, 6, { top: null });
  void r;
}

function courtyardDressing(B: Builder) {
  buildPaving(B);
  const wc = wellCentre(), y = GROUND;
  B.cyl('trim', wc[0], wc[1], 1.0, 1.0, y - 0.5, y + 0.85, 20, { top: null });
  B.cyl('trim', wc[0], wc[1], 0.72, 0.72, y - 0.5, y + 0.85, 20, { top: null, inward: true });
  B.cap('void', Array.from({ length: 16 }, (_, i) => [wc[0] + Math.cos((i / 16) * Math.PI * 2) * 0.75, wc[1] + Math.sin((i / 16) * Math.PI * 2) * 0.75] as V2), y + 0.5, true);
  B.ringPrism('trim', Array.from({ length: 20 }, (_, i) => [wc[0] + Math.cos((i / 20) * Math.PI * 2) * 1.05, wc[1] + Math.sin((i / 20) * Math.PI * 2) * 1.05] as V2), Array.from({ length: 20 }, (_, i) => [wc[0] + Math.cos((i / 20) * Math.PI * 2) * 0.7, wc[1] + Math.sin((i / 20) * Math.PI * 2) * 0.7] as V2), y + 0.85, y + 1.0, false);
  for (const s of [-1, 1]) B.box('wood', [wc[0] + s * 0.95, y + 1.9, wc[1]], [0.14, 2.2, 0.14]);
  B.box('wood', [wc[0], y + 2.9, wc[1]], [2.2, 0.16, 0.16]);
  // the windlass between the posts: an oak roller with a few turns of rope on it, the rope down to a
  // hooped bucket hanging over the shaft, and an iron crank through the east post
  B.box('wood', [wc[0], y + 2.15, wc[1]], [1.76, 0.2, 0.2]);
  B.box('wood', [wc[0] - 0.1, y + 2.15, wc[1]], [0.5, 0.235, 0.235]);
  B.box('wood', [wc[0] + 0.05, y + 1.69, wc[1] + 0.11], [0.035, 0.9, 0.035]);
  B.cyl('wood', wc[0] + 0.05, wc[1] + 0.11, 0.15, 0.17, y + 0.98, y + 1.26, 12, { top: null });
  B.cyl('wood', wc[0] + 0.05, wc[1] + 0.11, 0.135, 0.135, y + 1.0, y + 1.02, 12);
  for (const h of [1.04, 1.21]) B.cyl('iron', wc[0] + 0.05, wc[1] + 0.11, 0.155 + (h - 0.98) * 0.07, 0.157 + (h - 0.98) * 0.07, y + h, y + h + 0.025, 12, { top: null });
  B.box('iron', [wc[0] + 0.05, y + 1.32, wc[1] + 0.11], [0.3, 0.02, 0.02]);
  B.box('iron', [wc[0] + 1.1, y + 2.15, wc[1]], [0.18, 0.04, 0.04]);
  B.box('iron', [wc[0] + 1.17, y + 1.98, wc[1]], [0.04, 0.38, 0.04]);
  B.box('iron', [wc[0] + 1.26, y + 1.8, wc[1]], [0.22, 0.04, 0.04]);
}
