# Moated Castle

A first-person browser game set in a huge, irregular grey-stone castle on a moated island, where every wall is built from stones that can be broken. See `docs/BRIEF.md`.

Live build: https://andeplane.github.io/midieval-castle/ (deployed from `main` by `.github/workflows/pages.yml`).

```bash
npm install
npm run dev        # open http://localhost:5173 (add ?webgl to force WebGL2)
npm test
```

## Controls

Walk is the physics player (Rapier capsule, 1.75 m, eye at 1.62 m). Open the page with `?play` to start walking at the gate.

| Key | Walk | Fly |
|---|---|---|
| Click the view | grab the mouse for looking (Esc releases it) | same |
| W A S D / arrows | walk (3 m/s) | fly |
| Shift | run (6 m/s) | fast |
| Space | jump (~0.9 m) | up |
| C or Ctrl (hold) | crouch (1.1 m; you stay down under low ceilings) | down (C) |
| Q | | down |
| E (or click while looking) | use the door or portcullis under the crosshair | up (E) |
| M | footstep sound on/off | |
| P / F / O | switch to walk / fly / orbit | |

The Mouse slider sets the look sensitivity (remembered per browser). `?test=walk` adds a movement test course on the east lawn: stairs with 0.15/0.20/0.30/0.35 m rises, 30° and 55° ramps, a low beam and a stair down into a tunnel under the ground. With the dev server running, `node scripts/walktest.mjs` walks it in a headless browser and checks each obstacle.
