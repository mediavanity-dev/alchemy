// Pitch tracking (McLeod Pitch Method) and note segmentation for sung / hummed audio.

const TARGET_RATE = 12000;
const MIN_FREQ = 38; // a bass guitar's low E is 41 Hz
const MAX_FREQ = 2400; // flute, violin and whistling reach past 2 kHz

export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Brings a recording to a consistent loudness, judged on the loudest 30% of it
// (the singing, not the silences), so one stray pop can't keep the whole take
// quiet. Brief transients that end up above 0.8 are softly rounded off.
export function normalizeLoudness(x, sr, target = 0.2) {
  const win = Math.max(1, Math.round(sr * 0.05));
  const levels = [];
  for (let i = 0; i + win <= x.length; i += win) levels.push(rmsOf(x.subarray(i, i + win)));
  if (!levels.length) return x;
  levels.sort((a, b) => a - b);
  const loud = levels.slice(Math.floor(levels.length * 0.7));
  const active = Math.sqrt(loud.reduce((a, v) => a + v * v, 0) / loud.length);
  if (active < 1e-4) return x;
  const gain = Math.min(target / active, 30);
  for (let i = 0; i < x.length; i++) {
    const v = x[i] * gain, a = Math.abs(v);
    x[i] = a <= 0.8 ? v : Math.sign(v) * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
  }
  return x;
}

function rmsOf(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

function lowpass(x, sr, cutoff) {
  const w0 = (2 * Math.PI * cutoff) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0, b1 = (1 - cos) / a0, b2 = b0;
  const a1 = (-2 * cos) / a0, a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    y[i] = yi;
  }
  return y;
}

// Voice fundamentals sit well below 1.1 kHz, so analyse at ~12 kHz to keep the
// autocorrelation cheap enough for phones.
export function decimate(x, sr) {
  const factor = Math.max(1, Math.floor(sr / TARGET_RATE));
  if (factor === 1) return { data: x, rate: sr };
  const rate = sr / factor;
  const f = lowpass(lowpass(x, sr, rate * 0.42), sr, rate * 0.42);
  const out = new Float32Array(Math.floor(x.length / factor));
  for (let i = 0; i < out.length; i++) out[i] = f[i * factor];
  return { data: out, rate };
}

export function mpm(frame, rate) {
  const n = frame.length;
  const minLag = Math.max(2, Math.floor(rate / MAX_FREQ));
  const maxLag = Math.min((n >> 1) - 2, Math.ceil(rate / MIN_FREQ));

  let mean = 0;
  for (let i = 0; i < n; i++) mean += frame[i];
  mean /= n;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = frame[i] - mean;

  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + x[i] * x[i];

  const nsdf = new Float32Array(maxLag + 2);
  for (let tau = 0; tau <= maxLag + 1; tau++) {
    let acf = 0;
    const lim = n - tau;
    for (let i = 0; i < lim; i++) acf += x[i] * x[i + tau];
    const m = cum[lim] + (cum[n] - cum[tau]);
    nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
  }

  // Skip the zero-lag lobe, then collect the highest point of each positive region.
  let tau = 1;
  while (tau <= maxLag && nsdf[tau] > 0) tau++;
  const peaks = [];
  let bestTau = -1, best = -Infinity;
  for (; tau <= maxLag; tau++) {
    const v = nsdf[tau];
    if (v > 0) {
      if (v > best) { best = v; bestTau = tau; }
    } else if (bestTau > 0) {
      peaks.push(bestTau);
      bestTau = -1; best = -Infinity;
    }
  }
  if (bestTau > 0 && bestTau < maxLag) peaks.push(bestTau);
  if (!peaks.length) return null;

  let maxV = 0;
  for (const p of peaks) if (p >= minLag && nsdf[p] > maxV) maxV = nsdf[p];
  const threshold = 0.9 * maxV;
  for (const p of peaks) {
    if (p < minLag || nsdf[p] < threshold) continue;
    const a = nsdf[p - 1], b = nsdf[p], c = nsdf[p + 1];
    const den = a - 2 * b + c;
    const shift = den !== 0 ? (0.5 * (a - c)) / den : 0;
    const clarity = Math.min(1, b - 0.25 * (a - c) * shift);
    return { freq: rate / (p + shift), clarity };
  }
  return null;
}

// Quick estimate for the live meter while recording.
export function livePitch(frame, sr) {
  const rms = rmsOf(frame);
  if (rms < 0.003) return { rms, midi: null };
  const { data, rate } = decimate(frame, sr);
  const p = mpm(data, rate);
  return { rms, midi: p && p.clarity > 0.85 ? freqToMidi(p.freq) : null };
}

export async function extractTrack(samples, sr, onProgress) {
  const { data, rate } = decimate(samples, sr);
  const frameLen = Math.round(rate * 0.064);
  const hop = Math.round(rate * 0.0125);
  const shortLen = Math.round(rate * 0.02);
  const count = Math.max(0, Math.floor((data.length - frameLen) / hop) + 1);
  const frames = [];
  for (let k = 0; k < count; k++) {
    const off = k * hop;
    const fr = data.subarray(off, off + frameLen);
    const rms = rmsOf(fr);
    const p = rms > 1e-4 ? mpm(fr, rate) : null;
    const mid = off + (frameLen >> 1);
    frames.push({
      t: (off + frameLen / 2) / rate,
      rms,
      // Short-window loudness, sharp enough to see the dip between repeated notes.
      env: rmsOf(data.subarray(mid - (shortLen >> 1), mid + (shortLen >> 1))),
      midi: p ? freqToMidi(p.freq) : null,
      clarity: p ? p.clarity : 0,
    });
    if (k % 150 === 149) {
      onProgress?.(k / count);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onProgress?.(1);
  return { frames, hop: hop / rate };
}

export function segmentNotes({ frames, hop }) {
  if (!frames.length) return { notes: [], offset: 0, trace: new Float32Array(0), traceT0: 0, hop };

  const sortedRms = frames.map((f) => f.rms).sort((a, b) => a - b);
  const p95 = sortedRms[Math.floor(sortedRms.length * 0.95)] || 0;
  const gate = Math.max(0.003, p95 * 0.12);

  const raw = frames.map((f) =>
    f.midi != null && f.rms >= gate && f.clarity >= 0.78 && f.midi > 26 && f.midi < 100 ? f.midi : null
  );

  // Median filter removes single-frame octave slips.
  const med = raw.map((v, i) => {
    if (v == null) return null;
    const w = [];
    for (let j = i - 2; j <= i + 2; j++) if (raw[j] != null) w.push(raw[j]);
    w.sort((a, b) => a - b);
    return w[w.length >> 1];
  });

  // Singers rarely sit on A440; find their personal tuning so notes snap sensibly.
  let sx = 0, sy = 0;
  for (const v of med) {
    if (v == null) continue;
    const a = 2 * Math.PI * (v - Math.round(v));
    sx += Math.cos(a); sy += Math.sin(a);
  }
  const offset = sx || sy ? Math.atan2(sy, sx) / (2 * Math.PI) : 0;

  const q = med.map((v) => (v == null ? null : Math.round(v - offset)));

  let runs = [];
  for (let i = 0; i < q.length; i++) {
    if (q[i] == null) continue;
    const last = runs[runs.length - 1];
    if (last && last.e === i - 1 && last.p === q[i]) {
      last.e = i;
      last.vals.push(med[i] - offset);
    } else {
      runs.push({ s: i, e: i, p: q[i], vals: [med[i] - offset] });
    }
  }

  // Fold short wobbles (scoops, vibrato crossings) into their neighbours.
  const minRun = Math.ceil(0.06 / hop);
  for (;;) {
    let idx = -1, minLen = Infinity;
    runs.forEach((r, i) => {
      const len = r.e - r.s + 1;
      if (len < minRun && len < minLen) { minLen = len; idx = i; }
    });
    if (idx < 0) break;
    const r = runs[idx], prev = runs[idx - 1], next = runs[idx + 1];
    const pc = prev && prev.e + 1 === r.s;
    const nc = next && r.e + 1 === next.s;
    if (pc && nc && prev.p === next.p) {
      prev.e = next.e;
      prev.vals.push(...r.vals, ...next.vals);
      runs.splice(idx, 2);
    } else if (pc || nc) {
      const toPrev = pc && (!nc || Math.abs(prev.p - r.p) <= Math.abs(next.p - r.p));
      if (toPrev) { prev.e = r.e; prev.vals.push(...r.vals); }
      else { next.s = r.s; next.vals.unshift(...r.vals); }
      runs.splice(idx, 1);
    } else {
      runs.splice(idx, 1);
    }
  }

  const peakEnv = (a, b) => { let m = 0; for (let i = a; i <= b; i++) m = Math.max(m, frames[i].env); return m; };
  const minEnv = (a, b) => { let m = Infinity; for (let i = a; i <= b; i++) m = Math.min(m, frames[i].env); return m; };
  const DIP = 0.55;

  // Re-join same-pitch runs split by a tracking dropout, but not by a real
  // re-articulation (a loudness dip means the singer repeated the note).
  const maxGap = Math.ceil(0.06 / hop);
  const joined = [];
  for (const r of runs) {
    const last = joined[joined.length - 1];
    if (
      last && last.p === r.p && r.s - last.e - 1 <= maxGap &&
      minEnv(last.e, r.s) > DIP * Math.min(peakEnv(last.s, last.e), peakEnv(r.s, r.e))
    ) {
      last.e = r.e;
      last.vals.push(...r.vals);
    } else joined.push(r);
  }

  // Split sustained runs at loudness dips (e.g. "hm-hm" on the same pitch).
  const split = [];
  for (const r of joined) {
    let cur = r;
    for (let i = r.s + minRun; i <= r.e - minRun; i++) {
      if (i - cur.s < minRun) continue;
      const v = frames[i].env;
      if (v > frames[i - 1].env || v > frames[i + 1].env) continue;
      if (v >= DIP * Math.min(peakEnv(cur.s, i), peakEnv(i, r.e))) continue;
      const k = i - cur.s;
      split.push({ s: cur.s, e: i - 1, p: r.p, vals: cur.vals.slice(0, k) });
      cur = { s: i, e: r.e, p: r.p, vals: cur.vals.slice(k) };
    }
    split.push(cur);
  }

  const notes = split
    .map((r) => {
      const own = r.vals.filter((v) => Math.abs(v - r.p) <= 0.5);
      const avg = own.length ? own.reduce((a, b) => a + b, 0) / own.length : r.p;
      return {
        start: frames[r.s].t - hop / 2,
        end: frames[r.e].t + hop / 2,
        midi: r.p,
        cents: Math.round((avg - r.p) * 100),
      };
    })
    .filter((n) => n.end - n.start >= 0.09);

  const trace = new Float32Array(med.length);
  med.forEach((v, i) => (trace[i] = v == null ? NaN : v - offset));

  return { notes, offset: Math.round(offset * 100), trace, traceT0: frames[0].t, hop };
}
