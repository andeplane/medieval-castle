# Progress

## 2026-11-05: physics player (branch `player-physics`)

Done
- Rapier 0.21 (compat build) world, `src/physics/world.ts`: fixed 60 Hz accumulator with render interpolation, static trimeshes from render meshes (`addObject`, glass skipped), an open terrain trimesh from the near-terrain grid with holes under building footprints, interior `terrainHoles` and the test course (so cellars at −2 m and the moat tunnel at −6.5 m are reachable from below), an invisible island boundary that only exists from `heightAt − 1` upward, kinematic boxes and raycasts per the interior contract (`src/castle/interior/types.ts`, verbatim). Several characters per world; collision groups keep rays off characters and the boundary.
- `CharacterMotor` (`src/character/motor.ts`): shared by the player and future NPCs. Takes an intent (wish direction, jump, crouch) and a `CharacterBody`; does acceleration and friction, limited air control, coyote time and jump buffer, crouch that will not stand up under low ceilings, autostep 0.3 m, snap-to-ground 0.4 m, 50° slope limit, wall sliding, landing and footfall events.
- `PlayerController` (`src/player/controller.ts`): maps keys to intent and drives the camera: eye 1.62 m (0.98 crouched), head bob and cadence that differ for walk and run, step smoothing, landing dip, FOV kick when running. Mouse look reuses `MouseLook` from main. Procedural footsteps by surface (stone, wood, grass, dirt; M toggles).
- Everything is injected (physics, input, clock, camera view, audio); `src/player/setup.ts` wires it for `main.ts` and the island test alike.
- Walk mode is now the physics player; orbit and fly stay. P/F/O switch, walk bookmarks teleport the player, `?play` starts walking at the spawn south of the gate. The bridge has landward steps up to the deck.
- `?test=walk`: a movement course on the east lawn (stairs 0.15/0.20/0.30/0.35, 30° and 55° ramps, a low beam, and stairs down through a hole in the ground into a tunnel). `scripts/walktest.mjs` drives it in the real page.
- Debug: `__game.player` (pos, teleport, look, state, spawn), `__game.input(keys, ms)` (steps physics synchronously, returns cost and a trace), `__game.physics` (stats, raycast), `__game.probes`.

Numbers (headless WebGL2 on a shared 4-core box): physics init 0.76 s on a normal load (Rapier wasm 0.16 s, colliders 0.41 s for 145k triangles: castle 114k, terrain 31k), 1.8–2.3 s with `?test=walk` under load ~30. Physics tick (player + world step) median 0.25–0.39 ms, mean 0.35–0.86 ms. Rendering cost is unchanged; colliders draw nothing.

Walk test: all checks pass (gate, east wall, revetment at 6 edges, bridge to the break, every course lane, the tunnel under the ground).

Known issues / next
- The gate is closed and the gatehouse plinth batter runs across it; the shell work must open the passage.
- Doors (kinematic boxes) do not push the player; the KCC stops against them.
- 0.15 m steps are ridden by snap rather than autostepped (it looks the same).
- The test course does not cut the render terrain; the tunnel hole is visible only from the physics.
- Collider build time should be measured on the M4; if it is long, split the castle trimesh or build it in a worker.

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
- Walk and fly are FPS-style: click the canvas to grab the mouse (pointer lock), mouse turns the head, WASD moves, Esc releases; crosshair shows while locked. Drag-to-look remains as a fallback.

Numbers (headless WebGL2 capture): castle ~115k triangles; near trees ~2.1M triangles (102 trees) + 11k far canopies; texture generation ~6 s on the container CPU across 3 workers.

Known issues / next
- Near trees are the triangle hog; add impostors (InstancedMesh2 + LOD) before adding more.
- No grass blades yet; island lawn is texture only.
- Far forests are low-poly blobs; swap for impostor cards.
- Stone texture could use a close-up detail normal for first-person distance.
- Courtyard is plain; no doors on the outer walls except the gate.

## 2026-11-05: vegetation

Done
- Trees (`src/world/trees.ts`, `treePlacement.ts`, `impostors.ts`): 7 ez-tree variants (two oaks, two ashes, pine, two bushes). Each has an L0 mesh within about 28 m, a meshopt-thinned L1 out to about 72 m, and an octahedral-lite impostor beyond that (8 azimuths × 2 elevations, albedo + normal atlas baked at startup). Impostors are drawn in 80 chunked instanced draws.
- Shadows come from fixed thinned casters on layer 1 within 140 m of the castle. The sun's shadow map now renders once per frame (`autoUpdate = false`, `needsUpdate` each frame) instead of a second time for the reflector camera.
- Layout is seeded: island groups and bushes clear of the walls and gate path, about 46 copses, hedgerows along a jittered field grid, and forest blocks with bushy edges out to 2.7 km (below h 240). There are about 30k trees in total.
- Ground cover (`src/world/grass.ts`): near and far grass tufts with TSL wind and gusts, colour drifting with the terrain macro, kept off the paths, the courtyard dirt, the rock and the revetment edge (heights and mask are read from the near terrain mesh). Also wildflower and clover patches, and reeds along both moat edges. Chunks are 12 m, culled per frame and packed nearest-first into one draw per layer.
- `?veg=0` disables vegetation; `?treeLod=0` forces impostors only. Tests: `tests/vegetation.test.ts`.

Numbers (headless WebGL2, 1600×900, all passes)
- Before: hero 14.1M triangles / 130 draw calls (trees 2.15M before shadows and AO).
- After:

  | View | Triangles | Draw calls |
  |---|---|---|
  | hero | 2.87M | 245 |
  | ward | 2.88M | 215 |
  | moat | 3.54M | 265 |
  | north | 3.12M | 239 |
  | aerial | 2.79M | 253 |

- With `?veg=0` the scene alone costs 2.51M / 66, mostly the near terrain and the AO pre-pass.

Known issues / next
- Moat, north and walk views sit slightly over 3M because of the non-vegetation baseline. Fixes: a lighter near-terrain grid, or keeping vegetation out of the AO pre-pass.
- The switch from L1 to impostor pops; there is no dithered cross-fade yet.
- Impostors don't receive shadows.
- Grass still reads as tufts rather than a sward up close.
- The WebGPU path is untested; headless captures are WebGL2 only.

