// The warm interior look: exposure, tone mapping, bloom and the grade that makes firelight read as
// inviting rather than orange. One owner of exposure (the interior-light controller) takes these as
// parameters; review pages apply them directly.
import { kelvinToLinear } from './blackbody';

export interface InteriorLook {
  exposure: number;
  /** Tone mapping operator: 'agx' rolls highlights to white, 'neutral' keeps the flame hue. */
  toneMapping: 'agx' | 'aces' | 'neutral';
  /** Bloom on the HDR flames: strength, radius, threshold (scene-linear). */
  bloom: { strength: number; radius: number; threshold: number };
  /** Cool, very dim fill so unlit corners read as deep blue-grey shadow, not flat black. */
  fill: { sky: number; ground: number; intensity: number };
  /** Grade after tone mapping: the eye's partial white balance to firelight, saturation, warm highlights, cool shadows, vignette. */
  grade: { adapt: number; saturation: number; contrast: number; warm: [number, number, number]; shadowTint: [number, number, number]; vignette: number };
  /** Air in the room: distance (m) for half the light to scatter, and its colour. */
  haze: { density: number; colour: number };
}

export const WARM_INTERIOR: InteriorLook = {
  exposure: 0.58,
  toneMapping: 'neutral',
  bloom: { strength: 0.32, radius: 0.55, threshold: 0.9 },
  fill: { sky: 0x3a4658, ground: 0x2a1c12, intensity: 0.07 },
  grade: { adapt: 0.18, saturation: 0.86, contrast: 1.06, warm: [1.04, 1.0, 0.93], shadowTint: [0.97, 1.0, 1.05], vignette: 0.28 },
  haze: { density: 0.035, colour: 0x1a120c },
};

/**
 * Eyes adapt to firelight: a partial white balance towards a black body at `kelvin`, scaled to keep
 * luminance. adapt 0 = none (everything as orange as the camera sees it), 1 = full (fire looks white).
 */
export function whiteBalance(kelvin: number, adapt: number): [number, number, number] {
  const c = kelvinToLinear(kelvin);
  const g = c.map((x) => Math.pow(1 / Math.max(0.2, x), adapt)); // no blue at all below ~1900 K
  const lum = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
  return [g[0] / lum, g[1] / lum, g[2] / lum];
}

/** Parse review-page overrides such as `?exposure=1.4&bloom=0.5` onto a look. */
export function lookFromParams(base: InteriorLook, get: (k: string) => string | null): InteriorLook {
  const num = (k: string, d: number) => { const v = get(k); const n = v === null ? NaN : Number(v); return Number.isFinite(n) ? n : d; };
  return {
    ...base,
    exposure: num('exposure', base.exposure),
    grade: { ...base.grade, adapt: num('adapt', base.grade.adapt) },
    bloom: { ...base.bloom, strength: num('bloom', base.bloom.strength) },
    fill: { ...base.fill, intensity: num('fill', base.fill.intensity) },
    haze: { ...base.haze, density: num('haze', base.haze.density) },
  };
}
