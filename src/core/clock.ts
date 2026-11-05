// Time source, injected so physics timing and tests never read a global clock directly.
export interface Clock { now(): number }
export const systemClock: Clock = { now: () => performance.now() };
