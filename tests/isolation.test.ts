// The node test files share their imported modules within a worker (vitest.config.ts: the `node` project runs
// with isolate: false, for wall time; the DOM files keep a fresh module graph each). That is safe only while no
// module keeps state one test file could leave behind for the next. This checks it, over every source file:
// - src and the shared test helpers: every module-level `let`/`var`, Map, Set or array is listed below with why
//   sharing it is safe (a memo of a pure function, a one-time init, a constant table nobody writes); a new one
//   fails here until it is listed or made a parameter (AGENTS.md: dependency injection, no hidden globals);
// - the constant tables are never written (no .add/.delete/.clear/.set on them, no push into the arrays);
// - no node test mocks a module, stubs a global or the environment, fakes timers or writes to globalThis;
// - the files that need a DOM (`@vitest-environment`) are exactly the `dom` project's.
import { describe, it, expect } from 'vitest';
import { DOM_TESTS } from './dom-files';

// every source file's text, by its path from the repository root (Vite's glob, read as raw text)
const files = Object.fromEntries(Object.entries({
  ...import.meta.glob<string>('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob<string>('./**/*.ts', { query: '?raw', import: 'default', eager: true }),
}).map(([p, t]) => [p.replace(/^\.\.\//, '').replace(/^\.\//, 'tests/'), t]));
const SRC = Object.keys(files).filter((f) => f.startsWith('src/')), TESTS = Object.keys(files).filter((f) => f.startsWith('tests/'));
const text = (f: string) => files[f];

/** Module-level state that may be shared between test files, and why. */
const SHARED: Record<string, string> = {
  'src/world/terrain.ts DEFAULT': 'the default terrain, made on first use from WORLD_SEED: the same for every file',
  'src/physics/world.ts wasmReady': "rapier's one-time wasm init",
  'src/render/texpool.ts onTextureProgress': 'the loading screen\'s listener, set only by the page (setTextureProgress); no test sets it',
  'src/render/materials.ts waterNormalData': 'the water normal map, written from the generated textures (a pure function of the seed)',
  'src/main.ts screen': 'the page entry; no test imports it',
  'src/castle/interior/caveGeom.ts cache': 'cave rock by the plan\'s content and seed: a memo of a pure function',
  'src/castle/stones/layout.ts specs': 'the masonry spec per stone material: a memo of a pure function',
  // constant tables: written by no one (checked below)
  'src/ui/help.ts NAMED': 'constant', 'src/render/interiorFire.ts TORCH_ROOMS': 'constant', 'src/render/interiorMath.ts OUTSIDE': 'constant',
  'src/castle/interior/caveGeom.ts FUNGI_ROOMS': 'constant', 'src/castle/interior/caveGeom.ts STONE_ROOMS': 'constant',
  'src/castle/interior/plan.ts SWING_OUT': 'constant', 'src/player/setup.ts LOCKED_DOORS': 'constant', 'src/player/input.ts GAME_KEYS': 'constant',
  'src/props/dress.ts TONED': 'constant',
  'tests/helpers/worldViews.ts OUTDOOR': 'constant',
};
// module level: a declaration at column 0 binding something that can change (WeakMaps and WeakSets are keyed by
// object identity, so a file only ever finds its own objects in them; they are not listed)
const STATE = /^(?:export )?(?:(?:let|var) +(\w+)|const +(\w+)(?: *:[^=]+)? *= *(?:new (?:Map|Set)\b|\[\]))/;
const stateOf = (f: string) => text(f).split('\n').flatMap((l) => { const m = STATE.exec(l); return m ? [`${f} ${m[1] ?? m[2]}`] : []; });

describe('test files can share their modules (isolate: false)', () => {
  it('keeps no module-level state in src or the test helpers that is not listed as safe to share', () => {
    expect(SRC.length).toBeGreaterThan(120); // every source file was read
    const found = [...SRC, ...TESTS.filter((f) => !f.endsWith('.test.ts'))].flatMap(stateOf);
    expect(found.filter((k) => !(k in SHARED))).toEqual([]);
    expect(Object.keys(SHARED).filter((k) => !found.includes(k))).toEqual([]); // no stale entries
    // what it is for: a module-level cache is found
    expect(stateOf('tests/helpers/rays.ts')).toEqual([]);
    expect(STATE.exec('let hits = 0;')?.[1]).toBe('hits');
    expect(STATE.exec('export const seen: Map<string, number> = new Map();')?.[2]).toBe('seen');
  });

  it('never writes to a constant table', () => {
    const tables = Object.entries(SHARED).filter(([, why]) => why === 'constant').map(([k]) => k.split(' ')[1]);
    const writes = [...SRC, ...TESTS].flatMap((f) => text(f).split('\n').filter((l) => tables.some((t) => new RegExp(`\\b${t}\\.(add|delete|clear|set|push|splice)\\(`).test(l))).map((l) => `${f}: ${l.trim()}`));
    expect(writes).toEqual([]);
  });

  it('mocks no module, stubs no global and fakes no timer in the node test files', () => {
    const node = TESTS.filter((f) => !DOM_TESTS.includes(f));
    const bad = node.flatMap((f) => text(f).split('\n').filter((l) => /\bvi\.(mock|doMock|unmock|stubGlobal|stubEnv|useFakeTimers|resetModules)\(|globalThis\.\w+ *=[^=]|process\.env\.\w+ *=[^=]/.test(l)).map((l) => `${f}: ${l.trim()}`))
      .filter((l) => !l.startsWith('tests/isolation.test.ts'));
    expect(bad).toEqual([]);
  });

  it('runs every file that needs a DOM in the isolated dom project', () => {
    const dom = TESTS.filter((f) => f.endsWith('.test.ts') && /^\/\/ @vitest-environment /m.test(text(f)));
    expect(dom.sort()).toEqual([...DOM_TESTS].sort());
  });
});
