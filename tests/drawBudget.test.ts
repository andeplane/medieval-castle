// The draw-call budget on WebGPU (BRIEF: 500–1000 a frame), counted from the scene graph without a
// browser (render/drawCount.ts models three r187's WebGPU draws: one per mesh or geometry group, one per
// run of a BatchedMesh). 2026-11-08: #66 brought the door BatchedMeshes back over #65's merged meshes, and
// Anders' Mac counted 1180 at the hero view against 426, of which doors were ~600; WebGL2 captures did not
// see it (multi-draw counts a batch once). Here the castle, its interior, every door and the terrain
// tiles are built as main.ts builds them, shown by the room graph at the hero, courtyard and hall poses,
// and counted for each pass the frame draws: the AO pre-pass and the scene (the view camera), the water's
// reflection (the view mirrored in y = 0) and the sun's shadow (every caster, uncut: an upper bound).
// Not built here: the 3D stones, vegetation, flames, water and sky (≈ 150–300 draws over the frame
// measured on WebGPU), so the budget for this part leaves them room under 1000.
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three/webgpu';
import { countDraws } from '../src/render/drawCount';
import { islandCastle, mats, doorMats } from './world';
import { buildInterior } from '../src/castle/interior';
import { buildCastleDoors, buildDoors } from '../src/castle/interior/doors';
import { portcullisInPlan } from '../src/castle/interior/portcullis';
import { playDoors } from '../src/player/setup';
import { buildTerrain, heightAt } from '../src/world/terrain';
import { createVisibility } from '../src/world/visibility';
import { bakeInteriorLight, createInteriorLight } from '../src/render/interiorLight';
import { VIEWS } from '../src/camera/controls';
import { interiorViews } from '../src/camera/interiorViews';
import { pointInPoly } from '../src/core/math2d';
import { GROUND, WINGS } from '../src/castle/spec';
import { TUNING } from '../src/player/movement';
import type { WindowInput } from '../src/render/interiorMath';
import { VIEW_MASK, MIRROR_MASK } from '../src/render/passLayers';
import { aoCamera, AO_FAR } from '../src/render/aoCamera';
import { NearFarShadowNode } from '../src/render/shadows';
import { courtyard, castleCentre } from '../src/castle/layout';
import type { RockLod } from '../src/world/rocks';
import { buildGroundCover, type GroundCover } from '../src/world/grass';

/** Budget for what is built here, per frame (four passes); the frame's own budget is 1000. */
const BUDGET = 750;
/** Triangles a frame for what is built here; the frame's own budget is 3 M. */
const TRI_BUDGET = 2_500_000;

describe('draw calls per frame on WebGPU, from the scene graph', () => {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.25, 30000);
  cam.layers.mask = VIEW_MASK; // as main.ts
  const preCam = new THREE.PerspectiveCamera();
  // the sun's near shadow map as sky.ts sets it up (the far map is static: re-rendered only when the sun moves)
  const sun = new THREE.DirectionalLight();
  const cc = castleCentre();
  sun.target.position.set(cc[0], 10, cc[1]); sun.position.set(cc[0] - 40, 10 + 63, cc[1] + 66); // the bake's sun below
  const shadows = new NearFarShadowNode(sun, { centre: new THREE.Vector3(cc[0], 10, cc[1]), farHalf: 105, farMap: 4096, farRadius: 2.5, nearHalf: 24, nearMap: 2048, nearRadius: 1.5, nearAhead: 14, nearMaxHeight: 70 });
  shadows.camera = cam;
  let show: () => void;
  let rockLod: RockLod;
  let cover: GroundCover;
  let plan: ReturnType<typeof buildInterior>['plan'];
  let poses: { name: string; pos: THREE.Vector3; target: THREE.Vector3 }[];

  beforeAll(() => {
    const isl = islandCastle();
    const inner = buildInterior(mats(), isl.builder, { heightAt });
    const P = inner.plan;
    plan = P;
    scene.add(isl.builder.build(mats()));
    for (const g of inner.groups) { scene.add(g.object); g.object.traverse((o) => { o.castShadow = false; }); } // as main.ts
    const terrain = buildTerrain(new THREE.MeshBasicMaterial(), undefined, { holes: inner.groundHoles.terrain });
    rockLod = terrain.getObjectByName('rocks')!.userData.lod;
    scene.add(terrain);
    // the ground cover as world/vegetation.ts builds it (grass, flowers and reeds near the camera)
    cover = buildGroundCover(terrain.getObjectByName('terrain-near') as THREE.Mesh, new THREE.Texture());
    scene.add(cover.group);
    const sets = playDoors([], P.doors), gate = P.doors.find((d) => d.id === 'gate-main')!;
    const port = portcullisInPlan(gate, P.rooms);
    const doors = buildCastleDoors(sets.active, { above: doorMats(), under: doorMats(), outdoor: doorMats() }, GROUND, undefined, { portcullis: [port] });
    const locked = buildDoors(sets.locked, doorMats(), undefined, { ajar: 0, initial: 0 });
    scene.add(doors.object, locked.object);
    const bake = bakeInteriorLight(inner.groups, { blocked: () => false }, { plan: P, windows: isl.lights as WindowInput[], sun: () => ({ dir: [-0.4, 0.63, 0.66], irradiance: [3, 3, 3] }), light: createInteriorLight() });
    const court = courtyard();
    // a stand-in for the water: the room graph shows it, and its reflection renders, only where it can be seen
    const water = new THREE.Group(); water.name = 'water'; scene.add(water);
    const fr = new THREE.Frustum(), pv = new THREE.Matrix4(), v3 = new THREE.Vector3();
    const frustum = () => {
      fr.setFromProjectionMatrix(pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
      return { planes: fr.planes, corners: ([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).map(([x, y]) => v3.set(x, y, 1).unproject(cam).sub(cam.position).normalize().toArray() as [number, number, number]) };
    };
    const vis = createVisibility(cam, inner.groups, P, { scene, apertures: bake.apertures, ground: heightAt, court: (x, z) => pointInPoly(court, x, z), roofs: Math.min(...WINGS.map((w) => w.top)), frustum });
    // the leaves follow the room graph as main.ts syncDoorVis has them
    const cells = [...sets.active.map((d) => [doors, d.id, d.spaces] as const), ...sets.locked.map((d) => [locked, d.id, d.spaces] as const), [doors, port.id, gate.spaces] as const, ...(port.winch?.room ? [[doors, port.id + ':winch', [port.winch.room, port.winch.room]] as const] : [])];
    show = () => {
      vis.update();
      for (const [sys, id, sp] of cells) sys.setVisible(id, vis.isRoomVisible(sp[0]) || vis.isRoomVisible(sp[1]));
      scene.traverse((o) => { (o as THREE.Mesh).onBeforeRender?.(null!, null!, null!, null!, null!, null!); }); // the door batches flush
    };
    const at = (name: string) => [...VIEWS, ...interiorViews(P)].find((v) => v.name === name)!;
    poses = ['hero', 'courtyard', 'hall'].map((n) => {
      const v = at(n), pos = new THREE.Vector3(...v.pos);
      if (v.mode === 'walk') pos.y = heightAt(pos.x, pos.z) + TUNING.eye;
      return { name: n, pos, target: new THREE.Vector3(...v.target) };
    });
  }, 300_000);

  const frame = (pos: THREE.Vector3, target: THREE.Vector3) => {
    cam.position.copy(pos); cam.lookAt(target); cam.updateMatrixWorld();
    rockLod.update(cam.position); cover.update(cam); // as main.ts, every frame
    show();
    scene.updateMatrixWorld();
    const view = countDraws(scene, cam);
    const mirror = cam.clone();
    mirror.position.set(pos.x, -pos.y, pos.z); mirror.lookAt(target.x, -target.y, target.z); mirror.updateMatrixWorld();
    mirror.layers.mask = MIRROR_MASK; // the water's reflection draws the stand-ins (world/water.ts)
    // the reflection renders only while the water is drawn (world/waterView.ts); without its clip plane at
    // the water, it is counted here as an upper bound
    const reflection = scene.getObjectByName('water')!.visible ? countDraws(scene, mirror) : { draws: 0, byGroup: {}, triangles: 0, trisByGroup: {} };
    const shadow = countDraws(scene, cam, true);
    // triangles: the AO pre-pass with its own nearer far plane, the scene, the reflection and the near
    // shadow map, which follows the camera when it is low and near the castle
    aoCamera(cam, preCam);
    const ao = countDraws(scene, preCam);
    shadows.updateBefore();
    const near = shadows.near.shadow!;
    const nearOn = near.needsUpdate;
    if (nearOn) near.updateMatrices(shadows.near as unknown as THREE.Light);
    const nearShadow = nearOn ? countDraws(scene, near.camera, true) : { triangles: 0, trisByGroup: {} as Record<string, number> };
    const triangles = ao.triangles + view.triangles + reflection.triangles + nearShadow.triangles;
    return { view, reflection, shadow, total: 2 * view.draws + reflection.draws + shadow.draws, ao, nearShadow, triangles };
  };

  it.each(['hero', 'courtyard', 'hall'])('stays within the budget at %s', (name) => {
    const p = poses.find((x) => x.name === name)!;
    const f = frame(p.pos, p.target);
    const by = Object.entries(f.view.byGroup).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
    console.info(`${name}: ${f.total} draws (AO + scene ${f.view.draws} each, reflection ${f.reflection.draws}, shadow ≤ ${f.shadow.draws}); view by group: ${by}`);
    expect(f.total).toBeLessThanOrEqual(BUDGET);
    // the door batches (both systems are 'doors'): one draw each per pass, whatever is shown (castle/interior/doorBatch.ts)
    expect(f.view.byGroup.doors ?? 0).toBeLessThanOrEqual(8);
  });

  // Triangles (BRIEF: 1–3 M a frame, shadow passes included) at every bookmark, outdoors and in. 2026-11-08:
  // 3.3–3.5 M at the hero and gate views on Anders' Mac; the reflection drew the near terrain and rocks at
  // full detail and the AO pre-pass drew out to the horizon (render/passLayers.ts, render/aoCamera.ts).
  // Not built here: vegetation (≈ 0.25 M over the frame at the hero view), 3D stones, flames, water and
  // furniture (≈ 0.15 M), so the budget for this part leaves them room under 3 M.
  it('stays within the triangle budget at every bookmark', () => {
    const views = [...VIEWS, ...interiorViews(plan)];
    const rows: string[] = [];
    let worst = { name: '', t: 0 };
    for (const v of views) {
      const pos = new THREE.Vector3(...v.pos);
      if (v.mode === 'walk') pos.y = heightAt(pos.x, pos.z) + TUNING.eye;
      const f = frame(pos, new THREE.Vector3(...v.target));
      rows.push(`${v.name} ${(f.triangles / 1e6).toFixed(2)} M (AO ${(f.ao.triangles / 1e3).toFixed(0)}k, scene ${(f.view.triangles / 1e3).toFixed(0)}k, reflection ${(f.reflection.triangles / 1e3).toFixed(0)}k, shadow ${(f.nearShadow.triangles / 1e3).toFixed(0)}k)`);
      if (f.triangles > worst.t) worst = { name: v.name, t: f.triangles };
      expect.soft(f.triangles, v.name).toBeLessThanOrEqual(TRI_BUDGET);
    }
    console.info(`triangles per frame (worst ${worst.name}):\n  ${rows.join('\n  ')}`);
  });

  it('draws the same ground in the reflection, cheaper', () => {
    const terrain = scene.getObjectByName('terrain')!;
    const sum = (mask: number, pre: string) => { let t = 0, n = 0; terrain.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && o.name.startsWith(pre) && (o.layers.mask & mask)) { t += m.geometry.index!.count / 3; n++; } }); return { t, n }; };
    const full = sum(VIEW_MASK, 'terrain-near-'), cheap = sum(MIRROR_MASK, 'terrain-mirror-');
    // every tile of the view's ground has its stand-in, with about a quarter of the triangles
    expect(cheap.n).toBe(full.n);
    expect(cheap.t).toBeGreaterThan(full.t * 0.24);
    expect(cheap.t).toBeLessThan(full.t * 0.27);
    // neither is drawn by the other's camera, and only the view's version is in the sun's shadow
    terrain.traverse((o) => {
      if (o.name.startsWith('terrain-mirror')) { expect(o.layers.mask & VIEW_MASK).toBe(0); expect(o.castShadow).toBe(false); }
      if (o.name.startsWith('terrain-near-')) expect(o.layers.mask & MIRROR_MASK).toBe(0);
    });
  });

  it('counts a door BatchedMesh by its runs (what it is for)', () => {
    const p = poses[0];
    cam.position.copy(p.pos); cam.lookAt(p.target); cam.updateMatrixWorld();
    const b = new THREE.BatchedMesh(4, 200, 400, new THREE.MeshBasicMaterial());
    const g = [new THREE.BoxGeometry(), new THREE.SphereGeometry(1, 3, 2)].map((x) => b.addGeometry(x));
    for (const k of [0, 1, 0, 0]) b.setMatrixAt(b.addInstance(g[k]), new THREE.Matrix4().makeTranslation(p.target.x, p.target.y, p.target.z));
    b.perObjectFrustumCulled = false; b.sortObjects = false;
    const s = new THREE.Scene(); s.add(b); s.updateMatrixWorld();
    expect(countDraws(s, cam).draws).toBe(3); // box, sphere, box ×2: three runs, three drawIndexed
    b.castShadow = false;
    expect(countDraws(s, cam, true).draws).toBe(0);
  });

  it('counts triangles by instances and draw range, as three does', () => {
    const c = new THREE.PerspectiveCamera(60, 1, 0.1, 100); c.position.set(0, 0, 10); c.lookAt(0, 0, 0); c.updateMatrixWorld();
    const s = new THREE.Scene();
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 5);
    im.count = 3; im.geometry.setDrawRange(6, 18); // three triangles of each of three instances
    const flat = new THREE.Mesh(new THREE.BoxGeometry().toNonIndexed(), new THREE.MeshBasicMaterial());
    s.add(im, flat); s.updateMatrixWorld();
    expect(countDraws(s, c).triangles).toBe(3 * 6 + 12);
    const ib = new THREE.InstancedBufferGeometry().copy(new THREE.BoxGeometry() as unknown as THREE.InstancedBufferGeometry);
    const tufts = new THREE.Mesh(ib, new THREE.MeshBasicMaterial()); tufts.frustumCulled = false;
    s.add(tufts);
    expect(countDraws(s, c).triangles).toBe(3 * 6 + 12 + 12); // instanceCount left at Infinity: one
    ib.instanceCount = 4;
    expect(countDraws(s, c).triangles).toBe(3 * 6 + 12 + 4 * 12);
    // and the same aside from the AO pre-pass's far plane (render/aoCamera.ts): the view's camera, nearer
    const pre = new THREE.PerspectiveCamera();
    aoCamera(c, pre);
    expect([pre.fov, pre.aspect, pre.near, pre.far]).toEqual([c.fov, c.aspect, c.near, 100]);
    c.far = 3000; aoCamera(c, pre);
    expect(pre.far).toBe(AO_FAR);
    expect(pre.position.equals(c.position) && pre.quaternion.equals(c.quaternion)).toBe(true);
    expect(pre.matrixWorld.equals(c.matrixWorld)).toBe(true);
  });

  it('counts as three projects: hidden, other layers, culled, groups, non-meshes', () => {
    const c = new THREE.PerspectiveCamera(60, 1, 0.1, 100); c.position.set(0, 0, 10); c.lookAt(0, 0, 0); c.updateMatrixWorld();
    const s = new THREE.Scene(), mat = new THREE.MeshBasicMaterial(), off = new THREE.MeshBasicMaterial({ visible: false });
    const box = () => new THREE.BoxGeometry();
    const parts = new THREE.Group(); parts.name = 'parts';
    const grouped = new THREE.Mesh(box(), [mat, off, mat, mat, mat, mat]); // 6 groups, one material hidden
    const hidden = new THREE.Mesh(box(), mat); hidden.visible = false; hidden.add(new THREE.Mesh(box(), mat)); // a hidden parent hides its child
    const layered = new THREE.Mesh(box(), mat); layered.layers.set(5);
    const behind = new THREE.Mesh(box(), mat); behind.position.z = 50; // behind the camera
    const unculled = new THREE.Mesh(box(), mat); unculled.position.z = 50; unculled.frustumCulled = false;
    const invisible = new THREE.Mesh(box(), off);
    parts.add(grouped, hidden, layered, behind, unculled, invisible, new THREE.Sprite(), new THREE.Line(box(), new THREE.LineBasicMaterial()), new THREE.Points(box(), new THREE.PointsMaterial()));
    s.add(parts, new THREE.Group());
    s.updateMatrixWorld();
    const r = countDraws(s, c);
    expect(r.draws).toBe(5 + 1 + 3);
    expect(r.byGroup).toEqual({ parts: 9 });
    // triangles as three's info counts them: the grouped box less its hidden side, the unculled box
    expect(r.triangles).toBe(10 + 12);
    expect(r.trisByGroup).toEqual({ parts: 22 });
    grouped.castShadow = true;
    expect(countDraws(s, c, true).draws).toBe(5);
    s.visible = false;
    expect(countDraws(s, c).draws).toBe(0);
  });
});
