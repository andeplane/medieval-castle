// Ground cover (game-materials-shaders "grass wind", game-world-generation recipe 4): instanced grass
// tufts, wildflower and clover patches on the island and the near banks, reeds along both edges of
// the moat. Each layer is generated lazily in 12 m chunks (seeded per chunk), and every frame the chunks
// in view are packed, nearest first, into one instanced draw per layer. Density falls with distance;
// each tuft has a rank and shrinks away smoothly when the density at its distance drops below it, so
// nothing pops. Placement reads the terrain mesh itself (heights and the grass/dirt/rock/mud weights),
// so tufts sit exactly on the rendered ground and stay off paths, the courtyard and the revetment edge.
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  attribute, texture, uv, vec2, vec3, float, sin, cos, time, cameraPosition, smoothstep, mix, max, min, pow, transformNormalToView, normalize, abs, select, clamp,
} from 'three/tsl';
import { createNoise2D } from 'simplex-noise';
import { mulberry32, hashSeed, type Rng } from '../core/rng';
import { sample, ISLAND, MOAT_OUTER } from './terrain';
import { gatehouseFrame, castleCentre } from '../castle/layout';
import { pointInPoly, type V2 } from '../core/math2d';

const CELL = 12;

// ---------------------------------------------------------------------------------------------
// terrain lookup: exact heights of the rendered near-terrain triangles, plus its ground weights
// ---------------------------------------------------------------------------------------------
export interface Ground { h(x: number, z: number): number; w(x: number, z: number): [number, number, number, number] | null }

export function groundFromMesh(mesh: THREE.Mesh): Ground {
  const g = mesh.geometry, p = g.attributes.position as THREE.BufferAttribute, m = g.attributes.mask as THREE.BufferAttribute;
  const n = Math.round(Math.sqrt(p.count)), x0 = p.getX(0), z0 = p.getZ(0), s = p.getX(1) - p.getX(0);
  const at = (x: number, z: number) => {
    const fx = (x - x0) / s, fz = (z - z0) / s, ix = Math.floor(fx), iz = Math.floor(fz);
    if (ix < 0 || iz < 0 || ix >= n - 1 || iz >= n - 1) return null;
    return { ix, iz, u: fx - ix, v: fz - iz };
  };
  const tri = (c: { ix: number; iz: number; u: number; v: number }, get: (k: number) => number) => {
    const a = c.ix + c.iz * n, b = a + n, d = a + 1, cc = b + 1;
    // PlaneGeometry splits each cell along b–d: (a, b, d) and (b, c, d)
    if (c.u + c.v <= 1) return get(a) + (get(d) - get(a)) * c.u + (get(b) - get(a)) * c.v;
    return get(cc) + (get(b) - get(cc)) * (1 - c.u) + (get(d) - get(cc)) * (1 - c.v);
  };
  return {
    h: (x, z) => { const c = at(x, z); return c ? tri(c, (k) => p.getY(k)) : sample(x, z).h; },
    w: (x, z) => {
      const c = at(x, z);
      if (!c) return null;
      return [tri(c, (k) => m.getX(k)), tri(c, (k) => m.getY(k)), tri(c, (k) => m.getZ(k)), tri(c, (k) => m.getW(k))];
    },
  };
}

// ---------------------------------------------------------------------------------------------
// geometry: blades are a centre line plus a sideways offset, so the shader can widen them alone
// ---------------------------------------------------------------------------------------------
interface BladeOpts { blades: number; radius: number; width: number; lean: [number, number]; hMin: number; segs?: number; upright?: number }

class ClumpBuilder {
  pos: number[] = []; side: number[] = []; nor: number[] = []; uvs: number[] = []; idx: number[] = [];
  private v = 0;
  vert(c: THREE.Vector3, s: THREE.Vector3, n: THREE.Vector3, u: number, t: number) {
    this.pos.push(c.x, c.y, c.z); this.side.push(s.x, s.y, s.z); this.nor.push(n.x, n.y, n.z); this.uvs.push(u, t);
    return this.v++;
  }
  tri(a: number, b: number, c: number) { this.idx.push(a, b, c); }
  /** A tapered, curved blade of `segs` segments ending in a point. kind goes to uv.x (0..1 blade). */
  blade(r: Rng, root: THREE.Vector3, h: number, width: number, lean: number, facing: number, segs: number, kindU = 0) {
    const leanDir = new THREE.Vector3(Math.cos(facing + (r() - 0.5) * 1.2), 0, Math.sin(facing + (r() - 0.5) * 1.2));
    const across = new THREE.Vector3(-Math.sin(facing), 0, Math.cos(facing));
    const ids: number[][] = [];
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const c = root.clone().addScaledVector(leanDir, lean * h * t * t).setY(root.y + h * (t - 0.35 * lean * t * t));
      const w = width * (1 - t) ** 0.8;
      // face normal: across × blade direction, blended toward up (grass is lit like a surface, not cards)
      const dirv = leanDir.clone().multiplyScalar(2 * lean * t).add(new THREE.Vector3(0, 1, 0)).normalize();
      const n = new THREE.Vector3().crossVectors(across, dirv).normalize().lerp(new THREE.Vector3(0, 1, 0), 0.55).normalize();
      if (k === segs) ids.push([this.vert(c, new THREE.Vector3(), n, kindU, 1)]);
      else ids.push([this.vert(c, across.clone().multiplyScalar(-w / 2), n, kindU, t), this.vert(c, across.clone().multiplyScalar(w / 2), n, kindU, t)]);
    }
    for (let k = 0; k < segs; k++) {
      const [a, b] = ids[k], nx = ids[k + 1];
      if (nx.length === 1) this.tri(a, b, nx[0]);
      else { this.tri(a, b, nx[0]); this.tri(b, nx[1], nx[0]); }
    }
  }
  /** Small closed head (pyramid/diamond) at c; kind in uv.x ≥ 2 so the shader colours it. */
  head(c: THREE.Vector3, r0: number, h0: number, kindU: number, sides = 4, flat = false) {
    const top = this.vert(c.clone().setY(c.y + h0), new THREE.Vector3(), new THREE.Vector3(0, 1, 0), kindU, 1);
    const bot = this.vert(c.clone().setY(c.y - (flat ? h0 * 0.3 : h0)), new THREE.Vector3(), new THREE.Vector3(0, -1, 0), kindU, 0.9);
    const ring: number[] = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2, d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      ring.push(this.vert(c.clone().addScaledVector(d, r0), new THREE.Vector3(), d.clone().setY(0.4).normalize(), kindU, 0.95));
    }
    for (let i = 0; i < sides; i++) { const a = ring[i], b = ring[(i + 1) % sides]; this.tri(top, b, a); this.tri(bot, a, b); }
  }
  build() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('side', new THREE.Float32BufferAttribute(this.side, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setIndex(this.idx);
    return g;
  }
  get tris() { return this.idx.length / 3; }
}

function grassClump(seed: string, o: BladeOpts) {
  const r = mulberry32(hashSeed(seed)), b = new ClumpBuilder();
  for (let i = 0; i < o.blades; i++) {
    const a = r() * Math.PI * 2, d = o.radius * Math.sqrt(r());
    const root = new THREE.Vector3(Math.cos(a) * d, 0, Math.sin(a) * d);
    const h = o.hMin + (1 - o.hMin) * r();
    const lean = o.lean[0] + (o.lean[1] - o.lean[0]) * r() * (d / o.radius * 0.6 + 0.4);
    b.blade(r, root, h, o.width * (0.7 + 0.6 * r()), lean, a + (r() - 0.5) * (o.upright ?? 1.4), o.segs ?? 2);
  }
  return b;
}

function reedClump() {
  const r = mulberry32(hashSeed('reeds')), b = grassClump('reeds-blades', { blades: 11, radius: 0.32, width: 0.022, lean: [0.03, 0.16], hMin: 0.55, segs: 2, upright: 0.6 });
  // two cattail stalks with brown heads
  for (let i = 0; i < 2; i++) {
    const a = r() * 6.28, d = 0.1 + r() * 0.15, root = new THREE.Vector3(Math.cos(a) * d, 0, Math.sin(a) * d), h = 0.85 + r() * 0.15;
    b.blade(r, root, h, 0.012, 0.02, a, 1);
    b.head(root.clone().setY(h - 0.07), 0.018, 0.075, 2, 4);
  }
  return b;
}

function flowerClump() {
  const r = mulberry32(hashSeed('flowers')), b = new ClumpBuilder();
  // stems with heads
  for (let i = 0; i < 4; i++) {
    const a = r() * 6.28, d = 0.03 + r() * 0.1, root = new THREE.Vector3(Math.cos(a) * d, 0, Math.sin(a) * d), h = 0.55 + r() * 0.45;
    b.blade(r, root, h, 0.012, 0.08 + r() * 0.1, a, 1);
    b.head(root.clone().setY(h), 0.06 + r() * 0.02, 0.03, 3, 5, true);
  }
  // low trefoil leaves (clover / rosette)
  for (let i = 0; i < 6; i++) {
    const a = r() * 6.28, d = r() * 0.12, c = new THREE.Vector3(Math.cos(a) * d, 0.08 + r() * 0.1, Math.sin(a) * d);
    for (let k = 0; k < 3; k++) {
      const la = a + (k / 3) * Math.PI * 2 + r() * 0.3, tip = new THREE.Vector3(Math.cos(la), 0.15, Math.sin(la)).multiplyScalar(0.07).add(c);
      const sd = new THREE.Vector3(-Math.sin(la), 0, Math.cos(la)).multiplyScalar(0.035);
      const up = new THREE.Vector3(0, 1, 0);
      const v0 = b.vert(c, new THREE.Vector3(), up, 4, 0.5), v1 = b.vert(tip.clone().add(sd), new THREE.Vector3(), up, 4, 0.6), v2 = b.vert(tip.clone().sub(sd), new THREE.Vector3(), up, 4, 0.6);
      b.tri(v0, v1, v2);
    }
  }
  return b;
}

// ---------------------------------------------------------------------------------------------
// material
// ---------------------------------------------------------------------------------------------
type Kind = 'grass' | 'reeds' | 'flowers';
interface Fade { a: number; b: number; c: number; d: number; fall: number; widen: number }

/** Same density curve on the CPU (packing) and the GPU (per-tuft shrink): ramp in a→b, out c→d, × (b/dist)^fall. */
const fadeCPU = (f: Fade, dist: number) => {
  const ss = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const ramp = f.a < f.b ? ss(f.a, f.b, dist) : 1;
  return ramp * (1 - ss(f.c, f.d, dist)) * Math.min(1, Math.pow(Math.max(f.b, 1) / Math.max(dist, 1e-3), f.fall));
};

function vegMaterial(kind: Kind, f: Fade, macro: THREE.Texture) {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: kind === 'reeds' ? 0.7 : 0.85, metalness: 0 });
  const gA = attribute<'vec4'>('gA', 'vec4'), gB = attribute<'vec4'>('gB', 'vec4');
  const base = gA.xyz, rot = gA.w, hgt = gB.x, wid = gB.y, rank = gB.z, cr = gB.w;
  const centre = attribute<'vec3'>('position', 'vec3'), side = attribute<'vec3'>('side', 'vec3');
  const dist = cameraPosition.xz.sub(base.xz).length();
  const ramp = f.a < f.b ? smoothstep(f.a, f.b, dist) : float(1);
  const dens = ramp.mul(float(1).sub(smoothstep(f.c, f.d, dist))).mul(min(float(1), pow(float(Math.max(f.b, 1)).div(max(dist, 0.001)), f.fall)));
  const vis = smoothstep(rank.sub(0.06), rank, dens);
  const t = uv().y;
  // wind: two sines and a travelling gust from the macro noise
  const gust = texture(macro, base.xz.mul(1 / 38).add(vec2(time.mul(0.031), time.mul(0.017)))).level(float(0)).r;
  const ph = time.mul(kind === 'reeds' ? 1.3 : 1.9).add(base.x.mul(0.27)).add(base.z.mul(0.19)).add(cr.mul(2.0));
  const sway = sin(ph).mul(0.6).add(sin(ph.mul(2.3).add(1.1)).mul(0.25)).mul(gust.mul(0.7).add(0.12)).mul(kind === 'reeds' ? 0.12 : kind === 'flowers' ? 0.12 : 0.22);
  const sc = hgt.mul(vis);
  const local = centre.add(side.mul(wid.mul(float(1).add(dist.mul(f.widen))))).mul(sc);
  const c = cos(rot), s = sin(rot);
  const rotY = (v: Node<'vec3'>) => vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.x.negate().mul(s).add(v.z.mul(c)));
  const bend = t.mul(t).mul(sc);
  const wdir = vec3(0.83, 0, 0.55);
  m.positionNode = base.add(rotY(local)).add(wdir.mul(sway.mul(bend))).sub(vec3(0, abs(sway).mul(bend).mul(0.3), 0));
  m.normalNode = transformNormalToView(normalize(rotY(attribute<'vec3'>('normal', 'vec3'))));

  // colour: root shade to tip, the terrain's meadow drift (dry/green at two scales) and per-tuft jitter
  const mac = texture(macro, base.xz.mul(1 / 180)), mac2 = texture(macro, base.xz.mul(1 / 1400));
  const dry = smoothstep(0.45, 0.75, mac.r.mul(0.6).add(mac2.g.mul(0.6)));
  const jit = cr.mul(0.3).add(0.85);
  const kU = uv().x;
  let col;
  if (kind === 'reeds') {
    const blade = mix(vec3(0.05, 0.06, 0.02), vec3(0.17, 0.17, 0.065), pow(t, 0.8)).mul(jit);
    col = select(kU.greaterThan(1.5), vec3(0.075, 0.042, 0.022), blade);
  } else {
    let blade = mix(vec3(0.03, 0.048, 0.012), vec3(0.115, 0.155, 0.036), pow(t, 0.75)).mul(jit);
    blade = mix(blade, blade.mul(vec3(1.25, 1.08, 0.72)), dry.mul(0.7)).mul(mac.b.mul(0.35).add(0.83));
    if (kind === 'flowers') {
      // palette per tuft: clover white/pink, buttercup yellow, self-heal purple
      const pi = cr.mul(4).floor();
      const head = select(pi.lessThan(1), vec3(0.7, 0.68, 0.6), select(pi.lessThan(2), vec3(0.62, 0.42, 0.45), select(pi.lessThan(3), vec3(0.62, 0.48, 0.05), vec3(0.24, 0.13, 0.36))));
      const leaf = vec3(0.04, 0.075, 0.025).mul(jit);
      col = select(kU.greaterThan(3.5), leaf, select(kU.greaterThan(2.5), head, blade));
    } else col = blade;
  }
  m.colorNode = col;
  // darker toward the root, where the tuft shades itself
  m.aoNode = mix(float(0.45), float(1), clamp(t.mul(1.4), 0, 1));
  return m;
}

// ---------------------------------------------------------------------------------------------
// layers
// ---------------------------------------------------------------------------------------------
interface ChunkData { a: Float32Array; b: Float32Array; n: number; box: THREE.Box3 }

class ScatterLayer {
  mesh: THREE.Mesh;
  private chunks = new Map<number, ChunkData | null>();
  private A: THREE.InstancedBufferAttribute; private B: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;
  rMax: number;
  count = 0;
  constructor(public name: string, b: ClumpBuilder, mat: THREE.Material, public fade: Fade, public cap: number, private gen: (ci: number, cj: number) => ChunkData | null, public trisPer = b.tris) {
    this.geo = b.build();
    this.A = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4); this.A.setUsage(THREE.DynamicDrawUsage);
    this.B = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4); this.B.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('gA', this.A); this.geo.setAttribute('gB', this.B);
    this.geo.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.name = name; this.mesh.castShadow = false; this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    this.rMax = fade.d;
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  }
  private key(i: number, j: number) { return (i + 2048) * 4096 + (j + 2048); }
  private chunk(i: number, j: number) {
    const k = this.key(i, j);
    if (!this.chunks.has(k)) this.chunks.set(k, this.gen(i, j));
    return this.chunks.get(k)!;
  }
  update(cam: THREE.Vector3, frustum: THREE.Frustum) {
    const R = this.rMax, i0 = Math.floor((cam.x - R) / CELL), i1 = Math.floor((cam.x + R) / CELL), j0 = Math.floor((cam.z - R) / CELL), j1 = Math.floor((cam.z + R) / CELL);
    const list: { c: ChunkData; d: number; take: number }[] = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const x0 = i * CELL, z0 = j * CELL;
      const dx = Math.max(x0 - cam.x, 0, cam.x - x0 - CELL), dz = Math.max(z0 - cam.z, 0, cam.z - z0 - CELL);
      const dmin = Math.hypot(dx, dz);
      if (dmin > R) continue;
      const c = this.chunk(i, j);
      if (!c || !c.n || !frustum.intersectsBox(c.box)) continue;
      const dmax = Math.hypot(Math.max(Math.abs(x0 - cam.x), Math.abs(x0 + CELL - cam.x)), Math.max(Math.abs(z0 - cam.z), Math.abs(z0 + CELL - cam.z)));
      let fm = 0;
      for (let k = 0; k <= 8; k++) fm = Math.max(fm, fadeCPU(this.fade, dmin + ((dmax - dmin) * k) / 8));
      for (const e of [this.fade.a, this.fade.b]) if (e > dmin && e < dmax) fm = Math.max(fm, fadeCPU(this.fade, e));
      const take = Math.min(c.n, Math.ceil(c.n * Math.min(1, fm + 0.06)));
      if (take > 0) list.push({ c, d: dmin, take });
    }
    list.sort((p, q) => p.d - q.d);
    const A = this.A.array as Float32Array, B = this.B.array as Float32Array;
    let n = 0;
    for (const { c, take } of list) {
      const k = Math.min(take, this.cap - n);
      if (k <= 0) break;
      A.set(c.a.subarray(0, k * 4), n * 4); B.set(c.b.subarray(0, k * 4), n * 4);
      n += k;
    }
    this.count = n;
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.A.clearUpdateRanges(); this.A.addUpdateRange(0, n * 4); this.A.needsUpdate = true;
      this.B.clearUpdateRanges(); this.B.addUpdateRange(0, n * 4); this.B.needsUpdate = true;
      // bounds: everything packed lies within rMax of the camera
      this.geo.boundingSphere = new THREE.Sphere(cam.clone(), R + 4);
    }
  }
}

function pack(items: number[][], box: THREE.Box3): ChunkData {
  const a = new Float32Array(items.length * 4), b = new Float32Array(items.length * 4);
  items.forEach((it, k) => { a.set(it.slice(0, 4), k * 4); b.set([it[4], it[5], k / items.length, it[6]], k * 4); });
  return { a, b, n: items.length, box };
}

export interface GroundCover { group: THREE.Group; update(camera: THREE.PerspectiveCamera): void; stats(): Record<string, number> }

export function buildGroundCover(terrain: THREE.Mesh, macro: THREE.Texture): GroundCover {
  const ground = groundFromMesh(terrain);
  const C = castleCentre(), gate = gatehouseFrame();
  const patchN = createNoise2D(mulberry32(hashSeed('grass-patch')));
  const flowerN = createNoise2D(mulberry32(hashSeed('flower-patch')));
  const bridge = (x: number, z: number) => {
    const gx = x - gate.centre[0], gz = z - gate.centre[1], along = gx * gate.out[0] + gz * gate.out[1];
    return Math.abs(gx * gate.dir[0] + gz * gate.dir[1]) < 5 && along > -2 && along < 75;
  };
  const inRegion = (x: number, z: number) => Math.hypot(x - C[0], z - C[1]) < 165;

  /** Candidate tufts in a chunk: [x, y, z, rot, height, width, colourRand]. */
  const tufts = (layer: string, density: number, accept: (x: number, z: number, w: [number, number, number, number], r: Rng) => [number, number] | null) => (ci: number, cj: number) => {
    const x0 = ci * CELL, z0 = cj * CELL;
    if (!inRegion(x0 + CELL / 2, z0 + CELL / 2) && !inRegion(x0, z0) && !inRegion(x0 + CELL, z0 + CELL)) return null;
    const r = mulberry32(hashSeed(`${layer}:${ci},${cj}`));
    const items: number[][] = [];
    const box = new THREE.Box3();
    const N = Math.round(density * CELL * CELL);
    for (let k = 0; k < N; k++) {
      const x = x0 + r() * CELL, z = z0 + r() * CELL, rot = r() * Math.PI * 2, cr = r();
      const w = ground.w(x, z);
      if (!w || bridge(x, z) || !inRegion(x, z)) continue;
      const y = ground.h(x, z);
      if (y < 0.35) continue;
      const hw = accept(x, z, w, r);
      if (!hw) continue;
      items.push([x, y - 0.02, z, rot, hw[0], hw[1], cr]);
      box.expandByPoint(new THREE.Vector3(x, y - 0.1, z)).expandByPoint(new THREE.Vector3(x, y + hw[0] + 0.2, z));
    }
    return items.length ? pack(items, box.expandByScalar(0.5)) : null;
  };

  const grassAccept = (tall: number) => (x: number, z: number, w: [number, number, number, number], r: Rng): [number, number] | null => {
    const g = w[0];
    if (g < 0.22 || r() > smoothstep01(0.22, 0.7, g)) return null;
    const island = pointInPoly(ISLAND, x, z);
    const patch = patchN(x / 9, z / 9);
    let h = (island ? 0.26 : 0.4) * (0.85 + 0.35 * patch);
    if (g < 0.62) h *= 1.45; // unmown tufts along paths, walls and the bank
    return [h * tall * (0.8 + 0.4 * r()), 1];
  };

  const fNear: Fade = { a: 0, b: 1, c: 9, d: 15, fall: 0, widen: 0 };
  const fFar: Fade = { a: 9, b: 15, c: 56, d: 72, fall: 0.8, widen: 0.035 };
  const fFlower: Fade = { a: 0, b: 1, c: 30, d: 48, fall: 0, widen: 0.01 };
  const fReed: Fade = { a: 0, b: 1, c: 210, d: 260, fall: 0, widen: 0.004 };

  const nearB = grassClump('grass-near', { blades: 10, radius: 0.2, width: 0.04, lean: [0.08, 0.5], hMin: 0.45 });
  const farB = grassClump('grass-far', { blades: 8, radius: 0.24, width: 0.07, lean: [0.1, 0.45], hMin: 0.5, segs: 1 });
  const near = new ScatterLayer('grass-near', nearB, vegMaterial('grass', fNear, macro), fNear, 9000, tufts('gn', 7.0, grassAccept(1)));
  const far = new ScatterLayer('grass-far', farB, vegMaterial('grass', fFar, macro), fFar, 16000, tufts('gf', 2.8, grassAccept(1.1)));
  const flowers = new ScatterLayer('flowers', flowerClump(), vegMaterial('flowers', fFlower, macro), fFlower, 3000,
    tufts('fl', 1.6, (x, z, w, r) => {
      const n = flowerN(x / 16, z / 16) + 0.25 * flowerN(x / 4, z / 4);
      if (w[0] < 0.6 || n < 0.38 || r() > (n - 0.38) * 3) return null;
      return [0.22 + 0.18 * r(), 1];
    }));

  // reeds: along the island revetment (in the water) and the outer bank (water's edge), in patches
  const reedItems = new Map<number, number[][]>();
  const rr = mulberry32(hashSeed('reed-place'));
  const reedN = createNoise2D(mulberry32(hashSeed('reed-patch')));
  const walk = (poly: V2[], outward: number, off: [number, number]) => {
    const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length, cz = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    for (let i = 0; i < poly.length; i++) {
      const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length], len = Math.hypot(bx - ax, bz - az);
      for (let d = 0; d < len; d += 0.75) {
        const x = ax + ((bx - ax) * d) / len, z = az + ((bz - az) * d) / len;
        const n = reedN(x / 13, z / 13) + 0.4 * reedN(x / 4, z / 4);
        if (n < 0.1 || rr() > 0.55 + n) continue;
        const ox = x - cx, oz = z - cz, ol = Math.hypot(ox, oz), o = off[0] + (off[1] - off[0]) * rr();
        const px = x + (ox / ol) * o * outward + (rr() - 0.5) * 0.6, pz = z + (oz / ol) * o * outward + (rr() - 0.5) * 0.6;
        if (bridge(px, pz)) continue;
        const y = Math.max(-1.3, sample(px, pz).h);
        if (y > 0.9) continue;
        const k = (Math.floor(px / CELL) + 2048) * 4096 + (Math.floor(pz / CELL) + 2048);
        const list = reedItems.get(k) ?? reedItems.set(k, []).get(k)!;
        list.push([px, y - 0.05, pz, rr() * 6.28, (1.5 + rr() * 0.9) - Math.min(0, y) * 0.6, 1, rr()]);
      }
    }
  };
  walk(ISLAND, 1, [0.3, 1.6]);
  walk(MOAT_OUTER, -1, [-1.2, 1.0]);
  let reedCount = 0;
  const reedChunk = (ci: number, cj: number) => {
    const items = reedItems.get((ci + 2048) * 4096 + (cj + 2048));
    if (!items) return null;
    reedCount += items.length;
    const box = new THREE.Box3();
    for (const it of items) box.expandByPoint(new THREE.Vector3(it[0], it[1], it[2])).expandByPoint(new THREE.Vector3(it[0], it[1] + it[4], it[2]));
    // reeds are all drawn (rank 0) while in range
    const c = pack(items, box.expandByScalar(0.6));
    for (let k = 0; k < c.n; k++) c.b[k * 4 + 2] = 0;
    return c;
  };
  const reeds = new ScatterLayer('reeds', reedClump(), vegMaterial('reeds', fReed, macro), fReed, 4000, reedChunk);

  const layers = [near, far, flowers, reeds];
  const group = new THREE.Group();
  group.name = 'ground-cover';
  for (const l of layers) group.add(l.mesh);
  const frustum = new THREE.Frustum(), pm = new THREE.Matrix4();
  const last = new THREE.Vector3(1e9, 0, 0), lastQ = new THREE.Quaternion();
  return {
    group,
    update(camera) {
      camera.updateMatrixWorld();
      if (camera.position.distanceToSquared(last) < 0.04 && camera.quaternion.angleTo(lastQ) < 0.02) return;
      last.copy(camera.position); lastQ.copy(camera.quaternion);
      pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pm, camera.coordinateSystem);
      // widen the side planes a little so tufts swaying in from the edge are already there
      for (const p of frustum.planes) p.constant += 2;
      for (const l of layers) l.update(camera.position, frustum);
    },
    stats() {
      const o: Record<string, number> = {};
      let tris = 0;
      for (const l of layers) { o[l.name] = l.count; tris += l.count * l.trisPer; }
      o.tris = tris; o.reedsPlaced = [...reedItems.values()].reduce((s, l) => s + l.length, 0);
      void reedCount;
      return o;
    },
  };
}

function smoothstep01(a: number, b: number, x: number) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
