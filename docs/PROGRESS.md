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

Numbers: 150 mixed doors come to 2 draw calls and 187k triangles (about 1.25k per leaf; iron studs and rings are about half of that). They build in about 0.7 s in Node. The castle gate, wicket and portcullis come to 5.6k triangles. Unit tests cover about 99% of lines in the door and interaction modules (v8).

Known issues / next
- Contract interpretations the shell should match: the leaf's back face sits on the stop at `rebate` from the swing face; the leaf fits inside the clear opening with 1.5 cm clearance (no lap over the stop, so thin light slits show); pointed heads rise 0.42·w (castle.ts gate arch), segmental 0.2·w. `openingOutline(head, w, h, seg, grow)` gives the exact outline, and `grow` gives a rebate recess.
- Portcullis grid is iron, not iron-shod oak; there is no winch or windlass in the room above yet.
- Doors are only in the main scene for the gate, until the shell's `plan.doors` lands.
