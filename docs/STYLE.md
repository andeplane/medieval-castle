# Style guide and art review

**Five words:** grey, weathered, massive, irregular, lived-in.

**Stone.** Mid-grey with a slight warm bias, never blue-white and never red. Old wings (N, W, great tower, SW tower) are coursed rubble with wide joints and pinning stones; newer wings (E, S, gatehouse, round towers) are ashlar. Dressed stone for quoins, window surrounds, string courses, copings. Weathering: damp, darker bases; algae at the waterline; rain streaks; lichen on north and upward faces; a few lighter repair patches; blocked windows.

**Silhouette.** One dominant square great tower; round towers different in height and finish; roofs only where they read (N and E wings, cone on the NE tower, turret caps). No symmetry anywhere. Avoid "fairy-tale" clusters of identical cones.

**Light.** Afternoon sun from the south-south-west by default; shaded faces stay grey-green, not sky-blue. Neutral tone mapping, exposure ~0.72, then a light grade (saturation 0.88, gentle S-curve, warm highlights). The sky IBL is deliberately desaturated to 30 % and the hemisphere bounce is neutral above / grass-green below: never "fix" grey stone by tinting albedo, fix the light. Target values in a capture: sunlit ashlar ≈ sRGB 90–100 with R ≥ G ≥ B; shaded stone has B ≤ G (no cyan).

**Relief.** Stone must read as 3D, not printed: mortar joints are recessed (parallax occlusion within ~40 m, self-shadowed by the sun), stones are split-faced and slightly pillowed (rubble) or flat and tooled with crisp arrises (ashlar, dressed). Beyond parallax range the joint cavity and AO shading carry the relief. Rubble faces are split stone, not blobby stucco.

**Close up (0.5–5 m).** A wall must still read as real stone at arm's length (Anders, 2026-11-05: "this does NOT look good close up"; `castle-plan/feedback/2026-11-05-stone-closeup-bad.png`). Rules:
- Joints are drawn from a signed distance to each stone's outline (data.a), sharpened in the shader with `fwidth`, so an edge is smooth at any magnification. Never threshold a raster mask into an edge: that is the staircase Anders saw.
- Mortar is a lighter, sandy lime bed set back between the stones, not a dark line. Darkness in a joint comes only from AO and the parallax self-shadow. Rubble joints are wide and deep-raked; ashlar joints are thin and nearly flush.
- Stone outlines are not wobbly: courses undulate only at low frequency. Each stone has slightly tilted edges, rounded or knocked-off corners and a few small chips, with a rounded arris (1.6 cm rubble, 1.2 cm ashlar, 0.8 cm dressed).
- Every stone is its own rock. Its kind (granite, limestone, sandstone, whin, greywacke) sets its colour, crystal grain, mineral flecks and pitting. Inside a stone there is mottling, sometimes bedding, darker weathered patches, iron staining, a quartz vein or a straight hairline crack. Never use closed crack loops or uniform speckle.
- Below ~9 m a detail layer (0.8 mm texels, repeating every 0.8 m and rotated and shifted per stone) adds crystals, flecks, pits and, on ashlar and dressed stone, claw-tool striations. Crustose lichen spots go where it is damp.
- Bookmarks `closeup-rubble`, `closeup-ashlar`, `closeup-shade` and `closeup-corner` are the close-up review. Compare them with `castle-plan/refs/04-rubble-masonry-round-tower.png` (per-stone colour, lighter mortar) and Gravensteen (pale grey, warm and cool stones mixed).

**Review loop (`game-art-review`).** `npm run shots` captures every bookmark (`hero, aerial, north, gate, ward, moat, courtyard, towertop, top`). A critic compares captures against `art/refs/castle/` and files numbered defects; it never edits code. Score each category 0–3: silhouette, materials, lighting, water, vegetation, terrain/sky, detail density, imperfection. Premium = every category ≥ 2 and average ≥ 2.3.
