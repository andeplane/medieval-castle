// Direct sun indoors comes only through real openings (Anders 2026-11-06: "this sunlight there comes from
// nothing", a sharp strip on a room floor and door jamb by a thick-walled doorway).
// Interior materials are lit by the shadowed sun, so what the sun reaches indoors is decided by the shadow
// casters alone: the castle exterior (castShadow bins) and the hidden shadow skins; the interior shell
// casts nothing (main.ts) and room culling never touches either caster. Over the whole castle, at several
// times of day: every sample point on a room floor or wall that those casters leave in sunlight must see the
// sun along a ray that leaves the room through one of its openings (both faces of a window embrasure or a
// door passage), through any rooms beyond, to the outside. The casters are ray-cast as the shadow pass
// draws them: three draws a single-sided material's faces turned away from the light only
// (`shadowSide ?? flip(side)`), so a face that looks at the sun stops nothing.
import { describe, expect, test } from 'vitest';
import * as THREE from 'three/webgpu';
import * as T3 from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { buildInterior } from '../src/castle/interior/index';
import { bakeInteriorLight, buildShadowSkins, bvhOccluder, createInteriorLight } from '../src/render/interiorLight';
import { apertureFrame, inPoly, type Aperture, type WindowInput } from '../src/render/interiorMath';
import type { V3 } from '../src/castle/interior/types';
import { islandCastle, mats } from './world';

/** sky.ts setTime: towards the sun at `hours` */
function sunAt(hours: number): V3 {
  const t = (hours - 6) / 14, el = (Math.sin(Math.PI * t) * 46 * Math.PI) / 180, az = ((90 + 180 * t) * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

/** One BVH per side the shadow pass draws, over every shadow-casting mesh under `roots`. */
function casters(roots: THREE.Object3D[]) {
  const soup = new Map<number, number[]>();
  const v = new THREE.Vector3();
  for (const r of roots) {
    r.updateMatrixWorld(true);
    r.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.castShadow || !m.visible) return;
      const mat = m.material as THREE.Material;
      const drawn = mat.shadowSide ?? ({ [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide } as Record<number, THREE.Side>)[mat.side];
      // a ray from the receiver towards the sun meets a face the light sees from behind on its front
      const side = drawn === THREE.DoubleSide ? T3.DoubleSide : drawn === THREE.BackSide ? T3.FrontSide : T3.BackSide;
      const p = m.geometry.attributes.position as THREE.BufferAttribute, idx = m.geometry.index, n = idx ? idx.count : p.count;
      const out = soup.get(side) ?? soup.set(side, []).get(side)!;
      for (let i = 0; i < n; i++) { v.fromBufferAttribute(p, idx ? idx.getX(i) : i).applyMatrix4(m.matrixWorld); out.push(v.x, v.y, v.z); }
    });
  }
  const bvhs = [...soup].map(([side, pos]) => {
    const g = new T3.BufferGeometry(); g.setAttribute('position', new T3.BufferAttribute(new Float32Array(pos), 3));
    return { side: side as T3.Side, bvh: new MeshBVH(g) };
  });
  const ray = new T3.Ray();
  return (o: V3, d: V3) => { ray.origin.set(...o); ray.direction.set(...d); return bvhs.some((b) => !!b.bvh.raycastFirst(ray, b.side, 0.01, 600)); };
}

const PAD = 0.15; // the skins' holes are 5 cm proud of the opening, and the aperture model of a splay is approximate

/** Ray parameter where o + s·d crosses face `t` (0 = glass / far face, depth = room face) of `ap` inside its outline, or -1. */
function through(ap: Aperture, o: V3, d: V3, t: number) {
  const { a, u, nIn } = apertureFrame(ap);
  const c: V3 = [ap.c[0] + nIn[0] * t, ap.c[1] + nIn[1] * t, ap.c[2] + nIn[2] * t];
  const dn = d[0] * nIn[0] + d[1] * nIn[1] + d[2] * nIn[2];
  if (Math.abs(dn) < 1e-6) return -1;
  const s = ((c[0] - o[0]) * nIn[0] + (c[1] - o[1]) * nIn[1] + (c[2] - o[2]) * nIn[2]) / dn;
  if (s <= 0) return -1;
  const x: V3 = [o[0] + d[0] * s - c[0], o[1] + d[1] * s - c[1], o[2] + d[2] * s - c[2]];
  const k = ap.depth > 0 ? t / ap.depth : 0;
  const hw = (ap.w + (ap.wi - ap.w) * k) / 2, hh = (ap.h + (ap.hi - ap.h) * k) / 2, yc = ap.yi * k;
  const ax = x[0] * a[0] + x[1] * a[1] + x[2] * a[2], uy = x[0] * u[0] + x[1] * u[1] + x[2] * u[2] - yc;
  return Math.abs(ax) < hw + PAD && uy > -hh - PAD && uy < hh + (ap.rise ?? 0) + PAD ? s : -1;
}

let built: { lights: ReturnType<typeof islandCastle>['lights']; res: ReturnType<typeof buildInterior>; castle: THREE.Object3D } | null = null;
/** the castle as main.ts builds and carves it (once for this file) */
function world() {
  if (!built) {
    const { builder, lights } = islandCastle();
    const M = mats();
    const res = buildInterior(M, builder, { heightAt: () => 2.6 });
    built = { lights, res, castle: builder.build(M) };
  }
  return built;
}

describe('sun indoors', () => {
  test('no reveal is shaded as facing the sky more than it does (a jamb tilted 60° up took sun it faces away from)', () => {
    let tris = 0, bad = 0;
    const g = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    for (const grp of world().res.groups) grp.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.name.endsWith('-trim')) return;
      const p = m.geometry.attributes.position as THREE.BufferAttribute, nr = m.geometry.attributes.normal as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i += 3) {
        a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
        g.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
        if (g.length() < 1e-6) continue;
        g.normalize(); n.fromBufferAttribute(nr, i);
        tris++;
        if (g.dot(n) < 0) g.negate();
        if (n.y - g.y > 0.3) bad++; // shaded as if facing the sky more than it does
      }
    });
    expect(tris).toBeGreaterThan(1000);
    expect(bad).toBe(0);
  }, 120_000);

  test('direct sun reaches a room only through its openings (whole castle, three times of day)', () => {
    const { lights, res, castle } = world();
    const occ = bvhOccluder([castle, ...res.groups.map((g) => g.object)]);
    const rooms = res.plan.rooms;
    const sun = { dir: sunAt(15.5), irradiance: [3, 3, 3] as V3 };
    const bake = bakeInteriorLight(res.groups, occ, { plan: res.plan, windows: lights as WindowInput[], sun: () => sun, light: createInteriorLight() });
    // the game's sun casters: the exterior and the skins (main.ts turns the interior shell's casting off)
    const lit = casters([castle, buildShadowSkins(res.plan, bake.apertures)]);
    const byRoom = rooms.map((_, i) => bake.apertures.filter((a) => a.room === i));
    /** follow the ray out: through an opening of each room it is in, until it is outside */
    const escapes = (room: number, o: V3, d: V3, from = 0, hops = 0): boolean => {
      if (hops > 4) return false;
      return byRoom[room].some((ap) => {
        const sIn = through(ap, o, d, ap.depth), sOut = through(ap, o, d, 0);
        if (sIn < from - 0.05 || sOut < from - 0.05) return false;
        return ap.kind !== 'portal' || (ap.other !== undefined && escapes(ap.other, o, d, Math.max(sIn, sOut), hops + 1));
      });
    };
    const leaks: string[] = [];
    let lits = 0, samples = 0, viaOpening = 0;
    for (const hours of [9, 12, 15.5]) {
      const d = sunAt(hours);
      rooms.forEach((r, ri) => {
        if (r.floor < 0) return; // cellars and tunnels: no direct sun at all (makeInteriorMaterials(…, null))
        const pts: V3[] = [];
        const xs = r.poly.map((p) => p[0]), zs = r.poly.map((p) => p[1]);
        for (let x = Math.min(...xs) + 0.05; x < Math.max(...xs); x += 0.5) for (let z = Math.min(...zs) + 0.05; z < Math.max(...zs); z += 0.5) if (inPoly(r.poly, x, z)) pts.push([x, r.y0 + 0.03, z]);
        r.poly.forEach((A, i) => {
          const B = r.poly[(i + 1) % r.poly.length], L = Math.hypot(B[0] - A[0], B[1] - A[1]);
          for (let s = 0.15; s < L - 0.1; s += 0.4) for (const h of [0.4, 1.4]) {
            const x = A[0] + ((B[0] - A[0]) * s) / L, z = A[1] + ((B[1] - A[1]) * s) / L, nx = -(B[1] - A[1]) / L, nz = (B[0] - A[0]) / L;
            const k = inPoly(r.poly, x + nx * 0.05, z + nz * 0.05) ? 1 : -1;
            if ((nx * d[0] + nz * d[2]) * k <= 0.05) continue; // a wall turned from the sun takes none (N·L)
            pts.push([x + nx * k * 0.03, r.y0 + h, z + nz * k * 0.03]);
          }
        });
        let n = 0;
        for (const p of pts) {
          samples++;
          if (lit(p, d)) continue;
          lits++;
          if (!escapes(ri, p, d)) n++; else viaOpening++;
        }
        if (n > 0) leaks.push(`${r.id} at ${hours} h: ${n} points, e.g. ${pts.find((p) => !lit(p, d) && !escapes(ri, p, d))!.map((v) => v.toFixed(2)).join(', ')}`);
      });
    }
    console.info(`sun indoors: ${samples} samples, ${lits} sunlit (${viaOpening} through an opening), ${leaks.length} rooms × times leak`);
    expect(viaOpening).toBeGreaterThan(50); // the sun does come in through the windows
    expect(leaks).toEqual([]);
  }, 120_000);
});
