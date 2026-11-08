# Agents guide

Read `docs/BRIEF.md` (what we are building), `docs/STYLE.md` (look + review) and `docs/PROGRESS.md` (state) first. Skills are vendored in `.claude/skills/` (see `SKILLS.md`); start from `game-dev-index`.

## Commands
- `npm run dev`: dev server (WebGPU; add `?webgl` to force WebGL2).
- `npm test`: plan and generator tests (fast, < 5 s). `npm run coverage` adds a v8 coverage report with per-folder thresholds (`vitest.config.ts`).
- `npm run build`: typecheck + production build (pages `index.html`, `props.html` and `lights.html`, the firelight review).
- `npm run shots [view…]`: with the dev server running, capture camera bookmarks to `shots/` (headless WebGL2). Env: `W`, `H`, `QUERY` (e.g. `ao=0`), `OUT`, `URL` (e.g. `http://localhost:5173/props.html` for the prop kit).

## Principles
- Keep it simple. Build the smallest thing that does the job; no abstractions, options or frameworks before a second real use needs them. Don't over-engineer.
- Don't invent what Anders will see. If a task needs a visible design choice he hasn't asked for (what a gate looks like, a door type, a style), use the plainest choice and name it as an assumption in the PR and report so he can veto it before it gets built out.
- "Works" means used, not looked at. Before saying the player can do something (walk in, open, climb, reach), do it: walk it in the game or run a test through the same code the player uses. A capture of a state is not proof of an interaction.
- Look at your own captures as a player would before reporting them. Anything odd (a hole, a black cutout, a floating piece, a seam, a door that makes no sense) is a defect to fix or flag, not a detail.
- One owner per thing in the world. Before adding something that places or cuts geometry, find the module that already owns that kind of thing and extend it; never build a second system beside it. (2026-11-05: doors were placed by the interior plan and carved into walls whose windows and arches the exterior placed on its own, so the same walls were cut twice and nothing checked one against the other: doors cut by towers, leaves swinging into stone, arches not matching their leaves.) When work is split between agents, the brief names the owner of every shared thing.
- Check the whole world, not a few views. A rule about placement (on one face, clear of junctions, no overlap, clear swing) is a test over the entire generated castle, so a bad layout fails CI before anyone sees it. Screenshots are for looks, not for catching layout mistakes.
- Report what you checked and what you didn't. No "should work"; say which path was walked, which test covers it, and what is still untested.

## Rules
- Coordinates: x east, y up, z south, metres. Moat water y = 0, island ground ≈ 2.6.
- Everything generated is a pure function of the seed: use `rngFor(name)` from `src/core/rng.ts`, never `Math.random`.
- Castle dimensions live in `src/castle/spec.ts`; `tests/layout.test.ts` guards the brief's requirements. Change the spec, not the tests, unless Anders changes the requirement.
- Geometry goes through `Builder` bins (one draw call per material). UVs are metres / tile so courses stay level.
- Stay inside the performance budgets in the brief; report triangles and draw calls from `__game.state()` when you change content.
- Interiors are approved (2026-11-05): every room, doors that open/close, stairs, cellars and tunnels, walk/run. No furniture yet; destruction comes later.
- Tests: aim for close to 100% coverage of logic (`npm run coverage`). Keep rendering glue thin and push logic into pure, tested functions.
- Dependency injection: modules take their collaborators (physics, input, clock, rng, materials, scene, audio) as typed parameters or interfaces, so tests use small type-safe fakes. No hidden globals, singletons or module-level side effects.
- Fire and firelight go through `src/light/` (one flame/light system: `LightRig`, flame sprites, `WARM_INTERIOR` look); don't add point lights or flame meshes elsewhere.
- NPC-ready: navigating NPCs will be added later. Character movement is a reusable motor over `PhysicsApi` (the player is just one user of it); the interior plan exposes a room/door/stair navigation graph; doors can be opened by any agent; nothing assumes there is only one character.
- Wall openings (doors, windows, the gate) have one model: one list from the seed, placed once against the rules, and every consumer (exterior holes and arches, interior reveals and embrasures, leaves, colliders, stone keep-outs) derives from it. `tests/world.test.ts` checks every opening over the whole castle; a new placed feature adds its rule there.
- One model for visibility and LOD: culling (`src/world/visibility.ts`) and levels of detail (stones, lights) decide only how something is drawn, never whether an opening, a door or what is seen through it exists. No LOD level or cull may add, move or remove an opening or a door, and a room seen through an opening is drawn wherever the opening is. `tests/world-views.test.ts` (split from `world.test.ts`, sharing `tests/helpers/worldViews.ts`) checks this over the whole castle from poses in front of every outdoor doorway; a new cull or LOD layer adds its rule there.
- Doors: a door is a whole leaf (or none, e.g. the portcullis-only main gate). No wicket or cutout doors inside leaves.
- Key paths have a test (vitest, no browser, using the same walk/collision code as the player): bridge → gate → passage → courtyard, courtyard → a ground-floor room → stair up one floor, and a cellar → the moat tunnel to the locked grille. Add a path when a feature adds a new way in; don't test every room.
- Look changes (stone, materials, light) get one close-range walk-mode capture (≈ 0.5 m from a wall) as well as the usual bookmarks.
- Coverage thresholds live per folder in `vitest.config.ts`; add new tested modules to its `include`. Example of DI with type-safe fakes: `src/loading/` + `tests/loading/fakes.ts`.

## UI
- Any UI surface (HUD, crosshair and prompts, menus, mode buttons, loading screen, review pages such as props.html) goes through the vendored `impeccable` skill (`.claude/skills/impeccable`): run its context step, follow `reference/craft-floor.md` before editing, and finish with its `critique`/`audit`/`polish` passes. Keep PRODUCT.md and DESIGN.md current.

## CI / CD
- Pull requests run `.github/workflows/ci.yml`: for wall time the tests run as 2 coverage shards side by side (balanced by `vitest.config.ts` SECONDS) plus a job that merges them and checks the coverage thresholds on the merged report, with the build beside them; every merge to `main` deploys to GitHub Pages (`pages.yml`) so Anders can play the latest build.
- Keep each pipeline under ~1-2 minutes: one OS, one Node version, no browser/OS matrix, no headless captures in CI.

## Definition of done
Build, tests and coverage pass (including the key-path tests), fresh captures from at least three bookmarks, anything you claim the player can do has been done once, `docs/PROGRESS.md` updated.
