// The physics side of a walking character, as narrow interfaces: the motor (motor.ts) drives any
// CharacterBody, so the player and future NPCs share one implementation, and tests pass fakes.
import type { V3 } from '../castle/interior/types';

export interface CharacterShape {
  radius: number; height: number;     // capsule radius and total height (m)
  skin: number;                       // KCC offset kept between the capsule and obstacles
  autostep: number; autostepMinWidth: number; snap: number; maxSlopeDeg: number;
}
export interface CharacterHit { normal: V3; point: V3; tag?: string }
export interface MoveResult { move: V3; grounded: boolean; hits: CharacterHit[] }

export interface CharacterBody {
  readonly id: number;
  /** Feet: bottom of the capsule (the skin gap is below it). */
  feet(): V3;
  /** Resolve a desired translation against the world; the body moves there on the next world step. */
  move(desired: V3): MoveResult;
  teleport(feet: V3): void;
  /** Change the capsule's total height, keeping the feet in place. */
  setHeight(height: number): void;
  /** Would a capsule of this height fit at the current feet (head room to stand up)? */
  fits(height: number): boolean;
  remove(): void;
}

export interface CharacterPhysics { createCharacter(shape: CharacterShape): CharacterBody }
