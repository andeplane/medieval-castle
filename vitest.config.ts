import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Modules that are covered so far. Browser entry points (page boot, UI) are checked by captures instead.
      include: ['src/props/**/*.ts'],
      exclude: ['src/props/preview.ts'],
      thresholds: { lines: 95, functions: 95, branches: 90, statements: 95 },
    },
  },
});
