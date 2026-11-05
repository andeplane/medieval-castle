// Interior daylight (threejs-lighting, game-materials-shaders). Indoors the outdoor hemisphere light
// and sky IBL would light every surface evenly and turn halls flat grey, so interior materials use
// `lightsNode = lights([sun])` (the shadowed sun still pours through the windows) and replace the
// environment with their own irradiance:
//   - every aperture of the fragment's room (glass, open doors, grilles, doorways to lit rooms) is an
//     area light whose exact form factor is integrated per pixel (polygon edge integral, Hill & Heitz
//     2016), clipped to the part of the glass the point can see through its splayed embrasure;
//   - split-flux inter-reflection per room (sky + sun flux in, spread over the room's area);
//   - a small floor so windowless cellars and tunnels stay just readable, never pure black.
// The "bake" is CPU work in milliseconds: tag each interior triangle with its room (vertex attribute
// `interiorRoom`), turn windows and doors into apertures, test each window's sun visibility against
// the castle (three-mesh-bvh), solve the room fluxes and pack the per-room table into one float
// texture. It re-runs when the sun moves or a door opens. Pure parts live in interiorMath.ts.
import * as THREE from 'three/webgpu';
import { IrradianceNode } from 'three/webgpu';
import * as T3 from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { uniform, lights, uv, vec2, fract, min, float, smoothstep } from 'three/tsl';
import { interiorIrradiance, paneGlow } from './interiorShader';
import { Builder, type MatKey } from '../castle/builder';
import type { InteriorGroup, InteriorPlan, SpaceId, V3 } from '../castle/interior/types';
import {
  type Aperture, type Daylight, type WindowInput, AP_TEXELS, apertureFrame, ceilingSkins, doorsToApertures, packTable, skinQuads, solveRooms, tagTriangles, windowsToApertures,
} from './interiorMath';

import { MAX_AP } from './interiorShader';
export { MAX_AP };
const TEX_W = 1 + MAX_AP * AP_TEXELS;

/** Interior keys the shell bins geometry into (InteriorGroup meshes are one per key). */
export type InteriorKey = 'old' | 'new' | 'trim' | 'wood' | 'iron' | 'glass';
export type InteriorMaterials = Record<InteriorKey, THREE.MeshStandardNodeMaterial>;
/** The material map plus a hook for the interior light manager (src/light/): extra lights (candles,
 * torches) join the sun in every interior material. Pass a stable pool and move/dim its lights
 * rather than changing the list: a new list recompiles the interior shaders. Non-enumerable, so
 * `Object.entries(materials)` still lists only materials. */
export type InteriorMaterialSet = InteriorMaterials & { readonly setDynamicLights: (extra: THREE.Light[]) => void };

/** The room table the shader reads and the artist knobs (live-tweakable from __game.interiorLight). */
export interface InteriorLight {
  table: THREE.DataTexture; maxRooms: number;
  /** irradiance floor so unlit stone never goes pure black (cellars, tunnels) */
  floor: THREE.UniformNode<'vec3', THREE.Vector3>;
  /** daylight gain indoors: the eye adapts further than the 2.5-stop exposure range allows */
  gain: THREE.UniformNode<'float', number>;
  /** glow multiplier for the inside of the panes */
  glow: THREE.UniformNode<'float', number>;
}

export function createInteriorLight(maxRooms = 1024): InteriorLight {
  const table = new THREE.DataTexture(new Float32Array(TEX_W * maxRooms * 4), TEX_W, maxRooms, THREE.RGBAFormat, THREE.FloatType);
  table.minFilter = table.magFilter = THREE.NearestFilter; table.generateMipmaps = false; table.needsUpdate = true;
  return { table, maxRooms, floor: uniform(new THREE.Vector3(0.05, 0.05, 0.055)), gain: uniform(12), glow: uniform(1) };
}

/**
 * Interior clones of the stone, timber, iron and glass materials. Same surface look; lit by the
 * shadowed sun plus the interior irradiance instead of the outdoor hemisphere and sky IBL.
 */
export function makeInteriorMaterials(M: Record<InteriorKey, THREE.MeshStandardNodeMaterial>, sun: THREE.Light, light: InteriorLight): InteriorMaterialSet {
  const sunOnly = lights([sun]);
  const irr = interiorIrradiance(light);
  const mk = (src: THREE.MeshStandardNodeMaterial, name: string) => {
    const m = src.clone() as THREE.MeshStandardNodeMaterial;
    m.name = `interior-${name}`;
    m.lightsNode = sunOnly;
    (m as unknown as { setupEnvironment: () => unknown }).setupEnvironment = () => new IrradianceNode(irr);
    return m;
  };
  const glass = mk(M.glass, 'glass');
  glass.side = THREE.DoubleSide;
  // leaded quarries (as outside), glowing with the daylight behind them when seen from the room
  const t = uv().mul(1 / 0.16), dd = vec2(t.x.add(t.y), t.x.sub(t.y)), f = fract(dd);
  const line = min(min(f.x, float(1).sub(f.x)), min(f.y, float(1).sub(f.y)));
  glass.emissiveNode = paneGlow(light).mul(smoothstep(0.03, 0.07, line).mul(0.85).add(0.03)).mul(light.glow).mul(light.gain.mul(0.3));
  const set = { old: mk(M.old, 'old'), new: mk(M.new, 'new'), trim: mk(M.trim, 'trim'), wood: mk(M.wood, 'wood'), iron: mk(M.iron, 'iron'), glass };
  let current: THREE.Light[] = [];
  Object.defineProperty(set, 'setDynamicLights', {
    enumerable: false,
    value: (extra: THREE.Light[]) => {
      if (extra.length === current.length && extra.every((l, i) => l === current[i])) return;
      current = [...extra];
      sunOnly.setLights([sun, ...current]);
      for (const m of Object.values(set)) m.needsUpdate = true;
    },
  });
  return set as InteriorMaterialSet;
}

// ---------- collaborators ----------

/** Answers "does sunlight from `dir` reach `origin`?" (the bake's only geometric query). */
export interface SunOccluder { blocked(origin: V3, dir: V3, far: number): boolean }
/** Sun direction (towards the sun) and its irradiance (colour × intensity). */
export interface SunState { dir: V3; irradiance: V3 }

export function sunStateOf(sun: THREE.DirectionalLight): () => SunState {
  const d = new THREE.Vector3();
  return () => {
    d.subVectors(sun.position, sun.target.position).normalize();
    return { dir: [d.x, d.y, d.z], irradiance: [sun.color.r * sun.intensity, sun.color.g * sun.intensity, sun.color.b * sun.intensity] };
  };
}

const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _nm = new THREE.Matrix3();

/** World-space triangle soup of everything under `roots` that blocks light (glass, voids, skins excluded). */
export function collectTriangles(roots: THREE.Object3D[]) {
  const chunks: Float32Array[] = [];
  let total = 0;
  for (const root of roots) {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.Material;
      if (/glass|void|skin/.test(mesh.name) || /glass|void/.test(mat.name) || mat.transparent) return;
      const g = mesh.geometry as THREE.BufferGeometry, pos = g.attributes.position as THREE.BufferAttribute, idx = g.index;
      const n = idx ? idx.count : pos.count, out = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        _v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(mesh.matrixWorld);
        out[i * 3] = _v.x; out[i * 3 + 1] = _v.y; out[i * 3 + 2] = _v.z;
      }
      chunks.push(out); total += out.length;
    });
  }
  const all = new Float32Array(total);
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  return all;
}

/** SunOccluder backed by one three-mesh-bvh over the given objects. */
export function bvhOccluder(roots: THREE.Object3D[]): SunOccluder & { triangles: number } {
  const pos = collectTriangles(roots);
  const geo = new T3.BufferGeometry();
  geo.setAttribute('position', new T3.BufferAttribute(pos.length ? pos : new Float32Array(9), 3));
  const bvh = new MeshBVH(geo);
  const ray = new T3.Ray();
  return {
    triangles: pos.length / 9,
    blocked(o, d, far) { ray.origin.set(o[0], o[1], o[2]); ray.direction.set(d[0], d[1], d[2]); return !!bvh.raycastFirst(ray, T3.DoubleSide, 0.02, far); },
  };
}

// ---------- bake ----------

export interface BakeOpts {
  plan: InteriorPlan;
  /** Glazed windows: castle.ts `lights` (WindowLight {p, n, w, h}) or richer records with embrasure sizes. */
  windows: WindowInput[];
  sun: () => SunState;
  light: InteriorLight;
  /** outdoor sky radiance near the horizon at full daylight (scene units); scaled by sun height */
  skyL?: V3;
  /** how far (m) from a room polygon a surface may sit and still belong to it (wall thickness) */
  maxWall?: number;
  now?: () => number;
}

export interface InteriorBake {
  ms: number; rooms: number; triangles: number;
  apertures: (Aperture & { group?: string })[];
  roomIndex: Map<SpaceId, number>;
  /** re-solve after the sun moves (sky.setTime) */
  update(): void;
  /** doors module (any agent may open a door): 0 = shut, 1 = wide open */
  setDoorOpen(doorId: string, open: number): void;
  roomLight(id: SpaceId): { bounce: V3; direct: V3 } | null;
}

/** Tag every triangle of the interior groups with its room (`interiorRoom` attribute, -1 = none). */
export function tagGroups(groups: InteriorGroup[], rooms: InteriorPlan['rooms'], index: Map<SpaceId, number>, maxWall: number) {
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
      const wp = new Float32Array(pos.count * 3), wn = nor ? new Float32Array(pos.count * 3) : null;
      _nm.getNormalMatrix(mesh.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        _v.fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(mesh.matrixWorld); wp.set([_v.x, _v.y, _v.z], i * 3);
        if (wn) { _n.fromBufferAttribute(nor as THREE.BufferAttribute, i).applyMatrix3(_nm); wn.set([_n.x, _n.y, _n.z], i * 3); }
      }
      geo.setAttribute('interiorRoom', new THREE.BufferAttribute(tagTriangles(wp, wn, rooms, maxWall, prefer), 1));
      tris += pos.count / 3;
    });
  }
  return tris;
}

/**
 * Prepare the interior light for the shell's groups: tag rooms, build apertures, solve the rooms and
 * fill the shader table. `occluder` answers sun-visibility rays (bvhOccluder over castle + interior).
 */
export function bakeInteriorLight(groups: InteriorGroup[], occluder: SunOccluder, opts: BakeOpts): InteriorBake {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const rooms = opts.plan.rooms.slice(0, opts.light.maxRooms);
  const index = new Map(rooms.map((r, i) => [r.id, i] as [SpaceId, number]));
  const triangles = tagGroups(groups, rooms, index, opts.maxWall ?? 4.5);
  const aps: (Aperture & { group?: string })[] = [...windowsToApertures(rooms, opts.windows), ...doorsToApertures({ ...opts.plan, rooms }, index)];
  const groupOf = new Map<number, string>();
  for (const g of groups) for (const id of g.rooms) { const i = index.get(id); if (i !== undefined) groupOf.set(i, g.key); }
  for (const a of aps) a.group = groupOf.get(a.room);
  const links: { a: number; b: number; area: number }[] = [];
  for (const s of opts.plan.stairs) for (let i = 0; i + 1 < s.spaces.length; i++) {
    const a = index.get(s.spaces[i]), b = index.get(s.spaces[i + 1]);
    if (a !== undefined && b !== undefined && a !== b) links.push({ a, b, area: s.width * 2.2 });
  }
  const day: Daylight = { sunDir: [0, 1, 0], sunE: [3, 3, 3], skyL: [0.3, 0.3, 0.3], groundAlbedo: 0.18 };
  const skyBase = opts.skyL ?? [0.27, 0.285, 0.31];
  let solved = solveRooms(rooms, aps, day, [], links);
  let sunVis: number[] = [];

  /** fraction of 5 points just outside the glass that see the sun past the rest of the castle */
  const sunVisibility = (ap: Aperture) => {
    const s = day.sunDir;
    if (ap.kind === 'portal' || s[1] <= 0 || s[0] * ap.n[0] + s[1] * ap.n[1] + s[2] * ap.n[2] <= 0) return 0;
    const { a, u } = apertureFrame(ap), off = ap.outer + 0.08;
    let vis = 0;
    for (const [i, j] of [[0, 0], [-0.35, -0.35], [0.35, -0.35], [-0.35, 0.35], [0.35, 0.35]]) {
      const o: V3 = [0, 1, 2].map((k) => ap.c[k] + a[k] * i * ap.w + u[k] * j * ap.h + ap.n[k] * off) as V3;
      if (!occluder.blocked(o, s, 600)) vis++;
    }
    return vis / 5;
  };
  const write = () => { packTable(opts.light.table.image.data as Float32Array, TEX_W, MAX_AP, rooms.length, aps, solved); opts.light.table.needsUpdate = true; };
  const update = () => {
    const sun = opts.sun();
    day.sunDir = sun.dir; day.sunE = sun.irradiance;
    const dayK = Math.min(1, Math.max(0.04, (sun.dir[1] + 0.05) / 0.35));
    day.skyL = [skyBase[0] * dayK, skyBase[1] * dayK, skyBase[2] * dayK];
    sunVis = aps.map(sunVisibility);
    solved = solveRooms(rooms, aps, day, sunVis, links);
    write();
  };
  update();
  return {
    ms: now() - t0, rooms: rooms.length, triangles, apertures: aps, roomIndex: index, update,
    setDoorOpen(id, open) {
      let hit = false;
      for (const a of aps) if (a.door === id) { a.open = Math.max(0, Math.min(1, open)); hit = true; }
      if (hit) { solved = solveRooms(rooms, aps, day, sunVis, links); write(); }
    },
    roomLight(id) { const i = index.get(id); return i === undefined ? null : solved.light[i]; },
  };
}

/**
 * Invisible shadow casters inside the walls (see interiorMath.skinQuads). One mesh, one draw call that
 * writes nothing to colour or depth; it only shows up in the sun's shadow maps.
 */
export function buildShadowSkins(plan: InteriorPlan, apertures: Aperture[], inset = 0.22) {
  const B = new Builder();
  for (const q of skinQuads(plan.rooms, apertures, inset)) {
    const f = { o: q.o, r: q.r, u: [0, 1, 0] as V3, n: q.n };
    B.planar('old', f, [[0, q.y0], [q.L, q.y0], [q.L, q.y1], [0, q.y1]], 0, q.holes.map(([s0, y0, s1, y1]) => [[s0, y0], [s1, y0], [s1, y1], [s0, y1]]));
  }
  for (const c of ceilingSkins(plan.rooms, 0.55, inset)) B.cap('old', c.poly, c.y, false);
  const mat = new THREE.MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false });
  mat.name = 'interior-shadow-skin';
  const all: Record<MatKey, THREE.Material> = { old: mat, new: mat, trim: mat, slate: mat, lead: mat, wood: mat, iron: mat, void: mat, glass: mat };
  const g = B.build(all);
  const mesh = (g.children[0] as THREE.Mesh | undefined) ?? new THREE.Mesh(new THREE.BufferGeometry(), mat);
  mesh.name = 'interior-shadow-skin';
  mesh.castShadow = true; mesh.receiveShadow = false;
  return mesh;
}
