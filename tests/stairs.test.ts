// Stair guards: rises, goings at the walking line, headroom, landing heights, mesh health and
// determinism, measured both on the plan and on the triangles the stair actually builds.
import { describe, it, expect } from 'vitest';
import { Builder } from '../src/castle/builder';
import {
  buildStair, planStair, stairCollisionRamp, stairNavPath, STAIR_RULES, spiralTreadY, spiralLandingAngles, spiralStartFor,
  validateStair, drumWall, spiralStonesAt, spiralNosingY, type SpiralPlan, type StairPlan, type StairOpts,
} from '../src/castle/interior/stairs';
import { probeStair, VerticalCaster, binTriangles, meshHealth } from '../src/castle/interior/stairprobe';
import type { StairSpec } from '../src/castle/interior/types';
import { floorBase } from '../src/castle/spec';
import { mulberry32 } from '../src/core/rng';

const TEST_SPIRAL: StairSpec = {
  id: 'test-spiral', kind: 'spiral', zone: 'test', spaces: ['a', 'b', 'c', 'd'],
  centre: [0, 0], radius: 2.4, newel: 0.3, turn: -1, width: 2.1,
  landings: [{ y: 7, angle: Math.PI / 2 }, { y: 13, angle: -0.6 }, { y: 19, angle: 2.3 }, { y: 25, angle: 0.8 }],
};
const TOWER: StairSpec = {
  id: 'se-turret', kind: 'spiral', zone: 'se', spaces: ['courtyard', 'se-1', 'se-2', 'se-3', 'se-4'],
  centre: [24, 12], radius: 1.15, newel: 0.13, turn: -1, startAngle: 1.0, width: 1.0,
  landings: [0, 1, 2, 3, 4].map((f) => ({ y: floorBase(f) })),
};
const MURAL: StairSpec = {
  id: 'mural', kind: 'straight', zone: 'W', spaces: ['W1-1', 'W2-1'], start: [-20, floorBase(1), 0], end: [-20, floorBase(2), 7.8], width: 1.0,
  landings: [{ y: floorBase(1) }, { y: floorBase(2) }],
};
const STEPS: StairSpec = {
  id: 'yard-steps', kind: 'straight', zone: 'courtyard', spaces: ['courtyard', 'N1-2'], start: [3, 2.6, 4], end: [5.5, 4.6, 0.2], width: 2.2,
  landings: [{ y: 2.6 }, { y: 4.6 }],
};

const area = (pos: number[]) => {
  let a = 0;
  for (let o = 0; o < pos.length; o += 9) {
    const u = [pos[o + 3] - pos[o], pos[o + 4] - pos[o + 1], pos[o + 5] - pos[o + 2]], v = [pos[o + 6] - pos[o], pos[o + 7] - pos[o + 1], pos[o + 8] - pos[o + 2]];
    a += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return a;
};

function checkProbe(s: StairSpec, o: StairOpts = {}) {
  const B = new Builder();
  const plan = buildStair(B, s, o);
  const r = probeStair(B, plan);
  expect(r.nan).toBe(0);
  expect(r.degenerate).toBe(0);
  expect(r.missing).toBe(0);
  expect(r.maxRise).toBeLessThanOrEqual(STAIR_RULES.riseLimit);
  expect(r.minGoing).toBeGreaterThanOrEqual(STAIR_RULES.goingLimit);
  expect(r.minHeadroom).toBeGreaterThanOrEqual(STAIR_RULES.headroomLimit);
  expect(r.landingErr).toBeLessThanOrEqual(0.01);
  return { B, r, plan };
}

describe('spiral stairs', () => {
  it('lists the step stones on a vertical line through the drum, one per turn (light slits keep off them)', () => {
    const p = planStair(TEST_SPIRAL) as SpiralPlan, last = p.steps[p.steps.length - 1];
    const th = p.theta0 + p.dir * (p.steps[3].a0 + p.steps[3].a1) / 2, st = spiralStonesAt(p, th);
    expect(st.length).toBeGreaterThanOrEqual(Math.floor((last.a1 - p.steps[3].a1) / (Math.PI * 2)));
    for (let i = 1; i < st.length; i++) expect(st[i][0]).toBeGreaterThan(st[i - 1][1]); // a gap between the turns
    const psi = (p.steps[3].a0 + p.steps[3].a1) / 2, nose = spiralNosingY(p, psi);
    expect(st[0]).toEqual([p.steps[3].solid ? p.yFloor : nose - p.T + p.steps[3].soffitJit, Math.max(p.steps[3].y, nose)]);
    expect(spiralStonesAt(p, th + 2 * Math.PI)).toEqual(st);
  });
  it('plans the test stair within the rules', () => {
    const p = planStair(TEST_SPIRAL) as SpiralPlan;
    expect(p.stats.problems).toEqual([]);
    expect(p.stats.maxRise).toBeLessThanOrEqual(0.21);
    expect(p.stats.minRise).toBeGreaterThanOrEqual(0.165);
    expect(p.stats.minGoing).toBeGreaterThanOrEqual(0.22);
    expect(p.stats.minHeadroom).toBeGreaterThanOrEqual(2.05);
    // a full turn rises at least 2.3 m plus the tread thickness
    expect(p.perTurn * p.stats.minRise).toBeGreaterThanOrEqual(2.3 + p.T - p.stats.maxRise);
    // landings at the requested heights and door angles
    for (const [k, l] of TEST_SPIRAL.landings.entries()) {
      expect(Math.abs(p.landings[k].y - l.y)).toBeLessThan(0.01);
      const da = Math.atan2(Math.sin(p.landings[k].angle - l.angle!), Math.cos(p.landings[k].angle - l.angle!));
      expect(Math.abs(da)).toBeLessThan(1e-6);
      if (k > 0) expect(spiralTreadY(p, p.landings[k].psi)).toBeCloseTo(l.y, 6);
      expect(p.landings[k].clear).toBeGreaterThan(2.2);
    }
  });

  it('builds closed, walkable geometry (measured on the triangles)', () => {
    const { B, r, plan } = checkProbe(TEST_SPIRAL);
    expect(r.rises.length).toBe(plan.steps.length);
    const tris = Object.values(B.bins).reduce((a, b) => a + b.pos.length / 9, 0);
    expect(tris / plan.steps.length).toBeLessThan(250);
  });

  it('honours the turn direction and start angle', () => {
    for (const turn of [1, -1] as const) {
      const s: StairSpec = { ...TOWER, id: `dir${turn}`, turn };
      const p = planStair(s) as SpiralPlan;
      expect(p.dir).toBe(-turn);
      const a0 = p.theta0 + p.dir * p.steps[0].a0, a1 = p.theta0 + p.dir * p.steps[1].a0;
      expect(a0).toBeCloseTo(1.0, 9);
      // seen from above with x east, z south: clockwise = increasing atan2(z, x)
      expect(Math.sign(a1 - a0)).toBe(turn === -1 ? 1 : -1);
    }
  });

  it('works for a tight tower stair and for many random towers', () => {
    checkProbe(TOWER);
    const rnd = mulberry32(42);
    for (let n = 0; n < 10; n++) {
      // the way a shell would do it: a bottom door, the start just past it, upper doors where the
      // stair puts its landings (spiralLandingAngles), nudged a little toward the rooms
      const R = 0.95 + rnd() * 1.7, floors = 2 + Math.floor(rnd() * 5), f0 = Math.floor(rnd() * 2), turn = rnd() < 0.8 ? -1 : 1;
      const door = rnd() * 6.28 - 3.14;
      const s: StairSpec = {
        id: `rand-${n}`, kind: 'spiral', zone: 'x', spaces: [], centre: [rnd() * 40 - 20, rnd() * 40 - 20],
        radius: R, newel: 0.1 + rnd() * 0.2 * (R / 2), turn, width: R - 0.2,
        landings: Array.from({ length: floors }, (_, k) => ({ y: floorBase(f0 + k), angle: k === 0 ? door : undefined })),
      };
      if (rnd() < 0.5) s.startAngle = spiralStartFor(door, R, turn);
      const free = spiralLandingAngles(s);
      if (rnd() < 0.6) s.landings = s.landings.map((l, k) => (k === 0 ? l : { ...l, angle: free[k] + (rnd() - 0.5) * 0.1 }));
      const p = planStair(s);
      expect(p.stats.problems, s.id).toEqual([]);
      checkProbe(s);
    }
  }, 30_000); // ~2 s idle; generous for a busy CI box

  it('reports impossible door angles instead of building a bad stair silently', () => {
    // bottom door half a turn behind the first step: the floor in front of it is under the stair
    const s: StairSpec = { ...TOWER, id: 'bad-door', landings: [{ y: floorBase(0), angle: 1.0 + Math.PI }, { y: floorBase(1) }] };
    expect(validateStair(s).problems.join()).toMatch(/bottom door/);
    const s2: StairSpec = { ...TOWER, id: 'bad-door2', landings: [{ y: floorBase(0), angle: 1.2 }, { y: floorBase(1) }] };
    expect(validateStair(s2).problems.join()).toMatch(/overlaps/);
    expect(validateStair({ ...TOWER, id: 'ok-door', landings: [{ y: floorBase(0), angle: 1.0 - (spiralStartFor(0, TOWER.radius!) - 0) }, { y: floorBase(1) }] }).ok).toBe(true);
    // two landings at the same height, and a single landing
    expect(validateStair({ ...TOWER, id: 'flat', landings: [{ y: 5 }, { y: 5.01 }, { y: 9 }] }).problems.join()).toMatch(/same height/);
    const one = planStair({ ...TOWER, id: 'one', landings: [{ y: 5 }] });
    expect(one.stats.ok).toBe(false);
    const B = new Builder();
    buildStair(B, one);
    expect(B.bins.trim.pos.length).toBe(0);
    expect(stairCollisionRamp(one)).toBeNull();
    expect(stairNavPath(one)).toEqual([]);
  });

  it('is deterministic per seed and differs between stairs', () => {
    const a = new Builder(), b = new Builder(), c = new Builder();
    buildStair(a, TEST_SPIRAL); buildStair(b, TEST_SPIRAL); buildStair(c, { ...TEST_SPIRAL, id: 'other' });
    expect(a.bins.trim.pos).toEqual(b.bins.trim.pos);
    expect(a.bins.trim.pos).not.toEqual(c.bins.trim.pos);
  });

  it('takes its randomness from an injected rng', () => {
    const a = planStair(TEST_SPIRAL, { rng: mulberry32(7) }), b = planStair(TEST_SPIRAL, { rng: mulberry32(7) }), c = planStair(TEST_SPIRAL, { rng: mulberry32(8) });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.stats.ok && c.stats.ok).toBe(true);
  });

  it('builds the optional parts: skin, ceiling, polygonal drum, no rail, no top wall, other materials', () => {
    const base = new Builder(); buildStair(base, TEST_SPIRAL);
    const B = new Builder();
    const o: StairOpts = { skin: true, ceilingDisc: true, ceiling: 27.6, skinOpenings: [{ angle: 0, width: 0.4, y0: 9, y1: 10 }], mat: { wall: 'new' } };
    buildStair(B, TEST_SPIRAL, o);
    expect(B.bins.new.pos.length).toBeGreaterThan(0);
    expect(B.bins.trim.pos.length).toBeGreaterThan(base.bins.trim.pos.length);
    expect(meshHealth(binTriangles(B, ['trim', 'new', 'wood', 'iron'])).degenerate).toBe(0);
    // octagonal stair room: tread ends follow the polygon, no rope by default
    const R8 = 2.4 / Math.cos(Math.PI / 8);
    const oct = Array.from({ length: 8 }, (_, k) => [Math.cos((k * Math.PI) / 4) * R8, Math.sin((k * Math.PI) / 4) * R8] as [number, number]);
    const P = new Builder();
    buildStair(P, TEST_SPIRAL, { drumPoly: oct, skin: true, topWall: false, bottomFloor: false });
    expect(P.bins.wood.pos.length).toBe(0);
    expect(P.bins.old.pos.length).toBe(0);
    // a tread reaches into the octagon's corner, beyond the 2.4 m circle
    const caster = new VerticalCaster(P.bins.trim.pos);
    let corner = 0;
    for (let k = 0; k < 8; k++) if (!Number.isNaN(caster.floor(Math.cos((k * Math.PI) / 4) * 2.5, Math.sin((k * Math.PI) / 4) * 2.5, 30))) corner++;
    expect(corner).toBe(8);
    const N = new Builder();
    buildStair(N, TEST_SPIRAL, { handrail: false });
    expect(N.bins.wood.pos.length).toBe(0);
  });

  it('has a collision ramp on or just above every tread', () => {
    const B = new Builder();
    const p = buildStair(B, TEST_SPIRAL) as SpiralPlan;
    const g = stairCollisionRamp(p)!;
    const pos = Array.from(g.getAttribute('position').array as Float32Array);
    expect(pos.every(Number.isFinite)).toBe(true);
    const ramp = new VerticalCaster(pos), steps = new VerticalCaster(B.bins.trim.pos);
    let below = 0, n = 0, maxSlope = 0, prev: [number, number] | null = null;
    const last = p.steps[p.steps.length - 1];
    for (let q = p.steps[0].a0; q < last.a1 - 0.01; q += 0.004) {
      const a = p.theta0 + p.dir * q, r = p.rWalk, x = p.c[0] + Math.cos(a) * r, z = p.c[1] + Math.sin(a) * r;
      const yT = steps.floor(x, z, spiralTreadY(p, q) + 0.06), yR = ramp.floor(x, z, spiralTreadY(p, q) + 0.3);
      n++;
      if (yR < yT - 0.001) below++;
      if (prev) maxSlope = Math.max(maxSlope, Math.atan2(yR - prev[1], q * r - prev[0]));
      prev = [q * r, yR];
    }
    expect(below / n).toBeLessThan(0.002);
    expect((maxSlope * 180) / Math.PI).toBeLessThan(35);
  });
});

describe('nav path', () => {
  for (const s of [TEST_SPIRAL, TOWER, MURAL, STEPS]) {
    it(`${s.id}: stays on the treads, keeps the headroom, meets the landings`, () => {
      const B = new Builder();
      const p: StairPlan = buildStair(B, s);
      const path = stairNavPath(p);
      expect(path.length).toBeGreaterThan(p.steps.length);
      const c = new VerticalCaster(binTriangles(B, ['trim', 'old']));
      for (let k = 0; k + 1 < path.length; k++) for (const u of [0, 0.5]) {
        const q = path[k].map((v, i) => v + (path[k + 1][i] - v) * u);
        let floor = c.floor(q[0], q[2], q[1] + 0.01);
        // a straight flight starts on the floor in front of it, which is the shell's (or the ground)
        if (p.kind === 'straight' && (q[0] - p.o[0]) * p.d[0] + (q[2] - p.o[2]) * p.d[1] < p.steps[0].s0 - p.steps[0].nosing) floor = p.yFloor;
        const ceil = c.ceiling(q[0], q[2], floor + STAIR_RULES.riseLimit + 0.06);
        expect(Number.isNaN(floor), `${k}`).toBe(false);
        expect(q[1] - floor).toBeGreaterThanOrEqual(-0.005);
        // at most a rise (plus the worn hollow) above the stone
        expect(q[1] - floor).toBeLessThanOrEqual(STAIR_RULES.riseLimit + 0.04);
        expect(ceil - floor).toBeGreaterThanOrEqual(STAIR_RULES.headroomLimit);
        expect(ceil - q[1]).toBeGreaterThanOrEqual(1.8);
        if (p.kind === 'spiral') {
          const r = Math.hypot(q[0] - p.c[0], q[2] - p.c[1]);
          expect(r).toBeGreaterThan(p.rn + 0.3);
          expect(r).toBeLessThan(p.R - 0.3);
        }
      }
      expect(path[0][1]).toBeCloseTo(p.yFloor, 6);
      expect(path[path.length - 1][1]).toBeCloseTo(p.yTop, 6);
      // every landing height is a vertex (spirals: exactly at the door centre on the walking line)
      for (const l of s.landings) expect(path.some((q) => Math.abs(q[1] - l.y) < 0.01)).toBe(true);
      if (p.kind === 'spiral') for (const l of p.landings) {
        const a = p.theta0 + p.dir * l.psi, d = [p.c[0] + Math.cos(a) * p.rWalk, l.y, p.c[1] + Math.sin(a) * p.rWalk];
        expect(Math.min(...path.map((q) => Math.hypot(q[0] - d[0], q[1] - d[1], q[2] - d[2])))).toBeLessThan(0.01);
      }
      // it never goes down
      for (let k = 1; k < path.length; k++) expect(path[k][1]).toBeGreaterThanOrEqual(path[k - 1][1] - 1e-9);
    });
  }
});

describe('drum wall', () => {
  it('cuts openings, inward or outward', () => {
    const B = new Builder();
    drumWall(B, 'old', [0, 0], 2, 0, 3, [{ angle: 0, width: 1, y0: 0, y1: 2 }, { angle: 3, width: 0.3, y0: 1, y1: 1.5 }], true);
    drumWall(B, 'new', [0, 0], 3, 0, 3, [], false);
    expect(meshHealth(B.bins.old.pos).degenerate).toBe(0);
    // polygonal approximation of the cylinder area, minus the door (1 × 2) and the slit (0.3 × 0.5)
    expect(area(B.bins.new.pos)).toBeCloseTo(2 * Math.PI * 3 * 3, 0);
    expect(area(B.bins.old.pos)).toBeCloseTo(2 * Math.PI * 2 * 3 - 2 - 0.15, 0);
    // the inward wall faces the axis, the outward one away from it
    const dotOut = (b: { pos: number[]; nor: number[] }) => b.nor[0] * b.pos[0] + b.nor[2] * b.pos[2];
    expect(dotOut(B.bins.old)).toBeLessThan(0);
    expect(dotOut(B.bins.new)).toBeGreaterThan(0);
  });
});

describe('straight stairs', () => {
  it('mural stair: rules, lintels and headroom', () => {
    const p = planStair(MURAL);
    if (p.kind !== 'straight') throw new Error('kind');
    expect(p.mural).toBe(true);
    expect(p.stats.problems).toEqual([]);
    expect(p.ceiling.length).toBeGreaterThan(5);
    checkProbe(MURAL);
  });

  it('courtyard steps: open flight', () => {
    const p = planStair(STEPS);
    if (p.kind !== 'straight') throw new Error('kind');
    expect(p.mural).toBe(false);
    expect(p.stats.problems).toEqual([]);
    checkProbe(STEPS);
    expect(stairCollisionRamp(STEPS)).not.toBeNull();
  });

  it('flags a flight that is too steep, and wrong landing heights', () => {
    const s: StairSpec = { ...MURAL, id: 'steep', end: [-20, floorBase(2), 3] };
    expect(planStair(s).stats.ok).toBe(false);
    expect(validateStair({ ...MURAL, id: 'off', landings: [{ y: 1 }, { y: 2 }] }).problems.join()).toMatch(/landings/);
  });

  it('runs downhill specs uphill, takes mid landings, and pads long runs with flat ends', () => {
    const down: StairSpec = { ...MURAL, id: 'down', start: MURAL.end, end: MURAL.start, landings: [] };
    const p = planStair(down);
    if (p.kind !== 'straight') throw new Error('kind');
    expect(p.yFloor).toBeCloseTo(floorBase(1), 6);
    expect(p.stats.ok).toBe(true);
    const mid: StairSpec = { ...STEPS, id: 'mid', end: [9, 6.6, -4], landings: [{ y: 2.6 }, { y: 4.6 }, { y: 6.6 }], width: 1.6 };
    const { plan } = checkProbe(mid);
    if (plan.kind !== 'straight') throw new Error('kind');
    expect(plan.steps.filter((x) => x.landing >= 0).length).toBe(2);
    const long: StairSpec = { ...MURAL, id: 'long', end: [-20, floorBase(2), 14] };
    const { plan: lp } = checkProbe(long);
    if (lp.kind !== 'straight') throw new Error('kind');
    expect(lp.lead).toBeGreaterThan(0.5);
    checkProbe({ ...MURAL, id: 'forced-open' }, { mural: false });
    expect(stairCollisionRamp(mid)!.getAttribute('position').count).toBeGreaterThan(30);
  });

  it('keeps a set going and gives the rest of the run to a top landing closed at its far end', () => {
    // the cellar stair's shape: an open flight in a stairwell whose top door opens off the landing's side
    const s: StairSpec = { ...STEPS, id: 'cellar', start: [0, -1.8, 0], end: [7.02, 2.6, 0], width: 1.25, landings: [{ y: -1.8 }, { y: 2.6 }] };
    const o: StairOpts = { going: 0.26, mural: false };
    const { plan } = checkProbe(s, o);
    if (plan.kind !== 'straight') throw new Error('kind');
    const top = plan.steps[plan.steps.length - 1];
    expect(plan.steps.slice(0, -1).every((x) => Math.abs(x.s1 - x.s0 - 0.26) < 1e-9)).toBe(true);
    expect(top.s1 - top.s0).toBeCloseTo(7.02 - 22 * 0.26, 6);
    // its far end is a stone face from below the floor up to the landing, facing out of the flight
    const B = new Builder();
    buildStair(B, s, o);
    const pos = B.bins.trim.pos, nor = B.bins.trim.nor;
    let end = 0;
    for (let i = 0; i < pos.length; i += 3) if (Math.abs(pos[i] - 7.02) < 1e-6 && nor[i] > 0.99) end = Math.max(end, pos[i + 1]);
    expect(end).toBeCloseTo(2.6, 6);
    // without a set going the same run is spread over the treads, with no landing
    const loose = planStair(s, { mural: false });
    if (loose.kind !== 'straight') throw new Error('kind');
    expect(loose.steps[loose.steps.length - 1].s1 - loose.steps[loose.steps.length - 1].s0).toBeCloseTo(0, 6);
  });
});
