# Style guide and art review

**Five words:** grey, weathered, massive, irregular, lived-in.

**Stone.** Mid-grey with a slight warm bias, never blue-white and never red. Old wings (N, W, great tower, SW tower) are coursed rubble with wide joints and pinning stones; newer wings (E, S, gatehouse, round towers) are ashlar. Dressed stone for quoins, window surrounds, string courses, copings. Weathering: damp, darker bases; algae at the waterline; rain streaks; lichen on north and upward faces; a few lighter repair patches; blocked windows.

**Silhouette.** One dominant square great tower; round towers different in height and finish; roofs only where they read (N and E wings, cone on the NE tower, turret caps). No symmetry anywhere. Avoid "fairy-tale" clusters of identical cones.

**Light.** Afternoon sun from the south-south-west by default; shaded faces stay grey-green, not sky-blue. Neutral tone mapping, exposure ~0.72.

**Review loop (`game-art-review`).** `npm run shots` captures every bookmark (`hero, aerial, north, gate, ward, moat, courtyard, towertop, top`). A critic compares captures against `art/refs/castle/` and files numbered defects; it never edits code. Score each category 0–3: silhouette, materials, lighting, water, vegetation, terrain/sky, detail density, imperfection. Premium = every category ≥ 2 and average ≥ 2.3.
