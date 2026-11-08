import { describe, it, expect } from 'vitest';
import { FireTable, lightCastle, toFire, fireAt, firesByRoom, roomSamples, roomSurface, fireStats, roomFires, FIRE_PEAK, FIRE_MEAN, MAX_FIRES, FIRE_W, FIRE_TEXELS, NEAR } from '../../src/light/roomLight';
import { PROFILES, flicker, flickerAmount, seedOf } from '../../src/light/flicker';
import { linkFlames, flameBrightness } from '../../src/light/flames';
import type { LightEmitter, V3 } from '../../src/light/types';
import { planInterior } from '../../src/castle/interior/plan';
import { createFurnisher } from '../../src/props/roomFurniture';
import { wallTorches } from '../../src/render/interiorFire';
import { dressRoom, variantPool } from '../../src/props/dress';
import { mergePlaced, yawXZ } from '../../src/props/place';
import { buildShell } from '../../src/castle/interior/shell';
import { islandCastle } from '../world';
import { caveFires } from '../../src/castle/interior/caveGeom';
import { CAVE_ZONE } from '../../src/castle/interior/caves';
import { CARRIED_LANTERN, lanternAt } from '../../src/player/lantern';

const em = (kind: LightEmitter['kind'], p: V3, intensity = 1, extra: Partial<LightEmitter> = {}): LightEmitter => ({ kind, position: p, colour: [1, 1, 1], intensity, flicker: 0.2, ...extra });
const hall = { poly: [[0, 0], [8, 0], [8, 6], [0, 6]] as [number, number][], y0: 0, y1: 4 };

describe('fires as the shader sees them', () => {
  it('resolves an emitter against its profile', () => {
    const f = toFire(em('torch', [1, 2, 3], 3));
    expect(f.candela).toBe(PROFILES.torch.candela * 3);
    expect(f.range).toBeCloseTo(PROFILES.torch.range * Math.sqrt(3) > PROFILES.torch.range * 1.5 ? PROFILES.torch.range * 1.5 : PROFILES.torch.range * Math.sqrt(3));
    expect(f.soft).toBe(PROFILES.torch.soft);
    expect(f.seed).toBe(seedOf([1, 2, 3]));
    expect(f.amount).toBe(flickerAmount(0.2));
    expect(Math.max(...f.colour)).toBeCloseTo(1);
    expect(f.colour[2]).toBeGreaterThan(toFire(em('torch', [0, 0, 0]), 0).colour[2]); // the adapted eye sees it less orange
    expect(toFire(em('candle', [0, 0, 0], 0.01)).range).toBe(PROFILES.candle.range * 0.5);
    expect(toFire(em('candle', [0, 0, 0], 1, { seed: 7 })).seed).toBe(7);
  });

  it('falls off as candela / (d² + soft²), to nothing at its range, with cos at a surface', () => {
    const f = toFire(em('hearth', [0, 0, 0], 1));
    expect(fireAt([f], [0, 0, 0])).toBeCloseTo(f.candela / f.soft ** 2); // finite at the flame
    const d = 1, w = (1 - (d / f.range) ** 4) ** 2;
    expect(fireAt([f], [d, 0, 0])).toBeCloseTo((f.candela * w) / (d * d + f.soft ** 2));
    expect(fireAt([f], [f.range + 0.01, 0, 0])).toBe(0);
    expect(fireAt([f], [1, 0, 0], [-1, 0, 0])).toBeCloseTo(fireAt([f], [1, 0, 0])); // facing the fire
    expect(fireAt([f], [1, 0, 0], [1, 0, 0])).toBe(0); // facing away
    expect(fireAt([f, f], [1, 0, 0])).toBeCloseTo(2 * fireAt([f], [1, 0, 0])); // fires add up
  });

  it('samples a room through its volume, never inside a flame', () => {
    const f = toFire(em('candle', [4, 1, 3], 1));
    const s = roomSamples(hall, [f]);
    expect(s.length).toBeGreaterThan(500);
    for (const p of s) expect(Math.hypot(p[0] - 4, p[1] - 1, p[2] - 3)).toBeGreaterThanOrEqual(NEAR - 1e-9);
    expect(s.some((p) => Math.hypot(p[0] - 4, p[1] - 1, p[2] - 3) < NEAR + 0.01)).toBe(true); // the ring round it
    expect(roomSurface(hall)).toBeCloseTo(2 * 48 + 28 * 4); // floor, ceiling, walls
    expect(fireStats(hall, []).mean).toBe(0);
  });

  it('leaves a lone torch alone and dims fires that pile up, together, under the caps', () => {
    const torch = [em('torch', [0.4, 2, 3], 3)];
    expect(roomFires(hall, torch)[0].candela).toBe(toFire(torch[0]).candela);
    expect(roomFires(hall, [])).toEqual([]);
    const pile = [em('hearth', [4, 0.7, 0.4], 3.5), ...Array.from({ length: 6 }, (_, i) => em('candle', [3 + i * 0.3, 1.5, 0.3], 3))];
    const out = roomFires(hall, pile), raw = pile.map((e) => toFire(e)).sort((a, b) => b.candela - a.candela);
    const k = out[0].candela / raw[0].candela;
    expect(k).toBeLessThan(1);
    out.forEach((f, i) => expect(f.candela / raw[i].candela).toBeCloseTo(k)); // one scale for the room
    const s = fireStats(hall, out);
    expect(s.peak).toBeLessThanOrEqual(FIRE_PEAK + 1e-6);
    expect(s.mean).toBeLessThanOrEqual(FIRE_MEAN + 1e-6);
    // more fires than the shader sums: the brightest are kept
    const many = Array.from({ length: MAX_FIRES + 3 }, (_, i) => em('candle', [0.5 + i * 0.4, 1, 3], i + 1));
    const kept = roomFires({ ...hall, poly: [[0, 0], [30, 0], [30, 6], [0, 6]] }, many);
    expect(kept).toHaveLength(MAX_FIRES);
    expect(Math.min(...kept.map((f) => f.position[0]))).toBeCloseTo(0.5 + 3 * 0.4);
  });
});

describe('fires by room', () => {
  it('puts a torch in its holder\'s room and anything else in the room that holds it', () => {
    const rooms = [
      { id: 'up', poly: [[0, 0], [4, 0], [4, 4], [0, 4]] as [number, number][], y0: 3, y1: 6 },
      { id: 'down', poly: [[0, 0], [4, 0], [4, 4], [0, 4]] as [number, number][], y0: 0, y1: 3 },
    ];
    const e = (x: number, y: number, z: number): LightEmitter => ({ kind: 'lantern', position: [x, y, z], colour: [1, 1, 1], intensity: 1, flicker: 0 });
    const torch = e(9, 9, 9), crate = e(2, 1, 2), above = e(2, 4, 2), nowhere = e(10, 1, 10);
    const m = firesByRoom(rooms, [torch, crate, above, nowhere], [{ room: 'down' }]);
    expect([...m.keys()]).toEqual(['down', 'up']);
    expect(m.get('down')).toEqual([torch, crate]);
    expect(m.get('up')).toEqual([above]);
    expect(firesByRoom(rooms, [crate]).get('down')).toEqual([crate]);
  });

  it('lights the whole castle at once: every room row by its owner, rooms without a row skipped, every flame linked', () => {
    const rooms = [
      { id: 'up', poly: [[0, 0], [4, 0], [4, 4], [0, 4]] as [number, number][], y0: 3, y1: 6 },
      { id: 'down', poly: [[0, 0], [4, 0], [4, 4], [0, 4]] as [number, number][], y0: 0, y1: 3 },
      { id: 'norow', poly: [[10, 0], [14, 0], [14, 4], [10, 4]] as [number, number][], y0: 0, y1: 3 },
    ];
    const e = (x: number, y: number, z: number): LightEmitter => ({ kind: 'torch', position: [x, y, z], colour: [1, 1, 1], intensity: 1, flicker: 0.5 });
    // a furniture fire owned by 'down' though it stands in 'up'; one by position; one in a room with no row
    const emitters = [e(2, 4, 2), e(2, 4.5, 3), e(12, 1, 2)];
    const rows: Record<string, number> = { up: 0, down: 1 };
    const { table, flames } = lightCastle(rooms, { emitters, flames: [{ kind: 'torch', base: [2, 4, 2], height: 0.3 }], owners: [{ room: 'down' }] }, (id) => (id in rows ? { row: rows[id], box: rooms.find((r) => r.id === id)! } : undefined), 4);
    expect(table.fires(1).map((f) => f.position)).toEqual([[2, 4, 2]]);
    expect(table.fires(0).map((f) => f.position)).toEqual([[2, 4.5, 3]]);
    expect(table.stats().fires).toBe(2);
    expect(flames).toHaveLength(1);
    expect(flames[0].seed).toBe(seedOf([2, 4, 2]));
  });
});

describe('fire table', () => {
  it('packs a room row, clears it and flickers in step with the flames', () => {
    const T = new FireTable(4), e = em('torch', [1, 2, 3], 3), f = toFire(e);
    T.set(2, [f]);
    const o = 2 * FIRE_W * 4;
    expect(T.data[o]).toBe(1);
    expect([...T.data.slice(o + 4, o + 8)]).toEqual([1, 2, 3, Math.fround(f.range)]);
    expect(T.data[o + 4 * FIRE_TEXELS + 3]).toBeCloseTo(f.soft ** 2);
    expect(T.data[o + 8]).toBeCloseTo(f.colour[0] * f.candela, 4);
    const v = T.version;
    T.set(9, [f]); T.set(-1, [f]); // not a row: ignored
    expect(T.version).toBe(v);
    T.update(2.5);
    const flame = linkFlames([{ kind: 'torch', base: [1, 1.8, 3], height: 0.3 }], [e]);
    expect(T.flick[2 * 4 * 0 + 2 * MAX_FIRES]).toBeCloseTo(flameBrightness(flame, 2.5, 1)[0], 6);
    expect(T.flick[2 * MAX_FIRES]).toBeCloseTo(flicker(PROFILES.torch, f.seed, 2.5, f.amount).k, 6);
    T.update(2.5, 0);
    expect(T.flick[2 * MAX_FIRES]).toBe(1);
    expect(T.stats()).toEqual({ rooms: 1, fires: 1, candela: Math.round(f.candela) });
    expect(T.fires(2)).toHaveLength(1);
    T.clear(2); T.clear(1);
    expect(T.data[o]).toBe(0);
    expect(T.fires(2)).toEqual([]);
    expect(T.stats().rooms).toBe(0);
  });
});

// Anders, 2026-11-08: "close to a chimneypiece with a fire, the whole frame is a flat, pale peach-orange".
// Every room of the castle, furnished (?furniture=1) and with the plain wall torches: the fires a room
// gets fit the shader (none dropped) and add up, anywhere in it, to no more than a torch's own hot spot,
// and on average to no more than the brightest torch-lit room.
describe('firelight over the whole castle', () => {
  const plan = planInterior();
  const box = (id: string) => plan.rooms.find((r) => r.id === id)!;
  it('keeps every room\'s firelight under the caps, furnished or torch-lit', () => {
    const furnish = createFurnisher(plan, { maxRooms: 1024 });
    const torches = wallTorches(plan, () => 'g');
    const sets: [string, string, LightEmitter[]][] = plan.rooms.map((r) => ['furnished', r.id, furnish(r.id).emitters]);
    const byRoom = new Map<string, LightEmitter[]>();
    torches.holders.forEach((h, i) => { if (!byRoom.has(h.room)) byRoom.set(h.room, []); byRoom.get(h.room)!.push(torches.emitters[i]); });
    for (const [id, es] of byRoom) sets.push(['torches', id, es]);
    const faults: string[] = [];
    let lit = 0, capped = 0, hot = 0;
    for (const [what, id, es] of sets) {
      if (!es.length) continue;
      lit++;
      if (es.length > MAX_FIRES) faults.push(`${what} ${id}: ${es.length} fires, the shader sums ${MAX_FIRES}`);
      const raw = fireStats(box(id), es.map((e) => toFire(e)));
      if (raw.peak > FIRE_PEAK || raw.mean > FIRE_MEAN) hot++;
      const fs = roomFires(box(id), es), s = fireStats(box(id), fs);
      if (fs[0].candela < toFire(es.reduce((a, b) => (toFire(b).candela > toFire(a).candela ? b : a))).candela) capped++;
      if (s.peak > FIRE_PEAK + 1e-6 || s.mean > FIRE_MEAN + 1e-6) faults.push(`${what} ${id}: peak ${s.peak.toFixed(0)} mean ${s.mean.toFixed(2)}`);
    }
    // the caves' lantern on its crate (main.ts adds it to the torches): in its cave room, under the caps
    const cf = caveFires(plan.caves!, 'g'), caves = firesByRoom(plan.rooms, cf.emitters);
    expect([...caves.values()].flat()).toEqual(cf.emitters);
    for (const [id, es] of caves) {
      expect(box(id).zone).toBe(CAVE_ZONE);
      sets.push(['cave', id, es]);
      const s = fireStats(box(id), roomFires(box(id), es));
      if (s.peak > FIRE_PEAK + 1e-6 || s.mean > FIRE_MEAN + 1e-6) faults.push(`cave ${id}: peak ${s.peak.toFixed(0)} mean ${s.mean.toFixed(2)}`);
    }
    expect(caves.size).toBeGreaterThan(0);
    expect(lit).toBeGreaterThan(150);
    expect(faults).toEqual([]);
    expect(capped).toBe(hot);
    // a torch-lit room is never dimmed: the approved look stays as it was
    for (const [id, es] of byRoom) expect(roomFires(box(id), es).map((f) => f.candela)).toEqual(es.map((e) => toFire(e).candela).sort((a, b) => b - a));
  }, 60_000);
});

// The caves have no torches: the player's lantern (player/lantern.ts) is the only light in most of them.
// It is the interior shader's carried light (InteriorLight.carried, the same falloff as fireAt): in every
// cave room, standing at its middle, the floor at your feet and the walls 1 m off are lit by it.
describe('the carried lantern in the caves', () => {
  const plan = planInterior();
  it('lights the floor and the walls round you in every cave room', () => {
    const caves = plan.rooms.filter((r) => r.zone === CAVE_ZONE);
    expect(caves.length).toBeGreaterThan(5);
    const faults: string[] = [];
    for (const r of caves) {
      const c = r.poly.reduce((a, p) => [a[0] + p[0] / r.poly.length, a[1] + p[1] / r.poly.length], [0, 0]);
      const eye: V3 = [c[0], r.y0 + 1.6, c[1]], f = toFire({ ...CARRIED_LANTERN, position: lanternAt(eye, [0, 0, -1]) });
      const floor = fireAt([f], [c[0], r.y0, c[1]], [0, 1, 0]);
      const walls = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).map(([dx, dz]) => fireAt([f], [c[0] + dx, r.y0 + 1.2, c[1] + dz], [-dx, 0, -dz]));
      // the readability floor is 0.145: the lantern must be well above it where you look
      if (floor < 0.5 || Math.min(...walls) < 0.5) faults.push(`${r.id}: floor ${floor.toFixed(2)}, walls ${walls.map((w) => w.toFixed(2)).join(' ')}`);
    }
    expect(faults).toEqual([]);
  });
});

// Anders, 2026-11-08 (live, ?furniture=1, the 'hall' bookmark): the hall's hooded hearth rendered near-white
// (202 sRGB beside 120 on the wall). Its light stood 0.4 m in front of the opening, out in the room, so the
// lintel, cheeks and hood a fire sits behind were lit head-on from a hand's breadth away. Over every
// fireplace in the castle: the stone of its own front (the faces looking into the room, above the hearth
// slab, in front of the fire) gets no more of its fire's light than 1.5 × the room's wall beside it.
describe('fireplaces in the castle', () => {
  const plan = planInterior(), make = variantPool();
  it('light the room, not their own fronts', () => {
    // dressed as the game dresses them (the windows' shutters and keep-outs move things)
    const windows = buildShell(plan, islandCastle().builder).embrasures.map((e) => e.face);
    const faults: string[] = [];
    let hearths = 0;
    for (const r of plan.rooms) {
      const d = dressRoom(r, plan, { make, windows });
      const all = mergePlaced(d.placed);
      if (!all.emitters.some((e) => e.kind === 'hearth')) continue;
      const fires = roomFires(r, all.emitters);
      for (const p of d.placed) {
        if (!p.prop.meta.emitters.some((e) => e.kind === 'hearth')) continue;
        hearths++;
        const [fx, fz] = yawXZ(0, 1, p.yaw), fwd: V3 = [fx, 0, fz];
        const world = (x: number, y: number, z: number): V3 => { const [wx, wz] = yawXZ(x, z, p.yaw); return [p.at[0] + wx, p.at[1] + y, p.at[2] + wz]; };
        const { min, max } = p.prop.bounds;
        // its own fire (the candles on a mantel light the mantel, as they should)
        const own = fires.filter((f) => f.kind === 'hearth' && Math.hypot(f.position[0] - p.at[0], f.position[2] - p.at[2]) < 2);
        // the wall it stands against, 0.8 m clear of it on either side, at eye height
        const wall = [-1, 1].map((sx) => fireAt(own, world(sx > 0 ? max[0] + 0.8 : min[0] - 0.8, 1.6, min[2] + 0.01), fwd));
        const ref = (wall[0] + wall[1]) / 2;
        const b = mergePlaced([p]).mesh.bins.stone, fireDepth = Math.max(...p.prop.mesh.flames.filter((f) => f.kind === 'hearth').map((f) => f.base[2])); // where its flames burn
        let worst = 0;
        for (let t = 0; t * 9 < b.pos.length; t++) {
          const c: V3 = [0, 1, 2].map((j) => (b.pos[t * 9 + j] + b.pos[t * 9 + 3 + j] + b.pos[t * 9 + 6 + j]) / 3) as V3;
          const n: V3 = [0, 1, 2].map((j) => b.nor[t * 9 + j]) as V3;
          // facing the room square on, in front of the fire (the fireback and soot behind it glow, as they
          // should, and so do the flanks of the shafts that turn toward it)
          const depth = (c[0] - p.at[0]) * fwd[0] + (c[2] - p.at[2]) * fwd[2];
          if (n[0] * fwd[0] + n[2] * fwd[2] < 0.9 || c[1] < p.at[1] + 0.3 || depth < fireDepth + 0.05) continue;
          worst = Math.max(worst, fireAt(own, c, n));
        }
        if (worst > 1.5 * ref) faults.push(`${r.id} ${p.prop.kind.name}: front ${worst.toFixed(2)} against the wall's ${ref.toFixed(2)}`);
      }
    }
    expect(hearths).toBeGreaterThan(10);
    expect(faults).toEqual([]);
  }, 180_000);
});
