import { describe, it, expect } from 'vitest';
import { createRoomFires } from '../../src/light/roomFires';
import { FireTable, MAX_FIRES, FIRE_W } from '../../src/light/roomLight';
import type { FlameInstance } from '../../src/light/flames';
import type { LightEmitter } from '../../src/light/types';

const torch = (x: number): LightEmitter => ({ kind: 'torch', position: [x, 2, 0], colour: [1, 1, 1], intensity: 3, flicker: 0.2 });
const box = { poly: [[-10, -3], [10, -3], [10, 3], [-10, 3]] as [number, number][], y0: 0, y1: 4 };

describe('room fires', () => {
  it('puts a room\'s fires in its row while the room is in, and takes them out when it leaves', () => {
    const table = new FireTable(8);
    const rows: Record<string, number> = { a: 1, b: 2 };
    const seen: FlameInstance[][] = [];
    const F = createRoomFires(table, (id) => (id in rows ? { row: rows[id], box } : undefined), (fs) => seen.push(fs));
    F.set('a', [torch(0)], [{ kind: 'torch', base: [0, 1.8, 0], height: 0.3 }]);
    F.set('b', [torch(-8), torch(8)], []);
    F.set('elsewhere', [torch(9)], []); // a room the table does not know: flames only
    expect(table.fires(1)).toHaveLength(1);
    expect(table.fires(2)).toHaveLength(2);
    expect(F.rooms()).toEqual(['a', 'b', 'elsewhere']);
    expect(F.flames()).toHaveLength(1);
    expect(seen).toHaveLength(0); // flames go out once a frame, on sync
    F.sync(); F.sync();
    expect(seen).toHaveLength(1);
    expect(seen.at(-1)![0].seed).toBe(table.fires(1)[0].seed); // the flame wavers with its own light
    F.clear('b');
    expect(table.fires(2)).toHaveLength(0);
    expect(table.data[2 * FIRE_W * 4]).toBe(0);
    F.clear('b'); // twice: nothing
    F.clear('elsewhere');
    F.sync();
    expect(seen).toHaveLength(2);
    F.set('b', [torch(-8), torch(8)], []);
    expect(table.stats()).toEqual({ rooms: 2, fires: 3, candela: Math.round(table.fires(1)[0].candela * 3) });
    F.clear('a');
    expect(F.flames()).toHaveLength(0);
    expect(F.rooms()).toEqual(['b']);
    expect(MAX_FIRES).toBeGreaterThan(8);
  });
});
