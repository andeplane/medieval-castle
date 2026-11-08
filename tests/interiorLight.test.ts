import { describe, expect, test } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  MAX_AP, bakeInteriorLight, syncFires, setCarried, buildShadowSkins, bvhOccluder, collectTriangles, createInteriorLight, makeInteriorMaterials, sunStateOf, tagGroups,
  type InteriorKey, type SunOccluder,
} from '../src/render/interiorLight';
import { buildRoomTest } from '../src/debug/roomtest';
import { FireTable, toFire, FIRE_W, MAX_FIRES } from '../src/light/roomLight';
import { gridRoom } from '../src/render/interiorMath';
import type { Materials } from '../src/render/materials';
import type { InteriorGroup, InteriorPlan, RoomSpec } from '../src/castle/interior/types';
import type { V2 } from '../src/core/math2d';

const mats = () => Object.fromEntries(['old', 'new', 'trim', 'wood', 'iron', 'glass', 'slate', 'lead', 'void', 'terrain'].map((k) => {
  const m = new THREE.MeshStandardNodeMaterial(); m.name = k; return [k, m];
})) as unknown as Materials & Record<InteriorKey, THREE.MeshStandardNodeMaterial>;
const sq = (x0: number, z0: number, x1: number, z1: number): V2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const hall: RoomSpec = { id: 'H', zone: 'T', floor: 0, kind: 'hall', poly: sq(0, 0, 12, 8), y0: 0, y1: 6 };
const cellar: RoomSpec = { id: 'tunnel-1', zone: 'tunnel', floor: -1, kind: 'undercroft', poly: sq(0, 0, 12, 8), y0: -5, y1: -1 };
const sun = () => ({ dir: [-0.4, 0.63, 0.66] as [number, number, number], irradiance: [3.2, 3.1, 2.9] as [number, number, number] });
const never: SunOccluder = { blocked: () => false };

function floorGroup(): InteriorGroup {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([1, 0, 1, 1, 0, 2, 2, 0, 1, 2, 0, 2], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  const obj = new THREE.Group(); obj.add(new THREE.Mesh(g, new THREE.MeshBasicNodeMaterial()));
  obj.add(new THREE.Object3D());
  return { key: 'T:0', zone: 'T', floor: 0, object: obj, bounds: new THREE.Box3().setFromObject(obj), rooms: ['H', 'nope'] };
}

describe('interior materials', () => {
  test('clones lit by the sun only, with the interior irradiance and their rooms\' fires', () => {
    const light = createInteriorLight(16);
    expect(light.table.image.width).toBe(1 + MAX_AP * 5);
    expect(light.table.image.height).toBe(16);
    expect(light.fires.image.width).toBe(FIRE_W);
    expect(light.flick.image.width).toBe(MAX_FIRES);
    expect(light.grid.model.size).toEqual([1, 1, 1]); // no rooms given: an empty grid
    const sunL = new THREE.DirectionalLight();
    const IM = makeInteriorMaterials(mats(), sunL, light);
    expect(Object.keys(IM).sort()).toEqual(['glass', 'iron', 'new', 'old', 'trim', 'wood']);
    expect(IM.old.name).toBe('interior-old');
    expect(IM.glass.side).toBe(THREE.DoubleSide);
    expect(IM.glass.emissiveNode).toBeTruthy();
    // daylight + firelight go into the lighting context: irradiance, and a rough reflection for metals
    const env = (IM.wood as unknown as { setupEnvironment: () => THREE.LightingNode }).setupEnvironment();
    expect(env.isLightingNode).toBe(true);
    const added: string[] = [];
    const slot = (k: string) => ({ addAssign: () => { added.push(k); } });
    expect(env.setup({ context: { irradiance: slot('irradiance'), radiance: slot('radiance'), iblIrradiance: slot('iblIrradiance') } } as unknown as THREE.NodeBuilder)).toBe(null);
    expect(added).toEqual(['irradiance', 'radiance', 'iblIrradiance']);
    const ln = IM.old.lightsNode as unknown as { getLights(): THREE.Light[] };
    expect(ln.getLights()).toEqual([sunL]); // no point lights indoors
    // underground: no sun
    const UM = makeInteriorMaterials(mats(), null, light);
    expect(UM.old.name).toBe('interior-under-old');
    expect((UM.old.lightsNode as unknown as { getLights(): THREE.Light[] }).getLights()).toEqual([]);
    // furniture materials join a set: same lights node, same clone per source
    const wood = new THREE.MeshStandardNodeMaterial(), plain = new THREE.MeshStandardNodeMaterial();
    wood.name = 'prop-wood';
    const a = UM.adopt(wood);
    expect(a).not.toBe(wood);
    expect(a.name).toBe('interior-under-prop-wood');
    expect(UM.adopt(wood)).toBe(a);
    expect(UM.adopt(plain).name).toBe('interior-under-prop');
    expect(a.lightsNode).toBe(UM.old.lightsNode);
  });
  test('the fire table reaches the textures: rows when they change, the flicker every frame', () => {
    const light = createInteriorLight(4), T = new FireTable(4), seen = { version: -1 };
    T.set(1, [toFire({ kind: 'torch', position: [1, 2, 3], colour: [1, 1, 1], intensity: 3, flicker: 0.2 })]);
    const v0 = light.fires.version, f0 = light.flick.version;
    syncFires(light, T, seen);
    expect((light.fires.image.data as Float32Array)[FIRE_W * 4]).toBe(1);
    expect(light.fires.version).toBeGreaterThan(v0);
    const v1 = light.fires.version;
    T.update(1.5);
    syncFires(light, T, seen);
    expect(light.fires.version).toBe(v1); // rows unchanged: no upload
    expect(light.flick.version).toBeGreaterThan(f0 + 1);
    expect((light.flick.image.data as Float32Array)[MAX_FIRES]).toBeCloseTo(T.flick[MAX_FIRES]);
  });
  test('the carried light: where it is, colour × candela × flicker, soft², range; out is black', () => {
    const light = createInteriorLight(2), f = toFire({ kind: 'lantern', position: [1, 2, 3], colour: [1, 1, 1], intensity: 0.45, flicker: 0.2 });
    expect(light.carried.light.value.toArray().slice(0, 3)).toEqual([0, 0, 0]); // out until set
    setCarried(light, f, 0.5);
    expect(light.carried.pos.value.toArray()).toEqual([1, 2, 3]);
    expect(light.carried.light.value.x).toBeCloseTo(f.colour[0] * f.candela * 0.5);
    expect(light.carried.light.value.w).toBeCloseTo(f.soft ** 2);
    expect(light.carried.range.value).toBe(f.range);
    setCarried(light, f);
    expect(light.carried.light.value.z).toBeCloseTo(f.colour[2] * f.candela);
    setCarried(light, null);
    expect(light.carried.light.value.toArray().slice(0, 3)).toEqual([0, 0, 0]);
  });
  test('the bake fills the room grid of the plan it was sized for', () => {
    const room = { id: 'H', zone: 'T', floor: 0, kind: 'hall' as const, poly: [[0, 0], [6, 0], [6, 4], [0, 4]] as [number, number][], y0: 0, y1: 4 };
    const light = createInteriorLight(4, [room]);
    expect(light.grid.model.size[0]).toBeGreaterThan(10);
    bakeInteriorLight([], never, { plan: { rooms: [room], doors: [], stairs: [] }, windows: [], sun, light });
    expect(gridRoom(light.grid.model, [3, 1, 2])).toBe(0);
    expect(light.grid.texture.version).toBeGreaterThan(0);
  });
  test('sunStateOf reads direction and irradiance', () => {
    const l = new THREE.DirectionalLight(0xffffff, 2); l.position.set(0, 10, 0);
    const s = sunStateOf(l)();
    expect(s.dir[1]).toBeCloseTo(1);
    expect(s.irradiance).toEqual([2, 2, 2]);
  });
});

describe('geometry queries', () => {
  test('collectTriangles skips glass, voids, skins and transparent meshes; handles index buffers', () => {
    const root = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicNodeMaterial());
    box.position.set(0, 5, 0);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicNodeMaterial()); glass.name = 'castle-glass';
    const clear = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicNodeMaterial({ transparent: true }));
    root.add(box, glass, clear, new THREE.Object3D());
    const tris = collectTriangles([root]);
    expect(tris.length).toBe(12 * 9);
    expect(Math.min(...Array.from(tris).filter((_, i) => i % 3 === 1))).toBeCloseTo(4);
  });
  test('bvhOccluder blocks rays through solid geometry only', () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicNodeMaterial());
    box.position.set(0, 5, 0);
    const occ = bvhOccluder([box]);
    expect(occ.triangles).toBe(12);
    expect(occ.blocked([0, 0, 0], [0, 1, 0], 100)).toBe(true);
    expect(occ.blocked([5, 0, 0], [0, 1, 0], 100)).toBe(false);
    expect(occ.blocked([0, 0, 0], [0, 1, 0], 2)).toBe(false);
    expect(bvhOccluder([]).blocked([0, 0, 0], [0, 1, 0], 10)).toBe(false);
  });
  test('tagGroups de-indexes meshes and tags every vertex with its room', () => {
    const g = floorGroup();
    const n = tagGroups([g], [hall], new Map([['H', 0]]), 4.5);
    expect(n).toBe(2);
    const mesh = g.object.children[0] as THREE.Mesh;
    expect(mesh.geometry.index).toBe(null);
    expect(Array.from(mesh.geometry.getAttribute('interiorRoom').array)).toEqual([0, 0, 0, 0, 0, 0]);
    const bare = new THREE.BufferGeometry();
    bare.setAttribute('position', new THREE.Float32BufferAttribute([1, 0, 1, 1, 0, 2, 2, 0, 1], 3));
    const obj = new THREE.Mesh(bare, new THREE.MeshBasicNodeMaterial());
    tagGroups([{ ...g, object: obj }], [hall], new Map([['H', 0]]), 4.5);
    expect(bare.getAttribute('interiorRoom').count).toBe(3);
  });
  test('tagGroups frustum culls each mesh by its rooms\' boxes', () => {
    const g = floorGroup();
    tagGroups([g], [hall], new Map([['H', 0]]), 4.5);
    const mesh = g.object.children[0] as THREE.Mesh;
    const boxes = mesh.userData.roomBoxes as THREE.Box3[];
    expect(boxes.length).toBe(1);
    const pos = mesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) expect(boxes[0].containsPoint(new THREE.Vector3().fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(mesh.matrixWorld))).toBe(true);
    const look = (x: number, z: number, tx: number, tz: number) => {
      const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100); cam.position.set(x, 1.6, z); cam.lookAt(tx, 0, tz); cam.updateMatrixWorld();
      return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    };
    const c = boxes[0].getCenter(new THREE.Vector3());
    expect(mesh.intersectsFrustum(look(c.x, c.z + 6, c.x, c.z))).toBe(true); // looking at the floor
    expect(mesh.intersectsFrustum(look(c.x, c.z + 6, c.x, c.z + 60))).toBe(false); // looking away from it
  });
});

describe('bake', () => {
  const plan: InteriorPlan = {
    rooms: [hall, cellar],
    doors: [{ id: 'gate', spaces: ['outside', 'H'], centre: [3, 0, -1], along: [1, 0], normal: [0, 1], width: 1.4, height: 2.6, wall: 2, head: 'round', leaf: true, hinge: 'left', swingInto: 1, rebate: 0.1, kind: 'plank' }],
    stairs: [{ id: 's', kind: 'straight', zone: 'T', spaces: ['H', 'tunnel-1', 'ghost'], width: 1.2, landings: [] }],
  };
  const windows = [{ p: [6, 3, 9.6] as [number, number, number], n: [0, 0, 1] as [number, number, number], w: 0.8, h: 2 }];
  test('fills the table, reacts to the sun, doors and blocked windows', () => {
    const light = createInteriorLight(1);
    let t = 0;
    const bake = bakeInteriorLight([floorGroup()], never, { plan, windows, sun, light, now: () => (t += 5) });
    expect(bake.ms).toBe(20);                           // five clock reads, 5 ms apart
    expect(bake.timings).toEqual({ tag: 5, apertures: 5, update: 5 });
    expect(bake.rooms).toBe(1);                         // the table holds one room
    expect(bake.apertures.map((a) => a.kind)).toEqual(['glass', 'open']);
    expect(bake.apertures[0].group).toBe('T:0');
    const data = light.table.image.data as Float32Array;
    expect(data[0]).toBe(1);                            // the door starts shut
    const shut = bake.roomLight('H')!.bounce[0];
    bake.setDoorOpen('gate', 2);
    expect(bake.apertures[1].open).toBe(1);
    expect(data[0]).toBe(2);
    expect(bake.roomLight('H')!.bounce[0]).toBeGreaterThan(shut);
    bake.setDoorOpen('nope', 1);
    expect(bake.roomLight('nope')).toBe(null);
    const lit = bake.roomLight('H')!.bounce[0];
    const shaded = bakeInteriorLight([floorGroup()], { blocked: () => true }, { plan, windows, sun, light: createInteriorLight(4) });
    shaded.setDoorOpen('gate', 1);
    expect(shaded.roomLight('H')!.bounce[0]).toBeLessThan(lit);
    expect(shaded.roomLight('tunnel-1')!.bounce[0]).toBeGreaterThan(0); // light down the stair
    let night = false;
    const b2 = bakeInteriorLight([], never, { plan, windows, light: createInteriorLight(4), sun: () => (night ? { dir: [0, -0.2, 0.98], irradiance: [0.1, 0.1, 0.1] } : sun()) });
    const dayB = b2.roomLight('H')!.bounce[0];
    night = true; b2.update();
    expect(b2.roomLight('H')!.bounce[0]).toBeLessThan(dayB);
  });
  test('shadow skins: one invisible caster mesh', () => {
    const bake = bakeInteriorLight([], never, { plan, windows, sun, light: createInteriorLight(4) });
    const skin = buildShadowSkins(plan, bake.apertures);
    expect(skin.name).toBe('interior-shadow-skin');
    expect(skin.castShadow).toBe(true);
    expect((skin.material as THREE.Material).colorWrite).toBe(false);
    expect((skin.material as THREE.Material).shadowSide).toBe(THREE.DoubleSide); // stops the sun from either side
    expect(skin.geometry.getAttribute('position').count).toBeGreaterThan(0);
    expect(buildShadowSkins({ rooms: [], doors: [], stairs: [] }, []).geometry.getAttribute('position')).toBeUndefined();
  });
});

describe('room test cell', () => {
  test('hall + chamber with splayed windows, doors and views', () => {
    const M = mats();
    const IM = makeInteriorMaterials(M, new THREE.DirectionalLight(), createInteriorLight(4));
    const t = buildRoomTest(M, IM);
    expect(t.plan.rooms.map((r) => r.id)).toEqual(['T0-1', 'U0-1']);
    expect(t.plan.doors).toHaveLength(2);
    expect(t.windows).toHaveLength(6);
    expect(t.groups.map((g) => g.key)).toEqual(['T:0', 'U:0']);
    expect(t.views.every((v) => v.name.startsWith('room-'))).toBe(true);
    const names: string[] = []; t.groups[0].object.traverse((o) => names.push(o.name));
    expect(names).toContain('interior-T:0-glass');
    const bake = bakeInteriorLight(t.groups, bvhOccluder([t.exterior, ...t.groups.map((g) => g.object)]), { plan: t.plan, windows: t.windows, sun, light: createInteriorLight(4) });
    expect(bake.apertures.filter((a) => a.kind === 'glass').map((a) => a.room)).toEqual([0, 0, 0, 0, 1, 1]);
    expect(bake.roomLight('T0-1')!.bounce[0]).toBeGreaterThan(bake.roomLight('U0-1')!.bounce[0]);
  });
});
