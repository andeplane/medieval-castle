import { defineConfig, configDefaults } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { DOM_TESTS } from './tests/dom-files.ts';

// Seconds per file under coverage on one CI runner (EPYC 9V45, the whole suite on 4 workers; world and
// world-views split from one 63 s file), only to order and split the run: the longest files start first, so
// none is left running alone at the end, and CI's two shards (--shard=1/2, 2/2) get about the same work. A file
// not listed counts 0.5 s; a stale entry only unbalances the shards, it never drops or repeats a file.
const SECONDS: Record<string, number> = {
  world: 36, 'world-views': 43, interior: 33, doorswing: 27, 'props-stream': 17.5, stairwalk: 15.3, island: 15.2,
  'props-zfight': 13.7, hearthStone: 10, 'props-dress': 13.6, sunLeak: 13.1, 'stones-offthread': 12.5, openings: 11.4, keypaths: 11.1,
  doors: 10.6, groundInRooms: 10.5, 'props-kit': 10.3, 'light/roomLight': 9.7, caves: 8.6, interiorLightShell: 7.6,
  texgen: 6.5, torches: 6.4, paving: 5.5, stairs: 3.9, terrain: 3.1, 'props-render': 2.8, doorLight: 2.7,
  'castle-stones': 2.3, vegetation: 2.2, rays: 2.1, batter: 1.3, 'props-place': 1.1,
};
const seconds = (f: TestSpecification) => SECONDS[f.moduleId.replace(/^.*\/tests\//, '').replace(/\.test\.ts$/, '')] ?? 0.5;
class LongestFirst extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    return (await super.sort(files)).map((f, i) => ({ f, i })).sort((a, b) => seconds(b.f) - seconds(a.f) || a.i - b.i).map(({ f }) => f);
  }
  /** Longest first, each file to the shard with the least work so far (vitest's own split is by path hash). */
  async shard(files: TestSpecification[]) {
    const { index, count } = this.ctx.config.shard!, load: number[] = new Array(count).fill(0), mine: TestSpecification[] = [];
    for (const f of [...files].sort((a, b) => seconds(b) - seconds(a) || (a.moduleId < b.moduleId ? -1 : 1))) {
      const k = load.indexOf(Math.min(...load));
      load[k] += seconds(f);
      if (k === index - 1) mine.push(f);
    }
    return mine;
  }
}
// A shard holds half the suite, so half the coverage: the thresholds are checked on the merged report
// (vitest --merge-reports --coverage), never per shard.
const SHARD = process.argv.some((a) => a.startsWith('--shard'));

export default defineConfig({
  test: {
    // generation tests build real terrain and vegetation; give them room on a loaded machine
    testTimeout: 30000,
    // worker threads on all four cores of the CI runner, longest files first (vitest's default is forks on
    // three): about 5 % faster on the same runner (141-144 s against 149 s under coverage)
    pool: 'threads',
    maxWorkers: '100%',
    sequence: { sequencer: LongestFirst },
    // The node files share the modules they import within a worker (isolate: false: about 18 % less time on the
    // same runner, 84 s against 100-107 s, mostly imports and the generators' memos not made again per file).
    // Safe while no module keeps state one file can leave for the next: tests/isolation.test.ts checks every
    // module-level variable, Map, Set and array in src and the test helpers, and that no node test mocks, stubs
    // or fakes timers. The DOM files (happy-dom) keep their own module graph.
    projects: [
      { extends: true, test: { name: 'node', include: ['tests/**/*.test.ts'], exclude: [...configDefaults.exclude, ...DOM_TESTS], isolate: false } },
      { extends: true, test: { name: 'dom', include: DOM_TESTS } },
    ],
    coverage: {
      provider: 'v8',
      // modules with tests; add each new module here as it gets tests (target: ~100 %).
      // Browser entry points (page boot, UI) are checked by captures instead.
      include: ['src/loading/**/*.ts', 'src/props/**/*.ts', 'src/light/**/*.ts', 'src/world/{terrain,fields,rocks,relief,deps}.ts', 'src/castle/{builder,castle,layout,spec,openings,paving}.ts', 'src/castle/{bridge,revetment,turf,rubble}.ts', 'src/castle/stones/**/*.ts', 'src/castle/interior/*.ts', 'src/camera/interiorViews.ts', 'src/castle/interior/{doors,doorGeom,doorParts,doorBatch,portcullis}.ts', 'src/game/{interact,doorAudio}.ts', 'src/ui/**/*.ts', 'src/render/texgen.ts',
        'src/physics/**/*.ts', 'src/character/**/*.ts', 'src/player/**/*.ts', 'src/camera/controls.ts', 'src/debug/{hooks,testcourse}.ts', 'src/core/clock.ts',
        'src/render/{interiorMath,interiorLight,interiorFire,windowGlass,exposure,precompile}.ts', 'src/world/visibility.ts', 'src/world/waterView.ts', 'src/debug/roomtest.ts', 'src/render/perf.ts', 'src/render/resolution.ts', 'src/debug/bench.ts', 'src/render/drawCount.ts'],
      exclude: ['src/loading/entry.ts', 'src/loading/tunnel.worker.ts', 'src/castle/stones/layout.worker.ts', 'src/props/furnish.worker.ts', 'src/props/preview.ts', 'src/light/preview.ts', 'src/castle/interior/types.ts'],
      thresholds: SHARD ? undefined : {
        'src/loading/**': { lines: 100, functions: 100, branches: 95, statements: 100 },
        'src/props/**': { lines: 99, functions: 100, branches: 95, statements: 99 },
        'src/light/**': { lines: 100, functions: 100, branches: 95, statements: 100 },
        // interior light + visibility; the TSL shader (render/interiorShader.ts) is checked by ?test=room captures
        'src/render/{interiorMath,interiorLight,interiorFire,windowGlass,exposure,precompile}.ts': { lines: 100, functions: 100, branches: 95, statements: 99 },
        'src/render/drawCount.ts': { lines: 100, functions: 100, branches: 95, statements: 100 },
        'src/world/{visibility,waterView}.ts': { lines: 100, functions: 100, branches: 95, statements: 99 },
        'src/render/texgen.ts': { lines: 95, functions: 95, branches: 85, statements: 95 },
        // measured 99.8 / 100 / 89.6 / 98.0
        'src/castle/interior/{stairs,stairprobe}.ts': { lines: 99, functions: 100, branches: 88, statements: 97 },
        'src/castle/interior/{plan,shell,nav,geom,carve,tunnel,index,caves,caveGeom,caveOffThread}.ts': { lines: 98, functions: 95, branches: 85, statements: 97 },
        'src/camera/interiorViews.ts': { lines: 100, functions: 90, branches: 90, statements: 95 },
        // measured: doorParts 98.9 / 87.8 / 100 / 100, doors 100 / 95.0 / 100 / 100, portcullis + doorGeom + doorBatch 100
        'src/castle/interior/{doors,doorGeom,doorParts,doorBatch,portcullis}.ts': { lines: 99, functions: 100, branches: 94, statements: 98 },
        // measured: interact 98.9 / 90.6 / 94.4 / 98.2, doorAudio 99.4 / 96.7 / 93.3 / 100
        'src/game/{interact,doorAudio}.ts': { lines: 98, functions: 93, branches: 90, statements: 98 },
        // physics player; measured on 2026-11-05 (see PROGRESS)
        'src/{physics,character,player}/**': { lines: 98, functions: 95, branches: 85, statements: 98 },
        'src/{camera/controls,debug/hooks,debug/testcourse}.ts': { lines: 99, functions: 100, branches: 80, statements: 99 },
        // measured: castle 99.5 / 93.6 / 100 / 99.9 (statements / branches / functions / lines)
        'src/castle/{builder,castle,layout,spec,openings,paving}.ts': { lines: 99, functions: 100, branches: 92, statements: 99 },
        // measured: 99.9 / 99.0 / 100 / 100
        'src/castle/stones/**': { lines: 100, functions: 100, branches: 97, statements: 99 },
        // measured: bridge 99.1 / 98 / 100 / 99.3, revetment 98.8 / 95.5 / 96 / 100, rubble + turf 98-100
        'src/castle/{bridge,revetment,turf,rubble}.ts': { lines: 99, functions: 95, branches: 90, statements: 98 },
        // HUD, tools panel, help and boot error (happy-dom + fakes in tests/ui)
        'src/ui/**': { lines: 100, functions: 100, branches: 95, statements: 100 },
        // frame stats and the benchmark runner
        'src/{render/perf,render/resolution,debug/bench}.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
      },
    },
  },
});
