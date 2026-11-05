// Exterior window glass that shows the room behind it. Each glass triangle carries the index of the
// interior visibility group behind it (`windowGroup` attribute). While that group is shown the pane
// is thin, slightly tinted, unreflective glass you see the real room through; while it is culled
// the pane is the opaque dark leaded glass, glowing warm at night if the room has firelight.
// One material, one draw call; the per-group flags live in a small float texture.
import * as THREE from 'three/webgpu';
import { attribute, float, fract, min, mix, max, smoothstep, texture, uniform, uv, vec2, vec3, select } from 'three/tsl';
import type { InteriorGroup, RoomSpec, SpaceId } from '../castle/interior/types';
import { tagTriangles } from './interiorMath';

const nightUniform = () => uniform(0);

export interface WindowFlags {
  tex: THREE.DataTexture;
  size: number;
  /** 0 = day, 1 = night: scales the warm glow of culled rooms with fire. */
  night: ReturnType<typeof nightUniform>;
  /** Write the shown / fire flags of every group; uploads only when something changed. */
  set(shown: ArrayLike<boolean>, fire: ArrayLike<boolean>): boolean;
}

/** Pack (shown, fire) per group into RGBA texels; returns whether `data` changed. */
export function packWindowFlags(data: Float32Array, shown: ArrayLike<boolean>, fire: ArrayLike<boolean>) {
  let changed = false;
  for (let i = 0; i < data.length / 4; i++) {
    const s = shown[i] ? 1 : 0, f = fire[i] ? 1 : 0;
    if (data[i * 4] !== s || data[i * 4 + 1] !== f) { data[i * 4] = s; data[i * 4 + 1] = f; changed = true; }
  }
  return changed;
}

export function createWindowFlags(size = 256): WindowFlags {
  const data = new Float32Array(size * 4);
  const tex = new THREE.DataTexture(data, size, 1, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  const night = nightUniform();
  return {
    tex, size, night,
    set(shown, fire) { const c = packWindowFlags(data, shown, fire); if (c) tex.needsUpdate = true; return c; },
  };
}

/** Night factor from the sun's height (y of the unit sun direction): 0 by day, 1 after dusk. */
export const nightOf = (sunY: number) => 1 - Math.min(1, Math.max(0, (sunY + 0.06) / 0.2));

/** Centroid and unit normal of each triangle of a non-indexed soup: [cx, cy, cz, nx, ny, nz] per triangle. */
export function triFrames(pos: ArrayLike<number>) {
  const out = new Float32Array((pos.length / 9) * 6);
  for (let t = 0; t < pos.length / 9; t++) {
    const o = t * 9, e = [pos[o + 3] - pos[o], pos[o + 4] - pos[o + 1], pos[o + 5] - pos[o + 2], pos[o + 6] - pos[o], pos[o + 7] - pos[o + 1], pos[o + 8] - pos[o + 2]];
    const n = [e[1] * e[5] - e[2] * e[4], e[2] * e[3] - e[0] * e[5], e[0] * e[4] - e[1] * e[3]], L = Math.hypot(n[0], n[1], n[2]) || 1;
    out.set([(pos[o] + pos[o + 3] + pos[o + 6]) / 3, (pos[o + 1] + pos[o + 4] + pos[o + 7]) / 3, (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3, n[0] / L, n[1] / L, n[2] / L], t * 6);
  }
  return out;
}

/** Is there an interior pane (from `triFrames`) in the same plane within `reach` of point c? */
export function paneNear(panes: Float32Array, c: ArrayLike<number>, reach = 1.5, plane = 0.15) {
  for (let i = 0; i < panes.length; i += 6) {
    const d = [c[0] - panes[i], c[1] - panes[i + 1], c[2] - panes[i + 2]];
    if (Math.abs(d[0]) > reach || Math.abs(d[1]) > reach || Math.abs(d[2]) > reach) continue;
    if (Math.abs(d[0] * panes[i + 3] + d[1] * panes[i + 4] + d[2] * panes[i + 5]) < plane) return true;
  }
  return false;
}

/**
 * Tag exterior glass with the group behind it: the room just inside each triangle (against its
 * outward normal) → that room's group index, or -1. Only windows with an embrasure (an interior pane
 * right behind the glass, `panes` from `triFrames`) are tagged: the others stay opaque, since there
 * is no room to see. Returns the number of tagged triangles.
 */
export function tagWindowGroups(geo: THREE.BufferGeometry, rooms: RoomSpec[], groupOfRoom: (id: SpaceId) => number, panes: Float32Array, maxWall = 4.5) {
  const pos = geo.attributes.position.array as ArrayLike<number>, nor = geo.attributes.normal?.array as ArrayLike<number> | undefined;
  const flip = nor ? Float32Array.from(nor, (v) => -v) : null;
  const room = tagTriangles(pos, flip, rooms, maxWall);
  const frames = triFrames(pos);
  let n = 0;
  const g = new Float32Array(room.length).fill(-1);
  for (let t = 0; t * 3 < room.length; t++) {
    const r = room[t * 3];
    if (r < 0 || !paneNear(panes, frames.subarray(t * 6))) continue;
    const k = groupOfRoom(rooms[r].id);
    g[t * 3] = g[t * 3 + 1] = g[t * 3 + 2] = k;
    if (k >= 0) n++;
  }
  geo.setAttribute('windowGroup', new THREE.BufferAttribute(g, 1));
  return n;
}

/** Group index per room id for `tagWindowGroups`. */
export function groupIndexOfRooms(groups: InteriorGroup[]) {
  const m = new Map<SpaceId, number>();
  groups.forEach((g, i) => { for (const id of g.rooms) m.set(id, i); });
  return (id: SpaceId) => m.get(id) ?? -1;
}

/**
 * The exterior glass: a clone of the see-through leaded glass (render/materials.ts) whose quarries
 * turn into an opaque dark pane while the room behind is culled (or there is no room to see).
 */
export function makeWindowGlass(src: THREE.MeshStandardNodeMaterial, flags: WindowFlags) {
  const m = src.clone() as THREE.MeshStandardNodeMaterial;
  m.name = 'window-glass';
  m.transparent = true;
  const k = attribute('windowGroup', 'float');
  const f = texture(flags.tex, vec2(max(k, 0).add(0.5).div(flags.size), 0.5));
  const shown = select(k.lessThan(0), float(0), f.x), fire = select(k.lessThan(0), float(0), f.y);
  const t = uv().mul(1 / 0.16), d = vec2(t.x.add(t.y), t.x.sub(t.y)), q = fract(d);
  const line = min(min(q.x, float(1).sub(q.x)), min(q.y, float(1).sub(q.y)));
  const lead = float(1).sub(smoothstep(0.03, 0.07, line));
  // shown: the source's own opacity (thin glass); culled: opaque
  m.opacityNode = mix(float(1), (src.opacityNode ?? float(1)) as unknown as ReturnType<typeof float>, shown);
  // culled rooms with firelight: a warm glow in the quarries at night
  m.emissiveNode = vec3(1.0, 0.55, 0.22).mul(fire.mul(float(1).sub(shown)).mul(flags.night).mul(float(1).sub(lead)).mul(0.9));
  return m;
}
