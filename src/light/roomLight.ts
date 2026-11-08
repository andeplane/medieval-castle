// Firelight by room. Every fire belongs to one room and lights that room's surfaces (the interior
// shader sums a room's fires per pixel, render/interiorShader.ts fireIrradiance), so what a room
// receives depends only on the room, never on where the camera is or how many other fires are near:
// a room the room graph draws is lit the same from across the castle as from inside it (LOD and
// culling change detail, never whether a light is on). Fires cast no shadows, so a fire lighting only
// its own room is also what stops a hearth shining through the wall into the next room.
// Pure: the shader reads `FireTable.data` (one row per room) and `FireTable.flick` (one flicker value
// per fire, written every frame).
import type { Flame, FlameKind, LightEmitter, RGB, V3 } from './types';
import { linkFlames, type FlameInstance } from './flames';
import { PROFILES, flicker, flickerAmount, seedOf } from './flicker';
import { kelvinToLinear, seenKelvin } from './blackbody';
import { WARM_INTERIOR } from './look';

/** Fires per room the shader sums (the busiest furnished room has 9). */
export const MAX_FIRES = 12;
/** RGBA texels per fire in a row: (position, range), (colour × candela, soft²). Texel 0 holds the count. */
export const FIRE_TEXELS = 2;
export const FIRE_W = 1 + MAX_FIRES * FIRE_TEXELS;
/**
 * Most firelight (candela / m², the shader's irradiance units) any point of a room may get from its
 * fires, NEAR or further from every flame: a wall torch's own hot spot (≈ 147 at 0.3 m). Several
 * fires close together (a hearth with candelabra on its mantel) must not add up past it.
 */
export const FIRE_PEAK = 150;
/**
 * Most firelight a room's walls, floor and ceiling may get on average from its fires (4π × candela
 * spread over the room's surface). The brightest torch-lit room (a tunnel, one torch in a narrow
 * vault) gives 4.4, a torch in the hall 0.9, an undercroft 1–2.4.
 */
export const FIRE_MEAN = 4.5;
/** Points this close to a flame are the flame's own fixture (wick, fire basket) and not capped. */
export const NEAR = 0.3;

export interface Fire { kind: FlameKind; position: V3; colour: RGB; candela: number; range: number; soft: number; seed: number; amount: number }

/** An emitter as the shader sees it: colour as the adapted eye sees the flame, candela, range and the soft near-field radius. */
export function toFire(e: LightEmitter, adapt = WARM_INTERIOR.grade.adapt): Fire {
  const p = PROFILES[e.kind], bb = kelvinToLinear(seenKelvin(p.kelvin, adapt));
  const c: RGB = [bb[0] * e.colour[0], bb[1] * e.colour[1], bb[2] * e.colour[2]], m = Math.max(...c);
  return {
    kind: e.kind, position: e.position, colour: [c[0] / m, c[1] / m, c[2] / m], candela: p.candela * e.intensity,
    range: p.range * Math.min(1.5, Math.sqrt(Math.max(0.25, e.intensity))), soft: p.soft, seed: e.seed ?? seedOf(e.position), amount: flickerAmount(e.flicker),
  };
}

/** The shader's falloff: candela / (d² + soft²), faded to 0 at `range` (three's window), × cos at a surface with normal n. */
export function fireAt(fires: Fire[], p: V3, n?: V3): number {
  let E = 0;
  for (const f of fires) {
    const dx = f.position[0] - p[0], dy = f.position[1] - p[1], dz = f.position[2] - p[2], d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2);
    const w = Math.max(0, 1 - (d / f.range) ** 4) ** 2;
    const cos = n ? Math.max(0, (n[0] * dx + n[1] * dy + n[2] * dz) / Math.max(d, 1e-6)) : 1;
    E += (f.candela * w * cos) / (d2 + f.soft * f.soft);
  }
  return E;
}

export interface RoomBox { poly: [number, number][]; y0: number; y1: number }

const inPoly = (poly: [number, number][], x: number, z: number) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};

/**
 * Fires by the room they light: an emitter with a holder (a wall torch) by its holder's room, any other
 * (the caves' lantern on its crate) by the room it stands in, the first whose floor plan and height hold
 * it; an emitter in no room lights nothing.
 */
export function firesByRoom(rooms: (RoomBox & { id: string })[], emitters: LightEmitter[], holders: ({ room: string } | undefined)[] = []): Map<string, LightEmitter[]> {
  const out = new Map<string, LightEmitter[]>();
  emitters.forEach((e, i) => {
    const [x, y, z] = e.position;
    const id = holders[i]?.room ?? rooms.find((r) => y >= r.y0 && y <= r.y1 && inPoly(r.poly, x, z))?.id;
    if (id === undefined) return;
    if (!out.has(id)) out.set(id, []);
    out.get(id)!.push(e);
  });
  return out;
}

/** Points through a room's volume (a `step` grid inside its outline, floor to ceiling) at least NEAR from every fire. */
export function roomSamples(r: RoomBox, fires: Fire[], step = 0.4): V3[] {
  const xs = r.poly.map((p) => p[0]), zs = r.poly.map((p) => p[1]), out: V3[] = [];
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const ny = Math.max(2, Math.ceil((r.y1 - r.y0) / step));
  for (let x = x0 + step / 2; x < x1; x += step) for (let z = z0 + step / 2; z < z1; z += step) {
    if (!inPoly(r.poly, x, z)) continue;
    for (let k = 0; k <= ny; k++) {
      const p: V3 = [x, r.y0 + 0.02 + ((r.y1 - r.y0 - 0.04) * k) / ny, z];
      if (fires.every((f) => Math.hypot(f.position[0] - p[0], f.position[1] - p[1], f.position[2] - p[2]) >= NEAR)) out.push(p);
    }
  }
  // the fires' own surroundings: a ring at NEAR round each (a candle on a mantel lights the stone under it)
  for (const f of fires) for (let a = 0; a < 8; a++) for (const dy of [-NEAR * 0.7, 0, NEAR * 0.7]) {
    const rr = Math.sqrt(NEAR * NEAR - dy * dy) + 1e-3;
    const p: V3 = [f.position[0] + Math.cos((a / 8) * Math.PI * 2) * rr, f.position[1] + dy, f.position[2] + Math.sin((a / 8) * Math.PI * 2) * rr];
    if (fires.every((g) => Math.hypot(g.position[0] - p[0], g.position[1] - p[1], g.position[2] - p[2]) >= NEAR)) out.push(p);
  }
  return out;
}

/** Floor, ceiling and walls of a room (m²). */
export function roomSurface(r: RoomBox): number {
  let a = 0, per = 0;
  for (let i = 0; i < r.poly.length; i++) {
    const p = r.poly[i], q = r.poly[(i + 1) % r.poly.length];
    a += p[0] * q[1] - q[0] * p[1]; per += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  return Math.abs(a) + per * (r.y1 - r.y0);
}

/** Peak firelight over the room's sample points and the average over its surfaces. */
export function fireStats(r: RoomBox, fires: Fire[]) {
  let peak = 0;
  for (const p of roomSamples(r, fires)) peak = Math.max(peak, fireAt(fires, p));
  return { peak, mean: (4 * Math.PI * fires.reduce((s, f) => s + f.candela, 0)) / Math.max(roomSurface(r), 1) };
}

/**
 * A room's fires, ready for the table: the brightest MAX_FIRES (no furnished room has more), dimmed
 * together so that no point of the room gets more than FIRE_PEAK and the room as a whole no more than
 * FIRE_MEAN. A room with one torch is untouched; a study with a hearth, a mantel pair of candelabra
 * and lamps comes down to the same kind of light as a torch-lit room, warm pools and dark corners.
 */
export function roomFires(r: RoomBox, emitters: LightEmitter[], adapt = WARM_INTERIOR.grade.adapt): Fire[] {
  const fires = emitters.map((e) => toFire(e, adapt)).sort((a, b) => b.candela - a.candela).slice(0, MAX_FIRES);
  if (!fires.length) return fires;
  const { peak, mean } = fireStats(r, fires);
  const k = Math.min(1, FIRE_PEAK / Math.max(peak, 1e-9), FIRE_MEAN / Math.max(mean, 1e-9));
  return k < 1 ? fires.map((f) => ({ ...f, candela: f.candela * k })) : fires;
}

/**
 * The per-room fire table the interior shader reads: row r = room r of the interior light (same index
 * as its daylight table). `set` a room's fires when they arrive, `clear` when they leave, `update`
 * every frame for the flicker.
 */
export class FireTable {
  readonly data: Float32Array;
  readonly flick: Float32Array;
  private rows: (Fire[] | null)[];
  /** bumped whenever `data` changes (texture upload) */
  version = 0;

  constructor(readonly maxRooms: number) {
    this.data = new Float32Array(maxRooms * FIRE_W * 4);
    this.flick = new Float32Array(maxRooms * MAX_FIRES).fill(1);
    this.rows = Array.from({ length: maxRooms }, () => null);
  }

  set(row: number, fires: Fire[]) {
    if (row < 0 || row >= this.maxRooms) return;
    const fs = fires.slice(0, MAX_FIRES), base = row * FIRE_W * 4;
    this.rows[row] = fs.length ? fs : null;
    this.data.fill(0, base, base + FIRE_W * 4);
    this.data[base] = fs.length;
    fs.forEach((f, k) => {
      const o = base + (1 + k * FIRE_TEXELS) * 4;
      this.data.set([f.position[0], f.position[1], f.position[2], f.range, f.colour[0] * f.candela, f.colour[1] * f.candela, f.colour[2] * f.candela, f.soft * f.soft], o);
    });
    this.version++;
  }

  clear(row: number) { if (this.rows[row]) this.set(row, []); }

  /** Fires of a row (for stats and tests). */
  fires(row: number): readonly Fire[] { return this.rows[row] ?? []; }

  /** Flicker of every fire at time t (the flame sprites use the same seeds, so a flame and its light gutter together). */
  update(t: number, motion = 1) {
    this.rows.forEach((fs, r) => {
      if (!fs) return;
      fs.forEach((f, k) => { this.flick[r * MAX_FIRES + k] = flicker(PROFILES[f.kind], f.seed, t, f.amount * motion).k; });
    });
  }

  stats() {
    let rooms = 0, fires = 0, candela = 0;
    for (const fs of this.rows) if (fs) { rooms++; fires += fs.length; candela += fs.reduce((a, f) => a + f.candela, 0); }
    return { rooms, fires, candela: Math.round(candela) };
  }
}

/** Fires for the whole castle: each emitter's owner room (a torch's holder, a furniture fire's room;
 * undefined: the room it stands in), and every flame. */
export interface CastleFireSources { emitters: LightEmitter[]; flames: Flame[]; owners: ({ room: string } | undefined)[] }

/**
 * The fire table and flame instances for every room at once, as main.ts makes them before the first
 * frame: each room's row holds all its fires (roomFires) and every flame is linked to its light. Built
 * once and never changed by where the camera is or what has streamed in (tests/world-views.test.ts walks it).
 * `room(id)`: the room's row and box; rooms it does not know light nothing.
 */
export function lightCastle(rooms: (RoomBox & { id: string })[], src: CastleFireSources, room: (id: string) => { row: number; box: RoomBox } | undefined, maxRooms: number): { table: FireTable; flames: FlameInstance[] } {
  const table = new FireTable(maxRooms);
  for (const [id, es] of firesByRoom(rooms, src.emitters, src.owners)) { const r = room(id); if (r) table.set(r.row, roomFires(r.box, es)); }
  return { table, flames: linkFlames(src.flames, src.emitters) };
}
