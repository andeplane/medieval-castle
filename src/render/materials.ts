// TSL node materials (game-materials-shaders). Stone gets its look from three layers:
// 1) the generated masonry texture (courses, stones, mortar), 2) per-stone variation from the data
// texture's stone id, 3) world-space weathering: damp base, algae at the waterline, rain streaks,
// lichen on north- and up-facing stone, repair patches. Layer 3 hides tiling and is what makes
// it read as old.
import * as THREE from 'three/webgpu';
import {
  texture, uv, positionWorld, normalWorld, mix, vec2, vec3, vec4, float, int, color, smoothstep, normalMap, clamp, fract, floor, round, abs, min, max, sin, cos, time, fwidth,
  positionLocal, instanceIndex, positionView, normalViewGeometry, cameraViewMatrix, cameraNear, cameraFar, viewZToPerspectiveDepth, uniform, hash, select, Fn, Loop, Break, If,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { LITHS, LITH_DETAIL, DETAIL_TILE, RUBBLE, ASHLAR, DRESSED, type TexSet } from './texgen';
import { generateTextures } from './texpool';
import { GROUND } from '../castle/spec';
import { TILE } from '../castle/builder';

/** World-space direction towards the sun; sky.ts keeps it in step with the light. */
export const sunDirection = uniform(new THREE.Vector3(0.3, 0.6, 0.7).normalize());

/** Parallax settings: `depth` is metres from the proudest face to the back of a joint. */
interface Pom { depth: number; tile: number; hTop: number; hBot: number; steps: number }
interface StoneOpts {
  tint: THREE.Color; mortar: THREE.Color; lichen: number; streak: number; normal: number; patch: number; vary: number; cavity: number;
  crevice: number;   // contact darkening in the mortar right against each stone (the crevice between stones)
  tool: number;      // chisel tooling on the faces (0 rubble, 1 dressed)
  detail: number;    // close-up grain and pitting strength (split rubble faces are rougher than dressed ones)
  sdfRange: number;  // metres encoded either side of the outline in data.a (texgen)
  pom: Pom;
}
/** Distance (m) over which parallax fades out; beyond it the normal map and cavity shading carry the relief. */
const POM_NEAR = 18, POM_FAR = 42;
/** `?pom=0` turns parallax off (A/B captures); `?pom=2` exaggerates it to check its direction. */
const POM_GAIN = typeof location === 'undefined' ? 1 : Number(new URLSearchParams(location.search).get('pom') ?? 1);

const depthOf = (h: Node<'float'>, o: Pom) => clamp(float(o.hTop).sub(h).div(o.hTop - o.hBot), 0, 1);

/** March tuning (FPOM-style): one layer per POM_PX pixels (or texels) of the ray's length, in [min, max]. */
const POM_PX = 1.5, POM_MIN = 6, POM_MAX = 64, SHADOW_MAX = 16;

/**
 * Parallax occlusion mapping on the masonry height (data.r), with a self-shadow march towards the
 * sun and a pixel depth offset. The tangent frame comes from screen derivatives of the geometry (the
 * castle has no tangent attribute). Height samples use explicit gradients so the loop is legal in
 * non-uniform control flow (WGSL) and mip selection follows the real surface, not the shifted uv.
 * Depth is metres (o.depth) on every mesh: uvs are metres / tile, so the uv offset is depth / tile.
 * Banding: the layer count follows the length of the ray on screen (or in texels, whichever is
 * coarser), so a layer is never longer than ~1.5 px and no joint is stepped over, even at 0.3 m and
 * grazing; 5 binary refinement steps then put the hit within 1/32 of a layer.
 * Returns the shifted uv, the gradients to sample with, the sun visibility (0-1) and `ray`, how far
 * (m) the hit lies behind the polygon along the view ray, for the depth offset.
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
    const fade = float(1).sub(smoothstep(POM_NEAR, POM_FAR, positionView.length())).mul(smoothstep(0.06, 0.2, vt.z)).toVar();
    const scale = (o.depth / o.tile) * POM_GAIN;
    const h = (q: Node<'vec2'>) => depthOf(texture(set.data, q).grad(gx, gy).r, o);
    // uv spacing of one height sample at the mip the gradients pick (never finer than a texel)
    const spacing = max(max(gx.length(), gy.length()), 1 / set.size).toVar();

    const out = vec4(uv0, 0, 1).toVar();
    If(fade.greaterThan(POM_GAIN > 0 ? 0.002 : 2), () => {
      const cz = vt.z.max(0.2);
      const off = vt.xy.div(cz).mul(scale).mul(fade).toVar(); // uv shift from the face to the full depth
      const nf = off.length().div(spacing.mul(POM_PX)).clamp(POM_MIN, POM_MAX).floor().toVar();
      const layer = float(1).div(nf);
      const dUV = off.mul(layer).toVar();
      const cur = vec2(uv0).toVar(), curD = float(0).toVar(), surf = h(uv0).toVar();
      Loop({ start: int(0), end: int(nf), type: 'int', condition: '<' }, () => {
        If(curD.greaterThanEqual(surf), () => { Break(); }); // early out at the first layer below the surface
        cur.subAssign(dUV);
        curD.addAssign(layer);
        surf.assign(h(cur));
      });
      // binary refinement between the last layer above the surface and the first below it
      const hit = curD.greaterThan(0);
      const hiUV = vec2(cur).toVar(), hiD = float(curD).toVar();
      const loUV = select(hit, cur.add(dUV), cur).toVar(), loD = select(hit, curD.sub(layer), curD).max(0).toVar();
      Loop(5, () => {
        const mUV = loUV.add(hiUV).mul(0.5).toVar(), mD = loD.add(hiD).mul(0.5).toVar();
        const below = mD.greaterThanEqual(h(mUV)).toVar();
        hiUV.assign(select(below, mUV, hiUV)); hiD.assign(select(below, mD, hiD));
        loUV.assign(select(below, loUV, mUV)); loD.assign(select(below, loD, mD));
      });
      const hitUV = loUV.add(hiUV).mul(0.5).toVar();
      const hitD = loD.add(hiD).mul(0.5).max(0).toVar();
      // metres behind the polygon along the view ray (the march descends depth * fade over that length)
      out.assign(vec4(hitUV, hitD.mul(o.depth * POM_GAIN).mul(fade).div(cz), 1));

      // self-shadow: march from the hit towards the actual sun, in the same tangent frame. Blockers
      // near the start count most, so the crevices between stones get crisp contact shadows.
      const L = cameraViewMatrix.mul(vec4(sunDirection, 0)).xyz;
      const lt = vec3(L.dot(Tn), L.dot(Bn), L.dot(N)).toVar();
      If(lt.z.greaterThan(0.02).and(hitD.greaterThan(0.01)), () => {
        const lOff = lt.xy.div(lt.z.max(0.1)).mul(scale).mul(fade).toVar(); // uv per unit of depth climbed
        const ns = lOff.length().mul(hitD).div(spacing.mul(2)).clamp(4, SHADOW_MAX).floor().toVar();
        const occ = float(0).toVar();
        Loop({ start: int(0), end: int(ns), type: 'int', condition: '<' }, ({ i }) => {
          const k = float(i).add(1).div(ns.add(1));
          const rayD = hitD.mul(float(1).sub(k));
          const sd = h(hitUV.add(lOff.mul(hitD.sub(rayD))));
          occ.assign(max(occ, rayD.sub(sd).mul(float(1).sub(k.mul(0.6)))));
        });
        out.w = float(1).sub(smoothstep(0, 0.14, occ).mul(0.88).mul(fade));
      });
    });
    return out;
  })().toVar('pom');
  return { uv: res.xy, ray: res.z, shadow: res.w, gx, gy };
}
import { makeTerrainMaterial, type GroundData } from '../world/terrainMaterial';

type V2N = Node<'vec2'>;
type F = Node<'float'>;

/** Pick a per-lithology constant (texgen LITHS order) with a select chain. */
export function byLith(lith: F, values: readonly number[]): F {
  let out: F = float(values[values.length - 1]);
  for (let i = values.length - 2; i >= 0; i--) out = select(lith.lessThan(i + 0.5), float(values[i]), out);
  return out;
}

/**
 * Stone (1) vs mortar (0). Magnified, the outline comes from the signed distance in data.a with a
 * one-pixel smoothstep (fwidth), so it is crisp and smooth at any distance, never a staircase.
 * Minified (several texels per pixel), it fades to the mipmapped mortar coverage in data.g.
 */
function jointMask(dat: Node<'vec4'>, size: number, gx: V2N, gy: V2N, range: number): F {
  const sdf = dat.a.sub(0.5).mul(2 * range);
  const aa = fwidth(sdf).mul(0.75).max(range * 0.004);
  const footprint = max(gx.length(), gy.length()).mul(size);
  return mix(smoothstep(aa.negate(), aa, sdf), float(1).sub(dat.g), smoothstep(1.5, 4, footprint)).toVar('stoneMask');
}

/**
 * Three taps of the detail texture (centre, +u, +v) in a frame rotated by `ang` and shifted by `off`
 * per stone, so the 0.8 m repeat never lines up. Gradients are rotated with it, so mips are right even
 * though the coordinates jump at stone boundaries.
 */
function detailTaps(tex: THREE.Texture, t: V2N, gx: V2N, gy: V2N, tile: number, ang: F, off: V2N) {
  const k = tile / DETAIL_TILE, c = cos(ang).toVar(), s = sin(ang).toVar();
  const rot = (v: V2N) => vec2(v.x.mul(c).sub(v.y.mul(s)), v.x.mul(s).add(v.y.mul(c)));
  const q = rot(t.mul(k)).add(off).toVar(), qx = rot(gx.mul(k)).toVar(), qy = rot(gy.mul(k)).toVar();
  const e = max(max(qx.length(), qy.length()), 1 / DETAIL_SIZE).toVar();
  const tap = (o: V2N) => texture(tex, q.add(o)).grad(qx, qy);
  return { s0: tap(vec2(0, 0)), su: tap(vec2(e, 0)), sv: tap(vec2(0, e)), e, c, s };
}

/** Surface slope (m/m, tangent frame) of the detail height `dh` (metres), rotated back from the detail frame. */
function detailSlope(D: ReturnType<typeof detailTaps>, dh: (s: Node<'vec4'>) => F): V2N {
  const h0 = dh(D.s0);
  const gd = vec2(dh(D.su).sub(h0), dh(D.sv).sub(h0)).div(D.e.mul(DETAIL_TILE));
  return vec2(gd.x.mul(D.c).add(gd.y.mul(D.s)), gd.y.mul(D.c).sub(gd.x.mul(D.s)));
}

/** Base normal map (strength `k`) plus the detail slope, re-encoded for normalMap() (UDN blend). */
function blendDetailNormal(nrm: Node<'vec4'>, k: number, slope: V2N) {
  const nb = nrm.xyz.mul(2).sub(1);
  return vec3(nb.xy.mul(k).sub(slope), nb.z).normalize().mul(0.5).add(0.5);
}

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
const texSet = (s: TexSet) => ({ size: s.size, albedo: dataTex(s.albedo, s.size, true), normal: dataTex(s.normal, s.size, false), data: dataTex(s.data, s.size, false) });
/** Size of the generated close-up detail texture (texels per DETAIL_TILE metres). */
const DETAIL_SIZE = 1024;
type GpuSet = ReturnType<typeof texSet>;
export let waterNormalData: Uint8Array | null = null;

export interface Materials {
  old: THREE.MeshStandardNodeMaterial; new: THREE.MeshStandardNodeMaterial; trim: THREE.MeshStandardNodeMaterial;
  slate: THREE.MeshStandardNodeMaterial; lead: THREE.MeshStandardNodeMaterial; wood: THREE.MeshStandardNodeMaterial;
  iron: THREE.MeshStandardNodeMaterial; void: THREE.MeshStandardNodeMaterial; glass: THREE.MeshStandardNodeMaterial;
  terrain: THREE.MeshStandardNodeMaterial; macro: THREE.DataTexture;
}

export async function makeMaterials(): Promise<Materials> {
  const T = await generateTextures(['rubble', 'ashlar', 'ground', 'dressed', 'detail', 'slate', 'macro', 'planks', 'water']);
  const ts = (k: string) => texSet(T[k] as unknown as TexSet);
  const S = { old: ts('rubble'), new: ts('ashlar'), trim: ts('dressed'), slate: ts('slate'), wood: ts('planks') };
  const macro = dataTex(T.macro.data as Uint8Array, 512, false);
  waterNormalData = T.water.data as Uint8Array;

  const detail = dataTex(T.detail.data as Uint8Array, DETAIL_SIZE, false);

  const stone = (set: GpuSet, o: StoneOpts) => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
    const P = parallax(set, o.pom);
    const t = P.uv, g = (tx: THREE.Texture) => texture(tx, t).grad(P.gx, P.gy);
    const alb = g(set.albedo), dat = g(set.data), nrm = g(set.normal);
    const p = positionWorld, n = normalWorld, dist = positionView.length();
    const wallUV = vec2(p.x.add(p.z).mul(1 / 41), p.y.mul(1 / 29));
    const mac = texture(macro, wallUV);
    const stoneMask = jointMask(dat, set.size, P.gx, P.gy, o.sdfRange);
    // how deep this texel sits below the stone faces (0 = proud face, 1 = back of a raked joint)
    const dep = depthOf(dat.r, o.pom);
    const cavity = smoothstep(0.45, 0.95, dep);
    // the crevice where the mortar meets a stone: a narrow, deep, occluded band along every outline
    // (from the SDF, so it is crisp and never stepped), faded out where the SDF is minified
    const sdf = dat.a.sub(0.5).mul(2 * o.sdfRange);
    const crev = float(1).sub(stoneMask).mul(float(1).sub(smoothstep(0, o.sdfRange * 0.25, sdf.negate())))
      .mul(float(1).sub(smoothstep(8, 22, dist))).mul(o.crevice).toVar();

    // Per-stone variation that does not repeat with the 4 m tile: the normal map's alpha holds each
    // stone's centre along u, so every stone instance gets its own tile index and its own random.
    const id = dat.b;
    const du = fract(t.x).sub(nrm.a), tileU = floor(t.x.sub(du.sub(round(du)))), tileV = floor(t.y);
    const rnd = hash(id.mul(997).add(tileU.mul(13.17)).add(tileV.mul(71.3)));
    const rnd2 = hash(rnd.mul(311.7).add(5.1)), rnd3 = hash(rnd.mul(97.3).add(2.3)), rnd4 = hash(rnd.mul(53.1).add(7.7));
    const lith = floor(id.mul(255 / 51)).clamp(0, LITHS.length - 1);
    const value = mix(float(1 - o.vary), float(1 + o.vary * 0.6), rnd)
      .mul(select(rnd2.greaterThan(0.95), float(0.72), select(rnd2.lessThan(0.04), float(1.22), float(1))));
    const hue = mix(vec3(0.98, 1.0, 1.0), vec3(1.07, 1.0, 0.91), smoothstep(0.2, 0.9, hash(rnd.mul(71.9).add(1.7))));
    const shade = vec3(value).mul(hue).mul(float(0.94).add(mac.r.mul(0.12)));

    // close-up detail: crystals, flecks, pits and tooling, rotated and shifted per stone, faded out by ~9 m
    const kDet = float(1).sub(smoothstep(3.5, 9, dist));
    const D = detailTaps(detail, t, P.gx, P.gy, o.pom.tile, rnd3.mul(Math.PI * 2), vec2(rnd4, rnd2));
    const wGrain = mix(float(1.5), byLith(lith, LITH_DETAIL.grain).mul(rnd2.mul(0.6).add(0.7)), stoneMask);
    const pitDensity = mix(float(0.22), byLith(lith, LITH_DETAIL.pits).mul(rnd4.mul(rnd4).add(0.15)), stoneMask).clamp(0.03, 0.85);
    const wTool = stoneMask.mul(o.tool).mul(rnd2.mul(0.6).add(0.4));
    const pitOf = (s: Node<'vec4'>) => smoothstep(float(1).sub(pitDensity), float(1), s.g);
    const dh = (s: Node<'vec4'>) => s.r.sub(0.5).mul(wGrain).mul(0.0007 * o.detail).sub(pitOf(s).mul(0.0025 * o.detail)).add(s.b.sub(1).mul(wTool).mul(0.0012));
    const slope = detailSlope(D, dh).mul(kDet);

    // stone colour: the per-stone albedo from texgen, per-instance shade, then the detail layer
    // dark minerals at full contrast, pale ones softer (a uniform white salt reads as stucco)
    const fleckRaw = D.s0.a.sub(0.5).mul(2), fleck = fleckRaw.mul(select(fleckRaw.greaterThan(0), float(0.55), float(1))), grainC = D.s0.r.sub(0.5), pit0 = pitOf(D.s0);
    const fleckAmt = byLith(lith, LITH_DETAIL.fleck).mul(kDet);
    let stoneCol = alb.rgb.mul(color(o.tint)).mul(shade)
      .mul(fleck.mul(fleckAmt).add(1))
      .mul(grainC.mul(kDet.mul(0.3 * o.detail)).add(1))
      .mul(float(1).sub(pit0.mul(kDet.mul(Math.min(0.5, 0.3 * o.detail)))))
      .mul(D.s0.b.sub(1).mul(wTool).mul(kDet.mul(0.3)).add(1));
    const patch = smoothstep(0.62, 0.7, mac.g).mul(o.patch);
    stoneCol = mix(stoneCol, stoneCol.mul(vec3(1.1, 1.08, 1.05)), patch);
    // lime mortar: lighter and sandy (grain + dark grit), set back between the stones
    const grit = smoothstep(0.55, 0.75, fleck.negate()).mul(kDet);
    const mortarCol = color(o.mortar).mul(grainC.mul(kDet.mul(0.6)).add(1)).mul(float(1).sub(grit.mul(0.3))).mul(float(0.9).add(mac.a.mul(0.2)));
    let col = mix(mortarCol, stoneCol, stoneMask);
    // hollows of pillowed faces stay a little dark; joints only darken at range (up close, AO + self-shadow do it)
    col = col.mul(float(1).sub(cavity.mul(o.cavity).mul(mix(smoothstep(15, 45, dist).mul(0.5), float(1), stoneMask))));
    col = col.mul(float(1).sub(crev.mul(0.55)));

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
    const base = clamp(float(1).sub(smoothstep(GROUND - 0.4, GROUND + 3.2, p.y)).mul(0.55).add(mac.b.mul(0.35).mul(float(1).sub(smoothstep(GROUND, GROUND + 9, p.y)))), 0, 1);
    col = mix(col, col.mul(vec3(0.55, 0.6, 0.48)), base);
    const algae = float(1).sub(smoothstep(-0.2, 1.1, p.y));
    col = mix(col, vec3(0.05, 0.06, 0.035), algae.mul(0.8));

    // lichen on north and upward faces, only on stone, in blotches
    const north = smoothstep(0.1, 0.9, n.z.negate()), up = smoothstep(0.3, 0.9, n.y);
    const lichenN = texture(macro, vec2(p.x.add(p.z.mul(0.7)).mul(0.19), p.y.mul(0.21).add(p.x.mul(0.05)))).b;
    const lichen = smoothstep(0.55, 0.68, lichenN.add(north.mul(0.12)).add(up.mul(0.15))).mul(stoneMask).mul(o.lichen);
    col = mix(col, mix(vec3(0.3, 0.31, 0.22), vec3(0.36, 0.35, 0.25), mac.a), lichen.mul(0.5));
    // crustose lichen spots (1–6 cm), more where it is damp: pale grey-green, a few orange
    const spotsN = texture(detail, t.mul(o.pom.tile / DETAIL_TILE / 4).add(vec2(0.37, 0.11))).g;
    const damp = clamp(base.mul(1.4).add(north.mul(0.5)).add(up.mul(0.4)).add(lichenN.sub(0.5)), 0, 1);
    // ragged, not polka dots: the threshold is broken up by the crystal grain and fades with distance to the edge
    const spots = smoothstep(0.42, 0.62, spotsN.add(grainC.mul(0.35))).mul(stoneMask).mul(damp.mul(0.85).add(0.1)).mul(o.lichen);
    col = mix(col, select(rnd2.greaterThan(0.9), vec3(0.42, 0.3, 0.12), vec3(0.37, 0.375, 0.32)), spots.mul(0.45));

    // where the wall meets the ground, soil and moss settle into the lowest courses: a height blend that
    // fills the joints first and then creeps over the stones, so the foot merges into the bank
    const soil = smoothstep(0, 0.6, float(GROUND + 0.3).sub(p.y).div(0.45).add(dep.sub(0.55).mul(1.4)))
      .mul(smoothstep(GROUND - 0.35, GROUND - 0.1, p.y)).toVar(); // none lower down (cellar vaults crown at 1.9)
    col = mix(col, mix(vec3(0.11, 0.095, 0.07), vec3(0.075, 0.085, 0.04), mac.b).mul(grainC.mul(kDet.mul(0.5)).add(1)), soil);

    m.colorNode = col;
    const stoneRough = float(0.8).add(rnd2.mul(0.14)).sub(smoothstep(0.4, 0.8, fleck).mul(kDet.mul(0.2)));
    m.roughnessNode = mix(mix(float(0.96), stoneRough, stoneMask).sub(algae.mul(0.4)).sub(base.mul(0.18)), float(1), soil).clamp(0.3, 1);
    m.normalNode = normalMap(mix(blendDetailNormal(nrm, o.normal, slope), vec3(0.5, 0.5, 1), soil.mul(0.7)));
    m.aoNode = mix(float(1), alb.a, 0.85).mul(float(1).sub(cavity.mul(0.2))).mul(float(1).sub(crev.mul(0.7)));
    // pixel depth offset: the fragment sits where the parallax ray hit (soil fills the joints), so
    // anything crossing the wall (ground, steps, other walls) meets the stones, not the flat polygon
    const zv = positionView.z.mul(P.ray.mul(float(1).sub(soil)).div(positionView.length()).add(1));
    m.depthNode = viewZToPerspectiveDepth(zv, cameraNear, cameraFar);
    // self-shadowing from the height field darkens only the sun term
    m.receivedShadowNode = Fn(([s]: [Node<'vec4'>]) => s.mul(P.shadow)) as unknown as () => Node;
    return m;
  };

  const old = stone(S.old, { tint: new THREE.Color(0.81, 0.79, 0.76), mortar: new THREE.Color(0.31, 0.295, 0.265), lichen: 0.55, streak: 1, normal: 1.0, patch: 0.4, vary: 0.22, cavity: 0.22, crevice: 0.6, tool: 0, detail: 1.7, sdfRange: RUBBLE.sdfRange,
    pom: { depth: 0.06, tile: TILE.old, hTop: 0.95, hBot: 0.06, steps: 18 } });
  const nw = stone(S.new, { tint: new THREE.Color(0.84, 0.82, 0.79), mortar: new THREE.Color(0.36, 0.345, 0.315), lichen: 0.35, streak: 0.9, normal: 1.0, patch: 0.3, vary: 0.13, cavity: 0.2, crevice: 0.45, tool: 0.7, detail: 1, sdfRange: ASHLAR.sdfRange,
    pom: { depth: 0.05, tile: TILE.new, hTop: 0.95, hBot: 0.06, steps: 12 } });
  const trim = stone(S.trim, { tint: new THREE.Color(0.87, 0.85, 0.81), mortar: new THREE.Color(0.38, 0.365, 0.335), lichen: 0.5, streak: 0.7, normal: 1.0, patch: 0.2, vary: 0.08, cavity: 0.15, crevice: 0.3, tool: 1, detail: 0.8, sdfRange: DRESSED.sdfRange,
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

  // Leaded glass: diamond quarries, slightly uneven panes that catch the sky. The quarries are
  // see-through (the rooms behind show), the lead cames are opaque.
  const glass = new THREE.MeshStandardNodeMaterial({ roughness: 0.12, metalness: 0.0, transparent: true, depthWrite: false, side: THREE.DoubleSide });
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
    glass.opacityNode = mix(float(0.18).add(wobble.mul(0.1)), float(1), leadMask);
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
