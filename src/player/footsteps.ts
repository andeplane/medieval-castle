// Procedural WebAudio footsteps (game-audio / audio-design): a short filtered noise burst plus a low
// thump, shaped per surface (stone, wood, grass, dirt). Variation comes from a seeded rng, never
// Math.random. The context starts on the first user gesture, as browsers require.

import { rngFor } from '../core/rng';
import type { Surface } from './controller';

/** The browser's AudioContext, or null where there is none. */
export const browserAudio = (w: { AudioContext?: typeof AudioContext }) => () => (w.AudioContext ? new w.AudioContext() : null);

interface Voice { type: BiquadFilterType; f: number; q: number; decay: number; gain: number; thump: number; thumpGain: number; hp?: number }
const VOICES: Record<Surface, Voice> = {
  stone: { type: 'bandpass', f: 1700, q: 1.1, decay: 0.06, gain: 0.5, thump: 85, thumpGain: 0.35 },
  wood: { type: 'bandpass', f: 520, q: 2.6, decay: 0.11, gain: 0.6, thump: 125, thumpGain: 0.45 },
  grass: { type: 'lowpass', f: 6500, q: 0.4, decay: 0.15, gain: 0.16, thump: 70, thumpGain: 0.12, hp: 1800 },
  dirt: { type: 'bandpass', f: 950, q: 0.7, decay: 0.1, gain: 0.32, thump: 75, thumpGain: 0.22 },
};

export class Footsteps {
  enabled = true;
  volume = 0.5;
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private r = rngFor('footsteps');

  /** `makeContext` creates the AudioContext (injected: the browser's, or a fake in tests). */
  constructor(private makeContext: () => AudioContext | null) {}

  /** Call from a user gesture (pointer lock click, key press). */
  unlock() {
    if (this.ctx) { void this.ctx.resume(); return; }
    this.ctx = this.makeContext();
    if (!this.ctx) return;
    const n = Math.floor(this.ctx.sampleRate * 0.3), buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate), d = buf.getChannelData(0);
    const r = rngFor('footstep-noise');
    for (let i = 0; i < n; i++) d[i] = r() * 2 - 1;
    this.noise = buf;
  }

  play(s: Surface, running: boolean, strength = 1) {
    const ctx = this.ctx;
    if (!this.enabled || !ctx || !this.noise || ctx.state !== 'running') return;
    const v = VOICES[s], r = this.r, t = ctx.currentTime + 0.005;
    const pitch = 0.9 + r() * 0.2, g = this.volume * v.gain * strength * (running ? 1.25 : 1) * (0.85 + r() * 0.3);
    const decay = v.decay * (running ? 0.85 : 1) * (0.9 + r() * 0.2);
    const out = ctx.createGain(); out.gain.value = 1; out.connect(ctx.destination);

    const src = ctx.createBufferSource(); src.buffer = this.noise; src.playbackRate.value = pitch;
    const f = ctx.createBiquadFilter(); f.type = v.type; f.frequency.value = v.f * pitch; f.Q.value = v.q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(g, t + (s === 'grass' ? 0.012 : 0.003));
    env.gain.exponentialRampToValueAtTime(0.0008, t + decay);
    let node: AudioNode = src;
    if (v.hp) { const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = v.hp; node.connect(hp); node = hp; }
    node.connect(f); f.connect(env); env.connect(out);
    src.start(t, r() * 0.15, decay + 0.05);

    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(v.thump * pitch * 1.6, t); o.frequency.exponentialRampToValueAtTime(v.thump * pitch, t + 0.04);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t); og.gain.linearRampToValueAtTime(this.volume * v.thumpGain * strength, t + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0006, t + 0.07 + decay * 0.4);
    o.connect(og); og.connect(out);
    o.start(t); o.stop(t + 0.2);
    o.onended = () => out.disconnect();
  }
}
