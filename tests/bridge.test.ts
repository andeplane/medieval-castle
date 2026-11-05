// The ruined bridge: layout, the walkable island half, the gap that keeps the far bank out of reach, the
// rubble heap and the triangle budget.
import { describe, it, expect } from 'vitest';
import { ISLAND, MOAT_OUTER, heightAt, islandWalkable } from '../src/world/terrain';
import { gatehouseFrame } from '../src/castle/layout';
import { BRIDGE, BREAK_PTS, archPt, bridgePlan, buildBridge, withBridge, makeArch, outlineNormal, planRubble, countTris, type BridgeInput } from '../src/castle/bridge';
import { Builder } from '../src/castle/builder';
import { mulberry32, rngFor } from '../src/core/rng';
import { pointInPoly, type V2 } from '../src/core/math2d';

const input = (rng = rngFor('bridge')): BridgeInput => ({ island: ISLAND, moatOuter: MOAT_OUTER, gate: gatehouseFrame(), groundAt: heightAt, rng });
const plan = bridgePlan(input());
const hw = BRIDGE.width / 2;

describe('arch geometry', () => {
  it('springs at both ends and peaks at the rise', () => {
    const A = makeArch(2, 8, 1.5, true);
    const [ta, ya] = archPt(A, 0, A.R), [tb, yb] = archPt(A, 1, A.R), [tc, yc] = archPt(A, 0.5, A.R);
    expect(ta).toBeCloseTo(2, 6); expect(ya).toBeCloseTo(BRIDGE.spring, 6);
    expect(tb).toBeCloseTo(8, 6); expect(yb).toBeCloseTo(BRIDGE.spring, 6);
    expect(tc).toBeCloseTo(5, 6); expect(yc).toBeCloseTo(BRIDGE.spring + 1.5, 6);
    expect(A.n % 2).toBe(1); // a keystone in the middle
  });
  it('finds the outline normal', () => {
    const sq: V2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const n = outlineNormal(sq, [5, 0.1]);
    expect(Math.abs(n[1])).toBeCloseTo(1, 6);
    expect(Math.hypot(...outlineNormal(ISLAND, plan.O))).toBeCloseTo(1, 6);
  });
});

describe('bridge plan', () => {
  it('is a pure function of the rng', () => {
    const again = bridgePlan(input());
    expect(again.arches).toEqual(plan.arches);
    expect(again.rubble.map((s) => s.corners)).toEqual(plan.rubble.map((s) => s.corners));
    expect(again.halves[0].brk).toEqual(plan.halves[0].brk);
    const other = bridgePlan(input(mulberry32(42)));
    expect(other.rubble.map((s) => s.corners)).not.toEqual(plan.rubble.map((s) => s.corners));
  });

  it('crosses the moat on two piers with three arches, the middle one fallen', () => {
    expect(plan.arches.map((a) => a.intact)).toEqual([true, false, true]);
    expect(plan.arches[1].b - plan.arches[1].a).toBeGreaterThan(plan.arches[0].b - plan.arches[0].a);
    for (const [a, b] of plan.piers) { expect(b - a).toBeCloseTo(BRIDGE.pier, 6); expect(a).toBeGreaterThan(0); expect(b).toBeLessThan(plan.M); }
    expect(plan.tA).toBeGreaterThan(0.75); // the abutment reaches past the revetment face
    for (const A of plan.arches) { expect(A.rise).toBeGreaterThan(0.18 * (A.b - A.a)); expect(A.rise).toBeLessThan(0.47 * (A.b - A.a)); }
  });

  it('keeps the deck above the intact arches', () => {
    for (const A of plan.arches.filter((a) => a.intact)) for (let u = 0; u <= 1; u += 0.05) {
      const [t, y] = archPt(A, u, A.R + BRIDGE.ring + 0.1);
      expect(plan.deck(t) - y).toBeGreaterThan(0.1);
    }
  });

  it('joins the ground in front of the gatehouse without a step', () => {
    for (let t = plan.tStart; t < -1; t += 0.25) for (const s of [-hw, 0, hw]) {
      const p = plan.P(t, s), g = heightAt(p[0], p[1]);
      expect(plan.deck(t) - g).toBeGreaterThan(-0.01);
      expect(plan.deck(t) - g).toBeLessThan(0.16);
    }
    for (let t = plan.tStart; t < plan.tEnd; t += 0.1) expect(Math.abs(plan.deck(t + 0.1) - plan.deck(t))).toBeLessThan(0.03);
    // the far end comes down onto the outer bank
    const far = [-hw, 0, hw].map((s) => { const p = plan.P(plan.tEnd, s); return heightAt(p[0], p[1]); });
    expect(plan.deck(plan.tEnd)).toBeGreaterThan(Math.max(...far) - 0.05);
    expect(plan.deck(plan.tEnd)).toBeLessThan(Math.max(...far) + 0.2);
  });

  it('has a closed walkable deck from the island up to the broken edge', () => {
    const [edge] = plan.gap;
    expect(plan.walkable.length).toBe(4);
    for (let t = plan.tStart + 0.1; t < edge - 1.2; t += 0.3) for (const s of [-1.5, 0, 1.5]) {
      const p = plan.P(t, s);
      expect(pointInPoly(plan.walkable, p[0], p[1])).toBe(true);
      expect(plan.deckHeightAt(p[0], p[1])).toBeCloseTo(plan.deck(t), 6);
    }
    const beyond = plan.P(edge + 0.2, 0);
    expect(plan.deckHeightAt(beyond[0], beyond[1])).toBeNull();
    const parapet = plan.P(0, hw - 0.1);
    expect(plan.deckHeightAt(parapet[0], parapet[1])).toBeNull();
  });

  it('leaves the far bank out of reach', () => {
    const [a, b] = plan.gap;
    expect(b - a).toBeGreaterThanOrEqual(BRIDGE.minGap - 1e-6);
    // the broken ring stubs leave an even wider gap lower down
    const ring = (h: (typeof plan.halves)[number]) => Math.max(...h.slices.map((sl, j) => archPt(h.stub, sl.bounds[h.brk.left[j]], h.stub.R + BRIDGE.ring + 0.1)[0]));
    expect(-ring(plan.halves[1]) - ring(plan.halves[0])).toBeGreaterThan(2.5);
    // nothing in the water stands high enough to climb from
    for (const s of plan.rubble) expect(Math.max(...s.corners.map((c) => c[1]))).toBeLessThanOrEqual(BRIDGE.rubbleTop + 1e-9);
    expect(plan.deck(a) - BRIDGE.rubbleTop).toBeGreaterThan(1.5);
    // but some of it breaks the surface
    expect(plan.rubble.filter((s) => Math.max(...s.corners.map((c) => c[1])) > 0.1).length).toBeGreaterThanOrEqual(6);
  });

  it('breaks raggedly: the ring, the core and the parapets all end at different places', () => {
    for (const h of plan.halves) {
      expect(new Set(h.brk.left).size + new Set(h.brk.cols.map((c) => c.pts[c.pts.length - 1][0].toFixed(2))).size).toBeGreaterThan(3);
      expect(h.brk.parapet[0][2][0]).not.toBeCloseTo(h.brk.parapet[1][2][0], 2);
      for (const [k, side] of h.brk.side.entries()) {
        // the parapet stops before the deck does, and the coping before the parapet
        expect(h.brk.parapet[k][2][0]).toBeLessThan(side[side.length - 1][0]);
        expect(h.brk.copingEnd[k]).toBeLessThan(h.brk.parapet[k][2][0]);
        // the break climbs from the ring to the deck in steps: never down, and level runs between rises
        for (let i = 1; i < side.length; i++) expect(side[i][1]).toBeGreaterThanOrEqual(side[i - 1][1] - 1e-9);
        expect(side.length).toBe(BREAK_PTS);
        expect(side.filter((p, i) => i > 0 && Math.abs(p[1] - side[i - 1][1]) < 1e-9).length).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe('rubble', () => {
  it('is a heap of varied, tilted, half-sunk stones under the gap', () => {
    const R = plan.rubble;
    expect(R.length).toBeGreaterThan(30);
    expect(new Set(R.map((s) => s.kind)).size).toBe(5);
    expect(R.filter((s) => s.size > 1.2).length).toBeGreaterThanOrEqual(2);
    expect(R.filter((s) => s.size < 0.7).length).toBeGreaterThanOrEqual(10);
    const A = plan.arches[1];
    let tilted = 0, wet = 0;
    for (const s of R) {
      const ys = s.corners.map((c) => c[1]);
      if (Math.min(...ys) < 0) wet++;
      // tilted: the bottom face is not level
      if (Math.abs(s.corners[0][1] - s.corners[5][1]) > 0.05) tilted++;
      const c = s.corners.reduce((p, q) => [p[0] + q[0] / 8, 0, p[2] + q[2] / 8], [0, 0, 0]);
      const t = (c[0] - plan.O[0]) * plan.d[0] + (c[2] - plan.O[1]) * plan.d[1];
      expect(t).toBeGreaterThan(A.a - 3); expect(t).toBeLessThan(A.b + 3);
      expect(s.chips.every((x) => x > 0)).toBe(true);
    }
    expect(wet).toBe(R.length);
    expect(tilted).toBeGreaterThan(R.length * 0.7);
  });
  it('follows its own rng', () => {
    const A = plan.arches[1];
    expect(planRubble(mulberry32(1), A, plan.P, BRIDGE.width)).toEqual(planRubble(mulberry32(1), A, plan.P, BRIDGE.width));
  });
});

describe('bridge geometry', () => {
  const B = new Builder();
  const tris = buildBridge(B, plan, rngFor('bridge-stones'));
  it('stays inside the triangle budget', () => {
    expect(tris).toBeGreaterThan(4000);
    expect(tris).toBeLessThan(25000);
    expect(countTris(B)).toBe(tris);
  });
  it('emits clean triangles in the stone bins only', () => {
    for (const k of ['new', 'slate', 'lead', 'wood', 'iron', 'void', 'glass'] as const) expect(B.bins[k].pos.length).toBe(0);
    for (const k of ['old', 'trim'] as const) {
      const { pos, nor, uv } = B.bins[k];
      expect(pos.every(Number.isFinite) && uv.every(Number.isFinite)).toBe(true);
      for (let i = 0; i < nor.length; i += 3) expect(Math.hypot(nor[i], nor[i + 1], nor[i + 2])).toBeCloseTo(1, 4);
    }
  });
  it('builds a walkable deck surface along the island half', () => {
    // an upward-facing triangle lies under every point of the walkable strip
    const { pos, nor } = B.bins.old;
    const ups: number[] = [];
    for (let i = 0; i < pos.length; i += 9) if (nor[i + 1] > 0.95) ups.push(i);
    const covered = (x: number, z: number, y: number) => ups.some((i) => {
      const a = [pos[i], pos[i + 2]], b = [pos[i + 3], pos[i + 5]], c = [pos[i + 6], pos[i + 8]];
      const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (z - c[1])) / d, l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (z - c[1])) / d, l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) return false;
      return Math.abs(l1 * pos[i + 1] + l2 * pos[i + 4] + l3 * pos[i + 7] - y) < 0.06;
    });
    for (let t = plan.tStart + 0.2; t < plan.gap[0] - 1.2; t += 0.7) for (const s of [-1.6, -0.85, 0, 0.85, 1.6]) {
      const p = plan.P(t, s);
      expect(covered(p[0], p[1], plan.deck(t))).toBe(true);
    }
  });
});

// Key path: the gate lawn → onto the bridge → its broken edge, with the same canWalk/groundAt composition
// main.ts gives the walk-mode rig (CameraRig itself needs a DOM, so its step rule is replayed here).
describe('walking the bridge', () => {
  const walk = withBridge(plan, islandWalkable, heightAt);
  const step = (p: V2, dir: V2, len: number): V2 | null => {
    // the rig's rule: try the full step, then each axis
    for (const s of [[dir[0] * len, dir[1] * len], [dir[0] * len, 0], [0, dir[1] * len]] as V2[]) {
      if (walk.canWalk(p[0] + s[0], p[1] + s[1])) return [p[0] + s[0], p[1] + s[1]];
    }
    return null;
  };
  const along = (p: V2) => (p[0] - plan.O[0]) * plan.d[0] + (p[1] - plan.O[1]) * plan.d[1];

  it('walks from the lawn by the gate onto the deck and up to the broken edge, with no step on the way', () => {
    let p = plan.P(plan.tStart - 2, 0);
    expect(walk.canWalk(p[0], p[1])).toBe(true);
    let y = walk.groundAt(p[0], p[1]), maxRise = 0, onDeck = false;
    for (let k = 0; k < 400; k++) {
      const q = step(p, plan.d, 0.07); // 4.2 m/s at 60 fps
      if (!q) break;
      const y1 = walk.groundAt(q[0], q[1]);
      maxRise = Math.max(maxRise, Math.abs(y1 - y));
      onDeck ||= plan.deckHeightAt(q[0], q[1]) !== null && !islandWalkable(q[0], q[1]);
      p = q; y = y1;
    }
    expect(onDeck).toBe(true);
    expect(maxRise).toBeLessThan(0.12);
    // stopped on the deck, just short of the edge, high above the water
    const [edge] = plan.gap;
    expect(along(p)).toBeGreaterThan(edge - BRIDGE.edgeMargin - 1.0);
    expect(along(p)).toBeLessThan(edge);
    expect(y).toBeCloseTo(plan.deck(along(p)), 6);
    expect(y).toBeGreaterThan(2);
  });

  it('cannot step off the deck: not over the parapets, the gap or anywhere on the far half', () => {
    for (let t = plan.tA; t < plan.gap[0] - 1; t += 0.5) {
      for (const s of [-1, 1]) {
        const a = plan.P(t, s * (hw - BRIDGE.parapet + 0.05)), b = plan.P(t, s * (hw + 0.5));
        expect(walk.canWalk(a[0], a[1])).toBe(false);
        expect(walk.canWalk(b[0], b[1])).toBe(false);
      }
    }
    for (let t = plan.gap[0] - BRIDGE.edgeMargin + 0.01; t < plan.tEnd + 3; t += 0.25) for (const s of [-1.5, 0, 1.5]) {
      const p = plan.P(t, s);
      expect(walk.canWalk(p[0], p[1])).toBe(false);
    }
  });
});
