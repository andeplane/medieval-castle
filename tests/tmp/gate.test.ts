import { it } from 'vitest';
import { planInterior } from '../../src/castle/interior/plan';
import { buildShell } from '../../src/castle/interior/shell';
import { islandCastle } from '../world';
import { dressRoom, wallsOf } from '../../src/props/dress';
it('gate', () => {
  const P = planInterior();
  const W = buildShell(P, islandCastle().builder).embrasures.map((e) => e.face);
  for (const id of ['gate-0', 'gate-1', 'N3-2', 'W1-0']) {
    const r = P.rooms.find((x) => x.id === id)!;
    console.log('G', id, r.y0, r.y1, JSON.stringify(r.poly.map(p=>p.map(v=>+v.toFixed(2)))), wallsOf(r, P).map(w=>w.L.toFixed(1)+(w.inner?'i':'')).join(' '));
    console.log('G doors', P.doors.filter(d => d.spaces.includes(id)).map(d => `${d.id} ${d.kind} w=${d.width.toFixed(2)}`).join(' | '));
    const d = dressRoom(r, P, { windows: W });
    console.log('G', d.placed.map(p => p.prop.kind.name).join(','), 'dropped', d.dropped.join(','));
  }
}, 200000);
