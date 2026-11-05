# Product

<!-- impeccable:product-schema 1 -->
<!-- Written by an agent from the brief (docs/BRIEF.md, AGENTS.md) and Anders's timeline notes, without a live interview: facts marked (inferred) are the agent's reading and wait for Anders to confirm. -->

## Platform

web

## Users

- **Anders, the owner and first player.** He plays each build in a desktop browser from GitHub Pages (every merge to `main` deploys) and judges it by walking around: does the castle read as real, heavy, weathered stone; do the gate and doors work; does it feel good close up. He gives feedback in short notes on the project timeline.
- **Agents building the game.** They use the same pages (`index.html`, `props.html`, `?test=` scenes) with review flags and camera bookmarks to capture and compare screenshots. Their needs are repeatability and hiding the UI for captures (`?shot`).
- **Players later (inferred).** Desktop, mouse and keyboard, first person. Mobile controls are out of scope for now.

## Product Purpose

A first-person sandbox in a huge, irregular grey-stone medieval castle on a moated island. You walk the island, open the gate and doors, and explore the castle's rooms, stairs, cellars and tunnels. Later every wall is built from real stones that can be broken, and NPCs will navigate the same rooms, doors and stairs. Success now is that the castle looks right and is good to walk around in. The loop and win conditions are deliberately undecided.

## Positioning

A castle generated from a seed, stone by stone. The masonry courses, the window reveals, the doors and the landscape all come from one seeded generator, and the destruction model will share the same stone courses. The world is the product; the interface exists to get the player into it and out of the way.

## Operating Context

- Played in a desktop browser at 1280×720 to 1440p; WebGPU with a WebGL2 fallback (`?webgl`). Pointer lock for mouse look; Esc releases it.
- Builds are tested often on GitHub Pages; CI must stay within about 1–2 minutes.
- Review tooling is part of the product while it is being built: orbit, fly and walk cameras, named bookmarks, time of day, `?shot` for clean captures, `?loading=<0..1>` to hold the loading tunnel, `props.html` for the furniture kit.
- Loading takes many seconds (textures, terrain erosion, shader compilation), so the loading screen is something every session sees.

## Capabilities and Constraints

- Exterior and interiors (rooms, doors that open and close, stairs, cellars, tunnels) are approved; furniture, destruction, NPCs and gameplay come later.
- Controls: WASD to move, Shift to run, mouse to look, E (or a click while locked) to use what the crosshair is on.
- Everything generated is a pure function of the seed. Modules take their collaborators by injection so tests use typed fakes; coverage close to 100 % of logic.
- Performance budgets in `docs/BRIEF.md` (60 fps at 1440p on an Apple M4). UI must not cost frames.
- The game must be NPC-ready: nothing assumes one character.
- Undecided: game loop, win/fail, meta progression, story, audio direction beyond door sounds.

## Brand Commitments

- Name in use: "Moated Castle" (page title and loading screen).
- Look words from `docs/STYLE.md`: grey, weathered, massive, irregular, lived-in. No red brick, no fairy-tale symmetry.
- Anders asked for the loading screen to be a dark tunnel under the moat that fills with light as loading progresses.

## Evidence on Hand

- Reference photos in `art/refs/castle/` (supplied by Anders, not shipped).
- Captures in `shots/` and on the project share.
- No players, reviews, metrics or press exist yet; do not invent them.

## Product Principles

1. The world leads. Any UI shows only what the player needs at that moment, then gets out of the way.
2. Review tooling is first-class while the game is being built, but it should never be in the way of playing.
3. One seed, one castle: what you see is generated and repeatable, so captures can be compared over time.
4. Built for more than one character: doors, stairs and movement work for NPCs too.

## Accessibility & Inclusion

No product-specific requirement has been established (inferred: WCAG AA for the HTML UI, `prefers-reduced-motion` honoured, as the current code already does).
