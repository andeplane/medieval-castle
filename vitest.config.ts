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
      include: ['src/loading/**/*.ts', 'src/props/**/*.ts', 'src/world/{terrain,fields,rocks,relief,deps}.ts', 'src/castle/interior/*.ts', 'src/camera/interiorViews.ts'],
      exclude: ['src/loading/entry.ts', 'src/props/preview.ts', 'src/castle/interior/types.ts'],
      thresholds: {
        'src/loading/**': { lines: 100, functions: 100, branches: 95, statements: 100 },
        'src/props/**': { lines: 99, functions: 100, branches: 95, statements: 99 },
        // measured 99.8 / 100 / 89.6 / 98.0
        'src/castle/interior/{stairs,stairprobe}.ts': { lines: 99, functions: 100, branches: 88, statements: 97 },
        'src/castle/interior/{plan,shell,nav,geom,carve,tunnel,index}.ts': { lines: 98, functions: 95, branches: 85, statements: 97 },
        'src/camera/interiorViews.ts': { lines: 100, functions: 90, branches: 90, statements: 95 },
      },
    },
  },
});
