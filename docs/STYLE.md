# Style guide and art review

**Five words:** grey, weathered, massive, irregular, lived-in.

**Stone.** Mid-grey with a slight warm bias, never blue-white and never red. Old wings (N, W, great tower, SW tower) are coursed rubble with wide joints and pinning stones; newer wings (E, S, gatehouse, round towers) are ashlar. Dressed stone for quoins, window surrounds, string courses, copings. Weathering: damp, darker bases; algae at the waterline; rain streaks; lichen on north and upward faces; a few lighter repair patches; blocked windows.

**Silhouette.** One dominant square great tower; round towers different in height and finish; roofs only where they read (N and E wings, cone on the NE tower, turret caps). No symmetry anywhere. Avoid "fairy-tale" clusters of identical cones.

**Light.** Afternoon sun from the south-south-west by default; shaded faces stay grey-green, not sky-blue. Neutral tone mapping, exposure ~0.72, then a light grade (saturation 0.88, gentle S-curve, warm highlights). The sky IBL is deliberately desaturated to 30 % and the hemisphere bounce is neutral above / grass-green below: never "fix" grey stone by tinting albedo, fix the light. Target values in a capture: sunlit ashlar ≈ sRGB 90–100 with R ≥ G ≥ B; shaded stone has B ≤ G (no cyan).

**Relief.** Stone must read as 3D, not printed: mortar joints are recessed (parallax occlusion within ~40 m, self-shadowed by the sun), stones are pillowed (rubble) or flat with crisp arrises (ashlar, dressed). Beyond parallax range the joint cavity and AO shading carry the relief. Rubble faces are split stone, not blobby stucco.

**Interiors (daylight only, until fixtures).** Rooms are lit by the sun pouring through their windows (sharp pools on floors and sills) and by the sky seen through the glass: walls are brightest in and around the embrasures and fall off into the room; corners stay dark but readable (stone texture visible at +2.5 stops), never pure black, also in windowless cellars. No outdoor hemisphere/sky ambient indoors: a flat, evenly grey room is a bug. Splayed embrasures glow; panes are bright but keep their lead lines. Thick walls never leak sun at floor or beam seams. Eye adaptation, not brighter lights, takes you from 0.72 outside to about +2.5 stops inside (+3 underground). Captures: `QUERY=test=room` with `room-hall, room-window, room-dark, room-chamber, room-out`.

**Review loop (`game-art-review`).** `npm run shots` captures every bookmark (`hero, aerial, north, gate, ward, moat, courtyard, towertop, top`). A critic compares captures against `art/refs/castle/` and files numbered defects; it never edits code. Score each category 0–3: silhouette, materials, lighting, water, vegetation, terrain/sky, detail density, imperfection. Premium = every category ≥ 2 and average ≥ 2.3.
