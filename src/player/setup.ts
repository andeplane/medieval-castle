// Builds the walking world after the castle exists: Rapier, colliders from the castle (with bridge and
// revetment), the interior shell when present, the near terrain with holes for cellar stairs, the
// island boundary, the player and footsteps. Everything here runs before __game.ready.
import type * as THREE from 'three/webgpu';
import { createPhysics, type Physics } from '../physics/world';
import { boundaryOutline } from '../physics/boundary';
import type { HeightGrid } from '../physics/mesh';
import { offsetPoly } from '../castle/builder';
import { courtyard, footprints, stairTowerCentre } from '../castle/layout';
import { STAIR_TOWER } from '../castle/spec';
import { type V2, pointInPoly } from '../core/math2d';
import { ISLAND, heightAt, footDist } from '../world/terrain';
import { PlayerController, type SurfaceResolver, type CameraView } from './controller';
import { CharacterMotor, shapeFrom } from '../character/motor';
import type { Footsteps } from './footsteps';
import type { InputSource } from './input';
import type { Clock } from '../core/clock';

/** What the interior shell may hand over (as `__game.interior`). */
export interface InteriorCollision { collision?: THREE.BufferGeometry[]; terrainHoles?: V2[][] }

export interface PlayDeps {
  castle: THREE.Object3D; terrain: THREE.Object3D; input: InputSource; view: CameraView; footsteps: Footsteps; clock: Clock;
  bridge?: { start: V2; dir: V2; width: number; breakAt: number } | null;   // null in ?test=stairs
  interior?: InteriorCollision | null;
  /** Furniture collision boxes as triangle soups (props block the player), when furniture is on. */
  furniture?: THREE.BufferGeometry[];
  extra?: { object: THREE.Object3D; holes: V2[][] } | null;   // e.g. the ?test=walk course
}

/** Doors that never open (no interactables, no NPC requests): the sally-port grille. */
export const LOCKED_DOORS = new Set(['sallyport-grille']);

/**
 * The door leaves of the walking world: the gate's own specs (until the gate-portcullis branch
 * reconciles them with the plan's 'gate-main'), every leaf door of the plan, and the locked ones apart.
 */
export function playDoors<D extends { id: string; leaf: boolean }>(gate: D[], plan: D[]) {
  const leaves = plan.filter((d) => d.leaf && d.id !== 'gate-main');
  return { active: [...gate, ...leaves.filter((d) => !LOCKED_DOORS.has(d.id))], locked: leaves.filter((d) => LOCKED_DOORS.has(d.id)) };
}

const COURT = courtyard();
const circle = (c: V2, r: number, n = 16): V2[] => Array.from({ length: n }, (_, i) => [c[0] + Math.cos((i / n) * 2 * Math.PI) * r, c[1] + Math.sin((i / n) * 2 * Math.PI) * r]);
/** Point-in-any-polygon with a bounding-box reject first. */
function boxed(polys: V2[][]) {
  const boxes = polys.map((p) => { let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (const [x, z] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); } return { x0, x1, z0, z1 }; });
  return (x: number, z: number) => polys.some((p, i) => { const b = boxes[i]; return x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && pointInPoly(p, x, z); });
}
export const surfaceAt: SurfaceResolver = (tag, x, z) => {
  if (!tag) return 'stone';
  if (tag.includes('wood')) return 'wood';
  if (tag === 'terrain') return pointInPoly(COURT, x, z) ? 'stone' : footDist(x, z) < 3 ? 'dirt' : 'grass';
  return 'stone';
};

/** The near terrain mesh as a height grid (PlaneGeometry rotated flat: X fastest, rows north → south). */
function terrainGrid(terrain: THREE.Object3D): HeightGrid | null {
  const near = terrain.getObjectByName('terrain-near') as THREE.Mesh | undefined;
  const g = near?.geometry as (THREE.BufferGeometry & { parameters?: { width: number; height: number; widthSegments: number; heightSegments: number } }) | undefined;
  if (!g?.parameters) return null;
  const { width, height, widthSegments: sx, heightSegments: sz } = g.parameters;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nx = sx + 1, nz = sz + 1, heights = new Float32Array(nx * nz);
  for (let i = 0; i < nx * nz; i++) heights[i] = pos.getY(i);
  return { heights, nx, nz, dx: width / sx, dz: height / sz, ox: pos.getX(0), oz: pos.getZ(0) };
}

export async function setupPlay(d: PlayDeps) {
  const t0 = d.clock.now();
  const physics: Physics = await createPhysics(d.clock);
  const tInit = d.clock.now() - t0;

  const castleTris = physics.addObject(d.castle);
  let interiorTris = 0;
  for (const g of d.interior?.collision ?? []) { physics.addStaticMesh(g, 'interior'); interiorTris += (g.index ? g.index.count : g.getAttribute('position').count) / 3; }
  for (const g of d.furniture ?? []) physics.addStaticMesh(g, 'furniture');
  if (d.extra) physics.addObject(d.extra.object, undefined, () => 'course');

  // terrain: an open trimesh over the island and the near moat. Holes under the buildings (their own
  // floors take over, and cellar stairs pass through) but not under the courtyard, which keeps the
  // ground except in the stair tower (its spiral goes down to the cellars); plus whatever the interior
  // or the course asks for
  const built = footprints().map((p) => offsetPoly(p, -0.5)), court = offsetPoly(COURT, 0.3);
  const extra: V2[][] = [circle(stairTowerCentre(), STAIR_TOWER.r - 0.3), ...(d.interior?.terrainHoles ?? []), ...(d.extra?.holes ?? [])];
  const inBuilt = boxed(built), inExtra = boxed(extra);
  const hole = (x: number, z: number) => (inBuilt(x, z) && !pointInPoly(court, x, z)) || inExtra(x, z);
  let ix0 = 1e9, ix1 = -1e9, iz0 = 1e9, iz1 = -1e9;
  for (const [x, z] of ISLAND) { ix0 = Math.min(ix0, x); ix1 = Math.max(ix1, x); iz0 = Math.min(iz0, z); iz1 = Math.max(iz1, z); }
  const crop = { x0: ix0 - 6, x1: ix1 + 6, z0: iz0 - 6, z1: iz1 + 6 };
  const grid = terrainGrid(d.terrain);
  const terrainTris = grid ? physics.addTerrain(grid, crop, hole) : 0;
  // the landscape's near rocks (instanced) that stand on the island; the moat-bank ones are out of reach
  const rocks = d.terrain.getObjectByName('rocks');
  const rockTris = rocks ? physics.addObject(rocks, (m) => m.name.startsWith('rocks-near'), () => 'rock', (x, z) => pointInPoly(ISLAND, x, z)) : 0;

  // the island boundary: only near the surface, so cellars and the moat tunnel can pass under it
  const boundary = boundaryOutline(ISLAND, d.bridge ?? undefined);
  physics.addBoundary(boundary, (p) => Math.max(heightAt(p[0], p[1]) - 1, 0.3), 40);

  const motor = new CharacterMotor(physics.createCharacter(shapeFrom()));
  const player = new PlayerController({ motor, input: d.input, view: d.view, ray: physics, surfaceAt, onFootstep: (s, run, k) => d.footsteps.play(s, run, k) });
  physics.onFixed((dt) => player.fixedUpdate(dt));
  // first step so the query structures hold every collider
  physics.world.step();
  const totalMs = d.clock.now() - t0;
  /** NPC motors sharing this world (add with physics.createCharacter); the player is not listed. */
  const npcs: CharacterMotor[] = [];
  const centre = (m: CharacterMotor) => ({ x: m.feet[0], y: m.feet[1] + m.height / 2, z: m.feet[2] });
  return {
    physics, player, boundary, npcs,
    /** Body centres of the NPCs (doors stop a swinging leaf against them). */
    characters: () => npcs.map(centre),
    /** The player's body centre. */
    playerCentre: () => centre(motor),
    walkable: (x: number, z: number) => pointInPoly(boundary, x, z),
    timings: { wasmMs: Math.round(tInit), totalMs: Math.round(totalMs), castleTris, interiorTris, terrainTris, rockTris },
  };
}
