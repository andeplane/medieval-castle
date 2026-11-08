// Rocks and boulders (game-world-generation recipe 4: seeded scatter, one InstancedMesh per shape):
// a few generated rock shapes (noisy icosphere cut by random planes, so they have flat fractured faces
// and creased edges), scattered at the moat's waterline, on the bank, on the rocky rise by the great
// tower, as glacial erratics in the fields and as clearance stones along hedgerows.
import * as THREE from 'three/webgpu';
import { mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { type Rng } from '../core/rng';
import { type V2, pointInPoly } from '../core/math2d';
import type { GenDeps } from './deps';
import { UNDRAWN_LAYER } from '../render/passLayers';

export interface RockEnv {
  sample(x: number, z: number): { h: number; zone: string; dEdge: number; face?: number };
  moatOuter: V2[];
  footDist(x: number, z: number): number;
  hedges: { a: V2; b: V2; lane: boolean }[];
  fieldAt(x: number, z: number): { field: number; crop: string | null };
  farmland(x: number, z: number): number;
}

/** One rock shape, roughly unit radius, bottom flattened. */
export function rockGeometry(deps: GenDeps, name: string, detail: number) {
  const r = deps.rng(name), n = deps.noise3(name);
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g = mergeVertices(g);
  const planes: [number, number, number, number][] = [];
  const np = 5 + Math.floor(r() * 4);
  for (let k = 0; k < np; k++) {
    const u = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    planes.push([s * Math.cos(a), u * 0.8, s * Math.sin(a), 0.62 + r() * 0.25]);
  }
  const p = g.attributes.position as THREE.BufferAttribute, v = new THREE.Vector3();
  const sx = 0.9 + r() * 0.6, sy = 0.5 + r() * 0.35, sz = 0.75 + r() * 0.4;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.multiplyScalar(1 + 0.2 * n(v.x * 1.4, v.y * 1.4, v.z * 1.4) + 0.07 * n(v.x * 4, v.y * 4, v.z * 4));
    for (const [a, b, c, d] of planes) { const t = v.x * a + v.y * b + v.z * c; if (t > d) v.addScaledVector(new THREE.Vector3(a, b, c), d - t); }
    if (v.y < -0.35) v.y = -0.35 + (v.y + 0.35) * 0.3;
    p.setXYZ(i, v.x * sx, v.y * sy, v.z * sz);
  }
  g.computeBoundingBox();
  const out = toCreasedNormals(g, 0.55);
  const op = out.attributes.position as THREE.BufferAttribute, uv = new Float32Array(op.count * 2);
  for (let i = 0; i < op.count; i++) { uv[i * 2] = op.getX(i) + op.getY(i) * 0.5; uv[i * 2 + 1] = op.getZ(i) + op.getY(i) * 0.5; }
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

/** One placed rock: base position, size (s horizontal, sy vertical), yaw and tilt, and which shape. */
export interface RockSpot { x: number; y: number; z: number; s: number; sy: number; yaw: number; tx: number; tz: number; shape: number }
type Spot = RockSpot;
export const ROCK_SHAPES = 5;

/** Where the rocks go (pure: no three.js). `near` rocks get detailed shapes and cast shadows. */
export function placeRocks(env: RockEnv, deps: GenDeps): { near: RockSpot[]; far: RockSpot[] } {
  const r = deps.rng('rocks');
  const SHAPES = ROCK_SHAPES;
  const near: Spot[] = [], far: Spot[] = [];
  const put = (list: Spot[], x: number, z: number, size: number, sink: number, rr: Rng, flat = 1) => {
    const h = env.sample(x, z).h;
    list.push({ x, y: h - size * sink, z, s: size, sy: size * flat * (0.8 + rr() * 0.5), yaw: rr() * 6.283, tx: (rr() - 0.5) * 0.5, tz: (rr() - 0.5) * 0.5, shape: Math.floor(rr() * SHAPES) });
  };

  // 1) waterline of the outer bank: stones and boulders in clusters, some half in the water
  const M = env.moatOuter;
  const cl = deps.noise3('rock-cluster');
  for (let i = 0; i < M.length; i++) {
    const a = M[i], b = M[(i + 1) % M.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const t: V2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    let nx = -t[1], nz = t[0];
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    if (pointInPoly(M, mx + nx * 2, mz + nz * 2)) { nx = -nx; nz = -nz; } // point the normal at the land
    for (let d = r() * 0.6; d < L; d += 0.35 + r() * 0.45) {
      const px = a[0] + t[0] * d, pz = a[1] + t[1] * d;
      const dens = 0.5 + 0.5 * cl(px / 14, pz / 14, 0.5);
      if (r() > 0.15 + dens * 0.85) continue;
      // find the waterline along the normal
      let wl = -6;
      for (let o = -6; o < 8; o += 0.25) if (env.sample(px + nx * o, pz + nz * o).h > 0.02) { wl = o; break; }
      const o = wl + (r() - 0.55) * 2.2;
      const x = px + nx * o + t[0] * (r() - 0.5) * 0.6, z = pz + nz * o + t[1] * (r() - 0.5) * 0.6;
      const big = r() < 0.13;
      const size = big ? 1.0 + r() * 1.2 : 0.25 + Math.pow(r(), 1.5) * 0.75;
      put(near, x, z, size, big ? 0.3 : 0.25, r);
    }
  }
  // 2) a few boulders up on the bank shoulder and half-buried in the turf
  for (let k = 0, n = 0; k < 600 && n < 26; k++) {
    const i = Math.floor(r() * M.length), p = M[i], l = Math.hypot(p[0], p[1]);
    const o = 3 + r() * 18, x = p[0] + (p[0] / l) * o, z = p[1] + (p[1] / l) * o;
    const s = env.sample(x, z);
    if (s.zone !== 'outer' || s.h < 0.6) continue;
    put(near, x, z, 0.5 + r() * 1.1, 0.45, r); n++;
  }
  // 3) the rocky rise by the great tower on the island: bedrock slabs dipping one way, loose stones
  const OX = -40, OZ = -24;
  for (let k = 0, n = 0; k < 300 && n < 34; k++) {
    const a = r() * 6.283, d = Math.sqrt(r()) * 10.5, x = OX + Math.cos(a) * d * 1.15, z = OZ + Math.sin(a) * d;
    const s = env.sample(x, z);
    if (s.zone !== 'island' || s.dEdge < 1.6 || env.footDist(x, z) < 1.2) continue;
    const slab = n < 14;
    const size = slab ? 1.4 + r() * 1.6 : 0.25 + r() * 0.5;
    near.push({ x, y: s.h - size * (slab ? 0.3 : 0.3), z, s: size, sy: size * (slab ? 0.75 : 1), yaw: slab ? 0.6 + (r() - 0.5) * 0.5 : r() * 6.283, tx: slab ? 0.25 + r() * 0.12 : (r() - 0.5) * 0.4, tz: (r() - 0.5) * 0.25, shape: Math.floor(r() * SHAPES) });
    n++;
  }
  // 4) fields: erratics (more in rough pasture, none in ploughland) and clearance stones by the hedges
  const cell = 34;
  for (let gz = -1100; gz < 1100; gz += cell) for (let gx = -1100; gx < 1100; gx += cell) {
    const rr = deps.rng(`rock:${gx}:${gz}`);
    const x = gx + rr() * cell, z = gz + rr() * cell, d = Math.hypot(x, z);
    if (d < 120) continue;
    const f = env.fieldAt(x, z);
    const p = f.crop === 'rough' ? 0.3 : f.crop === 'pasture' || f.crop === 'grazed' ? 0.07 : f.crop === null ? 0.04 : 0.0;
    if (rr() > p) continue;
    const s = env.sample(x, z);
    if (s.zone !== 'outer' || s.h < 1.5 || s.h > 260) continue;
    const size = 0.5 + Math.pow(rr(), 2) * 1.8;
    put(d < 420 ? near : far, x, z, size, 0.4, rr);
    if (rr() < 0.3) put(d < 420 ? near : far, x + (rr() - 0.5) * 3, z + (rr() - 0.5) * 3, size * 0.4, 0.3, rr);
  }
  for (const h of env.hedges) {
    const L = Math.hypot(h.b[0] - h.a[0], h.b[1] - h.a[1]), mid = Math.hypot((h.a[0] + h.b[0]) / 2, (h.a[1] + h.b[1]) / 2);
    if (mid > 750) continue;
    const rr = deps.rng(`hedge-rock:${Math.round(h.a[0])}:${Math.round(h.a[1])}`);
    const n = Math.floor(rr() * rr() * L / 40);
    for (let k = 0; k < n; k++) {
      const t = rr(), side = (rr() < 0.5 ? -1 : 1) * (1.4 + rr() * 1.2);
      const ux = (h.b[0] - h.a[0]) / L, uz = (h.b[1] - h.a[1]) / L;
      const x = h.a[0] + ux * L * t - uz * side, z = h.a[1] + uz * L * t + ux * side;
      for (let c = 0; c < 3; c++) put(mid < 420 ? near : far, x + (rr() - 0.5) * 1.6, z + (rr() - 0.5) * 1.6, 0.3 + rr() * 0.5, 0.3, rr);
    }
  }
  return { near, far };
}

/** Rock footprints on the island as circles (x, z, radius), for walk collision and a future navmesh. */
export function islandObstacles(spots: RockSpot[], env: Pick<RockEnv, 'sample'>, minHeight = 0.35): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const s of spots) {
    const g = env.sample(s.x, s.z);
    if (g.zone === 'island' && s.y + s.sy * 0.6 - g.h >= minHeight) out.push([s.x, s.z, s.s * 0.9]); // else sunk flush with the turf
  }
  return out;
}

/** Rock levels of detail by how big a rock looks from the eye: its width (2 × its size, m) over its
 * distance, the first level whose `above` it passes. ≈ 60 and 12 px tall at 1440p: past 60 px a 320-triangle
 * rock, then 80, and under 12 px the bare 20-face shape (render/passLayers.ts: how, never whether). */
export const ROCK_LOD = [{ detail: 2, above: 0.043 }, { detail: 1, above: 0.0087 }, { detail: 0, above: -1 }] as const;

/** Which ROCK_LOD level a rock of size s at distance d gets. */
export function rockLevel(s: number, d: number): number {
  const k = (2 * s) / Math.max(d, 1e-3);
  return ROCK_LOD.findIndex((l) => k > l.above);
}

export interface RockLod {
  /** Put every rock in the level its size and distance from the eye give (does nothing until the eye has moved 1 m). */
  update(eye: { x: number; y: number; z: number }): void;
  /** Rocks drawn at each level (hi to lo). */
  counts(): number[];
}

/**
 * Instanced rocks. The rocks are drawn by level of detail: for each shape one InstancedMesh per ROCK_LOD
 * level, refilled as the eye moves (userData.lod), the same rocks in every pass. The near rocks' whole
 * detailed set (`rocks-near-*`) stays, undrawn, for the physics (player/setup.ts) and the island's obstacles.
 * Before 2026-11-08 the 385 near rocks were always drawn at 320 triangles and the far ones at 80, all of
 * them in every pass (one mesh's bounds span the land): 176 k triangles a pass, four passes a frame.
 */
export function buildRocks(material: THREE.Material, env: RockEnv, deps: GenDeps) {
  const SHAPES = ROCK_SHAPES;
  const { near, far } = placeRocks(env, deps);
  const group = new THREE.Group();
  group.name = 'rocks';
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
  let tris = 0;
  const matrixOf = (s: Spot, i: number) => {
    e.set(s.tx, s.yaw, s.tz, 'YXZ'); q.setFromEuler(e);
    return m.compose(pos.set(s.x, s.y, s.z), q, sc.set(s.s, s.sy, s.s * (0.85 + ((i * 0.618) % 1) * 0.3)));
  };
  // the near rocks as physics reads them: detail 2, every instance, never drawn
  for (let sh = 0; sh < SHAPES; sh++) {
    const mine = near.filter((s) => s.shape === sh);
    if (!mine.length) continue;
    const g = rockGeometry(deps, `rock-shape-${sh}`, 2);
    const im = new THREE.InstancedMesh(g, material, mine.length);
    mine.forEach((s, i) => im.setMatrixAt(i, matrixOf(s, i)));
    im.computeBoundingSphere();
    im.castShadow = true; im.receiveShadow = true;
    im.name = `rocks-near-${sh}`;
    im.layers.set(UNDRAWN_LAYER);
    group.add(im);
    tris += (g.attributes.position.count / 3) * mine.length;
  }
  tris += far.length * 80; // the far rocks at detail 1, as reported before the levels
  // the drawn rocks: per shape and level, with room for all of that shape
  const lod = Array.from({ length: SHAPES }, (_, sh) => {
    const nearOnes = near.filter((s) => s.shape === sh), farOnes = far.filter((s) => s.shape === sh);
    // (each list's own index shapes the rock's depth, as when near and far were meshes of their own)
    const mine = [...nearOnes, ...farOnes].map((s) => ({ s }));
    const mats = [...nearOnes.map((s, i) => matrixOf(s, i).clone()), ...farOnes.map((s, i) => matrixOf(s, i).clone())];
    const levels = ROCK_LOD.map((l, li) => {
      const im = new THREE.InstancedMesh(rockGeometry(deps, `rock-shape-${sh}`, l.detail), material, Math.max(1, mine.length));
      im.count = 0; im.visible = false;
      im.castShadow = true; im.receiveShadow = true;
      im.name = `rocks-lod${li}-${sh}`;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      group.add(im);
      return im;
    });
    return { mine, mats, levels };
  });
  let last: { x: number; y: number; z: number } | null = null;
  const counts = ROCK_LOD.map(() => 0);
  const rockLod: RockLod = {
    update(eye) {
      if (last && Math.hypot(eye.x - last.x, eye.y - last.y, eye.z - last.z) < 1) return;
      last = { x: eye.x, y: eye.y, z: eye.z };
      counts.fill(0);
      for (const { mine, mats, levels } of lod) {
        const n = levels.map(() => 0);
        mine.forEach(({ s }, i) => {
          const li = rockLevel(s.s, Math.hypot(s.x - eye.x, s.y - eye.y, s.z - eye.z));
          levels[li].setMatrixAt(n[li]++, mats[i]);
        });
        levels.forEach((im, li) => {
          im.count = n[li]; im.visible = n[li] > 0; counts[li] += n[li];
          im.instanceMatrix.needsUpdate = true;
          // bounds of the rocks it now holds: three culls the mesh by them
          if (n[li]) im.computeBoundingSphere();
        });
      }
    },
    counts: () => [...counts],
  };
  rockLod.update({ x: 0, y: 60, z: 0 });
  group.userData = { count: near.length + far.length, near: near.length, far: far.length, triangles: Math.round(tris), obstacles: islandObstacles(near, env), lod: rockLod };
  return group;
}
