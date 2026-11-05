// Physics world (Rapier in Node via rapier3d-compat): collider helpers, the boundary outline, static
// meshes from three objects, terrain with holes, kinematic boxes, raycasts, the fixed-step accumulator.
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three/webgpu';
import { weld, gridSoup, ribbon, mergeSoups, bakePositions, mul4 } from '../src/physics/mesh';
import { boundaryOutline } from '../src/physics/boundary';
import { createPhysics, DT, solidMeshes, type Physics } from '../src/physics/world';
import { pointInPoly, type V2 } from '../src/core/math2d';
import { systemClock } from '../src/core/clock';
import { addBox, boxGeometry, fakeClock } from './helpers';

describe('collider helpers', () => {
  it('welds a triangle soup and drops degenerate triangles', () => {
    const quad = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0]);
    const s = weld(quad, null);
    expect(s.vertices.length / 3).toBe(4);
    expect(s.indices.length / 3).toBe(2);
    const indexed = weld(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), [0, 1, 2, 0, 0, 1]);
    expect(indexed.indices.length).toBe(3);
  });
  it('bakes world matrices and merges soups', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    const m = new THREE.Matrix4().makeTranslation(10, 0, 0);
    expect(bakePositions(g, m.elements).pos[0]).toBe(10);
    expect(bakePositions(g).pos[3]).toBe(1);
    const a = weld(bakePositions(g).pos, null), merged = mergeSoups([a, a]);
    expect(merged.vertices.length).toBe(18);
    expect(Array.from(merged.indices.slice(3))).toEqual([3, 4, 5]);
  });
  it('lays out a terrain grid with holes, matching PlaneGeometry', () => {
    const nx = 5, nz = 4, heights = new Float32Array(nx * nz).map((_, i) => i);
    const g = gridSoup({ heights, nx, nz, dx: 1, dz: 1, ox: 0, oz: 0 }, { x0: 0, x1: 4, z0: 0, z1: 3 }, (x, z) => x < 1 && z < 1);
    expect(g.indices.length / 3).toBe(4 * 3 * 2 - 2);
    expect(g.vertices[(2 * 5 + 3) * 3 + 1]).toBe(2 * 5 + 3); // row-major, X fastest
    expect(gridSoup({ heights, nx, nz, dx: 1, dz: 1, ox: 0, oz: 0 }, { x0: 1, x1: 2, z0: 1, z1: 2 }).indices.length).toBe(6);
  });
  it('builds ribbons with a fixed or per-point bottom, open or closed', () => {
    const pts: V2[] = [[0, 0], [1, 0], [1, 1]];
    expect(ribbon(pts, 0, 1).indices.length / 3).toBe(6);
    const open = ribbon(pts, (p) => -p[0], 1, false);
    expect(open.indices.length / 3).toBe(4);
    expect(open.vertices[6 + 1]).toBe(-1);
  });
  it('boundary detours along the bridge to the broken span', () => {
    const island: V2[] = Array.from({ length: 64 }, (_, i) => [Math.cos((i / 64) * Math.PI * 2) * 40, Math.sin((i / 64) * Math.PI * 2) * 30] as V2);
    expect(boundaryOutline(island).length).toBe(64);
    const b = boundaryOutline(island, { start: [0, 28], dir: [0, 1], width: 4, breakAt: 10 });
    expect(pointInPoly(b, 0, 35)).toBe(true);   // on the bridge
    expect(pointInPoly(b, 0, 39)).toBe(false);  // past the break
    expect(pointInPoly(b, 5, 32)).toBe(false);  // beside the bridge, over the moat
    expect(pointInPoly(b, 0, 0)).toBe(true);
    // a bridge that never meets the outline changes nothing
    expect(boundaryOutline(island, { start: [200, 200], dir: [0, 1], width: 4, breakAt: 10 }).length).toBe(64);
    // the corridor run may wrap past index 0
    const rolled = [...island.slice(16), ...island.slice(0, 16)];
    expect(pointInPoly(boundaryOutline(rolled, { start: [0, 28], dir: [0, 1], width: 4, breakAt: 10 }), 0, 35)).toBe(true);
  });
});

describe('physics world', () => {
  let P: Physics;
  beforeAll(async () => {
    P = await createPhysics(fakeClock());
    addBox(P, -10, 10, -1, 0, -10, 10, 'floor');
  });

  it('adds three objects as trimeshes by tag, skipping hidden meshes', () => {
    const grp = new THREE.Group();
    const a = new THREE.Mesh(boxGeometry(0, 1, 0, 1, 0, 1), new THREE.MeshBasicMaterial()); a.name = 'castle-wood'; a.position.set(20, 0, 0);
    const b = new THREE.Mesh(boxGeometry(0, 1, 0, 1, 0, 1), new THREE.MeshBasicMaterial()); b.name = 'castle-wood'; b.position.set(22, 0, 0);
    const hidden = new THREE.Mesh(boxGeometry(0, 1, 0, 1, 0, 1), new THREE.MeshBasicMaterial()); hidden.visible = false;
    const anon = new THREE.Mesh(boxGeometry(0, 1, 0, 1, 0, 1), new THREE.MeshBasicMaterial()); anon.position.set(24, 0, 0);
    grp.add(a, b, hidden, anon, new THREE.Group());
    const before = P.stats().colliders;
    expect(P.addObject(grp)).toBe(36);
    expect(P.stats().colliders).toBe(before + 2);
    expect(P.raycast([20.5, 5, 0.5], [0, -1, 0], 10)?.tag).toBe('castle-wood');
    expect(P.raycast([24.5, 5, 0.5], [0, -2, 0], 10)?.tag).toBe('mesh');
    expect(solidMeshes(hidden)).toBe(false);
    expect(P.addObject(grp, () => false)).toBe(0);
  });

  it('adds instanced meshes one copy per instance, kept by instance origin', () => {
    const grp = new THREE.Group(); grp.position.set(0, 0, 30);
    const im = new THREE.InstancedMesh(boxGeometry(-0.5, 0.5, 0, 1, -0.5, 0.5), new THREE.MeshBasicMaterial(), 3);
    im.name = 'rocks-near-0';
    const m = new THREE.Matrix4();
    [0, 5, 50].forEach((x, i) => im.setMatrixAt(i, m.makeRotationY(i).setPosition(x, 0, 0)));
    grp.add(im);
    expect(P.addObject(grp, undefined, () => 'rock', (x, z) => Math.abs(x) <= 10 && z === 30)).toBe(24);
    expect(P.raycast([5, 5, 30], [0, -1, 0], 10)?.tag).toBe('rock');
    expect(P.raycast([5, 5, 30], [0, -1, 0], 10)?.point[1]).toBeCloseTo(1, 3);
    expect(P.raycast([50, 5, 30], [0, -1, 0], 10)).toBeNull(); // filtered out
    expect(P.addObject(grp)).toBe(36); // no crop: all three, tagged by name
    // mul4 matches Matrix4.multiply
    const a = new THREE.Matrix4().makeRotationX(0.3).setPosition(1, 2, 3), b = new THREE.Matrix4().makeScale(2, 3, 4).setPosition(-1, 0, 5);
    expect(mul4(a.elements, b.elements)).toEqual(new THREE.Matrix4().multiplyMatrices(a, b).elements.map((v) => expect.closeTo(v, 9)));
  });

  it('raycasts return point, normal, distance and tag, or null', () => {
    const h = P.raycast([0, 5, 0], [0, -1, 0], 10)!;
    expect(h.point[1]).toBeCloseTo(0, 3); expect(h.normal[1]).toBeCloseTo(1); expect(h.dist).toBeCloseTo(5); expect(h.tag).toBe('floor');
    expect(P.raycast([0, 5, 0], [0, 1, 0], 10)).toBeNull();
    expect(P.tagOf(null)).toBeUndefined();
  });

  it('terrain trimesh with holes, and the boundary is invisible to rays', () => {
    const heights = new Float32Array(11 * 11).fill(3);
    expect(P.addTerrain({ heights, nx: 11, nz: 11, dx: 1, dz: 1, ox: 40, oz: 0 }, { x0: 40, x1: 50, z0: 0, z1: 10 }, (x) => x > 48)).toBe(160);
    expect(P.raycast([45, 10, 5], [0, -1, 0], 20)?.tag).toBe('terrain');
    expect(P.raycast([49.5, 10, 5], [0, -1, 0], 20)).toBeNull();
    P.addBoundary([[30, -5], [30, 5]], -1, 10);
    expect(P.raycast([25, 1, 0], [1, 0, 0], 10)).toBeNull();
  });

  it('kinematic boxes: posed, moved, hit by rays, removed', () => {
    const k = P.addKinematicBox([0.5, 1, 0.1], 'door');
    k.setPose([0, 1, -5], [0, 0, 0, 1]);
    P.tick();
    expect(P.raycast([0, 1, -3], [0, 0, -1], 5)?.tag).toBe('door');
    k.setPose([3, 1, -5], [0, 0, 0, 1]);
    P.tick();
    expect(P.raycast([0, 1, -3], [0, 0, -1], 5)).toBeNull();
    expect(P.raycast([3, 1, -3], [0, 0, -1], 5)?.tag).toBe('door');
    k.remove(); k.remove(); k.setPose([0, 0, 0], [0, 0, 0, 1]);
    P.tick();
    expect(P.raycast([3, 1, -3], [0, 0, -1], 5)).toBeNull();
    const plain = P.addKinematicBox([0.2, 0.2, 0.2]);
    plain.setPose([0, 3, 8], [0, 0, 0, 1]); P.tick();
    expect(P.raycast([0, 5, 8], [0, -1, 0], 5)?.tag).toBe('kinematic');
  });

  it('fixed step: accumulates frame time, caps catch-up, reports alpha, fixed callbacks and stats', () => {
    let n = 0;
    const off = P.onFixed(() => { n++; });
    P.step(DT * 2.5);
    expect(n).toBe(2);
    expect(P.alpha).toBeCloseTo(0.5, 1);
    P.step(1);                 // a long hitch runs at most 5 ticks
    expect(n).toBe(7);
    off();
    P.step(DT * 3);
    expect(n).toBe(7);
    const s = P.stats();
    expect(s.ticks).toBeGreaterThan(5); expect(s.stepMs).toBeGreaterThan(0); expect(s.triangles).toBeGreaterThan(0);
    P.addStaticMesh(boxGeometry(0, 1, 0, 1, 0, 1));
    expect(systemClock.now()).toBeGreaterThan(0);
  });
});
