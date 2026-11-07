// Shared contract for the interior work (plan + shell, stairs, doors, player + physics, interior light
// + visibility). Five parallel branches copy this file verbatim, so DO NOT edit it on a branch: put
// anything extra in your own module. Coordinates as everywhere: x east, y up, z south, metres.
import type * as THREE from 'three/webgpu';
import type { V2 } from '../../core/math2d';

export type V3 = [number, number, number];
export type Quat = [number, number, number, number];

/** 'outside' = the island ring, 'courtyard' = the inner ward. Everything else is a RoomSpec id. */
export type SpaceId = string;

export type RoomKind = 'undercroft' | 'hall' | 'chamber' | 'passage' | 'tower' | 'stair' | 'gate' | 'chapel' | 'wallwalk';

export interface RoomSpec {
  id: SpaceId;              // e.g. 'N2-3' = north wing, floor 2, room 3; 'great-4'; 'stairtower'
  zone: string;             // 'N' | 'E' | 'S' | 'W' | tower id ('great', 'ne', 'se', 'sw') | 'gate' | 'eturret' | 'stairtower'
  floor: number;            // 0..6 for wings; towers may go higher (7, 8 …)
  kind: RoomKind;
  poly: V2[];               // clear floor polygon (inside face of walls), clockwise seen from above like layout.ts
  y0: number;               // walking surface (top of floor)
  y1: number;               // underside of ceiling / beams
}

export interface DoorSpec {
  id: string;
  spaces: [SpaceId, SpaceId];  // the two sides
  centre: V3;                  // bottom centre of the opening, on the wall's mid plane, y = sill (walking surface)
  along: V2;                   // unit vector along the wall
  normal: V2;                  // unit, horizontal, pointing from spaces[0] into spaces[1]
  width: number;               // clear opening width
  height: number;              // clear height at the springing/top of a flat head
  wall: number;                // wall thickness at the door
  head: 'round' | 'pointed' | 'flat' | 'segmental';
  leaf: boolean;               // false = open archway, no door leaf
  hinge: 'left' | 'right';     // hinge side, seen from spaces[0] looking along +normal
  swingInto: 0 | 1;            // which space the leaf swings into first (where it rests shut at the start)
  rebate: number;              // depth from the face of the space it swings into to where the closed leaf sits
  /** Hinge side when the leaf swings into the other space, spaces[1 - swingInto]: the doorway is rebated on
   *  both faces and the leaf opens away from whoever opens it. Absent: it opens into spaces[swingInto] only. */
  otherHinge?: 'left' | 'right';
  kind: 'plank' | 'gate' | 'postern' | 'grille';
}

export interface StairSpec {
  id: string;
  kind: 'spiral' | 'straight';
  zone: string;
  spaces: SpaceId[];           // landings served, bottom to top (each landing opens into these spaces)
  // spiral: newel post at centre, steps wind between newel and drum radius
  centre?: V2; radius?: number; newel?: number; turn?: 1 | -1; // turn: +1 = counter-clockwise going up (seen from above)
  startAngle?: number;         // radians, angle of the first step (atan2(z, x) convention)
  // straight (mural stairs in the wall thickness or courtyard steps): from start to end
  start?: V3; end?: V3;
  width: number;
  landings: { y: number; angle?: number; at?: V3; door?: string }[]; // walking height at each landing, door id it serves
}

export interface InteriorPlan { rooms: RoomSpec[]; doors: DoorSpec[]; stairs: StairSpec[] }

/** Interior geometry is grouped so visibility can switch whole cells on and off. */
export interface InteriorGroup {
  key: string;                 // `${zone}:${floor}` for a wing or tower floor, 'stairs:<id>', 'doors'
  zone: string; floor: number; // floor = -1 for things that span floors (stairs)
  object: THREE.Object3D;      // meshes, one per material
  bounds: THREE.Box3;
  rooms: SpaceId[];            // rooms inside this group
}

/** The physics world the player owns; geometry modules feed it colliders. */
export interface PhysicsApi {
  /** Static triangle mesh collider (world space positions, indexed or not). */
  addStaticMesh(geometry: THREE.BufferGeometry, tag?: string): void;
  /** Kinematic box for moving parts (door leaves). Pose = centre + rotation. */
  addKinematicBox(half: V3, tag?: string): { setPose(p: V3, q: Quat): void; remove(): void };
  /** Closest hit along a ray, against everything solid. */
  raycast(from: V3, dir: V3, maxDist: number): { point: V3; normal: V3; dist: number; tag?: string } | null;
}

/** Something the player can use with E / click when looking at it within reach. */
export interface Interactable {
  id: string;
  label: () => string;                         // 'Open door' / 'Close door'
  hit: (ray: THREE.Ray, maxDist: number) => number | null; // distance along ray or null
  /** `by`: who uses it (where they stand and look), e.g. so a door opens away from them. */
  use: (by?: { pos: { x: number; y: number; z: number }; dir?: { x: number; y: number; z: number } }) => void;
}
