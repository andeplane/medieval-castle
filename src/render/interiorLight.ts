// Interior daylight (threejs-lighting, game-materials-shaders). Indoors the outdoor hemisphere light
// and sky IBL would light every surface evenly and turn halls flat grey, so interior materials use
// `lightsNode = lights([sun])` (the shadowed sun still pours through the windows) and replace the
// environment with their own irradiance:
//   - every aperture of the fragment's room (glass, open doors, grilles, doorways to lit rooms) is an
//     area light whose exact form factor is integrated per pixel (polygon edge integral, Heitz 2016),
//     clipped to the part of the glass the point can see through its splayed embrasure;
//   - plus split-flux inter-reflection per room (sky + sun flux in, spread over the room's area);
//   - plus a small floor so windowless cellars stay just readable.
// The "bake" is CPU work in milliseconds: tag each interior triangle with its room (vertex attribute
// `interiorRoom`), turn windows and doors into apertures, test each window's sun visibility against
// the castle with three-mesh-bvh, and solve the room fluxes. All of it re-runs when the sun moves or
// a door opens; the per-room table lives in one float texture.
import * as THREE from 'three/webgpu';
import { IrradianceNode } from 'three/webgpu';
import * as T3 from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import {
  Fn, If, Loop, Break, attribute, textureLoad, ivec2, int, float, vec3, uniform, positionWorld, normalWorld, select, max, inverseSqrt, sqrt, lights, mix,
  cameraPosition, uv, vec2, fract, min, smoothstep,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { Materials } from './materials';
import type { InteriorGroup, InteriorPlan, RoomSpec, SpaceId, V3 } from '../castle/interior/types';
import {
  type Aperture, type Daylight, type WindowInput, apertureFrame, doorsToApertures, nearestRoom, solveRooms, windowsToApertures,
} from './interiorMath';

export const MAX_AP = 8;          // apertures per room the shader integrates
const TEXELS = 5;                 // per aperture
const TEX_W = 1 + MAX_AP * TEXELS;
export const MAX_ROOMS = 1024;

/** Interior keys the shell bins geometry into (InteriorGroup meshes are one per key). */
export type InteriorKey = 'old' | 'new' | 'trim' | 'wood' | 'iron' | 'glass';
export type InteriorMaterials = Record<InteriorKey, THREE.MeshStandardNodeMaterial>;

/** Shared lighting state: the room table and artist knobs (live-tweakable from the console). */
export const interiorLight = {
  table: (() => {
    const t = new THREE.DataTexture(new Float32Array(TEX_W * MAX_ROOMS * 4), TEX_W, MAX_ROOMS, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
    return t;
  })(),
  /** irradiance floor so unlit stone never goes pure black (cellars, tunnels) */
  floor: uniform(new THREE.Vector3(0.0105, 0.0105, 0.0115)),
  /** daylight gain indoors: the eye adapts further than the 2.5-stop exposure range */
  gain: uniform(8),
  /** glass glow multiplier (radiance seen on the inside of the panes) */
  glow: uniform(1.0),
};

// ---------- shader ----------

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
const tex = (x: Node<'int'>, r: Node<'int'>) => textureLoad(interiorLight.table, ivec2(x, r));

/** Daylight irradiance at the fragment from its room's apertures + bounce + floor. */
export const interiorIrradiance = Fn(() => {
  const r = row().toVar();
  const P = positionWorld, N = normalWorld.toVar();
  const E = vec3(interiorLight.floor).toVar();
  If(r.greaterThanEqual(0), () => {
    const head = tex(int(0), r);
    E.addAssign(head.yzw.mul(interiorLight.gain));
    const count = int(head.x);
    Loop(MAX_AP, ({ i }: { i: Node<'int'> }) => {
      If(i.greaterThanEqual(count), () => { Break(); });
      const x = i.mul(TEXELS).add(1);
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
          // horizon handling: exact above the tangent plane, a smooth quadratic through it
          const e = select(cw.greaterThanEqual(s), f.mul(cw), select(cw.lessThanEqual(s.negate()), float(0), f.mul(cw.add(s)).mul(cw.add(s)).div(s.mul(4))));
          E.addAssign(L.mul(e.mul(Math.PI)).mul(interiorLight.gain));
        });
      });
    });
  });
  return E;
});

/** Radiance on the room side of a pane: the aperture whose glass plane the fragment sits on. */
const paneGlow = Fn(() => {
  const r = row().toVar();
  const Lo = vec3(0).toVar();
  If(r.greaterThanEqual(0), () => {
    const count = int(tex(int(0), r).x);
    Loop(MAX_AP, ({ i }: { i: Node<'int'> }) => {
      If(i.greaterThanEqual(count), () => { Break(); });
      const x = i.mul(TEXELS).add(1);
      const t0 = tex(x, r), t1 = tex(x.add(1), r), t2 = tex(x.add(2), r), t3 = tex(x.add(3), r);
      const nIn = t1.xyz.cross(t2.xyz), d = positionWorld.sub(t0.xyz);
      const onPane = d.dot(nIn).abs().lessThan(0.08).and(d.dot(t1.xyz).abs().lessThan(t1.w.add(0.05))).and(d.dot(t2.xyz).abs().lessThan(t2.w.add(0.05)));
      const seenFromRoom = cameraPosition.sub(t0.xyz).dot(nIn).greaterThan(0);
      If(onPane.and(seenFromRoom), () => { Lo.assign(t3.xyz); Break(); });
    });
  });
  return Lo;
});

/**
 * Interior clones of the stone, timber, iron and glass materials. Same surface look; lit by the sun
 * (shadowed) plus the interior irradiance instead of the outdoor hemisphere and sky IBL.
 */
export function makeInteriorMaterials(M: Materials, sun: THREE.DirectionalLight): InteriorMaterials {
  const sunOnly = lights([sun]);
  const mk = (src: THREE.MeshStandardNodeMaterial, name: string) => {
    const m = src.clone() as THREE.MeshStandardNodeMaterial;
    m.name = `interior-${name}`;
    m.lightsNode = sunOnly;
    (m as unknown as { setupEnvironment: () => unknown }).setupEnvironment = () => new IrradianceNode(interiorIrradiance());
    return m;
  };
  const glass = mk(M.glass, 'glass');
  glass.side = THREE.DoubleSide;
  {
    // leaded quarries (same pattern as the outside), glowing with the daylight behind them
    const t = uv().mul(1 / 0.16), dd = vec2(t.x.add(t.y), t.x.sub(t.y)), f = fract(dd);
    const line = min(min(f.x, float(1).sub(f.x)), min(f.y, float(1).sub(f.y)));
    const pane = smoothstep(0.03, 0.07, line);
    glass.emissiveNode = paneGlow().mul(pane.mul(0.85).add(0.03)).mul(interiorLight.glow);
  }
  return { old: mk(M.old, 'old'), new: mk(M.new, 'new'), trim: mk(M.trim, 'trim'), wood: mk(M.wood, 'wood'), iron: mk(M.iron, 'iron'), glass };
}

// ---------- bake ----------

export interface BakeOpts {
  plan: InteriorPlan;
  /** Glazed windows: castle.ts `lights` (WindowLight {p, n, w, h}) or richer records with embrasure sizes. */
  windows: WindowInput[];
  sun: THREE.DirectionalLight;
  /** outdoor sky radiance near the horizon at full daylight (scene units); scaled by sun height */
  skyL?: V3;
  /** how far (m) from a room polygon a surface may sit and still belong to it (wall thickness) */
  maxWall?: number;
}

export interface InteriorBake {
  ms: number; bvhMs: number; rooms: number; triangles: number;
  apertures: (Aperture & { group?: string })[];
  roomIndex: Map<SpaceId, number>;
  /** re-solve after the sun moves (sky.setTime) */
  update(): void;
  /** doors module: 0 = shut, 1 = wide open */
  setDoorOpen(doorId: string, open: number): void;
  /** per-room solved light, for debugging (__game.state) */
  roomLight(id: SpaceId): { bounce: V3; direct: V3 } | null;
}

const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _nm = new THREE.Matrix3();

/** Tag every triangle of the interior groups with its room (`interiorRoom` attribute, -1 = none). */
function tagRooms(groups: InteriorGroup[], rooms: RoomSpec[], index: Map<SpaceId, number>, maxWall: number) {
  let tris = 0;
  for (const g of groups) {
    const prefer = new Set(g.rooms.map((id) => index.get(id)).filter((i): i is number => i !== undefined));
    g.object.updateMatrixWorld(true);
    g.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      let geo = mesh.geometry as THREE.BufferGeometry;
      if (geo.index) { geo = geo.toNonIndexed(); mesh.geometry = geo; }
      const pos = geo.attributes.position, nor = geo.attributes.normal;
      const out = new Float32Array(pos.count);
      _nm.getNormalMatrix(mesh.matrixWorld);
      for (let t = 0; t < pos.count; t += 3) {
        _v.set(0, 0, 0); _n.set(0, 0, 0);
        for (let k = 0; k < 3; k++) { _v.x += pos.getX(t + k) / 3; _v.y += pos.getY(t + k) / 3; _v.z += pos.getZ(t + k) / 3; if (nor) { _n.x += nor.getX(t + k); _n.y += nor.getY(t + k); _n.z += nor.getZ(t + k); } }
        _v.applyMatrix4(mesh.matrixWorld); _n.applyMatrix3(_nm).normalize();
        // step off the surface into the space it faces
        const p: V3 = [_v.x + _n.x * 0.25, _v.y + _n.y * 0.25, _v.z + _n.z * 0.25];
        const room = nearestRoom(rooms, p, maxWall, prefer);
        out[t] = out[t + 1] = out[t + 2] = room;
      }
      geo.setAttribute('interiorRoom', new THREE.BufferAttribute(out, 1));
      tris += pos.count / 3;
    });
  }
  return tris;
}

/** One BVH over everything that blocks the sun (glass and voids excluded). */
function buildOccluderBVH(occluders: THREE.Object3D[]) {
  const chunks: Float32Array[] = [];
  let total = 0;
  for (const root of occluders) {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      const mat = mesh.material as THREE.Material;
      if (/glass|void/.test(mesh.name) || /glass|void/.test(mat?.name ?? '') || mat?.transparent) return;
      const g = mesh.geometry as THREE.BufferGeometry, pos = g.attributes.position;
      if (!pos) return;
      const idx = g.index, n = idx ? idx.count : pos.count, out = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        _v.fromBufferAttribute(pos as THREE.BufferAttribute, idx ? idx.getX(i) : i).applyMatrix4(mesh.matrixWorld);
        out[i * 3] = _v.x; out[i * 3 + 1] = _v.y; out[i * 3 + 2] = _v.z;
      }
      chunks.push(out); total += out.length;
    });
  }
  const all = new Float32Array(total);
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  const geo = new T3.BufferGeometry();
  geo.setAttribute('position', new T3.BufferAttribute(all, 3));
  return new MeshBVH(geo as never);
}

/**
 * Prepare the interior light for these groups: tag rooms, build apertures and the sun-visibility BVH,
 * solve the rooms and fill the shader table. `occluders` are the castle shell and the interior groups.
 */
export function bakeInteriorLight(groups: InteriorGroup[], occluders: THREE.Object3D[], opts: BakeOpts): InteriorBake {
  const t0 = performance.now();
  const rooms = opts.plan.rooms.slice(0, MAX_ROOMS);
  if (opts.plan.rooms.length > MAX_ROOMS) console.warn(`interior light: ${opts.plan.rooms.length} rooms, table holds ${MAX_ROOMS}`);
  const index = new Map(rooms.map((r, i) => [r.id, i] as [SpaceId, number]));
  const triangles = tagRooms(groups, rooms, index, opts.maxWall ?? 4.5);
  const aps: (Aperture & { group?: string })[] = [...windowsToApertures(rooms, opts.windows), ...doorsToApertures(opts.plan, index)];
  const groupOf = new Map<number, string>();
  for (const g of groups) for (const id of g.rooms) { const i = index.get(id); if (i !== undefined) groupOf.set(i, g.key); }
  for (const a of aps) a.group = groupOf.get(a.room);
  const links: { a: number; b: number; area: number }[] = [];
  for (const s of opts.plan.stairs) for (let i = 0; i + 1 < s.spaces.length; i++) {
    const a = index.get(s.spaces[i]), b = index.get(s.spaces[i + 1]);
    if (a !== undefined && b !== undefined && a !== b) links.push({ a, b, area: s.width * 2.2 });
  }
  const tb = performance.now();
  const bvh = buildOccluderBVH(occluders);
  const bvhMs = performance.now() - tb;

  const ray = new T3.Ray(), sunDir = new THREE.Vector3();
  const day: Daylight = { sunDir: [0, 1, 0], sunE: [3, 3, 3], skyL: [0.3, 0.3, 0.3], groundAlbedo: 0.18 };
  const skyBase = opts.skyL ?? [0.27, 0.285, 0.31];
  let solved: ReturnType<typeof solveRooms> | null = null;

  /** fraction of 5 points just outside the glass that see the sun past the rest of the castle */
  const sunVisibility = (ap: Aperture) => {
    if (ap.kind === 'portal' || sunDir.dot(_v.set(...ap.n)) <= 0 || sunDir.y <= 0) return 0;
    const { a, u } = apertureFrame(ap);
    let vis = 0;
    for (const [s, t] of [[0, 0], [-0.35, -0.35], [0.35, -0.35], [-0.35, 0.35], [0.35, 0.35]]) {
      const off = ap.outer + 0.08;
      ray.origin.set(ap.c[0] + a[0] * s * ap.w + u[0] * t * ap.h + ap.n[0] * off, ap.c[1] + a[1] * s * ap.w + u[1] * t * ap.h + ap.n[1] * off, ap.c[2] + a[2] * s * ap.w + u[2] * t * ap.h + ap.n[2] * off);
      ray.direction.copy(sunDir as unknown as T3.Vector3);
      if (!bvh.raycastFirst(ray, T3.DoubleSide, 0.02, 600)) vis++;
    }
    return vis / 5;
  };

  const write = () => {
    if (!solved) return;
    const data = interiorLight.table.image.data as Float32Array;
    data.fill(0);
    const per = rooms.map(() => [] as number[]);
    aps.forEach((a, i) => per[a.room].push(i));
    rooms.forEach((_, r) => {
      // brightest apertures first; the shader integrates MAX_AP of them
      const list = per[r].map((i) => ({ i, L: solved!.radiance[i][0] + solved!.radiance[i][1] + solved!.radiance[i][2] })).filter((x) => x.L > 1e-5)
        .sort((p, q) => q.L * aps[q.i].w * aps[q.i].h - p.L * aps[p.i].w * aps[p.i].h).slice(0, MAX_AP);
      const base = r * TEX_W * 4, b = solved!.light[r].bounce;
      data.set([list.length, b[0], b[1], b[2]], base);
      list.forEach(({ i }, k) => {
        const ap = aps[i], { a, u } = apertureFrame(ap), L = solved!.radiance[i], o = base + (1 + k * TEXELS) * 4;
        data.set([ap.c[0], ap.c[1], ap.c[2], ap.depth, a[0], a[1], a[2], ap.w / 2, u[0], u[1], u[2], ap.h / 2, L[0], L[1], L[2], ap.wi / 2, ap.hi / 2, ap.yi, 0, 0], o);
      });
    });
    interiorLight.table.needsUpdate = true;
  };

  let sunVis: number[] = [];
  const update = () => {
    const sun = opts.sun;
    sunDir.subVectors(sun.position, sun.target.position).normalize();
    day.sunDir = [sunDir.x, sunDir.y, sunDir.z];
    day.sunE = [sun.color.r * sun.intensity, sun.color.g * sun.intensity, sun.color.b * sun.intensity];
    const dayK = Math.min(1, Math.max(0.04, (sunDir.y + 0.05) / 0.35));
    day.skyL = [skyBase[0] * dayK, skyBase[1] * dayK, skyBase[2] * dayK];
    sunVis = aps.map(sunVisibility);
    solved = solveRooms(rooms, aps, day, sunVis, links);
    write();
  };
  update();
  const ms = performance.now() - t0;
  return {
    ms, bvhMs, rooms: rooms.length, triangles, apertures: aps, roomIndex: index, update,
    setDoorOpen(id, open) {
      let hit = false;
      for (const a of aps) if (a.door === id && a.kind !== 'grille') { a.open = Math.max(0, Math.min(1, open)); hit = true; }
      if (hit && solved) { solved = solveRooms(rooms, aps, day, sunVis, links); write(); }
    },
    roomLight(id) { const i = index.get(id); return i === undefined || !solved ? null : solved.light[i]; },
  };
}
