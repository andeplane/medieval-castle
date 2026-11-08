// Rapier physics world for walking (game-physics recipes 1–5): static trimesh colliders baked from the
// render meshes, the near terrain as an open trimesh (cellars and tunnels run under it), an invisible
// wall round the island, kinematic boxes for door leaves, any number of KCC characters (player, NPCs),
// and a fixed 60 Hz step with an accumulator. Implements the PhysicsApi contract.
import RAPIER from '@dimforge/rapier3d-compat';
import type * as THREE from 'three/webgpu';
import type { PhysicsApi, V3, Quat } from '../castle/interior/types';
import type { V2 } from '../core/math2d';
import { type Clock, systemClock } from '../core/clock';
import type { CharacterBody, CharacterPhysics, CharacterShape, CharacterHit } from '../character/types';
import { bakePositions, mul4, weld, mergeSoups, gridSoup, ribbon, type TriSoup, type HeightGrid } from './mesh';

export const DT = 1 / 60;
const MAX_STEPS = 5;

/** Collision layers (InteractionGroups = memberships << 16 | filter). */
export const L = { World: 0, Boundary: 1, Character: 2, Door: 3, Ray: 4 } as const;
const bits = (ls: number[]) => ls.reduce((a, l) => a | (1 << l), 0);
export const groups = (member: number[], hits: number[]) => (((bits(member) & 0xffff) << 16) | (bits(hits) & 0xffff)) >>> 0;
export const G = {
  world: groups([L.World], [L.Character, L.Ray]),
  boundary: groups([L.Boundary], [L.Character]),
  door: groups([L.Door], [L.Character, L.Ray]),
  // characters bump into the world, the boundary, doors and each other; rays (use, footsteps) skip
  // them, so a ray from the player's eye does not hit the player's own capsule
  character: groups([L.Character], [L.World, L.Boundary, L.Door, L.Character]),
  ray: groups([L.Ray], [L.World, L.Door]),
};

export type MeshFilter = (mesh: THREE.Mesh) => boolean;
/** Default: everything solid, glass included (windows must block). Only invisible meshes are skipped. */
export const solidMeshes: MeshFilter = (m) => m.visible !== false;
const defaultTag = (m: THREE.Mesh) => m.name || 'mesh';

export interface Crop { x0: number; x1: number; z0: number; z1: number }
export interface PhysicsStats { colliders: number; characters: number; triangles: number; buildMs: number; initMs: number; stepMs: number; stepMsMax: number; ticks: number }

export interface Physics extends PhysicsApi, CharacterPhysics {
  readonly R: typeof RAPIER;
  readonly world: RAPIER.World;
  /** Advance by a frame's dt: runs whole fixed ticks, keeps the remainder for interpolation. */
  step(dt: number): void;
  /** Exactly one fixed tick (fixed callbacks, then world.step). */
  tick(): void;
  /** Interpolation factor between the last two ticks, 0..1. */
  readonly alpha: number;
  /** Called every fixed tick before the world steps (characters, doors). Returns an unsubscribe. */
  onFixed(cb: (dt: number) => void): () => void;
  /**
   * Walk an object's meshes, bake world matrices, one trimesh per tag. Instanced meshes add one copy
   * per instance, keeping only instances whose origin (x, z) passes `keep`. Returns triangles added.
   */
  addObject(obj: THREE.Object3D, filter?: MeshFilter, tagOf?: (m: THREE.Mesh) => string, keep?: (x: number, z: number) => boolean): number;
  /** Near terrain as an open trimesh (see gridSoup), with optional holes for stairs into cellars. */
  addTerrain(g: HeightGrid, crop: Crop, hole?: (x: number, z: number) => boolean, tag?: string): number;
  /** Invisible wall from y0(point) up to y1, blocking characters only (not rays). */
  addBoundary(outline: V2[], y0: number | ((p: V2) => number), y1: number): void;
  tagOf(c: RAPIER.Collider | null | undefined): string | undefined;
  stats(): PhysicsStats;
}

let wasmReady: Promise<void> | null = null;
export const initRapier = () => (wasmReady ??= RAPIER.init());

export async function createPhysics(clock: Clock = systemClock): Promise<Physics> {
  const t0 = clock.now();
  await initRapier();
  const initMs = clock.now() - t0;
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  const tags = new Map<number, string>();
  const fixed = new Set<(dt: number) => void>();
  let acc = 0, alpha = 0, triangles = 0, buildMs = 0, characters = 0;
  let stepMs = 0, stepMsMax = 0, ticks = 0;
  // Rapier only refreshes its query structure in world.step(); queries right after adding colliders
  // would miss them, so the first query after a change steps once (nothing dynamic lives here)
  let dirty = false;
  const fresh = () => { if (dirty) { world.step(); dirty = false; } };
  const timed = <T>(f: () => T): T => { const t = clock.now(); const r = f(); buildMs += clock.now() - t; return r; };

  const addSoup = (s: TriSoup, tag: string, grp: number) => {
    if (!s.indices.length) return;
    timed(() => tags.set(world.createCollider(RAPIER.ColliderDesc.trimesh(s.vertices, s.indices).setCollisionGroups(grp).setFriction(0.8)).handle, tag));
    triangles += s.indices.length / 3;
    dirty = true;
  };

  // rapier 0.21's world.step() ends by walking every body and collider handle through JS, to wrap ones the
  // engine made itself (soft bodies, cuts) and drop removed ones: O(handles) per step, about 40 % of a step
  // with the castle's door leaves (the door-swing and stair-walk tests). Everything here is made through
  // the JS API, which wraps it at once, so a step does that walk only after a body was removed (rapier
  // drops the body's colliders on its own side; the walk drops their wrappers).
  let remap = false;
  const step = () => {
    if (remap) { world.step(); remap = false; return; }
    world.physicsPipeline.step(world.gravity, world.integrationParameters, world.islands, world.broadPhase, world.narrowPhase, world.bodies, world.colliders, world.softBodies, world.impulseJoints, world.multibodyJoints, world.ccdSolver);
  };

  const tick = () => {
    const t = clock.now();
    for (const cb of fixed) cb(DT);
    step();
    dirty = false;
    const ms = clock.now() - t;
    stepMs = ticks ? stepMs * 0.95 + ms * 0.05 : ms; stepMsMax = Math.max(stepMsMax * 0.999, ms); ticks++;
  };

  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const round3 = (n: number) => Math.round(n * 1000) / 1000;

  const createCharacter = (shape: CharacterShape): CharacterBody => {
    const half = (h: number) => Math.max(0.05, h / 2 - shape.radius);
    let hh = half(shape.height);
    const lift = () => hh + shape.radius + shape.skin; // feet → capsule centre
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    const collider = world.createCollider(RAPIER.ColliderDesc.capsule(hh, shape.radius).setCollisionGroups(G.character).setFriction(0), body);
    const kcc = world.createCharacterController(shape.skin);
    kcc.setUp({ x: 0, y: 1, z: 0 });
    kcc.setMaxSlopeClimbAngle((shape.maxSlopeDeg * Math.PI) / 180);
    kcc.setMinSlopeSlideAngle((shape.maxSlopeDeg * Math.PI) / 180);
    kcc.enableAutostep(shape.autostep, shape.autostepMinWidth, false);
    kcc.enableSnapToGround(shape.snap);
    kcc.setSlideEnabled(true);
    kcc.setApplyImpulsesToDynamicBodies(false);
    const feet: V3 = [0, 0, 0];
    const place = (teleport: boolean) => {
      const c = { x: feet[0], y: feet[1] + lift(), z: feet[2] };
      if (teleport) { body.setTranslation(c, true); world.propagateModifiedBodyPositionsToColliders(); }
      body.setNextKinematicTranslation(c);
    };
    characters++;
    dirty = true;
    tags.set(collider.handle, 'character');
    let alive = true;
    return {
      id: collider.handle,
      feet: () => [feet[0], feet[1], feet[2]],
      move(d) {
        fresh();
        kcc.computeColliderMovement(collider, { x: d[0], y: d[1], z: d[2] }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, G.character);
        const m = kcc.computedMovement();
        const hits: CharacterHit[] = [];
        for (let i = 0, n = kcc.numComputedCollisions(); i < n; i++) {
          const c = kcc.computedCollision(i)!;
          hits.push({ normal: [c.normal1.x, c.normal1.y, c.normal1.z], point: [c.witness1.x, c.witness1.y, c.witness1.z], tag: c.collider ? tags.get(c.collider.handle) : undefined });
        }
        feet[0] += m.x; feet[1] += m.y; feet[2] += m.z;
        place(false);
        return { move: [m.x, m.y, m.z], grounded: kcc.computedGrounded(), hits };
      },
      probe(x, z, top, depth) {
        const h = api.raycast([x, top, z], [0, -1, 0], depth);
        return h && { y: h.point[1], normal: h.normal, tag: h.tag };
      },
      teleport(p) { feet[0] = p[0]; feet[1] = p[1]; feet[2] = p[2]; place(true); },
      setHeight(h) { hh = half(h); collider.setHalfHeight(hh); place(true); },
      fits(h) {
        const c = { x: feet[0], y: feet[1] + half(h) + shape.radius + shape.skin + 0.03, z: feet[2] };
        fresh();
        return !world.intersectionWithShape(c, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Capsule(half(h), shape.radius - 0.02), RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, G.character, collider);
      },
      remove() { if (!alive) return; alive = false; characters--; tags.delete(collider.handle); world.removeCharacterController(kcc); world.removeRigidBody(body); remap = true; },
    };
  };

  const api: Physics = {
    R: RAPIER, world,
    get alpha() { return alpha; },
    onFixed: (cb) => { fixed.add(cb); return () => { fixed.delete(cb); }; },
    tick,
    step(dt) {
      acc += Math.min(dt, 0.25);
      let n = 0;
      while (acc >= DT - 1e-6 && n < MAX_STEPS) { tick(); acc -= DT; n++; }
      if (n === MAX_STEPS) acc = Math.min(acc, DT);
      acc = Math.max(0, acc);
      alpha = Math.min(1, acc / DT);
    },

    addStaticMesh(geometry, tag = 'mesh') {
      const { pos, index } = bakePositions(geometry);
      addSoup(timed(() => weld(pos, index)), tag, G.world);
    },

    addObject(obj, filter = solidMeshes, tagOf = defaultTag, keep) {
      obj.updateMatrixWorld(true);
      const before = triangles;
      const soups = new Map<string, TriSoup[]>();
      const push = (tag: string, s: TriSoup) => (soups.get(tag) ?? soups.set(tag, []).get(tag)!).push(s);
      timed(() => obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !filter(m)) return;
        const im = o as THREE.InstancedMesh;
        if (im.isInstancedMesh) {
          const arr = im.instanceMatrix.array;
          for (let i = 0; i < im.count; i++) {
            const e = mul4(im.matrixWorld.elements, arr, i * 16);
            if (keep && !keep(e[12], e[14])) continue;
            const { pos, index } = bakePositions(im.geometry, e);
            push(tagOf(m), weld(pos, index));
          }
          return;
        }
        const { pos, index } = bakePositions(m.geometry, m.matrixWorld.elements);
        push(tagOf(m), weld(pos, index));
      }));
      for (const [tag, list] of soups) addSoup(list.length === 1 ? list[0] : mergeSoups(list), tag, G.world);
      return triangles - before;
    },

    addTerrain(g, crop, hole, tag = 'terrain') {
      const soup = timed(() => gridSoup(g, crop, hole));
      addSoup(soup, tag, G.world);
      return soup.indices.length / 3;
    },

    addBoundary(outline, y0, y1) { addSoup(ribbon(outline, y0, y1), 'boundary', G.boundary); },

    addStaticBoxes(boxes, tag = 'box') {
      const made: RAPIER.Collider[] = [];
      for (let i = 0; i + 7 <= boxes.length; i += 7) {
        const s = Math.sin(boxes[i + 6] / 2), c = Math.cos(boxes[i + 6] / 2);
        const desc = RAPIER.ColliderDesc.cuboid(boxes[i + 3], boxes[i + 4], boxes[i + 5]).setTranslation(boxes[i], boxes[i + 1], boxes[i + 2]).setRotation({ x: 0, y: s, z: 0, w: c }).setCollisionGroups(G.world).setFriction(0.8);
        const col = timed(() => world.createCollider(desc));
        tags.set(col.handle, tag);
        made.push(col);
      }
      if (made.length) dirty = true;
      let alive = true;
      return {
        remove() {
          if (!alive) return;
          alive = false;
          for (const col of made) { tags.delete(col.handle); world.removeCollider(col, false); }
          if (made.length) dirty = true;
        },
      };
    },

    addKinematicBox(half: V3, tag = 'kinematic') {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      const c = world.createCollider(RAPIER.ColliderDesc.cuboid(half[0], half[1], half[2]).setCollisionGroups(G.door), body);
      tags.set(c.handle, tag);
      dirty = true;
      let placed = false, alive = true;
      return {
        setPose(p: V3, q: Quat) {
          if (!alive) return;
          const tr = { x: p[0], y: p[1], z: p[2] }, rot = { x: q[0], y: q[1], z: q[2], w: q[3] };
          // the first pose teleports, later ones move so contacts see a real velocity
          if (!placed) { body.setTranslation(tr, true); body.setRotation(rot, true); world.propagateModifiedBodyPositionsToColliders(); placed = true; dirty = true; }
          body.setNextKinematicTranslation(tr); body.setNextKinematicRotation(rot);
        },
        remove() { if (!alive) return; alive = false; tags.delete(c.handle); world.removeRigidBody(body); remap = true; },
      };
    },

    raycast(from, dir, maxDist) {
      const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      ray.origin = { x: from[0], y: from[1], z: from[2] };
      ray.dir = { x: dir[0] / l, y: dir[1] / l, z: dir[2] / l };
      fresh();
      const hit = world.castRayAndGetNormal(ray, maxDist, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, G.ray);
      if (!hit) return null;
      const d = hit.timeOfImpact;
      return {
        point: [from[0] + ray.dir.x * d, from[1] + ray.dir.y * d, from[2] + ray.dir.z * d],
        normal: [hit.normal.x, hit.normal.y, hit.normal.z], dist: d, tag: tags.get(hit.collider.handle),
      };
    },

    createCharacter,
    tagOf: (c) => (c ? tags.get(c.handle) : undefined),
    stats: () => ({ colliders: world.colliders.len(), characters, triangles, buildMs: Math.round(buildMs), initMs: Math.round(initMs), stepMs: round3(stepMs), stepMsMax: round3(stepMsMax), ticks }),
  };
  return api;
}
