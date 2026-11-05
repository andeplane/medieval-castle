// Castle layout spec, in metres. x = east, z = south, y = up. Moat water level y = 0.
// Deliberately irregular (docs/BRIEF.md): no right angles, every wing a different depth and height,
// every tower a different shape, two building phases (old rubble, newer ashlar).
import type { V2 } from '../core/math2d';

export const GROUND = 2.6; // island ground level next to the walls

/** 7 floors. Heights per floor, bottom up (undercroft, hall, five upper floors). */
export const FLOOR_HEIGHTS = [5.0, 6.0, 4.6, 4.5, 4.5, 4.4, 4.4];
export const floorBase = (f: number) => GROUND + FLOOR_HEIGHTS.slice(0, f).reduce((a, b) => a + b, 0);
export const ROOF_LEVEL = floorBase(FLOOR_HEIGHTS.length); // ~36 m

export type Phase = 'old' | 'new';
export type CornerKey = 'A' | 'B' | 'C' | 'D';

/** Outer corners of the quadrangle (NW, NE, SE, SW). Skewed so nothing is square. */
export const CORNERS: Record<CornerKey, V2> = { A: [-27, -18], B: [21, -24], C: [26, 15], D: [-21, 19] };

export interface WingSpec {
  id: 'N' | 'E' | 'S' | 'W';
  a: CornerKey; b: CornerKey;
  depth: number;   // outer wall to courtyard wall
  top: number;     // parapet walk level
  rooms: number;   // rooms per floor in this wing
  phase: Phase;
  roof: 'gable' | 'flat';
  buttresses: boolean; // Gravensteen-style buttresses with blind arches
  lean: number;        // outward lean of the outer wall over its height, metres
}

export const WINGS: WingSpec[] = [
  { id: 'N', a: 'A', b: 'B', depth: 11.0, top: 37.5, rooms: 6, phase: 'old', roof: 'gable', buttresses: true, lean: 0.18 },
  { id: 'E', a: 'B', b: 'C', depth: 10.0, top: 35.8, rooms: 5, phase: 'new', roof: 'gable', buttresses: false, lean: 0.06 },
  { id: 'S', a: 'C', b: 'D', depth: 9.5, top: 34.6, rooms: 4, phase: 'new', roof: 'flat', buttresses: false, lean: 0.04 },
  { id: 'W', a: 'D', b: 'A', depth: 10.5, top: 36.4, rooms: 5, phase: 'old', roof: 'flat', buttresses: true, lean: 0.22 },
];

export interface SquareTower { id: string; kind: 'square'; at: CornerKey; w: number; d: number; rot: number; top: number; phase: Phase; bartizans: boolean; capHouse: boolean; pull: number }
export interface RoundTower { id: string; kind: 'round'; at: CornerKey; r: number; top: number; phase: Phase; cone: number; stairTurret: boolean; pull: number }
export type TowerSpec = SquareTower | RoundTower;

/** pull = how far the tower centre is pulled from the outer corner toward the castle centre (0..1). */
export const TOWERS: TowerSpec[] = [
  { id: 'great', kind: 'square', at: 'A', w: 14, d: 13, rot: 0.07, top: 53, phase: 'old', bartizans: true, capHouse: true, pull: 0.1 },
  { id: 'ne', kind: 'round', at: 'B', r: 6.2, top: 46, phase: 'new', cone: 11, stairTurret: false, pull: 0.08 },
  { id: 'se', kind: 'round', at: 'C', r: 5.4, top: 42.5, phase: 'new', cone: 0, stairTurret: true, pull: 0.07 },
  { id: 'sw', kind: 'square', at: 'D', w: 9.5, d: 9, rot: -0.12, top: 41, phase: 'old', bartizans: false, capHouse: false, pull: 0.09 },
];

/** Gatehouse on the south wing: a projecting block between two drum towers. */
export const GATEHOUSE = { wing: 'S' as const, t: 0.46, width: 12.5, project: 6.0, top: 40.5 };

/** Square garderobe/chapel turret projecting from the east wing. */
export const EAST_TURRET = { wing: 'E' as const, t: 0.55, w: 5.2, project: 3.2, top: 39.2 };

/** Octagonal stair tower in the courtyard's north-east corner. */
export const STAIR_TOWER = { corner: 1, r: 2.9, top: 41.5, sides: 8 };

export const ISLAND = { rx: 56, rz: 50, northSquash: 10, seGrow: [9, 10] as V2, wobble: [0.06, 0.025] as V2 };
export const MOAT = { width: 19, widthNoise: 7, northExtra: 6, bed: -2.6 };
