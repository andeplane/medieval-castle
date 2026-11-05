// The real island in Node: castle + bridge + revetment colliders, the terrain from heightAt, the
// boundary, the ?test=walk course and the spawn, driven through setupPlay() exactly as main.ts does.
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three/webgpu';
import { buildCastle } from '../src/castle/castle';
import { buildBridge } from '../src/castle/bridge';
import { buildRevetment } from '../src/castle/revetment';
import { Builder, type MatKey } from '../src/castle/builder';
import { footprints, gatehouseFrame, outerPoly } from '../src/castle/layout';
import { ISLAND, MOAT_OUTER, heightAt } from '../src/world/terrain';
import { pointInPoly, edgeDist, dot, sub, type V2 } from '../src/core/math2d';
import { buildCourse, courseOrigin, type CourseInfo } from '../src/debug/testcourse';
import { setupPlay, surfaceAt } from '../src/player/setup';
import { ScriptedInput } from '../src/player/input';
import { Footsteps } from '../src/player/footsteps';
import { spawnPoint } from '../src/camera/controls';
import { TUNING, nearCorner } from '../src/player/movement';
import { GATEHOUSE } from '../src/castle/spec';
import { buildDoors, gateDoorSpecs, gatePortcullisSpec } from '../src/castle/interior/doors';
import { fakeClock, fakeView } from './helpers';

const mats = () => { const m = new THREE.MeshBasicMaterial(); return Object.fromEntries((['old', 'new', 'trim', 'slate', 'lead', 'wood', 'iron', 'void', 'glass'] as MatKey[]).map((k) => [k, m])) as unknown as Record<MatKey, THREE.Material>; };

/** A coarse stand-in for the render terrain: same layout as buildTerrain's near grid. */
function terrainObject(size = 240, seg = 160) {
  const g = new THREE.PlaneGeometry(size, size, seg, seg);
  g.rotateX(-Math.PI / 2);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setY(i, heightAt(p.getX(i), p.getZ(i)));
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial()); mesh.name = 'terrain-near';
  // a rock on the lawn (near: collides) and one far away (far detail: ignored), like buildRocks
  const rocks = new THREE.Group(); rocks.name = 'rocks';
  for (const tag of ['near', 'far']) {
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), new THREE.MeshBasicMaterial(), 1);
    im.name = `rocks-${tag}-0`;
    im.setMatrixAt(0, new THREE.Matrix4().makeTranslation(ROCK[0], heightAt(ROCK[0], ROCK[1]) + 0.4, ROCK[1]));
    rocks.add(im);
  }
  const grp = new THREE.Group(); grp.add(mesh, rocks);
  return grp;
}
const ROCK: V2 = (() => { const e = ISLAND[24], l = Math.hypot(e[0], e[1]); return [e[0] * (1 - 12 / l), e[1] * (1 - 12 / l)]; })();

describe('walking the island', { timeout: 60_000 }, () => {
  let play: Awaited<ReturnType<typeof setupPlay>>, input: ScriptedInput, course: CourseInfo, bridge: ReturnType<typeof buildBridge>;
  const view = fakeView();
  const walk = (keys: string[], s: number) => {
    input.hold(keys);
    let minY = 1e9;
    for (let i = 0; i < Math.round(s * 60); i++) { play.physics.tick(); minY = Math.min(minY, play.player.feet[1]); }
    input.hold([]);
    return { feet: play.player.feet, minY };
  };
  const ground = (x: number, z: number) => play.player.groundAt(x, z, heightAt(x, z) + 3, heightAt(x, z));
  const stand = (x: number, z: number, yaw: number) => play.player.teleport(x, ground(x, z), z, yaw, 0);
  /** yaw that faces from a toward b */
  const face = (a: V2, b: V2) => Math.atan2(-(b[0] - a[0]), -(b[1] - a[1]));

  beforeAll(async () => {
    const { builder } = buildCastle();
    bridge = buildBridge(builder, ISLAND, MOAT_OUTER, pointInPoly, heightAt);
    buildRevetment(builder, ISLAND, heightAt, (x, z) => Math.hypot(x - bridge.start[0], z - bridge.start[1]) < 3.2);
    const castle = builder.build(mats());
    const cb = new Builder();
    course = buildCourse(cb);
    input = new ScriptedInput();
    play = await setupPlay({
      castle, terrain: terrainObject(), bridge, input, view, footsteps: new Footsteps(() => null), clock: fakeClock(0.01),
      interior: { collision: [new THREE.BoxGeometry(1, 1, 1).translate(-200, 0, -200)], terrainHoles: [] },
      extra: { object: cb.build(mats()), holes: course.holes },
    });
    play.player.setActive(true);
  }, 120_000);

  it('builds colliders for castle, terrain and course', () => {
    const t = play.timings;
    expect(t.castleTris).toBeGreaterThan(50_000);
    expect(t.terrainTris).toBeGreaterThan(10_000);
    expect(t.interiorTris).toBe(12);
    expect(t.rockTris).toBe(12); // the near rock only
    expect(play.physics.raycast([ROCK[0], 60, ROCK[1]], [0, -1, 0], 80)?.tag).toBe('rock');
    expect(play.physics.stats().characters).toBe(1);
  });

  it('spawns south of the gate facing it; the gate leaves stop you, and once open you walk in on the sill', () => {
    // the real gate: leaves (kinematic boxes) and the portcullis, stepped with physics like main.ts
    const doors = buildDoors(gateDoorSpecs(), { wood: new THREE.MeshBasicMaterial(), iron: new THREE.MeshBasicMaterial(), trim: new THREE.MeshBasicMaterial() }, play.physics,
      { initial: 0, portcullis: [gatePortcullisSpec()], characters: play.characters });
    play.physics.onFixed((dt) => doors.update(dt, play.playerCentre()));
    const s = spawnPoint(), g = gatehouseFrame(), sill = gateDoorSpecs()[0].centre[1];
    // how far into the gatehouse (from its front face, along −out) the feet got
    const front: V2 = [g.base[0] + g.out[0] * GATEHOUSE.project, g.base[1] + g.out[1] * GATEHOUSE.project];
    const into = (f: number[]) => -dot(sub([f[0], f[2]], front), g.out);
    stand(s.x, s.z, s.yaw);
    const shut = walk(['KeyW'], 5).feet;
    expect(into(shut)).toBeGreaterThan(0.5);   // through the arch, onto the sill…
    expect(into(shut)).toBeLessThan(4.2);      // …but stopped by the closed leaves
    expect(Math.abs(shut[1] - sill)).toBeLessThan(0.1);
    doors.setOpen('main-gate', true, true);
    const open = walk(['KeyW'], 3).feet;
    expect(into(open)).toBeGreaterThan(4.5);   // to the end of the passage (the shell continues it)
    expect(Math.abs(open[1] - sill)).toBeLessThan(0.1);
    expect(play.npcs).toEqual([]);
    expect(play.characters()).toEqual([]);
    stand(s.x, s.z, s.yaw);
  });

  it('walls stop you elsewhere too', () => {
    const from: V2 = [44, 27];
    stand(from[0], from[1], face(from, [20, -6]));
    const w = walk(['KeyW', 'ShiftLeft'], 6);
    expect(pointInPoly(outerPoly(), w.feet[0], w.feet[2])).toBe(false);
    expect(footprints().some((p) => pointInPoly(p, w.feet[0], w.feet[2]) && edgeDist(p, w.feet[0], w.feet[2]).d > 0.5)).toBe(false);
  });

  it('cannot leave the island over the revetment', () => {
    let tried = 0;
    for (const i of [0, 40, 64, 100, 116]) {
      // walk outward from 6 m inside the edge, toward an island outline vertex
      const e = ISLAND[i], l = Math.hypot(e[0], e[1]);
      const start: V2 = [e[0] - (e[0] / l) * 6, e[1] - (e[1] / l) * 6];
      if (footprints().some((p) => pointInPoly(p, start[0], start[1]) || edgeDist(p, start[0], start[1]).d < 1)) continue;
      tried++;
      stand(start[0], start[1], face(start, e));
      const w = walk(['KeyW', 'ShiftLeft'], 2.5);
      expect(pointInPoly(ISLAND, w.feet[0], w.feet[2])).toBe(true);
      expect(w.minY).toBeGreaterThan(1);
      walk(['Space', 'KeyW'], 1); // jumping at the wall does not get you over either
      expect(pointInPoly(ISLAND, play.player.feet[0], play.player.feet[2])).toBe(true);
    }
    expect(tried).toBeGreaterThan(2);
  });

  it('can walk out onto the broken bridge but not off its end', () => {
    const p0 = bridge.start, d = bridge.dir;
    const a: V2 = [p0[0] - d[0] * 4, p0[1] - d[1] * 4];
    stand(a[0], a[1], face(a, [a[0] + d[0], a[1] + d[1]]));
    const w = walk(['KeyW'], 6);
    const along = dot(sub([w.feet[0], w.feet[2]], p0), d);
    expect(along).toBeGreaterThan(bridge.breakAt - 1.5);
    expect(along).toBeLessThan(bridge.breakAt + 0.1);
    expect(w.feet[1]).toBeGreaterThan(bridge.deck - 0.6); // on the deck or the pier top, not in the moat
  });

  it('runs the test course: stairs, ramps, beam and the stair down under the ground', () => {
    const lane = (n: string) => course.lanes.find((l) => l.name === n)!;
    const go = (n: string, keys: string[], s: number) => { const l = lane(n); play.player.teleport(l.x, course.slab, l.z0, 0, 0); return walk(keys, s).feet; };
    for (const n of ['stairs-0.15', 'stairs-0.20', 'stairs-0.30']) expect(go(n, ['KeyW'], 3)[1]).toBeCloseTo(lane(n).top, 1);
    expect(go('stairs-0.35', ['KeyW'], 4)[1]).toBeLessThan(course.slab + 0.1);
    expect(go('ramp-30', ['KeyW'], 2.8)[1]).toBeGreaterThan(lane('ramp-30').top - 0.25);
    expect(go('ramp-55', ['KeyW'], 4)[1]).toBeLessThan(course.slab + 0.6);
    expect(go('beam', ['KeyW'], 4)[2]).toBeGreaterThan(lane('beam').beamZ![1] - 0.1);
    expect(go('beam', ['KeyW', 'KeyC'], 5)[2]).toBeLessThan(lane('beam').beamZ![0]);
    const down = go('descent', ['KeyW'], 9);
    expect(down[1]).toBeCloseTo(lane('descent').floorY!, 1);
    expect(down[2]).toBeLessThan(lane('descent').endZ + 1.5);
    // the ground above the tunnel end is real terrain, well above your head
    expect(heightAt(down[0], down[2])).toBeGreaterThan(down[1] + TUNING.height);
  });

  it('the walk camera never gets closer to a collider than the capsule radius (walls) or the near plane (anything)', () => {
    // rays from the eye: 24 horizontal, 16 tilted up and down, 1 straight up
    const dirs: [number, number, number][] = [];
    for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; dirs.push([Math.cos(a), 0, Math.sin(a)]); }
    for (let i = 0; i < 16; i++) { const a = (i / 8) * Math.PI, e = i % 2 ? 0.6 : -0.6; dirs.push([Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)]); }
    dirs.push([0, 1, 0]);
    let wall = 9, any = 9, frames = 0;
    const probe = (keys: string[], s: number) => {
      input.hold(keys);
      for (let i = 0; i < Math.round(s * 60); i++) {
        play.physics.tick(); play.player.frame(1, 1 / 60); frames++;
        const p = view.position;
        dirs.forEach((d, k) => {
          const h = play.physics.raycast([p.x, p.y, p.z], d, 1);
          if (!h) return;
          if (k < 24) wall = Math.min(wall, h.dist); else any = Math.min(any, h.dist);
        });
      }
      input.hold([]);
    };
    const s = spawnPoint(), g = gatehouseFrame();
    stand(44, 27, face([44, 27], [20, -6])); probe(['KeyW', 'ShiftLeft'], 5);           // run at the east wing and slide along it
    stand(s.x, s.z, s.yaw + 0.55); probe(['KeyW'], 4); probe(['KeyW', 'KeyD'], 2);      // into the gatehouse front at an angle
    const gx = g.base[0] + g.out[0] * (GATEHOUSE.project + 1.5) + g.dir[0] * 4.5, gz = g.base[1] + g.out[1] * (GATEHOUSE.project + 1.5) + g.dir[1] * 4.5;
    stand(gx, gz, face([gx, gz], g.base)); probe(['KeyW', 'ShiftLeft'], 2); probe(['KeyA', 'KeyW'], 2); // into the batter and along it
    const b = course.lanes.find((l) => l.name === 'beam')!;
    play.player.teleport(b.x, course.slab, b.z0, 0, 0.5); probe(['KeyW', 'KeyC'], 2.4); probe(['KeyC'], 0.5); // crouched under the beam, looking up
    play.player.teleport(b.x, course.slab, b.z0, 0, 0); probe(['KeyW'], 3);              // head-first into the beam standing
    expect(frames).toBeGreaterThan(1000);
    expect(view.near).toBe(TUNING.near);
    expect(wall).toBeGreaterThanOrEqual(TUNING.radius);
    // the near plane's corners (widest fov with the run kick, a 21:9 screen) stay inside that clearance
    const reach = nearCorner(TUNING.near, TUNING.fov + TUNING.fovRunKick, 21 / 9);
    expect(reach).toBeLessThan(TUNING.radius / 2);
    expect(any).toBeGreaterThan(reach + 0.03);
    expect(wall).toBeLessThan(0.45); // and the probes really were pressed against walls
  });

  it('course origin is deterministic, surfaces resolve by place', () => {
    expect(courseOrigin()).toEqual(course.origin);
    expect(surfaceAt('terrain', -2, 0)).toBe('stone'); // courtyard
    expect(surfaceAt('terrain', 60, 30)).toBe('grass');
    expect(surfaceAt(undefined, 0, 0)).toBe('stone');
    expect(surfaceAt('castle-wood', 0, 0)).toBe('wood');
    expect(surfaceAt('castle-old', 0, 0)).toBe('stone');
    const g = gatehouseFrame();
    expect(surfaceAt('terrain', g.base[0] + g.out[0] * 6, g.base[1] + g.out[1] * 6)).toBe('dirt');
    expect(play.walkable(spawnPoint().x, spawnPoint().z)).toBe(true);
    expect(play.walkable(500, 500)).toBe(false);
  });
});
