// Terrain, rock and stream materials (game-materials-shaders). The terrain blends four albedo layers by
// a per-vertex mask (grass, dirt, rock, mud) and a second mask (farmland, moor, scree, wet). On top:
// the field patchwork from a baked field map (crop colours, mowing stripes and furrows, hedge bases,
// lanes), per-pixel mountain normals/erosion from the relief texture (gullies, rock faces, scree, snow)
// and aerial perspective, so distant hills fade into the haze instead of reading as one flat green.
import * as THREE from 'three/webgpu';
import {
  texture, uv, positionWorld, normalWorld, mix, vec2, vec3, float, smoothstep, normalMap, clamp, attribute, floor, abs, sin, cameraPosition,
  transformNormalToView, normalize, max, exp, hash, instanceIndex, step, select, dot, sqrt, uniform, pow,
} from 'three/tsl';
import { bakeFieldMap, FIELD_EXTENT, type FieldLayout } from './fields';
import { RELIEF_TEX, defaultTerrain } from './terrain';

export interface GroundData { size: number; grass: Uint8Array; dirt: Uint8Array; rock: Uint8Array; mud: Uint8Array; normal: Uint8Array }

function dataTex(data: Uint8Array, N: number, srgb: boolean, repeat = true) {
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Haze colour for aerial perspective; close to the fog colour at the default time of day. */
export const hazeColor = uniform(new THREE.Color(0.56, 0.63, 0.73));

/** Terrain material (+ rock and stream materials in userData). `fields` is the layout to draw; FM the field-map size. */
export function makeTerrainMaterial(G: GroundData, macro: THREE.Texture, fields: FieldLayout = defaultTerrain().fields, FM = 2048) {
  const t0 = performance.now();
  const gl = { grass: dataTex(G.grass, G.size, true), dirt: dataTex(G.dirt, G.size, true), rock: dataTex(G.rock, G.size, true), mud: dataTex(G.mud, G.size, true), normal: dataTex(G.normal, G.size, false) };
  const fieldTex = dataTex(bakeFieldMap(fields, FM), FM, false, false);
  fieldTex.anisotropy = 4;
  const tField = performance.now();
  // filled by buildTerrain() once the mountain erosion has finished
  const reliefTex = dataTex(new Uint8Array(RELIEF_TEX.size * RELIEF_TEX.size * 4).fill(128), RELIEF_TEX.size, false, false);
  const timings = { fieldMapMs: Math.round(tField - t0) };

  const terrain = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const p = positionWorld;
  const w = attribute('mask', 'vec4'), w2 = attribute('mask2', 'vec4');
  const dist = p.sub(cameraPosition).length();
  const uvA = uv(), uvB = vec2(p.x.mul(0.8).sub(p.z.mul(0.6)), p.x.mul(0.6).add(p.z.mul(0.8))).mul(1 / 13.1);
  const uvC = vec2(p.x.mul(0.6).add(p.z.mul(0.8)), p.z.mul(0.6).sub(p.x.mul(0.8))).mul(1 / 57);
  // two scales up close, a third much larger one far away so the 4 m tile never shows
  const farT = smoothstep(60, 400, dist);
  const layer = (tx: THREE.Texture) => mix(mix(texture(tx, uvA).rgb, texture(tx, uvB).rgb, 0.4), texture(tx, uvC).rgb, farT.mul(0.6));
  const mac = texture(macro, p.xz.mul(1 / 180));
  const mac2 = texture(macro, p.xz.mul(1 / 1400));
  const macS = texture(macro, p.xz.mul(1 / 23));

  // relief: per-pixel normal and erosion for the far terrain and the mountains
  const ruv = p.xz.sub(vec2(RELIEF_TEX.x0, RELIEF_TEX.z0)).div(RELIEF_TEX.extent);
  const inGrid = step(0.002, ruv.x).mul(step(ruv.x, 0.998)).mul(step(0.002, ruv.y)).mul(step(ruv.y, 0.998));
  const rel = texture(reliefTex, ruv);
  const rnx = rel.r.mul(2).sub(1), rnz = rel.g.mul(2).sub(1);
  const reliefN = normalize(vec3(rnx, sqrt(max(float(1).sub(rnx.mul(rnx)).sub(rnz.mul(rnz)), 0.0)), rnz));
  const farN = smoothstep(500, 1400, dist).mul(inGrid);
  const nW = normalize(mix(normalWorld, reliefN, farN));
  // the relief normals are exaggerated ×2.2 for shading; masks use the true slope
  const rg = vec2(rnx, rnz).length().div(max(reliefN.y, 0.05)).div(2.2);
  const slopeFar = float(1).sub(float(1).div(sqrt(rg.mul(rg).add(1))));
  const slope = mix(float(1).sub(normalWorld.y), slopeFar, farN);
  const ero = rel.b.sub(0.5).mul(80).mul(inGrid); // metres, + deposited, − cut
  const hgt = p.y;

  const grassT = layer(gl.grass), dirtT = layer(gl.dirt), rockT = layer(gl.rock), mudT = layer(gl.mud);
  let grassC = grassT;

  // ── fields ──
  const fuv = p.xz.add(FIELD_EXTENT).div(2 * FIELD_EXTENT);
  const fm = texture(fieldTex, fuv);
  const crop = floor(fm.r.mul(8));
  const hedgeD = fm.g.mul(16), laneD = fm.b.mul(16), frand = fm.a;
  const farm = clamp(w2.x, 0, 1), commons = clamp(w2.x.negate(), 0, 1);
  const is = (k: number) => float(1).sub(step(0.5, abs(crop.sub(k))));
  // stripes along or across the regional grain
  const ang = fields.angle;
  const ga = vec2(Math.cos(ang), Math.sin(ang)), gb = vec2(-Math.sin(ang), Math.cos(ang));
  const along = select(frand.greaterThan(0.5), dot(p.xz, ga), dot(p.xz, gb));
  const stripeFade = float(1).sub(smoothstep(250, 900, dist));
  const mow = sin(along.mul(Math.PI / 5.5)).mul(0.07).mul(stripeFade);
  const furrow = sin(along.mul(Math.PI / 0.75)).mul(0.5).add(0.5).mul(float(1).sub(smoothstep(40, 220, dist)));
  const lum = dot(dirtT, vec3(0.3, 0.55, 0.15));
  const fieldBright = frand.mul(0.22).add(0.88);
  const cPasture = grassT.mul(vec3(0.92, 1.16, 0.85));
  const cRough = mix(grassT.mul(vec3(1.3, 1.08, 0.66)), grassT.mul(vec3(0.6, 0.66, 0.42)), smoothstep(0.55, 0.68, macS.a));
  const cHay = grassT.mul(vec3(1.7, 1.45, 0.8)).mul(float(1).add(mow));
  const cStubble = mix(vec3(0.27, 0.2, 0.075).mul(lum.mul(4).add(0.45)), grassT, 0.12).mul(float(1).add(mow.mul(0.8)));
  const cPlough = dirtT.mul(vec3(0.78, 0.66, 0.56)).mul(furrow.mul(0.35).add(0.7));
  const cGrazed = grassT.mul(vec3(1.25, 1.25, 0.9));
  let fieldC = cPasture.mul(is(0)).add(cRough.mul(is(1))).add(cHay.mul(is(2))).add(cStubble.mul(is(3))).add(cPlough.mul(is(4))).add(cGrazed.mul(is(5)));
  fieldC = fieldC.mul(fieldBright);
  // hedge base (dark, shaded, nettles and bramble) and the uncut verge beside it
  const hedgeBase = float(1).sub(smoothstep(1.2, 2.5, hedgeD.add(macS.g.sub(0.5).mul(1.4))));
  const verge = float(1).sub(smoothstep(3.0, 6.0, hedgeD)).sub(hedgeBase);
  fieldC = mix(fieldC, grassT.mul(vec3(1.1, 1.02, 0.72)), verge.mul(0.75));
  fieldC = mix(fieldC, vec3(0.026, 0.05, 0.014).mul(macS.r.mul(0.8).add(0.6)), hedgeBase);
  // lanes: two wheel ruts with a grass strip in the middle
  const lane = float(1).sub(smoothstep(1.3, 1.9, laneD));
  const crown = float(1).sub(smoothstep(0.25, 0.45, laneD));
  const laneC = mix(dirtT.mul(vec3(1.05, 1.0, 0.92)), grassT, crown.mul(0.8));
  fieldC = mix(fieldC, laneC, lane);
  grassC = mix(grassC, fieldC, farm);
  // common grazing round the moat: rough, tussocky, rushes in the wet hollows
  grassC = mix(grassC, cRough, commons);

  // ── uplands: moor grass, bracken and heather; rock faces, scree and snow from the relief ──
  const moorN = mac.g.mul(0.6).add(mac2.r.mul(0.6)).add(macS.b.mul(0.3));
  const bracken = vec3(0.27, 0.11, 0.035), moorGrass = vec3(0.17, 0.15, 0.055), heather = vec3(0.11, 0.065, 0.07);
  const moorC = mix(mix(moorGrass, bracken, smoothstep(0.45, 0.72, moorN)), heather, smoothstep(0.62, 0.8, mac.b.add(mac2.a.mul(0.3)))).mul(lum.mul(2.2).add(0.55));
  const moorW = max(w2.y, smoothstep(120, 300, hgt.add(mac2.g.sub(0.5).mul(160))).mul(farN));
  grassC = mix(grassC, moorC, moorW);
  const rockFar = smoothstep(0.24, 0.42, slope.add(ero.mul(-0.006))).mul(smoothstep(80, 250, hgt)).mul(farN);
  const screeW = max(w2.z, smoothstep(5, 18, ero).mul(smoothstep(0.14, 0.26, slope)).mul(smoothstep(250, 400, hgt)).mul(farN));
  const rockW = clamp(max(w.z, rockFar), 0, 1);

  const rockC = rockT.mul(vec3(0.72, 0.7, 0.68)).mul(macS.r.mul(0.4).add(0.7));
  const nearCol = grassC.mul(w.x).add(dirtT.mul(w.y)).add(rockT.mul(w.z)).add(mudT.mul(w.w));
  const farCol = mix(grassC.mul(w.x.add(w.z)).add(dirtT.mul(w.y)).add(mudT.mul(w.w)), rockC, rockW);
  let col = mix(nearCol, farCol, farN);
  col = mix(col, vec3(0.15, 0.14, 0.125).mul(lum.mul(2.5).add(0.5)), screeW.mul(0.8));
  // gullies hold shade, damp and darker vegetation; spurs between them are lighter
  col = col.mul(float(1).sub(smoothstep(2, 25, ero.negate()).mul(0.35)));
  // meadow colour drift (dry/green) at two scales so distant hills are not one flat green
  const dry = smoothstep(0.45, 0.75, mac.r.mul(0.6).add(mac2.g.mul(0.6)));
  col = mix(col, col.mul(vec3(1.22, 1.08, 0.74)), dry.mul(w.x).mul(float(1).sub(farm)).mul(0.6));
  col = col.mul(mac.b.mul(0.3).add(0.85)).mul(macS.r.mul(0.22).add(0.89));
  // close up: tussocks and thin patches mottle the turf
  const mot = texture(macro, p.xz.mul(1 / 6.3)).g;
  col = col.mul(mix(float(1), mot.mul(0.42).add(0.79), w.x.mul(float(1).sub(farT))));
  // stream bed: dark, wet stones
  col = mix(col, mix(mudT.mul(0.8), dirtT.mul(vec3(0.75, 0.72, 0.68)), 0.5), w2.w);
  // banks at the water: a bare earth face where the ground is steep and low, dark wet mud at the waterline
  const lowBank = float(1).sub(smoothstep(1.2, 1.9, hgt.add(macS.g.sub(0.5).mul(0.6)))).mul(float(1).sub(farT));
  const earth = lowBank.mul(smoothstep(0.16, 0.36, slope.add(macS.b.sub(0.5).mul(0.15))));
  const earthC = mix(dirtT.mul(vec3(0.85, 0.7, 0.55)), dirtT.mul(vec3(0.5, 0.42, 0.34)), float(1).sub(smoothstep(0.1, 0.9, hgt)));
  col = mix(col, earthC, earth.mul(0.92));
  const wetline = float(1).sub(smoothstep(0.02, 0.32, hgt)).mul(lowBank);
  col = mix(col, mudT.mul(0.55), wetline.mul(0.85));
  // snow on the highest ground, lying in gullies and on flatter slopes
  const snow = smoothstep(1000, 1100, hgt.add(mac.a.mul(140)).add(ero.mul(2))).mul(smoothstep(0.45, 0.75, nW.y.add(0.15)));
  col = mix(col, vec3(0.8, 0.82, 0.86), snow);

  // aerial perspective: extinction on the surface colour, in-scattered haze added as emission
  const haze = float(1).sub(exp(dist.div(-11000))).mul(0.7).mul(float(1).sub(smoothstep(300, 1600, hgt).mul(0.25)));
  terrain.colorNode = col.mul(float(1).sub(haze));
  terrain.emissiveNode = hazeColor.mul(haze).mul(0.75);
  terrain.roughnessNode = mix(float(0.97), float(0.55), max(w.w, wetline).mul(0.6)).sub(snow.mul(0.3)).sub(w2.w.mul(0.35));
  const detailN = normalMap(texture(gl.normal, uvA), vec2(0.6, 0.6).mul(float(1).sub(farT)));
  terrain.normalNode = normalize(mix(detailN, transformNormalToView(reliefN), farN));

  // ── boulders: triplanar rock with moss on top and a dark wet band at the waterline ──
  const rock = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });
  {
    const n = normalWorld, aw = abs(n), wsum = aw.x.add(aw.y).add(aw.z);
    const tri = (tx: THREE.Texture, k: number) => texture(tx, p.zy.mul(k)).rgb.mul(aw.x).add(texture(tx, p.xz.mul(k)).rgb.mul(aw.y)).add(texture(tx, p.xy.mul(k)).rgb.mul(aw.z)).div(wsum);
    const v = hash(instanceIndex);
    const base = tri(gl.rock, 0.45).mul(vec3(0.9, 0.85, 0.78)).mul(v.mul(0.25).add(0.45));
    const moss = smoothstep(0.45, 0.85, n.y.add(macS.g.sub(0.5).mul(0.8))).mul(smoothstep(0.35, 1.2, p.y));
    let rc = mix(base, tri(gl.grass, 0.6).mul(vec3(0.8, 0.9, 0.55)), moss.mul(0.75));
    const lichen = smoothstep(0.62, 0.72, macS.b.add(n.y.mul(0.1))).mul(float(1).sub(moss));
    rc = mix(rc, vec3(0.32, 0.33, 0.25), lichen.mul(0.4));
    const wetBand = float(1).sub(smoothstep(0.05, 0.55, p.y));
    rc = mix(rc, rc.mul(vec3(0.42, 0.45, 0.38)), wetBand);
    rc = mix(rc, vec3(0.04, 0.05, 0.03), float(1).sub(smoothstep(-0.25, 0.15, p.y)).mul(0.8));
    rock.colorNode = rc;
    rock.roughnessNode = float(0.9).sub(wetBand.mul(0.45));
    rock.normalNode = normalMap(texture(gl.normal, p.xz.mul(0.45)), vec2(0.8, 0.8));
  }

  // ── stream water: dark and still, reflecting the sky through the environment map ──
  const stream = new THREE.MeshStandardNodeMaterial({ roughness: 0.06, metalness: 0 });
  {
    // no planar reflector for a 4 m stream: tint toward the sky by Fresnel, dark peaty water underneath
    const v = normalize(cameraPosition.sub(positionWorld));
    const fres = pow(float(1).sub(max(v.y, 0)), 4);
    stream.colorNode = vec3(0.015, 0.02, 0.016);
    stream.emissiveNode = mix(vec3(0.02, 0.03, 0.03), vec3(0.42, 0.5, 0.62), fres.mul(0.85).add(0.1));
    stream.envMapIntensity = 1.2;
  }
  stream.polygonOffset = true; stream.polygonOffsetFactor = -2; stream.polygonOffsetUnits = -2;

  terrain.userData = { rock, stream, reliefTex, timings };
  return terrain;
}
