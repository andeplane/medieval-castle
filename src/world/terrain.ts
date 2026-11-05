// Seeded terrain (game-world-generation): one height function used by the meshes, the walk camera and
// tree placement. Island ground around the castle, irregular moat, banks, rolling farmland, forests and
// a mountain range to the north and west. The island is the only playable ground.
import * as THREE from 'three/webgpu';
import { createNoise2D } from 'simplex-noise';
import { mulberry32, hashSeed } from '../core/rng';
import { type V2, pointInPoly, edgeDist, smoothstep, clamp } from '../core/math2d';
import { GROUND, MOAT } from '../castle/spec';
import { islandOutline, moatOuter, footprints, courtyard, castleCentre, gatehouseFrame } from '../castle/layout';

const n1 = createNoise2D(mulberry32(hashSeed('terrain-a')));
const n2 = createNoise2D(mulberry32(hashSeed('terrain-b')));
const n3 = createNoise2D(mulberry32(hashSeed('terrain-c')));
const fbm = (f: (x: number, y: number) => number, x: number, z: number, o: number, lac = 2.03, g = 0.5) => { let s = 0, a = 1, fr = 1, n = 0; for (let i = 0; i < o; i++) { s += a * f(x * fr, z * fr); n += a; a *= g; fr *= lac; } return s / n; };
const ridged = (x: number, z: number, o: number) => { let s = 0, a = 1, fr = 1, n = 0, w = 1; for (let i = 0; i < o; i++) { let v = 1 - Math.abs(n3(x * fr, z * fr)); v *= v * w; w = clamp(v * 1.6, 0, 1); s += a * v; n += a; a *= 0.5; fr *= 2.1; } return s / n; };

export const ISLAND = islandOutline();
export const MOAT_OUTER = moatOuter(ISLAND);
const FOOT = footprints();
const COURT = courtyard();
const CC = castleCentre();
const GATE = gatehouseFrame();

function footDist(x: number, z: number) {
  let d = 1e9;
  for (const p of FOOT) { if (pointInPoly(p, x, z)) return 0; d = Math.min(d, edgeDist(p, x, z).d); }
  return d;
}

export interface Sample { h: number; zone: 'island' | 'moat' | 'outer'; dEdge: number }

export function sample(x: number, z: number): Sample {
  const r = Math.hypot(x, z);
  if (r < 140 && pointInPoly(ISLAND, x, z)) {
    const e = edgeDist(ISLAND, x, z).d;
    const dc = Math.hypot(x - CC[0], z - CC[1]);
    let h = GROUND + 0.35 * fbm(n1, x / 40, z / 40, 3) - 0.9 * smoothstep(28, 60, dc);
    // little rocky rise by the great tower, hollows in the south-east lawn
    h += 1.1 * Math.max(0, 1 - Math.hypot(x + 40, z + 24) / 11) * (0.7 + 0.3 * n2(x / 6, z / 6));
    h -= 0.35 * Math.max(0, n2(x / 25 + 3, z / 25)) * smoothstep(35, 50, dc);
    // flatten the ward next to the walls and the courtyard
    const fd = footDist(x, z);
    h = h + (GROUND - 0.05 - h) * (1 - smoothstep(2, 9, fd));
    if (pointInPoly(COURT, x, z)) h = GROUND + 0.02;
    // the bank is faced with a stone revetment, so the ground holds its level right to the edge
    const bank = smoothstep(0.1, 0.9, e);
    h = -1.4 + (h + 1.4) * bank;
    return { h, zone: 'island', dEdge: e };
  }
  if (r < 210 && pointInPoly(MOAT_OUTER, x, z)) {
    const e = Math.min(edgeDist(ISLAND, x, z).d, edgeDist(MOAT_OUTER, x, z).d);
    return { h: -0.6 + (MOAT.bed + 0.6) * smoothstep(0, 7, e) + 0.3 * n2(x / 9, z / 9), zone: 'moat', dEdge: e };
  }
  const e = r < 260 ? edgeDist(MOAT_OUTER, x, z).d : r - 100;
  // outer bank, rising farmland and hills
  let h = 0.5 + 2.2 * smoothstep(0, 7, e) + 1.2 * smoothstep(5, 40, e) * fbm(n1, x / 70, z / 70, 3);
  const hills = fbm(n1, x / 650, z / 650, 5);
  h += smoothstep(30, 420, e) * (16 + 34 * hills) + e * 0.004;
  // a lake to the east
  const lake = Math.hypot((x - 760) / 1.25, z - 330);
  h -= 22 * (1 - smoothstep(170, 330, lake));
  // mountains north and west, 1.6–6 km out
  const ang = Math.atan2(z, x);
  const dirW = smoothstep(-0.2, 0.9, -Math.sin(ang) * 0.85 - Math.cos(ang) * 0.55 + 0.25);
  const ring = smoothstep(1500, 3600, r) * (1 - smoothstep(7000, 9500, r));
  const m = ridged(x / 2600, z / 2600, 6);
  const massif = 0.5 + 0.5 * fbm(n1, x / 3000 + 11, z / 3000, 3);
  h += ring * dirW * massif * (720 * m * m + 260 * m + 140 * fbm(n2, x / 700, z / 700, 4));
  // gentler far hills elsewhere
  h += smoothstep(1200, 4000, r) * (1 - dirW) * 160 * (0.5 + 0.5 * fbm(n2, x / 1600 + 7, z / 1600, 4));
  return { h, zone: 'outer', dEdge: e };
}

export const heightAt = (x: number, z: number) => sample(x, z).h;

/** Ground weights (grass, dirt, rock, mud) for a vertex. */
function maskFor(x: number, z: number, s: Sample, slope: number): [number, number, number, number] {
  let grass = 1, dirt = 0, rock = 0, mud = 0;
  const wob = n2(x / 7, z / 7);
  if (s.zone === 'island') {
    const fd = footDist(x, z);
    dirt = clamp(1 - smoothstep(1.5, 4.0 + 1.6 * wob, fd), 0, 1) * 0.85;
    // worn path from the gate toward the south-east lawn
    const g = GATE.centre, gd = Math.abs((x - g[0]) * GATE.dir[0] + (z - g[1]) * GATE.dir[1]);
    const along = (x - g[0]) * GATE.out[0] + (z - g[1]) * GATE.out[1];
    if (along > 0 && along < 30) dirt = Math.max(dirt, (1 - smoothstep(1.6, 3.2 + wob, gd)) * 0.9);
    if (pointInPoly(COURT, x, z)) { dirt = 0.6; rock = 0.4; grass = 0; }
    mud = 1 - smoothstep(0.3, 2.2, s.dEdge);
    rock = Math.max(rock, smoothstep(0.35, 0.7, slope) * 0.8, Math.max(0, 1 - Math.hypot(x + 40, z + 24) / 9) * 0.9);
  } else if (s.zone === 'moat') {
    mud = 1; grass = 0;
  } else {
    mud = 1 - smoothstep(0.5, 3, s.dEdge);
    rock = smoothstep(0.42, 0.75, slope + 0.1 * wob) + smoothstep(600, 1100, s.h) * 0.7;
    dirt = 0.25 * smoothstep(0.3, 0.8, n1(x / 140, z / 140)) * (1 - smoothstep(400, 900, Math.hypot(x, z)));
    if (s.h < 1.2 && s.h > -1) mud = Math.max(mud, 0.6);
  }
  grass = Math.max(0, grass - dirt - rock - mud);
  const t = grass + dirt + rock + mud || 1;
  return [grass / t, dirt / t, rock / t, mud / t];
}

function buildGrid(size: number, seg: number, drop: ((x: number, z: number) => number) | null, cx = 0, cz = 0) {
  const g = new THREE.PlaneGeometry(size, size, seg, seg);
  g.rotateX(-Math.PI / 2);
  g.translate(cx, 0, cz);
  const p = g.attributes.position as THREE.BufferAttribute;
  const samples: Sample[] = new Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), s = sample(x, z);
    samples[i] = s;
    p.setY(i, s.h - (drop ? drop(x, z) : 0));
  }
  g.computeVertexNormals();
  const nrm = g.attributes.normal as THREE.BufferAttribute, mask = new Float32Array(p.count * 4);
  for (let i = 0; i < p.count; i++) mask.set(maskFor(p.getX(i), p.getZ(i), samples[i], 1 - nrm.getY(i)), i * 4);
  g.setAttribute('mask', new THREE.BufferAttribute(mask, 4));
  worldUV(g);
  return g;
}

function worldUV(g: THREE.BufferGeometry) {
  const p = g.attributes.position as THREE.BufferAttribute, uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / 3.7; uv[i * 2 + 1] = -p.getZ(i) / 3.7; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Polar far terrain: rings with growing spacing out to the horizon. */
function buildFar(inner: number, outer: number, rings: number, segs: number, drop: (x: number, z: number) => number) {
  const pos: number[] = [], idx: number[] = [];
  const radii: number[] = [];
  for (let i = 0; i <= rings; i++) radii.push(inner * Math.pow(outer / inner, i / rings));
  for (const r of radii) for (let j = 0; j <= segs; j++) { const a = (j / segs) * Math.PI * 2; const x = Math.cos(a) * r, z = Math.sin(a) * r; pos.push(x, heightAt(x, z) - drop(x, z), z); }
  const W = segs + 1;
  for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) { const a = i * W + j, b = a + 1, c = a + W, d = c + 1; idx.push(a, b, c, b, d, c); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const p = g.attributes.position as THREE.BufferAttribute, nrm = g.attributes.normal as THREE.BufferAttribute, mask = new Float32Array(p.count * 4);
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i); mask.set(maskFor(x, z, sample(x, z), 1 - nrm.getY(i)), i * 4); }
  g.setAttribute('mask', new THREE.BufferAttribute(mask, 4));
  worldUV(g);
  return g;
}

export function buildTerrain(material: THREE.Material) {
  const NEAR = 380;
  const inside = (x: number, z: number) => NEAR / 2 - Math.max(Math.abs(x), Math.abs(z));
  const group = new THREE.Group();
  group.name = 'terrain';
  const near = new THREE.Mesh(buildGrid(NEAR, 420, null), material);
  near.receiveShadow = true; near.name = 'terrain-near';
  const far = new THREE.Mesh(buildFar(150, 16000, 150, 360, (x, z) => 4 * smoothstep(0, 25, inside(x, z))), material);
  far.receiveShadow = false; far.name = 'terrain-far';
  group.add(near, far);
  return group;
}

export function islandWalkable(x: number, z: number) {
  return pointInPoly(ISLAND, x, z) && edgeDist(ISLAND, x, z).d > 1.2 && footDist(x, z) > 0.6;
}
export { footDist };
export type { V2 };
