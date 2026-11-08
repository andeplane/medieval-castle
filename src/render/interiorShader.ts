// Interior daylight shader (TSL): per-pixel form factors of each aperture of the fragment's room,
// clipped by its splayed embrasure, plus the room's bounce and the readability floor; and the glow on
// the room side of window panes. Built lazily by the renderer, so it is checked by captures
// (?test=room) rather than unit tests. Data layout: interiorMath.packTable.
import {
  Fn, If, Loop, Break, attribute, textureLoad, texture3DLoad, ivec2, ivec3, int, float, vec3, positionWorld, normalWorld, select, max, inverseSqrt, sqrt, mix, cameraPosition, min, clamp,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { InteriorLight } from './interiorLight';
import { AP_TEXELS, OUTDOOR_TAG } from './interiorMath';
import { MAX_FIRES, FIRE_TEXELS } from '../light/roomLight';

export const MAX_AP = 8;          // apertures per room the shader integrates

/** Polygon edge integral (vector form factor of an edge), numerically stable fit by Hill & Heitz. */
const edge = (v1: Node<'vec3'>, v2: Node<'vec3'>) => {
  const x = v1.dot(v2), y = x.abs();
  const a = float(0.8543985).add(float(0.4965155).add(y.mul(0.0145206)).mul(y));
  const b = float(3.417594).add(float(4.1616724).add(y).mul(y));
  const v = a.div(b);
  const ts = select(x.greaterThan(0), v, float(0.5).mul(inverseSqrt(max(float(1).sub(x.mul(x)), 1e-7))).sub(v));
  return v1.cross(v2).mul(ts);
};

const row = () => int(attribute('interiorRoom', 'float').add(0.5).floor());

/** Daylight irradiance at the fragment from its room's apertures + bounce + floor (× `floorK`). */
export function interiorIrradiance(light: InteriorLight, floorK = 1) {
  const tex = (x: Node<'int'>, r: Node<'int'>) => textureLoad(light.table, ivec2(x, r));
  return Fn(() => {
    const r = row().toVar();
    const P = positionWorld, N = normalWorld.toVar();
    const E = vec3(light.floor).mul(floorK).toVar();
    // the outer half of an outdoor doorway: the courtyard's sky and ground, as on the wall beside it
    If(r.equal(OUTDOOR_TAG), () => { E.assign(mix(light.outdoor.ground, light.outdoor.sky, N.y.mul(0.5).add(0.5))); });
    If(r.greaterThanEqual(0), () => {
      const head = tex(int(0), r);
      E.addAssign(head.yzw.mul(light.gain));
      const count = int(head.x);
      Loop(MAX_AP, ({ i }: { i: Node<'int'> }) => {
        If(i.greaterThanEqual(count), () => { Break(); });
        const x = i.mul(AP_TEXELS).add(1);
        const t0 = tex(x, r), t1 = tex(x.add(1), r), t2 = tex(x.add(2), r), t3 = tex(x.add(3), r), t4 = tex(x.add(4), r);
        const c = t0.xyz, D = t0.w, A = t1.xyz, hw = t1.w, U = t2.xyz, hh = t2.w, L = t3.xyz, hwi = t3.w, hhi = t4.x, yi = t4.y;
        const nIn = A.cross(U);
        const d = P.sub(c).toVar();
        const t = d.dot(nIn).toVar(), pa = d.dot(A).toVar(), pu = d.dot(U).toVar();
        If(t.greaterThan(0.003), () => {
          const a0 = float(0).toVar(), a1 = float(0).toVar(), u0 = float(0).toVar(), u1 = float(0).toVar();
          If(t.lessThan(D), () => {
            // inside the embrasure: only this aperture's own tunnel sees its glass, and all of it
            const f = t.div(D.max(1e-3));
            const inside = pa.abs().lessThan(mix(hw, hwi, f).add(0.12)).and(pu.sub(yi.mul(f)).abs().lessThan(mix(hh, hhi, f).add(0.12)));
            If(inside, () => { a0.assign(hw.negate()); a1.assign(hw); u0.assign(hh.negate()); u1.assign(hh); });
          }).Else(() => {
            // in the room: the glass seen through the room-side opening (projected onto the glass plane)
            const k = t.div(t.sub(D));
            a0.assign(max(hw.negate(), pa.add(hwi.negate().sub(pa).mul(k))));
            a1.assign(min(hw, pa.add(hwi.sub(pa).mul(k))));
            u0.assign(max(hh.negate(), pu.add(yi.sub(hhi).sub(pu).mul(k))));
            u1.assign(min(hh, pu.add(yi.add(hhi).sub(pu).mul(k))));
          });
          If(a1.greaterThan(a0).and(u1.greaterThan(u0)), () => {
            const corner = (s: Node<'float'>, v: Node<'float'>) => A.mul(s).add(U.mul(v)).sub(d).normalize();
            const v0 = corner(a0, u0).toVar(), v1 = corner(a1, u0).toVar(), v2 = corner(a1, u1).toVar(), v3 = corner(a0, u1).toVar();
            const F = edge(v0, v1).add(edge(v1, v2)).add(edge(v2, v3)).add(edge(v3, v0)).toVar();
            F.assign(select(F.dot(nIn).greaterThan(0), F.negate(), F));
            const f = F.length().max(1e-6), cw = F.dot(N).div(f), s = sqrt(f);
            // horizon: exact above the tangent plane, a smooth quadratic through it
            const e = select(cw.greaterThanEqual(s), f.mul(cw), select(cw.lessThanEqual(s.negate()), float(0), f.mul(cw.add(s)).mul(cw.add(s)).div(s.mul(4))));
            E.addAssign(L.mul(e.mul(Math.PI)).mul(light.gain));
          });
        });
      });
    });
    return E;
  })();
}

/** Radiance on the room side of a pane: the aperture whose glass plane the fragment sits on. */
export function paneGlow(light: InteriorLight) {
  const tex = (x: Node<'int'>, r: Node<'int'>) => textureLoad(light.table, ivec2(x, r));
  return Fn(() => {
    const r = row().toVar();
    const Lo = vec3(0).toVar();
    If(r.greaterThanEqual(0), () => {
      const count = int(tex(int(0), r).x);
      Loop(MAX_AP, ({ i }: { i: Node<'int'> }) => {
        If(i.greaterThanEqual(count), () => { Break(); });
        const x = i.mul(AP_TEXELS).add(1);
        const t0 = tex(x, r), t1 = tex(x.add(1), r), t2 = tex(x.add(2), r), t3 = tex(x.add(3), r);
        const nIn = t1.xyz.cross(t2.xyz), d = positionWorld.sub(t0.xyz);
        const onPane = d.dot(nIn).abs().lessThan(0.08).and(d.dot(t1.xyz).abs().lessThan(t1.w.add(0.05))).and(d.dot(t2.xyz).abs().lessThan(t2.w.add(0.05)));
        const seenFromRoom = cameraPosition.sub(t0.xyz).dot(nIn).greaterThan(0);
        // sky above, darker ground below: brighter towards the top of the pane
        If(onPane.and(seenFromRoom), () => { Lo.assign(t3.xyz.mul(d.dot(t2.xyz).div(t2.w).mul(0.35).add(1))); Break(); });
      });
    });
    return Lo;
  })();
}


/**
 * Firelight at the fragment from its room's fires (light/roomLight.ts FireTable): candela / (d² + soft²),
 * faded out at each fire's range, × cos, × this frame's flicker. Every fire of the room, whatever the
 * camera's distance: a room is lit the same from anywhere it is drawn. Untagged surfaces (door leaves)
 * take the room they face from the room grid, 0.3 m out along their normal.
 */
export function fireIrradiance(light: InteriorLight) {
  const tex = (x: Node<'int'>, r: Node<'int'>) => textureLoad(light.fires, ivec2(x, r));
  return Fn(() => {
    const r = row().toVar();
    const P = positionWorld, N = normalWorld.toVar();
    If(r.equal(-1), () => {
      const g = light.grid;
      const q = P.add(N.mul(0.3)).sub(g.origin).div(g.cell).floor();
      const c = ivec3(clamp(q, vec3(0), g.size.sub(1)));
      r.assign(int(texture3DLoad(g.texture, c).x.add(0.5)).sub(1));
    });
    const E = vec3(0).toVar();
    If(r.greaterThanEqual(0), () => {
      const count = int(tex(int(0), r).x);
      Loop(MAX_FIRES, ({ i }: { i: Node<'int'> }) => {
        If(i.greaterThanEqual(count), () => { Break(); });
        const x = i.mul(FIRE_TEXELS).add(1);
        const a = tex(x, r), b = tex(x.add(1), r);
        const k = textureLoad(light.flick, ivec2(i, r)).x;
        const L = a.xyz.sub(P).toVar();
        const d2 = L.dot(L), d = sqrt(d2).max(1e-4);
        const w = clamp(float(1).sub(d.div(a.w).pow(4)), 0, 1);
        const cos = N.dot(L.div(d)).max(0);
        E.addAssign(b.xyz.mul(k.mul(w).mul(w).mul(cos).div(d2.add(b.w))));
      });
    });
    // the carried light (InteriorLight.carried): every surface in its range, whatever room
    const c = light.carried, Lc = c.pos.sub(P).toVar();
    const dc2 = Lc.dot(Lc), dc = sqrt(dc2).max(1e-4);
    const wc = clamp(float(1).sub(dc.div(c.range).pow(4)), 0, 1);
    E.addAssign(c.light.xyz.mul(wc.mul(wc).mul(N.dot(Lc.div(dc)).max(0)).div(dc2.add(c.light.w))));
    return E;
  })();
}
