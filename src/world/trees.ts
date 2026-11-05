// Vegetation (game-world-generation recipe 4): a handful of seeded ez-tree variants instanced on the
// island and the near banks, and cheap low-poly canopies for the forests out to the horizon.
import * as THREE from 'three/webgpu';
import { texture, uv, vec3, float, mix, positionWorld, instanceIndex, hash, sin, time, positionLocal, max, normalWorld, smoothstep } from 'three/tsl';
import { Tree } from '@dgreenheck/ez-tree';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createNoise2D } from 'simplex-noise';
import { mulberry32, hashSeed, rngFor } from '../core/rng';
import { sample, footDist } from './terrain';
import { pointInPoly } from '../core/math2d';
import { gatehouseFrame } from '../castle/layout';

interface Variant { target: number; branches: THREE.BufferGeometry; leaves: THREE.BufferGeometry; bark: THREE.Material; leaf: THREE.Material; height: number; tris: number }

function leafMaterial(src: THREE.MeshPhongMaterial, tint: THREE.Color) {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5, roughness: 0.8 });
  const tex = texture(src.map!, uv());
  const v = hash(instanceIndex).mul(0.3).add(0.85);
  m.colorNode = tex.rgb.mul(vec3(tint.r, tint.g, tint.b)).mul(v);
  m.opacityNode = tex.a;
  // sway: the higher up the tree, the more it moves
  const h = max(positionLocal.y, 0);
  const ph = hash(instanceIndex).mul(6.28);
  const s = sin(time.mul(1.4).add(ph).add(positionLocal.x.mul(0.4))).mul(0.012).mul(h);
  m.positionNode = positionLocal.add(vec3(s, 0, s.mul(0.7)));
  return m;
}

function makeVariant(preset: string, seed: number, tune: (o: Tree['options']) => void, tint: THREE.Color, target: number): Variant {
  const t = new Tree();
  t.loadPreset(preset);
  t.options.seed = seed;
  tune(t.options);
  t.generate();
  t.branchesMesh.geometry.computeBoundingBox();
  const bb = t.branchesMesh.geometry.boundingBox!;
  const bark = t.branchesMesh.material as THREE.Material;
  const leaf = leafMaterial(t.leavesMesh.material as THREE.MeshPhongMaterial, tint);
  const tris = (t.branchesMesh.geometry.index!.count + t.leavesMesh.geometry.index!.count) / 3;
  return { target, branches: t.branchesMesh.geometry, leaves: t.leavesMesh.geometry, bark, leaf, height: bb.max.y, tris };
}

export function buildTrees(keepClear: [number, number][] = []) {
  const clear = (x: number, z: number) => keepClear.every(([cx, cz]) => Math.hypot(x - cx, z - cz) > 28);
  const clearWalk = (x: number, z: number) => keepClear.every(([cx, cz]) => Math.hypot(x - cx, z - cz) > 16);
  const group = new THREE.Group();
  group.name = 'trees';
  const r = rngFor('trees');
  const cut = (o: Tree['options']) => {
    const b = o.branch as unknown as { segments: Record<number, number>; sections: Record<number, number> };
    b.segments[0] = Math.min(b.segments[0], 7); b.segments[1] = Math.min(b.segments[1], 5); b.segments[2] = 3; b.segments[3] = 3;
    b.sections[2] = Math.min(b.sections[2], 5); b.sections[3] = Math.min(b.sections[3], 3);
  };
  const lowerLeaves = (o: Tree['options']) => { cut(o); o.leaves.count = Math.min(o.leaves.count, 22); o.leaves.size *= 1.25; };
  const variants: Variant[] = [
    makeVariant('Oak Medium', 11, lowerLeaves, new THREE.Color(0.85, 0.95, 0.75), 13),
    makeVariant('Oak Large', 23, lowerLeaves, new THREE.Color(0.8, 0.9, 0.7), 17),
    makeVariant('Ash Medium', 37, lowerLeaves, new THREE.Color(0.95, 1.0, 0.8), 15),
    makeVariant('Aspen Medium', 41, lowerLeaves, new THREE.Color(1.0, 1.0, 0.8), 14),
    makeVariant('Pine Medium', 53, (o) => { cut(o); o.leaves.count = Math.min(o.leaves.count, 22); }, new THREE.Color(0.75, 0.85, 0.75), 19),
  ];

  // placement: island lawn (few, away from walls and the gate path) + near banks (more, clustered)
  const gate = gatehouseFrame();
  const spots: { x: number; z: number; v: number; s: number; rot: number }[] = [];
  const clump = createNoise2D(mulberry32(hashSeed('clump')));
  const tryIsland = 160, tryBank = 900, maxBank = 95;
  for (let i = 0; i < tryIsland; i++) {
    const x = -75 + r() * 150, z = -70 + r() * 150, s = sample(x, z);
    if (s.zone !== 'island' || s.dEdge < 2.5) continue;
    const fd = footDist(x, z);
    if (fd < 9) continue;
    const gx = x - gate.centre[0], gz = z - gate.centre[1];
    if (Math.abs(gx * gate.dir[0] + gz * gate.dir[1]) < 5 && gx * gate.out[0] + gz * gate.out[1] > 0) continue;
    if (spots.some((p) => Math.hypot(p.x - x, p.z - z) < 7) || !clearWalk(x, z)) continue;
    if (clump(x / 30, z / 30) < -0.2) continue;
    spots.push({ x, z, v: Math.floor(r() * 4), s: 0.7 + r() * 0.35, rot: r() * 6.28 });
    if (spots.length >= 26) break;
  }
  const islandCount = spots.length;
  for (let i = 0; i < tryBank && spots.length - islandCount < maxBank; i++) {
    const a = r() * Math.PI * 2, rad = 85 + Math.pow(r(), 1.4) * 260;
    const x = Math.cos(a) * rad, z = Math.sin(a) * rad, s = sample(x, z);
    if (s.zone !== 'outer' || s.dEdge < 4 || s.h < 1.5 || !clear(x, z)) continue;
    if (clump(x / 45, z / 45) < 0.22) continue;
    if (spots.some((p) => Math.abs(p.x - x) < 6.5 && Math.abs(p.z - z) < 6.5)) continue;
    spots.push({ x, z, v: r() < 0.25 ? 4 : Math.floor(r() * 4), s: 0.8 + r() * 0.5, rot: r() * 6.28 });
  }

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  let tris = 0;
  variants.forEach((v, vi) => {
    const mine = spots.filter((s) => s.v === vi);
    if (!mine.length) return;
    const bm = new THREE.InstancedMesh(v.branches, v.bark, mine.length);
    const lm = new THREE.InstancedMesh(v.leaves, v.leaf, mine.length);
    mine.forEach((s, i) => {
      p.set(s.x, sample(s.x, s.z).h - 0.2, s.z); q.setFromAxisAngle(up, s.rot); sc.setScalar(s.s * v.target / v.height);
      m.compose(p, q, sc); bm.setMatrixAt(i, m); lm.setMatrixAt(i, m);
    });
    for (const im of [bm, lm]) { im.castShadow = true; im.receiveShadow = true; im.computeBoundingSphere(); group.add(im); }
    tris += v.tris * mine.length;
  });

  // far forests: two-lump low-poly canopies with a short trunk
  const lump = (r0: number, dx: number, dy: number, dz: number) => { const g = new THREE.IcosahedronGeometry(r0, 0); g.translate(dx, dy, dz); return g; };
  const canopy = mergeGeometries([lump(1, 0, 1.3, 0), lump(0.75, 0.45, 2.0, 0.2), lump(0.7, -0.4, 1.7, -0.3)]);
  canopy.computeVertexNormals();
  const farMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  {
    const v = hash(instanceIndex);
    const base = mix(vec3(0.045, 0.075, 0.03), vec3(0.075, 0.09, 0.035), v);
    const light = smoothstep(-0.2, 0.9, normalWorld.y).mul(0.35).add(0.75);
    farMat.colorNode = base.mul(light).mul(float(1).add(sin(positionWorld.x.mul(0.9)).mul(sin(positionWorld.z.mul(1.1))).mul(0.12)));
  }
  const forestN = createNoise2D(mulberry32(hashSeed('forest')));
  const farSpots: THREE.Matrix4[] = [];
  const fr = mulberry32(hashSeed('farTrees'));
  for (let i = 0; i < 90000 && farSpots.length < 11000; i++) {
    const a = fr() * Math.PI * 2, rad = 330 + Math.pow(fr(), 1.6) * 3200;
    const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
    const f = forestN(x / 700, z / 700) * 0.7 + forestN(x / 160, z / 160) * 0.3;
    if (f < 0.12) continue;
    const s = sample(x, z);
    if (s.h < 1.5 || s.h > 700 || !clear(x, z)) continue;
    const scale = 6 + fr() * 5;
    p.set(x, s.h - 1, z); q.setFromAxisAngle(up, fr() * 6.28); sc.set(scale * (0.8 + fr() * 0.4), scale * (0.9 + fr() * 0.5), scale * (0.8 + fr() * 0.4));
    farSpots.push(new THREE.Matrix4().compose(p, q, sc));
  }
  const far = new THREE.InstancedMesh(canopy, farMat, farSpots.length);
  farSpots.forEach((mm, i) => far.setMatrixAt(i, mm));
  far.computeBoundingSphere();
  far.castShadow = false; far.receiveShadow = false;
  far.name = 'far-forest';
  group.add(far);
  tris += farSpots.length * canopy.attributes.position.count / 3;
  group.userData = { variantHeights: variants.map((v) => Math.round(v.height)), nearTrees: spots.length, farTrees: farSpots.length, triangles: tris, variantTris: variants.map((v) => v.tris) };
  return group;
}

export { pointInPoly, time };
