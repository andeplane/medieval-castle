// The whole castle from the seed, seen as the player sees it: one model for visibility and LOD (AGENTS.md).
// From every pose a player has, every opening the eye can reach has its spaces drawn; the caves are drawn by
// the room graph; the same place draws the same spaces at every distance; meshes are culled only by bounds
// that hold their rooms; walking through a doorway keeps both rooms drawn; every drawn room has all its
// fires. Split from tests/world.test.ts for wall time (CI runs the two files side by side); the poses,
// openings and shut leaves both files use are in tests/helpers/worldViews.ts.
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three/webgpu';
import * as T3 from 'three';
import { buildInterior, type PlanX } from '../src/castle/interior';
import { heightAt, nearGrid } from '../src/world/terrain';
import { pointInPoly } from '../src/core/math2d';
import { mats, islandCastle } from './world';
import type { WindowInput } from '../src/render/interiorMath';
import { drawnSpaces, roomGraph, createVisibility } from '../src/world/visibility';
import { PAVE_Y } from '../src/castle/paving';
import { interiorViews } from '../src/camera/interiorViews';
import { rayIndex, soupTris } from './helpers/rays';
import { caveWalk, CAVE_ZONE } from '../src/castle/interior/caves';
import { wallTorches, furnitureFires } from '../src/render/interiorFire';
import { lightCastle, firesByRoom, fireAt, MAX_FIRES } from '../src/light/roomLight';
import { caveFires } from '../src/castle/interior/caveGeom';
import { roomFireLists } from '../src/props/roomFurniture';
import { createFurnitureStreamer } from '../src/props/streamer';
import { inlineJobs } from '../src/props/furnishWorker';
import { worldViews, OUTDOOR, on, bvhOf, type V3 } from './helpers/worldViews';

describe('every opening in the castle, as the player sees it', () => {
  const { set, cam, baked, makeVis, castleSolid, allGroupTris, shutLeaf, openingsOf, playerPoses, court, inCourt, roofs } = worldViews();
  let P: PlanX, inner: ReturnType<typeof buildInterior>;
  beforeAll(() => {
    const isl = islandCastle(); // the castle as main.ts lays it, cut by the interior as main.ts does
    inner = buildInterior(mats(), isl.builder, { heightAt });
    P = inner.plan;
    set({ P, B: isl.builder, inner, lights: isl.lights as WindowInput[] });
  }, 300_000);

  // One model for visibility and LOD: no level of detail or cull may add, move or remove an opening or a
  // door. Which rooms are drawn is a graph walk (world/visibility.ts): the same spaces from every distance.
  // Checked here by looking: from every pose a player has (in front of every outdoor doorway near and far,
  // the middle of every room and in front of each of its doors, the courtyard, outside, the gate passage),
  // every opening the eye can reach (a ray through the real castle, the rooms and the shut leaves, past the
  // glass) has its spaces drawn: both for an opening nothing shuts, the eye's side for a shut leaf.
  // Anders, 2026-11-07: from the gate passage the courtyard doors showed sky (E0-2) or plain wall (the stair
  // tower), from a few metres into the courtyard they were fine; a shut door in a room showed a white outline.
  it('draws the spaces of every opening seen from any pose, near or far, doors shut or open', () => {
    const vis = makeVis(), poses = playerPoses();
    const solid = [...castleSolid(), ...allGroupTris()];
    const faults = new Map<string, string>(), ray = new T3.Ray();
    let seen = 0, n = 0;
    for (const open of [false, true]) { // as the castle starts, and with every leaf swung open (any agent may open any door)
      const occ = bvhOf(open ? solid : [...solid, ...P.doors.flatMap((d) => shutLeaf(d)?.tris ?? [])]);
      const ops = openingsOf().map((o) => (open ? { ...o, leafT: undefined } : o));
      for (const d of P.doors) vis.setDoorOpen(d.id, open); // the doors system tells the graph (main.ts syncDoorLight)
      n = ops.length;
      poses.forEach(({ label, eye }, i) => {
        cam.position = { x: eye[0], y: eye[1], z: eye[2] };
        vis.update();
        for (const op of ops) {
          let target = op.p, need = op.spaces as string[];
          if (op.leafT !== undefined) { // a shut leaf: the eye's side, up to the leaf
            const side = Math.sign((eye[0] - op.p[0]) * op.n[0] + (eye[2] - op.p[2]) * op.n[1]) || 1;
            target = [op.p[0] + op.n[0] * (op.leafT + side * 0.04), op.p[1], op.p[2] + op.n[1] * (op.leafT + side * 0.04)];
            need = [side < 0 ? op.spaces[0] : op.spaces[1]];
          }
          // a window seen from outside shows its dark fallback pane, not the room (windows lead out only)
          if (op.window && (eye[0] - op.p[0]) * op.n[0] + (eye[2] - op.p[2]) * op.n[1] > 0) need = [op.spaces[1]];
          // A ray is only needed to tell whether an undrawn space is seen. Everything drawn is fine whether or not
          // it is seen, so the ray is skipped (it costs ~100 ms per 1000 under coverage); every 8th pose still
          // casts all of them, so the count of openings seen below shows the rays reach the openings.
          const undrawn = need.filter((s) => !vis.isRoomVisible(s) && !faults.has(`${op.id}:${s}`));
          if (!undrawn.length && i % 8) continue;
          const dv = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]], dist = Math.hypot(dv[0], dv[1], dv[2]);
          if (dist > 220 || dist < 0.05) continue;
          ray.origin.set(eye[0], eye[1], eye[2]); ray.direction.set(dv[0] / dist, dv[1] / dist, dv[2] / dist);
          if (occ.hits(ray, 0, dist - 0.02)) continue;
          seen++;
          for (const s of undrawn) faults.set(`${op.id}:${s}`, `${op.id}: ${s} not drawn, seen from ${label}${open ? ' (doors open)' : ''}`);
        }
      });
    }
    console.info(`openings seen: ${poses.length} poses, ${n} openings, ${seen} seen, ${faults.size} faults`);
    expect(poses.length).toBeGreaterThan(900);
    expect(seen).toBeGreaterThan(600); // 876 measured: a sample of the 6822 openings seen from every pose
    expect([...faults.values()]).toEqual([]);
  }, 300_000);

  // The caves (castle/interior/caves.ts) are rooms of the same graph: from anywhere in them the whole cave
  // group is drawn (and from the great cavern, deep under the moat, the outdoors is not), and from anywhere in the two cellars that open into
  // them, near their doorway or across the room, the cave group is drawn too: graph steps, never distance.
  it('draws the caves by the room graph, from every point of their walks and of the cellars they open into', () => {
    const vis = makeVis(), caves = new Set(P.rooms.filter((r) => r.zone === CAVE_ZONE).map((r) => r.id));
    const gi = inner.groups.findIndex((g) => g.rooms.some((r) => caves.has(r)));
    expect(caves.size).toBeGreaterThanOrEqual(12);
    expect(inner.groups[gi].rooms.every((r) => caves.has(r))).toBe(true);
    const look = (eye: V3) => { cam.position = { x: eye[0], y: eye[1], z: eye[2] }; return vis.update(); };
    const bad: string[] = [];
    let n = 0;
    for (const id of caves) for (const w of caveWalk(P.caves!, id)) {
      const v = look([w[0], w[1] + 1.6, w[2]]); n++;
      if (!v.from.some((s) => caves.has(s))) bad.push(`${id} at (${w[0].toFixed(1)}, ${w[2].toFixed(1)}): camera in ${v.from.join(', ')}`);
      if (!v.visible[gi]) bad.push(`${id} at (${w[0].toFixed(1)}, ${w[2].toFixed(1)}): the cave group is not drawn`);
      if (id === 'cave-cavern' && !v.underground) bad.push('the outdoors is drawn from the great cavern');
      for (const c of caves) if (!v.drawn.has(c)) { bad.push(`${c} not drawn from ${id}`); break; }
    }
    for (const id of ['N-c1', 'great-c']) {
      const r = P.rooms.find((x) => x.id === id)!, xs = r.poly.map((q) => q[0]), zs = r.poly.map((q) => q[1]);
      for (let x = Math.min(...xs) + 0.4; x < Math.max(...xs); x += 1) for (let z = Math.min(...zs) + 0.4; z < Math.max(...zs); z += 1) {
        if (!pointInPoly(r.poly, x, z)) continue;
        const v = look([x, r.y0 + 1.6, z]); n++;
        if (!v.visible[gi]) bad.push(`caves not drawn from ${id} at (${x.toFixed(1)}, ${z.toFixed(1)})`);
      }
    }
    expect(n).toBeGreaterThan(60);
    expect(bad).toEqual([]);
  });

  it('draws the same spaces from the same place at every distance (a graph, no distance or facing test)', () => {
    const vis = makeVis();
    const by = new Map<string, { drawn: string; label: string }>(), faults: string[] = [];
    for (const { label, eye } of playerPoses()) {
      cam.position = { x: eye[0], y: eye[1], z: eye[2] };
      const st = vis.update(), key = [...st.from].sort().join('+'), drawn = [...st.drawn].sort().join(',');
      const was = by.get(key);
      if (!was) by.set(key, { drawn, label }); else if (was.drawn !== drawn) faults.push(`${key}: ${label} draws other spaces than ${was.label}`);
    }
    expect(by.has('courtyard') && by.has('outside') && by.has('gate-1')).toBe(true);
    expect(faults).toEqual([]);
    // from outdoors no room is drawn only because of a window: the rooms are those its doors and stairs reach
    const doorsOnly = roomGraph(P), outdoor: string[] = [];
    for (const [key, { drawn }] of by) {
      if (!key.split('+').every((s) => s === 'courtyard' || s === 'outside')) continue;
      const reach = drawnSpaces(doorsOnly, key.split('+'));
      outdoor.push(...drawn.split(',').filter((s) => !reach.has(s)).map((s) => `${s} drawn from ${key} through a window`));
    }
    expect(outdoor).toEqual([]);
    // the caves are drawn only where the graph reaches them from the camera: from outdoors, every door shut,
    // no cave room (2026-11-08: the cave group was drawn from the hero view, 7 draws a pass, because the open
    // flood started from the great cellar two shut steps off and ran on through the cave openings)
    const caves = new Set(P.rooms.filter((r) => r.zone === CAVE_ZONE).map((r) => r.id)), inCave: string[] = [];
    for (const [key, { drawn, label }] of by) {
      if (!key.split('+').every((s) => s === 'courtyard' || s === 'outside')) continue;
      const c = drawn.split(',').filter((s) => caves.has(s));
      if (c.length) inCave.push(`${c.join(', ')} drawn from ${label}`);
    }
    expect(caves.size).toBeGreaterThan(0);
    expect(inCave).toEqual([]);
    // what the graph is for: from the gate passage every room off the courtyard is drawn, from far outside too
    const courtRooms = P.doors.filter((d) => d.spaces.includes('courtyard') && d.id !== 'gate-court').map((d) => d.spaces.find((s) => s !== 'courtyard')!);
    const g = P.doors.find((d) => d.id === 'gate-court')!, q = on(g, 0, -(g.wall / 2 + 2));
    cam.position = { x: q[0], y: g.centre[1] + 1.7, z: q[1] }; vis.update();
    expect(vis.roomId).toBe('gate-1');
    expect(courtRooms.filter((r) => !vis.isRoomVisible(r))).toEqual([]);
  }, 300_000);

  // Frustum culling by room (render/interiorLight.ts tagGroups, world/visibility.ts tagBoxes): each interior
  // mesh is culled by its rooms' boxes instead of one sphere round its group. A cull layer may decide only
  // how something is drawn: so every triangle of every mesh lies in one of the mesh's boxes (a frustum that
  // reaches a triangle reaches its box), and from player poses no mesh with a vertex in view is culled.
  it('culls interior meshes by bounds that hold every triangle of their rooms', () => {
    baked(); // tags the triangles and gives each mesh its room boxes
    const meshes: THREE.Mesh[] = [];
    for (const g of inner.groups) g.object.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    const outside: string[] = [], v = new THREE.Vector3();
    // every mesh's vertices in world space, once (flat loops: the vertex checks below run ~4× faster under coverage)
    const world = new Map(meshes.map((m) => {
      const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute, w = new Float64Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); w[i * 3] = v.x; w[i * 3 + 1] = v.y; w[i * 3 + 2] = v.z; }
      return [m, w];
    }));
    let boxes = 0;
    for (const m of meshes) {
      const bs = m.userData.roomBoxes as THREE.Box3[], w = world.get(m)!;
      boxes += bs.length;
      for (let i = 0; i < w.length / 3; i++) {
        const x = w[i * 3], y = w[i * 3 + 1], z = w[i * 3 + 2];
        let inside = false;
        for (const b of bs) { // Box3.distanceToPoint < 1e-4
          const dx = Math.max(b.min.x - x, 0, x - b.max.x), dy = Math.max(b.min.y - y, 0, y - b.max.y), dz = Math.max(b.min.z - z, 0, z - b.max.z);
          if (Math.sqrt(dx * dx + dy * dy + dz * dz) < 1e-4) { inside = true; break; }
        }
        if (!inside) { outside.push(`${m.name}: vertex ${i} outside its rooms' boxes`); break; }
      }
    }
    expect(meshes.length).toBeGreaterThan(250);
    expect(boxes).toBeGreaterThan(meshes.length); // most meshes hold several rooms
    expect(outside).toEqual([]);
    // from a sample of the player's poses, looking four ways: a mesh with a vertex in the view is not culled
    const culledInView: string[] = [], camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.25, 30000), fr = new THREE.Frustum(), pv = new THREE.Matrix4();
    let culled = 0;
    playerPoses().filter((_, i) => i % 60 === 0).forEach(({ label, eye }) => {
      for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        camera.position.set(...eye); camera.lookAt(eye[0] + dx, eye[1], eye[2] + dz); camera.updateMatrixWorld();
        fr.setFromProjectionMatrix(pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
        for (const m of meshes) {
          if (m.intersectsFrustum(fr)) continue;
          culled++;
          const w = world.get(m)!, pl = fr.planes;
          for (let i = 0; i < w.length / 3; i++) { // Frustum.containsPoint: on the inner side of all six planes
            const x = w[i * 3], y = w[i * 3 + 1], z = w[i * 3 + 2];
            if (pl.every((q) => q.normal.x * x + q.normal.y * y + q.normal.z * z + q.constant >= 0)) { culledInView.push(`${m.name} culled with a vertex in view from ${label}`); break; }
          }
        }
      }
    });
    expect(culled).toBeGreaterThan(0);
    expect(culledInView).toEqual([]);
  }, 300_000);

  // walking through a doorway: from 1 m before it to 1 m past it, in 5 cm steps, the rooms on both
  // sides stay drawn at every step (inside the wall's thickness the camera is in neither room)
  it('keeps both rooms of every doorway drawn while the camera walks through it', () => {
    const vis = makeVis();
    const faults = new Map<string, string>();
    let poses = 0;
    for (const d of P.doors) {
      const rooms = d.spaces.filter((s) => !OUTDOOR.has(s) && s !== 'farbank');
      if (!rooms.length) continue;
      const reach = d.wall / 2 + 1;
      for (let t = -reach; t <= reach + 1e-9; t += 0.05) for (const across of [0, -d.width / 4, d.width / 4]) {
        const q = on(d, across, t);
        cam.position = { x: q[0], y: d.centre[1] + 1.6, z: q[1] };
        vis.update(); poses++;
        for (const r of rooms) if (!vis.isRoomVisible(r) && !faults.has(`${d.id}:${r}`)) faults.set(`${d.id}:${r}`, `${d.id}: ${r} culled ${t.toFixed(2)} m through, ${across.toFixed(2)} m aside (camera room ${vis.roomId ?? 'none'})`);
      }
    }
    expect(poses).toBeGreaterThan(1000);
    expect([...faults.values()]).toEqual([]);
  }, 120_000);

  // Anders, 2026-11-08: looking down into a room through an open door it was dark; a few steps closer
  // its torch suddenly lit ("light in next room off. then i walk a bit, then on"). Twice over:
  // - the old rig lit the 8 fires nearest the camera, each only within 1.6 × its range (#71 replaced it
  //   with a fire table: one row per room);
  // - with furniture (?furniture=1) a room's fires came with its furniture, which streams in by room once
  //   the room graph draws it, so a room seen through a doorway was drawn dark until its furniture loaded
  //   (and dark again after it was unloaded). Now every room's fires are listed up front without building
  //   the furniture (props/roomFurniture.ts roomFireLists) and set once (light/roomLight.ts lightCastle).
  // Here, as main.ts builds them, in both modes, with the furniture streamer running as main runs it (the
  // rooms the graph draws wanted, loads finishing between steps): walking from 15 m out up to and through
  // every doorway, doors shut and open, every room the graph draws has all its fires at the same candela,
  // the firelight on its floor is the same, and the flames are the same, at every step from the first frame.
  it('lights every drawn room with all its fires and flames, the same from every pose, with furniture or without', async () => {
    const vis = makeVis(), index = baked().roomIndex;
    const groupOf = new Map<string, string>();
    for (const g of inner.groups) for (const id of g.rooms) groupOf.set(id, g.key);
    const roomBox = (id: string) => { const row = index.get(id), r = P.rooms.find((x) => x.id === id); return row === undefined || !r ? undefined : { row, box: r }; };
    const centre = (id: string): V3 => { const r = P.rooms.find((x) => x.id === id)!; return [r.poly.reduce((a, p) => a + p[0], 0) / r.poly.length, r.y0 + 0.01, r.poly.reduce((a, p) => a + p[1], 0) / r.poly.length]; };
    const caves = caveFires(P.caves!, 'caves');
    const lists = roomFireLists(P);
    const modes = {
      'wall torches': () => { const t = wallTorches(P, (id) => groupOf.get(id)); t.emitters.push(...caves.emitters); t.flames.push(...caves.flames); return { ...t, owners: t.holders }; },
      furniture: () => { const f = furnitureFires(lists, (id) => groupOf.get(id)); f.emitters.push(...caves.emitters); f.flames.push(...caves.flames); return f; },
    };
    const faults = new Map<string, string>();
    let poses = 0, checked = 0;
    for (const [mode, sources] of Object.entries(modes)) {
      const src = sources();
      const byRoom = new Map<string, number>();
      for (const [id, es] of firesByRoom(P.rooms, src.emitters, src.owners)) byRoom.set(id, Math.min(es.length, MAX_FIRES));
      // as main.ts, before the first frame
      const { table, flames } = lightCastle(P.rooms, src, roomBox, 1024);
      table.update(0, 0); // flicker held (motion 0)
      const lightOf = (id: string) => { const row = index.get(id)!; return fireAt(table.fires(row).map((f, k) => ({ ...f, candela: f.candela * table.flick[row * MAX_FIRES + k] })), centre(id), [0, 1, 0]); };
      const ref = new Map([...byRoom.keys()].map((id) => [id, lightOf(id)]));
      const data0 = table.data.slice(), flames0 = JSON.stringify(flames);
      // the furniture streamer as main.ts drives it: the graph's drawn rooms wanted, a few rooms in per frame
      const stream = mode === 'furniture' ? createFurnitureStreamer({
        jobs: inlineJobs((id) => ({ room: id, key: groupOf.get(id) ?? '', role: 'empty', props: 0, triangles: 0, bins: {}, boxes: new Float32Array(0), ...(lists.find((l) => l.room === id) ?? { emitters: [], flames: [] }) })),
        sink: { add: (r) => r.room, remove: () => {} }, now: () => poses * 16,
      }, { unloadAfter: 500 }) : null;
      for (const open of [false, true]) {
        for (const d of P.doors) vis.setDoorOpen(d.id, open);
        for (const d of P.doors) {
          const reach = d.wall / 2 + 15;
          for (let t = -reach; t <= reach + 1e-9; t += 0.25) {
            const q = on(d, 0, t);
            cam.position = { x: q[0], y: d.centre[1] + 1.6, z: q[1] };
            vis.update(); poses++;
            if (stream) {
              stream.setWanted(new Set([...vis.state.from, ...vis.state.drawn].filter((id) => index.has(id))));
              stream.update();
              await Promise.resolve(); // the jobs started this step finish before the next
            }
            const where = `from ${t.toFixed(2)} m off ${d.id}${open ? ' (doors open)' : ''} [${mode}]`;
            for (const [id, n] of byRoom) {
              if (!vis.isRoomVisible(id)) continue;
              checked++;
              const row = index.get(id)!;
              if (table.fires(row).length !== n) faults.set(id + mode, `${id}: ${table.fires(row).length} of ${n} fires lit ${where}`);
              else if (Math.abs(lightOf(id) - ref.get(id)!) > 1e-9) faults.set(id + mode, `${id}: firelight ${lightOf(id).toFixed(3)} ≠ ${ref.get(id)!.toFixed(3)} ${where}`);
            }
          }
        }
      }
      // nothing in the table or the flames changed while walking (and streaming) about
      expect(table.data, mode).toEqual(data0);
      expect(JSON.stringify(flames), mode).toBe(flames0);
      expect(flames.length, mode).toBe(src.flames.length);
      if (stream) expect(stream.stats().added, 'the furniture did stream in and out on the walk').toBeGreaterThan(50);
      if (stream) expect(stream.stats().removed).toBeGreaterThan(10);
      expect(byRoom.size, mode).toBeGreaterThan(mode === 'furniture' ? 150 : 10);
    }
    expect(poses).toBeGreaterThan(4000);
    expect(checked).toBeGreaterThan(40000);
    expect([...faults.values()]).toEqual([]);
  }, 240_000);

  // The water's reflection renders the whole scene again from below (1.1 M of 3.2 M triangles at the hall on
  // Anders' Mac). It is skipped when no line of sight can reach the water (world/waterView.ts). From poses all
  // over the island (outdoors round the castle, the courtyard, every room, the bookmarks) rays through a grid
  // of pixels, against the castle, the interiors and the ground: wherever one meets the water first, the
  // water must be drawn (so its reflection is rendered that frame: never missing, never stale). Indoors it
  // is skipped from most rooms, and from the hall, chamber and tower room bookmarks.
  it('draws the water wherever it can be seen, and skips it (and its reflection) where it cannot', () => {
    // the castle, the rooms, and buildTerrain's own near grid (its holes as main.ts gives them)
    const ground = nearGrid(undefined, { holes: inner.groundHoles.terrain }).toNonIndexed().getAttribute('position').array;
    const occ = rayIndex([...castleSolid(), ...allGroupTris(), ...soupTris(ground)]);
    const pc = new T3.PerspectiveCamera(55, 16 / 10, 0.25, 30000), water = { visible: true, name: 'water' };
    const fr = new T3.Frustum(), m = new T3.Matrix4(), v = new T3.Vector3();
    const frustum = () => {
      pc.updateMatrixWorld();
      fr.setFromProjectionMatrix(m.multiplyMatrices(pc.projectionMatrix, pc.matrixWorldInverse));
      const corners = ([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).map(([x, y]) => v.set(x, y, 1).unproject(pc).sub(pc.position).normalize().toArray() as V3);
      return { planes: fr.planes, corners };
    };
    const vis = createVisibility(pc, inner.groups, P, { apertures: baked().apertures, ground: heightAt, court: inCourt, roofs, scene: { getObjectByName: (n: string) => (n === 'water' ? water : undefined) }, frustum });
    const ray = new T3.Ray(), nd = new T3.Vector3();
    /** Does a pixel of the grid see water first (y 0 where the ground is below it)? */
    const seesWater = (W = 32, H = 20) => {
      for (let i = 0; i < W; i++) for (let j = 0; j < H; j++) {
        nd.set(((i + 0.5) / W) * 2 - 1, ((j + 0.5) / H) * 2 - 1, 1).unproject(pc).sub(pc.position).normalize();
        if (nd.y >= 0 || pc.position.y <= 0) continue; // (under the water: the rock is between)
        const t = -pc.position.y / nd.y, x = pc.position.x + nd.x * t, z = pc.position.z + nd.z * t;
        if (heightAt(x, z) >= 0) continue;
        ray.origin.copy(pc.position); ray.direction.copy(nd);
        if (!occ.hits(ray, 0, t)) return true;
      }
      return false;
    };
    
    const misses: string[] = [], skipped: string[] = [];
    let poses = 0, seen = 0, indoor = 0;
    const look = (label: string, eye: V3, yaw: number, pitch: number, isIndoor: boolean) => {
      pc.position.set(...eye);
      pc.lookAt(eye[0] + Math.cos(yaw) * Math.cos(pitch), eye[1] + Math.sin(pitch), eye[2] + Math.sin(yaw) * Math.cos(pitch));
      water.visible = true;
      vis.update(); poses++;
      if (isIndoor) { indoor++; if (!water.visible) skipped.push(label); }
      // Only a skipped water can be a miss, so the rays are cast where it is skipped; every 8th pose still casts
      // them, so the count seen below shows the rays reach the water (as the openings check above)
      if (water.visible && poses % 8) return true;
      const truth = seesWater();
      if (truth) seen++;
      if (truth && !water.visible) misses.push(`${label}, yaw ${yaw.toFixed(2)} pitch ${pitch.toFixed(2)}`);
      return water.visible;
    };
    const yaws = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => (k * Math.PI) / 4);
    // outdoors, 45 m and 80 m from the castle's centre, level, down and up
    for (const R of [45, 80]) for (const a of yaws) {
      const x = Math.cos(a + 0.2) * R, z = Math.sin(a + 0.2) * R, eye: V3 = [x, Math.max(heightAt(x, z), 0) + 1.7, z];
      for (const yaw of yaws) for (const pitch of [-0.3, 0, 0.35]) look(`outside at (${x.toFixed(0)}, ${z.toFixed(0)})`, eye, yaw, pitch, false);
    }
    // the courtyard, on a 6 m grid
    const xs = court.map((q) => q[0]), zs = court.map((q) => q[1]);
    for (let x = Math.min(...xs) + 2; x < Math.max(...xs); x += 6) for (let z = Math.min(...zs) + 2; z < Math.max(...zs); z += 6) {
      if (!inCourt(x, z)) continue;
      for (const yaw of yaws) for (const pitch of [0, 0.3]) look(`courtyard (${x.toFixed(0)}, ${z.toFixed(0)})`, [x, PAVE_Y + 1.7, z], yaw, pitch, false);
    }
    // every room but the caves, from its middle, four ways and a little down; with the doors shut, then
    // with every leaf open (the rays below see through leaves either way: they are not in the occluder)
    for (const open of [false, true]) {
      for (const d of P.doors) vis.setDoorOpen(d.id, open);
      for (const r of P.rooms) {
        if (r.zone === CAVE_ZONE) continue;
        const c = r.poly.reduce((a, q) => [a[0] + q[0] / r.poly.length, a[1] + q[1] / r.poly.length], [0, 0]);
        if (!pointInPoly(r.poly, c[0], c[1])) continue;
        for (const yaw of [0, 1, 2, 3].map((k) => (k * Math.PI) / 2)) look(`${r.id}${open ? ', doors open' : ''}`, [c[0], r.y0 + 1.6, c[1]], yaw, -0.15, true);
      }
    }
    for (const d of P.doors) vis.setDoorOpen(d.id, false);
    // the bookmarks
    const marks = interiorViews(P).filter((w) => ['hall', 'chamber', 'towerroom'].includes(w.name));
    const markShown = marks.map((w) => {
      const d = [w.target[0] - w.pos[0], w.target[1] - w.pos[1], w.target[2] - w.pos[2]], l = Math.hypot(d[0], d[2]);
      const shown = look(w.name, w.pos as V3, Math.atan2(d[2], d[0]), Math.atan2(d[1], l), true);
      return [w.name, shown, seesWater(320, 200)] as const;
    });
    expect(poses).toBeGreaterThan(1000);
    console.info(`water: ${poses} poses, ${seen} see it, ${skipped.length} of ${indoor} indoor skipped`);
    expect(seen).toBeGreaterThan(20); // 27 measured: every 8th pose casts its rays
    expect(misses.slice(0, 10)).toEqual([]);
    expect(skipped.length).toBeGreaterThan(indoor / 2);
    // none of the three sees the water (at 320 × 200 rays), and none draws it
    expect(markShown).toEqual([['hall', false, false], ['chamber', false, false], ['towerroom', false, false]]);
  }, 600_000);
});
