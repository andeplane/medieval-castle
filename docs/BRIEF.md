# Moated Castle: brief

**Pitch.** A first-person sandbox in a huge, irregular grey-stone castle on a moated island. Every wall is built from real stones and can be broken with enough force. Think *Teardown*'s destruction in a *Gravensteen* / Irish tower-house castle, with a view-only landscape of farmland, forest and mountains around it.

**Loop (draft, to be decided with Anders).** 30 s: walk, look, smash a wall and watch stones fall. 5 min: explore a floor of ~20 rooms, find a way up, open new views. Session: reach the roof of the great tower; or free sandbox. Win/fail and meta are open questions, deliberately left until the castle looks right.

**Camera and controls.** First person (mouse + WASD) on desktop browsers. The player starts on the island inside the moat and cannot leave it (the bridge's middle span has fallen). Review builds also have orbit and fly cameras.

**Performance target.** 60 fps at 1440p on an Apple M4 (WebGPU), 30+ fps on a mid laptop. Budgets from `game-performance-optimization`: 500–1000 draw calls, 1–3 M triangles including shadow passes, < 1 GB VRAM, 20–50 MB download, DPR ≤ 2, < 100 shader programs, shaders compiled behind the loading screen.

**Art direction.** References in `art/refs/castle/` (Gravensteen walls rising from the moat with buttresses and blind arches; Windsor round tower with grey stone and chimneys; Irish square-towered castle against mountains; rubble round tower with an arched gate). Adjectives: **grey, weathered, massive, irregular, lived-in.** No red brick. No perfect geometry: corners at 82–98°, wings of different depth and height, two building phases (old rubble, newer ashlar), blocked windows, repairs, lichen on north faces, damp bases. Style guide: `docs/STYLE.md`.

**Scale (guarded by `tests/layout.test.ts`).** 7 floors (~36 m to the parapet), four wings around a courtyard, ~1,350 m² gross and ~1,050 m² usable per floor, 20 rooms per floor of 35–75 m², plus towers: square great tower (53 m), round NE tower with a slate cone, round SE tower with a stair turret, square SW tower, gatehouse, east turret, courtyard stair tower. Island ~9,000 m² with a ≥ 6 m walkable ring round the castle; moat 13–30 m wide.

**Tech.** three.js r187 `WebGPURenderer` + TSL (WebGL2 fallback, forced with `?webgl` for headless captures), Vite, TypeScript, Vitest. Rapier 0.21 in a worker when destruction starts. Seeded generation everywhere (`mulberry32` + `hashSeed` sub-seeds). Assets: procedural first (all current textures are generated), then CC0, then Blender scripts, then AI 3D; every external asset goes in `CREDITS.md`.

**Destruction model (phase D).** Walls are lists of stone courses per wall segment (course 0.22–0.45 m, stones 0.3–1.0 m, two skins with a rubble core), ~170k stones total. A support graph decides what falls: a stone rests on the stones it overlaps below. Loose stones become Rapier bodies; connected chunks become compound bodies; settled rubble freezes. Rendering: real bevelled stones near the player, the generated masonry texture further away (the texture is laid out with the same course rules, so the switch is invisible).

**Out of scope for now.** Multiplayer, NPCs, story, mobile controls, interiors before the exterior is approved.

## Phased steps

Each step is done when `npm run build` and `npm test` pass and `npm run shots` has produced fresh captures that pass the art review in `docs/STYLE.md`.

| Step | What | Acceptance |
|---|---|---|
| **E.1** ✅ | Layout spec + plan tests | Tests prove 7 floors, ~1,000 m² usable, 20 rooms, no right angles, walkable ring, irregular moat |
| **E.2** ✅ | Generated masonry, slate, ground and water textures (workers) | Textures generate in < 3 s on the M4; stones read as stone at 2 m and at 100 m |
| **E.3** ✅ | Castle exterior generator | Walls with real window openings and reveals, buttresses + blind arches, corbel tables with machicolations, crenellations, roofs, chimneys, towers, gatehouse; ≤ 150k triangles |
| **E.4** ✅ | Island, revetment, moat, broken bridge | No visible seams; player cannot leave the island |
| **E.5** ✅ | Terrain, sky, fog, water reflections, trees | Mountains visible to the north and west; no tree in a bookmark camera |
| **E.6** ✅ | Orbit / fly / walk cameras, bookmarks, `window.__game`, capture script | `npm run shots` writes every bookmark |
| **E.7** ⏳ | Art-review iterations with Anders | Scorecard ≥ 2 in every category, average ≥ 2.3 |
| I.1 | Interior layout: 20 rooms per floor, corridors, stairs in towers | Every room reachable; validator passes for 256 seeds |
| I.2 | Interior geometry + dressing | Captures of hall, stair, chamber pass review |
| D.1 | Stone course data model shared by render and physics | Same course layout in texture and stones |
| D.2 | Support graph + Rapier worker + rubble freeze | Breaking a 3 m hole holds 60 fps; no floating stones |
| G.1 | FPS controller (Rapier capsule), a force tool to break walls | Can walk the island, enter, climb, smash |
