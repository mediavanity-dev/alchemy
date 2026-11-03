// Small Web Audio synth: warm pad for chords, soft lead for melody, recorded voice playback.

import { midiToFreq } from './pitch.js';

function makeImpulse(ctx, seconds = 2.2) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return buf;
}

export class Synth {
  constructor() {
    this.ctx = null;
    this.out = null;
    this.sources = new Set();
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      comp.connect(ctx.destination);
      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(comp);
      const verb = ctx.createConvolver();
      verb.buffer = makeImpulse(ctx);
      this.reverb = ctx.createGain();
      this.reverb.gain.value = 0.22;
      this.reverb.connect(verb).connect(this.master);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  // Each playback gets its own output bus so stopping can fade it out cleanly.
  begin() {
    this.stop();
    const ctx = this.ensure();
    this.out = ctx.createGain();
    this.out.connect(this.master);
    this.out.connect(this.reverb);
    return ctx;
  }

  stop() {
    if (!this.out) return;
    const ctx = this.ctx, out = this.out, now = ctx.currentTime;
    out.gain.setTargetAtTime(0, now, 0.03);
    for (const s of this.sources) {
      try { s.stop(now + 0.2); } catch { /* already stopped */ }
    }
    this.sources.clear();
    setTimeout(() => out.disconnect(), 400);
    this.out = null;
  }

  _track(src) {
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  _voice(midi, t, dur, gain, type, cutoff, detunes) {
    const ctx = this.ctx;
    const env = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    filter.Q.value = 0.6;
    filter.connect(env).connect(this.out);

    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.06);
    env.gain.setTargetAtTime(gain * 0.7, t + 0.06, 0.5);
    env.gain.setTargetAtTime(0, t + dur, 0.15);

    for (const d of detunes) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = midiToFreq(midi);
      osc.detune.value = d;
      osc.connect(filter);
      osc.start(t);
      osc.stop(t + dur + 1);
      this._track(osc);
    }
  }

  chord(midis, t, dur, level = 0.8) {
    const [bass, ...upper] = midis;
    this._voice(bass, t, dur, 0.22 * level, 'triangle', 900, [0]);
    for (const m of upper) this._voice(m, t, dur, (0.07 * level * 4) / Math.max(3, upper.length), 'sawtooth', 1500, [-7, 7]);
  }

  lead(midi, t, dur) {
    const ctx = this.ctx;
    const env = ctx.createGain();
    env.connect(this.out);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.2, t + 0.015);
    env.gain.setTargetAtTime(0.14, t + 0.015, 0.2);
    env.gain.setTargetAtTime(0, t + dur, 0.05);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = midiToFreq(midi);
    osc.connect(env);
    osc.start(t);
    osc.stop(t + dur + 0.5);
    this._track(osc);
  }

  voice(buffer, t, offset, dur) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = 1;
    src.connect(g).connect(this.out);
    src.start(t, offset, dur);
    this._track(src);
  }
}
