// Page entry (index.html). Browser wiring only; the logic is in start.ts (tested).
import { createLoadingScreen } from './tunnel';
import { start } from './start';

start({
  search: location.search,
  screen: (opts) => createLoadingScreen(document.getElementById('loading')!, opts),
  bootGame: (screen) => import('../main').then((m) => m.boot(screen)),
  every: (ms, f) => void setInterval(f, ms),
  reload: () => location.reload(),
});
