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

## 2026-11-05: real stones (D.1 stone course data model)

Done
- `src/castle/stones/`: every rubble/ashlar wall face (planar walls, box and prism sides, round towers, battered plinths, revetment) is a list of courses of real stones. The layout is the masonry texture's own layout (`masonryLayout()` / `masonryWarp()` split out of `texgen.ts`), tiled exactly as the wall UVs tile the texture, so each 3D stone sits on the texture stone it replaces, joints follow the texture's warped joints, and the near/far switch is invisible (brief: "same course layout in texture and stones").
- Stones skip openings and anything standing proud of the face (jambs, sills, voussoirs, quoins, buttresses, string courses, plinths, corbels): the Builder records stone faces and exclusion solids (`stoneFaces`, `stoneExcl`). End stones interlock round convex corners on alternate courses.
- Geometry: chamfered slabs proud of the wall (rubble 5–9 cm, ashlar 4–6.5 cm), the flat wall behind acts as mortar. Three LODs per 12 m chunk × material × facing: hi (rounded, chipped, domed, 84 tris) ≤ 8 m, mid (chamfered, 22) ≤ 24 m, lo (slabs, 10) ≤ 40 m; ashlar 1.25× further. Silhouette stones (parapets, merlons, buttresses, turrets, corners, revetment) stay as lo out to 80 m via a draw range. Chunks facing away are hidden; geometry is built lazily (4 ms/frame budget) and evicted when far.
- Dressing stands proud of the stones (jambs 11 / 8.5 cm, quoins 11 cm); parapet copings are separate coping stones.
- `?stones=0` hides the real stones for A/B; `__game.lookFrom(pos, target)` for close-up captures; `state().stones` reports counts; captures now report per-shot draw calls/triangles.
- Tests: `tests/stones.test.ts` (courses cover the face and tile end to end, inner joints are the texture joints, no stone overlaps an opening or a solid, corners interlock, deterministic).
- Close-up pass after Anders' "does NOT look good close up" (feedback/2026-11-05-stone-closeup-bad.png): stone faces now sample only the interior of their texture stone (UVs squeezed toward the stone centre, an extended corner stone maps onto its own cell), so the texture's joint outlines, bevel shading and mortar mask never land on a geometric stone. Hi LOD (≤ 8 m, 84 tris) has a 12-point outline, a rounded arris with random chips knocked back and down, and an unevenly domed face. The flat wall between the stones is the mortar; its colour and grain come from the texture (being rebuilt on `stone-closeup`).
- Exclusions are clipped to the stone layer: a solid blocks the convex outline where it passes through the face's stone layer (hull of corner points inside it plus corner-to-corner crossings), not its bounding box. Battered plinths no longer leave bare bands on the buttress sides.
- Dependency injection and coverage (Anders' rules): `StoneSet` (src/castle/stones/set.ts) lays out every stone once from injected faces, exclusion solids, masonry specs (`SpecFor`, built from an injected rng via `makeMasonrySpec`) and seed salt, and answers `stonesNear(point, r)` for physics and NPCs. `StoneField` takes the set, materials, LOD distances and a clock; `update()` takes a camera position. `pickLevel`, `facingAway`, `boxDistance` and `makeChunks` are pure and exported. `buildCastle`, `buildBridge` and `buildRevetment` take their rng as a parameter. Tests: `tests/stones-model.test.ts` (toy masonry spec, all geometry levels on plane, cylinder, battered and mirrored faces, stonesNear vs brute force, LOD bands/hysteresis/budget/eviction with a fake camera and clock) and `tests/castle-stones.test.ts` (whole castle with injected rngs and ground). Coverage of src/castle/**: ~99 % statements, 100 % lines in src/castle/stones.

Numbers (headless WebGL2, 1600×900, frame incl. shadow + AO pre-pass; the ~14 M baseline is mostly the near trees):

| View | Draw calls (stones off → on) | Frame triangles (off → on) | Stone triangles |
|---|---|---|---|
| gate | 124 → 482 | 14.12 M → 15.03 M | 0.53 M |
| ward | 120 → 386 | 14.12 M → 14.81 M | 0.46 M |
| north | → 182 | → 14.21 M | 0.02 M |
| moat | → 308 | → 14.35 M | 0.06 M |
| hero | 130 → 130 | 14.13 M → 14.13 M | 0 (nothing within 80 m) |
| close-up, rubble wall 2 m away | → 466 | → 16.17 M | 1.71 M (12 hi chunks) |
| close-up, corner | → 552 | → 16.40 M | 1.81 M (13 hi chunks) |

159k stones in 465 chunks. Layout takes 2–7 s at startup on the shared container CPU (once; well under 1 s on the M4 is the expectation, to be measured). Geometry is 30–100 MB depending on where the camera has been.
- `Builder.walls` (`WallRecord`, shape agreed with the interior branch) records every wall face; real stones stay exterior-only.

Known issues / next
- Triangles: stones add ~0.5–1.8 M per frame in close views (counted twice because of the GTAO normal pre-pass). Trees still dominate the frame budget.
- Geometry is built on the main thread; a big chunk can cost a few ms when it first comes into range. Move to a worker if it shows up as a hitch on the M4.
- Battered round-tower bases (frustums) and arch spandrels are still flat texture.
- Mortar between the stones is the texture's (speckled, grey); the `stone-closeup` branch rebuilds it as sandy lime, and the stones pick that up with no change here.
- `npm test` is ~13 s wall on the loaded container (8 s CPU), above the brief's 5 s: most of it is importing three and building the whole castle twice in `castle-stones.test.ts`.
- The gatehouse plinth runs across the bottom of the gate arch (pre-existing).
- The `courtyard` and `towertop` bookmarks put the camera inside a solid (a wing, and the keep's cap house). Walls are single-sided, so from there you see the backs of the real stones as floating shards. Move those two bookmarks out of the solids.
