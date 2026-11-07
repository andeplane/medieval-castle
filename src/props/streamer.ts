// Streaming furniture: rooms are furnished on demand (in workers, furnishWorker.ts) and put into the
// world a few per frame, and taken out again when nobody has wanted them for a while.
// - setWanted(rooms): rooms not loaded or on their way are queued, in the set's order (put the room
//   the player stands in first); rooms that drop out of the set are kept for `unloadAfter` ms
//   (hysteresis, so a room behind you does not reload when you turn round).
// - update(): starts jobs (at most `maxInFlight` at once), adds finished rooms until `budgetMs` of this
//   frame is spent (at least one per frame), then unloads rooms past their time while budget is left.
// The world side is a RoomSink (meshes, colliders, fire); tests pass fakes for it and for the jobs.
import type { SpaceId } from '../castle/interior/types';
import type { FurnitureJobs } from './furnishWorker';
import type { RoomFurniture } from './roomFurniture';

/** Where a furnished room goes: add returns a handle that remove takes back out. */
export interface RoomSink<H> {
  add(r: RoomFurniture): H;
  remove(h: H): void;
  /** Deferred work (rebuilding merged meshes): do at least one piece, more while `over()` is false.
   * Returns true while work is left. */
  flush?(over: () => boolean): boolean;
}

/** What the streamer is told to keep: the rooms near the player (a room graph, or a stand-in). */
export interface WantedRooms { wantedRooms(): Set<SpaceId> }

export interface StreamerOptions {
  /** Jobs in flight at once. */
  maxInFlight: number;
  /** Milliseconds a room stays after it was last wanted. */
  unloadAfter: number;
  /** Milliseconds per update for adding rooms (one room is always added if one is ready). */
  budgetMs: number;
}
export const DEFAULT_STREAMER: StreamerOptions = { maxInFlight: 4, unloadAfter: 5000, budgetMs: 4 };

export interface StreamerDeps<H> {
  jobs: FurnitureJobs;
  sink: RoomSink<H>;
  /** Milliseconds (performance.now in the page). */
  now(): number;
  onError?(room: SpaceId, e: unknown): void;
}

export interface StreamerStats { loaded: number; inFlight: number; queued: number; ready: number; failed: number; props: number; triangles: number; emitters: number; added: number; removed: number;
  /** Longest single update so far (ms): the frame cost of streaming. */
  maxUpdateMs: number;
  /** Median of the last 1024 updates that did any work (ms). */
  medianUpdateMs: number }

export interface FurnitureStreamer {
  setWanted(rooms: Set<SpaceId>): void;
  update(): void;
  isLoaded(room: SpaceId): boolean;
  /** Nothing queued, in flight or waiting to be added. */
  idle(): boolean;
  /** Run update until idle (captures and tests); resolves once every wanted room is in. */
  settle(): Promise<void>;
  stats(): StreamerStats;
  dispose(): void;
}

export function createFurnitureStreamer<H>(d: StreamerDeps<H>, opts: Partial<StreamerOptions> = {}): FurnitureStreamer {
  const o = { ...DEFAULT_STREAMER, ...opts };
  const lastWanted = new Map<SpaceId, number>();
  const wanted = new Set<SpaceId>();
  const queue: SpaceId[] = [];
  const inFlight = new Set<SpaceId>();
  const ready: RoomFurniture[] = [];
  const loaded = new Map<SpaceId, { h: H; r: RoomFurniture }>();
  const failed = new Set<SpaceId>();
  let added = 0, removed = 0, disposed = false, maxUpdateMs = 0, flushing = false;
  const busyMs: number[] = [];
  let wake: (() => void) | null = null;

  const known = (id: SpaceId) => loaded.has(id) || inFlight.has(id) || failed.has(id) || ready.some((r) => r.room === id);
  const start = () => {
    while (inFlight.size < o.maxInFlight && queue.length) {
      const id = queue.shift()!;
      inFlight.add(id);
      d.jobs.run(id).then(
        (r) => { inFlight.delete(id); if (!disposed) ready.push(r); wake?.(); },
        (e) => { inFlight.delete(id); failed.add(id); d.onError?.(id, e); wake?.(); },
      );
    }
  };
  const unload = (id: SpaceId) => { const l = loaded.get(id)!; d.sink.remove(l.h); loaded.delete(id); removed++; };

  const api: FurnitureStreamer = {
    setWanted(rooms) {
      const t = d.now();
      wanted.clear();
      for (const id of rooms) { wanted.add(id); lastWanted.set(id, t); }
      // queued rooms nobody wants any more are dropped; new ones join in the order given
      for (let i = queue.length - 1; i >= 0; i--) if (!wanted.has(queue[i])) queue.splice(i, 1);
      for (const id of rooms) if (!known(id) && !queue.includes(id)) queue.push(id);
      start();
    },
    update() {
      const t0 = d.now(), over = () => d.now() - t0 >= o.budgetMs;
      const stale = (id: SpaceId) => !wanted.has(id) && t0 - lastWanted.get(id)! > o.unloadAfter;
      start();
      const before = added + removed;
      // rooms in first (one at least), then rooms out with what is left of the budget, then the sink's
      // deferred work (one step at least when nothing else was done this frame)
      while (ready.length) {
        const r = ready.shift()!;
        if (stale(r.room)) continue; // came back after nobody wanted it any more
        loaded.set(r.room, { h: d.sink.add(r), r }); added++; // known() keeps a room from coming twice
        if (over()) break;
      }
      for (const id of [...loaded.keys()]) { if (over()) break; if (stale(id)) unload(id); }
      const worked = added + removed > before;
      if (worked && d.sink.flush) flushing = true;
      if (flushing && (!worked || !over())) flushing = d.sink.flush!(over);
      const ms = d.now() - t0;
      maxUpdateMs = Math.max(maxUpdateMs, ms);
      if (worked || flushing || ms > 0) { busyMs.push(ms); if (busyMs.length > 1024) busyMs.shift(); }
    },
    isLoaded: (id) => loaded.has(id),
    idle: () => !queue.length && !inFlight.size && !ready.length && !flushing,
    async settle() {
      api.update();
      while (!api.idle()) {
        if (!ready.length && !flushing) await new Promise<void>((r) => { wake = r; });
        wake = null;
        api.update();
      }
    },
    stats() {
      let props = 0, triangles = 0, emitters = 0;
      for (const { r } of loaded.values()) { props += r.props; triangles += r.triangles; emitters += r.emitters.length; }
      return { loaded: loaded.size, inFlight: inFlight.size, queued: queue.length, ready: ready.length, failed: failed.size, props, triangles, emitters, added, removed, maxUpdateMs, medianUpdateMs: busyMs.length ? [...busyMs].sort((a, b) => a - b)[busyMs.length >> 1] : 0 };
    },
    dispose() {
      disposed = true;
      for (const id of [...loaded.keys()]) unload(id);
      d.sink.flush?.(() => false);
      queue.length = 0; ready.length = 0;
      d.jobs.dispose();
    },
  };
  return api;
}
