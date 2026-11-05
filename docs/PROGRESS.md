# Progress

## 2026-11-05: courtyard paving (branch `courtyard-paving`)

Anders, on `castle-plan/feedback/courtyard-door-cut.png`: "wtf is this". The courtyard floor was the terrain's flat, blurry grey.

Done
- **Paving** (`src/castle/paving.ts`, pure): one flat polygon over the courtyard in a new Builder bin `pave` (one mesh, one material, no shadow casting), 41 triangles. It covers the courtyard minus the stair tower and the well (convex cuts, `cutConvex`), at `PAVE_Y = GROUND + 0.02`. The terrain under it drops to `COURT_BED = GROUND − 0.15`, below the deepest joint. The interior carve leaves the `pave` bin alone, so the passage plinth no longer eats 146 m² of it.
- **Stones are texture and parallax, not geometry.** `render/texgen.ts` adds `cobbles`: tileable Voronoi cells (14 cm) cut by a per-cell ellipse, domed and bevelled, set in an earth bed, 4 m repeat at 2048². It also adds `flags`: masonry flags in 0.6–0.9 m courses, 2 m repeat. Both are worker jobs (`texpool`). The `paving` material in `render/materials.ts` uses the same POM with depth offset and self-shadow as the walls. It picks the flag set on the path strip and the cobble set elsewhere, from the path frame in the uvs. Weathering:
  - earth joints with moss;
  - damper, darker ground within about 1–2 m of every wall foot, the stair tower and the well (distance from the plan, in the shader);
  - a worn, smoother track along the path;
  - per-stone tint, using the walls' close-up detail layer.
- **Path:** a 2 m flag path runs from the gate passage (`gate-court`) to the N wing's courtyard door (`court>N…`). Both ends come from the interior plan's doors. The path edges fall on a flag joint, with a kerb joint where the flags meet the cobbles.
- **Well:** it now has a windlass: an oak roller with turns of rope, a rope down to a hooped bucket over the shaft, and an iron crank. Its position is seeded (`rngFor('court-well')`), a little west of the old spot so it stays clear of the path. The "bare crossbar" item is closed.
- **Leaning slab:** the wings' courtyard-side faces no longer get the battered plinth (`loft` skips that face, and `offsetPoly` takes per-edge offsets). The uncarved batter by the stair tower was the odd leaning slab. The outer faces keep their batter.
- Footsteps on the paving are stone: the collider tag is `castle-pave`, which `surfaceAt` resolves to stone. Key path 1 walks onto it and asserts `surfaceTag === 'castle-pave'` and `surface === 'stone'`.
- New bookmarks:
  - `court-ground` (walk, the ground about 1.5 m ahead);
  - `court-close` (fly, 0.5 m above the cobbles);
  - `gatepass-court` (walk, the passage looking in);
  - `court-stair` (walk, the stair tower foot).
- Fixed in `controls.ts`: a fly bookmark reached from walk mode kept the player's look. It now takes its own yaw and pitch, and `clamp: false` lets it go below eye height.

Numbers (headless WebGL2, `__game.state()`, 1600×900)
- castleTriangles: 128,085 → 128,177.
- Same view and frame, paving shown vs hidden: +4 draw calls and +164 triangles. That is the one paving mesh (41 triangles) in each of the four passes that draw it (main, AO pre-pass, water reflector and one more), and it is the same in every view.
- Per bookmark, before (main) → after: courtyard 716 → 726, gate 542 → 550, gatepass-court 446 → 442, court-ground 718 → 726, court-close 380 → 390, court-stair 542 → 534. Measured on the second frame, court-ground is 708 with the paving and 704 without. The paving accounts for 4 of each difference. The rest is not pinned down: the well dressing goes into existing bins, and the first frame after a camera jump also re-renders shadows, so the counts move by a few between runs.

Captures: `castle-plan/courtyard/` holds before/after pairs of `court-ground`, `court-close`, `gatepass-court`, `courtyard`, `gate` and `court-stair`.

Assumptions (Anders can veto)
- Rounded cobbles set in earth everywhere, with a flag path from the gate to the N door. There is no drain or gutter.
- The well moved about 1 m west.
- The courtyard faces have no battered plinth.

Not checked / still open
- Only headless WebGL2 (SwiftShader) was checked. WebGPU and the frame rate on the M4 were not measured. The paving is a full-screen POM surface at eye height, so run `?bench` on the courtyard and the run-courtyard walk.
- There is a 12 cm step at the passage arch: the passage floor is at 2.5 and the paving at 2.62. This was already there.
- The passage floor's own flat look is out of scope here (interior materials).

## 2026-11-05: firelight on grey stone, not sepia (branch `interior-colour`)

Anders sent `castle-plan/feedback/door-prompt-floor.png`: an empty interior room in one saturated orange-brown. Measured on his screenshot: mean sRGB (87, 45, 13), HSV saturation 0.87, blue/red 0.15, and the same hue (25°) on every wall and the floor.

Cause (measured in the game, not guessed):
- **The torch colour had no blue at all.** `toSource` lit every fire with the 1800 K black body as a daylight-balanced camera records it: linear (1, 0.21, 0). Grey stone times that is pure orange whatever its own colour, so every fire-lit pixel had saturation ≈ 1.0 and blue/red ≈ 0.02. The eye's partial white balance to firelight (`WARM_INTERIOR.grade.adapt`) existed only on the review page (lights.html), as a whole-frame gain, and a gain cannot bring back a blue channel that is zero.
- **Torches lit the neighbouring rooms through the walls.** Fire lights cast no shadows, and a wall torch's range was 7 × √3 ≈ 12 m. The undercrofts' torches are about 5.5 m apart, so each room was lit by its own torch and its neighbours'. The whole room was in torchlight, with no unlit stone left to show its grey. The chamber next to the hall had a warm glow from the hall's torch.
- **The readability floor (0.05) was invisible.** At +2.5 stops it sits in the toe of the neutral tone map, which subtracts most of the darkest channel and makes dark warm pixels browner still. Bounce and fill could not counter the torch.

Changes (tuning only, no new system):
- `src/light/blackbody.ts` `seenKelvin(k, adapt)`: chromatic adaptation along the Planckian locus, linear in mired towards 6500 K.
- `src/light/rig.ts`: `toSource` and `LightRig` colour every fire with it (`RigOptions.adapt`, default `WARM_INTERIOR.grade.adapt`).
- `src/light/look.ts`: `grade.adapt` goes from 0.18 to 0.55, so a 1800 K torch reads about 3000 K (linear 1, 0.44, 0.15), a hearth about 2700 K and a candle about 3050 K. The flames themselves keep their own 1800 K ramp, so they still look orange against the stone.
- lights.html now uses the same adaptation through the rig, instead of a frame gain (`whiteBalance` is removed).
- `src/light/flicker.ts`: torch range goes from 7 to 4, which gives about 6.9 m for a wall torch (intensity 3), about one room.
- `src/render/interiorLight.ts`: the readability floor goes from (0.05, 0.05, 0.055) to (0.145, 0.145, 0.155), near neutral. A first try at (0.14, 0.145, 0.16), with green above red, turned the darkest stone olive in the tone-map toe.

Before/after, measured on headless WebGL2 walk-mode captures (`?shot`: +2.5 stops in rooms, +3.2 deep). Fire lights are held at their mean brightness, with no flicker or fade-in, so each pair differs only by the change. Values are mean sRGB, HSV saturation and blue/red over a region:

| view, region | before | sat | B/R | after | sat | B/R |
|---|---|---|---|---|---|---|
| undercroft N0-2, torch wall | (202, 117, 57) | 0.77 | 0.28 | (198, 143, 93) | 0.57 | 0.47 |
| undercroft N0-2, side wall | (136, 63, 3) | 0.98 | 0.02 | (117, 75, 33) | 0.74 | 0.28 |
| undercroft N0-2, floor | (128, 60, 1) | 0.99 | 0.01 | (104, 67, 19) | 0.83 | 0.18 |
| 0.5 m from the wall, 1 m from the torch * | (215, 114, 44) | 0.82 | 0.21 | (215, 149, 89) | 0.61 | 0.41 |
| 0.5 m from the far wall, 5.7 m from the torch | (130, 61, 3) | 0.98 | 0.02 | (68, 44, 16) | 0.79 | 0.23 |
| cellar N-c1, torch wall | (171, 104, 49) | 0.80 | 0.29 | (162, 123, 72) | 0.66 | 0.44 |
| cellar N-c1, far vault | (124, 59, 3) | 0.98 | 0.03 | (98, 66, 29) | 0.71 | 0.30 |
| hall N1-2 (windows + torch), torch wall | (151, 102, 79) | 0.44 | 0.52 | (148, 120, 98) | 0.31 | 0.66 |
| hall N1-2, wall away from the torch | (104, 78, 65) | 0.42 | 0.62 | (82, 78, 72) | 0.24 | 0.88 |
| chamber N1-1 (window, no fire) * | (88, 71, 62) | 0.28 | 0.71 | (84, 82, 79) | 0.07 | 0.93 |

Rows marked * were captured with the first floor value, (0.14, 0.145, 0.16); every other row moved by at most 0.01 between the two floor values.

Captures (`castle-plan/interior-colour/`, `before-*` / `after-*`): under-room, under-near-wall (close range, 0.5 m), under-far-wall (0.5 m), cellar-room, hall-room, hall-near-wall, chamber-room; the bookmarks hall, undercroft and cellar; gate and courtyard (after only); and lights.html cellar and supper.

Checked:
- `npm run coverage`: 649 tests pass, and `src/light` coverage is 100 % lines. `npm run build` passes. The key-path tests are in the suite.
- I looked at the captures as a player would. Rooms with daylight (the hall, the chamber) now read as grey stone with a warm pool round the torch. The windowless undercroft and cellar read as warm stone rather than sepia, darker and browner away from the torch.

Still open:
- Windowless rooms are still warm all over (far wall saturation 0.78). Nothing neutral reaches them, and the neutral tone map's toe browns dark warm pixels. Two levers remain if Anders wants greyer: a dark-tone desaturation in the grade, or a stronger fill. Either changes the outdoor look or flattens rooms, so neither is done here.
- The `undercroft` and `cellar` bookmarks render only a couple of frames, so their torches have not faded in. They show mostly the fill: dark, slightly olive stone. The walk captures above hold the fires at full.
- `?shot` gives the hall's north wall +3.2 stops ("deep") when you stand 0.5 m from it, so that close-up is blown out. This is the shot exposure path; live auto-exposure was not checked.
- lights.html is a little darker than before: shorter torch range, and no frame gain. At its exposure of 0.58 the page sits in the tone-map toe, and it is still saturated (0.97).
- Not checked on WebGPU or on a Mac; with flicker on; at night; with `?furniture=1` (hearths, braziers and candles keep their old ranges, 9 / 7.5 / 3.5 m, and still reach through walls).
## 2026-11-05: frame rate fixes (AO pre-pass at half size, dynamic resolution)

Measured after deploy (`?bench`, Anders' M4, Chrome WebGPU, 1200×897 CSS px, devicePixelRatio 2, 120 Hz; fps / p95 frame ms):

| view | before (main at #33) | AO at half size, fixed 2× (`?scale=2`) | default (dynamic resolution) |
|---|---|---|---|
| hero / aerial | 120 | 120 | 120 |
| gate | 82 / 23.6 | 95 / 19.5 | 94 / 19.7 |
| door-gate | 43 / 45.2 | 53 / 36.1 | 66 / 29.1 |
| courtyard | 57 / 33.6 | 70 / 27.1 | 83 / 22.7 |
| ward | 83 / 22.8 | 96 / 19.6 | 95 / 19.5 |
| closeup-ashlar | 37 / 53.5 | 45 / 42.9 | 71 / 26.9 |
| gatepass | 87 / 22.0 | 107 / 17.6 | 114 / 14.9 |
| walk-gate (spawn → gate, walking) | – (the step did not move then) | 57 / 40.8 | 71 / 26.6 |
| run-courtyard | 39 / 34.0 | 67 / 29.6 | 65 / 30.0 |

- GPU time with the new per-frame reading: door-gate 16 ms at a fixed 2×, 12.8 ms with dynamic resolution. It matches the frame rate now.
- Still open:
  - p95 frames stay at 20–30 ms near the castle: there are occasional hitches above the GPU time. The cause is not found yet; the stone chunk builds while moving are a suspect.
  - Door leaves are ~1,600 draw calls on WebGPU (a BatchedMesh draws once per instance). This does not limit the M4 but would weigh on weaker CPUs.
- A run with the game also open in a second tab dropped the resolution to 1× everywhere, as designed. Close other tabs with the game before benchmarking.

- Per-pass GPU timestamps on the M4 (WebGPU, retina 2×): the GTAO normal pre-pass redrew the whole scene at full size for AO that is computed at half size. It cost ~7 ms of the 20 ms door-gate frame (`?ao=0`: 20 → 12.8 ms, 45 → 70 fps). It now renders at half size (`pre.setResolutionScale(0.5)`).
- **Dynamic resolution** (`src/render/resolution.ts`): every quarter second the render pixel ratio is checked against the GPU time per frame. It steps 0.25 down (at most once a second) while a frame costs more than 15 ms, and back up (at most every 3 s) when the bigger frame would still fit in 12 ms. It ranges from 1 to the screen's ratio (capped at 2). `?scale=` fixes the ratio, `?dynres=0` turns it off. Without GPU timestamps it only steps down, on frames slower than 57 fps. The stats overlay shows the current ratio under "size".
- GPU time on Apple GPUs: their passes overlap, and each pass's timestamps span most of the frame, so the sum of passes read 5–8× too high (150 ms for a 22 ms frame). The overlay now takes the longest pass per frame on Apple and the sum elsewhere (`gpuFrameTimes`). It also reads one resolve per frame batch; before, a resolve could count several frames.
## 2026-11-05: one owner per wall opening; door prompt and door clipping (branch `door-prompt-clipping`)

Anders: "what door?" (`castle-plan/feedback/door-prompt-floor.png`: "Open door" while looking at the floor), "some clipping error on doors, please fix", then "rethink and redo. do better". The coordinator added `courtyard-door-cut.png` and `CLIPPING.md`.

Root cause of the clipping: two systems cut the same walls. The exterior (castle.ts + openings.ts) placed windows, the gate arch and the stair-tower door; the interior plan placed every door and carved it through the castle again. Nothing checked one against the other.

Who owns what now
- **Doors (and the gate):** the interior plan. Each DoorSpec has one outline (`doorOutlines` in doorGeom.ts), clear from the non-swing face to the stop and rebated beyond. The leaf, the rebate, the shell reveal and the cut through the castle all come from it. The cut is the shell's carve volume, the only thing that removes castle geometry for a door. castle.ts no longer cuts the gate arch or the stair-tower door; the gate's voussoirs and passage take `GATE` from the plan.
- **Windows and slits:** openings.ts, as before. They are placed after the door holes of their face (`doorHoles(plan)` → `doorBox`), with the same `fits()` rule, so a window never lands on a door.
- **Courtyard doors:** placed by the same `fits()` rule: on one face, 0.8 m from its ends, nothing within 1.5 m in front.
- **Stone keep-outs:** `Builder.doorHoles`; the stone layer leaves the door holes free.
- Why the carve and not the wall records: 29 doors pass through castle geometry that is not a `Builder.wall` face (round-tower drums, batters, string courses). Cutting door holes into wall faces and deleting the carve left those doors blocked (three key paths failed), so the carve stays as the single door cut and the castle's own door cuts went.

Other fixes
- **"Open door" at the floor.** `rayBox` returned 0 when the ray started inside the box, so a fly camera inside a shut leaf "aimed" at it whatever it looked at; the windlass's coarse box did the same. `rayEnters` ignores a box the eye is in, and the windlass has precise boxes.
- **Leaf and rebate.** The leaf is the clear outline grown by 5 cm and laps the stop all round. The rebate is the outline grown by 8 cm with the same arc centres. The stop is 5 mm behind the shut leaf.
- **Leaves that hit something** when they swing (walls, steps, another leaf) are hung on the other jamb, or opened into the other room (`fitHinges`).
- **Door heads under spiral steps:** a door whose head would cut the steps above takes a lower head (`doorUnderSteps`).

Whole-castle invariant (`tests/world.test.ts`): the island castle and the interior built and carved as `main.ts` does, then every opening checked.
- No two castle openings overlap on a face, and no hole is cut twice: by a castle opening and a door, or by two doors.
- No castle surface is left in a doorway (rays 1 cm inside the outline go through). For outdoor doors, the hole is not bigger than the outline (rays 1 cm outside hit the face). This is the "exterior hole matches the reveal within 1 cm" check.
- Every jamb plus its rebate opens into a room on each side.
- Each outdoor door has exactly one outdoor face, is 0.8 m from that face's ends, and has nothing within 1.5 m in front.
- No leaf swings through a wall, above the ceiling, into spiral steps, or into another leaf's sweep.
- A second test mutates the plan and the geometry and checks that each kind of fault is reported.

On main before this branch the test lists 16 faults:
- cut twice: the gate, `court>stairtower` and `stairtower>N1-5`;
- `court>N0-4`: castle surface in the doorway, a hole bigger than its outline, and jammed against the stair tower;
- the holes of `court>E0-2`, `court>W0-2` and `court>stairtower` are bigger than their outlines;
- seven leaves swing into other leaves (N4/N5/N6 stair-tower doors, `E0-1>E0-2` with `court>E0-2`).
On the branch it passes.

Other tests
- doors.test: no prompt for a floor ray by any door, leaf open or shut, from inside the leaf or 0.4 m out. Leaves lap the stop and clear the rebate.
- portcullis.test: no prompt looking at the floor by the windlass.
- island.test: the camera keeps 0.3 m from the gate jambs and the batter, with the interior carving the gate as in the game.
- A scratch walk (not committed) walked into every leaved door with the player's motor: 1,440 walks from both sides, leaf toggled mid-walk. The eye never came closer than 0.32 m to a leaf.

Assumptions (visible, for Anders to veto)
- `court>N0-4` sits 0.75 m further west on the north courtyard face.
- Five stair doors take a segmental head 2.0 m high: `court>stairtower` (was pointed), `great-stair>great-1`, `ne-stair>ne-1`, `se-stair>se-1`, `sw-stair>sw-1` (were round or pointed, 2.05 m).
- Seven leaves hang on the other jamb: `N0-2>N0-3`, `N4-4>N4-5`, `N5-4>N5-5`, `N6-4>N6-5`, `E0-1>E0-2`, `stairtower>N1-5` and `gate4>S4-1`. `N6-4>N6-5` also opens into the other room.
- The stair tower loses the slits on the facets buried in the N wing.
- The leaf laps the stop by 5 cm, and the rebate stands 3 cm round it.
- With `?interior=0` the castle has no doorways at all, because doors are cut only by the interior.

Still open
- Closed leaves, and doorways seen from the courtyard, are dark: the interior materials and the room behind not being drawn from outside. This is the interior light's area.
- A battered plinth strip still leans out beside the stair tower at the N wing junction. It is not a door.
- The SE spiral's light slits were not touched.

## 2026-11-05: frame-rate measurement (stats overlay + benchmark)

Anders: "please measure fps and have stats on rendering so you can improve. now it is quite bad on m4 mac".

Done
- **Stats overlay** (`src/ui/statsOverlay.ts`, I toggles it, `?stats` starts with it): fps, frame time p50/p95, CPU time in the frame callback, GPU time (WebGPU timestamp queries, `trackTimestamp`), draw calls, triangles, render size and API.
- **Benchmark** (`src/debug/bench.ts`): the same bookmarks and walks every run (hero, aerial, gate, door-gate, courtyard, ward, closeup-ashlar, gatepass, tunnel, walk-gate from the spawn, run-courtyard), 1 s warm-up and 3 s measured each. `?bench` runs it after loading and shows the table in the overlay; `__game.bench({ steps, warmMs, measureMs })` returns rows and a markdown table; `npm run bench` drives it from Playwright (headless numbers are SwiftShader: only draw calls and triangles mean anything there).
- `?scale=` sets the render pixel ratio (default: the screen's, capped at 2).

Baseline (live build at 3e3b024, Anders' M4 MacBook Pro, Chrome WebGPU, 1200×897 CSS px at devicePixelRatio 2, 120 Hz screen):

| view | fps | draw calls | triangles |
|---|---|---|---|
| hero / aerial / north / moat / top | 120 | 250–370 | 4.0–4.9 M |
| gate | 77 | 904 | 5.4 M |
| ward | 83 | 1,138 | 5.5 M |
| courtyard | 54 | 2,304 | 5.6 M |
| door-gate | 41 | 1,822 | 5.6 M |
| closeup-rubble / closeup-ashlar | 40–42 | 1,240–1,250 | 5.2–5.3 M |

What the A/B toggles showed on that machine:
- It is pixel-bound. At 600×450 CSS px (a quarter of the pixels) every view above runs at 120 fps, with the same 1,800–2,300 draw calls.
- Door leaves are ~1,600 of the courtyard's 2,304 draw calls: on WebGPU a BatchedMesh draws once per visible instance. Hiding them did not change fps.
- `?ao=0` (no GTAO normal pre-pass) took door-gate from 41 to 57 fps and halved the draw calls; `?stones=0` changed little.

## 2026-11-05: the game starts walking

Anders: "default should be walk for sure". The page now starts in walk mode at the spawn on the lawn outside the gate, facing it, with the tools panel shut; O switches to orbit and F to fly. A `?view=` bookmark, `?shot` captures and the `?test=` scenes keep their review camera as before, and `?play` still forces walking. I checked it in the real page (headless WebGL2): the default URL reports mode `walk`, the player is grounded at the spawn (5.48, 2.66, 29.79), and the tools panel is closed.

## 2026-11-05: loading tunnel in a worker, time-based progress

- Anders: loading lagged with no animation, the light came the wrong way, and the bar sat at 90 % for a long time.
- The tunnel draws in a worker on an OffscreenCanvas (`src/loading/tunnel.worker.ts` → `worker.ts`, loop in `loop.ts`, main-thread fallback in `backend.ts`), so it animates while the castle build and shader compile block the main thread (checked by blocking the page for 8 s). It draws at 30 fps at most, at half the device pixels. The caption is page DOM and only updates when the main thread is free.
- Look: fully black at 0 %. The farthest torch strikes first and the light walks toward the viewer. Far torches keep a minimum size on screen. Daylight at the grille only comes up with the final fill.
- Progress is proportional to time (`src/loading/timeline.ts`). Each boot step gets a share of the bar sized by how long it took on this device last time. Timings are kept in localStorage `moated-castle:boot-ms:v1`, averaged 70/30 with the previous value; the first visit uses defaults. Inside a step, progress moves linearly over the expected time, then slows and never reaches the step's end. main.ts calls `screen.step(label)`, matched without regard to case; unknown labels only change the caption.

## 2026-11-05: combined build on main checked (after #27–#30)

Main at 39996d7, with interior light and visibility (#27), furniture on interior materials (#28), the portcullis and windlass (#29) and furniture kept off the windlass (#30).
- `npm test` passes: 646 tests in 62 files. `npm run build` passes.
- `scripts/walktest.mjs` passed 19/19 in the real page: lowered portcullis, E, passage, courtyard, bridge, revetment and the course. `scripts/doortest.mjs` passed 25/25: the test doors, the castle gate from outside, inside and the windlass. Physics tick median 0.34 ms. 316 draw calls in the door-test castle frame.
- Bookmark captures: spawn, gate, courtyard, ward, course. They are headless WebGL2 and were not checked on WebGPU.
- Still open:
  - The exterior is about 600 draw calls and 4.8M triangles, over budget.
  - The windlass has no collider.
  - The passage stone just inside the gate arch is overexposed.
  - The courtyard has no paving, and the well has a bare crossbar.
  - The great hall is only a small room.
  - The torch has no bracket.

## 2026-11-05: main gate is a portcullis with a working windlass (branch `gate-portcullis`)

Anders, on the live gate (`castle-plan/feedback/gate-door-bad-1531.png`): "why would we have a door like that. why is it not just the fence … that goes up/down (please add the rope and rotating stuff on the inside so it is 'real')". And on doors: "Either no wooden door, or the entire wood thing is a door."

Done
- **No oak gate.** The plan's `gate-main` is leafless (`leaf: false`, kind `gate`), and the portcullis is the only thing that closes it. There is one gate and no duplicate: the old `gateDoorSpecs` / `main-gate` / `main-portcullis` are gone. `placeLeaves` never gives a gate leaves.
- **Whole leaves only.** The wicket code and the two-leaf gate code (sag, judder, the stud grid) are deleted from doorParts, doorGeom and doors. Every door with a leaf is one whole leaf.
- **`src/castle/interior/portcullis.ts`** holds only pure code:
  - Placement from the gate's DoorSpec. The groove sits 0.5 m from the inner face of the 2.6 m wall, so it lies under the gatehouse room. The shell's jamb grooves moved to match.
  - The state machine: `portCommand` / `portStep`. It heaves up unevenly (sin² pulses × a per-tooth effort) with a clank per 9 cm ratchet tooth, about 6 s in all. It drops on the brake at up to 2.6 m/s, about 1.3 s, and the spikes seat 12 cm into sill sockets with a thud. It holds rather than come down on anyone under it.
  - The collider: one kinematic box, only while the spike tips are below 2 m.
  - The winch pose: rope length = drum radius × angle, and the coil widens as the rope winds on.
  - The geometry: 8 cm square bars, flush half-lapped crossings with a rivet head on each face, a spike per upright, and a heavy top rail with two lifting eyes. Also the sill sockets, a slot in the arch head and a slot in the room floor.
- **Windlass** in the lowest room over the raised grid (plan room `gate2`, floor 13.6 m): a horizontal oak drum (r 0.23 m, 3 m long) on two timber A-frames with sole plates and runners, a six-spoke capstan head at each end, an iron ratchet wheel (16 teeth = one per tooth of lift) with its pawl, and two hemp ropes running down into a floor slot. It rotates with the lift. Everything goes into the existing two door BatchedMeshes, so there are no new draw calls.
- **Use:** E on the grille from outside or inside, or on the windlass, raises or lowers it (the `gate-main` and `gate-main:winch` interactables). NPCs can call `request('gate-main', …)` from the grille or the drum; `isPassable('gate-main')` is true once the spike tips are above 2 m.
- Merged with #17 (physics player): `main.ts`, the island test and key path 1 build the gate from `portcullisInPlan`; `gateDoorSpecs` and `gatePortcullisSpec` are gone. In walk mode the grille is a Rapier kinematic box while it is low.
- Cell visibility (#27): `setVisible` covers the portcullis.
  - `gate-main` shows the grille, following the gate's spaces.
  - `gate-main:winch` shows the drum, ropes and coils, following `WinchSpec.room`.
  - The fixtures stay while either of them is shown.
  - `main.ts` registers both next to the leaf doors.
- **Door leaves no longer render white indoors** (the furniture thread found them in the undercroft). The cause was the outdoor wood and iron under the +2.5 stop interior exposure. Now:
  - Leaves take their floor's interior material: `IM.adopt` above ground, `IMu.adopt` in cellars and tunnels, as the furniture does. The portcullis and windlass use `IM` too.
  - A batch has one material, so `main.ts` joins two door systems (`joinDoors`: above ground with the portcullis, and underground). The locked grille uses `IMu`.
  - Door geometries carry `interiorRoom = -1`. Leaves are not room-tagged (a batch geometry is shared by many rooms), so they take the ambient floor, the sun and the fires, not row 0's daylight.

Checked (after merging #17, #26, #27 and #28)
- The real page (headless WebGL2), as the player with the player's own controls:
  - `scripts/walktest.mjs`: 19/19. From the spawn, the lowered portcullis stops you 1.72 m into the gatehouse (the groove is at 2.1 m). `__game.use()` raises it, and you walk the passage (10.5 m in) into the courtyard.
  - `scripts/doortest.mjs`: 25/25.
    1. Walking straight at the lowered gate, you are stopped 0.38 m short of the groove.
    2. With the crosshair on the grille ("Raise portcullis"), E raises it: 0.35 of the way after 2 s, still blocking while low, clanks heard, fully up after about 7 s.
    3. Walk in 9 m.
    4. Turn round, look up and use it: it drops and seats with a thud.
    5. Stand in `gate2` with the crosshair on the windlass: E raises it.
- Key paths (`tests/keypaths.test.ts`):
  1. Bridge end → stopped by the lowered portcullis → a request from where you stand raises it (more than 3 s) → on through the passage to the courtyard.
  2. **New path:** courtyard → gate-1 → S0-1 → S0-0 → se-0 → up the SE tower stair → se-2 → S2-0 → S2-1 → `gate2`, to the drum. There the winch lowers the portcullis (under 2.5 s) and raises it again (more than twice as long).
- Unit tests: `tests/portcullis.test.ts` (19).
  - Placement from the real plan, including every vertex of the frames, drum and spokes staying inside room `gate2` at any angle.
  - The state machine, the winch pose and the geometry.
  - Aiming from both sides and at the winch, the collider appearing and disappearing, holding over an NPC, rope shortening in the batch matrices, and NPC requests.
  - `tests/doors.test.ts` is updated for whole leaves.
  - New tests for cell visibility per part, for `joinDoors`, and for the untagged room attribute. 646 tests in all.
- Interior door look (headless WebGL2, `?shot` exposure):
  - A cellar leaf beside the torch (`N-cellarstair>N-c1`) and the undercroft leaf (`N0-0>N0-1`) read as dark oak in line with the walls.
  - The windlass timber reads as timber, where before this change it was bleached.

Numbers:
- Gate, windlass and ropes: about 8.1k triangles, in the above-ground door batches.
- `doorTriangles` is 304k with all 241 interior leaves.
- Doors are 4 batches (wood and iron × above ground and underground), plus 2 for the locked grille.
- The gatepass frame is 322 draw calls.
- Coverage on doors, doorGeom, doorParts, doorBatch and portcullis: 100 % lines, except doorParts statements at 98.9 %.

Captures (`castle-plan/interior/doors/`): castle-gate-lowered, castle-gate-raised, castle-gate-walked-in, castle-gate-inside-lowered, castle-passage-raised, castle-winch-lowered, castle-winch-raised, castle-winch-room, cellar-door-interior-material, undercroft-door-interior-material.

Assumptions (for Anders to veto)
- The portcullis starts raised.
- The grille sits 2.1 m in from the outer face (0.5 m from the inner face), under the room above, rather than just behind the outer arch.
- The windlass is in the first gatehouse room above the gate (`gate2`, 13.6 m). The plan has no gatehouse room on floor 1: the passage vault fills up to 8.5 m. The raised grid stays inside the masonry (its top at about 11.3 m), and the ropes go down through a slot in the room floor.
- Ropes, not chains; no counterweight; a drum windlass with capstan spokes rather than a treadwheel.
- The test scene's gate is portcullis-only too, with no windlass, because there is no room above it.

Known issues
- With `?furniture=1` the furnishing pass does not know about the windlass, and could place furniture in `gate2` on top of it. `dress.ts` `keepOutFor` would need the windlass footprint.
- The rivet heads are small (2.2 cm) and read as dots from a few metres away.
- The windlass has no collider: the player walks through the drum and frames.
- Leaves and the windlass get no room daylight; they need per-instance room tags, which BatchedMesh does not have. In rooms lit mostly through windows they can read darker than the walls, and the windlass timber is dark in shade.

## 2026-11-05: interior light, eye adaptation, cell visibility, see-through windows (branch `interior-light`)

Done
- `src/render/interiorLight.ts`: `makeInteriorMaterials(M, sun | null, light)` clones stone/timber/iron/glass with `lightsNode = lights([sun])` (no outdoor hemisphere or sky IBL indoors) and their own irradiance; `sun: null` is the cellar/tunnel set (no direct sun underground). `setDynamicLights(lights)` (non-enumerable) adds the fire rig's light pool. `bakeInteriorLight(groups, occluder, { plan, windows, sun, light })` tags every interior triangle with its room, turns the castle window lights and the plan's doors into apertures, checks each window's sun with three-mesh-bvh, solves split-flux bounce per room (stairs and open doors carry light on) and packs one float table; `update()` on time of day, `setDoorOpen(id, 0..1)` from `doors.state()` every physics tick. `buildShadowSkins` adds hidden casters inside walls and above ceilings; the interior meshes themselves cast no sun shadow.
- `src/render/interiorShader.ts`: per pixel, each aperture of the room is an area light with its exact form factor, clipped to the glass the point sees through its splayed embrasure; plus bounce and a readability floor.
- `src/render/exposure.ts`: eye adaptation from a 32×18 log-luminance reduction of the HDR scene pass; 0.72 outdoors, up to +2.5 stops in rooms and +3.2 underground. `?exposure=` fixes it; `?shot` sets it from where the camera is.
- `src/world/visibility.ts` (`visibleSet`, pure and unit-tested): inside, the camera room's group plus the groups of rooms joined by a door or stair and stairs within 12 m; outside, windowed groups within 40 m whose openings face the camera; underground, terrain, water, vegetation, the castle exterior, its stones and the gate are hidden. `register(obj, roomOf)` and `isRoomVisible(id)` for NPCs, door leaves and the fire rig. Door leaves follow their rooms through `DoorSystem.setVisible(id, v)` (BatchedMesh instance visibility).
- `src/render/windowGlass.ts`: exterior glass is tagged per triangle with the visibility group behind it (only where the shell built an embrasure pane). Shown group: main's see-through leaded glass. Culled group or no room: the opaque dark pane. Rooms with firelight glow warm in the quarries after sunset (full on the dark pane, half over see-through glass). One material, a per-group flag texture.
- `src/render/interiorFire.ts`: fire sources for `src/light`: the furniture's emitters and flames with `?furniture=1`, otherwise one wall torch per hall, gate room and undercroft and one every ~10 m in tunnels. `LightRig` (8 plain lights, no shadow-casting ones) lights the nearest fires in shown groups; flames via `makeFlameSprites(linkFlames(...))`.
- `?test=room` (`src/debug/roomtest.ts`): a 12 × 8 × 6 m hall and a chamber for tuning the light.

Numbers (headless WebGL2, SwiftShader): bake over the shell 206 rooms / 767 apertures / 240k triangles ≈ 0.45 s in the browser (room tagging dominates; box cull + group fast path took it from 7.2 s in node), BVH over 366k triangles ≈ 0.26–0.5 s. Draw calls / triangles per bookmark (`__game.state()`, 1600×900, before = main as reviewed, all 85 groups drawn):

| bookmark | before | after | interior groups shown |
|---|---|---|---|
| gate | 2,068 / 9.2 M (main after #17) | 522 / 6.0 M | 9 |
| courtyard | 1,400–1,900 / 5–7.4 M | 710 / 5.8 M | 43 |
| hall (N1-2) | 1,400–1,900 / 5–7.4 M | 356 / 5.0 M | 3 |
| tunnel | 168 / 2.6 M | 25 / 0.05 M | 3 |
| hero | 1,400–1,900 / 5–7.4 M | 612 / 4.8 M | 0 |
| cellar (N-c1) | – | 45 / 0.13 M (54 / 0.19 M with furniture) | 5 |

Known issues / next
- Exterior cost is now the bulk: the hero view with no interior group shown is ~600 calls / 4.8 M triangles (stones, vegetation, shadow cascades, AO pre-pass).
- Faint diagonal banding on cellar floors remains with no sun and with `?ao=0`; cause not found yet.
- Furniture props keep the outdoor materials (hemisphere light), so at +3 stops underground light props such as sacks blow out to white; they should move to the interior lighting.
- Window records with real embrasure sizes from the shell would beat the guessed ones; windows whose embrasure was skipped stay opaque.
- Portals between rooms are uniform; rooms that are not convex get light through their own corners.


## 2026-11-05: window placement (no more openings cut by a wall junction)

Anders: "how the fuck do you place a window cut off like that. one does not build like that" (arched windows half inside the gatehouse and towers, voussoirs through the next wall; slits at tower corners).

Done
- One rule in `src/castle/openings.ts` (pure): an opening with its dressing (jambs, sill, voussoirs, hood) lies wholly on one wall face, 0.8 m from the face's ends and from any other building in front of it or against it (wings, towers, gatehouse, east turret, courtyard stair tower; open air 1.5 m out), and 0.15 m from the plinth, string courses, floor lines and the corbel table / parapet. If it does not fit it moves up or down within its storey, then slides along the face up to 1.5 m; otherwise it is left out. Wings (outer and courtyard faces), square towers, the gatehouse front and the east turret use it; round-tower openings keep their angle and are left out where a wing or band would clip them.
- Default seed: 338 openings planned, 39 moved (16 along the face, 25 up or down), 85 left out. 61 of those were buried inside a neighbouring building (tower faces inside wings, windows behind the turret and gatehouse); 24 were visible: windows right against the gatehouse, east turret and courtyard stair tower, the S wing's top-floor row (its lintels ran into the corbel table), the square towers' ground-floor loops (half in the battered plinth) and one NE-tower slit under the E roof.
- The interior shell's embrasures follow automatically (they come from the exterior openings). `ShellResult.embrasures` lists them; on main 7 embrasures looked at another building within 1 m, now none.
- Cone roofs and the pyramid roofs (east turret, stair tower) get a soffit under the eave, so the sky no longer shows through the overhang as a white seam.
- Tests: `tests/openings.test.ts` (default seed + 4 seeds: every placed opening inside its face with clearance, clear of every other building, no overlaps) and an interior test that every embrasure sits behind a placed opening.

- Review items: 8 (N courtyard window behind the stair tower) is one of the drops; 7 (towerroom "blind" niche): both great-2 embrasures open onto real windows (`niche-north`, `niche-south` captures), the niche only looks blind from the bookmark's oblique angle; 11 (cone seam) is the soffit.

Numbers (default seed): exterior bins before carving 116k → 98k triangles (before the soffits), window lights 300 → 222, embrasures 141 → 135. After merging main: `__game.state()` castleTriangles 128,135, interior 239,714 triangles; gate 1,448 draw calls / 7.27 M triangles, courtyard 1,390 / 6.49 M, ward 1,476 / 7.22 M (still over budget, review item 5). Captures: `castle-plan/windows/`.

Next
- The S wing top floor now has courtyard windows only; give it dormers or lower its corbel table if Anders wants windows there.
## 2026-11-05: physics player (branch `player-physics`)

Done
- Rapier 0.21 (compat build) world, `src/physics/world.ts`: fixed 60 Hz accumulator with render interpolation, static trimeshes from render meshes (`addObject`, glass skipped), an open terrain trimesh from the near-terrain grid with holes under building footprints, interior `terrainHoles` and the test course (so cellars at −2 m and the moat tunnel at −6.5 m are reachable from below), the landscape's near rocks on the island (instanced meshes, one trimesh copy per instance), an invisible island boundary that only exists from `heightAt − 1` upward, kinematic boxes and raycasts per the interior contract (`src/castle/interior/types.ts`, verbatim). Several characters per world; collision groups keep rays off characters and the boundary.
- `CharacterMotor` (`src/character/motor.ts`): shared by the player and future NPCs. Takes an intent (wish direction, jump, crouch) and a `CharacterBody`; does acceleration and friction, limited air control, coyote time and jump buffer, crouch that will not stand up under low ceilings, autostep 0.3 m, snap-to-ground 0.4 m, 50° slope limit, wall sliding, landing and footfall events.
- `PlayerController` (`src/player/controller.ts`): maps keys to intent and drives the camera: eye 1.62 m (0.98 crouched), head bob and cadence that differ for walk and run, step smoothing, landing dip, FOV kick when running. Mouse look reuses `MouseLook` from main. Procedural footsteps by surface (stone, wood, grass, dirt; M toggles).
- Everything is injected (physics, input, clock, camera view, audio); `src/player/setup.ts` wires it for `main.ts` and the island test alike.
- Walk mode is now the physics player; orbit and fly stay. P/F/O switch, walk bookmarks teleport the player, `?play` starts walking at the spawn south of the gate. The bridge has landward steps up to the deck.
- `?test=walk`: a movement course on the east lawn (stairs 0.15/0.20/0.30/0.35, 30° and 55° ramps, a low beam, and stairs down through a hole in the ground into a tunnel). `scripts/walktest.mjs` drives it in the real page.
- Interior on physics: the shell's collision soups (`buildInterior().collision`, glass excluded) are static meshes, so every room, stair, cellar and tunnel is walked on real geometry (no `canWalk` gating any more). The terrain keeps its ground in the courtyard (it was holed with the whole castle footprint) except in the stair tower. With `?furniture=1` the furniture's box soups are static colliders too.
- Doors on physics: the gate's leaves and portcullis (`gateDoorSpecs`, untouched here; the gate-portcullis branch owns them) and every leaf door of the plan except the gate (`kind !== 'gate'`; 243 leaves, one batched build through doorBatch) are kinematic boxes in the same world, stepped each fixed tick (`playDoors()` picks the sets). `sallyport-grille` is built as its own never-opened system with no interactables. Leaves stop the player and any NPC motors (`setupPlay().characters`), and the use ray is blocked by walls via physics raycasts. `?test=doors` walks with the physics player too.
- Camera clip margin: the eye stays on the capsule axis (sway clamped to the 0.02 m skin), its height is clamped inside the capsule (≥ r, ≤ height − 0.1), and the walk near plane is 0.06 m (0.25 m otherwise), so the near-plane corners reach 0.133 m from the eye at FOV 76 / 21:9, under half the 0.3 m radius. `tests/island.test.ts` walks into walls, the gatehouse, the batter and a low beam and asserts the eye stays ≥ 0.3 m from every collider (0.313 m measured at the closest wall) and, after subtracting the relief of the real 3D stones there (measured from StoneSet), still more than the near-plane reach + 0.03 m.
- Key paths (`tests/keypaths.test.ts`, vitest, no browser): the same motor and colliders as main.ts, steered along the interior nav graph. (1) the bridge end (0.5 m short of the break) → `gate-main` (gate open) → gate passage → courtyard; (2) the shut courtyard door into W0-2 stops you, opened it lets you through, then W0-2, W0-1, W0-0, sw-0 → SW tower spiral → sw-1 on floor 1; (3) great-tower cellar → moat tunnel down to −6.5 and up the far flight → stopped 0.2–1.2 m short of the locked `sallyport-grille`. Doors on the way are opened as E would.
- Fixed for path (3): the sally-port housing's back face lay on a boundary between two of `tunnelCarve`'s 1 m carve pieces, so neither carved it and it closed the tunnel's last flight (also visible from inside). `portal()` now adds a carve volume for the bore.
- HUD: main's `src/ui` HUD through `wireGameHud` (the physics rig is the `RigLike`; MouseLook's lock change and rig mode changes call `ui.sync()`); the walk help adds Space jump and C crouch. The interim `MinimalHud` is gone. P / F / O and M stay as keys.
- Bridge: the new bridge plan's walkable deck (`walkable`, `d`) gives the boundary its corridor (`bridgeInfo`); the island tests use main's own bridge and revetment build (`tests/world.ts islandCastle()`) and a test terrain at the real near-grid resolution (0.9 m cells).
- Debug: `__game.player` (pos, teleport, look, state, spawn), `__game.input(keys, ms)` (steps physics synchronously, returns cost and a trace), `__game.physics` (stats, raycast), `__game.probes`.

Numbers (headless WebGL2 on a shared 4-core box, load ~22): physics init 4.8 s with the interior (Rapier wasm 0.16 s, collider build 3.1 s for 423k triangles: castle 148k, interior 239k, terrain 32k, rocks 6k; it was 0.8 s for 152k without the interior). Physics tick (player + world step) median 0.31 ms, mean 0.51 ms. Captures at 1600×900: gate 2068 draw calls / 9.2M triangles, courtyard 1576, hall 992 (the whole page; colliders draw nothing).

Walk test (`scripts/walktest.mjs`, 18/18 after the HUD merge): closed gate leaves stop you on the sill, open gate lets you through the passage into the courtyard, east wall, revetment at 6 edges, bridge to the break, every course lane, the tunnel under the ground).

Known issues / next
- Key paths are steered with the nav graph's room centroids and door points; they are not a navmesh and walk only the three paths above. Untested by walking: other stairs, upper floors beyond sw-1, wall walks.
- Door leaves do not push the player; a leaf stops against a standing character (doors.ts) and the player stops against a leaf.
- 0.15 m steps are ridden by snap rather than autostepped (it looks the same).
- The test course does not cut the render terrain; the tunnel hole is visible only from the physics.
- Collider build time should be measured on the M4; if it is long, split the castle trimesh or build it in a worker.

## 2026-11-05: stone close up (branch `stone-closeup`)

Anders: "this does NOT look good close up" (`castle-plan/feedback/2026-11-05-stone-closeup-bad.png`). The problems were flat, plastic slabs; a staircased dark outline round every stone; uniform speckle; a closed crack loop; and mortar drawn as a line.

Done
- Joints from a signed distance (`src/render/texgen.ts` `masonry`, `stoneDistance`). Each stone is its cell inset by half a joint, with slightly tilted edges, rounded or knocked-off corners, smooth edge noise and chipped arrises. data.a stores the distance to the outline (±4 cm rubble, ±2.5 cm ashlar, ±1.5 cm dressed). The shader (`jointMask`) sharpens it with `fwidth`, so edges are smooth at any magnification. When a pixel covers several texels, it fades to the mipmapped mortar coverage in data.g. Course warp is low-frequency only, so joints no longer wobble.
- Mortar: a lighter, sandy lime bed, painted in the shader from the SDF. The albedo texture carries the stone colour on under the joints, so mips never mix mortar into stones. Rubble joints are deep-raked; ashlar and dressed joints are nearly flush (`mortarLevel`). Joints are darkened only by baked AO (albedo.a), GTAO and the parallax self-shadow. The cavity darkening of mortar now applies only beyond ~15 m.
- Per-stone rock: five lithologies (granite, limestone, sandstone, whin, greywacke). The kind is encoded in the stone id byte, `lith * 51 + rand`. Inside a stone: mottling, bedding (sandstone, greywacke), darker weathered patches, iron staining, quartz veins (straight, crossing the stone) and short open hairline cracks from an edge. There are no loops and no uniform pits. Rubble faces are split facets with a little pillowing. Arrises are rounded: 1.6 cm rubble, 1.2 cm ashlar, 0.8 cm dressed. Pinning stones are rarer and larger.
- Detail layer (`stoneDetail`, 1024² RGBA, repeats every 0.8 m, 0.78 mm texels): crystal grain (Voronoi crystals), mineral flecks in clusters, two scales of weathering pits ranked so one threshold sets the density, and claw-tool striations. The shader rotates and shifts it per stone, with rotated gradients so mips stay right across stone boundaries. It builds a detail normal from three taps, weighted per lithology and per stone, and blends it with the base normal (UDN). The layer fades out between 3.5 and 9 m. Mortar uses the same taps as sand grain and grit.
- Albedo and roughness: grey overall with warm and cool stones mixed (R ≥ B in every lithology). Roughness varies per stone, pale flecks are a little glossier, and the damp base is smoother. Crustose lichen spots appear where it is damp: pale grey-green, a few orange.
- Parallax: up to 1.8× more layers below 6 m, and 5-step binary refinement instead of linear, so there is no slicing or swimming at 0.5–2 m. Rubble depth went from 7.5 to 6 cm.
- Bookmarks `closeup-rubble` (1.2 m, SW tower), `closeup-ashlar` (1.5 m, S wing), `closeup-shade` (north face), `closeup-corner` (SW tower quoins, 3 m). Their targets sit 9 m out because `go()` runs OrbitControls' minDistance 8.
- Tests: `tests/texgen.test.ts` covers SDF sign and continuity at the outline, mortar set-back, AO, per-stone and in-stone variation, no blue, veins, cracks, iron and pins, id/lith round trip, and the detail texture (determinism, content, tileable Voronoi). texgen.ts is in the coverage include at ~100 % lines. All generators take size, rng and noise as parameters.

GPU depth instead of plain 3D stones (Anders on the live site: "it looks terrible up front", `castle-plan/feedback/closeup-wall-live-1525.png`: soft pillows, blurry pits, stair-stepped black joint edges, a flat untextured slab)
- Parallax (`materials.ts` `parallax`): the number of layers follows the ray's length on screen, or in texels if coarser: about one layer per 1.5 px, 6–64 layers, with an early out. So no joint is stepped over at 0.3 m or at grazing angles, and 5 binary refinement steps put the hit within 1/32 of a layer. This removes the stair-stepped joint edges. Depth is in world metres on every mesh (rubble 6 cm, ashlar 5 cm, dressed 2.5 cm; uv = metres / tile).
- Pixel depth offset (`material.depthNode`): the fragment depth is where the ray hit, so the ground, steps and other walls meet the stones, not the flat polygon. The depth pre-pass for GTAO uses the same depth. The shadow pass uses its own override material and is unaffected.
- Self-shadow: a second march towards the actual sun direction (4–16 taps, by the ray's length on screen), weighted towards its start, gives crisp contact shadows between stones. Up to 88 % of the sun is blocked.
- Crevices: a narrow, occluded band where the mortar meets each stone, taken from the SDF (crisp at any distance). It darkens albedo and indirect light. Per-stone value and warm/cool spread are a little wider.
- Wall foot: soil and moss fill the lowest joints first and then creep over the stones, within ~0.3 m of the island ground (a height blend on the masonry depth). Normals flatten there and the depth offset shrinks to match. This is the MeshBlend idea (`castle-plan/feedback/reference-sergeev-meshblend.png`) done in one shader.
- 3D stones cut back (`stones/field.ts`): plain stones are built only within `LOD.plain` (default 0), so real stones remain only on silhouettes (merlons, parapets, buttresses, turrets, quoins and the revetment edge). Their distances are now hi 8 / mid 20 / lo 32 / silhouette 45 m (were 8/24/40/80). `?stones=all` restores every stone for comparison.
- The untextured slab was the sides of 3D stones: every side vertex sampled the same edge texel of the squeezed face UVs, so 6–9 cm of side showed one smeared texel. Sides now fold the texture inward by their depth below the face (`stones/mesh.ts` `push`), so they carry stone at its real density.
- New bookmark `closeup-walk`: on foot at the S wing foot, 1.1 m out, looking west (Anders' viewpoint).

Numbers
- Stone triangles, from `__game.state().stones` (the frame counts them twice, once more in the GTAO pre-pass): closeup-rubble 1,654,722 → 235,556; closeup-ashlar 1,588,976 → 217,412; closeup-shade 1,765,172 → 548,704; closeup-corner 1,492,346 → 235,194; gate 679,264 → 99,220. For comparison, the frame without any stones is ≈ 2.6M (terrain, vegetation and castle, also counted twice).
- Texel density unchanged: 512 texels/m base (2048 px per 4 m tile), plus the detail layer at 1280 texels/m. Raising the base resolution was not needed, because the SDF carries edges and the detail layer carries grain.
- GPU memory for stone: rubble and ashlar 3 × 2048² RGBA8 with mips ≈ 67 MB each, dressed ≈ 17 MB, detail +5.6 MB. That is ≈ 156 MB, of which only the 5.6 MB detail texture is new.
- Generation (single thread, node, same machine back to back): rubble ~9 s, ashlar ~8–9 s, dressed ~2 s, detail ~2–3 s, against old rubble ~10 s, ashlar ~7.5 s, dressed ~1.7 s. The worker pool runs these in parallel, so wall time stays at the slowest job. The container was heavily loaded (load average 15–30) while this was measured, so treat these numbers as rough.
- Shader: per stone pixel, 3 detail taps + 1 lichen tap, 5 binary-refinement height taps, and up to 1.8× march steps below 6 m. Triangles and draw calls are unchanged (castle 113,962 triangles).

Known issues / next
- Silhouette stones that are still 3D (buttresses, `closeup-shade`) look pillowy at 0.5 m. Their sides are textured now, but they show swirls where the fold meets the face.
- The window jamb blocks stick out of the rubble towers as plain boxes.
- Rubble faces between the facets are still smooth at 1 m. A real split face needs sharper conchoidal ridges.
- POM silhouettes on outside corners (FPOM-style clipping) and the camera-following displaced patch (phase 2) are not done. Corners keep the 3D quoins instead.
- The pixel depth offset turns off early-z for stone. Measure it on WebGPU at 1440p; the march itself is bounded at 64 + 5 + 16 taps.
- Upper rubble walls in sun at 3–8 m show strong dark undersides from the deep raked joints. This is plausible, but heavier than the reference photos.
- Sunlit ashlar in `gate` measures sRGB ≈ 115, against the STYLE target of 90–100 (it was ≈ 107 before this branch).
- Bright mineral flecks can still read as salt at 0.5 m on granite stones.
- WebGPU not run here (headless WebGL2/SwiftShader only).

## 2026-11-05: see-through window glass

Done
- `glass` (src/render/materials.ts) is transparent: the diamond quarries are ~20 % opaque, the lead cames stay solid, double-sided, no depth write. From the courtyard you now see the room behind a window (floor, walls, ceiling beams); from inside, the trees outside. Checked with captures from 4 m and 1 m outside a N-wing courtyard window, the gate bookmark and the towerroom bookmark (headless WebGL2). Not checked on WebGPU.
- Visual review findings (opaque windows, wicket gate, no interior door leaves, sunlit cellar, pillow stones, draw calls) went to the castle thread.

## 2026-11-05: furniture in the castle rooms (behind `?furniture=1`)

Update: furniture now takes the interior clones of its materials (`InteriorMaterialSet.adopt`, underground set for cellars and tunnels) and is room-tagged after the bake, so it gets the room's daylight, irradiance and firelight instead of the outdoor sky (sacks no longer blow out underground).

Done
- `src/props/dress.ts` (pure): every room gets a role from its kind, floor and size (hall, chapel, bedchamber, solar, study, guard room, kitchen, store, cellar, gate, passage) and a recipe that puts props against walls, in the middle, on table tops, on walls (sconces, tapestries) and from the ceiling. Tall props and hangings go on inner walls only (outer walls have windows). Props come from 6 seeded variants per kind.
- Walkable by construction: clear zones inside every doorway (door swing + a step) and around straight stair ends; after placing, a flood fill on a 0.2 m grid (agent radius 0.3 m, wall clearance) must still connect every door of the room, or props are taken out again, last first. Tests check this for every room of the plan.
- `src/props/furnish.ts`: one object per interior visibility group (`Map<group key, Group>`, parented under the group so it hides with its rooms), light emitters and box-collider triangle soups per group (`__game.furniture`). Main builds it only with `?furniture=1` until Anders approves furniture in the castle.

Numbers (default seed): 1,405 props in 206 rooms, ~755k triangles in total, at most ~41k in one group (N:2), 7 materials per group, 322 emitters (sconces, candles, chandeliers); dressing takes ~0.6 s.

Next
- Interior light: turn `furniture.emitters` into lights; switch props to the interior materials.
- Window positions are not in the plan, so the "inner wall" test is a heuristic; expose embrasures from the shell to place low furniture under windows correctly.
- Triangle budget: with all groups visible the furniture adds ~755k; it relies on the interior visibility culling.

## 2026-11-05: firelight (shared flame and light system, `src/light/`)

Anders: "what we really need to nail here is amazing lighting. realistic flames and warm great feeling". One system for every fire: the prop kit, the castle interiors (interior-light consumes it) and later NPC-carried torches.

Done
- `types.ts`: `FlameKind` (candle, torch, lantern, brazier, hearth), `Flame` (base, height, up) and `LightEmitter` (the prop kit's `Emitter` is now this, with a `kind`).
- `flicker.ts`: deterministic flicker per kind and seed: slow breathing, a faster lick, crackle and occasional gutters (a draught pulls the flame down for ~0.2 s), plus a small wander of the light centre so shadows move. Profiles hold colour temperature, candela per candle unit and range.
- `blackbody.ts`: fire colour from Kelvin (1600–2000 K), linear and normalised.
- `budget.ts` + `rig.ts`: `LightRig` keeps a fixed pool of point lights (default 2 shadow casters + 10 plain, so materials never recompile), ranks fires by brightness over distance for any eye, cross-fades sources between pools with hysteresis (no popping), takes an injected `visible(id)` for room culling, and supports `add`/`move`/`setScale` for carried torches and fires that go out. `meanLights()` feeds bounce bakes. Engine-free: the three.js side is a `LightFactory` (`three.ts`); tests use a typed fake.
- `flames.ts` + `three.ts`: flame sprites in three instanced draws for any number of flames: a turbulent teardrop body (two noise octaves, licks that break off at the tip, black-body ramp, blue cup at candle wicks, additive HDR), a camera-facing halo, and a thin smoke column over torches. Each flame is linked to its light, so the flame and the room gutter together. Flame motion runs on a uniform clock (deterministic captures).
- `look.ts`: the warm interior look: Neutral tone mapping (keeps flame hue; AgX turned flames cream), exposure 0.58, bloom on the flames, a whisper of cool fill so shadows are deep blue-grey rather than dead black, a partial white balance (the eye adapting to firelight), mild vignette, dark warm haze. `lookFromParams` for review overrides.
- Warm bounce: `LightProbeGrid` (three r187 addon) baked once per volume with every fire at its mean brightness, one extra bounce (cellar 7×3×5 + tunnel 16×2×2 probes, ~3 s in SwiftShader).
- Prop kit: candles, sconce torches and chandeliers now mark flames (`PropMesh.addFlame`, carried through transforms and `append`) instead of lathe flame meshes; candles get a charred wick, torch heads are charred dark. `props.html` lights its rooms through the shared rig and sprites.
- Review page `lights.html` (`src/light/preview.ts`, geometry in `stage.ts`): a 12 × 7.2 m segmental-vaulted cellar with a supper table and chandelier, a door into a 29 m barrel-vaulted tunnel with torches every 4.5 m. Views: cellar, supper, torch, tunnel, door. Flags: `?t=` freeze time, `?still`, `?exposure`, `?bloom`, `?fill`, `?haze`, `?adapt`, `?tm=agx|aces|neutral`, `?gi=0`, `?shadows=N`, `?lights=N`, `?nowalls` (flames on black for tuning). `URL=http://localhost:5173/lights.html QUERY=t=3.2 npm run shots`.
- Tests: `tests/light/*` with fakes in `tests/light/fakes.ts`; `src/light` at 100 % lines/functions/statements, 99 % branches (`npm run coverage`).

How interiors use it (agreed with the castle build thread): place fixtures, `rig.setEmitters(emitters)`, `makeFlameSprites(linkFlames(mesh.flames, emitters))`; each frame `rig.update(t, dt, eye, visible)` and `sprites.update(flameBrightness(...), t)`. Interior materials add `factory.lights` to their `lightsNode`. The interior-light exposure controller owns exposure and takes `WARM_INTERIOR` as parameters.

Numbers: the review page has 13 emitters and 20 flames → 12 point lights (2 with 512² cube shadows), 3 flame draw calls; prop triangles 12.5k. Castle page unchanged.

Next
- Hook into `interior-shell` rooms when it lands (probe grids per room group, visibility from `createVisibility`).
- Embers and sparks over braziers and hearths; brazier, lantern and hearth props (profiles and looks exist).
- Check frame time on the M4 (WebGPU): shadowed point lights are the main cost; drop to one shadow caster if needed.
- Floor flagstones read a little like modern tiles under raking light; the rubble's pits show at grazing angles near torches.

## 2026-11-05: interior plan and shell (branch `interior-shell`, PR #15)

Done
- `src/castle/interior/plan.ts`: `planInterior(seed)` is a pure function of the seed. It lays out 206 rooms: 20 per wing floor in enfilade, the hall on N1, a chapel in the east turret, tower rooms on every storey including the tops, five rooms over the gate, cellars under the N and W wings and the great tower, and five tunnels. It also lays out 244 doors and 6 stairs. The gate passage (`gate-0` under the gatehouse, `gate-1` through the S wing, 10 m) has the leaved gate `gate-main` (kind `gate`, centred on the gatehouse front's mid plane, width = clear arch, rebate 1.5 m for the portcullis groove and leaves), open arches at the S wing and the courtyard, ribbed vaults and murder holes. There are courtyard doors into N, E and W. Spirals of 1.9 m radius in the four corner towers and the 2.0 m courtyard stair tower (one landing per storey, so main's stair planner climbs whole turns with 2 m headroom), plus a straight cellar stair from N0. The moat tunnel runs from the great-tower cellar at −1.8 down 0.2/0.3 steps to −6.5 (crown −3.8, 1.2 m of rock under the moat bed), back up to a sally port on the far bank, which is barred by a locked grille (`sallyport-grille`). Old work has round heads, new work has pointed or segmental heads, and every door head is fitted below its ceiling or vault (`fitDoorHeads`).
- `validatePlan`: every room is reachable from outside and from the courtyard, the far bank never is, and only the moat tunnel leaves the island. It also checks door sizes ≥ 0.9 × 2.0 m with heads clear of the ceilings, rooms inside the footprint and apart, stair landings on their floors, and each stair against `validateStair`. All 256 seeds pass (64 in CI).
- `src/castle/interior/shell.ts`: room walls with door holes (reveals, rebate step on the leaf side, gate cheeks and portcullis groove). Every exterior window gets an embrasure (splayed niche, glass pane where the exterior is glazed, daylight through open lights). Flagstone ground floors, board floors, beamed ceilings, barrel vaults (pointed in new work), tunnels via `buildTunnel`, and the sally-port housing on the far bank. Every interior volume is carved out of the exterior bins (`carve.ts`), so the zero-thickness exterior shells no longer cross rooms.
- `navGraph(plan)` (`nav.ts`) links room, door and landing nodes, where flights follow `stairNavPath`. `findPath` runs A* and skips locked edges, and `floorPolys` gives clean walkable outlines. Tests show that every room is reachable.
- `buildInterior(materials, ext, deps)` returns groups `${zone}:${floor}` and `stairs:<id>` with one mesh per material, plus colliders per group. `main.ts` adds them and sets `__game.interior`. Use `?interior=0` to build without interiors. New bookmarks: gatepass, hall, chamber, towerroom, undercroft, tunnel, cellar.
- Tests are in `tests/interior.test.ts` and `tests/interior-geom.test.ts`, with coverage of 98–100 % lines over the interior modules (thresholds in `vitest.config.ts`).

Numbers (headless WebGL2, seed default): interior 239.6k triangles (most of it the real stairs), 85 groups, 296 meshes (one per material per group), 131 embrasures, 50 windows skipped (enclosed by towers or other masses). Castle exterior after carving: 131.6k triangles. Carving takes about 2.4 s in the browser and 1.2 s in node.

Captures (1600×900, `QUERY=exposure=1.6`): gatepass, hall, chamber, towerroom, tunnel, undercroft, cellar, courtyard, hero. Copies are in `castle-plan/interior/shell-*.png`. `CameraRig.go()` no longer applies a damped orbit update to walk/fly bookmarks; it had nudged the `courtyard` view into the W wing.

Known issues / next
- Draw calls: all 296 interior meshes together exceed the ~250 budget. The visibility work has to switch groups off, because only a few cells should render at once.
- Exterior windows enclosed by other masses get no embrasure. Two-door landings are not supported by the stair planner, so the stair tower opens onto N or E on each floor, not both.
- Interior light: wired to the shell in `interior-light` (see the section above).

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

- Bookmarks: `CameraRig.go()` ran the orbit control's update for every view. Its polar-angle clamp lifted walk and fly views that look up at the walls to about the target's height, so the courtyard view sat inside the west wing at y ≈ 22. Only orbit views go through it now, so walk bookmarks (gate, ward, courtyard) are at real eye height. The `towertop` view is now over the keep's south parapet, clear of the cap house (it used to sit inside it) and of the corner turret.
- Coverage: `src/castle/**` is in `npm run coverage`. Thresholds: castle lines 99 / functions 100 / branches 92 / statements 99; stones lines 100 / functions 100 / branches 97 / statements 99.
- After merging main (shadows, vegetation, landscape): gate 696 draw calls / 6.44 M frame triangles (stones 0.56 M), ward 682 / 6.09 M (0.54 M), courtyard 570 / 5.92 M (1.62 M), towertop 392 / 5.54 M (1.52 M), rubble close-up 602 / 6.62 M (1.76 M). Walk views now sit at eye height, so these are not comparable with the table above.

Known issues / next
- Triangles: stones add ~0.5–1.8 M per frame in close views (counted twice because of the GTAO normal pre-pass). Trees still dominate the frame budget.
- Geometry is built on the main thread; a big chunk can cost a few ms when it first comes into range. Move to a worker if it shows up as a hitch on the M4.
- Battered round-tower bases (frustums) and arch spandrels are still flat texture.
- Mortar between the stones is the texture's (speckled, grey); the `stone-closeup` branch rebuilds it as sandy lime, and the stones pick that up with no change here.
- `npm test` is ~13 s wall on the loaded container (8 s CPU), above the brief's 5 s: most of it is importing three and building the whole castle twice in `castle-stones.test.ts`.
- The gatehouse plinth runs across the bottom of the gate arch (pre-existing).

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

## 2026-11-05: bridge ruin and moat rim fix

Done
- Revetment (`src/castle/revetment.ts`): fixes the "flying stones". It is now a battered rubble wall that rises from the moat bed, with its face 0.75 m outside the island outline. Coping stones 0.9 m deep sit 5–11 cm above the turf, and three damaged stretches have fallen stones in the water.
- The revetment face records battered stone faces, so the real stones (castle/stones) cover it near the camera.
- Turf strip (`src/castle/turf.ts`): uses the terrain material and covers the near grid's one-cell step under the coping. The island ground holds its level to the coping's back edge.
- terrain.ts, island branch only:
  - the lawn drop toward the rim is now -0.75, was -0.9;
  - the bank is `smoothstep(0.05, 0.35, e)` down to -1.6.
- grass.ts: the island reeds moved out to 1.3–2.5 m, in front of the wall face.
- Bridge (`src/castle/bridge.ts` plus `src/castle/rubble.ts`): a ruined three-arch bridge.
  - Piers with cutwaters, voussoir arches, spandrels, a string course, and parapets with coping. The deck has worn ruts.
  - The middle span fell. Its stubs, core and parapets break back in steps, and the 45-stone rubble heap is half-submerged.
  - The approach is flush at the gatehouse. The deck is walkable to the break, which leaves a gap of at least 4 m, so the far end can't be reached.
  - `plan.walkable` and `plan.deckHeightAt` are exported for the nav graph.
  - Walk mode includes the deck (`withBridge` in main.ts). Walked in the headless game: holding W from the lawn by the gate climbs smoothly onto the deck and stops 1.3 m short of the broken edge. `tests/bridge.test.ts` has a key-path test through the same composition (lawn → deck → edge, never over the parapets, the gap or the far half).
- Plans are pure and take their collaborators as parameters (outlines, `groundAt`, rng, Builder). Tests are in `tests/bridge.test.ts`, `revetment.test.ts` and `turf.test.ts`, at 98–100% line coverage. They include the requested check that the ground 0.4–2 m inside the ring sits no lower than the coping top − 0.3 m, and a replica near-grid check that the terrain never shows in front of the wall.
- New walk bookmarks: `bridge`, `rim`.

Numbers (headless WebGL2, 1600×900):
- Castle bin: 132.8k triangles, of which the bridge is 11.0k and the revetment 5.4k.
- The turf strip is 7.7k triangles in one extra draw call.
- Frame totals: bridge 5.02M triangles / 308 draw calls, rim 5.08M / 302, moat 4.47M / 356, gate 6.03M / 662. Most of that is real stones and terrain, which come from main.

Known issues / next
- `tests/revetment.test.ts` replicates the near terrain grid (380 m / 420 cells). Update `NEAR` there if the grid changes.
- `turf.ts` `rimMask` duplicates the terrain's island ground mask.
- Physics must treat water as a barrier so the far bank stays unreachable.

## 2026-11-05: UI through impeccable (branch `ui-impeccable`)

Anders asked for the vendored `impeccable` skill to be used on every UI surface. Its launcher ran (`impeccable context`); `init` and `document` ran without a live interview (the agent was a subagent), so PRODUCT.md and DESIGN.md mark inferred facts for Anders to confirm.

Done
- `PRODUCT.md` (product truth), `DESIGN.md` + `.impeccable/design.json` (design system "Torchlight on Stone": ink, bone, one brass accent; IM Fell English SC for titles, system sans for everything read at a glance).
- `src/ui/ui.css`: one stylesheet for tokens, loading caption, HUD, tools panel and boot error, linked from `index.html` and `props.html` (the inline styles are gone). The title face is self-hosted (`src/ui/fonts/`, OFL, 57 kB, in CREDITS.md).
- `src/ui/hud.ts` `createHud(deps, opts)`: crosshair dot that opens a brass ring on a usable target, the use prompt ("E Open door"), a help line while the mouse is free, a Controls card on the first pointer lock that fades after 4.5 s (H shows it again), toasts, and the review tools panel (backquote toggles it, Esc closes it; opening it while locked releases the mouse). Document, keys and timers are injected.
  - API for other modules (the physics player): `hud.setHelp(text | items)`, `hud.setPrompt(text | null, key?)`, `hud.setLocked(bool)`, `hud.toast(text, ms?)`, `hud.showControls()`, `hud.promptView` (pass as `createInteraction(..., { view })`). `__game.hud` exposes it for captures.
- `src/ui/tools.ts` `createToolsPanel`: choice (segmented), range, actions grid and select sections; used by the castle page, `?test=doors` and `props.html`.
- `src/ui/gameHud.ts` `wireGameHud(hud, { rig, views, time, walkFrom, search })`: camera mode, time of day (hh:mm), bookmarks, fps, and help per mode and lock state. The rig is an interface, so the physics controller can stand in. The tools start shut when the start bookmark is a walk view and open for orbit and fly.
- `src/ui/help.ts`: help presets per mode, `parseHelp` for old "WASD walk · E use" strings, `?ui=` flags. `src/ui/error.ts`: a boot error with a Reload button instead of a bare text line.
- `?ui` keeps the HUD under `?shot`: `?ui=locked` draws it as if the mouse were captured, `tools` / `notools` opens or shuts the panel, `card` holds the Controls card.
- Loading caption: "Moated Castle" in the title face, the step in words and the percentage apart in tabular figures, `aria-valuetext`; step labels in sentence case.
- `interact.ts` is unchanged: main.ts passes `view: hud.promptView`.
- Tests: `tests/ui/*` (happy-dom + typed fakes for keys, timers and the rig), `src/ui/**` at 100 % lines in coverage.

- The dot also shows whenever something usable is under it, even with the mouse free (drag-look).
- `lights.html` (merged from main) uses the same chrome: tools panel "Firelight", help line, boot error.

Checked in headless Chromium against the merged build (`?webgl&shot&ui`): backquote shuts and reopens the tools (focus goes to "Orbit"), Esc shuts them, H shows the Controls card. Standing 2.1 m from the gate in walk mode, the prompt read "Open gate"; pressing E on the keyboard (the player's key handler) opened it (`main-gate` 0 → 1 after 6 s). Contrast: bone on chip ink ≥ 6.5:1 and brass keycaps ≥ 4.6:1 over white sky (computed). Not checked: real pointer lock (headless cannot grab the mouse) and a real touch device.

Known issues / next
- Captures run on swiftshader on a loaded machine, so the locked HUD in captures is drawn via `__game.hud.setLocked(true)`, not real pointer lock.
- The tools open on orbit/fly start views (`?view=hero` and other review bookmarks); the default page starts walking with them shut.
- With interior bookmarks the Views grid has 17 entries and scrolls inside the panel; group exterior/interior when it grows.
- The help line still names the old walk controls; the physics player should call `hud.setHelp` with its own (jump, crouch).
- No touch controls: on a phone the HUD lays out, but the game cannot be played.
