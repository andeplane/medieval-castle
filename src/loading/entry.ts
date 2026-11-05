// Page entry (index.html). Browser wiring only; the logic is in start.ts (tested).
import { loadingScreen } from './tunnel';
import { start } from './start';

start({
  search: location.search,
  screen: () => loadingScreen(),
  bootGame: () => import('../main'),
  every: (ms, f) => void setInterval(f, ms),
  reload: () => location.reload(),
});
