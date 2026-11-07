// Fires that come and go by room (streamed furniture): each room's emitters join the light rig the
// first time the room arrives and keep their rig ids after that, so a room that unloads and loads again
// gets the same lights (put out with setScale 0, lit again with 1) and the rig's pools are never reset.
// Its flames are linked to its own emitters (linkFlames); sync() hands the whole set to the flame sprites
// once a frame when it changed.
import type { LightRig } from './rig';
import { linkFlames, type FlameInstance } from './flames';
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

export function createRoomFires(rig: Pick<LightRig, 'add' | 'setScale'>, onFlames: (fs: FlameInstance[]) => void): RoomFires {
  const ids = new Map<string, number[]>();
  const lit = new Map<string, FlameInstance[]>();
  const all = () => [...lit.values()].flat();
  let changed = false;
  return {
    set(room, emitters, flames) {
      let mine = ids.get(room);
      if (!mine) { mine = emitters.map((e) => rig.add(e)); ids.set(room, mine); }
      else for (const id of mine) rig.setScale(id, 1);
      lit.set(room, linkFlames(flames, emitters));
      changed = true;
    },
    clear(room) {
      if (!lit.has(room)) return;
      for (const id of ids.get(room)!) rig.setScale(id, 0);
      lit.delete(room);
      changed = true;
    },
    rooms: () => [...lit.keys()],
    flames: all,
    sync() { if (changed) { changed = false; onFlames(all()); } },
  };
}
