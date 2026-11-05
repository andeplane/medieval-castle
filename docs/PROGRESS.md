# Progress

## 2026-11-05: interior daylight, eye adaptation, cell visibility

Done
- `src/render/interiorLight.ts`: `makeInteriorMaterials(M, sun, light)` clones stone/timber/iron/glass with `lightsNode = lights([sun])` (no outdoor hemisphere or sky IBL indoors) and their own irradiance; `setDynamicLights(lights)` (non-enumerable) lets the interior light manager add candles/torches. `bakeInteriorLight(groups, occluder, { plan, windows, sun, light })` tags every interior triangle with its room (`interiorRoom` attribute), turns windows (castle.ts `lights` or richer records with embrasure sizes) and doors (outside doors, grilles, portals between rooms) into apertures, checks each window's sun with three-mesh-bvh, solves split-flux bounce per room (stairs and open doors carry light on) and packs one float table. `setDoorOpen(id, 0..1)` re-solves. `buildShadowSkins` adds hidden casters inside the walls and above ceilings (the shadow map renders back faces, so thick walls leaked a strip of sun along every floor seam and beam).
- `src/render/interiorShader.ts`: per pixel, each aperture of the room is an area light with its exact form factor (polygon edge integral), clipped to the glass the point sees through its splayed embrasure; plus bounce × gain and a readability floor. Glass glows from the room side, brighter at the top.
- `src/render/exposure.ts`: eye adaptation from a 32×18 log-luminance reduction of the HDR scene pass, read back every 6 frames; 0.72 outdoors, up to +2.5 stops in rooms and +3.2 underground; ~1.4 s into the dark, ~0.6 s into the light. `?exposure=` fixes it; `?shot` sets +2.5 / +3.2 from where the camera is.
- `src/world/visibility.ts`: cell visibility for InteriorGroups (inside: own floor, ±1 floor, adjacent zones at that height, door neighbours, nearby stairs; outside: groups within 60 m whose windows/doors face the camera). Underground hides water, far terrain, stream, rocks, trees and ground cover; deep inside (no open way out within 40 m) hides trees and ground cover. `register(obj, roomOf)` shows/hides NPCs, door leaves and other dynamic things with their room.
- `?test=room` (`src/debug/roomtest.ts`): 12 × 8 × 6 m hall (2 m walls, three splayed south windows, one west, a round-headed door from outside) and a 6 × 8 m chamber through a 1.4 m cross wall, timber floor, boarded ceiling on beams, bookmarks `room-hall, room-pool, room-window, room-chamber, room-dark, room-ceiling, room-out, room-south`.
- Tests: `tests/interiorMath.test.ts`, `interiorLight.test.ts`, `visibility.test.ts`, `exposure.test.ts`; 100 % lines on the interior light, exposure and visibility modules.

Numbers (test cell, headless WebGL2): bake 15–25 ms for 2 rooms / 9 apertures (BVH over the island 35–90 ms); the per-room part is linear, so ~140 rooms ≈ 0.3–0.6 s plus the BVH. Draw calls: outside 246–260, inside 228–240 (2.3 M triangles with vegetation; 50–60 / 0.93 M with `?veg=0`). Measured mean log2 luminance: exterior −1.2, hall −6.9, chamber −8.6.

Known issues / next
- Shell integration: pass the shell's `groups` + `plan` and the castle `lights` (better: windows with `depth`, `wi`, `hi`, `yi` from the shell's embrasures) to `bakeInteriorLight`; doors module calls `setDoorOpen`.
- Glass is opaque from inside (glows); there is no view out through glazed windows.
- Light through a door from a neighbour is a uniform portal; no directional sun through internal doors.
- Rooms that are not convex get some light through their own corners (no occlusion inside a room).

## 2026-11-05: procedural prop kit (furniture, not yet placed in the castle)

Sourcing decision (Anders, 2026-11-05): code + free CC0 only; no store packs (their licences forbid shipping raw files from a public repo); Meshy (already paid for) may be used later for a few organic hero props.

Done
- `src/props/geom.ts`: pure `PropMesh` (no three.js): bevelled boxes with hand-made skew/taper, tubes, lathes, parametric sheets, transform stack, vertex tints. One bin per material: wood, iron, cloth, straw, ceramic, wax, flame.
- `src/props/kit.ts`: 29 seeded kinds (trestle table, bench, stool, chair, throne, bed, four-poster, straw pallet, chest, cupboard, shelf with clutter, barrel, crate, sack, bucket, cauldron, tableware, candlestick, sconce + torch, chandelier, weapon rack, armour stand, lectern, altar, book stack, tapestry, rug, firewood, straw heap). Each returns colliders (boxes), light emitters (position, colour, intensity, flicker) and whether it blocks navigation.
- `src/props/place.ts`: merge placed props into one mesh per material, world footprints for navmesh obstacles, the review layout.
- `src/props/textures.ts` + `render.ts`: generated oak, iron, weave, straw, glaze textures; three.js materials and meshes.
- `props.html`: review page (gallery + hall, chamber, store rooms). `URL=http://localhost:5173/props.html npm run shots kit hall chamber store`.
- `npm run coverage`: v8 coverage, thresholds 95 % lines on `src/props` (currently ~99.9 % lines, 97 % branches).

Numbers (headless WebGL2): 140–3.8k triangles per piece (shelf with clutter is the largest); the whole review page is 79 props, ~40k triangles, 7 materials; prop textures generate in < 1 s.

Next
- Hook into the interiors once `interior-shell` lands: `dressRooms(plan, physics)` returns `Map<InteriorGroup key, Object3D>`; recipes per `RoomKind`; keep door swings and stair landings clear; validator for 256 seeds.
- Swap the stand-in materials for `makeInteriorMaterials` from `src/render/interiorLight.ts`; hand emitters to interior-light.
- Looks: tapestry patterns are coarse, the mail shirt reads as a tube, straw heap reads as sand.

## 2026-11-05: tunnel loading screen

Done
- Loading screen (`src/loading/tunnel.ts`, shader in `tunnel.glsl.ts`): a vaulted rubble tunnel under the moat that starts pitch dark; each boot step lights the next wall torch (nearest first, 8 torches), and the last 7 % brings up a soft fill and daylight through the iron grille at the far bank. Torches strike with a short sputter and then flicker; puddles mirror the flames; in-scattering gives the damp air a glow.
- Own WebGL2 canvas with an analytic ray tracer (floor, walls, barrel vault, end wall), so it is up in the first frame, before the castle renderer, textures and shaders exist. Without WebGL2 the caption alone shows progress. Context is lost and the canvas removed after the fade.
- Matches the castle tunnels (interior-shell): 2.1 m wide, crown 2.65 m, rubble walls and vault with the `rubble` greys from `texgen.ts`, dressed springer course, dressed flagstones.
- Progress comes from the existing `say()` steps in `main.ts` (unknown labels just advance a little) plus per-job texture progress from `texpool.ts` (`setTextureProgress`).
- `index.html` now loads `src/loading/entry.ts` (12 kB gzip), which shows the tunnel at once and then `import()`s `main.ts` (3.2 MB gzip), so the tunnel is up during the download too.
- Structure for tests: `model.ts` (pure progress/torch state), `gl.ts` (renderer over a narrow `GLLike` slice of WebGL2), `tunnel.ts` (DOM + frame loop with injected `LoadingDeps`), `start.ts` (entry logic with injected `EntryDeps`). `npm run coverage` enforces 100 % on `src/loading` (type-safe fakes in `tests/loading/fakes.ts`).
- Review: `?loading=<0..1>` holds the tunnel at a progress value, `?loading=demo` loops a fake load; `node scripts/loading-shots.mjs [p …]` captures `shots/loading-<p>.png`. Honours `prefers-reduced-motion` (no camera drift or flicker).

Next
- Swap the procedural stone for the castle's own stone textures once the stone-closeup work lands, if the look should match exactly (they are generated after the loading screen starts, so it would need a cached copy).

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

## 2026-11-05: landscape (branch `landscape`)

Done
- Outer moat bank (`terrain.ts` `bank()`): irregular shoreline, a bare-earth face 0.6–1.45 m high, a wet line and mud, a rounded shoulder, hummocks. The island branch of `sample()` is unchanged.
- Rocks (`src/world/rocks.ts`): 5 generated shapes (noisy icospheres cut by planes, creased normals) × 2 LODs, about 1340 instances. They sit on the waterline (13% boulders), the bank shoulder, the NW outcrop by the great tower (14 bedrock slabs) and in rough fields as erratics, plus clearance stones by hedges.
- Field patchwork (`src/world/fields.ts`): a warped, jittered lattice along the regional grain, with merged fields, six crops, hedgerows and two lanes (boreens). It is baked into a 2048² field map that the terrain shader reads (`src/world/terrainMaterial.ts`): crop colours, mowing stripes, furrows, hedge bases and rutted lanes. Rough commons sit around the moat. Drumlins follow the grain.
- Stream from the northern hills to the lake: meandering, never climbing, a fine corridor mesh and a water ribbon.
- Mountains (`src/world/relief.ts`): broad massifs plus warped ridged noise, then droplet and thermal erosion on a 512² grid. Erosion runs in `relief.worker.ts`, in parallel with texture generation. Per-pixel relief normals, rock on steep slopes, scree on erosion fans, gully darkening, moor and bracken, snow above about 1050 m, and aerial perspective.
- Dependency injection: generators take `GenDeps` (`src/world/deps.ts`: `rng(name)`, `noise2(name)`, `noise3(name)`). `createTerrain(deps)` returns a `Terrain`; `defaultTerrain()` is the game's instance, created lazily. The module-level `sample`/`heightAt`/… wrappers use it. Module scope holds only layout-derived constants.
- Tests: `tests/{fields,relief,terrain,rocks,terrainMaterial}.test.ts` with fakes in `tests/fakes.ts`. Coverage of the landscape modules is 99% of lines and 94% of branches (v8). The uncovered part is the browser-only worker branch of `prepareTerrain`.

API for other generators (hedges, trees, walls, NPCs). Use `defaultTerrain()` or the module wrappers in `terrain.ts`:
- `hedgerowLines(): {a, b, lane}[]`: hedge centre lines in world x/z, already clipped to farmland (none in the moat, the lake, by the stream, on steep or high ground). Lane edges come back as two hedges `LANE_HALF` (3.2 m) either side, with `lane: true`. About 2k segments. The shader draws a dark hedge-base strip on the same lines.
- `fieldAt(x, z) → {field, crop}`, `farmland(x, z) → 0..1`, `streamLine() → {pts, level, halfWidth}`.
- Navigation: `islandWalkable(x, z)`, `slopeAt(x, z, e)`, `navSample(x, z, obstacles?) → {h, slope, walkable}`, and `islandNavGrid(cell, obstacles?)`, a raster for navmesh generation. `MAX_WALK_SLOPE` is 35°. The island rock footprints are in `terrain.getObjectByName('rocks').userData.obstacles` as (x, z, r).

Numbers (headless WebGL2)
- Terrain is about 785k triangles: near grid 353k, far 224k, stream corridor 31k, rocks about 176k (near 123k, far 53k).
- About 8 extra draw calls: corridor, stream water, 10 rock instanced meshes.
- Timings in Node, on an idle container:
  - erosion 1.9 s, in a worker in the browser and overlapped with textures
  - `buildTerrain` 2.4 s: near 1.0 s, far 0.7 s, corridor 0.2 s, rocks 0.5 s
  - relief texture 0.6 s
  - field map 0.3 s

  The previous terrain took 4.3 s.

Known issues / next
- Far forest canopies (`trees.ts`) still scatter up the mountain flanks up to 700 m, which looks blobby on the moorland. They should use `farmland()`, `slopeAt()` or a height limit.
- Hedges are only dark strips until hedge geometry is planted on `hedgerowLines()`.
- The stream water reads bright from low angles, like a canal; it could use banks with reeds and a narrower ribbon.
- Mountains are smooth at mid-distance, where the 26 m erosion grid is the limit. The next step is a finer grid around the hero massif.
- The lake shows a dark band at its shore and the moat has pinkish reflections. Both come from `water.ts` and need checking with the water owner.
- Island rocks are not in walk collision yet; `obstacles` are exposed for it.

## 2026-11-05: interior stairs (branch `interior-stairs`)

Done
- `src/castle/interior/stairs.ts`: `buildStair(B, spec, opts)` for the shared `StairSpec` (contract in `src/castle/interior/types.ts`).
  - Spiral newel stairs: stone wedge steps, each with its own newel drum, nosing, worn hollow on the walking line, small tilt; a helical soffit under every step (first-turn steps are solid down to the floor). Rises 0.17–0.198 m; steps per turn chosen from the radius (going ~0.4 m at the walking line), raised until the headroom holds (>= 2.05 m). Landings are wide flat steps centred on each door angle; the planner picks rise counts and turns to hit fixed door angles. Rope handrail on iron staples, optional inner drum skin with door/slit gaps, top wall, ceiling, polygonal stair rooms (`drumPoly`).
  - Straight flights: mural stairs (passage walls + stepped lintels) or open courtyard steps, with mid landings and flat lead-in / run-out when the run is long.
  - `stairCollisionRamp()` (invisible helicoid through the nosings, never below a tread), `stairNavPath()` (walking-line polyline for NPCs, a vertex at every landing), `validateStair()`, `spiralLandingAngles()`, `spiralStartFor()`, `drumWall()`.
  - Randomness is injected (`opts.rng`, default: world seed + stair id); the Builder is passed in.
- `src/castle/interior/stairprobe.ts`: vertical ray casts on the built triangles (rises, goings, headroom, landing heights, NaN/degenerate checks).
- `tests/stairs.test.ts`: plan and geometry checks for the test stair, a tight turret stair, 10 random towers, mural and courtyard flights, nav path, ramp, options. Coverage of the stair modules ~98 % statements / 99.8 % lines.
- `?test=stairs` (`src/debug/stairtest.ts`): a tower (r 2.4, newel 0.3, landings 7/13/19/25 m) with a thick drum, doors, slits and a mural stair up to its door; `&cut` removes half the drum. Bookmarks `stair-up, stair-climb, stair-down, stair-landing, stair-soffit, stair-mural, stair-out, stair-cut`.

Numbers: test spiral 103 steps, 24.7k triangles (~196 stone + ~43 rope/staples per step), ramp ~5k triangles; mural flight 31 steps, 3k triangles.

Known issues / next
- The stone materials are exterior ones: rain streaks and lichen show on treads indoors (needs an interior material variant).
- Fixed door angles that fall badly for a small radius can cost going or headroom; the plan reports it in `stats.problems`. Taking upper door angles from `spiralLandingAngles()` always works.
- The ramp is steeper than 50° within ~0.65 m of the axis on wide stairs (the capsule only gets there hugging the newel).

## 2026-11-05: interior doors (branch `interior-doors`)

Done
- `src/castle/interior/doors.ts`: `buildDoors(doors, M, physics?, opts)` builds every door leaf from the shared `DoorSpec`s. All leaves go into two BatchedMeshes (oak, iron), so there are 2 draw calls however many doors there are. Each leaf is one instance whose matrix is rewritten while it swings.
  - Leaf kinds: plank doors (vertical oak boards with chamfers and gaps, shaped to round, pointed, segmental or flat heads; ledges and a brace with its foot on the hinge side; strap hinges with spear tips and knuckles on pintles; clinched nail heads; a ring and escutcheon outside; a thumb latch, keeper and pull ring inside), studded and banded posterns, iron grilles (yetts), and the gate (two leaves, a wicket in one, sag and judder while moving).
  - The leaf geometry is shared per size class and generated as pure arrays in `doorParts.ts`. The placement maths (hinge side, swing space, rebate depth, swing limit near the jamb) is in `doorGeom.ts`.
- Behaviour: doors open fast and settle slowly; they close accelerating and end with a thud and a latch click. A leaf stops short of any character in its arc: the player (passed to `update`) plus `opts.characters()` for NPCs. A seeded few doors start ajar. There is one kinematic box per solid leaf part through `PhysicsApi.addKinematicBox`.
- NPC API: `request(id, open, { pos })` (within 2.6 m), `isOpen(id)`, `isPassable(id)`. For the gate, `isPassable` is true when there is enough gap, or the wicket is open, and the portcullis is up.
- Main gate on main: `gateDoorSpecs()` and `gatePortcullisSpec()` are read from `gatehouseFrame()`. The wood fill in `castle.ts` is now a 5.2 m deep dark passage. The old static portcullis is replaced by a moving one: it ratchets up slowly with a clank per tooth and drops on the brake, but not onto anyone. In the normal scene, E (walk mode) or a click (pointer locked) opens the gate, the wicket or the portcullis. Walk mode can step into the gate passage when the leaves allow.
- `src/game/interact.ts`: centre dot plus an "E Open door" chip (index.html tokens, hidden in `body.shot`), reach 2.2 m. Input and view are injected, and `pickTarget` is pure.
- `src/game/doorAudio.ts`: procedural WebAudio creak, latch, thud, bump, clank and chain sounds. They are positional (distance gain, low-pass and pan) and start on the first gesture. They are logged in `__game.state().sounds`.
- `?test=doors`: a rebated stone wall with every head and kind, a gate with a portcullis and a grille. `?doors=0|0.5|1` sets the starting openness and `&port=down` lowers the portcullis. `door-*` bookmarks.
- `__game.use()`, and `__game.doors.{state,setOpen,tick}`. `scripts/doortest.mjs` drives both the test scene and the castle gate.
- The gatehouse's battered plinth used to cover the lower half of the gate; it is now cut through at the gate (`gatehouseBatter` in castle.ts). There is a new `door-gate` bookmark in front of it.
- `CameraRig.canWalk` / `groundAt` are injectable. Bookmarks no longer get pushed out to the orbit minDistance in walk or fly mode.

Numbers: 150 mixed doors come to 2 draw calls and 187k triangles (about 1.25k per leaf; iron studs and rings are about half of that). They build in about 0.7 s in Node. The castle gate, wicket and portcullis come to 5.6k triangles. `npm run coverage` enforces thresholds on the door modules (measured: doors 100 / 95.4 / 100 / 100, doorParts 98.3 / 94 / 100 / 99.2, doorGeom and doorBatch 100, interact 98.9 / 90.6 / 94.4 / 98.2, doorAudio 99.4 / 96.7 / 93.3 / 100, as statements / branches / functions / lines). The interaction now reuses the page's `#crosshair` instead of adding a second dot.

Known issues / next
- Contract interpretations the shell should match: the leaf's back face sits on the stop at `rebate` from the swing face; the leaf fits inside the clear opening with 1.5 cm clearance (no lap over the stop, so thin light slits show); pointed heads rise 0.42·w (castle.ts gate arch), segmental 0.2·w. `openingOutline(head, w, h, seg, grow)` gives the exact outline, and `grow` gives a rebate recess.
- Portcullis grid is iron, not iron-shod oak; there is no winch or windlass in the room above yet.
- Doors are only in the main scene for the gate, until the shell's `plan.doors` lands.
