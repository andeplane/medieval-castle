// `?test=room`: a stand-in for the interior shell so the light and visibility work can be judged before
// the shell lands. A 12 × 8 × 6 m hall with 2 m walls, three splayed south windows and one west window,
// a round-headed door from the outside, and a door through a 1.4 m cross wall into a 6 × 8 m chamber
// (one south, one east window). Timber floor, boarded ceiling on beams. Built in the island's middle
// (no castle in this mode) with the same Builder bins and the same InteriorGroup / InteriorPlan shapes
// the shell returns.
import * as THREE from 'three/webgpu';
import { Builder, type Frame, type MatKey, TILE, at, wallFrame, rect, roundArch } from '../castle/builder';
import { GROUND } from '../castle/spec';
import { castleCentre } from '../castle/layout';
import type { V2 } from '../core/math2d';
import type { Materials } from '../render/materials';
import type { InteriorMaterials } from '../render/interiorLight';
import type { WindowInput } from '../render/interiorMath';
import type { InteriorGroup, InteriorPlan, RoomSpec, DoorSpec, V3 } from '../castle/interior/types';
import type { View } from '../camera/controls';

const C = castleCentre();
const OX = C[0] - 9.7, OZ = C[1] - 4;
const Y0 = GROUND + 0.45;          // floor top
const YC = Y0 + 6;                 // underside of the ceiling boards
const YB = YC - 0.42;              // underside of the beams (room y1)
const YR = YC + 0.8;               // roof
const P = (x: number, z: number): V2 => [OX + x, OZ + z];
const W3 = (x: number, y: number, z: number): V3 => [OX + x, y, OZ + z];

interface Win { side: 'S' | 'W' | 'E'; at: number; w: number; h: number; yc: number; wi: number; hi: number; yi: number }
const WALL = 2, GLASS_OUT = 0.4;
const WINS: Win[] = [
  ...[2.5, 6, 9.5].map((x) => ({ side: 'S' as const, at: x, w: 0.8, h: 2.0, yc: Y0 + 3.0, wi: 2.0, hi: 3.0, yi: -0.25 })),
  { side: 'W', at: 4, w: 0.8, h: 2.0, yc: Y0 + 3.0, wi: 2.0, hi: 3.0, yi: -0.25 },
  { side: 'S', at: 16.4, w: 0.6, h: 1.4, yc: Y0 + 2.6, wi: 1.5, hi: 2.2, yi: -0.2 },
  { side: 'E', at: 4, w: 0.6, h: 1.4, yc: Y0 + 2.6, wi: 1.5, hi: 2.2, yi: -0.2 },
];
// inner faces of the outer walls (local coords), and of the cross wall
const IN = { x0: 0, x1: 19.4, z0: 0, z1: 8, hallX: 12, chX: 13.4 };
const OUT = { x0: -2, x1: 21.4, z0: -2, z1: 10 };
const DOOR_OUT = { x: 3, w: 1.4, h: 2.6 };    // north wall
const DOOR_IN = { z: 5, w: 1.2, h: 2.2 };      // cross wall

/** Distance along a wall frame from its origin to world point (x, z). */
const sOf = (f: Frame, p: V2) => (p[0] - f.o[0]) * f.r[0] + (p[1] - f.o[2]) * f.r[2];

/** Splayed embrasure from the room-side opening (depth 0 on frame f, facing the room) to the glass at depth -D. */
function splay(B: Builder, f: Frame, s: number, w: Win, D: number, mat: MatKey) {
  const T = TILE[mat], bin = B.bins[mat];
  const yIn = w.yc + w.yi;
  const inner: [number, number][] = [[s - w.wi / 2, yIn - w.hi / 2], [s + w.wi / 2, yIn - w.hi / 2], [s + w.wi / 2, yIn + w.hi / 2], [s - w.wi / 2, yIn + w.hi / 2]];
  const glass: [number, number][] = [[s - w.w / 2, w.yc - w.h / 2], [s + w.w / 2, w.yc - w.h / 2], [s + w.w / 2, w.yc + w.h / 2], [s - w.w / 2, w.yc + w.h / 2]];
  const axis = at(f, s, (yIn + w.yc) / 2, -D / 2);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const A = at(f, inner[i][0], inner[i][1], 0), Bq = at(f, inner[j][0], inner[j][1], 0), Cq = at(f, glass[j][0], glass[j][1], -D), Dq = at(f, glass[i][0], glass[i][1], -D);
    const e1 = new THREE.Vector3(...Bq).sub(new THREE.Vector3(...A)).normalize();
    const nn = new THREE.Vector3().crossVectors(e1, new THREE.Vector3(...Dq).sub(new THREE.Vector3(...A))).normalize();
    const mid = new THREE.Vector3(...A).add(new THREE.Vector3(...Cq)).multiplyScalar(0.5);
    if (nn.dot(new THREE.Vector3(...axis).sub(mid)) < 0) nn.negate();
    const e2 = new THREE.Vector3().crossVectors(nn, e1);
    const uvq = (p: V3): [number, number] => [(p[0] * e1.x + p[1] * e1.y + p[2] * e1.z) / T, (p[0] * e2.x + p[1] * e2.y + p[2] * e2.z) / T];
    const n: V3 = [nn.x, nn.y, nn.z];
    bin.tri(A, Bq, Cq, n, uvq(A), uvq(Bq), uvq(Cq));
    bin.tri(A, Cq, Dq, n, uvq(A), uvq(Cq), uvq(Dq));
  }
  B.planar('glass', f, glass, -D);
}

export interface RoomTest { exterior: THREE.Group; groups: InteriorGroup[]; plan: InteriorPlan; windows: WindowInput[]; views: View[] }

export function buildRoomTest(M: Materials, IM: InteriorMaterials): RoomTest {
  const ext = new Builder();
  const extMats: Record<MatKey, THREE.Material> = { old: M.old, new: M.new, trim: M.trim, slate: M.slate, lead: M.lead, wood: M.wood, iron: M.iron, void: M.void, glass: M.glass };
  const intMats: Record<MatKey, THREE.Material> = { ...extMats, ...IM };
  const windows: WindowInput[] = [];

  // window placements on each outer face: side → (frame of the outer face, frame of the inner face)
  const faces = {
    S: { outer: wallFrame(P(OUT.x0, OUT.z1), P(OUT.x1, OUT.z1), [0, 1]), inner: (x0: number, x1: number) => wallFrame(P(x0, IN.z1), P(x1, IN.z1), [0, -1]) },
    N: { outer: wallFrame(P(OUT.x0, OUT.z0), P(OUT.x1, OUT.z0), [0, -1]) },
    W: { outer: wallFrame(P(OUT.x0, OUT.z0), P(OUT.x0, OUT.z1), [-1, 0]), inner: wallFrame(P(IN.x0, IN.z0), P(IN.x0, IN.z1), [1, 0]) },
    E: { outer: wallFrame(P(OUT.x1, OUT.z0), P(OUT.x1, OUT.z1), [1, 0]), inner: wallFrame(P(IN.x1, IN.z0), P(IN.x1, IN.z1), [-1, 0]) },
  };
  const worldOf = (w: Win): V2 => (w.side === 'S' ? P(w.at, OUT.z1) : w.side === 'W' ? P(OUT.x0, w.at) : P(OUT.x1, w.at));
  const outerHoles: Record<string, V2[][]> = { S: [], N: [], W: [], E: [] };
  for (const w of WINS) {
    const f = faces[w.side].outer, s = sOf(f, worldOf(w));
    outerHoles[w.side].push(rect(s, w.yc - w.h / 2, w.w, w.h));
    const g = at(f, s, w.yc, -GLASS_OUT);
    windows.push({ p: g, n: f.n, w: w.w, h: w.h, depth: WALL - GLASS_OUT, wi: w.wi, hi: w.hi, yi: w.yi, outer: GLASS_OUT });
  }
  // exterior shell: faces with straight outer reveals (the glass sits in the interior group)
  const yBase = GROUND - 0.8;
  for (const k of ['S', 'N', 'W', 'E'] as const) {
    const f = faces[k].outer, L = k === 'S' || k === 'N' ? OUT.x1 - OUT.x0 : OUT.z1 - OUT.z0;
    const ops = outerHoles[k].map((pts) => ({ pts, depth: GLASS_OUT, fill: 'none' as const, reveal: 'trim' as MatKey }));
    if (k === 'N') ops.push({ pts: roundArch(sOf(f, P(DOOR_OUT.x, OUT.z0)), Y0, DOOR_OUT.w, DOOR_OUT.h), depth: WALL, fill: 'none', reveal: 'trim' });
    ext.planar('old', f, [[0, yBase], [L, yBase], [L, YR], [0, YR]], 0, ops.map((o) => o.pts));
    for (const o of ops) ext.openingInsides(f, o);
  }
  const outerPoly: V2[] = [P(OUT.x0, OUT.z0), P(OUT.x1, OUT.z0), P(OUT.x1, OUT.z1), P(OUT.x0, OUT.z1)];
  const parIn: V2[] = [P(OUT.x0 + 0.6, OUT.z0 + 0.6), P(OUT.x1 - 0.6, OUT.z0 + 0.6), P(OUT.x1 - 0.6, OUT.z1 - 0.6), P(OUT.x0 + 0.6, OUT.z1 - 0.6)];
  ext.ringPrism('trim', outerPoly, parIn, YR, YR + 1.1, false);
  ext.cap('lead', parIn, YR, true);
  const exterior = ext.build(extMats);
  exterior.name = 'castle';

  // interior: zone T = the hall, zone U = the chamber
  const groups: InteriorGroup[] = [];
  const mkGroup = (key: string, zone: string, B: Builder, rooms: string[]) => {
    const obj = B.build(intMats);
    obj.name = `interior-${key}`;
    obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.name = o.name.replace('castle-', `interior-${key}-`); });
    groups.push({ key, zone, floor: 0, object: obj, bounds: new THREE.Box3().setFromObject(obj), rooms });
  };
  const ceiling = (B: Builder, x0: number, x1: number) => {
    const poly: V2[] = [P(x0, IN.z0), P(x1, IN.z0), P(x1, IN.z1), P(x0, IN.z1)];
    B.cap('wood', poly, Y0, true);
    B.cap('wood', poly, YC, false);
    for (let x = x0 + 1.4; x < x1 - 0.6; x += 2.05) B.box('wood', [OX + x, YC - 0.21, OZ + (IN.z0 + IN.z1) / 2], [IN.z1 - IN.z0, 0.42, 0.3], [0, 1], { top: false, bottom: true });
  };
  const winsIn = (side: 'S' | 'W' | 'E', x0: number, x1: number) => WINS.filter((w) => w.side === side && (side !== 'S' || (w.at > x0 && w.at < x1)));
  const innerWall = (B: Builder, f: Frame, L: number, side: 'S' | 'W' | 'E' | null, x0: number, x1: number, extra: V2[][] = []) => {
    const ws = side ? winsIn(side, x0, x1) : [];
    const holes = ws.map((w) => { const s = sOf(f, side === 'S' ? P(w.at, IN.z1) : side === 'W' ? P(IN.x0, w.at) : P(IN.x1, w.at)); return rect(s, w.yc + w.yi - w.hi / 2, w.wi, w.hi); });
    B.planar('old', f, [[0, Y0], [L, Y0], [L, YC], [0, YC]], 0, [...holes, ...extra]);
    for (const w of ws) splay(B, f, sOf(f, side === 'S' ? P(w.at, IN.z1) : side === 'W' ? P(IN.x0, w.at) : P(IN.x1, w.at)), w, WALL - GLASS_OUT, 'trim');
  };
  {
    const B = new Builder();
    const x0 = IN.x0, x1 = IN.hallX;
    innerWall(B, faces.S.inner(x0, x1), x1 - x0, 'S', x0, x1);
    const fW = faces.W.inner; innerWall(B, fW, IN.z1 - IN.z0, 'W', x0, x1);
    const fN = wallFrame(P(x0, IN.z0), P(x1, IN.z0), [0, 1]);
    innerWall(B, fN, x1 - x0, null, x0, x1, [roundArch(sOf(fN, P(DOOR_OUT.x, IN.z0)), Y0, DOOR_OUT.w, DOOR_OUT.h)]);
    // cross wall, hall side, with the door passage reveals through it
    B.wall('old', P(x1, IN.z0), P(x1, IN.z1), [-1, 0], Y0, YC, [{ pts: roundArch(DOOR_IN.z, Y0, DOOR_IN.w, DOOR_IN.h), depth: IN.chX - IN.hallX, fill: 'none', reveal: 'trim' }]);
    ceiling(B, x0, x1);
    B.cap('trim', [P(DOOR_OUT.x - DOOR_OUT.w / 2, OUT.z0), P(DOOR_OUT.x + DOOR_OUT.w / 2, OUT.z0), P(DOOR_OUT.x + DOOR_OUT.w / 2, IN.z0), P(DOOR_OUT.x - DOOR_OUT.w / 2, IN.z0)], Y0, true);
    B.cap('trim', [P(IN.hallX, DOOR_IN.z - DOOR_IN.w / 2), P(IN.chX, DOOR_IN.z - DOOR_IN.w / 2), P(IN.chX, DOOR_IN.z + DOOR_IN.w / 2), P(IN.hallX, DOOR_IN.z + DOOR_IN.w / 2)], Y0, true);
    // the step down outside the door
    B.box('trim', [OX + DOOR_OUT.x, (GROUND - 0.3 + Y0) / 2, OZ + OUT.z0 - 0.35], [DOOR_OUT.w + 0.4, Y0 - GROUND + 0.3, 0.7], [1, 0]);
    mkGroup('T:0', 'T', B, ['T0-1']);
  }
  {
    const B = new Builder();
    const x0 = IN.chX, x1 = IN.x1;
    innerWall(B, faces.S.inner(x0, x1), x1 - x0, 'S', x0, x1);
    innerWall(B, faces.E.inner, IN.z1 - IN.z0, 'E', x0, x1);
    innerWall(B, wallFrame(P(x0, IN.z0), P(x1, IN.z0), [0, 1]), x1 - x0, null, x0, x1);
    const fX = wallFrame(P(x0, IN.z0), P(x0, IN.z1), [1, 0]);
    innerWall(B, fX, IN.z1 - IN.z0, null, x0, x1, [roundArch(sOf(fX, P(x0, DOOR_IN.z)), Y0, DOOR_IN.w, DOOR_IN.h)]);
    ceiling(B, x0, x1);
    mkGroup('U:0', 'U', B, ['U0-1']);
  }

  const room = (id: string, zone: string, kind: RoomSpec['kind'], x0: number, x1: number): RoomSpec =>
    ({ id, zone, floor: 0, kind, poly: [P(x0, IN.z0), P(x1, IN.z0), P(x1, IN.z1), P(x0, IN.z1)], y0: Y0, y1: YB });
  const door = (d: Partial<DoorSpec> & Pick<DoorSpec, 'id' | 'spaces' | 'centre' | 'along' | 'normal' | 'width' | 'height' | 'wall'>): DoorSpec =>
    ({ head: 'round', leaf: false, hinge: 'left', swingInto: 1, rebate: 0.15, kind: 'plank', ...d });
  const plan: InteriorPlan = {
    rooms: [room('T0-1', 'T', 'hall', IN.x0, IN.hallX), room('U0-1', 'U', 'chamber', IN.chX, IN.x1)],
    doors: [
      door({ id: 'test-out', spaces: ['outside', 'T0-1'], centre: W3(DOOR_OUT.x, Y0, (OUT.z0 + IN.z0) / 2), along: [1, 0], normal: [0, 1], width: DOOR_OUT.w, height: DOOR_OUT.h, wall: WALL }),
      door({ id: 'test-cross', spaces: ['T0-1', 'U0-1'], centre: W3((IN.hallX + IN.chX) / 2, Y0, DOOR_IN.z), along: [0, 1], normal: [1, 0], width: DOOR_IN.w, height: DOOR_IN.h, wall: IN.chX - IN.hallX }),
    ],
    stairs: [],
  };

  const eye = Y0 + 1.7, ground = GROUND + 0.1;
  const views: View[] = [
    { name: 'room-hall', label: 'Hall', mode: 'fly', pos: W3(11.2, eye, 0.8), target: W3(3.5, Y0 + 2.2, 8) },
    { name: 'room-pool', label: 'Sun pools', mode: 'fly', pos: W3(2.4, Y0 + 3.2, 1.2), target: W3(7.5, Y0, 5.2) },
    { name: 'room-window', label: 'Embrasure', mode: 'fly', pos: W3(5.0, eye, 4.4), target: W3(6, Y0 + 2.9, 9.6) },
    { name: 'room-chamber', label: 'Chamber door', mode: 'fly', pos: W3(5.5, eye, 3.5), target: W3(16.5, Y0 + 1.4, 5.2) },
    { name: 'room-dark', label: 'Chamber', mode: 'fly', pos: W3(18.6, eye, 0.7), target: W3(13.4, Y0 + 2.2, 6.5) },
    { name: 'room-ceiling', label: 'Beams', mode: 'fly', pos: W3(10.5, Y0 + 1.6, 6.8), target: W3(3, YC, 1.5) },
    { name: 'room-out', label: 'Test exterior', mode: 'fly', pos: W3(-7, ground + 1.7, -16), target: W3(5, Y0 + 3, 2) },
    { name: 'room-south', label: 'Test south', mode: 'fly', pos: W3(20, ground + 6, 26), target: W3(8, Y0 + 4, 8) },
  ];
  return { exterior, groups, plan, windows, views };
}
