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
      include: ['src/loading/**/*.ts', 'src/props/**/*.ts', 'src/world/{terrain,fields,rocks,relief,deps}.ts', 'src/castle/interior/{stairs,stairprobe}.ts', 'src/castle/interior/{doors,doorGeom,doorParts,doorBatch}.ts', 'src/game/{interact,doorAudio}.ts',
        'src/render/{interiorMath,interiorLight,exposure}.ts', 'src/world/visibility.ts', 'src/debug/roomtest.ts'],
      exclude: ['src/loading/entry.ts', 'src/props/preview.ts'],
      thresholds: {
        'src/loading/**': { lines: 100, functions: 100, branches: 95, statements: 100 },
        'src/props/**': { lines: 99, functions: 100, branches: 95, statements: 99 },
        // interior light + visibility; the TSL shader (render/interiorShader.ts) is checked by ?test=room captures
        'src/render/{interiorMath,interiorLight,exposure}.ts': { lines: 100, functions: 100, branches: 95, statements: 99 },
        'src/world/visibility.ts': { lines: 100, functions: 100, branches: 95, statements: 99 },
        // measured 99.8 / 100 / 89.6 / 98.0
        'src/castle/interior/{stairs,stairprobe}.ts': { lines: 99, functions: 100, branches: 88, statements: 97 },
        // measured: doorParts 98.3 / 94 / 100 / 99.2, doors 100 / 95.4 / 100 / 100, doorGeom + doorBatch 100
        'src/castle/interior/{doors,doorGeom,doorParts,doorBatch}.ts': { lines: 99, functions: 100, branches: 94, statements: 98 },
        // measured: interact 98.9 / 90.6 / 94.4 / 98.2, doorAudio 99.4 / 96.7 / 93.3 / 100
        'src/game/{interact,doorAudio}.ts': { lines: 98, functions: 93, branches: 90, statements: 98 },
      },
    },
  },
});
