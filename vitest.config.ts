import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // modules with tests; add each new module here as it gets tests (target: ~100 %)
      include: ['src/loading/**/*.ts'],
      exclude: ['src/loading/entry.ts'],
      thresholds: { 'src/loading/**': { lines: 100, functions: 100, branches: 95, statements: 100 } },
    },
  },
});
