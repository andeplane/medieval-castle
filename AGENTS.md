# Agents guide

Read `docs/BRIEF.md` (what we are building), `docs/STYLE.md` (look + review) and `docs/PROGRESS.md` (state) first. Skills are vendored in `.claude/skills/` (see `SKILLS.md`); start from `game-dev-index`.

## Commands
- `npm run dev`: dev server (WebGPU; add `?webgl` to force WebGL2).
- `npm test`: plan and generator tests (fast, < 5 s).
- `npm run coverage`: tests with v8 coverage (thresholds on the covered modules, see `vitest.config.ts`).
- `npm run build`: typecheck + production build (pages `index.html` and `props.html`).
- `npm run shots [view…]`: with the dev server running, capture camera bookmarks to `shots/` (headless WebGL2). Env: `W`, `H`, `QUERY` (e.g. `ao=0`), `OUT`, `URL` (e.g. `http://localhost:5173/props.html` for the prop kit).

## Rules
- Coordinates: x east, y up, z south, metres. Moat water y = 0, island ground ≈ 2.6.
- Everything generated is a pure function of the seed: use `rngFor(name)` from `src/core/rng.ts`, never `Math.random`.
- Castle dimensions live in `src/castle/spec.ts`; `tests/layout.test.ts` guards the brief's requirements. Change the spec, not the tests, unless Anders changes the requirement.
- Geometry goes through `Builder` bins (one draw call per material). UVs are metres / tile so courses stay level.
- Stay inside the performance budgets in the brief; report triangles and draw calls from `__game.state()` when you change content.
- Exterior only until Anders approves it. No interiors, destruction or gameplay yet.

## Definition of done
Build and tests pass, fresh captures from at least three bookmarks, `docs/PROGRESS.md` updated.
