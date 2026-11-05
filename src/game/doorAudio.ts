// Procedural door sounds (game-audio): no files, all WebAudio. Creak = a bowed, stick-slip squeal
// through a resonant band; latch = two clicks and a ping; thud = a falling low sine and a dull burst;
// clank = inharmonic iron partials (portcullis ratchet); chain = a rattle of short metal ticks.
// Positional by distance from the camera with a stereo pan. The AudioContext starts on the first
// gesture. Every sound is also logged (`log`), so agents can check what played.
import type * as THREE from 'three/webgpu';
import type { V3 } from '../castle/interior/types';
import type { DoorSound } from '../castle/interior/doors';
import { rngFor } from '../core/rng';

export interface DoorAudioDeps {
  /** Makes the AudioContext on the first gesture (default: new AudioContext). */
  createContext?: () => AudioContext;
  /** Where gestures come from (default: window). */
  gestures?: Pick<EventTarget, 'addEventListener'>;
  /** Clock for the log (default: performance.now). */
  now?: () => number;
}

export class DoorAudio {
  ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private r = rngFor('door-audio');
  readonly log: { t: number; name: string; gain: number }[] = [];
  volume = 0.9;

  private now: () => number;
  constructor(private camera: THREE.Camera, deps: DoorAudioDeps = {}) {
    const make = deps.createContext ?? (() => new AudioContext({ latencyHint: 'interactive' }));
    this.now = deps.now ?? (() => performance.now());
    const start = () => {
      if (!this.ctx) {
        try { this.init(make()); } catch { return; }
      }
      if (this.ctx!.state !== 'running') void this.ctx!.resume();
    };
    const target = deps.gestures ?? globalThis;
    for (const ev of ['pointerdown', 'keydown', 'touchend']) target.addEventListener(ev, start, { capture: true });
  }

  private init(ctx: AudioContext) {
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -8; comp.ratio.value = 4;
    this.out = ctx.createGain(); this.out.gain.value = this.volume;
    this.out.connect(comp).connect(ctx.destination);
    const n = ctx.sampleRate * 2, buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    const r = rngFor('door-audio-noise');
    for (let i = 0; i < n; i++) d[i] = r() * 2 - 1;
    this.noise = buf;
  }

  /** Play a door sound at a world position. weight ~1 for a door, ~2 for the gate. */
  play(name: DoorSound, pos: V3, weight = 1) {
    const cam = this.camera.position;
    const dx = pos[0] - cam.x, dy = pos[1] - cam.y, dz = pos[2] - cam.z, d = Math.hypot(dx, dy, dz);
    const gain = Math.min(1, 3.5 / (3.5 + d)) * Math.min(1.6, 0.55 + weight * 0.35);
    this.log.push({ t: Math.round(this.now()), name, gain: Math.round(gain * 100) / 100 });
    if (this.log.length > 40) this.log.shift();
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.out || gain < 0.02) return;
    // pan from the camera's right vector
    const e = this.camera.matrixWorld.elements, rx = e[0], rz = e[2];
    const pan = d > 0.1 ? Math.max(-1, Math.min(1, (dx * rx + dz * rz) / d)) * 0.8 : 0;
    const bus = ctx.createGain(); bus.gain.value = gain;
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    // distance darkens the sound
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9000 / (1 + d * 0.12);
    bus.connect(lp).connect(p).connect(this.out);
    const t = ctx.currentTime + 0.005, v = 0.9 + this.r() * 0.2;
    if (name === 'creak') this.creak(bus, t, weight, v);
    else if (name === 'latch') this.latch(bus, t, v);
    else if (name === 'thud' || name === 'bump') this.thud(bus, t, name === 'bump' ? weight * 0.35 : weight, v);
    else if (name === 'clank') this.clank(bus, t, weight, v);
    else this.chain(bus, t, v);
  }

  private env(g: GainNode, t: number, a: number, peak: number, dur: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  private noiseSrc(t: number, dur: number) {
    const s = this.ctx!.createBufferSource(); s.buffer = this.noise; s.loop = true;
    s.start(t, this.r() * 1.5); s.stop(t + dur + 0.05);
    return s;
  }

  private creak(out: AudioNode, t: number, w: number, v: number) {
    const ctx = this.ctx!, heavy = w > 1.5, dur = (heavy ? 2.4 : 0.9) * (0.8 + this.r() * 0.5);
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    const f0 = (heavy ? 95 : 230) * v;
    o.frequency.setValueAtTime(f0, t);
    // the squeal wanders as the hinge binds and frees
    for (let k = 1; k <= 6; k++) o.frequency.linearRampToValueAtTime(f0 * (0.75 + this.r() * 0.7), t + (dur * k) / 6);
    // stick-slip: amplitude pulsed at a rate that drifts
    const am = ctx.createGain(); am.gain.value = 0;
    const lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.setValueAtTime((heavy ? 11 : 24) * v, t);
    lfo.frequency.linearRampToValueAtTime((heavy ? 7 : 15) * v, t + dur);
    const lg = ctx.createGain(); lg.gain.value = 0.5;
    lfo.connect(lg).connect(am.gain);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = heavy ? 620 : 1350 * v; bp.Q.value = 6;
    const bp2 = ctx.createBiquadFilter(); bp2.type = 'peaking'; bp2.frequency.value = heavy ? 260 : 2400; bp2.gain.value = 8; bp2.Q.value = 3;
    const g = ctx.createGain(); this.env(g, t, 0.08, heavy ? 0.5 : 0.32, dur);
    const base = ctx.createConstantSource(); base.offset.value = 0.5; base.connect(am.gain);
    o.connect(am).connect(bp).connect(bp2).connect(g).connect(out);
    // wood body: a little low noise under it
    const n = this.noiseSrc(t, dur), nl = ctx.createBiquadFilter(); nl.type = 'lowpass'; nl.frequency.value = heavy ? 300 : 700;
    const ng = ctx.createGain(); this.env(ng, t, 0.1, heavy ? 0.12 : 0.05, dur);
    n.connect(nl).connect(ng).connect(out);
    for (const s of [o, lfo, base]) { s.start(t); s.stop(t + dur + 0.05); }
  }

  private click(out: AudioNode, t: number, f: number, amp: number) {
    const ctx = this.ctx!;
    const n = this.noiseSrc(t, 0.03), hp = ctx.createBiquadFilter(); hp.type = 'bandpass'; hp.frequency.value = f; hp.Q.value = 1.5;
    const g = ctx.createGain(); this.env(g, t, 0.001, amp, 0.03);
    n.connect(hp).connect(g).connect(out);
  }
  private ping(out: AudioNode, t: number, freqs: number[], amp: number, dur: number) {
    const ctx = this.ctx!;
    for (const [i, f] of freqs.entries()) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = ctx.createGain(); this.env(g, t, 0.002, amp / (1 + i * 0.6), dur / (1 + i * 0.3));
      o.connect(g).connect(out); o.start(t); o.stop(t + dur + 0.05);
    }
  }
  private latch(out: AudioNode, t: number, v: number) {
    this.click(out, t, 3200 * v, 0.5);
    this.ping(out, t + 0.002, [2300 * v, 3710 * v], 0.06, 0.09);
    this.click(out, t + 0.07 + this.r() * 0.04, 2400 * v, 0.35);
  }
  private thud(out: AudioNode, t: number, w: number, v: number) {
    const ctx = this.ctx!, heavy = w > 1.5, dur = heavy ? 0.9 : 0.4;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime((heavy ? 62 : 95) * v, t); o.frequency.exponentialRampToValueAtTime((heavy ? 34 : 52) * v, t + dur);
    const g = ctx.createGain(); this.env(g, t, 0.004, Math.min(1, 0.55 * w), dur);
    o.connect(g).connect(out); o.start(t); o.stop(t + dur + 0.05);
    const n = this.noiseSrc(t, 0.25), lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = heavy ? 260 : 480;
    const ng = ctx.createGain(); this.env(ng, t, 0.002, Math.min(1, 0.45 * w), 0.22);
    n.connect(lp).connect(ng).connect(out);
  }
  private clank(out: AudioNode, t: number, w: number, v: number) {
    this.click(out, t, 1800 * v, 0.4 * w);
    this.ping(out, t, [410 * v, 1033 * v, 1597 * v, 2711 * v], 0.12 * w, 0.35);
  }
  private chain(out: AudioNode, t: number, v: number) {
    for (let k = 0; k < 14; k++) this.click(out, t + k * 0.055 + this.r() * 0.03, (2600 + this.r() * 1800) * v, 0.18 + this.r() * 0.12);
  }
}
