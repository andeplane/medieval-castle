# Progress

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
