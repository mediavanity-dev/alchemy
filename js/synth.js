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
      this.attach(new AC({ latencyHint: 'interactive' }));
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  // Builds the output chain on a context (a live one, or an offline one for measuring levels).
  attach(ctx) {
    this.ctx = ctx;
    // A fast, hard-kneed limiter: transparent at normal levels, it only catches
    // peaks so the mix can sit loud on a phone speaker without clipping.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.2;
    limiter.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(limiter);
    const verb = ctx.createConvolver();
    verb.buffer = makeImpulse(ctx);
    this.reverb = ctx.createGain();
    this.reverb.gain.value = 0.22;
    this.reverb.connect(verb).connect(this.master);
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
    this._voice(bass, t, dur, 0.55 * level, 'triangle', 900, [0]);
    for (const m of upper) this._voice(m, t, dur, (0.18 * level * 4) / Math.max(3, upper.length), 'sawtooth', 1500, [-7, 7]);
  }

  lead(midi, t, dur) {
    const ctx = this.ctx;
    const env = ctx.createGain();
    env.connect(this.out);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.5, t + 0.015);
    env.gain.setTargetAtTime(0.35, t + 0.015, 0.2);
    env.gain.setTargetAtTime(0, t + dur, 0.05);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = midiToFreq(midi);
    osc.connect(env);
    osc.start(t);
    osc.stop(t + dur + 0.5);
    this._track(osc);
  }

  // Count-in clicks before a recording. They bypass the reverb so no tail can
  // ring on into the take, and can be cancelled on their own.
  countIn(t0, beat, beats = 4) {
    const ctx = this.ensure();
    this.stopCountIn();
    this.countOut = ctx.createGain();
    this.countOut.connect(this.master);
    for (let k = 0; k < beats; k++) this.click(t0 + k * beat, k === 0, this.countOut);
  }

  stopCountIn() {
    const out = this.countOut;
    if (!out) return;
    this.countOut = null;
    out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
    setTimeout(() => out.disconnect(), 200);
  }

  // Short woodblock-ish tick; the first beat of each bar is brighter.
  click(t, accent = false, dest = this.out) {
    const ctx = this.ctx;
    const env = ctx.createGain();
    env.connect(dest);
    env.gain.setValueAtTime(accent ? 0.7 : 0.45, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(accent ? 1900 : 1300, t);
    osc.frequency.exponentialRampToValueAtTime(accent ? 1400 : 950, t + 0.05);
    osc.connect(env);
    osc.start(t);
    osc.stop(t + 0.06);
    this._track(osc);
  }

  // Clean reference pitch, independent of playback so it never cuts a take off.
  tone(midi, dur = 3, onEnd) {
    const ctx = this.ensure();
    this.stopTone();
    const t = ctx.currentTime + 0.01;
    const env = ctx.createGain();
    env.connect(this.master);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.7, t + 0.04);
    env.gain.setValueAtTime(0.7, t + dur - 0.7);
    env.gain.linearRampToValueAtTime(0, t + dur);
    const oscs = [[1, 1], [2, 0.12], [3, 0.04]].map(([h, g]) => {
      const osc = ctx.createOscillator();
      const og = ctx.createGain();
      osc.frequency.value = midiToFreq(midi) * h;
      og.gain.value = g;
      osc.connect(og).connect(env);
      osc.start(t);
      osc.stop(t + dur + 0.05);
      return osc;
    });
    const nodes = { env, oscs, onEnd };
    oscs[0].onended = () => {
      if (this.toneNodes !== nodes) return;
      this.toneNodes = null;
      onEnd?.();
    };
    this.toneNodes = nodes;
  }

  stopTone() {
    const n = this.toneNodes;
    if (!n) return;
    this.toneNodes = null;
    n.onEnd?.();
    const now = this.ctx.currentTime;
    n.env.gain.cancelScheduledValues(now);
    n.env.gain.setTargetAtTime(0, now, 0.03);
    for (const o of n.oscs) {
      try { o.stop(now + 0.2); } catch { /* already stopped */ }
    }
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
