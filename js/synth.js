// Small Web Audio synth: the output chain, soft lead for the guide melody, clicks,
// drums and recorded-audio playback. Chord sounds live in instruments.js.

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

function newContext() {
  const AC = window.AudioContext || window.webkitAudioContext;
  return new AC({ latencyHint: 'interactive' });
}

export class Synth {
  constructor() {
    this.ctx = null;
    this.out = null;
    this.sources = new Set();
  }

  ensure() {
    // Built for an audio route that's gone (see retire): start over on a fresh one.
    if (this.ctx && this.stale) this._drop();
    if (!this.ctx) this.attach(newContext());
    this.stale = false;
    // 'interrupted' is Safari's state after a phone call or audio route change.
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  // The app went to the background: pause the audio engine, so the phone stops
  // listing Alchemy as "Now Playing" on the lock screen. ensure() wakes it again.
  sleep() {
    if (this.ctx?.state === 'running') this.ctx.suspend().catch(() => {});
  }

  // Opening or closing the mic switches a phone's audio route (call mode, Bluetooth
  // headset profiles, sample rate). A context that lives through the switch can stay
  // quiet or distorted, so the next ensure() builds a new one. Until then the old
  // context keeps working, so anything still fading out finishes cleanly.
  retire() {
    if (this.ctx) this.stale = true;
  }

  // Swaps in a fresh context right away, e.g. once the mic is open. Outside a tap a
  // browser may refuse to start new audio, so the old context is only replaced once
  // the new one is confirmed running.
  async renew() {
    const fresh = newContext();
    if (fresh.state !== 'running') {
      await Promise.race([fresh.resume().catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
    }
    if (fresh.state !== 'running') {
      fresh.close().catch(() => {});
      this.stale = false;
      return this.ensure();
    }
    if (this.ctx) this._drop();
    this.attach(fresh);
    this.stale = false;
    return fresh;
  }

  _drop() {
    const old = this.ctx;
    this.ctx = this.out = this.countOut = this.toneNodes = this.clickNoise = this.drumNoise = null;
    this.sources.clear();
    old.close?.().catch(() => {});
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
    // A little headroom: a levelled voice peaks at 0.8 and the chords sit under
    // it, so together they only brush the limiter instead of overshooting it.
    this.master.gain.value = 0.85;
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

  // A gain stage for one track of the mix, feeding the current playback's bus.
  bus(level = 1) {
    const g = this.ctx.createGain();
    g.gain.value = level;
    g.connect(this.out);
    return g;
  }

  _track(src) {
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  lead(midi, t, dur, dest = this.out) {
    const ctx = this.ctx;
    const env = ctx.createGain();
    env.connect(dest);
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
  // ring on into the take, and can be cancelled on their own. With headphones the
  // click can carry on through the take (countClick) at the same, gentler, level.
  countIn(t0, beat, beats = 4, level = 1) {
    const ctx = this.ensure();
    this.stopCountIn();
    this.countOut = ctx.createGain();
    this.countOut.gain.value = level;
    this.countOut.connect(this.master);
    for (let k = 0; k < beats; k++) this.click(t0 + k * beat, k === 0, this.countOut);
  }

  countClick(t, accent) {
    if (this.countOut) this.click(t, accent, this.countOut);
  }

  stopCountIn() {
    const out = this.countOut;
    if (!out) return;
    this.countOut = null;
    out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
    setTimeout(() => out.disconnect(), 200);
  }

  // Woodblock-ish tick: a pitched body plus a short noise snap for a crisp attack
  // that cuts through on a phone speaker. The first beat of each bar is brighter.
  click(t, accent = false, dest = this.out) {
    const ctx = this.ctx;
    const env = ctx.createGain();
    env.connect(dest);
    env.gain.setValueAtTime(accent ? 0.95 : 0.7, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(accent ? 1900 : 1300, t);
    osc.frequency.exponentialRampToValueAtTime(accent ? 1400 : 950, t + 0.09);
    osc.connect(env);
    osc.start(t);
    osc.stop(t + 0.1);
    this._track(osc);

    this.clickNoise ??= this._noise(0.02);
    const snap = ctx.createBufferSource();
    snap.buffer = this.clickNoise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    const sg = ctx.createGain();
    sg.gain.value = accent ? 0.5 : 0.35;
    snap.connect(hp).connect(sg).connect(dest);
    snap.start(t);
    this._track(snap);
  }

  // A burst of white noise, fading out by `fade` (0 = steady, 2 = quickly).
  _noise(seconds, fade = 2) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** fade;
    return buf;
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

  voice(buffer, t, offset, dur, dest = this.out) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(dest);
    src.start(t, offset, dur);
    this._track(src);
  }

  // A small synthesized kit for rhythm layers: kick (k), snare (s) and hi-hat (h),
  // `vel` from 0 to 1.
  drum(d, t, vel = 1, dest = this.out) {
    const ctx = this.ctx;
    const env = ctx.createGain();
    env.connect(dest);
    const a = 0.35 + 0.65 * vel;
    this.drumNoise ??= this._noise(0.3, 0);
    if (d === 'k') {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(150, t);
      osc.frequency.exponentialRampToValueAtTime(48, t + 0.12);
      env.gain.setValueAtTime(1.1 * a, t);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      osc.connect(env);
      osc.start(t);
      osc.stop(t + 0.42);
      this._track(osc);
      return;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = this.drumNoise;
    const f = ctx.createBiquadFilter();
    if (d === 'h') {
      f.type = 'highpass';
      f.frequency.value = 7000;
      env.gain.setValueAtTime(0.45 * a, t);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    } else {
      f.type = 'bandpass';
      f.frequency.value = 1800;
      f.Q.value = 0.7;
      env.gain.setValueAtTime(0.9 * a, t);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      // The drum's body under the rattle
      const body = ctx.createOscillator();
      const bg = ctx.createGain();
      body.type = 'triangle';
      body.frequency.value = 190;
      bg.gain.setValueAtTime(0.5 * a, t);
      bg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      body.connect(bg).connect(dest);
      body.start(t);
      body.stop(t + 0.12);
      this._track(body);
    }
    noise.connect(f).connect(env);
    noise.start(t);
    noise.stop(t + 0.3);
    this._track(noise);
  }
}
