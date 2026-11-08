// Furnishing off the main thread. The worker side (serveFurnish, wired to the real worker global in
// furnish.worker.ts) furnishes rooms on request; the page side (workerJobs) keeps a small pool of
// workers and hands out jobs to the least busy one. Both are plain logic over injected message
// ports, so tests run them with fakes (tests/props-stream.test.ts).
import type { InteriorPlan, SpaceId } from '../castle/interior/types';
import type { WindowFace } from '../castle/interior/shell';
import { createFurnisher, roomFireLists, transferables, type RoomFireList, type RoomFurniture } from './roomFurniture';
import { variantPool } from './dress';
import { propTextures, type PropTex } from './textures';

/** The prop kit's textures (structurally render.ts PropTextures, without three.js). */
export type PropTexSet = ReturnType<typeof propTextures>;

export interface FurnishInit { plan: InteriorPlan; maxRooms: number; seed?: number; windows?: WindowFace[] }
export type ToFurnisher = ({ t: 'init' } & FurnishInit) | { t: 'room'; job: number; room: SpaceId } | { t: 'fires'; job: number } | { t: 'textures'; job: number };
export type FromFurnisher = { t: 'room'; job: number; result: RoomFurniture } | { t: 'fires'; job: number; result: RoomFireList[] } | { t: 'textures'; job: number; result: PropTexSet } | { t: 'error'; job: number; message: string };

/** The worker global as serveFurnish uses it. */
export interface FurnishScope {
  onmessage: ((e: { data: ToFurnisher }) => void) | null;
  postMessage(m: FromFurnisher, transfer?: Transferable[]): void;
}

/** Answer room (and texture) requests on `scope`. Room requests before 'init' get an error. */
export function serveFurnish(scope: FurnishScope, make: typeof createFurnisher = createFurnisher, textures: () => PropTexSet = propTextures, fires: typeof roomFireLists = roomFireLists) {
  let furnish: ((room: SpaceId) => RoomFurniture) | null = null, listFires: (() => RoomFireList[]) | null = null;
  scope.onmessage = ({ data: m }) => {
    if (m.t === 'init') {
      const pool = variantPool(); // one prop pool for the fires and the furniture: the same props
      furnish = make(m.plan, { maxRooms: m.maxRooms, seed: m.seed, windows: m.windows, make: pool });
      listFires = () => fires(m.plan, { seed: m.seed, windows: m.windows, make: pool });
      return;
    }
    try {
      if (m.t === 'textures') {
        const result = textures();
        scope.postMessage({ t: 'textures', job: m.job, result }, Object.values(result).flatMap((x: PropTex) => [x.albedo.buffer, x.normal.buffer, x.rough.buffer] as ArrayBuffer[]));
        return;
      }
      if (!furnish || !listFires) throw new Error('furnisher not initialised');
      if (m.t === 'fires') { scope.postMessage({ t: 'fires', job: m.job, result: listFires() }); return; }
      const result = furnish(m.room);
      scope.postMessage({ t: 'room', job: m.job, result }, transferables(result));
    } catch (e) {
      scope.postMessage({ t: 'error', job: m.job, message: e instanceof Error ? e.message : String(e) });
    }
  };
}

/** Runs one room's furnishing somewhere (a worker, or inline in tests). */
export interface FurnitureJobs {
  run(room: SpaceId): Promise<RoomFurniture>;
  /** Every room's fires (roomFireLists), without its furniture: the page lights them all before the first frame. */
  fires(): Promise<RoomFireList[]>;
  /** The prop textures, made off the page's thread where there are workers. */
  textures(): Promise<PropTexSet>;
  dispose(): void;
}

/** The page's handle on a worker (a Worker satisfies it). */
export interface WorkerPort {
  onmessage: ((e: { data: FromFurnisher }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
  postMessage(m: ToFurnisher): void;
  terminate(): void;
}

/** Workers to use: one fewer than the cores (the page keeps one), at least 1, at most `cap`. */
export const poolSize = (cores: number | undefined, cap = 2) => Math.max(1, Math.min(cap, (cores ?? 2) - 1));

/** A pool of `size` workers; each job goes to the worker with the fewest jobs in flight. */
export function workerJobs(create: () => WorkerPort, size: number, init: FurnishInit): FurnitureJobs {
  let next = 0;
  const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void; w: number }>();
  const busy = new Array<number>(size).fill(0);
  const workers = Array.from({ length: size }, (_, w) => {
    const port = create();
    const settle = (job: number) => { const p = pending.get(job); if (p) { pending.delete(job); busy[w]--; } return p; };
    port.onmessage = ({ data: m }) => {
      const p = settle(m.job);
      if (!p) return;
      if (m.t === 'error') p.reject(new Error(m.message)); else p.resolve(m.result);
    };
    // a worker that fails to load or throws outside a job fails everything it holds
    port.onerror = (e) => { for (const [job, p] of [...pending]) if (p.w === w) { settle(job); p.reject(new Error(e.message ?? 'furnish worker error')); } };
    port.postMessage({ t: 'init', ...init });
    return port;
  });
  const ask = <T>(m: (job: number) => ToFurnisher): Promise<T> => {
    const w = busy.indexOf(Math.min(...busy)), job = next++;
    busy[w]++;
    return new Promise<T>((resolve, reject) => { pending.set(job, { resolve: resolve as (r: unknown) => void, reject, w }); workers[w].postMessage(m(job)); });
  };
  return {
    run: (room) => ask((job) => ({ t: 'room', job, room })),
    fires: () => ask((job) => ({ t: 'fires', job })),
    textures: () => ask((job) => ({ t: 'textures', job })),
    dispose() { for (const w of workers) w.terminate(); },
  };
}

/** Jobs run on the calling thread (tests, and a fallback without workers). */
export function inlineJobs(furnish: (room: SpaceId) => RoomFurniture, textures: () => PropTexSet = propTextures, fires: () => RoomFireList[] = () => []): FurnitureJobs {
  return { run: async (room) => furnish(room), fires: async () => fires(), textures: async () => textures(), dispose() {} };
}
