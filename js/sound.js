import { decimate } from './pitch.js';

// What kind of sound a layer is (a melody line, chords, or rhythm), plus the
// analysis each kind needs: a chroma profile for chords and hit times for rhythm.

// In-place iterative radix-2 FFT.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

const pow2 = (x) => 2 ** Math.round(Math.log2(x));
const hann = (n) => Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));

// Magnitude spectra of overlapping frames, with each frame's loudness.
function stft(x, size, hop) {
  const win = hann(size);
  const re = new Float64Array(size), im = new Float64Array(size);
  const frames = [];
  for (let off = 0; off + size <= x.length; off += hop) {
    let e = 0;
    for (let i = 0; i < size; i++) {
      const v = x[off + i];
      e += v * v;
      re[i] = v * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float32Array(size / 2);
    for (let k = 0; k < size / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    frames.push({ mag, rms: Math.sqrt(e / size) });
  }
  return frames;
}

const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

// Pitch-class energy over time (about 12 frames a second), from spectral peaks so
// low guitar notes land in the right bin. Each frame is scaled to a peak of 1;
// quiet frames are left empty.
export function chromaOf(samples, sampleRate) {
  // Low guitar notes are only a few Hz apart, so this needs a long window; working
  // at a low sample rate keeps that cheap.
  const { data: x, rate: sr } = decimate(samples, sampleRate);
  const size = pow2(sr * 0.34), hop = size / 4;
  const frames = stft(x, size, hop);
  const loud = percentile(frames.map((f) => f.rms), 0.95);
  const binHz = sr / size;
  const lo = Math.ceil(70 / binHz), hi = Math.floor(2100 / binHz);
  const out = frames.map((f) => {
    const c = new Float32Array(12);
    if (f.rms < loud * 0.12) return c;
    const m = f.mag;
    let peak = 0;
    for (let k = lo; k <= hi; k++) peak = Math.max(peak, m[k]);
    const peaks = [];
    for (let k = lo; k <= hi; k++) {
      if (m[k] < peak * 0.08 || m[k] < m[k - 1] || m[k] < m[k + 1]) continue;
      // Parabolic interpolation for the true peak frequency
      const a = Math.log(m[k - 1] + 1e-9), b = Math.log(m[k] + 1e-9), g = Math.log(m[k + 1] + 1e-9);
      const d = 0.5 * (a - g) / (a - 2 * b + g || 1e-9);
      peaks.push({ f: (k + d) * binHz, m: m[k] });
    }
    for (const p of peaks) {
      // Overtones 3, 5, 6, 7, 9 and 10 of a lower note fall on other pitch classes (5th,
      // major 3rd, flat 7th, 2nd); discount peaks that line up with a strong enough lower one.
      let w = Math.sqrt(p.m);
      for (const h of [3, 5, 6, 7, 9, 10]) {
        if (peaks.some((q) => q.m >= p.m * 0.4 && Math.abs(q.f * h - p.f) < p.f * 0.015)) w *= 0.35;
      }
      const midi = 69 + 12 * Math.log2(p.f / 440);
      c[((Math.round(midi) % 12) + 12) % 12] += w;
    }
    const mx = Math.max(...c);
    if (mx > 0) for (let i = 0; i < 12; i++) c[i] /= mx;
    return c;
  });
  return { t0: size / 2 / sr, hop: hop / sr, frames: out };
}

// Hits: sharp rises in spectral energy, each tagged kick (k), snare (s) or hi-hat (h)
// by where its energy sits, with a strength from 0 to 1.
export function hitsOf(x, sr) {
  const size = pow2(sr * 0.021), hop = size / 4;
  const frames = stft(x, size, hop);
  const binHz = sr / size;
  const n = frames.length;
  const flux = new Float32Array(n);
  let prev = null;
  frames.forEach((f, i) => {
    const lm = f.mag.map((v) => Math.log1p(1000 * v));
    if (prev) {
      let s = 0;
      for (let k = 1; k < lm.length; k++) s += Math.max(0, lm[k] - prev[k]);
      flux[i] = s;
    }
    prev = lm;
  });

  const mean = flux.reduce((a, v) => a + v, 0) / Math.max(1, n);
  const loud = percentile(frames.map((f) => f.rms), 0.95);
  const span = Math.round(0.1 / (hop / sr)), near = Math.max(1, Math.round(0.03 / (hop / sr)));
  const gap = 0.06;
  const hits = [];
  const fmax = Math.max(...flux);
  for (let i = 1; i < n - 1; i++) {
    const v = flux[i];
    let isMax = true;
    for (let j = Math.max(0, i - near); j <= Math.min(n - 1, i + near); j++) if (flux[j] > v) { isMax = false; break; }
    if (!isMax) continue;
    const local = [];
    for (let j = Math.max(0, i - span); j <= Math.min(n - 1, i + span); j++) local.push(flux[j]);
    if (v < percentile(local, 0.5) + mean * 0.8 || v < fmax * 0.08) continue;
    // Ignore rises that never get loud (breaths, room noise)
    let peakRms = 0;
    for (let j = i; j < Math.min(n, i + 8); j++) peakRms = Math.max(peakRms, frames[j].rms);
    if (peakRms < loud * 0.15) continue;
    const t = (i * hop + size / 2) / sr;
    if (hits.length && t - hits[hits.length - 1].t < gap) {
      if (v > hits[hits.length - 1].v) hits.pop();
      else continue;
    }
    // Where the hit's energy sits over its first ~30 ms
    let low = 0, mid = 0, high = 0;
    for (let j = i; j < Math.min(n, i + 6); j++) {
      const m = frames[j].mag;
      for (let k = 1; k < m.length; k++) {
        const f = k * binHz, p = m[k] * m[k];
        if (f < 180) low += p;
        else if (f < 3000) mid += p;
        else if (f > 5000) high += p;
      }
    }
    const tot = low + mid + high || 1;
    hits.push({ t, v, kick: low / tot > 0.45, bright: high / (mid + high || 1) });
  }
  labelDrums(hits);
  const top = Math.max(1e-9, ...hits.map((h) => h.v));
  return hits.map(({ t, v, d }) => ({ t: +t.toFixed(4), s: +Math.min(1, v / top).toFixed(3), d }));
}

// Low-heavy hits are kicks. The rest are split into snares and hi-hats by
// brightness relative to each other, since mics and mouths vary so much; if they
// all sound alike they share one label.
function labelDrums(hits) {
  const rest = hits.filter((h) => !h.kick);
  hits.forEach((h) => { if (h.kick) h.d = 'k'; });
  if (!rest.length) return;
  const b = rest.map((h) => h.bright);
  let lo = Math.min(...b), hi = Math.max(...b);
  for (let it = 0; it < 12 && hi > lo; it++) {
    const mid = (lo + hi) / 2;
    const L = b.filter((v) => v <= mid), H = b.filter((v) => v > mid);
    if (!L.length || !H.length) break;
    lo = L.reduce((a, v) => a + v, 0) / L.length;
    hi = H.reduce((a, v) => a + v, 0) / H.length;
  }
  if (hi - lo >= 0.15) rest.forEach((h) => (h.d = h.bright > (lo + hi) / 2 ? 'h' : 's'));
  else {
    const mean = b.reduce((a, v) => a + v, 0) / b.length;
    rest.forEach((h) => (h.d = mean < 0.55 ? 's' : 'h'));
  }
}

// How tonal vs noisy the sound is (spectral flatness, 0 tonal .. 1 noise) and how
// much of it is held rather than struck, over the loud parts.
function texture(x, sr) {
  const size = pow2(sr * 0.043), hop = size / 2;
  const frames = stft(x, size, hop);
  const loud = percentile(frames.map((f) => f.rms), 0.95);
  const binHz = sr / size;
  const lo = Math.ceil(150 / binHz), hi = Math.floor(Math.min(6000, sr / 2 - 1) / binHz);
  const flats = [];
  let active = 0, held = 0;
  for (const f of frames) {
    if (f.rms > loud * 0.05) active++;
    if (f.rms > loud * 0.3) held++;
    if (f.rms < loud * 0.2) continue;
    let lg = 0, ar = 0;
    for (let k = lo; k <= hi; k++) {
      const p = f.mag[k] * f.mag[k] + 1e-12;
      lg += Math.log(p);
      ar += p;
    }
    const cnt = hi - lo + 1;
    flats.push(Math.exp(lg / cnt) / (ar / cnt));
  }
  return { flatness: percentile(flats, 0.5), sustain: active ? held / active : 0 };
}

// Classifies a recording from its pitch track (frames with rms and clarity, from
// extractTrack) and its spectrum.
// - melody: one clear pitch at a time (voice, whistling, a single-note riff)
// - chords: pitched but several notes at once (strummed guitar, piano chords)
// - rhythm: mostly noise-like or struck (drums, taps, beatbox)
export function classify(x, sr, track, hits = hitsOf(x, sr)) {
  const rmsList = track.frames.map((f) => f.rms);
  const loud = percentile(rmsList, 0.95);
  const active = track.frames.filter((f) => f.rms > loud * 0.15);
  const pitched = active.length ? active.filter((f) => f.midi != null && f.clarity >= 0.9).length / active.length : 0;
  const { flatness, sustain } = texture(x, sr);
  const decay = decayOf(x, sr, hits);
  const features = { pitched: +pitched.toFixed(2), flatness: +flatness.toFixed(3), sustain: +sustain.toFixed(2), decay: +decay.toFixed(2) };
  let kind;
  // Decay is the clearest sign of a struck sound; noisiness alone only counts when
  // extreme (shakers, brushes), since strummed strings can be fairly noisy too.
  if (decay < 0.3 || sustain < 0.3 || flatness > 0.35 || (flatness > 0.2 && decay < 0.5)) kind = 'rhythm';
  else if (pitched >= 0.6) kind = 'melody';
  else kind = 'chords';
  return { kind, features };
}

// Typical level 0.11 s after each hit relative to its peak: struck sounds have died
// away by then, sung or bowed notes are still going.
function decayOf(x, sr, hits) {
  const w = Math.round(sr * 0.02);
  const rmsAt = (t) => {
    const a = Math.max(0, Math.round(t * sr));
    let e = 0;
    for (let i = a; i < Math.min(x.length, a + w); i++) e += x[i] * x[i];
    return Math.sqrt(e / w);
  };
  const ratios = [];
  hits.forEach((h, i) => {
    const next = hits[i + 1]?.t ?? Infinity;
    if (next - h.t < 0.16) return;
    let peak = 0;
    for (let dt = -0.005; dt <= 0.04; dt += 0.005) peak = Math.max(peak, rmsAt(h.t + dt));
    if (peak > 0) ratios.push(rmsAt(h.t + 0.11) / peak);
  });
  return ratios.length >= 3 ? percentile(ratios, 0.5) : 1;
}

// Everything a new layer needs: its kind, plus the analysis each kind uses.
export function analyze(x, sr, track) {
  const hits = hitsOf(x, sr);
  const { kind, features } = classify(x, sr, track, hits);
  return { kind, features, hits, chroma: chromaOf(x, sr) };
}

// Peak normalisation for struck and strummed sounds: unlike the loudness levelling
// used for singing, it never rounds off the attacks.
export function normalizePeak(x, target = 0.9) {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak < 1e-4) return x;
  const g = Math.min(target / peak, 30);
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}
