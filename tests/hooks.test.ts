// window.__game hooks against a fake window: state, bookmarks, stepping, the scripted player API.
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three/webgpu';
import { installHooks, type HookWindow } from '../src/debug/hooks';
import { createPhysics } from '../src/physics/world';
import { CharacterMotor, shapeFrom } from '../src/character/motor';
import { PlayerController } from '../src/player/controller';
import { ScriptedInput } from '../src/player/input';
import { CameraRig } from '../src/camera/controls';
import { addBox, fakeClock } from './helpers';

class FakeWin implements HookWindow {
  l: Record<string, ((e: never) => void)[]> = {};
  __game?: unknown; render_game_to_text?: () => string;
  addEventListener(t: string, f: (e: never) => void) { (this.l[t] ??= []).push(f); }
  fire(t: string, e: unknown) { for (const f of this.l[t] ?? []) f(e as never); }
}

describe('__game hooks', () => {
  let w: FakeWin, game: ReturnType<typeof installHooks>, renders = 0, used = 0, open = false;
  beforeAll(async () => {
    const physics = await createPhysics(fakeClock());
    addBox(physics, -200, 200, -1, 0, -200, 200, 'floor');
    const input = new ScriptedInput(), cam = new THREE.PerspectiveCamera();
    const player = new PlayerController({ motor: new CharacterMotor(physics.createCharacter(shapeFrom())), input, view: cam, ray: physics });
    physics.onFixed((dt) => player.fixedUpdate(dt));
    const rig = new CameraRig(cam, { enabled: true, target: new THREE.Vector3(), update() {} }, input);
    rig.player = player; rig.alpha = () => physics.alpha;
    w = new FakeWin();
    w.__game = { interior: { from: 'shell' } };
    let hours = 10;
    game = installHooks({
      renderer: { backend: { isWebGPUBackend: true } } as never, camera: cam, rig,
      setTime: (h) => { hours = h; }, getTime: () => hours, renderNow: async () => { renders++; },
      stats: () => ({ extra: 1 }), tick: (dt) => { physics.step(dt); rig.update(dt); },
      physics, player, input, course: { lanes: [] }, interior: null,
      use: () => { used++; return true; },
      doors: { state: () => ({ gate: open ? 1 : 0 }), setOpen: (_id, o) => { open = o; } },
    }, w, fakeClock());
  });

  it('publishes on the window and keeps what was there', () => {
    expect(w.__game).toBe(game);
    expect((game as unknown as { interior: unknown }).interior).toBeNull();
    expect(game.version).toBe(2);
    expect(JSON.parse(w.render_game_to_text!()).backend).toBe('webgpu');
  });

  it('bookmarks, modes, time and stepping', async () => {
    expect(game.views()).toContain('gate');
    expect(game.setCamera('nope')).toBe(false);
    expect(game.setCamera('hero')).toBe(true);
    game.setMode('fly');
    expect(game.state().camera.mode).toBe('fly');
    game.setPose([0, 20, 0], [0, 0, -10]);
    game.lookFrom([1, 21, 2], [0, 0, -10]);
    expect(game.state().camera).toMatchObject({ mode: 'fly', x: 1, y: 21, z: 2 });
    game.lookFrom([0, 30, 60], [0, 0, 0], 'orbit');
    expect(game.state().camera.mode).toBe('orbit');
    game.setMode('fly');
    game.setTime(7);
    expect(game.state().time).toBe(7);
    await game.step(3);
    expect(renders).toBe(3);
    w.fire('error', { message: 'boom' }); w.fire('unhandledrejection', { reason: 'nope' });
    expect(game.state().errors).toEqual(['boom', 'nope']);
    expect((game.state() as Record<string, unknown>).extra).toBe(1);
  });

  it('teleports and walks the player by script', () => {
    const s = game.player.teleport(0, null, 0, 0, 0);
    expect(s.y).toBeCloseTo(0, 2);
    expect(game.state().camera.mode).toBe('walk');
    game.player.look(0, 0);
    const r = game.input(['KeyW'], 1000, { traceEvery: 10 });
    expect(r.z).toBeLessThan(-2);
    expect(r.ticks).toBe(60);
    expect(r.trace.length).toBe(6);
    expect(r.groundedFrac).toBeGreaterThan(0.9);
    expect(r.tickMs).toBeGreaterThan(0);
    expect(game.player.pos[2]).toBeCloseTo(r.z, 2);
    expect(game.player.state().z).toBe(r.z);
    game.setMode('orbit');
    expect(game.input([], 100).active).toBe(true);
    game.setMode('orbit');
    expect(game.player.teleport(5, 0, 5).x).toBe(5);
    expect(game.player.spawn().active).toBe(true);
    expect(game.physics.stats().characters).toBe(1);
    expect(game.physics.raycast([0, 5, 0], [0, -1, 0], 10)?.tag).toBe('floor');
    expect(game.course).toEqual({ lanes: [] });
  });

  it('use and doors pass through to the game', () => {
    expect(game.use()).toBe(true);
    expect(used).toBe(1);
    game.doors!.setOpen('gate', true);
    expect(game.doors!.state()).toEqual({ gate: 1 });
    const ticks = game.physics.stats().ticks;
    expect(game.doors!.tick(0.5)).toEqual({ gate: 1 });
    expect(game.physics.stats().ticks).toBeGreaterThan(ticks); // doors advance with physics
  });
});
