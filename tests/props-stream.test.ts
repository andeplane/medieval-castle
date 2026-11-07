// Streamed furniture: the per-room furnisher against the old whole-castle path, the worker protocol
// round trip, the streamer (queue, dedupe, bounded jobs, time slicing, hysteresis) with fakes, and
// the three.js sink.
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three/webgpu';
import { planInterior } from '../src/castle/interior/plan';
import type { InteriorPlan, InteriorGroup, SpaceId } from '../src/castle/interior/types';
import { dressPlan, groupKey } from '../src/props/dress';
import { mergePlaced, colliderSoup } from '../src/props/place';
import { meshFromProp, makePropMaterials } from '../src/props/render';
import { tagGroups } from '../src/render/interiorLight';
import { PROP_MATS } from '../src/props/geom';
import { createFurnisher, sphereOf, unionSphere, colliderBoxes, transferables, BOX_FLOATS, type RoomFurniture } from '../src/props/roomFurniture';
import { serveFurnish, workerJobs, inlineJobs, poolSize, type FurnishScope, type WorkerPort, type ToFurnisher, type FromFurnisher, type FurnitureJobs } from '../src/props/furnishWorker';
import { createFurnitureStreamer, type RoomSink } from '../src/props/streamer';
import { meshesFromBins, mergeBins, startMerge, stepMerge, createRoomSink } from '../src/props/roomMeshes';
import { yawXZ } from '../src/props/place';
import type { PropTex } from '../src/props/textures';

const MAX_ROOMS = 1024;
let plan: InteriorPlan;
beforeAll(() => { plan = planInterior(); });

const fakeTex = (): PropTex => ({ size: 2, albedo: new Uint8Array(16), normal: new Uint8Array(16), rough: new Uint8Array(16) });
const mats = makePropMaterials({ wood: fakeTex(), iron: fakeTex(), cloth: fakeTex(), straw: fakeTex(), ceramic: fakeTex(), brass: fakeTex(), stone: fakeTex(), paint: fakeTex() });

/** Concatenate float arrays. */
const cat = (xs: Float32Array[]) => { const o = new Float32Array(xs.reduce((s, x) => s + x.length, 0)); let k = 0; for (const x of xs) { o.set(x, k); k += x.length; } return o; };

describe('per-room furnishing', () => {
  it('matches the old whole-castle path (dressPlan → group meshes → tagGroups), room by room', () => {
    const old = dressPlan(plan);
    const furnish = createFurnisher(plan, { maxRooms: MAX_ROOMS });
    const rooms = plan.rooms.slice(0, MAX_ROOMS), index = new Map(rooms.map((r, i) => [r.id, i] as [SpaceId, number]));
    // a hall, a cellar, a chamber floor and a tunnel: whichever groups these rooms are in
    const keys = [...new Set(['hall', 'undercroft', 'chamber'].map((k) => plan.rooms.find((r) => r.kind === k)).filter((r) => r).map((r) => groupKey(r!)))].filter((k) => old.byGroup.has(k));
    keys.push([...old.byGroup.keys()].find((k) => plan.rooms.some((r) => r.zone === 'tunnel' && groupKey(r) === k))!);
    let checked = 0;
    for (const key of keys) {
      const placed = old.byGroup.get(key)!;
      const object = meshFromProp(mergePlaced(placed).mesh, mats, key);
      const group = { key, rooms: plan.rooms.filter((r) => groupKey(r) === key).map((r) => r.id), object } as unknown as InteriorGroup;
      tagGroups([group], rooms, index, 4.5);
      const mine = plan.rooms.filter((r) => groupKey(r) === key).map((r) => furnish(r.id));
      expect(mine.reduce((s, r) => s + r.props, 0)).toBe(placed.length);
      for (const k of PROP_MATS) {
        const m = object.children.find((c) => c.name === `${key}-${k}`) as THREE.Mesh | undefined;
        const parts = mine.map((r) => r.bins[k]).filter((b) => b);
        if (!m) { expect(parts).toHaveLength(0); continue; }
        const attr = (n: string) => Array.from(m.geometry.getAttribute(n).array as Float32Array);
        expect(Array.from(cat(parts.map((b) => b!.pos)))).toEqual(attr('position'));
        expect(Array.from(cat(parts.map((b) => b!.nor)))).toEqual(attr('normal'));
        expect(Array.from(cat(parts.map((b) => b!.uv)))).toEqual(attr('uv'));
        expect(Array.from(cat(parts.map((b) => b!.col)))).toEqual(attr('color'));
        expect(Array.from(cat(parts.map((b) => b!.room)))).toEqual(attr('interiorRoom'));
        checked++;
      }
      // emitters and flames, and the colliders: boxes span the old triangle soup's corners
      const { mesh, emitters } = mergePlaced(placed);
      expect(mine.flatMap((r) => r.emitters)).toEqual(emitters);
      expect(mine.flatMap((r) => r.flames)).toEqual(mesh.flames);
      const soup = cat(mine.map((r) => soupOf(r.boxes))), ref = colliderSoup(placed);
      expect(soup.length).toBe(ref.length);
      expect(Math.max(0, ...ref.map((v, i) => Math.abs(v - soup[i])))).toBeLessThan(1e-4);
    }
    expect(keys.length).toBeGreaterThanOrEqual(3);
    expect(checked).toBeGreaterThan(8);
  });

  it('does not depend on the order rooms are asked for, nor on the furnisher', () => {
    const ids = plan.rooms.filter((_, i) => i % 9 === 0).map((r) => r.id);
    const a = createFurnisher(plan, { maxRooms: MAX_ROOMS }), b = createFurnisher(plan, { maxRooms: MAX_ROOMS });
    const forward = ids.map((id) => a(id));
    const backward = [...ids].reverse().map((id) => b(id)).reverse();
    expect(backward).toEqual(forward);
    expect(forward.some((r) => r.props > 0)).toBe(true);
    expect(() => a('nope')).toThrow(/no room/);
  });

  it('lists every buffer for transfer and boxes only for blocking props', () => {
    const r = createFurnisher(plan, { maxRooms: MAX_ROOMS })(plan.rooms.find((x) => x.kind === 'hall')!.id);
    expect(transferables(r)).toHaveLength(1 + Object.keys(r.bins).length * 5);
    expect(r.boxes.length % BOX_FLOATS).toBe(0);
    const d = dressPlan({ ...plan, rooms: [plan.rooms.find((x) => x.kind === 'hall')!] }).rooms[0];
    expect(colliderBoxes(d.placed.filter((p) => !p.prop.kind.blocksNav))).toHaveLength(0);
  });
});

/** Triangle soup of boxes, as place.ts colliderSoup lays them out. */
function soupOf(boxes: Float32Array): Float32Array {
  const out: number[] = [];
  const F = [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]];
  for (let i = 0; i < boxes.length; i += BOX_FLOATS) {
    const [cx, cy, cz, hx, hy, hz, yaw] = boxes.subarray(i, i + BOX_FLOATS);
    const v: number[][] = [];
    for (const y of [-1, 1]) for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const [x, z] = yawXZ(sx * hx, sz * hz, yaw); v.push([cx + x, cy + y * hy, cz + z]); }
    for (const [a, b, c, d] of F) out.push(...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[d]);
  }
  return new Float32Array(out);
}

// ---------------------------------------------------------------- worker protocol

/** A worker port and its scope wired back to back; messages are structured-cloned as postMessage does. */
const tinyTex = () => { const t = (): PropTex => ({ size: 1, albedo: new Uint8Array(4), normal: new Uint8Array(4), rough: new Uint8Array(4) }); return { wood: t(), iron: t(), cloth: t(), straw: t(), ceramic: t(), brass: t(), stone: t(), paint: t() }; };
function fakeWorker(furnisherOf = createFurnisher) {
  const sent: ToFurnisher[] = [];
  let transferred = 0;
  const scope: FurnishScope = {
    onmessage: null,
    postMessage(m: FromFurnisher, transfer?: Transferable[]) { transferred += transfer?.length ?? 0; const c = structuredClone(m, { transfer: transfer as Transferable[] }); queueMicrotask(() => port.onmessage?.({ data: c })); },
  };
  const port: WorkerPort & { terminated: boolean; sent: ToFurnisher[]; transferred: () => number } = {
    onmessage: null, onerror: null, terminated: false, sent, transferred: () => transferred,
    postMessage(m) { sent.push(m); const c = structuredClone(m); queueMicrotask(() => scope.onmessage?.({ data: c })); },
    terminate() { this.terminated = true; },
  };
  serveFurnish(scope, furnisherOf, tinyTex);
  return port;
}

describe('furnish worker protocol', () => {
  it('round-trips rooms through structured clone and transfer, equal to inline', async () => {
    const ports: ReturnType<typeof fakeWorker>[] = [];
    const jobs = workerJobs(() => { const p = fakeWorker(); ports.push(p); return p; }, 2, { plan, maxRooms: MAX_ROOMS });
    const inline = inlineJobs(createFurnisher(plan, { maxRooms: MAX_ROOMS }));
    const ids = [plan.rooms.find((r) => r.kind === 'hall')!.id, plan.rooms.find((r) => r.kind === 'undercroft')!.id, plan.rooms[3].id];
    const got = await Promise.all(ids.map((id) => jobs.run(id)));
    expect(got).toEqual(await Promise.all(ids.map((id) => inline.run(id))));
    expect(got[0].bins.wood!.pos).toBeInstanceOf(Float32Array);
    // spread over both workers, each initialised once with the plan
    expect(ports.map((p) => p.sent.filter((m) => m.t === 'room').length)).toEqual([2, 1]);
    expect(ports.every((p) => p.sent[0].t === 'init')).toBe(true);
    expect(ports[0].transferred()).toBeGreaterThan(5);
    // the prop textures come from a worker too, their pixels transferred
    const before = ports.map((p) => p.transferred());
    expect(await jobs.textures()).toEqual(tinyTex());
    expect(ports.reduce((s, p, i) => s + p.transferred() - before[i], 0)).toBe(24);
    jobs.dispose(); inline.dispose();
    expect(ports.every((p) => p.terminated)).toBe(true);
  });

  it('rejects a job the worker fails, and everything a crashed worker held', async () => {
    const ports: ReturnType<typeof fakeWorker>[] = [];
    const jobs = workerJobs(() => { const p = fakeWorker(); ports.push(p); return p; }, 1, { plan, maxRooms: MAX_ROOMS });
    await expect(jobs.run('no-such-room')).rejects.toThrow(/no room/);
    const a = jobs.run(plan.rooms[0].id), b = jobs.run(plan.rooms[1].id);
    ports[0].onerror!({ message: 'boom' });
    await expect(a).rejects.toThrow('boom');
    await expect(b).rejects.toThrow('boom');
    ports[0].onerror!({});
    // a late answer to a settled job is ignored
    ports[0].onmessage!({ data: { t: 'error', job: 99, message: 'late' } });
    const c = jobs.run(plan.rooms[2].id);
    ports[0].onerror!({});
    await expect(c).rejects.toThrow('furnish worker error');
  });

  it('answers requests before init with an error, and non-Error throws as text', () => {
    const out: FromFurnisher[] = [];
    const scope: FurnishScope = { onmessage: null, postMessage: (m) => { out.push(m); } };
    serveFurnish(scope, () => () => { throw 'bad'; });
    scope.onmessage!({ data: { t: 'room', job: 1, room: 'x' } });
    scope.onmessage!({ data: { t: 'init', plan, maxRooms: 4 } });
    scope.onmessage!({ data: { t: 'room', job: 2, room: 'x' } });
    expect(out).toEqual([{ t: 'error', job: 1, message: 'furnisher not initialised' }, { t: 'error', job: 2, message: 'bad' }]);
  });

  it('makes the real prop textures inline', async () => {
    const t = await inlineJobs(() => room('x')).textures();
    expect(Object.keys(t)).toEqual(['wood', 'iron', 'cloth', 'straw', 'ceramic', 'brass', 'stone', 'paint']);
    expect(t.wood.albedo.length).toBe(t.wood.size * t.wood.size * 4);
  });

  it('sizes the pool from the cores', () => {
    expect(poolSize(undefined)).toBe(1);
    expect(poolSize(1)).toBe(1);
    expect(poolSize(8)).toBe(2);
    expect(poolSize(8, 3)).toBe(3);
  });
});

// ---------------------------------------------------------------- streamer

const room = (id: SpaceId, emitters = 0): RoomFurniture => ({
  room: id, key: 'k', role: 'store', props: 2, triangles: 10, bins: {}, boxes: new Float32Array(0),
  emitters: Array.from({ length: emitters }, () => ({ kind: 'torch' as const, position: [0, 0, 0] as [number, number, number], colour: [1, 1, 1] as [number, number, number], intensity: 1, flicker: 0 })), flames: [],
});

/** Jobs that resolve when the test says so. */
function manualJobs() {
  const calls: { room: SpaceId; resolve: () => void; reject: (e: Error) => void }[] = [];
  let disposed = false;
  const jobs: FurnitureJobs = {
    run: (id) => new Promise((res, rej) => calls.push({ room: id, resolve: () => res(room(id, 1)), reject: rej })),
    textures: async () => tinyTex(),
    dispose: () => { disposed = true; },
  };
  return { jobs, calls, disposed: () => disposed };
}
function fakeSink(cost = 0, clock?: { t: number }) {
  const live = new Set<SpaceId>(), log: string[] = [];
  const sink: RoomSink<SpaceId> = {
    add: (r) => { live.add(r.room); log.push(`+${r.room}`); if (clock) clock.t += cost; return r.room; },
    remove: (h) => { live.delete(h); log.push(`-${h}`); },
  };
  return { sink, live, log };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('furniture streamer', () => {
  it('requests wanted rooms once, at most maxInFlight at a time, in the order given', async () => {
    const clock = { t: 0 };
    const J = manualJobs(), S = fakeSink();
    const s = createFurnitureStreamer({ jobs: J.jobs, sink: S.sink, now: () => clock.t }, { maxInFlight: 2 });
    s.setWanted(new Set(['a', 'b', 'c']));
    s.setWanted(new Set(['a', 'b', 'c'])); // no duplicates
    expect(J.calls.map((c) => c.room)).toEqual(['a', 'b']);
    expect(s.stats()).toMatchObject({ inFlight: 2, queued: 1 });
    J.calls[1].resolve(); await flush();
    s.setWanted(new Set(['a', 'b', 'c'])); // b is ready, not in yet: not asked for again; c starts
    s.update(); // b goes in
    expect(J.calls.map((c) => c.room)).toEqual(['a', 'b', 'c']);
    expect(S.log).toEqual(['+b']);
    expect(s.isLoaded('b')).toBe(true); expect(s.isLoaded('a')).toBe(false);
    s.setWanted(new Set(['a', 'b', 'c'])); // loaded or in flight: nothing new
    expect(J.calls).toHaveLength(3);
    expect(s.idle()).toBe(false);
    J.calls[0].resolve(); J.calls[2].resolve(); await flush();
    s.update();
    expect(s.idle()).toBe(true);
    expect(s.stats()).toMatchObject({ loaded: 3, props: 6, triangles: 30, emitters: 3, added: 3, maxUpdateMs: 0 });
  });

  it('drops queued rooms nobody wants any more', () => {
    const J = manualJobs(), S = fakeSink();
    const s = createFurnitureStreamer({ jobs: J.jobs, sink: S.sink, now: () => 0 }, { maxInFlight: 1 });
    s.setWanted(new Set(['a', 'b', 'c']));
    s.setWanted(new Set(['a', 'c']));
    expect(s.stats().queued).toBe(1);
    J.calls[0].resolve();
    return flush().then(() => { s.update(); expect(J.calls.map((c) => c.room)).toEqual(['a', 'c']); });
  });

  it('unloads a room only after it has been unwanted for unloadAfter (hysteresis)', async () => {
    const clock = { t: 0 };
    const J = manualJobs(), S = fakeSink();
    const s = createFurnitureStreamer({ jobs: J.jobs, sink: S.sink, now: () => clock.t }, { unloadAfter: 1000 });
    s.setWanted(new Set(['a', 'b']));
    J.calls.forEach((c) => c.resolve()); await flush(); s.update();
    clock.t = 100; s.setWanted(new Set(['a'])); s.update();
    clock.t = 1000; s.update();
    expect(S.live).toEqual(new Set(['a', 'b']));
    clock.t = 1101; s.update();
    expect(S.live).toEqual(new Set(['a']));
    // wanted again: back in through a new job; within the window it would have stayed
    s.setWanted(new Set(['a', 'b']));
    expect(J.calls.map((c) => c.room)).toEqual(['a', 'b', 'b']);
    clock.t = 1500; s.setWanted(new Set(['b'])); clock.t = 2400; s.setWanted(new Set(['a', 'b'])); clock.t = 3000; s.update();
    expect(S.live.has('a')).toBe(true);
    expect(s.stats().removed).toBe(1);
  });

  it('adds finished rooms within the frame budget, at least one per update', async () => {
    const clock = { t: 0 };
    const J = manualJobs(), S = fakeSink(3, clock);
    const s = createFurnitureStreamer({ jobs: J.jobs, sink: S.sink, now: () => clock.t }, { budgetMs: 4, maxInFlight: 8 });
    s.setWanted(new Set(['a', 'b', 'c', 'd', 'e']));
    J.calls.forEach((c) => c.resolve()); await flush();
    s.update(); expect(S.live.size).toBe(2); // 3 ms, 6 ms: over budget after the second
    S.sink.add = ((add) => (r: RoomFurniture) => { clock.t += 10; return add(r); })(S.sink.add);
    s.update(); expect(S.live.size).toBe(3); // one, even though it alone is over budget
    s.update(); s.update(); expect(S.live.size).toBe(5);
    expect(s.stats().maxUpdateMs).toBe(13); // 10 + the sink's own 3
    expect(s.stats().medianUpdateMs).toBe(13); // updates of 6, 13, 13, 13 ms
  });

  it('unloads within what is left of the budget, and drops results nobody wants any more', async () => {
    const clock = { t: 0 };
    const J = manualJobs(), S = fakeSink();
    const s = createFurnitureStreamer({ jobs: J.jobs, sink: { add: S.sink.add, remove: (h) => { clock.t += 3; S.sink.remove(h); } }, now: () => clock.t }, { unloadAfter: 100, budgetMs: 4, maxInFlight: 8 });
    s.setWanted(new Set(['a', 'b', 'c']));
    J.calls.forEach((c) => c.resolve()); await flush(); s.update();
    s.setWanted(new Set(['d']));
    clock.t = 200; s.update();
    expect(S.live.size).toBe(1); // 3 ms + 3 ms: two out, the third waits
    s.update(); expect(S.live.size).toBe(0);
    // d finishes after it stopped being wanted long ago: never added
    s.setWanted(new Set(['e'])); clock.t = 400;
    J.calls[3].resolve(); await flush(); s.update();
    expect(S.log.includes('+d')).toBe(false);
    expect(s.isLoaded('d')).toBe(false);
  });

  it('runs the sink\'s deferred work in the budget and is not idle or settled until it is done', async () => {
    const J = manualJobs(), S = fakeSink();
    let work = 3, calls = 0;
    const s = createFurnitureStreamer({ jobs: J.jobs, sink: { ...S.sink, flush: (over) => { calls++; do work--; while (work > 0 && !over()); return work > 0; } }, now: () => 0 }, { budgetMs: 0 });
    s.setWanted(new Set(['a']));
    J.calls[0].resolve(); await flush();
    s.update();
    expect(work).toBe(3); expect(s.idle()).toBe(false); // the add took this frame's budget
    s.update();
    expect(work).toBe(2);
    await s.settle();
    expect(work).toBe(0); expect(s.idle()).toBe(true);
    work = 2; // dispose finishes whatever is left, with no budget
    s.dispose();
    expect(work).toBe(0);
    expect(calls).toBe(4);
    expect(s.stats().medianUpdateMs).toBe(0);
  });

  it('records failed rooms without retrying them, and settles', async () => {
    const J = manualJobs(), S = fakeSink(), errors: SpaceId[] = [];
    const s = createFurnitureStreamer({ jobs: J.jobs, sink: S.sink, now: () => 0, onError: (id) => errors.push(id) });
    s.setWanted(new Set(['a', 'b']));
    const done = s.settle();
    J.calls[0].reject(new Error('x')); await flush();
    J.calls[1].resolve();
    await done;
    expect(errors).toEqual(['a']);
    expect(s.stats()).toMatchObject({ failed: 1, loaded: 1 });
    s.setWanted(new Set(['a', 'b']));
    expect(J.calls).toHaveLength(2);
    await s.settle(); // already idle
    // a stream without an error handler survives a failure too
    const J2 = manualJobs(), s2 = createFurnitureStreamer({ jobs: J2.jobs, sink: fakeSink().sink, now: () => 0 });
    s2.setWanted(new Set(['z'])); J2.calls[0].reject(new Error('y')); await flush();
    expect(s2.stats().failed).toBe(1);
  });

  it('disposes: unloads everything, drops late results, stops the jobs', async () => {
    const J = manualJobs(), S = fakeSink();
    const s = createFurnitureStreamer({ jobs: J.jobs, sink: S.sink, now: () => 0 });
    s.setWanted(new Set(['a', 'b']));
    J.calls[0].resolve(); await flush(); s.update();
    s.dispose();
    J.calls[1].resolve(); await flush(); s.update();
    expect(S.live.size).toBe(0);
    expect(J.disposed()).toBe(true);
    expect(s.stats().ready).toBe(0);
  });

  it('streams real rooms end to end with inline jobs', async () => {
    const S = fakeSink();
    const s = createFurnitureStreamer({ jobs: inlineJobs(createFurnisher(plan, { maxRooms: MAX_ROOMS })), sink: S.sink, now: () => performance.now() });
    const ids = plan.rooms.filter((r) => r.kind === 'hall').map((r) => r.id);
    s.setWanted(new Set(ids));
    await s.settle();
    expect(S.live).toEqual(new Set(ids));
    expect(s.stats().props).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------- three.js sink

describe('room meshes', () => {
  it('merges a group\'s loaded rooms into one mesh per material, equal to the old per-group path, and rebuilds as rooms come and go', () => {
    const old = dressPlan(plan);
    const rooms = plan.rooms.slice(0, MAX_ROOMS), index = new Map(rooms.map((r, i) => [r.id, i] as [SpaceId, number]));
    const key = groupKey(plan.rooms.find((x) => x.kind === 'hall')!);
    const ids = plan.rooms.filter((r) => groupKey(r) === key).map((r) => r.id);
    const ref = meshFromProp(mergePlaced(old.byGroup.get(key)!).mesh, mats, key);
    tagGroups([{ key, rooms: ids, object: ref } as unknown as InteriorGroup], rooms, index, 4.5);
    const furnish = createFurnisher(plan, { maxRooms: MAX_ROOMS });
    const order = new Map(plan.rooms.map((r, i) => [r.id, i]));
    const parent = new THREE.Group(), boxes: { n: number; tag?: string; removed: boolean }[] = [], fire: string[] = [];
    const sink = createRoomSink({
      parentOf: (k) => (k === key ? parent : undefined),
      matsFor: () => mats,
      order: (id) => order.get(id)!,
      physics: { addStaticBoxes: (b, tag) => { const e = { n: b.length / BOX_FLOATS, tag, removed: false }; boxes.push(e); return { remove: () => { e.removed = true; } }; } },
      fire: { set: (id, e) => fire.push(`+${id}:${e.length}`), clear: (id) => fire.push(`-${id}`) },
    });
    // rooms arrive in any order; colliders and fires go in at once, meshes on flush
    const furnished = [...ids].reverse().map((id) => furnish(id));
    const handles = furnished.map((r) => sink.add(r));
    expect(parent.children).toHaveLength(0);
    expect(boxes).toHaveLength(ids.length);
    expect(fire.length).toBe(furnished.filter((r) => r.emitters.length || r.flames.length).length);
    // no budget: one step per flush (start, one room per step, swap), so a big group spans frames
    let steps = 0;
    while (sink.flush(() => true)) { steps++; expect(parent.children).toHaveLength(0); }
    expect(steps + 1).toBe(ids.length + 1); // start, then one room per step (the last one swaps)
    const g = sink.objectOf(key)!;
    // the bounding sphere comes from the rooms' spheres and holds every vertex
    for (const m of g.children as THREE.Mesh[]) {
      const sp = m.geometry.boundingSphere!, p = m.geometry.getAttribute('position');
      for (let i = 0; i < p.count; i++) expect(sp.center.distanceTo(new THREE.Vector3().fromBufferAttribute(p, i))).toBeLessThanOrEqual(sp.radius + 1e-4);
    }
    expect(parent.children).toEqual([g]);
    expect(g.name).toBe(`furniture:${key}`);
    const names = (o: THREE.Object3D) => o.children.map((c) => c.name.split('-').pop());
    expect(names(g)).toEqual(names(ref));
    for (const [i, m] of (g.children as THREE.Mesh[]).entries()) {
      const r = ref.children[i] as THREE.Mesh;
      for (const a of ['position', 'normal', 'uv', 'color', 'interiorRoom']) expect(Array.from(m.geometry.getAttribute(a).array)).toEqual(Array.from(r.geometry.getAttribute(a).array));
      expect(m.castShadow).toBe(r.castShadow); expect(m.receiveShadow).toBe(r.receiveShadow);
    }
    expect(g.userData.triangles).toBe(ref.userData.triangles);
    // a room goes: the group is rebuilt without it, the old geometry disposed
    let disposed = 0;
    for (const m of g.children as THREE.Mesh[]) m.geometry.addEventListener('dispose', () => disposed++);
    const big = handles.reduce((a, h, i) => (furnished[i].triangles > furnished[handles.indexOf(a)].triangles ? h : a), handles[0]);
    const bigTris = furnished[handles.indexOf(big)].triangles;
    sink.remove(big);
    expect(boxes[handles.indexOf(big)].removed).toBe(true);
    expect(fire.at(-1)).toBe(`-${big.room}`);
    // while the rebuild runs, step by step, the old mesh stays drawn: nothing vanishes in between
    for (let i = 0; i < 3; i++) { expect(sink.flush(() => true)).toBe(true); expect(parent.children).toEqual([g]); expect(disposed).toBe(0); }
    // a room arriving mid-rebuild restarts it; the old mesh is still there
    const back = sink.add(furnished[handles.indexOf(big)]);
    sink.flush(() => true);
    expect(parent.children).toEqual([g]);
    sink.remove(back);
    sink.flush(() => false);
    expect(disposed).toBe(g.children.length);
    expect(parent.children).toEqual([sink.objectOf(key)]);
    expect(sink.objectOf(key)!.userData.triangles).toBe(ref.userData.triangles - bigTris);
    // all go: nothing left under the group
    for (const h of handles) if (h !== big) sink.remove(h);
    expect(sink.flush(() => false)).toBe(false);
    expect(parent.children).toHaveLength(0);
    expect(sink.objectOf(key)).toBeUndefined();
    // two dirty groups and no budget: one per flush; a group without an object to hang on is still built
    sink.add({ ...room('x'), key: 'none', bins: furnished[0].bins });
    sink.add(furnished[1]);
    expect(sink.flush(() => false)).toBe(false);
    expect(sink.objectOf('none')!.parent).toBeNull();
    const flame = meshesFromBins('f', { flame: furnished[0].bins.wood ?? Object.values(furnished[0].bins)[0] }, mats).children[0] as THREE.Mesh;
    expect(flame.castShadow).toBe(false); expect(flame.receiveShadow).toBe(false);
    expect(mergeBins([])).toEqual({});
  });

  it('splits a big room over several merge steps, to the same arrays', () => {
    const f = createFurnisher(plan, { maxRooms: MAX_ROOMS });
    const rs = plan.rooms.filter((r) => r.kind === 'hall').map((r) => f(r.id));
    const m = startMerge(rs);
    let steps = 1;
    while (!stepMerge(m, 5000)) steps++;
    const floats = rs.reduce((n, r) => n + Object.values(r.bins).reduce((k, b) => k + b.pos.length + b.nor.length + b.uv.length + b.col.length + b.room.length, 0), 0);
    expect(steps).toBeGreaterThanOrEqual(Math.ceil(floats / 5000));
    expect(m.bins).toEqual(mergeBins(rs));
    expect(stepMerge(startMerge([]))).toBe(true);
  });

  it('bounds points and unions spheres', () => {
    expect(sphereOf([0, 0, 0, 2, 0, 0])).toEqual([1, 0, 0, 1]);
    expect(unionSphere([0, 0, 0, 1], [3, 0, 0, 1])).toEqual([1.5, 0, 0, 2.5]);
    expect(unionSphere([0, 0, 0, 5], [1, 0, 0, 1])).toEqual([0, 0, 0, 5]);
    expect(unionSphere([1, 0, 0, 1], [0, 0, 0, 5])).toEqual([0, 0, 0, 5]);
  });
});
