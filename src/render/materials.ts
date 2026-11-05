// TSL node materials (game-materials-shaders). Stone gets its look from three layers:
// 1) the generated masonry texture (courses, stones, mortar), 2) per-stone variation from the data
// texture's stone id, 3) world-space weathering: damp base, algae at the waterline, rain streaks,
// lichen on north- and up-facing stone, repair patches. Layer 3 hides tiling and is what makes
// it read as old.
import * as THREE from 'three/webgpu';
import {
  texture, uv, positionWorld, normalWorld, mix, vec2, vec3, vec4, float, int, color, smoothstep, normalMap, clamp, fract, floor, round, abs, min, max, sin, time,
  positionLocal, instanceIndex, positionView, normalViewGeometry, cameraViewMatrix, uniform, hash, select, Fn, Loop, Break, If,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { TexSet } from './texgen';
import { generateTextures } from './texpool';
import { GROUND } from '../castle/spec';
import { TILE } from '../castle/builder';

/** World-space direction towards the sun; sky.ts keeps it in step with the light. */
export const sunDirection = uniform(new THREE.Vector3(0.3, 0.6, 0.7).normalize());

/** Parallax settings: `depth` is metres from the proudest face to the back of a joint. */
interface Pom { depth: number; tile: number; hTop: number; hBot: number; steps: number }
interface StoneOpts { tint: THREE.Color; lichen: number; streak: number; normal: number; patch: number; vary: number; cavity: number; pom: Pom }
/** Distance (m) over which parallax fades out; beyond it the normal map and cavity shading carry the relief. */
const POM_NEAR = 18, POM_FAR = 42;
/** `?pom=0` turns parallax off (A/B captures); `?pom=2` exaggerates it to check its direction. */
const POM_GAIN = typeof location === 'undefined' ? 1 : Number(new URLSearchParams(location.search).get('pom') ?? 1);

const depthOf = (h: Node<'float'>, o: Pom) => clamp(float(o.hTop).sub(h).div(o.hTop - o.hBot), 0, 1);

/**
 * Parallax occlusion mapping on the masonry height (data.r), with a short soft self-shadow march
 * towards the sun. The tangent frame comes from screen derivatives of the geometry (the castle has
 * no tangent attribute). Height samples use explicit gradients so the loop is legal in non-uniform
 * control flow (WGSL) and mip selection follows the real surface, not the shifted uv.
 * Returns the shifted uv, the gradients to sample with, and the self-shadow factor.
 */
function parallax(set: GpuSet, o: Pom) {
  const uv0 = uv();
  const gx = uv0.dFdx().toVar('pomGx'), gy = uv0.dFdy().toVar('pomGy');
  const res = Fn(() => {
    const q0 = positionView.dFdx(), q1 = positionView.dFdy(), N = normalViewGeometry;
    const q1p = q1.cross(N), q0p = N.cross(q0);
    const T = q1p.mul(gx.x).add(q0p.mul(gy.x)), B = q1p.mul(gx.y).add(q0p.mul(gy.y));
    const inv = max(T.dot(T), B.dot(B)).max(1e-24).inverseSqrt();
    const Tn = T.mul(inv).toVar(), Bn = B.mul(inv).toVar();
    const V = positionView.negate().normalize();
    const vt = vec3(V.dot(Tn), V.dot(Bn), V.dot(N)).toVar();
    const fade = float(1).sub(smoothstep(POM_NEAR, POM_FAR, positionView.length())).mul(smoothstep(0.08, 0.3, vt.z)).toVar();
    const scale = (o.depth / o.tile) * POM_GAIN;
    const h = (q: Node<'vec2'>) => depthOf(texture(set.data, q).grad(gx, gy).r, o);

    const out = vec4(uv0, 0, 1).toVar();
    If(fade.greaterThan(POM_GAIN > 0 ? 0.002 : 2), () => {
      const nf = mix(float(o.steps), float(Math.max(4, Math.round(o.steps * 0.35))), vt.z).mul(fade.mul(0.6).add(0.4)).max(3).floor();
      const layer = float(1).div(nf);
      const dUV = vt.xy.div(vt.z.max(0.25)).mul(scale * 1).mul(fade).mul(layer).toVar();
      const cur = vec2(uv0).toVar(), curD = float(0).toVar(), surf = h(uv0).toVar(), prev = float(0).toVar();
      Loop({ start: int(0), end: int(nf), type: 'int', condition: '<' }, () => {
        If(curD.greaterThanEqual(surf), () => { Break(); });
        prev.assign(surf);
        cur.subAssign(dUV);
        curD.addAssign(layer);
        surf.assign(h(cur));
      });
      // linear refinement between the last two layers
      const after = surf.sub(curD), before = prev.sub(curD).add(layer);
      const w = select(curD.greaterThan(0), after.div(after.sub(before).min(-1e-5)), float(0)).clamp(0, 1);
      const hitUV = mix(cur, cur.add(dUV), w).toVar();
      const hitD = mix(curD, curD.sub(layer), w).max(0).toVar();
      out.assign(vec4(hitUV, hitD, 1));

      // soft self-shadow towards the sun, in the same tangent frame
      const L = cameraViewMatrix.mul(vec4(sunDirection, 0)).xyz;
      const lt = vec3(L.dot(Tn), L.dot(Bn), L.dot(N)).toVar();
      If(lt.z.greaterThan(0.03).and(hitD.greaterThan(0.02)), () => {
        const lOff = lt.xy.div(lt.z.max(0.12)).mul(scale).mul(fade).toVar();
        const occ = float(0).toVar();
        Loop(5, ({ i }) => {
          const k = float(i).add(1).div(6);
          const rayD = hitD.mul(float(1).sub(k));
          const sd = h(hitUV.add(lOff.mul(hitD.sub(rayD))));
          occ.assign(max(occ, rayD.sub(sd).mul(float(1).sub(k.mul(0.5)))));
        });
        out.w = float(1).sub(occ.mul(6).mul(fade).clamp(0, 0.75));
      });
    });
    return out;
  })().toVar('pom');
  return { uv: res.xy, depth: res.z, shadow: res.w, gx, gy };
}
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

  const stone = (set: GpuSet, o: StoneOpts) => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
    const P = parallax(set, o.pom);
    const t = P.uv, g = (tx: THREE.Texture) => texture(tx, t).grad(P.gx, P.gy);
    const alb = g(set.albedo), dat = g(set.data), nrm = g(set.normal);
    const p = positionWorld, n = normalWorld;
    const wallUV = vec2(p.x.add(p.z).mul(1 / 41), p.y.mul(1 / 29));
    const mac = texture(macro, wallUV);
    const id = dat.b, isMortar = dat.a, stoneMask = float(1).sub(isMortar);
    // how deep this texel sits below the stone faces (0 = proud face, 1 = back of a raked joint)
    const dep = depthOf(dat.r, o.pom);
    const cavity = smoothstep(0.45, 0.95, dep);

    // Per-stone variation that does not repeat with the 4 m tile: the normal map's alpha holds each
    // stone's centre along u, so every stone instance gets its own tile index and its own random.
    const du = fract(t.x).sub(nrm.a), tileU = floor(t.x.sub(du.sub(round(du)))), tileV = floor(t.y);
    const rnd = hash(id.mul(997).add(tileU.mul(13.17)).add(tileV.mul(71.3)));
    const rnd2 = hash(rnd.mul(311.7).add(5.1));
    const value = mix(float(1 - o.vary), float(1 + o.vary * 0.6), rnd)
      .mul(select(rnd2.greaterThan(0.95), float(0.72), select(rnd2.lessThan(0.04), float(1.22), float(1))));
    const hue = mix(vec3(0.97, 1.0, 1.01), vec3(1.05, 1.0, 0.92), smoothstep(0.2, 0.9, hash(rnd.mul(71.9).add(1.7))));
    const shade = vec3(value).mul(hue).mul(float(0.94).add(mac.r.mul(0.12)));
    const patch = smoothstep(0.62, 0.7, mac.g).mul(o.patch).mul(stoneMask);
    let col = alb.rgb.mul(color(o.tint)).mul(mix(vec3(1), shade, stoneMask));
    col = mix(col, col.mul(vec3(1.1, 1.08, 1.05)), patch);
    // deep joints and the hollows of pillowed faces stay dark even in sun
    col = col.mul(float(1).sub(cavity.mul(o.cavity)));

    // rain streaks: broad vertical washes (not fine scratches), a little darker
    const streakN = texture(macro, vec2(p.x.add(p.z).mul(0.11), p.y.mul(0.013))).b;
    const streak = smoothstep(0.58, 0.8, streakN).mul(o.streak);
    col = col.mul(float(1).sub(streak.mul(0.22)));
    // broad soot/weather staining: darker blotches at building scale
    const grime = smoothstep(0.35, 0.75, texture(macro, vec2(p.x.add(p.z).mul(1 / 97), p.y.mul(1 / 61))).r);
    col = col.mul(float(1).sub(grime.mul(0.32)));
    // mid-scale tonal drift (5–15 m): walls never read as one evenly printed sheet at 10–60 m
    const drift = texture(macro, vec2(p.x.add(p.z).mul(1 / 13), p.y.mul(1 / 9.5))).g;
    col = col.mul(float(0.86).add(drift.mul(0.26)));

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
    m.normalNode = normalMap(nrm, vec2(o.normal, o.normal));
    m.aoNode = mix(float(1), dat.g, 0.7).mul(float(1).sub(cavity.mul(0.25)));
    // self-shadowing from the height field darkens only the sun term
    m.receivedShadowNode = Fn(([s]: [Node<'vec4'>]) => s.mul(P.shadow)) as unknown as () => Node;
    return m;
  };

  const old = stone(S.old, { tint: new THREE.Color(0.9, 0.87, 0.82), lichen: 0.55, streak: 1, normal: 1.15, patch: 0.4, vary: 0.17, cavity: 0.28,
    pom: { depth: 0.075, tile: TILE.old, hTop: 0.95, hBot: 0.06, steps: 18 } });
  const nw = stone(S.new, { tint: new THREE.Color(0.95, 0.92, 0.87), lichen: 0.35, streak: 0.9, normal: 1.1, patch: 0.3, vary: 0.11, cavity: 0.25,
    pom: { depth: 0.05, tile: TILE.new, hTop: 0.95, hBot: 0.06, steps: 12 } });
  const trim = stone(S.trim, { tint: new THREE.Color(0.98, 0.95, 0.89), lichen: 0.5, streak: 0.7, normal: 0.9, patch: 0.2, vary: 0.08, cavity: 0.2,
    pom: { depth: 0.025, tile: TILE.trim, hTop: 0.95, hBot: 0.06, steps: 10 } });

  const slateM = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
  {
    const t = uv(), dat = texture(S.slate.data, t);
    const mac = texture(macro, positionWorld.xz.mul(1 / 23));
    slateM.colorNode = texture(S.slate.albedo, t).rgb.mul(mac.r.mul(0.35).add(0.82));
    slateM.roughnessNode = float(0.5).add(dat.a.mul(0.4)).add(mac.g.mul(0.15));
    slateM.normalNode = normalMap(texture(S.slate.normal, t), vec2(1.2, 1.2));
    slateM.aoNode = dat.g;
  }
  // weathered lead goes a pale, matte grey (a dark shiny lead roof mirrors the blue sky)
  const lead = new THREE.MeshStandardNodeMaterial({ color: 0x55585a, roughness: 0.72, metalness: 0.05 });
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
