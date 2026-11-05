// Messages between the page and the tunnel worker.
import type { Palette } from './gl';

export type ToWorker =
  | { t: 'init'; canvas: OffscreenCanvas; w: number; h: number; reduced: boolean; fixed?: number; palette: Palette }
  | { t: 'size'; w: number; h: number }
  | { t: 'progress'; p: number }
  | { t: 'look'; x: number; y: number }
  | { t: 'stop' };

export type FromWorker =
  | { t: 'shown'; v: number }
  | { t: 'nogl' };

/** The slice of a worker's global scope (or a test fake) the tunnel worker uses. */
export interface WorkerScope {
  onmessage: ((e: { data: ToWorker }) => void) | null;
  postMessage(m: FromWorker): void;
}
