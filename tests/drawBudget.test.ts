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
import { courtyard } from '../src/castle/layout';
import { pointInPoly } from '../src/core/math2d';
import { GROUND, WINGS } from '../src/castle/spec';
import { TUNING } from '../src/player/movement';
import type { WindowInput } from '../src/render/interiorMath';

/** Budget for what is built here, per frame (four passes); the frame's own budget is 1000. */
const BUDGET = 750;

describe('draw calls per frame on WebGPU, from the scene graph', () => {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.25, 30000);
  let show: () => void;
  let poses: { name: string; pos: THREE.Vector3; target: THREE.Vector3 }[];

  beforeAll(() => {
    const isl = islandCastle();
    const inner = buildInterior(mats(), isl.builder, { heightAt });
    const P = inner.plan;
    scene.add(isl.builder.build(mats()));
    for (const g of inner.groups) { scene.add(g.object); g.object.traverse((o) => { o.castShadow = false; }); } // as main.ts
    scene.add(buildTerrain(new THREE.MeshBasicMaterial(), undefined, { holes: inner.groundHoles.terrain }));
    const sets = playDoors([], P.doors), gate = P.doors.find((d) => d.id === 'gate-main')!;
    const port = portcullisInPlan(gate, P.rooms);
    const doors = buildCastleDoors(sets.active, { above: doorMats(), under: doorMats(), outdoor: doorMats() }, GROUND, undefined, { portcullis: [port] });
    const locked = buildDoors(sets.locked, doorMats(), undefined, { ajar: 0, initial: 0 });
    scene.add(doors.object, locked.object);
    const bake = bakeInteriorLight(inner.groups, { blocked: () => false }, { plan: P, windows: isl.lights as WindowInput[], sun: () => ({ dir: [-0.4, 0.63, 0.66], irradiance: [3, 3, 3] }), light: createInteriorLight() });
    const court = courtyard();
    const vis = createVisibility(cam, inner.groups, P, { scene, apertures: bake.apertures, ground: heightAt, court: (x, z) => pointInPoly(court, x, z), roofs: Math.min(...WINGS.map((w) => w.top)) });
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
    show();
    scene.updateMatrixWorld();
    const view = countDraws(scene, cam);
    const mirror = cam.clone();
    mirror.position.set(pos.x, -pos.y, pos.z); mirror.lookAt(target.x, -target.y, target.z); mirror.updateMatrixWorld();
    const reflection = countDraws(scene, mirror), shadow = countDraws(scene, cam, true);
    return { view, reflection, shadow, total: 2 * view.draws + reflection.draws + shadow.draws };
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
    grouped.castShadow = true;
    expect(countDraws(s, c, true).draws).toBe(5);
    s.visible = false;
    expect(countDraws(s, c).draws).toBe(0);
  });
});
