import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // generation tests build real terrain and vegetation; give them room on a loaded machine
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      // modules with tests; add each new module here as it gets tests (target: ~100 %).
      // Browser entry points (page boot, UI) are checked by captures instead.
      include: ['src/loading/**/*.ts', 'src/props/**/*.ts', 'src/light/**/*.ts', 'src/world/{terrain,fields,rocks,relief,deps}.ts', 'src/castle/{builder,castle,layout,spec,openings,paving}.ts', 'src/castle/{bridge,revetment,turf,rubble}.ts', 'src/castle/stones/**/*.ts', 'src/castle/interior/*.ts', 'src/camera/interiorViews.ts', 'src/castle/interior/{doors,doorGeom,doorParts,doorBatch,portcullis}.ts', 'src/game/{interact,doorAudio}.ts', 'src/ui/**/*.ts', 'src/render/texgen.ts',
        'src/physics/**/*.ts', 'src/character/**/*.ts', 'src/player/**/*.ts', 'src/camera/controls.ts', 'src/debug/{hooks,testcourse}.ts', 'src/core/clock.ts',
        'src/render/{interiorMath,interiorLight,interiorFire,windowGlass,exposure}.ts', 'src/world/visibility.ts', 'src/debug/roomtest.ts', 'src/render/perf.ts', 'src/render/resolution.ts', 'src/debug/bench.ts'],
      exclude: ['src/loading/entry.ts', 'src/loading/tunnel.worker.ts', 'src/props/furnish.worker.ts', 'src/props/preview.ts', 'src/light/preview.ts', 'src/castle/interior/types.ts'],
      thresholds: {
        'src/loading/**': { lines: 100, functions: 100, branches: 95, statements: 100 },
        'src/props/**': { lines: 99, functions: 100, branches: 95, statements: 99 },
        'src/light/**': { lines: 100, functions: 100, branches: 95, statements: 100 },
        // interior light + visibility; the TSL shader (render/interiorShader.ts) is checked by ?test=room captures
        'src/render/{interiorMath,interiorLight,interiorFire,windowGlass,exposure}.ts': { lines: 100, functions: 100, branches: 95, statements: 99 },
        'src/world/visibility.ts': { lines: 100, functions: 100, branches: 95, statements: 99 },
        'src/render/texgen.ts': { lines: 95, functions: 95, branches: 85, statements: 95 },
        // measured 99.8 / 100 / 89.6 / 98.0
        'src/castle/interior/{stairs,stairprobe}.ts': { lines: 99, functions: 100, branches: 88, statements: 97 },
        'src/castle/interior/{plan,shell,nav,geom,carve,tunnel,index}.ts': { lines: 98, functions: 95, branches: 85, statements: 97 },
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
