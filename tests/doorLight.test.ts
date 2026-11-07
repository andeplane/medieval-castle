// Door leaves are lit as the space each face looks into, over the whole castle (Anders, 2026-11-06: a
// courtyard door seen from its dim room glowed near-white, its room face drawn in the sunlit exterior
// wood). A batch has one material, so the faces of one leaf can sit in different batches: a face that
// looks into a room uses an interior material, one that looks into the courtyard or outside the
// outdoor material (sun, sky and environment). Built through buildCastleDoors, as main.ts builds them.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { planInterior } from '../src/castle/interior/plan';
import { buildCastleDoors, buildDoors, isOutdoor, BACK_SIDE_SWING, type DoorMats } from '../src/castle/interior/doors';
import { placeLeaves, leafMatrix, m4swing } from '../src/castle/interior/doorGeom';
import { playDoors } from '../src/player/setup';
import { GROUND } from '../src/castle/spec';
import type { DoorSpec } from '../src/castle/interior/types';
import { fakeBatch } from './helpers/doorFakes';

const set = (): DoorMats => ({ wood: new THREE.MeshBasicMaterial(), iron: new THREE.MeshBasicMaterial() });
const mats = { above: set(), under: set(), outdoor: set() };
const outdoorMat = new Set<THREE.Material>(Object.values(mats.outdoor));
const doors = playDoors([], planInterior().doors).active;
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

/**
 * Every drawn leaf triangle of every door at openness `initial`, with the space it must be lit as;
 * `flipped`: every two-way leaf first opened from its first swing space, so it hangs in its other seat.
 */
function faces(initial: number, flipped = false) {
  const fb = fakeBatch();
  const sys = buildCastleDoors(doors, mats, GROUND, undefined, { batch: fb.factory, initial, ajar: 0 });
  if (flipped) for (const d of doors) if (d.otherHinge) {
    const sg = d.swingInto === 1 ? 1 : -1, t = d.wall / 2 + 1;
    sys.setOpen(d.id, true, true, { pos: { x: d.centre[0] + d.normal[0] * sg * t, y: d.centre[1] + 1, z: d.centre[2] + d.normal[1] * sg * t } });
    if (initial === 0) sys.setOpen(d.id, false, true);
    expect(sys.seat(d.id)).toBe(1 - d.swingInto);
  }
  const leaves = doors.map((d) => ({ d, pl: placeLeaves(d, sys.seat(d.id)!)[0] }));
  const out: { d: DoorSpec; outdoorMat: boolean; looks: string | null }[] = [];
  const seen = new Set<string>();
  for (const b of fb.made) for (const [i, m] of b.mats) {
    if (b.hidden.has(i)) continue;
    // whose instance: a leaf (or its jamb iron) is posed about its pivot
    const own = leaves.find((l) => near([m[12], m[13], m[14]], l.pl.pivot));
    if (!own) continue; // the portcullis and its windlass
    seen.add(own.d.id);
    const shutPose = near(m, leafMatrix(own.pl, m4swing(0)));
    const g = b.geoms[b.inst[i]];
    for (let k = 0; k < g.nor.length; k += 9) {
      const n = [0, 1, 2].map((r) => m[r] * g.nor[k] + m[4 + r] * g.nor[k + 1] + m[8 + r] * g.nor[k + 2]);
      const through = n[0] * own.d.normal[0] + n[2] * own.d.normal[1];
      // shut (and the jamb iron): a face looks through the doorway into one side; edges are not judged.
      // Wide open, the whole leaf stands in its swing space, both faces.
      const looks = shutPose ? (through > 0.5 ? own.d.spaces[1] : through < -0.5 ? own.d.spaces[0] : null) : own.d.spaces[own.pl.seat];
      out.push({ d: own.d, outdoorMat: outdoorMat.has(b.material!), looks });
    }
  }
  return { out, seen, batches: fb.made.length };
}

describe('door leaves are lit as the space each face looks into', () => {
  for (const [label, initial, flipped] of [['shut', 0, false], ['wide open', 1, false], ['shut in the other seat', 0, true], ['wide open the other way', 1, true]] as const) it(`every leaf face of the castle, ${label}`, () => {
    const { out, seen } = faces(initial, flipped);
    expect(seen.size).toBe(doors.length); // every leaf door was found
    const wrong = new Map<string, number>();
    let judged = 0, outward = 0;
    for (const f of out) {
      if (!f.looks) continue;
      judged++;
      if (isOutdoor(f.looks)) outward++;
      if (f.outdoorMat !== isOutdoor(f.looks)) wrong.set(`${f.d.id} (${f.looks} face, ${f.outdoorMat ? 'outdoor' : 'interior'} material)`, (wrong.get(`${f.d.id} (${f.looks} face, ${f.outdoorMat ? 'outdoor' : 'interior'} material)`) ?? 0) + 1);
    }
    expect([...wrong.keys()]).toEqual([]);
    expect(judged).toBeGreaterThan(1000);
    if (initial === 0) expect(outward).toBeGreaterThan(0); // the courtyard doors' outer faces were judged
  });

  it('draws them in no more batches than before (room wood and iron above and below, outdoor wood and iron)', () => {
    expect(faces(0).batches).toBe(6);
  });

  it('moves a courtyard leaf\'s back faces to its swing space as it opens past BACK_SIDE_SWING, and hides them with its rooms', () => {
    const d = doors.find((x) => x.spaces.some(isOutdoor))!;
    const fb = fakeBatch();
    const sys = buildDoors([d], mats.above, undefined, { batch: fb.factory, outdoor: mats.outdoor, ajar: 0, initial: 0 });
    const out = fb.made.filter((b) => outdoorMat.has(b.material!)), room = fb.made.filter((b) => !outdoorMat.has(b.material!));
    expect(out.map((b) => b.name)).toEqual(['doors-wood-outdoor', 'doors-iron-outdoor']);
    const shown = (bs: typeof fb.made) => bs.reduce((n, b) => n + b.inst.length - b.hidden.size, 0);
    // shut: the courtyard faces (wood, strap iron and jamb iron) are outdoor, the room's back-face copies hidden
    expect(shown(out)).toBe(3);
    const roomShut = shown(room);
    sys.setOpen(d.id, true, true);
    expect(shown(out)).toBe(1); // only the jamb iron's courtyard side
    expect(shown(room)).toBe(roomShut + 2);
    sys.setVisible(d.id, false);
    expect(shown(out) + shown(room)).toBe(0);
    sys.setVisible(d.id, true);
    expect(shown(out)).toBe(1);
    expect(shown(room)).toBe(roomShut + 2);
    // shut again: back to the courtyard
    sys.setOpen(d.id, false, true);
    expect(shown(out)).toBe(3);
    expect(BACK_SIDE_SWING).toBeLessThan(Math.PI / 2);
  });
});
