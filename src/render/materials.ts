// TSL node materials (game-materials-shaders). Stone gets its look from three layers:
// 1) the generated masonry texture (courses, stones, mortar), 2) per-stone variation from the data
// texture's stone id, 3) world-space weathering: damp base, algae at the waterline, rain streaks,
// lichen on north- and up-facing stone, repair patches. Layer 3 hides tiling and is what makes
// it read as old.
import * as THREE from 'three/webgpu';
import {
  texture, uv, positionWorld, normalWorld, mix, vec2, vec3, float, color, smoothstep, normalMap, clamp, fract, abs, min, max, sin, time, positionLocal, instanceIndex,
} from 'three/tsl';
import type { TexSet } from './texgen';
import { generateTextures } from './texpool';
import { GROUND } from '../castle/spec';
import { makeTerrainMaterial, type GroundData } from '../world/terrainMaterial';

function dataTex(data: Uint8Array, N: number, srgb: boolean) {
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
const texSet = (s: TexSet) => ({ albedo: dataTex(s.albedo, s.size, true), normal: dataTex(s.normal, s.size, false), data: dataTex(s.data, s.size, false) });
type GpuSet = ReturnType<typeof texSet>;
export let waterNormalData: Uint8Array | null = null;

export interface Materials {
  old: THREE.MeshStandardNodeMaterial; new: THREE.MeshStandardNodeMaterial; trim: THREE.MeshStandardNodeMaterial;
  slate: THREE.MeshStandardNodeMaterial; lead: THREE.MeshStandardNodeMaterial; wood: THREE.MeshStandardNodeMaterial;
  iron: THREE.MeshStandardNodeMaterial; void: THREE.MeshStandardNodeMaterial; glass: THREE.MeshStandardNodeMaterial;
  terrain: THREE.MeshStandardNodeMaterial; macro: THREE.DataTexture;
}

export async function makeMaterials(): Promise<Materials> {
  const T = await generateTextures(['rubble', 'ashlar', 'ground', 'dressed', 'slate', 'macro', 'planks', 'water']);
  const ts = (k: string) => texSet(T[k] as unknown as TexSet);
  const S = { old: ts('rubble'), new: ts('ashlar'), trim: ts('dressed'), slate: ts('slate'), wood: ts('planks') };
  const macro = dataTex(T.macro.data as Uint8Array, 512, false);
  waterNormalData = T.water.data as Uint8Array;

  const stone = (set: GpuSet, o: { tint: THREE.Color; lichen: number; streak: number; normal: number; patch: number }) => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
    const t = uv();
    const alb = texture(set.albedo, t), dat = texture(set.data, t);
    const p = positionWorld, n = normalWorld;
    const wallUV = vec2(p.x.add(p.z).mul(1 / 41), p.y.mul(1 / 29));
    const mac = texture(macro, wallUV);
    const id = dat.b, isMortar = dat.a, stoneMask = float(1).sub(isMortar);

    // per-stone shade and repair patches (lighter, cleaner stones in blotchy regions)
    const shade = float(0.93).add(fract(id.mul(13.37).add(mac.r.mul(2.0))).mul(0.12));
    const patch = smoothstep(0.62, 0.7, mac.g).mul(o.patch).mul(stoneMask);
    let col = alb.rgb.mul(color(o.tint)).mul(mix(float(1), shade, stoneMask));
    col = mix(col, col.mul(vec3(1.1, 1.08, 1.05)), patch);

    // rain streaks: noise stretched vertically
    const streakN = texture(macro, vec2(p.x.add(p.z).mul(0.27), p.y.mul(0.011))).a;
    const streak = smoothstep(0.5, 0.78, streakN).mul(o.streak);
    col = col.mul(float(1).sub(streak.mul(0.45)));
    // broad soot/weather staining: darker blotches at building scale, heavier toward the top edges
    const grime = smoothstep(0.35, 0.75, texture(macro, vec2(p.x.add(p.z).mul(1 / 97), p.y.mul(1 / 61))).r);
    col = col.mul(float(1).sub(grime.mul(0.3)));

    // damp, green-tinged base and dark algae at the moat waterline
    const base = float(1).sub(smoothstep(GROUND - 0.4, GROUND + 3.2, p.y)).mul(0.55).add(mac.b.mul(0.35).mul(float(1).sub(smoothstep(GROUND, GROUND + 9, p.y))));
    col = mix(col, col.mul(vec3(0.55, 0.6, 0.48)), clamp(base, 0, 1));
    const algae = float(1).sub(smoothstep(-0.2, 1.1, p.y));
    col = mix(col, vec3(0.05, 0.06, 0.035), algae.mul(0.8));

    // lichen on north and upward faces, only on stone, in blotches
    const north = smoothstep(0.1, 0.9, n.z.negate()), up = smoothstep(0.3, 0.9, n.y);
    const lichenN = texture(macro, vec2(p.x.add(p.z.mul(0.7)).mul(0.19), p.y.mul(0.21).add(p.x.mul(0.05)))).b;
    const lichen = smoothstep(0.55, 0.68, lichenN.add(north.mul(0.12)).add(up.mul(0.15))).mul(stoneMask).mul(o.lichen);
    col = mix(col, mix(vec3(0.3, 0.31, 0.22), vec3(0.36, 0.35, 0.25), mac.a), lichen.mul(0.5));

    m.colorNode = col;
    m.roughnessNode = mix(float(0.86), float(0.97), isMortar).sub(algae.mul(0.4)).sub(base.mul(0.1));
    m.normalNode = normalMap(texture(set.normal, t), vec2(o.normal, o.normal));
    m.aoNode = mix(float(1), dat.g, 0.85);
    return m;
  };

  const old = stone(S.old, { tint: new THREE.Color(0.9, 0.87, 0.82), lichen: 0.55, streak: 1, normal: 1.3, patch: 0.4 });
  const nw = stone(S.new, { tint: new THREE.Color(0.95, 0.92, 0.87), lichen: 0.35, streak: 0.9, normal: 1.1, patch: 0.3 });
  const trim = stone(S.trim, { tint: new THREE.Color(0.98, 0.95, 0.89), lichen: 0.5, streak: 0.7, normal: 0.9, patch: 0.2 });

  const slateM = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
  {
    const t = uv(), dat = texture(S.slate.data, t);
    const mac = texture(macro, positionWorld.xz.mul(1 / 23));
    slateM.colorNode = texture(S.slate.albedo, t).rgb.mul(mac.r.mul(0.35).add(0.82));
    slateM.roughnessNode = float(0.5).add(dat.a.mul(0.4)).add(mac.g.mul(0.15));
    slateM.normalNode = normalMap(texture(S.slate.normal, t), vec2(1.2, 1.2));
    slateM.aoNode = dat.g;
  }
  const lead = new THREE.MeshStandardNodeMaterial({ color: 0x2b2e31, roughness: 0.55, metalness: 0.2 });
  const wood = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
  wood.colorNode = texture(S.wood.albedo, uv()).rgb;
  wood.normalNode = normalMap(texture(S.wood.normal, uv()));
  const iron = new THREE.MeshStandardNodeMaterial({ color: 0x1a1a1b, roughness: 0.55, metalness: 0.7 });
  const voidM = new THREE.MeshStandardNodeMaterial({ color: 0x050505, roughness: 1 });

  // Leaded glass: diamond quarries, slightly uneven panes that catch the sky
  const glass = new THREE.MeshStandardNodeMaterial({ roughness: 0.12, metalness: 0.0 });
  {
    const t = uv().mul(1 / 0.16);
    const d = vec2(t.x.add(t.y), t.x.sub(t.y));
    const f = fract(d);
    const line = min(min(f.x, float(1).sub(f.x)), min(f.y, float(1).sub(f.y)));
    const leadMask = float(1).sub(smoothstep(0.03, 0.07, line));
    const wobble = texture(macro, uv().mul(0.9)).a;
    glass.colorNode = mix(vec3(0.03, 0.035, 0.04).mul(wobble.add(0.6)), vec3(0.025, 0.025, 0.025), leadMask);
    glass.roughnessNode = mix(float(0.06).add(wobble.mul(0.12)), float(0.7), leadMask);
    glass.metalnessNode = mix(float(0.15), float(0.4), leadMask);
  }

  const terrain = makeTerrainMaterial(T.ground as unknown as GroundData, macro);

  return { old, new: nw, trim, slate: slateM, lead, wood, iron, void: voidM, glass, terrain, macro };
}

/** Wind sway for foliage: bend by height above the instance origin. */
export function windOffset(strength = 0.15) {
  const h = max(positionLocal.y, 0);
  const phase = float(instanceIndex).mul(1.7);
  const s = sin(time.mul(1.3).add(phase).add(positionLocal.x.mul(0.3))).mul(strength).mul(h.mul(0.05));
  return positionLocal.add(vec3(s, 0, s.mul(0.6)));
}

export { abs };
