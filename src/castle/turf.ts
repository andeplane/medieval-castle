// The turf strip along the top of the revetment. The terrain grid (~0.9 m cells) cannot step straight down
// at the wall, so its last cell sags toward the moat; this strip lies 3 cm above the true ground from under
// the coping to 1.9 m in, where the terrain is level again, and hides that sag. It uses the terrain material
// with the same mask weights, so it reads as the same lawn. Where the coping is gone it ends in a low earth
// face over the broken wall top.
import * as THREE from 'three/webgpu';
import { type V2, smoothstep, clamp } from '../core/math2d';
import { REVET, type RevetmentPlan } from './revetment';

export type Mask = [number, number, number, number]; // grass, dirt, rock, mud

export interface RimMaskInput {
  footDist: (x: number, z: number) => number;
  noise: (x: number, z: number) => number;
  /** The worn path out of the gate. */
  gate?: { centre: V2; dir: V2; out: V2 };
}

/** Ground weights for the strip: the terrain's island weights, with a little less mud right at the coping. */
export function rimMask(inp: RimMaskInput) {
  return (x: number, z: number, e: number): Mask => {
    const wob = inp.noise(x / 7, z / 7);
    let dirt = clamp(1 - smoothstep(1.5, 4.0 + 1.6 * wob, inp.footDist(x, z)), 0, 1) * 0.85;
    const g = inp.gate;
    if (g) {
      const gd = Math.abs((x - g.centre[0]) * g.dir[0] + (z - g.centre[1]) * g.dir[1]);
      const along = (x - g.centre[0]) * g.out[0] + (z - g.centre[1]) * g.out[1];
      if (along > 0 && along < 30) dirt = Math.max(dirt, (1 - smoothstep(1.6, 3.2 + wob, gd)) * 0.9);
    }
    const mud = (1 - smoothstep(0.3, 2.2, e)) * (0.55 + 0.45 * smoothstep(0.2, REVET.turfIn, e));
    const grass = Math.max(0, 1 - dirt - mud);
    const t = grass + dirt + mud || 1;
    return [grass / t, dirt / t, 0, mud / t];
  };
}

export interface TurfGeom { positions: Float32Array; uvs: Float32Array; masks: Float32Array; indices: Uint32Array }

const ROWS = [0, 0.0, 0.35, 0.7, 1.1, 1.5, REVET.turfIn]; // row 0 is the outer edge (depends on damage)

export function rimTurf(plan: RevetmentPlan, groundAt: (x: number, z: number) => number, maskAt: (x: number, z: number, e: number) => Mask): TurfGeom {
  const n = plan.st.length;
  const pos: number[] = [], uv: number[] = [], mask: number[] = [], idx: number[] = [];
  const excluded: boolean[] = [];
  const cols: { damaged: boolean; base: number }[] = [];
  const ragged = (i: number, u: number) => { const R = plan.segs[i].ragged, k = Math.min(3, Math.floor(u * 4)), f = u * 4 - k; return R[k] + (R[k + 1] - R[k]) * f; };
  for (let i = 0; i < n; i++) {
    const L = plan.arc[i + 1] - plan.arc[i], m = Math.max(1, Math.ceil(L / 0.6));
    const prev = (i + n - 1) % n;
    for (let k = 0; k < m; k++) {
      const u = k / m;
      const damaged = plan.segs[i].damaged || (k === 0 && plan.segs[prev].damaged);
      const base = pos.length / 3;
      cols.push({ damaged, base });
      const vert = (e: number, y: number) => {
        const p = plan.at(i, u, e);
        pos.push(p[0], y, p[1]); uv.push(p[0] / 3.7, -p[1] / 3.7);
        mask.push(...maskAt(p[0], p[1], Math.max(e, 0)));
        excluded.push(plan.exclude(p[0], p[1]));
      };
      ROWS.forEach((e0, r) => {
        const e = r === 0 ? (damaged ? -0.1 : REVET.turfOut) : e0;
        const q = plan.at(i, u, Math.max(e, REVET.level));
        const lift = e >= REVET.turfIn - 1e-6 ? 0.022 : 0.035;
        vert(e, groundAt(q[0], q[1]) + lift - (r === 0 && damaged ? 0.06 : 0));
      });
      // skirt foot: on the broken wall top where the coping is gone, else on the outer edge
      const yR = plan.segs[i].damaged ? ragged(i, u) : plan.segs[prev].damaged && k === 0 ? ragged(prev, 1) : null;
      const outer = pos.slice(base * 3, base * 3 + 3);
      if (yR === null) { pos.push(outer[0], outer[1], outer[2]); uv.push(outer[0] / 3.7, -outer[2] / 3.7); mask.push(...mask.slice(base * 4, base * 4 + 4)); excluded.push(excluded[base]); }
      else vert(-0.1, yR + 0.05);
    }
  }
  const P = (v: number) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
  const push = (a: number, b: number, c: number, want: (n: number[]) => boolean) => {
    const A = P(a), B = P(b), C = P(c);
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const nn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (Math.hypot(nn[0], nn[1], nn[2]) < 1e-8) return;
    if (want(nn)) idx.push(a, b, c); else idx.push(a, c, b);
  };
  for (let c = 0; c < cols.length; c++) {
    const A = cols[c], B = cols[(c + 1) % cols.length];
    for (let r = 0; r < ROWS.length - 1; r++) {
      const q = [A.base + r, B.base + r, B.base + r + 1, A.base + r + 1];
      if (q.every((v) => excluded[v])) continue;
      push(q[0], q[1], q[2], (nn) => nn[1] > 0);
      push(q[0], q[2], q[3], (nn) => nn[1] > 0);
    }
    if (A.damaged && B.damaged) {
      const s0 = A.base + ROWS.length, s1 = B.base + ROWS.length, o0 = A.base, o1 = B.base;
      const s = P(s0), outward = [s[0] - P(o0 + 2)[0], 0, s[2] - P(o0 + 2)[2]];
      const want = (nn: number[]) => nn[0] * outward[0] + nn[2] * outward[2] > 0;
      push(s0, s1, o1, want);
      push(s0, o1, o0, want);
    }
  }
  return { positions: new Float32Array(pos), uvs: new Float32Array(uv), masks: new Float32Array(mask), indices: new Uint32Array(idx) };
}

export function rimTurfMesh(geom: TurfGeom, material: THREE.Material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(geom.positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(geom.uvs, 2));
  g.setAttribute('mask', new THREE.BufferAttribute(geom.masks, 4));
  // (farmland, moor, scree, wet) are all zero on the island
  g.setAttribute('mask2', new THREE.BufferAttribute(new Float32Array(geom.masks.length), 4));
  g.setIndex(new THREE.BufferAttribute(geom.indices, 1));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  m.name = 'revetment-turf';
  m.receiveShadow = true;
  return m;
}
