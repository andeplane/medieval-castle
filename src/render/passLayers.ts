// Which version of an object each pass draws (2026-11-08: the frame was over the 1–3 M triangle budget,
// 3.3–3.5 M at the hero and gate views on Anders' Mac, a third of it the water's reflection drawing the
// whole scene again at full detail into a half-size, rippled target).
//
// Most objects are on layer 0 and every pass draws them. An object with a cheaper stand-in for the
// reflection is split in two: the full version on VIEW_LAYER (the view: AO pre-pass and scene; and the sun's
// shadow maps) and the stand-in on MIRROR_LAYER (the water's reflection only). Both cover the same ground,
// so this decides only how the reflection draws something, never whether: everything that can be seen in
// the water is still in it. Now: the terrain's near grid and far mesh at half resolution (world/terrain.ts
// mirrorIndex, polarMirrorIndex), and the grass, far grass and reeds with straight blades, the far grass
// with half of them (world/grass.ts).
// Layer 1 is the trees' shadow-only casters (world/trees.ts).

export const VIEW_LAYER = 2;
export const MIRROR_LAYER = 3;
/** Glow drawn by the view and the reflection but not into the AO pre-pass: the flame sprites (light/three.ts),
 * blended, writing no depth, so they gave the AO nothing but their normals smeared over what is behind. */
export const FX_LAYER = 4;

/** The view camera's layers (and every pass that draws what it sees: the AO pre-pass less FX_LAYER, the sun's shadow). */
export const VIEW_MASK = (1 << 0) | (1 << VIEW_LAYER) | (1 << FX_LAYER);
/** The water reflection's mirrored camera. */
export const MIRROR_MASK = (1 << 0) | (1 << MIRROR_LAYER) | (1 << FX_LAYER);

/** A layer no camera renders: meshes kept for whoever reads them by name (the terrain's whole near and far
 * grids, the near rocks' physics set). */
export const UNDRAWN_LAYER = 31;
