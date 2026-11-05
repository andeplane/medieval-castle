// Colour of fire. Flames and the light they cast are close to a black body at 1700–2200 K; this is
// the Tanner Helland fit (sRGB, max channel = 1), converted to linear for lighting.

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** sRGB colour (0..1) of a black body at `kelvin` (1000–12000 K). */
export function kelvinToSrgb(kelvin: number): [number, number, number] {
  const t = Math.min(12000, Math.max(1000, kelvin)) / 100;
  const r = t <= 66 ? 1 : clamp01((329.698727446 * Math.pow(t - 60, -0.1332047592)) / 255);
  const g = t <= 66 ? clamp01((99.4708025861 * Math.log(t) - 161.1195681661) / 255) : clamp01((288.1221695283 * Math.pow(t - 60, -0.0755148492)) / 255);
  const b = t >= 66 ? 1 : t <= 19 ? 0 : clamp01((138.5177312231 * Math.log(t - 10) - 305.0447927307) / 255);
  return [r, g, b];
}

/** Linear-light colour of a black body, normalised so the brightest channel is 1. */
export function kelvinToLinear(kelvin: number): [number, number, number] {
  const [r, g, b] = kelvinToSrgb(kelvin).map(toLinear);
  const m = Math.max(r, g, b);
  return [r / m, g / m, b / m];
}
