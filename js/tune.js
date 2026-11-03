// Pitch correction ("autotune") for a recorded voice, by TD-PSOLA: the waveform is
// cut into pitch-period grains around each glottal pulse, and the grains are laid
// back down closer together (higher) or further apart (lower). Timing and vowel
// colour are preserved; only the pitch moves.

import { midiToFreq } from './pitch.js';

// Per-frame shift (in semitones) that pulls each sung note toward its target.
// `amount` 0..1: 1 flattens every note onto its target (the hard, robotic sound);
// smaller amounts move the note's centre part of the way and keep vibrato/slides.
function shiftCurve(clip, amount, targetOf) {
  const { trace, hop, traceT0, notes } = clip;
  const pitch = Float32Array.from(trace, (v) => v + clip.tuning);
  const shift = new Float32Array(trace.length);
  const frameOf = (t) => Math.round((t - traceT0) / hop);

  for (const n of notes) {
    const a = Math.max(0, frameOf(n.start)), b = Math.min(trace.length - 1, frameOf(n.end));
    let sum = 0, count = 0;
    for (let i = a; i <= b; i++) if (!Number.isNaN(pitch[i])) { sum += pitch[i]; count++; }
    if (!count) continue;
    const target = targetOf(sum / count);
    for (let i = a; i <= b; i++) if (!Number.isNaN(pitch[i])) shift[i] = amount * (target - pitch[i]);
  }

  // Glide between notes (~25 ms each way) so corrections never jump audibly.
  const k = Math.exp(-hop / 0.025);
  for (let i = 1; i < shift.length; i++) shift[i] = k * shift[i - 1] + (1 - k) * shift[i];
  for (let i = shift.length - 2; i >= 0; i--) shift[i] = k * shift[i + 1] + (1 - k) * shift[i];
  return { pitch, shift };
}

export function tuneClip(clip, { amount, targetOf }) {
  const x = clip.samples, sr = clip.sampleRate, n = x.length;
  const { pitch, shift } = shiftCurve(clip, amount, targetOf);
  const at = (arr, t) => {
    const i = Math.round((t - clip.traceT0) / clip.hop);
    return i < 0 || i >= arr.length ? NaN : arr[i];
  };

  // Analysis marks: one per pitch period, snapped to the local peak so grains
  // line up with the glottal pulses. Unvoiced stretches use fixed 10 ms grains.
  const marks = [];
  for (let i = 0; i < n; ) {
    const p = at(pitch, i / sr);
    const period = Number.isNaN(p) ? Math.round(sr * 0.01) : Math.max(16, Math.round(sr / midiToFreq(p)));
    let m = i;
    if (!Number.isNaN(p)) {
      const r = period >> 2;
      let best = -Infinity;
      for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) if (x[j] > best) { best = x[j]; m = j; }
    }
    marks.push({ i: m, T: period });
    i = Math.max(i + 1, m + period);
  }

  // Synthesis: Hann-windowed two-period grains, placed every period / ratio.
  const y = new Float32Array(n), wsum = new Float32Array(n);
  let k = 0;
  for (let ts = marks[0].i; ts < n; ) {
    while (k + 1 < marks.length && Math.abs(marks[k + 1].i - ts) <= Math.abs(marks[k].i - ts)) k++;
    const { i: src0, T } = marks[k];
    const s = at(shift, ts / sr);
    const ratio = Number.isNaN(s) ? 1 : 2 ** (s / 12);
    const dst0 = Math.round(ts);
    for (let j = -T; j < T; j++) {
      const src = src0 + j, dst = dst0 + j;
      if (src < 0 || src >= n || dst < 0 || dst >= n) continue;
      const w = 0.5 - 0.5 * Math.cos((Math.PI * (j + T)) / T);
      y[dst] += x[src] * w;
      wsum[dst] += w;
    }
    ts += T / ratio;
  }
  for (let i = 0; i < n; i++) y[i] /= Math.max(wsum[i], 0.5);
  return y;
}

// Nearest equal-tempered note (A = 440 Hz), or nearest note of the given scale.
export function targetFn(mode, scale) {
  if (mode !== 'key' || !scale) return Math.round;
  return (m) => {
    let best = null;
    for (let c = Math.floor(m) - 2; c <= Math.ceil(m) + 2; c++) {
      if (scale.has(((c % 12) + 12) % 12) && (best === null || Math.abs(c - m) < Math.abs(best - m))) best = c;
    }
    return best ?? Math.round(m);
  };
}
