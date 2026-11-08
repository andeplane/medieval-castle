// Type-safe fakes for the light system's injected engine side.
import type { LightFactory, LightHandle } from '../../src/light/rig';
import type { RGB, V3 } from '../../src/light/types';

export interface FakeLight { castShadow: boolean; position: V3; colour: RGB; candela: number; range: number; decay: number; sets: number }
export interface FakeFactory extends LightFactory { lights: FakeLight[] }

export function fakeFactory(): FakeFactory {
  const lights: FakeLight[] = [];
  return {
    lights,
    create(castShadow): LightHandle {
      const l: FakeLight = { castShadow, position: [0, 0, 0], colour: [0, 0, 0], candela: 0, range: 0, decay: 2, sets: 0 };
      lights.push(l);
      return { set(p, c, cd, r, d = 2) { l.position = p; l.colour = c; l.candela = cd; l.range = r; l.decay = d; l.sets++; } };
    },
  };
}
