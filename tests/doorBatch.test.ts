// The door batches draw in one call each (2026-11-08). WebGPU in three r187 has no multi-draw: a
// BatchedMesh cost one drawIndexed per shown leaf class, 192 a pass at the courtyard on Anders' Mac.
// Each batch is now one mesh with its instances baked in world space and an index of the shown ones;
// these tests check that it draws exactly what the instances say, and one call per batch and pass.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { threeBatch, bakeInstance, type BatchFactory, type BatchLike } from '../src/castle/interior/doorBatch';
import { buildCastleDoors, type DoorMats } from '../src/castle/interior/doors';
import { m4mul, m4rotX, m4scale, m4swing, m4translate } from '../src/castle/interior/doorGeom';
import type { PartBin } from '../src/castle/interior/doorParts';
import { planInterior } from '../src/castle/interior/plan';
import { playDoors } from '../src/player/setup';
import { GROUND } from '../src/castle/spec';
import { portcullisInPlan } from '../src/castle/interior/portcullis';
import { mulberry32 } from '../src/core/rng';
import { fakeBatch } from './helpers/doorFakes';

const tri = (s = 1): PartBin => ({ pos: [0, 0, 0, s, 0, 0, 0, s, 0], nor: [0, 0, 1, 0, 0, 1, 0, 0, 1], uv: [0, 0, 1, 0, 0, 1] });
const quad: PartBin = { pos: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0], nor: Array(6).fill([0.6, 0, 0.8]).flat(), uv: Array(12).fill(0.5) };

/** The draw calls WebGPU issues for `root` from `camera`: three r187 draws a BatchedMesh as one call per
 *  run of shown instances that share a geometry (no multi-draw), every other mesh as one. */
function webgpuDraws(root: THREE.Object3D, camera: THREE.Camera): number {
  let n = 0;
  const walk = (o: THREE.Object3D) => {
    if (!o.visible) return;
    if ((o as THREE.BatchedMesh).isBatchedMesh) {
      const b = o as unknown as { _updateDrawParameters(c: THREE.Camera, g: THREE.BufferGeometry, m: THREE.Material, f: string): void; _mergedDrawCount: number; geometry: THREE.BufferGeometry; material: THREE.Material };
      b._updateDrawParameters(camera, b.geometry, b.material, 'merged');
      n += b._mergedDrawCount;
    } else if ((o as THREE.Mesh).isMesh) n++;
    o.children.forEach(walk);
  };
  walk(root);
  return n;
}

/** What a merged batch draws: its indexed triangles' positions, normals, colours. */
function drawn(b: BatchLike) {
  b.flush!();
  const m = b.object as THREE.Mesh, g = m.geometry, ix = g.index!.array, n = g.drawRange.count;
  const P = g.getAttribute('position').array, N = g.getAttribute('normal').array, C = g.getAttribute('color')?.array;
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  for (let k = 0; k < n; k++) for (let c = 0; c < 3; c++) { pos.push(P[3 * ix[k] + c]); nor.push(N[3 * ix[k] + c]); col.push(C ? C[3 * ix[k] + c] : 1); }
  return { pos, nor, col, visible: m.visible };
}

/** What a BatchedMesh draws for the same calls (three's batching: matrix per instance, normals by BatchNode). */
function expected(rec: ReturnType<typeof fakeBatch>['made'][number]) {
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  rec.inst.forEach((g, i) => {
    if (rec.hidden.has(i)) return;
    const src = rec.geoms[g], m = new THREE.Matrix4().fromArray(rec.mats.get(i) ?? new THREE.Matrix4().toArray());
    const e = m.elements, s2 = [0, 1, 2].map((c) => e[4 * c] ** 2 + e[4 * c + 1] ** 2 + e[4 * c + 2] ** 2);
    const m3 = new THREE.Matrix3().setFromMatrix4(m);
    for (let v = 0; v < src.pos.length / 3; v++) {
      pos.push(...new THREE.Vector3().fromArray(src.pos, 3 * v).applyMatrix4(m).toArray());
      nor.push(...new THREE.Vector3(src.nor[3 * v] / s2[0], src.nor[3 * v + 1] / s2[1], src.nor[3 * v + 2] / s2[2]).applyMatrix3(m3).toArray());
      col.push(...(rec.cols.get(i) ?? [1, 1, 1]));
    }
  });
  return { pos, nor, col };
}

/** A factory that builds the real batch and records every call on a fake, to compare the two. */
function tee() {
  const fb = fakeBatch(), real: BatchLike[] = [];
  const factory: BatchFactory = (name, mat, i, v) => {
    const a = threeBatch(name, mat, i, v), b = fb.factory(name, mat, i, v);
    real.push(a);
    return {
      object: a.object,
      addGeometry: (g) => { b.addGeometry(g); return a.addGeometry(g); },
      addInstance: (g) => { b.addInstance(g); return a.addInstance(g); },
      setMatrixAt: (i, m) => { b.setMatrixAt(i, m); a.setMatrixAt(i, m); },
      setColorAt: (i, c) => { b.setColorAt(i, c); a.setColorAt(i, c); },
      setVisibleAt: (i, on) => { b.setVisibleAt(i, on); a.setVisibleAt(i, on); },
      flush: () => a.flush?.(),
    };
  };
  return { factory, real, made: fb.made };
}
const close = (a: number[], b: number[], eps = 1e-5) => { expect(a.length).toBe(b.length); let worst = 0; a.forEach((x, k) => { worst = Math.max(worst, Math.abs(x - b[k])); }); expect(worst).toBeLessThan(eps); };

describe('door batch: one merged mesh', () => {
  it('bakes positions by the matrix and normals as three batches them', () => {
    const m = m4mul(m4translate(1, 2, 3), m4mul(m4rotX(0.7), m4scale(2, 1, 0.5)));
    const P = new Float32Array(18), N = new Float32Array(18);
    bakeInstance(quad, m, P, N, 0);
    const rec = { geoms: [quad], inst: [0], mats: new Map([[0, m]]), cols: new Map(), hidden: new Set<number>(), name: 'x' };
    const e = expected(rec);
    close([...P], e.pos); close([...N], e.nor);
  });

  it('draws the shown instances only, at their matrices, with their colours, untagged for the interior light', () => {
    const b = threeBatch('x', new THREE.MeshStandardNodeMaterial(), 3, 9), mesh = b.object as THREE.Mesh;
    expect(mesh.visible).toBe(false); // nothing added: nothing drawn
    const g0 = b.addGeometry(tri()), g1 = b.addGeometry(quad);
    const ids = [b.addInstance(g0), b.addInstance(g1), b.addInstance(g0)];
    b.setMatrixAt(ids[0], m4translate(1, 2, 3)); b.setMatrixAt(ids[1], m4swing(0.4)); b.setColorAt(ids[2], [1, 0.5, 0.2]);
    b.setVisibleAt(ids[1], false);
    let d = drawn(b);
    close(d.pos, [1, 2, 3, 2, 2, 3, 1, 3, 3, 0, 0, 0, 1, 0, 0, 0, 1, 0]);
    close(d.col, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.5, 0.2, 1, 0.5, 0.2, 1, 0.5, 0.2]);
    expect((mesh.material as THREE.Material).vertexColors).toBe(true);
    expect(mesh.geometry.getAttribute('interiorRoom').getX(0)).toBe(-1);
    expect(mesh.frustumCulled).toBe(false);
    // moved: only that instance is re-baked and uploaded
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute, v0 = pos.version;
    b.setMatrixAt(ids[0], m4translate(1, 2, 3)); b.flush!();
    expect(pos.version).toBe(v0); // the same matrix: nothing to do
    b.setMatrixAt(ids[0], m4translate(0, 5, 0)); b.flush!();
    expect(pos.version).toBe(v0 + 1);
    expect(pos.updateRanges).toEqual([{ start: 0, count: 9 }]);
    d = drawn(b);
    close(d.pos.slice(0, 9), [0, 5, 0, 1, 5, 0, 0, 6, 0]);
    // shown again, then everything hidden: no draw at all
    b.setVisibleAt(ids[1], true);
    expect(drawn(b).pos.length).toBe(3 * (3 + 6 + 3));
    for (const i of ids) b.setVisibleAt(i, false);
    expect(drawn(b).visible).toBe(false);
    b.setVisibleAt(ids[2], true);
    expect(drawn(b).visible).toBe(true);
    // a batch without colours has no colour attribute (and leaves its material's vertexColors alone)
    const plain = threeBatch('y', new THREE.MeshStandardNodeMaterial(), 1, 3);
    plain.addInstance(plain.addGeometry(tri())); plain.flush!();
    expect((plain.object as THREE.Mesh).geometry.getAttribute('color')).toBeUndefined();
    expect(((plain.object as THREE.Mesh).material as THREE.Material).vertexColors).toBe(false);
    // rendering flushes too (the renderer calls onBeforeRender in every pass)
    plain.setMatrixAt(0, m4translate(0, 0, 9));
    (plain.object as THREE.Mesh).onBeforeRender(null!, null!, null!, null!, null!, null!);
    expect((plain.object as THREE.Mesh).geometry.getAttribute('position').getZ(0)).toBe(9);
  });

  const mats = (): DoorMats => ({ wood: new THREE.MeshStandardNodeMaterial(), iron: new THREE.MeshStandardNodeMaterial() });
  const plan = planInterior(), doors = playDoors([], plan.doors).active;
  const port = [portcullisInPlan(plan.doors.find((d) => d.id === 'gate-main')!, plan.rooms)];
  const castle = () => {
    const t = tee();
    const sys = buildCastleDoors(doors, { above: mats(), under: mats(), outdoor: mats() }, GROUND, undefined, { batch: t.factory, portcullis: port });
    return { ...t, sys };
  };

  it('draws every castle door batch in one WebGPU call per pass, whatever is shown', () => {
    const { sys, real } = castle(), cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    cam.position.set(0, 40, 80); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
    sys.object.updateMatrixWorld();
    const r = mulberry32(3);
    for (const share of [1, 0.3, 0.05]) {
      for (const d of doors) sys.setVisible(d.id, r() < share);
      for (const b of real) b.flush?.();
      // BatchedMeshes drew ~one call per shown leaf class here (hundreds); merged, one per batch
      expect(webgpuDraws(sys.object, cam)).toBeLessThanOrEqual(real.length);
    }
  });

  it('draws the same triangles, normals and colours as the batched instances did, over the whole castle', () => {
    const { sys, real, made } = castle();
    const r = mulberry32(9);
    const check = () => real.forEach((b, k) => { const d = drawn(b), e = expected(made[k]); close(d.pos, e.pos, 1e-4); close(d.nor, e.nor, 1e-4); close(d.col, e.col); });
    check();
    for (const d of doors) sys.setVisible(d.id, r() < 0.4);
    for (const d of doors.slice(0, 40)) sys.setOpen(d.id, true);
    for (let t = 0; t < 0.5; t += 1 / 60) sys.update(1 / 60);
    check();
  });
});
