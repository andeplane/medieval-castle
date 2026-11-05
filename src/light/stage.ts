// The lighting review stage (lights.html): a low segmental-vaulted cellar like the castle undercrofts,
// a door into a 2.1 m barrel-vaulted tunnel like the ones under the moat, fixtures from the prop kit.
// Pure geometry and layout (no three.js), so it is tested and the page stays thin glue.
import type { V3 } from './types';
import type { Placed } from '../props/place';
import { makeProp } from '../props/kit';

export interface Surf { pos: number[]; nor: number[]; uv: number[] }
const surf = (): Surf => ({ pos: [], nor: [], uv: [] });

/** Vault cross-section (z, y) from floor to floor: walls up to `spring`, then an arc rising `rise`. */
export function vaultProfile(halfWidth: number, spring: number, rise: number, n = 16): [number, number][] {
  // circle through (±hw, spring) and (0, spring + rise)
  const R = (halfWidth * halfWidth + rise * rise) / (2 * rise), cy = spring + rise - R;
  const a0 = Math.asin(Math.min(1, halfWidth / R));
  const pts: [number, number][] = [[-halfWidth, 0]];
  for (let i = 0; i <= n; i++) { const a = -a0 + (2 * a0 * i) / n; pts.push([R * Math.sin(a), cy + R * Math.cos(a)]); }
  pts.push([halfWidth, 0]);
  return pts;
}
/** Height of the vault's inside surface at z (0 outside the width). */
export function vaultHeight(halfWidth: number, spring: number, rise: number, z: number): number {
  if (Math.abs(z) > halfWidth) return 0;
  const R = (halfWidth * halfWidth + rise * rise) / (2 * rise), cy = spring + rise - R;
  return cy + Math.sqrt(R * R - z * z);
}

function quad(s: Surf, a: V3, b: V3, c: V3, d: V3, n: V3, ua: [number, number], ub: [number, number], uc: [number, number], ud: [number, number]) {
  for (const [p, t] of [[a, ua], [b, ub], [c, uc], [a, ua], [c, uc], [d, ud]] as [V3, [number, number]][]) { s.pos.push(...p); s.nor.push(...n); s.uv.push(...t); }
}

export interface Vault { x0: number; x1: number; z: number; halfWidth: number; spring: number; rise: number; tile: number }

/** Inside of a vault running along x from x0 to x1, centred on z: walls and the curved vault, facing in. */
export function vaultShell(v: Vault, s = surf()): Surf {
  const P = vaultProfile(v.halfWidth, v.spring, v.rise);
  let arc = 0;
  for (let i = 0; i < P.length - 1; i++) {
    const [z0, y0] = P[i], [z1, y1] = P[i + 1];
    const len = Math.hypot(z1 - z0, y1 - y0);
    // inward normal: rotate the profile tangent (walking -z → +z over the top) towards the axis
    const n: V3 = [0, -(z1 - z0) / len, (y1 - y0) / len];
    quad(s, [v.x0, y0, v.z + z0], [v.x1, y0, v.z + z0], [v.x1, y1, v.z + z1], [v.x0, y1, v.z + z1], n,
      [v.x0 / v.tile, arc / v.tile], [v.x1 / v.tile, arc / v.tile], [v.x1 / v.tile, (arc + len) / v.tile], [v.x0 / v.tile, (arc + len) / v.tile]);
    arc += len;
  }
  return s;
}

/** Floor of a vault. */
export function vaultFloor(v: Vault, s = surf()): Surf {
  const a = v.z - v.halfWidth, b = v.z + v.halfWidth;
  quad(s, [v.x0, 0, a], [v.x0, 0, b], [v.x1, 0, b], [v.x1, 0, a], [0, 1, 0], [v.x0 / v.tile, a / v.tile], [v.x0 / v.tile, b / v.tile], [v.x1 / v.tile, b / v.tile], [v.x1 / v.tile, a / v.tile]);
  return s;
}

/**
 * End wall of a vault at `x`, facing `facing` (+1 = +x), with an optional door opening (|z - zc| < hw,
 * y < height). Built as vertical strips so the top follows the arc.
 */
export function vaultEnd(v: Vault, x: number, facing: 1 | -1, door?: { halfWidth: number; height: number; reveal?: number }, s = surf()): Surf {
  const zs = new Set<number>();
  for (let i = 0; i <= 24; i++) zs.add(-v.halfWidth + (2 * v.halfWidth * i) / 24);
  if (door) { zs.add(-door.halfWidth); zs.add(door.halfWidth); }
  const Z = [...zs].sort((a, b) => a - b);
  const n: V3 = [facing, 0, 0];
  for (let i = 0; i < Z.length - 1; i++) {
    const z0 = Z[i], z1 = Z[i + 1], zm = (z0 + z1) / 2;
    const bot = door && Math.abs(zm) < door.halfWidth ? door.height : 0;
    const t0 = vaultHeight(v.halfWidth, v.spring, v.rise, z0), t1 = vaultHeight(v.halfWidth, v.spring, v.rise, z1);
    const u = (z: number) => (facing * (v.z + z)) / v.tile;
    // wind so the face points along `facing`
    const A: V3 = [x, bot, v.z + z0], B: V3 = [x, bot, v.z + z1], C: V3 = [x, t1, v.z + z1], D: V3 = [x, t0, v.z + z0];
    if (facing > 0) quad(s, A, D, C, B, n, [u(z0), bot / v.tile], [u(z0), t0 / v.tile], [u(z1), t1 / v.tile], [u(z1), bot / v.tile]);
    else quad(s, A, B, C, D, n, [u(z0), bot / v.tile], [u(z1), bot / v.tile], [u(z1), t1 / v.tile], [u(z0), t0 / v.tile]);
  }
  // door reveal (the wall's thickness, behind the face) so the opening reads as cut through masonry
  if (door?.reveal) {
    const t = door.reveal, x2 = x - facing * t, hw = door.halfWidth, h = door.height, T = v.tile;
    const q = (a: V3, b: V3, c: V3, d: V3, n: V3, ua: [number, number], ub: [number, number], uc: [number, number], ud: [number, number]) =>
      facing < 0 ? quad(s, a, b, c, d, n, ua, ub, uc, ud) : quad(s, a, d, c, b, n, ua, ud, uc, ub);
    q([x, 0, v.z - hw], [x2, 0, v.z - hw], [x2, h, v.z - hw], [x, h, v.z - hw], [0, 0, 1], [0, 0], [t / T, 0], [t / T, h / T], [0, h / T]);
    q([x, 0, v.z + hw], [x, h, v.z + hw], [x2, h, v.z + hw], [x2, 0, v.z + hw], [0, 0, -1], [0, 0], [0, h / T], [t / T, h / T], [t / T, 0]);
    q([x, h, v.z - hw], [x2, h, v.z - hw], [x2, h, v.z + hw], [x, h, v.z + hw], [0, -1, 0], [0, 0], [t / T, 0], [t / T, 2 * hw / T], [0, 2 * hw / T]);
  }
  return s;
}

export interface StageView { name: string; label: string; pos: V3; target: V3 }
export interface Stage { walls: Surf; floors: Surf; placed: Placed[]; views: StageView[]; volumes: { centre: V3; size: V3; probes: V3 }[] }

export const CELLAR: Vault = { x0: -6, x1: 6, z: 0, halfWidth: 3.6, spring: 2.1, rise: 1.7, tile: 4 };
export const TUNNEL: Vault = { x0: 6.9, x1: 36, z: 0, halfWidth: 1.05, spring: 1.6, rise: 1.05, tile: 4 };
const DOOR = { halfWidth: 0.62, height: 2.15 };
const GAP = TUNNEL.x0 - CELLAR.x1; // wall thickness between cellar and tunnel

/** The review stage. `seed` varies the props. */
export function lightStage(seed = 1): Stage {
  const walls = surf(), floors = surf();
  vaultShell(CELLAR, walls); vaultFloor(CELLAR, floors);
  vaultEnd(CELLAR, CELLAR.x0, 1, undefined, walls);
  vaultEnd(CELLAR, CELLAR.x1, -1, { ...DOOR, reveal: GAP }, walls);
  vaultShell(TUNNEL, walls); vaultFloor(TUNNEL, floors);
  vaultEnd(TUNNEL, TUNNEL.x0, 1, DOOR, walls);
  vaultEnd(TUNNEL, TUNNEL.x1, -1, { halfWidth: 0.55, height: 1.95, reveal: 0.6 }, walls);

  const P = (kind: string, at: V3, yaw: number, s = 0): Placed => ({ prop: makeProp(kind, seed * 101 + s), at, yaw });
  const hw = CELLAR.halfWidth;
  const placed: Placed[] = [
    // cellar: torches on both long walls, a chandelier, a table set for a late supper, stores
    P('sconce', [-3.2, 1.55, -hw], 0, 1), P('sconce', [3.0, 1.55, -hw], 0, 2), P('sconce', [-0.4, 1.55, hw], Math.PI, 3),
    P('chandelier', [0.6, CELLAR.spring + CELLAR.rise - 0.02, 0], 0.4, 4),
    P('trestle-table', [0.4, 0, 0.3], 0.05, 5), P('bench', [0.4, 0, -0.55], 0.05, 6), P('bench', [0.5, 0, 1.15], Math.PI + 0.08, 7),
    P('candlestick', [-0.2, 0.78, 0.25], 0, 8), P('candlestick', [1.1, 0.78, 0.4], 0, 9), P('tableware', [0.5, 0.78, 0.3], 0.1, 10),
    P('barrel', [-5.2, 0, -2.8], 0.3, 11), P('barrel', [-4.4, 0, -3.0], 1.2, 12), P('barrel', [-5.2, 0, 2.6], 0.5, 13),
    P('crate', [4.6, 0, 2.7], 0.2, 14), P('sack', [4.0, 0, 3.0], 0.9, 15), P('shelf', [-5.6, 0, 0.2], Math.PI / 2, 16),
    P('firewood', [3.8, 0, -2.9], 0, 17), P('candlestick', [-5.45, 1.42, 0.5], 0, 18),
  ];
  // tunnel: torches every 4.5 m, alternating sides, like the reference corridors
  for (let i = 0, x = TUNNEL.x0 + 2.4; x < TUNNEL.x1 - 1; i++, x += 4.5) {
    const side = i % 2 ? 1 : -1;
    placed.push(P('sconce', [x, 1.45, side * TUNNEL.halfWidth], side > 0 ? Math.PI : 0, 40 + i));
  }
  const views: StageView[] = [
    { name: 'cellar', label: 'Cellar', pos: [-5.3, 1.65, 2.6], target: [3, 1.1, -1.2] },
    { name: 'supper', label: 'Supper table', pos: [-1.9, 1.35, 1.9], target: [0.6, 0.85, 0.1] },
    { name: 'torch', label: 'Torch', pos: [-2.55, 1.8, -2.55], target: [-3.2, 1.9, -3.35] },
    { name: 'tunnel', label: 'Tunnel', pos: [7.4, 1.55, 0.35], target: [20, 1.2, -0.1] },
    { name: 'door', label: 'Into the cellar', pos: [12.5, 1.6, 0.3], target: [2, 1.3, -0.4] },
  ];
  const volumes = [
    { centre: [0, 1.95, 0] as V3, size: [12, 3.9, 7.2] as V3, probes: [7, 3, 5] as V3 },
    { centre: [(TUNNEL.x0 + TUNNEL.x1) / 2, 1.3, 0] as V3, size: [TUNNEL.x1 - TUNNEL.x0, 2.6, 2.1] as V3, probes: [16, 2, 2] as V3 },
  ];
  return { walls, floors, placed, views, volumes };
}
