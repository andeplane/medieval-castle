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
import { LightingNode } from 'three/webgpu';
import * as T3 from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { uniform, lights, uv, vec2, fract, min, float, smoothstep, mix, transformDirection, cameraViewMatrix } from 'three/tsl';
import { interiorIrradiance, paneGlow, fireLights } from './interiorShader';
import { FIRE_W, MAX_FIRES, type Fire, type FireTable } from '../light/roomLight';
import { tagBoxes } from '../world/visibility';
import { Builder, type MatKey } from '../castle/builder';
import type { InteriorGroup, InteriorPlan, SpaceId, V3 } from '../castle/interior/types';
import {
  type Aperture, type Daylight, type WindowInput, type RoomGrid, AP_TEXELS, apertureFrame, outdoorRevealTest, ceilingSkins, doorsToApertures, fillRoomGrid, passageSkins, packTable, roomGridFor, skinQuads, solveRooms, tagTriangles, windowsToApertures,
} from './interiorMath';

import { MAX_AP } from './interiorShader';
export { MAX_AP };
const TEX_W = 1 + MAX_AP * AP_TEXELS;

/** Interior keys the shell bins geometry into (InteriorGroup meshes are one per key). */
export type InteriorKey = 'old' | 'new' | 'trim' | 'wood' | 'iron' | 'glass';
export type InteriorMaterials = Record<InteriorKey, THREE.MeshStandardNodeMaterial>;
/** The material map plus `adopt` (non-enumerable, so `Object.entries(materials)` still lists only
 * materials). Firelight is not a light here: each room's fires come from the fire table
 * (light/roomLight.ts) through the interior irradiance, so no point light is ever picked or culled. */
export type InteriorMaterialSet = InteriorMaterials & {
  /** An interior clone of any other standard material (furniture), lit like the rest of this set
   * (daylight and its room's fires). The same source always gives the same clone. */
  readonly adopt: (src: THREE.MeshStandardNodeMaterial) => THREE.MeshStandardNodeMaterial;
};

/** The room table the shader reads and the artist knobs (live-tweakable from __game.interiorLight). */
export interface InteriorLight {
  table: THREE.DataTexture; maxRooms: number;
  /** irradiance floor so unlit stone never goes pure black (cellars, tunnels); slightly cool, and
   * strong enough that stone away from a torch keeps its grey instead of the fire's colour */
  floor: THREE.UniformNode<'vec3', THREE.Vector3>;
  /** daylight gain indoors: the eye adapts further than the 2.5-stop exposure range allows */
  gain: THREE.UniformNode<'float', number>;
  /** glow multiplier for the inside of the panes */
  glow: THREE.UniformNode<'float', number>;
  /** each room's fires (light/roomLight.ts FireTable.data), one row per room */
  fires: THREE.DataTexture;
  /** this frame's flicker of every fire (FireTable.flick), MAX_FIRES per row */
  flick: THREE.DataTexture;
  /** daylight on the outer half of an outdoor doorway (OUTDOOR_TAG), as the courtyard wall beside it gets
   * it from the hemisphere light and the sky: sky colour facing up, ground colour facing down; the bake
   * scales it with the sun's height */
  outdoor: { sky: THREE.UniformNode<'vec3', THREE.Vector3>; ground: THREE.UniformNode<'vec3', THREE.Vector3> };
  /** which room a point is in, for surfaces with no room tag (door leaves); filled by the bake */
  grid: { texture: THREE.Data3DTexture; origin: THREE.UniformNode<'vec3', THREE.Vector3>; cell: THREE.UniformNode<'vec3', THREE.Vector3>; size: THREE.UniformNode<'vec3', THREE.Vector3>; model: RoomGrid };
  /** a light carried from room to room (the player's cave lantern, player/lantern.ts): it belongs to no
   * room's row, so it lights every interior surface in its range, as a point light would; colour × candela
   * × flicker (0 when out), soft², range (setCarried) */
  carried: { pos: THREE.UniformNode<'vec3', THREE.Vector3>; light: THREE.UniformNode<'vec4', THREE.Vector4>; range: THREE.UniformNode<'float', number> };
}

/** The outdoor ambient at full daylight (world/sky.ts): the hemisphere light (0xcfd0cb over 0x5d6446 at
 * 0.75) plus the sky environment at 0.5 (≈ π × 0.27 sky radiance × 0.5 from above). */
export const OUTDOOR_SKY = [0.81 * 0.75 + 0.42, 0.82 * 0.75 + 0.44, 0.8 * 0.75 + 0.47];
export const OUTDOOR_GROUND = [0.36 * 0.75 + 0.1, 0.39 * 0.75 + 0.1, 0.27 * 0.75 + 0.1];

const nearest = <T extends THREE.Texture>(t: T) => { t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; return t; };

/** `rooms`: the plan the bake will light (its bounds size the room grid; the bake fills it). */
export function createInteriorLight(maxRooms = 1024, rooms: InteriorPlan['rooms'] = []): InteriorLight {
  const table = nearest(new THREE.DataTexture(new Float32Array(TEX_W * maxRooms * 4), TEX_W, maxRooms, THREE.RGBAFormat, THREE.FloatType));
  const fires = nearest(new THREE.DataTexture(new Float32Array(FIRE_W * maxRooms * 4), FIRE_W, maxRooms, THREE.RGBAFormat, THREE.FloatType));
  const flick = nearest(new THREE.DataTexture(new Float32Array(MAX_FIRES * maxRooms).fill(1), MAX_FIRES, maxRooms, THREE.RedFormat, THREE.FloatType));
  const model = roomGridFor(rooms.slice(0, maxRooms));
  const tex = nearest(new THREE.Data3DTexture(model.data, model.size[0], model.size[1], model.size[2]));
  tex.format = THREE.RedFormat; tex.type = THREE.FloatType;
  const v = (a: number[]) => uniform(new THREE.Vector3(a[0], a[1], a[2]));
  return {
    table, maxRooms, floor: uniform(new THREE.Vector3(0.145, 0.145, 0.155)), gain: uniform(12), glow: uniform(1), fires, flick,
    outdoor: { sky: v(OUTDOOR_SKY), ground: v(OUTDOOR_GROUND) },
    grid: { texture: tex, origin: v(model.origin), cell: v(model.cell), size: v(model.size), model },
    carried: { pos: v([0, -1000, 0]), light: uniform(new THREE.Vector4(0, 0, 0, 1)), range: uniform(1) },
  };
}

/** Copy a FireTable into the light's textures: the rows when they changed, the flicker every call. */
export function syncFires(light: InteriorLight, t: FireTable, seen: { version: number }) {
  if (seen.version !== t.version) { (light.fires.image.data as Float32Array).set(t.data); light.fires.needsUpdate = true; seen.version = t.version; }
  (light.flick.image.data as Float32Array).set(t.flick); light.flick.needsUpdate = true;
}

/** Set the carried light (light/roomLight.ts toFire of its emitter) at this frame's flicker `k`; null puts it out. */
export function setCarried(light: InteriorLight, f: Fire | null, k = 1) {
  const c = light.carried;
  if (!f) { c.light.value.set(0, 0, 0, 1); return; }
  c.pos.value.set(f.position[0], f.position[1], f.position[2]);
  c.light.value.set(f.colour[0] * f.candela * k, f.colour[1] * f.candela * k, f.colour[2] * f.candela * k, f.soft * f.soft);
  c.range.value = f.range;
}

/** Daylight (irradiance only, as before) plus the fires as point lights (interiorShader.fireLights): the
 * lighting model gives them diffuse and a specular highlight, so brass and iron are dark but for the
 * glint of the fire they face, as metal by a fire is. (They went in as a uniform environment before,
 * so every metal near a fire reflected it from all sides and shone near-white: the hall's armour.) */
export class InteriorEnvNode extends LightingNode {
  /** `fires(add)`: hands every light of the fragment to `add` (interiorShader.fireLights, in the lighting stack). */
  constructor(private day: THREE.Node, private fires: (add: (L: THREE.Node<'vec3'>, c: THREE.Node<'vec3'>) => void) => void) { super(); }
  setup(builder: THREE.NodeBuilder) {
    const ctx = builder.context as unknown as {
      irradiance: THREE.Node & { addAssign(n: unknown): void };
      lightingModel: { direct(d: { lightDirection: unknown; lightColor: unknown; reflectedLight: unknown }, b: THREE.NodeBuilder): void };
      reflectedLight: unknown;
    };
    ctx.irradiance.addAssign(this.day);
    this.fires((L, c) => ctx.lightingModel.direct({ lightDirection: transformDirection(L, cameraViewMatrix), lightColor: c, reflectedLight: ctx.reflectedLight }, builder));
    return null;
  }
}

/**
 * Interior clones of the stone, timber, iron and glass materials. Same surface look; lit by the
 * shadowed sun plus the interior irradiance instead of the outdoor hemisphere and sky IBL.
 * `sun: null` gives the underground set: no direct sun at all (cellars and tunnels get daylight only
 * through their openings, via the irradiance, and firelight from the fire table, fireLights).
 */
export function makeInteriorMaterials(M: Record<InteriorKey, THREE.MeshStandardNodeMaterial>, sun: THREE.Light | null, light: InteriorLight): InteriorMaterialSet {
  const base = sun ? [sun] : [];
  const sunOnly = lights(base);
  const irr = interiorIrradiance(light);
  const mk = (src: THREE.MeshStandardNodeMaterial, name: string) => {
    const m = src.clone() as THREE.MeshStandardNodeMaterial;
    m.name = sun ? `interior-${name}` : `interior-under-${name}`;
    m.lightsNode = sunOnly;
    // (fireLights emits TSL: it runs when the renderer builds the shader, checked by the captures)
    (m as unknown as { setupEnvironment: () => unknown }).setupEnvironment = () => new InteriorEnvNode(irr, /* v8 ignore next */ (add) => fireLights(light, add));
    return m;
  };
  const glass = mk(M.glass, 'glass');
  glass.side = THREE.DoubleSide;
  // leaded quarries (as outside), glowing with the daylight behind them when seen from the room
  const t = uv().mul(1 / 0.16), dd = vec2(t.x.add(t.y), t.x.sub(t.y)), f = fract(dd);
  const line = min(min(f.x, float(1).sub(f.x)), min(f.y, float(1).sub(f.y)));
  glass.emissiveNode = paneGlow(light).mul(smoothstep(0.03, 0.07, line).mul(0.85).add(0.03)).mul(light.glow).mul(light.gain.mul(0.3));
  // see-through between the leads, both ways (the exterior pane, render/windowGlass.ts, sits 2 mm outside)
  glass.transparent = true;
  glass.opacityNode = mix(float(0.3), float(1), float(1).sub(smoothstep(0.03, 0.07, line)));
  const set = { old: mk(M.old, 'old'), new: mk(M.new, 'new'), trim: mk(M.trim, 'trim'), wood: mk(M.wood, 'wood'), iron: mk(M.iron, 'iron'), glass };
  const adopted = new Map<THREE.Material, THREE.MeshStandardNodeMaterial>();
  Object.defineProperty(set, 'adopt', {
    enumerable: false,
    value: (src: THREE.MeshStandardNodeMaterial) => {
      let m = adopted.get(src);
      if (!m) { m = mk(src, src.name || 'prop'); adopted.set(src, m); }
      return m;
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
  /** where the bake time went: room tagging, apertures, sun rays + solve + table */
  timings: { tag: number; apertures: number; update: number };
  apertures: (Aperture & { group?: string })[];
  roomIndex: Map<SpaceId, number>;
  /** re-solve after the sun moves (sky.setTime) */
  update(): void;
  /** doors module (any agent may open a door): 0 = shut, 1 = wide open */
  setDoorOpen(doorId: string, open: number): void;
  roomLight(id: SpaceId): { bounce: V3; direct: V3 } | null;
}

/**
 * Tag every triangle of the interior groups with its room (`interiorRoom` attribute, -1 = none). From the
 * same walk, each mesh is frustum culled by its rooms' boxes instead of one sphere round the group
 * (world/visibility.ts tagBoxes); which groups are drawn stays the room graph's.
 */
export function tagGroups(groups: InteriorGroup[], rooms: InteriorPlan['rooms'], index: Map<SpaceId, number>, maxWall: number, outdoor?: (p: V3, n: V3) => boolean) {
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
      const tags = tagTriangles(wp, wn, rooms, maxWall, prefer, outdoor);
      geo.setAttribute('interiorRoom', new THREE.BufferAttribute(tags, 1));
      const boxes = tagBoxes(wp, tags).map((b) => new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)));
      mesh.userData.roomBoxes = boxes; // world space: the groups never move
      mesh.intersectsFrustum = (f: THREE.Frustum) => boxes.some((b) => f.intersectsBox(b));
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
  const triangles = tagGroups(groups, rooms, index, opts.maxWall ?? 4.5, outdoorRevealTest(opts.plan.doors));
  fillRoomGrid(opts.light.grid.model, rooms); opts.light.grid.texture.needsUpdate = true;
  const t1 = now();
  const aps: (Aperture & { group?: string })[] = [...windowsToApertures(rooms, opts.windows), ...doorsToApertures({ ...opts.plan, rooms }, index)];
  const groupOf = new Map<number, string>();
  for (const g of groups) for (const id of g.rooms) { const i = index.get(id); if (i !== undefined) groupOf.set(i, g.key); }
  for (const a of aps) a.group = groupOf.get(a.room);
  const links: { a: number; b: number; area: number }[] = [];
  for (const s of opts.plan.stairs) for (let i = 0; i + 1 < s.spaces.length; i++) {
    const a = index.get(s.spaces[i]), b = index.get(s.spaces[i + 1]);
    if (a !== undefined && b !== undefined && a !== b) links.push({ a, b, area: s.width * 2.2 });
  }
  const t2 = now();
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
    opts.light.outdoor.sky.value.set(OUTDOOR_SKY[0] * dayK, OUTDOOR_SKY[1] * dayK, OUTDOOR_SKY[2] * dayK);
    opts.light.outdoor.ground.value.set(OUTDOOR_GROUND[0] * dayK, OUTDOOR_GROUND[1] * dayK, OUTDOOR_GROUND[2] * dayK);
    sunVis = aps.map(sunVisibility);
    solved = solveRooms(rooms, aps, day, sunVis, links);
    write();
  };
  const t3 = now();
  update();
  const t4 = now();
  return {
    ms: t4 - t0, timings: { tag: t1 - t0, apertures: t2 - t1, update: t4 - t3 }, rooms: rooms.length, triangles, apertures: aps, roomIndex: index, update,
    setDoorOpen(id, open) {
      let hit = false;
      for (const a of aps) if (a.door === id) { a.open = Math.max(0, Math.min(1, open)); hit = true; }
      if (hit) { solved = solveRooms(rooms, aps, day, sunVis, links); write(); }
    },
    roomLight(id) { const i = index.get(id); return i === undefined ? null : solved.light[i]; },
  };
}

/**
 * Invisible shadow casters inside the walls and round the passages through them (see interiorMath.skinQuads,
 * passageSkins). One mesh, one draw call that
 * writes nothing to colour or depth; it only shows up in the sun's shadow maps.
 */
export function buildShadowSkins(plan: InteriorPlan, apertures: Aperture[], inset = 0.22) {
  const B = new Builder();
  for (const q of skinQuads(plan.rooms, apertures, inset)) {
    const f = { o: q.o, r: q.r, u: [0, 1, 0] as V3, n: q.n };
    B.planar('old', f, [[0, q.y0], [q.L, q.y0], [q.L, q.y1], [0, q.y1]], 0, q.holes.map(([s0, y0, s1, y1]) => [[s0, y0], [s1, y0], [s1, y1], [s0, y1]]));
  }
  for (const c of ceilingSkins(plan.rooms, 0.55, inset + 0.1)) B.cap('old', c.poly, c.y, false);
  const rooms = new Set(plan.rooms.map((r) => r.id));
  for (const [p, q, r, s] of passageSkins(plan.doors, (id) => rooms.has(id), apertures)) { B.bins.old.tri(p, q, r, null, [0, 0], [0, 0], [0, 0]); B.bins.old.tri(p, r, s, null, [0, 0], [0, 0], [0, 0]); }
  const mat = new THREE.MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false });
  mat.name = 'interior-shadow-skin';
  // both faces reach the shadow map: by default it draws only faces turned away from the sun, so the skin
  // of a wall between two rooms stopped the sun from one side only, and a passage's skins from neither
  mat.shadowSide = THREE.DoubleSide;
  const all: Record<MatKey, THREE.Material> = { old: mat, new: mat, trim: mat, slate: mat, lead: mat, wood: mat, iron: mat, void: mat, glass: mat };
  const g = B.build(all);
  const mesh = (g.children[0] as THREE.Mesh | undefined) ?? new THREE.Mesh(new THREE.BufferGeometry(), mat);
  mesh.name = 'interior-shadow-skin';
  mesh.castShadow = true; mesh.receiveShadow = false;
  return mesh;
}
