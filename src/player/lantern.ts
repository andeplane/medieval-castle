// The lantern the player carries in the caves (the castle's cellars and tunnels have wall torches; the
// caves have none). It is one more source of the shared light rig (src/light: LightRig.add as a mobile
// source), lit while the camera is in a cave room and out elsewhere, held low and to the right.
import type { LightEmitter, V3 } from '../light/types';
import type { SpaceId } from '../castle/interior/types';

// Falloff 1/d, not 1/d²: the lantern is a hand's breadth from the wall in the squeeze and 5 m from the
// cavern's far side. With the physical falloff the near wall is ~80x brighter than what lies ahead, so at
// any intensity that lights the way the wall beside the eye burns out to flat orange (and lowering the
// intensity only darkens the way: the near wall stays clipped). 1/d keeps that ratio near 9.
export const CARRIED_LANTERN: LightEmitter = { kind: 'lantern', position: [0, -1000, 0], colour: [1, 0.94, 0.84], intensity: 0.2, flicker: 0.2, decay: 1, range: 9 };

/** Where the lantern hangs for an eye looking along `fwd` (any length; only its plan direction counts). */
export function lanternAt(eye: V3, fwd: V3): V3 {
  const l = Math.hypot(fwd[0], fwd[2]) || 1, f = [fwd[0] / l, fwd[2] / l], right = [-f[1], f[0]];
  return [eye[0] + f[0] * 0.3 + right[0] * 0.22, eye[1] - 0.45, eye[2] + f[1] * 0.3 + right[1] * 0.22];
}

/** Lit while any of the camera's spaces is a cave room. */
export const lanternLit = (spaces: SpaceId[], caves: Set<SpaceId>) => spaces.some((s) => caves.has(s));
