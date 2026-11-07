// Wall torches over the whole castle (Anders, 2026-11-06: "wtf is this flying flame?"): without furniture
// every torch flame stands on a holder built into its room, the holder's iron is fixed to the room's wall
// face (the shell's real triangles, not the plan polygon), and no torch sits in a door or window opening.
// Same path as main.ts: wallTorches on the plan → its holders into buildInterior.
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three/webgpu';
import { buildInterior } from '../src/castle/interior';
import { planInterior, type PlanX } from '../src/castle/interior/plan';
import { groupKey } from '../src/castle/interior/shell';
import { Builder } from '../src/castle/builder';
import { buildTorchHolder, torchParts } from '../src/castle/interior/torch';
import { wallTorches, type FireSources } from '../src/render/interiorFire';
import type { InteriorGroup } from '../src/castle/interior/types';
import { heightAt } from '../src/world/terrain';
import { mats, islandCastle } from './world';

type V3 = [number, number, number];
let P: PlanX, fire: FireSources, groups: InteriorGroup[];
const meshes = new Map<string, { walls: THREE.Mesh[]; iron: Float32Array | null; wood: Float32Array | null }>();

beforeAll(() => {
  P = planInterior();
  const room = new Map(P.rooms.map((r) => [r.id, r]));
  fire = wallTorches(P, (id) => groupKey(room.get(id)!));
  const { builder } = islandCastle();
  groups = buildInterior(mats(), builder, { heightAt, plan: P, torches: fire.holders }).groups;
  for (const g of groups) {
    const all = g.object.children as THREE.Mesh[], pos = (k: string) => (all.find((m) => m.name.endsWith(`-${k}`))?.geometry.attributes.position.array as Float32Array) ?? null;
    meshes.set(g.key, { walls: all.filter((m) => !/-(wood|iron|glass)$/.test(m.name)), iron: pos('iron'), wood: pos('wood') });
  }
}, 60000);

/** Distance along dir from o to the first wall/vault/floor triangle of the group within max, or null. */
function hit(key: string, o: V3, dir: V3, max: number): number | null {
  const rc = new THREE.Raycaster(new THREE.Vector3(...o), new THREE.Vector3(...dir).normalize(), 0, max);
  for (const m of meshes.get(key)!.walls) (m.material as THREE.Material).side = THREE.DoubleSide;
  const h = rc.intersectObjects(meshes.get(key)!.walls, false)[0];
  return h ? h.distance : null;
}
const hasVertex = (arr: Float32Array | null, p: V3) => { if (!arr) return false; for (let i = 0; i < arr.length; i += 3) if (Math.abs(arr[i] - p[0]) < 1e-4 && Math.abs(arr[i + 1] - p[1]) < 1e-4 && Math.abs(arr[i + 2] - p[2]) < 1e-4) return true; return false; };

describe('wall torches: every flame on a holder fixed to its wall', () => {
  it('the castle has wall torches, one holder per flame, each in its room\'s group', () => {
    expect(fire.flames.length).toBeGreaterThan(20);
    expect(fire.holders).toHaveLength(fire.flames.length);
    const room = new Map(P.rooms.map((r) => [r.id, r]));
    const bad: string[] = [];
    fire.holders.forEach((h, i) => {
      const key = groupKey(room.get(h.room)!), m = meshes.get(key)!, B = new Builder();
      buildTorchHolder(B, h);
      // the group's own bins hold this holder's wood and iron (built with the room, culled with it)
      const w = B.bins.wood.pos, ir = B.bins.iron.pos;
      if (!hasVertex(m.wood, [w[0], w[1], w[2]]) || !hasVertex(m.iron, [ir[0], ir[1], ir[2]])) bad.push(`${h.room}: holder not in group ${key}`);
      if (fire.group[i] !== key) bad.push(`${h.room}: flame in group ${fire.group[i]}, room in ${key}`);
    });
    expect(bad).toEqual([]);
  });

  it('each flame stands on its shaft: the holder\'s top is within 5 cm below the flame base', () => {
    const bad: string[] = [];
    fire.flames.forEach((f, i) => {
      const B = new Builder(); buildTorchHolder(B, fire.holders[i]);
      const w = B.bins.wood.pos;
      let top = -Infinity, at: V3 = [0, 0, 0];
      for (let k = 0; k < w.length; k += 3) if (w[k + 1] > top) { top = w[k + 1]; at = [w[k], w[k + 1], w[k + 2]]; }
      const dy = f.base[1] - top, dxz = Math.hypot(at[0] - f.base[0], at[2] - f.base[2]);
      if (!(dy >= -0.005 && dy <= 0.05 && dxz < 0.05)) bad.push(`${fire.holders[i].room}: top ${dy.toFixed(3)} below, ${dxz.toFixed(3)} off`);
    });
    expect(bad).toEqual([]);
  });

  it('the bracket\'s plate lies on the room\'s wall face, and the wall is behind the flame (no opening)', () => {
    const room = new Map(P.rooms.map((r) => [r.id, r]));
    const bad: string[] = [];
    for (const h of fire.holders) {
      const key = groupKey(room.get(h.room)!), p = torchParts(h), back: V3 = [-h.n[0], 0, -h.n[1]], s: V3 = [-h.n[1], 0, h.n[0]];
      // the plate's back corners and centre, probed from 5 cm in front: the wall is 5 cm away (± 3 cm)
      for (const [u, v] of [[0, 0], [-0.03, -0.09], [0.03, -0.09], [-0.03, 0.09], [0.03, 0.09]]) {
        const q: V3 = [p.plate[0] + s[0] * u + h.n[0] * 0.05, p.plate[1] + v, p.plate[2] + s[2] * u + h.n[1] * 0.05];
        const d = hit(key, q, back, 0.5);
        if (d === null || Math.abs(d - 0.05) > 0.03) { bad.push(`${h.room}: plate (${u}, ${v}) wall at ${d?.toFixed(3) ?? 'none'}`); break; }
      }
      // the wall stands right behind the flame, its shaft top and its foot (not a window or door behind them)
      for (const [name, q, out] of [['flame', h.base, 0.22], ['top', p.top, 0.22], ['foot', p.foot, 0.07]] as [string, V3, number][]) {
        const d = hit(key, q, back, 1.5);
        if (d === null || Math.abs(d - out) > 0.03) bad.push(`${h.room}: ${name} wall at ${d?.toFixed(3) ?? 'none'} (want ${out})`);
      }
      // nothing of the room (vault, ceiling) over the flame, nor under the foot within 1 m (floor)
      const up = hit(key, h.base, [0, 1, 0], 0.4);
      if (up !== null) bad.push(`${h.room}: ceiling ${up.toFixed(2)} m over the flame`);
      const down = hit(key, p.foot, [0, -1, 0], 1.0);
      if (down !== null) bad.push(`${h.room}: floor only ${down.toFixed(2)} m under the shaft`);
    }
    expect(bad).toEqual([]);
  });

  it('no torch is in or beside a doorway of its room', () => {
    const bad: string[] = [];
    for (const h of fire.holders) for (const d of P.doors) {
      if (!d.spaces.includes(h.room)) continue;
      const p = torchParts(h);
      for (const q of [h.base, p.plate, p.foot]) {
        const dx = q[0] - d.centre[0], dz = q[2] - d.centre[2], u = dx * d.along[0] + dz * d.along[1], t = dx * d.normal[0] + dz * d.normal[1];
        if (Math.abs(u) < d.width / 2 + 0.3 && Math.abs(t) < d.wall / 2 + 0.5 && q[1] > d.centre[1] - 0.1 && q[1] < d.centre[1] + d.height + 1) bad.push(`${h.room}: torch at ${d.id}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
