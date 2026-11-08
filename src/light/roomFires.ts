// Fires that come and go by room (streamed furniture): a room's emitters go into its row of the fire
// table (light/roomLight.ts) when the room arrives and come out when it leaves, so a room's light is
// exactly its own fires whenever it is drawn. Its flames are linked to its own emitters (linkFlames);
// sync() hands the whole set to the flame sprites once a frame when it changed.
import { linkFlames, type FlameInstance } from './flames';
import { roomFires, type FireTable, type RoomBox } from './roomLight';
import type { Flame, LightEmitter } from './types';

export interface RoomFires {
  set(room: string, emitters: LightEmitter[], flames: Flame[]): void;
  clear(room: string): void;
  /** Rooms whose fires are in now. */
  rooms(): string[];
  /** Flame instances of every room that is in, in the order rooms arrived. */
  flames(): FlameInstance[];
  /** Hand the flames to onFlames if they changed since the last sync (once a frame, however many rooms moved). */
  sync(): void;
}

/** `room(id)`: the room's row in the table and its box (for the cap); rooms it does not know light nothing. */
export function createRoomFires(table: Pick<FireTable, 'set' | 'clear'>, room: (id: string) => { row: number; box: RoomBox } | undefined, onFlames: (fs: FlameInstance[]) => void): RoomFires {
  const lit = new Map<string, FlameInstance[]>();
  const all = () => [...lit.values()].flat();
  let changed = false;
  return {
    set(id, emitters, flames) {
      const r = room(id);
      if (r) table.set(r.row, roomFires(r.box, emitters));
      lit.set(id, linkFlames(flames, emitters));
      changed = true;
    },
    clear(id) {
      if (!lit.has(id)) return;
      const r = room(id);
      if (r) table.clear(r.row);
      lit.delete(id);
      changed = true;
    },
    rooms: () => [...lit.keys()],
    flames: all,
    sync() { if (changed) { changed = false; onFlames(all()); } },
  };
}
