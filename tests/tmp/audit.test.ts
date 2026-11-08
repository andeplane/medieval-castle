import { it } from 'vitest';
import { planInterior } from '../../src/castle/interior/plan';
import { buildShell } from '../../src/castle/interior/shell';
import { islandCastle } from '../world';
import { dressPlan } from '../../src/props/dress';
it('audit', () => {
  const P = planInterior();
  const W = buildShell(P, islandCastle().builder).embrasures.map((e) => e.face);
  const D = dressPlan(P, { windows: W });
  const by: Record<string, string[]> = {};
  for (const d of D.rooms) (by[d.role] ??= []).push(d.room);
  console.log('ROLES', JSON.stringify(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length]))));
  const low = D.rooms.filter((d) => d.role !== 'empty' && d.role !== 'passage' && d.placed.length < 6).map((d) => `${d.room}(${d.role}):${d.placed.length}`);
  console.log('LOW', low.join(' '));
  const sig = new Map<string, string[]>();
  for (const d of D.rooms) { if (d.role === 'empty' || d.role === 'passage') continue; const k = d.role + '|' + d.placed.map((p) => p.prop.kind.name).sort().join(','); sig.set(k, [...(sig.get(k) ?? []), d.room]); }
  console.log('DUP', [...sig.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => `${k.split('|')[0]}:${v.join('+')}`).join(' '));
  const tris = D.rooms.reduce((s, r) => s + r.placed.reduce((t, p) => t + p.prop.mesh.triangles, 0), 0);
  let maxG = 0, maxK = ''; for (const [k, pl] of D.byGroup) { const t = pl.reduce((s, p) => s + p.prop.mesh.triangles, 0); if (t > maxG) { maxG = t; maxK = k; } }
  const counts = D.rooms.filter((d) => d.role !== 'empty' && d.role !== 'passage').map((d) => d.placed.length).sort((a, b) => a - b);
  console.log('TRIS', tris, 'maxgroup', maxK, maxG, 'props', D.rooms.reduce((s, r) => s + r.placed.length, 0), 'median', counts[counts.length >> 1], 'min', counts[0], 'max', counts.at(-1));
  for (const role of Object.keys(by)) console.log('R', role, by[role].join(','));
}, 200000);
