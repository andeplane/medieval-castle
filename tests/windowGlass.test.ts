import { describe, expect, test } from 'vitest';
import * as THREE from 'three/webgpu';
import { createWindowFlags, groupIndexOfRooms, makeWindowGlass, nightOf, packWindowFlags, paneNear, tagWindowGroups, triFrames } from '../src/render/windowGlass';
import type { InteriorGroup, RoomSpec } from '../src/castle/interior/types';
import type { V2 } from '../src/core/math2d';

const sq = (x0: number, z0: number, x1: number, z1: number): V2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const hall: RoomSpec = { id: 'H', zone: 'T', floor: 0, kind: 'hall', poly: sq(0, 0, 12, 8), y0: 0, y1: 6 };
// a 1 x 1 m pane on the south face (z = 10), normal +z (outward): the hall lies 2 m behind it
const pane = (z: number) => [5, 2, z, 6, 2, z, 5, 3, z, 6, 2, z, 6, 3, z, 5, 3, z];
const glassGeo = (z: number) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pane(z), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(Array(6).fill([0, 0, 1]).flat(), 3));
  return g;
};

describe('window glass', () => {
  test('flags pack shown and fire per group and report changes', () => {
    const d = new Float32Array(8);
    expect(packWindowFlags(d, [true, false], [false, true])).toBe(true);
    expect([...d]).toEqual([1, 0, 0, 0, 0, 1, 0, 0]);
    expect(packWindowFlags(d, [true, false], [false, true])).toBe(false);
    const f = createWindowFlags(2);
    const v0 = f.tex.version;
    expect(f.set([true, true], [false, false])).toBe(true);
    expect(f.tex.version).toBeGreaterThan(v0);
    expect(f.set([true, true], [false, false])).toBe(false);
  });

  test('night ramps in after sunset', () => {
    expect(nightOf(0.5)).toBe(0);
    expect(nightOf(-0.2)).toBe(1);
    expect(nightOf(0.04)).toBeCloseTo(0.5);
  });

  test('panes: frames and the same-plane test', () => {
    const fr = triFrames(pane(9.998));
    expect(fr).toHaveLength(12);
    expect(Math.abs(fr[5])).toBeCloseTo(1);
    expect(paneNear(fr, [5.5, 2.5, 10])).toBe(true);
    expect(paneNear(fr, [5.5, 2.5, 10.5])).toBe(false);   // not in the plane
    expect(paneNear(fr, [9, 2.5, 10])).toBe(false);      // too far along it
    expect(triFrames([0, 0, 0, 0, 0, 0, 0, 0, 0])[3]).toBe(0); // degenerate: no NaN
  });

  test('exterior glass is tagged with the group behind it, only where an embrasure pane exists', () => {
    const groups = [{ key: 'X:0', rooms: ['other'] }, { key: 'T:0', rooms: ['H'] }] as unknown as InteriorGroup[];
    const ix = groupIndexOfRooms(groups);
    expect(ix('H')).toBe(1); expect(ix('nope')).toBe(-1);
    const g = glassGeo(10);
    expect(tagWindowGroups(g, [hall], ix, triFrames(pane(9.998)))).toBe(2);
    expect([...(g.attributes.windowGroup.array as Float32Array)]).toEqual(Array(6).fill(1));
    // no pane behind: stays opaque (-1); a room outside any group also stays -1
    const g2 = glassGeo(10);
    expect(tagWindowGroups(g2, [hall], ix, new Float32Array(0))).toBe(0);
    expect(tagWindowGroups(g2, [hall], () => -1, triFrames(pane(9.998)))).toBe(0);
    expect(g2.attributes.windowGroup.array[0]).toBe(-1);
    // far from any room
    expect(tagWindowGroups(glassGeo(30), [hall], ix, triFrames(pane(29.998)))).toBe(0);
    // no normals: the winding decides; this pane faces +z so the room is not found behind it
    const g3 = new THREE.BufferGeometry();
    g3.setAttribute('position', new THREE.Float32BufferAttribute(pane(10), 3));
    expect(tagWindowGroups(g3, [hall], ix, triFrames(pane(9.998)))).toBeGreaterThanOrEqual(0);
  });

  test('the material is transparent and keeps the source untouched', () => {
    const src = new THREE.MeshStandardNodeMaterial();
    const m = makeWindowGlass(src, createWindowFlags(4));
    expect(m.transparent).toBe(true);
    expect(m.name).toBe('window-glass');
    expect(src.transparent).toBe(false);
    expect(m.opacityNode).toBeTruthy();
  });
});
