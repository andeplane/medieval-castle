// The lantern the player carries in the caves (the castle's cellars and tunnels have wall torches; the
// caves have none). It is the interior shader's one carried light (render/interiorLight.ts setCarried),
// lit while the camera is in a cave room and out elsewhere, held low and to the right, so its light rakes
// across the rock.
import type { LightEmitter, V3 } from '../light/types';
import type { SpaceId } from '../castle/interior/types';
import { toFire, type Fire } from '../light/roomLight';

export const CARRIED_LANTERN: LightEmitter = { kind: 'lantern', position: [0, -1000, 0], colour: [0.82, 0.97, 1.25], intensity: 0.45, flicker: 0.2 };
/**
 * The carried light's near-field radius and reach. The shader's falloff is candela / (d² + soft²). The lantern
 * is a hand's breadth from the wall in the squeeze and 5 m from the cavern's far side: with a flame-sized soft
 * (0.15 m) the near wall gets ~80× what lies ahead, so at any intensity that lights the way the wall beside
 * the eye burns out to flat orange, and lowering the intensity only darkens the way (the near wall stays
 * clipped). A metre of soft (the light of the whole glass, held at arm's length) keeps that ratio near 13.
 */
export const LANTERN_SOFT = 1.0, LANTERN_RANGE = 9;

/** The lantern at `at` as the shader's carried light. One seed: its flicker must not jump as it moves. */
export function lanternFire(at: V3): Fire {
  return { ...toFire({ ...CARRIED_LANTERN, position: at, seed: 7 }), soft: LANTERN_SOFT, range: LANTERN_RANGE };
}

/** Where the lantern hangs for an eye looking along `fwd` (any length; only its plan direction counts). */
export function lanternAt(eye: V3, fwd: V3): V3 {
  const l = Math.hypot(fwd[0], fwd[2]) || 1, f = [fwd[0] / l, fwd[2] / l], right = [-f[1], f[0]];
  return [eye[0] + f[0] * 0.3 + right[0] * 0.3, eye[1] - 0.55, eye[2] + f[1] * 0.3 + right[1] * 0.3];
}

/** Lit while any of the camera's spaces is a cave room. */
export const lanternLit = (spaces: SpaceId[], caves: Set<SpaceId>) => spaces.some((s) => caves.has(s));
