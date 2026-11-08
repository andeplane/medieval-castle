// Z-fighting in the furniture. Two surfaces drawn on one plane flicker as the camera moves (the depth
// test cannot order them), and a closed solid's face that lies on another solid's face looking the
// same way is drawn twice in one place. Anders saw it on the books (the page block's fore-edge flush
// with the cover), the bookcases (leaning books' fronts on their neighbours'), the fireplaces and the
// joinery of most furniture. These rules run over every prop kind and seed, and over every prop the
// castle places against the room shell, so a new flush part fails here before anyone sees it.
import { describe, it, expect, beforeAll } from 'vitest';
import { KIT, makeProp } from '../src/props/kit';
import { mergePlaced } from '../src/props/place';
import { dressPlan, type Dressing } from '../src/props/dress';
import { planInterior } from '../src/castle/interior/plan';
import type { InteriorPlan } from '../src/castle/interior/types';
import { PropMesh, translate } from '../src/props/geom';
import { trisOf, coplanarFights, makeTri, shellFights, type Tri } from './helpers/coplanar';

const SEEDS = [0, 1, 2, 3, 4, 5];

describe('the z-fight finder', () => {
  it('finds two overlapping faces on one plane, either way round, and only those', () => {
    const t = (y: number, up = true, x0 = 0) => makeTri([x0, y, 0], up ? [x0, y, 1] : [x0 + 1, y, 0], up ? [x0 + 1, y, 0] : [x0, y, 1], 'wood')!;
    expect(t(0).n[1]).toBeGreaterThan(0.99);
    expect(coplanarFights([t(0), t(0.0005)])).toMatchObject([{ same: true }]);
    expect(coplanarFights([t(0), t(0.0005, false)])).toMatchObject([{ same: false }]);
    expect(coplanarFights([t(0), t(0.002)])).toEqual([]);   // 2 mm apart: the depth buffer orders them
    expect(coplanarFights([t(0), t(0, true, 1)])).toEqual([]); // side by side, sharing an edge
    expect(makeTri([0, 0, 0], [1, 0, 0], [2, 0, 0], 'wood')).toBeNull();
  });

  it('finds the old book: the page block flush with the cover', () => {
    const m = new PropMesh();
    m.box('cloth', [0, 0.02, 0], [0.3, 0.04, 0.2], { bevel: 0.004 });
    m.box('wax', [0.006, 0.02, 0], [0.288, 0.028, 0.184]); // the fore-edge on the cover's +x face
    const f = coplanarFights(trisOf(m));
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((x) => x.same && x.mats.includes('wax') && x.mats.includes('cloth'))).toBe(true);
  });

  it('finds a prop face on a shell face, and a back against the wall as hidden', () => {
    const room = { poly: [[0, 0], [4, 0], [4, 3], [0, 3]] as [number, number][], y0: 2, y1: 5 };
    const m = new PropMesh();
    m.with(translate(2, 2, 1.5), () => m.box('wood', [0, 0.25, 0], [1, 0.5, 1])); // a block on the floor
    m.sheet('paint', (s, t) => [0.5 + s, 3 + t, 0.0004], 1, 1, [1, 1]);     // a canvas flat on the z = 0 wall, facing in
    m.sheet('cloth', (s, t) => [1 + s, 5, 1 + t], 1, 1, [1, 1]);            // a cloth on the ceiling
    const { same, opposite } = shellFights(trisOf(m), room);
    expect(same.map((x) => x.mat).sort()).toEqual(['cloth', 'cloth', 'paint', 'paint']);
    expect(opposite.map((x) => x.mat)).toEqual(['wood', 'wood']); // the block's bottom on the floor
  });
});

describe('no z-fighting inside a prop', () => {
  // Faces that look the same way on one plane both show: every one is a flicker. Opposite faces on one
  // plane are two solids in contact (a book on a book, a strap on a lid): each hides the other's face,
  // so they are not drawn and are left alone.
  for (const k of KIT) it(`${k.name}: no two faces on one plane looking the same way`, () => {
    const bad: string[] = [];
    for (const s of SEEDS) for (const f of coplanarFights(trisOf(makeProp(k, s).mesh))) if (f.same) bad.push(`seed ${s} ${f.mats.join('/')} at ${f.at.map((v) => v.toFixed(3)).join(', ')}`);
    expect(bad).toEqual([]);
  });
});

describe('no z-fighting against the room shell', () => {
  let P: InteriorPlan, D: Dressing;
  beforeAll(() => { P = planInterior(); D = dressPlan(P); }, 60_000);

  it('no placed prop face lies on a floor, wall or ceiling looking into the room', () => {
    const bad: string[] = [];
    let props = 0, hidden = 0;
    const rooms = new Map(P.rooms.map((r) => [r.id, r]));
    for (const rd of D.rooms) {
      const r = rooms.get(rd.room)!;
      props += rd.placed.length;
      for (const p of rd.placed) {
        const tris: Tri[] = trisOf(mergePlaced([p]).mesh);
        const { same, opposite } = shellFights(tris, { poly: r.poly, y0: r.y0, y1: r.y1 });
        hidden += opposite.length;
        if (same.length) bad.push(`${rd.room} ${p.prop.kind.name}: ${same.length} faces (${[...new Set(same.map((t) => t.mat))].join(', ')})`);
      }
    }
    expect(props).toBeGreaterThan(500);
    expect(hidden).toBeGreaterThan(0); // the rule does see props touching the shell (bottoms on floors)
    expect(bad).toEqual([]);
  });
});
