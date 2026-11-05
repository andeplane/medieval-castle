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
      include: ['src/loading/**/*.ts', 'src/props/**/*.ts', 'src/world/{terrain,fields,rocks,relief,deps}.ts',
        'src/render/{interiorMath,interiorLight,exposure}.ts', 'src/world/visibility.ts', 'src/debug/roomtest.ts'],
      exclude: ['src/loading/entry.ts', 'src/props/preview.ts'],
      thresholds: {
        'src/loading/**': { lines: 100, functions: 100, branches: 95, statements: 100 },
        'src/props/**': { lines: 99, functions: 100, branches: 95, statements: 99 },
        // interior light + visibility; the TSL shader (render/interiorShader.ts) is checked by ?test=room captures
        'src/render/{interiorMath,interiorLight,exposure}.ts': { lines: 100, functions: 100, branches: 95, statements: 99 },
        'src/world/visibility.ts': { lines: 100, functions: 100, branches: 95, statements: 99 },
      },
    },
  },
});
