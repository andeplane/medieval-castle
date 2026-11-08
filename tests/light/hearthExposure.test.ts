// Anders, 2026-11-08 (?furniture=1): rooms with a fireplace looked washed out and flickering. Measured then
// (#71) 1.5 m from the hall's and a study's hearth: scene-pass HDR mean ≈ 1.1, p99 6.6-9.8, eye adaptation
// pinned at its floor and 21-23 % of the pixels over white. This is the same read-back done without a
// browser, over every room of the castle that has a hearth or three or more fires, from the two poses the
// browser probe uses: 1.5 m in front of each hearth looking into its fire, and the room's doorway looking
// into the room.
//
// The view is the room's shell (floor, walls, ceiling) through the game camera (55°, 16:9): each ray's
// surface gets its room's fires as the shader sums them (roomFires → fireAt, the shader's falloff) plus the
// readability floor, and leaves as EFFECTIVE_ALBEDO × E / π. Eye adaptation is the controller's own maths
// (centre-weighted mean log2 → targetStops → exposure). Daylight, furniture and the flames themselves are
// left out: daylight only lowers exposure, and the flames are small. The albedo is calibrated against the
// headless WebGL2 read-back of main (f98c864), whose HDR means it reproduces within 5 %:
//   hall N1-2, 1.5 m from the hooded hearth: browser 0.120, here 0.125
//   guard room N0-0 from its doorway:       browser 0.061, here 0.062
//
// Also the flicker the fires put on the walls: the room's fires each wavering by their own seed (the flicker
// the fire table writes every frame), summed on the wall beside the hearth and on the floor before it.
import { describe, it, expect } from 'vitest';
import { planInterior } from '../../src/castle/interior/plan';
import { dressRoom, variantPool } from '../../src/props/dress';
import { mergePlaced, yawXZ } from '../../src/props/place';
import { buildShell } from '../../src/castle/interior/shell';
import { roomFires, fireAt, toFire, type Fire } from '../../src/light/roomLight';
import { PROFILES, flicker } from '../../src/light/flicker';
import { EXPOSURE, targetStops } from '../../src/render/interiorMath';
import type { RoomSpec, V3 } from '../../src/castle/interior/types';
import { islandCastle } from '../world';

/** Reflectance × AO × everything else between irradiance and the scene pass, as the captures measure it. */
const EFFECTIVE_ALBEDO = 0.11;
/** The interior shader's readability floor (InteriorLight.floor). */
const FLOOR = 0.145;
/** Washed out: more than this share of the view over white at the settled exposure (#71: 21-23 %). */
const MAX_CLIPPED = 0.05;
/** The eye must not be pinned at its indoor floor: this much headroom (stops) left. */
const HEADROOM = 0.25;

const inPoly = (poly: readonly (readonly [number, number])[], x: number, z: number) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};

/** First floor, ceiling or wall of the room's shell along o + t·d (unit d), with its normal into the room. */
function shellHit(r: RoomSpec, o: V3, d: V3): { p: V3; n: V3 } | null {
  let best = Infinity, n: V3 = [0, 1, 0];
  for (const [y, ny] of [[r.y0, 1], [r.y1, -1]] as const) {
    if (Math.abs(d[1]) < 1e-9) continue;
    const t = (y - o[1]) / d[1];
    if (t > 1e-4 && t < best && inPoly(r.poly, o[0] + d[0] * t, o[2] + d[2] * t)) { best = t; n = [0, ny, 0]; }
  }
  for (let i = 0; i < r.poly.length; i++) {
    const a = r.poly[i], b = r.poly[(i + 1) % r.poly.length], ex = b[0] - a[0], ez = b[1] - a[1];
    const den = d[0] * ez - d[2] * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((a[0] - o[0]) * ez - (a[1] - o[2]) * ex) / den, s = ((a[0] - o[0]) * d[2] - (a[1] - o[2]) * d[0]) / den, y = o[1] + d[1] * t;
    if (t > 1e-4 && t < best && s >= 0 && s <= 1 && y >= r.y0 && y <= r.y1) {
      best = t;
      const L = Math.hypot(ex, ez);
      n = [-ez / L, 0, ex / L];
      if (n[0] * d[0] + n[2] * d[2] > 0) n = [-n[0], 0, -n[2]];
    }
  }
  return best < Infinity ? { p: [o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best], n } : null;
}

/** HDR luminance through the game camera from eye to target, and the exposure the eye settles at. */
function viewStats(r: RoomSpec, fires: Fire[], eye: V3, target: V3, cfg = EXPOSURE, W = 64, H = 36) {
  const f = [0, 1, 2].map((k) => target[k] - eye[k]), fl = Math.hypot(...f), F = f.map((v) => v / fl);
  const rl = Math.hypot(F[2], F[0]), R = [F[2] / rl, 0, -F[0] / rl];
  const U = [R[1] * F[2] - R[2] * F[1], R[2] * F[0] - R[0] * F[2], R[0] * F[1] - R[1] * F[0]];
  const th = Math.tan((55 / 2) * (Math.PI / 180)), L: number[] = [];
  let s = 0, ws = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = ((x + 0.5) / W * 2 - 1) * th * (16 / 9), v = (1 - ((y + 0.5) / H) * 2) * th;
    const d = [0, 1, 2].map((k) => F[k] + R[k] * u + U[k] * v), dl = Math.hypot(...d);
    const h = shellHit(r, eye, d.map((q) => q / dl) as V3);
    if (!h) continue;
    const l = (EFFECTIVE_ALBEDO * (fireAt(fires, h.p, h.n) + FLOOR)) / Math.PI;
    L.push(l);
    // the controller's reader: log2 clamped to its 8-bit code, centre weighted (interiorMath.meanLog2)
    const dx = (x + 0.5) / W - 0.5, dy = (y + 0.5) / H - 0.5, wt = 1 - 1.2 * (dx * dx + dy * dy);
    s += Math.min(4, Math.max(-14, Math.log2(l))) * wt; ws += wt;
  }
  const stops = targetStops(s / ws, false, cfg, true), exposure = cfg.base * 2 ** stops;
  L.sort((a, b) => a - b);
  return { mean: L.reduce((a, b) => a + b, 0) / L.length, p99: L[Math.floor(0.99 * (L.length - 1))], stops, exposure, clipped: L.filter((l) => l * exposure > 1).length / L.length };
}

describe('rooms with a fire, over the whole castle', () => {
  const plan = planInterior(), make = variantPool();
  // dressed as the game dresses them (the windows' shutters and keep-outs move things)
  const windows = buildShell(plan, islandCastle().builder).embrasures.map((e) => e.face);
  const rooms = plan.rooms.map((r) => {
    const d = dressRoom(r, plan, { make, windows }), emitters = mergePlaced(d.placed).emitters;
    return { r, d, emitters, fires: roomFires(r, emitters) };
  }).filter(({ emitters }) => emitters.some((e) => e.kind === 'hearth') || emitters.length >= 3);
  const hearths = (x: (typeof rooms)[number]) => x.d.placed.filter((p) => p.prop.meta.emitters.some((e) => e.kind === 'hearth'));

  it('are not washed out, 1.5 m from every hearth or from the doorway', () => {
    const faults: string[] = [];
    let views = 0, hearthViews = 0, worst = { clipped: 0, at: '' };
    for (const x of rooms) {
      const { r, fires } = x;
      const poses: [string, V3, V3][] = [];
      hearths(x).forEach((p, k) => {
        const [fx, fz] = yawXZ(0, 1, p.yaw), front = p.prop.bounds.max[2] + 1.5;
        const fl = p.prop.mesh.flames.find((f) => f.kind === 'hearth')!, [bx, bz] = yawXZ(fl.base[0], fl.base[2], p.yaw);
        poses.push([`hearth ${k}`, [p.at[0] + fx * front, r.y0 + 1.6, p.at[2] + fz * front], [p.at[0] + bx, p.at[1] + fl.base[1] + 0.3, p.at[2] + bz]]);
      });
      hearthViews += poses.length;
      const door = plan.doors.find((d) => d.spaces.includes(r.id) && d.spaces[0] !== d.spaces[1]);
      if (door) {
        const s = door.spaces[1] === r.id ? 1 : -1, off = door.wall / 2 + 0.35;
        const c = r.poly.reduce((a, q) => [a[0] + q[0] / r.poly.length, a[1] + q[1] / r.poly.length], [0, 0]);
        poses.push(['doorway', [door.centre[0] + door.normal[0] * s * off, door.centre[1] + 1.6, door.centre[2] + door.normal[1] * s * off], [c[0], r.y0 + 1.1, c[1]]]);
      }
      for (const [what, eye, target] of poses) {
        views++;
        const v = viewStats(r, fires, eye, target);
        if (v.clipped > worst.clipped) worst = { clipped: v.clipped, at: `${r.id} ${what}` };
        if (v.clipped > MAX_CLIPPED || v.stops < EXPOSURE.minInside + HEADROOM) {
          faults.push(`${r.id} ${what}: HDR mean ${v.mean.toFixed(2)}, p99 ${v.p99.toFixed(2)}, exposure ${v.exposure.toFixed(2)}, ${(v.clipped * 100).toFixed(1)} % over white`);
        }
      }
    }
    expect(rooms.length).toBeGreaterThan(60);
    expect(hearthViews).toBeGreaterThan(50);
    expect(views).toBeGreaterThan(120);
    expect(faults).toEqual([]);
    expect(worst.clipped).toBeGreaterThan(0); // the rule sees bright surfaces somewhere
  }, 120_000);

  it('would have caught the washed-out hall: its fires at the old strength fail', () => {
    // the hall as before #71: hearths at 14 cd per unit (now 6), no room caps, and an eye that could not close
    // below 0.72 indoors (minInside 0, now -1). Not modelled: the old emitter 0.4 m out in the room and the
    // neighbours' fires through the walls, so the old hall measured brighter still (HDR mean 1.06).
    const x = rooms.find((y) => y.r.id === 'N1-2')!, h = hearths(x)[0];
    const old = x.emitters.map((e) => toFire(e.kind === 'hearth' ? { ...e, intensity: e.intensity * (14 / PROFILES.hearth.candela) } : e));
    const [fx, fz] = yawXZ(0, 1, h.yaw), front = h.prop.bounds.max[2] + 1.5;
    const eye: V3 = [h.at[0] + fx * front, x.r.y0 + 1.6, h.at[2] + fz * front], target: V3 = [h.at[0], h.at[1] + 0.5, h.at[2]];
    const now = viewStats(x.r, x.fires, eye, target), before = viewStats(x.r, old, eye, target, { ...EXPOSURE, minInside: 0 });
    expect(now.clipped).toBeLessThanOrEqual(MAX_CLIPPED);
    expect(now.stops).toBeGreaterThan(EXPOSURE.minInside + HEADROOM);
    expect(before.clipped > MAX_CLIPPED || before.stops < 0 + HEADROOM).toBe(true); // pinned at its old floor
  });

  it('flicker gently on the walls and floor round every hearth', () => {
    const faults: string[] = [];
    let n = 0;
    for (const x of rooms) for (const h of hearths(x)) {
      const [fx, fz] = yawXZ(0, 1, h.yaw), { min, max } = h.prop.bounds;
      const at = (lx: number, y: number, lz: number): V3 => { const [wx, wz] = yawXZ(lx, lz, h.yaw); return [h.at[0] + wx, y, h.at[2] + wz]; };
      const pts: [string, V3, V3][] = [
        ['wall left', at(min[0] - 0.5, x.r.y0 + 1.4, min[2] + 0.01), [fx, 0, fz]],
        ['wall right', at(max[0] + 0.5, x.r.y0 + 1.4, min[2] + 0.01), [fx, 0, fz]],
        ['floor', at(0, x.r.y0, max[2] + 1.5), [0, 1, 0]],
      ];
      for (const [what, p, nrm] of pts) {
        const per = x.fires.map((f) => fireAt([f], p, nrm)), E0 = per.reduce((a, b) => a + b, 0);
        if (E0 <= 0) continue;
        n++;
        // 60 s at 60 frames a second, relative to the steady light
        let s = 0, s2 = 0, lo = Infinity, step = 0, prev = NaN;
        const N = 3600;
        for (let i = 0; i < N; i++) {
          const e = x.fires.reduce((a, f, k) => a + per[k] * flicker(PROFILES[f.kind], f.seed, i / 60, f.amount).k, 0) / E0;
          s += e; s2 += e * e; lo = Math.min(lo, e);
          if (i) step = Math.max(step, Math.abs(e - prev));
          prev = e;
        }
        const m = s / N, sd = Math.sqrt(Math.max(0, s2 / N - m * m)) / m;
        // a slow breathing of a few per cent, dips no deeper than half, no frame-to-frame jump over 6 %
        if (sd > 0.1 || lo < 0.5 || step > 0.06) faults.push(`${x.r.id} ${what}: sd ${(sd * 100).toFixed(1)} %, lowest ${lo.toFixed(2)}, frame step ${(step * 100).toFixed(1)} %`);
      }
    }
    expect(n).toBeGreaterThan(150);
    expect(faults).toEqual([]);
  }, 120_000);
});
