// Rocks and boulders (game-world-generation recipe 4: seeded scatter, one InstancedMesh per shape):
// a few generated rock shapes (noisy icosphere cut by random planes, so they have flat fractured faces
// and creased edges), scattered at the moat's waterline, on the bank, on the rocky rise by the great
// tower, as glacial erratics in the fields and as clearance stones along hedgerows.
import * as THREE from 'three/webgpu';
import { mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { type Rng } from '../core/rng';
import { type V2, pointInPoly } from '../core/math2d';
import type { GenDeps } from './deps';

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

const ROCK_QUARTERS = 4;
/** The quarter round the castle (0..3, by bearing) a rock at (x, z) is drawn in. */
export const rockQuarter = (x: number, z: number) => Math.min(ROCK_QUARTERS - 1, Math.floor(((Math.atan2(z, x) / (Math.PI * 2)) + 1) % 1 * ROCK_QUARTERS));

/** Instanced rocks: one InstancedMesh per shape, detail level and quarter. */
export function buildRocks(material: THREE.Material, env: RockEnv, deps: GenDeps) {
  const SHAPES = ROCK_SHAPES;
  const { near, far } = placeRocks(env, deps);
  const group = new THREE.Group();
  group.name = 'rocks';
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
  let tris = 0;
  // one InstancedMesh per shape, level and quarter round the castle: each quarter's bounding sphere is
  // its own, so frustum culling skips the quarters out of view (a mesh of all the island's rocks never is)
  const make = (list: Spot[], detail: number, shadows: boolean, tag: string) => {
    for (let sh = 0; sh < SHAPES; sh++) {
      const all = list.filter((s) => s.shape === sh);
      if (!all.length) continue;
      const g = rockGeometry(deps, `rock-shape-${sh}`, detail);
      for (let qd = 0; qd < ROCK_QUARTERS; qd++) {
        const mine = all.filter((s) => rockQuarter(s.x, s.z) === qd);
        if (!mine.length) continue;
        const im = new THREE.InstancedMesh(g, material, mine.length);
        mine.forEach((s, i) => {
          e.set(s.tx, s.yaw, s.tz, 'YXZ'); q.setFromEuler(e);
          m.compose(pos.set(s.x, s.y, s.z), q, sc.set(s.s, s.sy, s.s * (0.85 + ((i * 0.618) % 1) * 0.3)));
          im.setMatrixAt(i, m);
        });
        im.computeBoundingSphere();
        im.castShadow = shadows; im.receiveShadow = true;
        im.name = `rocks-${tag}-${sh}-${qd}`;
        group.add(im);
        tris += (g.attributes.position.count / 3) * mine.length;
      }
    }
  };
  make(near, 2, true, 'near');
  make(far, 1, false, 'far');
  group.userData = { count: near.length + far.length, near: near.length, far: far.length, triangles: Math.round(tris), obstacles: islandObstacles(near, env) };
  return group;
}
