# Progress

## 2026-11-05: stone material and light (branch `stone-material-light`)

Done
- Parallax occlusion mapping on rubble, ashlar and dressed stone (`src/render/materials.ts` `parallax()`): steep march on the height channel (data.r) with linear refinement, derivative-based tangent frame (the castle has no tangents), explicit-gradient sampling (legal in WGSL loops), fades out 18–42 m and at grazing angles; 18/12/10 max steps. Soft 5-tap self-shadow towards the sun, applied to the sun term only via `receivedShadowNode`. Joint depth 7.5 cm rubble, 5 cm ashlar, 2.5 cm dressed. `?pom=0` turns it off, `?pom=3` exaggerates it.
- Less "wallpaper": per-stone shade and hue that differ between repeats of the 4 m tile (texgen writes each stone's centre-u into the normal map's alpha), a 5–15 m tonal drift, broader rain washes instead of fine vertical scratches, cavity darkening in deep joints.
- Height maps (`src/render/texgen.ts`): raked joints, pillowed faces (`dome`), lighter lime mortar, hairline cracks as open segments instead of drawn loops; generation time unchanged within noise.
- Light: sky IBL desaturated to 30 % and warmed, neutral/grass-green hemisphere bounce, env 0.5; shaded stone is now grey-green, not cyan. Weathered lead roofs are pale matte grey.
- Shadows (`src/render/shadows.ts`): static 4k map over the island (re-rendered only when the sun moves) + a 2k map (2.3 cm texels) following the camera when below 70 m, cross-faded at its edge. Per frame this is one 2k shadow pass instead of the old 4k one.
- Post (`src/main.ts`): GTAO radius 1.1 m / scale 1.2, faded out beyond ~110–260 m (half-res AO is noise there); light grade after tone mapping (`?grade=0` to compare; `?aoview` shows AO).
- `__game.setPose(pos, target)` for close-up material captures.

Numbers: castle triangles unchanged (~114k). Extra cost is fragment work on stone within 42 m (≤ 23 extra data-texture taps per pixel) and the light grade pass; shadow passes per frame went from one 4096² to one 2048².

Known issues / next
- WebGPU path not run here (headless captures are WebGL2/SwiftShader); check the M4 once for shader compile and frame time.
- Rubble joints still read a little dark and cobbled in shade at 2–5 m; the geometric-stone LOD will take over there.
- Parallax works in UV space, so silhouettes and corners stay flat (by design; real stones cover the near range).

## 2026-11-05: exterior v1

Done
- Layout spec (`src/castle/spec.ts`) and plan tests (`tests/layout.test.ts`).
- Generated textures in workers (`src/render/texgen.ts`): rubble, ashlar, dressed stone, slate, planks, ground layers, water ripples.
- TSL materials (`src/render/materials.ts`) with per-stone variation and world-space weathering.
- Castle exterior generator (`src/castle/castle.ts`): wings with real window openings, buttresses with blind arches, corbel tables and machicolations, crenellations, hip roofs with dormers, chimneys, four towers, gatehouse with portcullis, east turret, courtyard stair tower and well.
- Island revetment (`src/castle/revetment.ts`) and the broken south bridge (`src/castle/bridge.ts`).
- Terrain with moat, banks, farmland, lake and mountains (`src/world/terrain.ts`); sky, sun, IBL, fog (`src/world/sky.ts`); reflective moat (`src/world/water.ts`); ez-tree trees + far forests (`src/world/trees.ts`).
- Orbit / fly / walk cameras with bookmarks; `window.__game` hooks; `npm run shots`.

Numbers (headless WebGL2 capture): castle ~115k triangles; near trees ~2.1M triangles (102 trees) + 11k far canopies; texture generation ~6 s on the container CPU across 3 workers.

Known issues / next
- Near trees are the triangle hog; add impostors (InstancedMesh2 + LOD) before adding more.
- No grass blades yet; island lawn is texture only.
- Far forests are low-poly blobs; swap for impostor cards.
- Stone texture could use a close-up detail normal for first-person distance.
- Courtyard is plain; no doors on the outer walls except the gate.
