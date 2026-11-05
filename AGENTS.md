# Agents guide

Read `docs/BRIEF.md` (what we are building), `docs/STYLE.md` (look + review) and `docs/PROGRESS.md` (state) first. Skills are vendored in `.claude/skills/` (see `SKILLS.md`); start from `game-dev-index`.

## Commands
- `npm run dev`: dev server (WebGPU; add `?webgl` to force WebGL2).
- `npm test`: plan and generator tests (fast, < 5 s). `npm run coverage` adds a v8 coverage report with per-folder thresholds (`vitest.config.ts`).
- `npm run build`: typecheck + production build (pages `index.html`, `props.html` and `lights.html`, the firelight review).
- `npm run shots [view…]`: with the dev server running, capture camera bookmarks to `shots/` (headless WebGL2). Env: `W`, `H`, `QUERY` (e.g. `ao=0`), `OUT`, `URL` (e.g. `http://localhost:5173/props.html` for the prop kit).

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
- Coverage thresholds live per folder in `vitest.config.ts`; add new tested modules to its `include`. Example of DI with type-safe fakes: `src/loading/` + `tests/loading/fakes.ts`.

## Definition of done
Build, tests and coverage pass, fresh captures from at least three bookmarks, `docs/PROGRESS.md` updated.
