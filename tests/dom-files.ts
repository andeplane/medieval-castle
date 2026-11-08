/** The test files that run in a DOM (`@vitest-environment happy-dom`): vitest.config.ts gives them their own
 * isolated project; tests/isolation.test.ts checks the list. */
export const DOM_TESTS = [
  'tests/ui/gameHud.test.ts', 'tests/ui/statsOverlay.test.ts', 'tests/ui/tools.test.ts', 'tests/ui/error.test.ts', 'tests/ui/hud.test.ts',
  'tests/loading/tunnel.test.ts',
];
