// Simple, fast stand-ins for the injected noise and rng (src/world/deps.ts).
import type { GenDeps } from '../src/world/deps';

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0) % 2147483646 + 1; };

/** Park–Miller rng per name; smooth sine "noise" in [-1, 1] that differs a little per name. */
export function fakeDeps(amp = 0.6): GenDeps {
  return {
    rng: (name) => { let s = hash(name); return () => (s = (s * 16807) % 2147483647) / 2147483647; },
    noise2: (name) => { const p = (hash(name) % 1000) / 160; return (x, y) => amp * Math.sin(x * 1.7 + y * 0.9 + p); },
    noise3: (name) => { const p = (hash(name) % 1000) / 160; return (x, y, z) => amp * Math.sin(x * 1.3 + y * 2.1 + z * 0.7 + p); },
  };
}

/** Constant noise: every noise source returns `v` everywhere. */
export function flatDeps(v = 0): GenDeps {
  const base = fakeDeps();
  return { rng: base.rng, noise2: () => () => v, noise3: () => () => v };
}
