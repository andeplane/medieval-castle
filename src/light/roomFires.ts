// Fires that come and go by room (streamed furniture): each room's emitters join the light rig the
// first time the room arrives and keep their rig ids after that, so a room that unloads and loads again
// gets the same lights (put out with setScale 0, lit again with 1) and the rig's pools are never reset.
// Its flames are linked to its own emitters (linkFlames) and the whole set goes to the flame sprites.
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
}

export function createRoomFires(rig: Pick<LightRig, 'add' | 'setScale'>, onFlames: (fs: FlameInstance[]) => void): RoomFires {
  const ids = new Map<string, number[]>();
  const lit = new Map<string, FlameInstance[]>();
  const all = () => [...lit.values()].flat();
  return {
    set(room, emitters, flames) {
      let mine = ids.get(room);
      if (!mine) { mine = emitters.map((e) => rig.add(e)); ids.set(room, mine); }
      else for (const id of mine) rig.setScale(id, 1);
      lit.set(room, linkFlames(flames, emitters));
      onFlames(all());
    },
    clear(room) {
      if (!lit.has(room)) return;
      for (const id of ids.get(room)!) rig.setScale(id, 0);
      lit.delete(room);
      onFlames(all());
    },
    rooms: () => [...lit.keys()],
    flames: all,
  };
}
