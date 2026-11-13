// Chord sounds and playing styles for the backing.
//
// chordEvents() turns the progression into notes for a playing style (held,
// on the beat, strum, arpeggio, bass & chord), laid on the take's beat grid.
// playNote() voices one of those notes with a chosen sound. Playback, chord
// previews and MIDI export all use the same notes, so what's exported is what
// was heard. Every sound is synthesized: nothing to download.

import { midiToFreq } from './pitch.js';

// `level` evens the sounds out: each is scaled so a held chord sits at about the
// loudness of the warm pad (measured offline; plucked and struck sounds a little
// under, as their attacks sound louder than their average level). `gm` is the General MIDI program
// the chords get in an exported MIDI file.
export const SOUNDS = [
  { id: 'pad', name: 'Warm pad', gm: 89, level: 1 },
  { id: 'epiano', name: 'Electric piano', gm: 4, level: 1.15 },
  { id: 'guitar', name: 'Guitar', gm: 25, level: 2.4 },
  { id: 'organ', name: 'Organ', gm: 16, level: 0.77 },
  { id: 'strings', name: 'Strings', gm: 48, level: 0.8 },
  { id: 'marimba', name: 'Marimba', gm: 12, level: 1.35 },
];

// `level` makes up for how much of the time a style is sounding, so a sparse
// arpeggio isn't much quieter than held chords.
export const STYLES = [
  { id: 'held', name: 'Held', level: 1 },
  { id: 'beats', name: 'On the beat', level: 1 },
  { id: 'strum', name: 'Strum', level: 1 },
  { id: 'arpeggio', name: 'Arpeggio', level: 1.3 },
  { id: 'alternate', name: 'Bass & chord', level: 1.35 },
];

export const soundOf = (id) => SOUNDS.find((s) => s.id === id) ?? SOUNDS[0];
export const styleOf = (id) => STYLES.find((s) => s.id === id) ?? STYLES[0];

/* ---------- playing styles ---------- */

// segs: [{ start, end }], voices: [[bass, ...upper]] per segment (seconds on the
// take's timeline), grid: { beat, downbeat, meter }. Returns notes sorted by time:
// { midi, t, dur, vel (0..1, the musical accent), gain (the style's level),
//   role: 'bass' | 'chord', n (upper notes in the chord) }.
export function chordEvents(segs, voices, grid, style) {
  const lift = styleOf(style).level;
  const B = grid.beat;
  const per = parseInt(grid.meter ?? '4/4', 10) || 4;
  const beatIndex = (t) => Math.round((t - grid.downbeat) / B);
  const out = [];
  segs.forEach((s, i) => {
    const [bass, ...upper] = voices[i];
    const a = s.start, b = s.end;
    const add = (midi, t, dur, vel, role) => {
      if (t < b - 0.01) out.push({ midi, t, dur: Math.max(0.05, Math.min(dur, b - t + 0.02)), vel, gain: lift, role, n: upper.length });
    };
    // Where the chord sounds: its start, then each beat after it
    const hits = [{ t: a, k: beatIndex(a) }];
    for (let k = Math.ceil((a + 0.06 - grid.downbeat) / B); ; k++) {
      const t = grid.downbeat + k * B;
      if (t >= b - 0.05) break;
      hits.push({ t, k });
    }
    const next = (j) => hits[j + 1]?.t ?? b;
    const accent = (h, j) => (j === 0 || ((h.k % per) + per) % per === 0 ? 1 : 0.8);
    const chord = (t, dur, vel) => {
      add(bass, t, dur, vel, 'bass');
      for (const m of upper) add(m, t, dur, vel, 'chord');
    };

    if (style === 'beats') {
      hits.forEach((h, j) => chord(h.t, (next(j) - h.t) * 0.9, accent(h, j)));
    } else if (style === 'strum') {
      // A down strum on each beat (low string to high), an up strum on the
      // off-beat (top strings, high to low, lighter)
      hits.forEach((h, j) => {
        const end = next(j), v = accent(h, j);
        [bass, ...upper].forEach((m, q) => add(m, h.t + q * 0.016, end - h.t, v, q ? 'chord' : 'bass'));
        const off = h.t + B / 2;
        if (end - off > 0.12) [...upper].reverse().forEach((m, q) => add(m, off + q * 0.013, end - off, 0.55 * v, 'chord'));
      });
    } else if (style === 'arpeggio') {
      // Bass, then up and back down the chord, in eighth notes, each left to ring
      const seq = [bass, ...upper, ...upper.slice(1, -1).reverse()];
      const step = B / 2;
      for (let t = a, q = 0; t < b - 0.03; t += step, q++) {
        const m = seq[q % seq.length];
        add(m, t, step * 1.8, q % seq.length === 0 ? 1 : 0.85, m === bass ? 'bass' : 'chord');
      }
    } else if (style === 'alternate') {
      // Bass on beats 1 and 3, chord on 2 and 4
      hits.forEach((h, j) => {
        const dur = next(j) - h.t;
        if (((h.k % 2) + 2) % 2 === 0 || j === 0) add(bass, h.t, dur * 0.9, accent(h, j), 'bass');
        else for (const m of upper) add(m, h.t, dur * 0.7, 0.85, 'chord');
      });
    } else {
      chord(a, b - a, 1);
    }
  });
  return out.sort((x, y) => x.t - y.t);
}

/* ---------- sounds ---------- */

// Plays one note at audio time `t` into `dest`. `level` is the track's volume.
export function playNote(synth, soundId, ev, t, dest, level = 1) {
  const sound = soundOf(soundId);
  // The bass carries the low end; the chord's notes share the rest
  const g = level * ev.vel * (ev.gain ?? 1) * sound.level * (ev.role === 'bass' ? 0.55 : 0.72 / Math.max(3, ev.n));
  if (g <= 0) return;
  const voice = VOICES[sound.id] ?? VOICES.pad;
  voice(synth, ev.midi, t, ev.dur, g, dest, ev.role);
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

function envelope(ctx, dest) {
  const env = ctx.createGain();
  env.gain.value = 0;
  env.connect(dest);
  return env;
}

function osc(synth, type, freq, t, stop, dest, detune = 0) {
  const o = synth.ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.detune.value = detune;
  o.connect(dest);
  o.start(t);
  o.stop(stop);
  synth._track(o);
  return o;
}

const VOICES = {
  // The original sound: a soft triangle bass under two slightly detuned saws
  pad(synth, midi, t, dur, g, dest, role) {
    const ctx = synth.ctx;
    const env = envelope(ctx, dest);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = role === 'bass' ? 900 : 1500;
    lp.Q.value = 0.6;
    lp.connect(env);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(g, t + 0.06);
    env.gain.setTargetAtTime(g * 0.7, t + 0.06, 0.5);
    env.gain.setTargetAtTime(0, t + dur, 0.15);
    const stop = t + dur + 1;
    if (role === 'bass') osc(synth, 'triangle', midiToFreq(midi), t, stop, lp);
    else for (const d of [-7, 7]) osc(synth, 'sawtooth', midiToFreq(midi), t, stop, lp, d);
  },

  // FM electric piano: a sine whose brightness fades as the note rings, plus a
  // quick bell-like "tine" at the start
  epiano(synth, midi, t, dur, g, dest) {
    const ctx = synth.ctx, f = midiToFreq(midi);
    const env = envelope(ctx, dest);
    const ring = 0.5 + 1.1 * clamp01((96 - midi) / 60);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(g, t + 0.004);
    env.gain.setTargetAtTime(0, t + 0.004, ring);
    env.gain.setTargetAtTime(0, t + dur, 0.09);
    const stop = t + dur + 0.6;
    const car = osc(synth, 'sine', f, t, stop, env);
    const mod = ctx.createOscillator();
    mod.frequency.value = f;
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(f * 1.6, t);
    depth.gain.setTargetAtTime(f * 0.25, t, 0.3);
    mod.connect(depth).connect(car.frequency);
    mod.start(t);
    mod.stop(stop);
    synth._track(mod);
    const tine = envelope(ctx, dest);
    tine.gain.setValueAtTime(g * 0.18, t);
    tine.gain.setTargetAtTime(0, t, 0.05);
    osc(synth, 'sine', f * 7, t, t + 0.4, tine);
  },

  // Plucked string (Karplus-Strong), rendered once per note and reused
  guitar(synth, midi, t, dur, g, dest) {
    const ctx = synth.ctx;
    synth._strings ??= new Map();
    const key = `${ctx.sampleRate}:${midi}`;
    if (!synth._strings.has(key)) synth._strings.set(key, pluck(ctx, midi));
    const src = ctx.createBufferSource();
    src.buffer = synth._strings.get(key);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 70;
    const env = envelope(ctx, dest);
    env.gain.setValueAtTime(g * 2.2, t);
    env.gain.setTargetAtTime(0, t + dur, 0.07);
    src.connect(hp).connect(env);
    src.start(t);
    src.stop(Math.min(t + dur + 0.5, t + src.buffer.duration));
    synth._track(src);
  },

  // Tonewheel-style organ: stacked sine "drawbars" with a gentle vibrato
  organ(synth, midi, t, dur, g, dest) {
    const ctx = synth.ctx, f = midiToFreq(midi);
    const env = envelope(ctx, dest);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(g, t + 0.006);
    env.gain.setTargetAtTime(0, t + dur, 0.04);
    const stop = t + dur + 0.3;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 6.4;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 6; // cents
    lfo.connect(lfoDepth);
    lfo.start(t);
    lfo.stop(stop);
    synth._track(lfo);
    for (const [ratio, amp] of [[0.5, 0.45], [1, 1], [2, 0.55], [3, 0.3], [4, 0.22]]) {
      const pg = ctx.createGain();
      pg.gain.value = amp / 1.6;
      pg.connect(env);
      const o = osc(synth, 'sine', f * ratio, t, stop, pg);
      lfoDepth.connect(o.detune);
    }
  },

  // A string section: detuned saws, a slow swell and a late vibrato
  strings(synth, midi, t, dur, g, dest, role) {
    const ctx = synth.ctx, f = midiToFreq(midi);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = role === 'bass' ? 1100 : 2300;
    lp.Q.value = 0.4;
    const env = envelope(ctx, dest);
    lp.connect(env);
    env.gain.setValueAtTime(0, t);
    env.gain.setTargetAtTime(g, t, 0.12);
    env.gain.setTargetAtTime(0, t + dur, 0.22);
    const stop = t + dur + 1.2;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.3;
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(0, t);
    depth.gain.linearRampToValueAtTime(7, t + 0.6);
    lfo.connect(depth);
    lfo.start(t);
    lfo.stop(stop);
    synth._track(lfo);
    for (const d of [-9, 0, 9]) depth.connect(osc(synth, 'sawtooth', f, t, stop, lp, d).detune);
  },

  // Marimba: a struck bar, mostly fundamental, with a quick woody overtone
  marimba(synth, midi, t, dur, g, dest) {
    const ctx = synth.ctx, f = midiToFreq(midi);
    const ring = 0.18 + 0.35 * clamp01((84 - midi) / 48);
    const stop = t + Math.min(dur + 0.3, ring * 6);
    for (const [ratio, amp, tau] of [[1, 1, ring], [3.93, 0.3, 0.05], [9.2, 0.07, 0.015]]) {
      const env = envelope(ctx, dest);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(g * amp, t + 0.002);
      env.gain.setTargetAtTime(0, t + 0.002, tau);
      env.gain.setTargetAtTime(0, t + dur, 0.08);
      osc(synth, 'sine', f * ratio, t, stop, env);
    }
  },
};

// Karplus-Strong plucked string, tuned with an all-pass so high notes stay in tune
function pluck(ctx, midi) {
  const sr = ctx.sampleRate, f = midiToFreq(midi), period = sr / f;
  let N = Math.floor(period - 0.5), frac = period - 0.5 - N;
  if (frac < 0.1) { N -= 1; frac += 1; }
  const C = (1 - frac) / (1 + frac);
  const t60 = 1.2 + 2.6 * clamp01((76 - midi) / 40); // low strings ring longer
  const rho = 10 ** (-3 / (f * t60));
  const len = Math.floor(sr * Math.min(3, t60 + 0.3));
  const y = new Float32Array(len);
  let prev = 0, apx = 0, apy = 0, soft = 0;
  for (let n = 0; n < len; n++) {
    const d = n >= N ? y[n - N] : 0;
    const avg = 0.5 * (d + prev);
    prev = d;
    const ap = C * avg + apx - C * apy;
    apx = avg;
    apy = ap;
    let e = 0;
    if (n < N) { soft += 0.35 * (Math.random() * 2 - 1 - soft); e = 0.8 * soft; } // a soft, rounded pick
    y[n] = e + rho * ap;
  }
  const buf = ctx.createBuffer(1, len, sr);
  buf.copyToChannel(y, 0);
  return buf;
}
