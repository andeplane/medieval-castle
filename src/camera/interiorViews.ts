// Camera bookmarks inside the castle, derived from the interior plan so they survive layout changes.
import type { View } from './controls';
import type { PlanX } from '../castle/interior/plan';
import type { V2 } from '../core/math2d';
import { passageFrame } from '../castle/interior/caves';

const EYE = 1.65;

export function interiorViews(P: PlanX): View[] {
  const room = (id: string) => P.rooms.find((r) => r.id === id);
  const cen = (p: V2[]): V2 => [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
  /** Stand near one end of the room's long axis (2D principal direction) and look down it. */
  const along = (id: string, name: string, label: string, back = 0.8, lift = EYE, side = 0): View | null => {
    const r = room(id); if (!r) return null;
    const c = cen(r.poly);
    let best: V2 = [1, 0], bl = 0;
    for (let i = 0; i < r.poly.length; i++) { const a = r.poly[i], b = r.poly[(i + 1) % r.poly.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L > bl) { bl = L; best = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; } }
    const ts = r.poly.map((q) => (q[0] - c[0]) * best[0] + (q[1] - c[1]) * best[1]), t0 = Math.min(...ts);
    const n: V2 = [-best[1], best[0]];
    const pos: [number, number, number] = [c[0] + best[0] * (t0 + back) + n[0] * side, r.y0 + lift, c[1] + best[1] * (t0 + back) + n[1] * side];
    return { name, label, mode: 'fly', pos, target: [c[0] + best[0] * 6, r.y0 + lift * 0.9, c[1] + best[1] * 6], clamp: false };
  };
  const out: (View | null)[] = [];
  // gate passage: from the courtyard end of the inner passage looking out through the gate
  const g1 = room('gate-1'), gm = P.doors.find((d) => d.id === 'gate-main');
  if (g1 && gm) {
    const c = cen(g1.poly), n = gm.normal;
    out.push({ name: 'gatepass', label: 'Gate passage', mode: 'fly', pos: [c[0] + n[0] * 2.4, g1.y0 + EYE, c[1] + n[1] * 2.4], target: [gm.centre[0], gm.centre[1] + 2.2, gm.centre[2]], clamp: false });
  }
  const hall = P.rooms.find((r) => r.kind === 'hall');
  if (hall) out.push(along(hall.id, 'hall', 'Great hall', 0.9, 1.8, 0.6));
  const ch = P.rooms.find((r) => r.id === 'E2-2') ?? P.rooms.find((r) => r.kind === 'chamber');
  if (ch) out.push(along(ch.id, 'chamber', 'Chamber', 0.7));
  if (room('great-2')) out.push(along('great-2', 'towerroom', 'Great tower room', 0.8));
  if (room('N0-1')) out.push(along('N0-1', 'undercroft', 'Undercroft', 0.7));
  const mt = P.sallyPort ? room(P.sallyPort.room) : undefined;
  if (mt && P.sallyPort) {
    const sp = P.sallyPort, t = P.tunnels.find((x) => x.room === sp.room)!;
    const low = t.path.find((p) => p[1] < -6);
    if (low) {
      const p = low;
      out.push({ name: 'tunnel', label: 'Moat tunnel', mode: 'fly', pos: [p[0] - sp.dir[0] * 0.2, p[1] + EYE, p[2] - sp.dir[1] * 0.2], target: [p[0] + sp.dir[0] * 8, p[1] + EYE + 0.2, p[2] + sp.dir[1] * 8], clamp: false });
    }
  }
  if (room('N-c1')) out.push(along('N-c1', 'cellar', 'Cellar', 0.6));
  if (P.caves && room(P.caves.entrance)) out.push(...caveViews(P));
  return out.filter((v): v is View => !!v);
}

/** The caves (castle/interior/caves.ts): the way in, the squeeze, the drop, the great cavern, the way out. */
function caveViews(P: PlanX): View[] {
  const C = P.caves!, out: View[] = [];
  const v = (name: string, label: string, pos: [number, number, number], target: [number, number, number]): View => ({ name, label, mode: 'fly', pos, target, clamp: false });
  /** Standing in a room `back` m in front of a door, looking at it. */
  const atDoor = (cave: string, from: string, name: string, label: string, back = 3) => {
    const d = P.doors.find((x) => x.spaces.includes(cave) && x.spaces.includes(from)), r = P.rooms.find((x) => x.id === from);
    if (!d || !r) return;
    const s = d.spaces[0] === from ? -1 : 1;
    out.push(v(name, label, [d.centre[0] + d.normal[0] * s * (d.wall / 2 + back), r.y0 + EYE, d.centre[2] + d.normal[1] * s * (d.wall / 2 + back)], [d.centre[0], d.centre[1] + 1.1, d.centre[2]]));
  };
  atDoor(C.entrance, 'N-c1', 'cave-entrance', 'Cave: the breach in the cellar wall');
  const sq = C.passages.find((p) => p.id === 'cave-squeeze');
  if (sq) { const f = passageFrame(sq), a = f.a; out.push(v('cave-squeeze', 'Cave: the squeeze', [a[0] + f.u[0] * 0.6, sq.from[1] + EYE, a[1] + f.u[1] * 0.6], [sq.to[0], sq.to[1] + 1.4, sq.to[2]])); }
  const drop = C.passages.find((p) => p.steps);
  if (drop) { const f = passageFrame(drop); out.push(v('cave-drop', 'Cave: the drop', [f.a[0] - f.u[0] * 1.2, drop.from[1] + EYE, f.a[1] - f.u[1] * 1.2], [drop.to[0], drop.to[1] + 0.6, drop.to[2]])); }
  const cav = C.chambers.find((k) => k.id === 'cave-cavern');
  if (cav && drop) {
    const f = passageFrame(drop), at: [number, number] = [drop.to[0] + f.u[0] * 1.2, drop.to[2] + f.u[1] * 1.2], tg = cav.pool?.c ?? cav.c;
    out.push(v('caves', 'Cave: the great cavern', [at[0], cav.y + EYE, at[1]], [tg[0], cav.y + 0.9, tg[1]]));
  }
  atDoor(C.exit, 'great-c', 'cave-exit', 'Cave: the way out, in the great tower cellar', 2.6);
  return out;
}
