// Trees (game-performance-optimization §5–6). Seven seeded ez-tree variants, each in three levels of detail:
//   L0  the full ez-tree mesh, only for the few trees within ~28 m of the camera (scaled by tree size);
//   L1  branches simplified with meshoptimizer and two thirds of the leaf cards dropped (the rest grown
//       to keep the crown full), out to ~72 m;
//   L2  a baked impostor quad (impostors.ts) for everything else, out to the horizon.
// Shadows come from a fixed, even coarser set of casters near the castle on layer 1, which only the
// sun's shadow camera sees, so shadows never pop when a tree changes level.
// Placement is in treePlacement.ts.
import * as THREE from 'three/webgpu';
import { texture, uv, vec3, float, sin, time, positionGeometry, positionLocal, max, normalViewGeometry, dFdx, dFdy, log2, vec2 } from 'three/tsl';
import { Tree } from '@dgreenheck/ez-tree';
import { MeshoptSimplifier } from 'three/addons/libs/meshopt_simplifier.module.js';
import { mulberry32 } from '../core/rng';
import { castleCentre } from '../castle/layout';
import { placeTrees, type Spot } from './treePlacement';
import { bakeImpostors, impostorMaterial, impostorQuad, NE, type Atlas, type BakeSource } from './impostors';

interface Variant {
  name: string; height: number; lod: [number, number];
  b0: THREE.BufferGeometry; l0: THREE.BufferGeometry; b1: THREE.BufferGeometry; l1: THREE.BufferGeometry; bS: THREE.BufferGeometry; lS: THREE.BufferGeometry;
  bark: THREE.Material; leaf: THREE.Material; tris0: number; tris1: number; src: BakeSource;
}


const loaded = (t: THREE.Texture) => new Promise<void>((res) => {
  const t0 = performance.now();
  const poll = () => {
    const img = t.image as HTMLImageElement | undefined;
    if ((img && img.width > 0 && (img.complete ?? true)) || performance.now() - t0 > 15000) res(); else setTimeout(poll, 20);
  };
  poll();
});

function leafMaterial(map: THREE.Texture, tint: THREE.Color) {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5, roughness: 0.78 });
  const tex = texture(map, uv());
  m.colorNode = tex.rgb.mul(vec3(tint.r, tint.g, tint.b));
  // alpha-tested cards lose coverage in the low mips; scale alpha with the mip level (Golus)
  const d = uv().mul(1024), dx = dFdx(d), dy = dFdy(d);
  const lod = max(float(0), log2(max(dx.dot(dx), dy.dot(dy))).mul(0.5));
  m.opacityNode = tex.a.mul(float(1).add(lod.mul(0.25)));
  // crown-shaped normals are baked into the leaf cards; don't flip them on back faces
  m.normalNode = normalViewGeometry;
  // sway: more toward the top of the tree, a slower trunk lean plus a quick flutter of the cards
  const h = max(positionGeometry.y, 0);
  const ph = positionLocal.x.mul(0.05).add(positionLocal.z.mul(0.037));
  const s = sin(time.mul(0.9).add(ph)).mul(0.0035).mul(h).add(sin(time.mul(4.1).add(positionGeometry.x.mul(1.7)).add(positionGeometry.z)).mul(0.025));
  m.positionNode = positionLocal.add(vec3(s, 0, s.mul(0.6)));
  void vec2;
  return m;
}

function barkMaterial(src: THREE.MeshPhongMaterial) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  m.map = src.map; m.normalMap = src.normalMap; m.aoMap = src.aoMap;
  m.color.copy(src.color).multiplyScalar(0.8);
  return m;
}

/** Crown-blended normals for the leaf cards (soft, volumetric shading at every distance). */
function crownNormals(g: THREE.BufferGeometry, crown: THREE.Vector3, k: number) {
  const p = g.attributes.position as THREE.BufferAttribute, n = g.attributes.normal as THREE.BufferAttribute;
  const a = new THREE.Vector3(), r = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    a.set(n.getX(i), n.getY(i), n.getZ(i));
    r.set(p.getX(i) - crown.x, (p.getY(i) - crown.y) * 0.8, p.getZ(i) - crown.z).normalize();
    a.lerp(r, k).normalize();
    n.setXYZ(i, a.x, a.y, a.z);
  }
  n.needsUpdate = true;
}

/** Keep a fraction of the leaf cards (8 vertices each: two crossed quads) and grow the survivors. */
function thinLeaves(g: THREE.BufferGeometry, keep: number, grow: number, seed: number) {
  const p = g.attributes.position as THREE.BufferAttribute, n = g.attributes.normal as THREE.BufferAttribute, t = g.attributes.uv as THREE.BufferAttribute;
  const r = mulberry32(seed), per = 8, leaves = p.count / per;
  const pos: number[] = [], nor: number[] = [], uvs: number[] = [], idx: number[] = [];
  for (let k = 0; k < leaves; k++) {
    if (r() > keep) continue;
    const o = k * per, ox = (p.getX(o + 1) + p.getX(o + 2)) / 2, oy = (p.getY(o + 1) + p.getY(o + 2)) / 2, oz = (p.getZ(o + 1) + p.getZ(o + 2)) / 2;
    const base = pos.length / 3;
    for (let j = 0; j < per; j++) {
      const i = o + j;
      pos.push(ox + (p.getX(i) - ox) * grow, oy + (p.getY(i) - oy) * grow, oz + (p.getZ(i) - oz) * grow);
      nor.push(n.getX(i), n.getY(i), n.getZ(i)); uvs.push(t.getX(i), t.getY(i));
    }
    for (let q = 0; q < per; q += 4) idx.push(base + q, base + q + 1, base + q + 2, base + q, base + q + 2, base + q + 3);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}

/** Simplify the branch mesh; seam vertices are welded by position so the simplifier can collapse them. */
function simplifyBranches(g: THREE.BufferGeometry, ratio: number) {
  const p = g.attributes.position as THREE.BufferAttribute;
  const key = new Map<string, number>(), remap = new Uint32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const k = `${Math.round(p.getX(i) * 1000)},${Math.round(p.getY(i) * 1000)},${Math.round(p.getZ(i) * 1000)}`;
    const j = key.get(k);
    if (j === undefined) { key.set(k, i); remap[i] = i; } else remap[i] = j;
  }
  const src = g.index!.array, ind = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i++) ind[i] = remap[src[i]];
  const target = Math.floor((ind.length * ratio) / 3) * 3;
  const [lod] = MeshoptSimplifier.simplify(ind, new Float32Array(p.array), 3, target, 0.02, []);
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes)) out.setAttribute(name, attr);
  out.setIndex(new THREE.BufferAttribute(lod, 1));
  out.computeBoundingSphere();
  return out;
}

async function makeVariant(o: { name: string; preset: string; seed: number; target: number; tint: THREE.Color; leafType?: string; leafSize?: number; tune?: (o: Tree['options']) => void }): Promise<Variant> {
  const t = new Tree();
  t.loadPreset(o.preset);
  t.options.seed = o.seed;
  const b = t.options.branch as unknown as { segments: Record<number, number>; sections: Record<number, number> };
  b.segments[0] = Math.min(b.segments[0], 8); b.segments[1] = Math.min(b.segments[1], 5); b.segments[2] = 3; b.segments[3] = 3;
  b.sections[2] = Math.min(b.sections[2], 5); b.sections[3] = Math.min(b.sections[3], 3);
  t.options.leaves.size *= o.leafSize ?? 1.3;
  if (o.leafType) (t.options.leaves as { type: string }).type = o.leafType;
  o.tune?.(t.options);
  t.generate();
  const b0 = t.branchesMesh.geometry, l0 = t.leavesMesh.geometry;
  const bb = new THREE.Box3().setFromBufferAttribute(b0.attributes.position as THREE.BufferAttribute).union(new THREE.Box3().setFromBufferAttribute(l0.attributes.position as THREE.BufferAttribute));
  const k = o.target / bb.max.y;
  b0.scale(k, k, k); l0.scale(k, k, k);
  // index buffers as 32-bit (the simplifier and merged leaf sets can pass 65k)
  b0.setIndex(new THREE.BufferAttribute(new Uint32Array(b0.index!.array), 1));
  const lp = l0.attributes.position as THREE.BufferAttribute, crown = new THREE.Vector3();
  for (let i = 0; i < lp.count; i++) crown.add(new THREE.Vector3(lp.getX(i), lp.getY(i), lp.getZ(i)));
  crown.divideScalar(lp.count);
  let crownR = 0;
  for (let i = 0; i < lp.count; i++) crownR = Math.max(crownR, Math.hypot(lp.getX(i) - crown.x, (lp.getY(i) - crown.y) * 0.8, lp.getZ(i) - crown.z));
  crownR *= 0.85;
  crownNormals(l0, crown, 0.6);
  const l1 = thinLeaves(l0, 0.3, 1.55, o.seed * 7 + 1);
  const b1 = simplifyBranches(b0, 0.16);
  // shadow casters: coarser still (a 4 cm shadow texel hides the difference)
  const lS = thinLeaves(l0, 0.2, 1.9, o.seed * 7 + 2), bS = simplifyBranches(b0, 0.08);
  const phongLeaf = t.leavesMesh.material as THREE.MeshPhongMaterial, phongBark = t.branchesMesh.material as THREE.MeshPhongMaterial;
  const tint = o.tint.clone();
  await Promise.all([loaded(phongLeaf.map!), loaded(phongBark.map!)]);
  const leaf = leafMaterial(phongLeaf.map!, tint), bark = barkMaterial(phongBark);
  const tri = (g: THREE.BufferGeometry) => g.index!.count / 3;
  // ?treeLod=k scales the LOD distances (0 = impostors only), for checking the impostors against the meshes
  const f = Math.sqrt(o.target / 15) * Number(new URLSearchParams(location.search).get('treeLod') ?? 1);
  return {
    name: o.name, height: o.target, lod: [28 * f, 72 * f], b0, l0, b1, l1, bS, lS, bark, leaf,
    tris0: tri(b0) + tri(l0), tris1: tri(b1) + tri(l1),
    src: { branches: b0, leaves: l0, barkMap: phongBark.map!, leafMap: phongLeaf.map!, barkTint: new THREE.Color(0.55, 0.5, 0.45), leafTint: tint, crown, crownR },
  };
}

// ---------------------------------------------------------------------------------------------
// LOD manager
// ---------------------------------------------------------------------------------------------

interface Chunk { mesh: THREE.Mesh; a: THREE.InstancedBufferAttribute; b: THREE.InstancedBufferAttribute; dirty: boolean }

export class TreeLOD {
  group = new THREE.Group();
  level: Int8Array;
  private active = new Set<number>();
  private grid = new Map<number, number[]>();
  private chunkOf: Int32Array; private slotOf: Int32Array;
  private chunks: Chunk[] = [];
  private meshes: { l0: THREE.InstancedMesh[]; l1: THREE.InstancedMesh[] }[] = [];
  private last = new THREE.Vector3(1e9, 0, 0);
  private mat = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private col = new THREE.Color();
  stats = { l0: 0, l1: 0, impostors: 0, shadowProxies: 0, tris: 0 };
  static CELL = 50;

  constructor(public spots: Spot[], public variants: Variant[], atlas: Atlas, shadowCentre: [number, number], shadowR: number) {
    this.group.name = 'trees';
    this.level = new Int8Array(spots.length).fill(-1);
    this.chunkOf = new Int32Array(spots.length); this.slotOf = new Int32Array(spots.length);
    // spatial hash for the LOD query
    spots.forEach((p, i) => {
      const k = this.key(Math.floor(p.x / TreeLOD.CELL), Math.floor(p.z / TreeLOD.CELL));
      (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(i);
    });

    // impostor chunks: 16 sectors × distance rings, each frustum-culled on its own
    const ringOf = (d: number) => (d < 220 ? 0 : d < 520 ? 1 : d < 1100 ? 2 : d < 2200 ? 3 : 4);
    const buckets = new Map<number, number[]>();
    spots.forEach((p, i) => {
      const sec = Math.floor(((Math.atan2(p.z, p.x) + Math.PI) / (Math.PI * 2)) * 16) % 16;
      const k = ringOf(Math.hypot(p.x, p.z)) * 16 + sec;
      (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i);
    });
    const quad = impostorQuad(), mat = impostorMaterial(atlas);
    for (const ids of buckets.values()) {
      const g = new THREE.InstancedBufferGeometry();
      g.index = quad.index; g.setAttribute('position', quad.attributes.position); g.setAttribute('uv', quad.attributes.uv);
      const A = new Float32Array(ids.length * 4), Bv = new Float32Array(ids.length * 4);
      const box = new THREE.Box3();
      ids.forEach((id, k) => {
        const p = spots[id];
        A.set([p.x, p.y, p.z, p.rot], k * 4); Bv.set([p.s, p.v * NE, p.b, p.w], k * 4);
        this.chunkOf[id] = this.chunks.length; this.slotOf[id] = k;
        const h = variants[p.v].height * p.s * Math.max(1, p.w);
        box.expandByPoint(new THREE.Vector3(p.x - h, p.y - h * 0.3, p.z - h)).expandByPoint(new THREE.Vector3(p.x + h, p.y + h * 1.3, p.z + h));
      });
      const a = new THREE.InstancedBufferAttribute(A, 4), b = new THREE.InstancedBufferAttribute(Bv, 4);
      b.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('iA', a); g.setAttribute('iB', b);
      g.instanceCount = ids.length;
      g.boundingBox = box; g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = false; mesh.receiveShadow = false; mesh.name = 'tree-impostors';
      this.group.add(mesh);
      this.chunks.push({ mesh, a, b, dirty: false });
    }

    // mesh LODs (instanced, rebuilt as the camera moves) and the fixed shadow casters near the castle
    const count = new Array(variants.length).fill(0);
    spots.forEach((p) => count[p.v]++);
    variants.forEach((v, vi) => {
      const cap = Math.min(count[vi], 600);
      const mk = (g: THREE.BufferGeometry, m: THREE.Material, name: string) => {
        const im = new THREE.InstancedMesh(g, m, Math.max(1, cap));
        im.count = 0; im.visible = false; im.castShadow = false; im.receiveShadow = true; im.name = name;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.setColorAt(0, this.col.setRGB(1, 1, 1));
        this.group.add(im);
        return im;
      };
      this.meshes.push({ l0: [mk(v.b0, v.bark, `${v.name}-l0b`), mk(v.l0, v.leaf, `${v.name}-l0l`)], l1: [mk(v.b1, v.bark, `${v.name}-l1b`), mk(v.l1, v.leaf, `${v.name}-l1l`)] });
      const casters = spots.filter((p) => p.v === vi && Math.hypot(p.x - shadowCentre[0], p.z - shadowCentre[1]) < shadowR);
      if (!casters.length) return;
      for (const [g, m] of [[v.bS, v.bark], [v.lS, v.leaf]] as const) {
        const im = new THREE.InstancedMesh(g, m, casters.length);
        casters.forEach((p, i) => im.setMatrixAt(i, this.matrixOf(p)));
        im.computeBoundingSphere();
        im.castShadow = true; im.receiveShadow = false;
        im.layers.set(1); // seen only by the sun's shadow camera
        im.name = `${v.name}-shadow`;
        this.group.add(im);
      }
      this.stats.shadowProxies += casters.length;
    });
  }

  private key(i: number, j: number) { return (i + 4096) * 8192 + (j + 4096); }

  private matrixOf(p: Spot) {
    return this.mat.compose(new THREE.Vector3(p.x, p.y, p.z), this.q.setFromAxisAngle(this.up, p.rot), new THREE.Vector3(p.s, p.s, p.s));
  }

  update(cam: THREE.Vector3) {
    if (cam.distanceToSquared(this.last) < 0.25) return;
    this.last.copy(cam);
    const maxR = Math.max(...this.variants.map((v) => v.lod[1])) * 1.05;
    const C = TreeLOD.CELL, i0 = Math.floor((cam.x - maxR) / C), i1 = Math.floor((cam.x + maxR) / C), j0 = Math.floor((cam.z - maxR) / C), j1 = Math.floor((cam.z + maxR) / C);
    const next = new Set<number>();
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const ids = this.grid.get(this.key(i, j));
      if (!ids) continue;
      for (const id of ids) {
        const p = this.spots[id], v = this.variants[p.v];
        const d = Math.hypot(p.x - cam.x, p.y + v.height * p.s * 0.4 - cam.y, p.z - cam.z) / Math.max(0.6, p.s);
        const was = this.level[id], hy = 1.06;
        const l1 = v.lod[1] * (was >= 0 ? hy : 1 / hy), l0 = v.lod[0] * (was === 0 ? hy : 1 / hy);
        if (d < l1) { next.add(id); this.level[id] = d < l0 ? 0 : 1; }
      }
    }
    for (const id of this.active) if (!next.has(id)) { this.level[id] = -1; this.setImpostor(id, true); }
    for (const id of next) if (!this.active.has(id)) this.setImpostor(id, false);
    this.active = next;
    for (const c of this.chunks) if (c.dirty) { c.b.needsUpdate = true; c.dirty = false; }

    const n0 = new Array(this.variants.length).fill(0), n1 = new Array(this.variants.length).fill(0);
    let tris = 0;
    for (const id of this.active) {
      const p = this.spots[id], lv = this.level[id], set = this.meshes[p.v], ms = lv === 0 ? set.l0 : set.l1, n = lv === 0 ? n0 : n1;
      if (n[p.v] >= ms[0].instanceMatrix.count) { this.level[id] = -1; this.setImpostor(id, true); continue; }
      const m = this.matrixOf(p);
      this.col.setScalar(p.b);
      for (const im of ms) { im.setMatrixAt(n[p.v], m); im.setColorAt(n[p.v], this.col); }
      n[p.v]++;
    }
    for (const c of this.chunks) if (c.dirty) { c.b.needsUpdate = true; c.dirty = false; }
    this.meshes.forEach((set, vi) => {
      for (const [ms, n] of [[set.l0, n0[vi]], [set.l1, n1[vi]]] as const) for (const im of ms) {
        im.count = n; im.visible = n > 0;
        if (n > 0) { im.instanceMatrix.needsUpdate = true; im.instanceColor!.needsUpdate = true; im.computeBoundingSphere(); }
      }
      tris += n0[vi] * this.variants[vi].tris0 + n1[vi] * this.variants[vi].tris1;
    });
    this.stats.l0 = n0.reduce((a, b) => a + b, 0); this.stats.l1 = n1.reduce((a, b) => a + b, 0);
    this.stats.impostors = this.spots.length - this.stats.l0 - this.stats.l1;
    this.stats.tris = tris + this.stats.impostors * 2;
  }

  private setImpostor(id: number, show: boolean) {
    const c = this.chunks[this.chunkOf[id]];
    (c.b.array as Float32Array)[this.slotOf[id] * 4] = show ? this.spots[id].s : 0;
    c.dirty = true;
  }
}

export async function buildTrees(renderer: THREE.WebGPURenderer, keepClear: [number, number][]) {
  await MeshoptSimplifier.ready;
  const t0 = performance.now();
  const variants = await Promise.all([
    makeVariant({ name: 'oakM', preset: 'Oak Medium', seed: 11, target: 13, tint: new THREE.Color(0.78, 0.8, 0.72) }),
    makeVariant({ name: 'oakL', preset: 'Oak Large', seed: 23, target: 18, tint: new THREE.Color(0.74, 0.78, 0.7) }),
    makeVariant({ name: 'ash', preset: 'Ash Medium', seed: 37, target: 15, tint: new THREE.Color(0.9, 0.88, 0.76) }),
    makeVariant({ name: 'ashL', preset: 'Ash Large', seed: 41, target: 17, tint: new THREE.Color(0.86, 0.86, 0.74) }),
    makeVariant({ name: 'pine', preset: 'Pine Medium', seed: 53, target: 19, leafSize: 1.15, tint: new THREE.Color(0.68, 0.74, 0.74) }),
    makeVariant({ name: 'bushA', preset: 'Bush 1', seed: 61, target: 3.6, tint: new THREE.Color(0.8, 0.8, 0.68) }),
    makeVariant({ name: 'bushB', preset: 'Bush 2', seed: 67, target: 3.1, leafType: 'oak', tint: new THREE.Color(0.8, 0.84, 0.72) }),
  ]);
  const tVar = performance.now() - t0;
  const atlas = bakeImpostors(renderer, variants.map((v) => v.src));
  const spots = placeTrees(keepClear);
  const C = castleCentre();
  const lod = new TreeLOD(spots, variants, atlas, C, 140);
  lod.group.userData = {
    variants: variants.map((v) => ({ name: v.name, h: v.height, tris0: v.tris0, tris1: v.tris1 })),
    trees: spots.length, buildMs: Math.round(performance.now() - t0), variantMs: Math.round(tVar),
  };
  return lod;
}
