// Locking a performance to the beat grid: find where each note or hit starts, move
// each start to the nearest point of a sensible subdivision of the beat, and
// time-stretch the audio in between (WSOLA, which keeps the pitch) so nothing
// jumps. The first moments after each start are copied untouched, so attacks stay
// crisp.

import { hitsOf } from './sound.js';

// Subdivisions of the beat (the pulse a tempo counts) that 'auto' chooses among.
export const GRIDS = { 1: 'beat', 2: 'half', 3: 'triplet', 4: 'quarter' };

// Onsets in a clip's own time: sharp rises in the spectrum (consonants, plucks,
// hits), plus note starts from pitch tracking for soft, sung entries. A note start
// with a sharp rise just before or at it takes the rise's time.
export function findOnsets(samples, sr, notes = [], hits = hitsOf(samples, sr)) {
  const out = [];
  const used = new Set();
  for (const n of notes) {
    let best = null;
    hits.forEach((h, i) => {
      const d = h.t - n.start;
      if (d > -0.07 && d < 0.03 && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, i };
    });
    if (best) used.add(best.i);
    out.push(best ? hits[best.i].t : n.start);
  }
  // Hits with no note: struck sounds, or a consonant on a held pitch. Only clear ones.
  hits.forEach((h, i) => { if (!used.has(i) && (h.s >= (notes.length ? 0.35 : 0.08))) out.push(h.t); });
  out.sort((a, b) => a - b);
  // One onset per 50 ms at most.
  return out.filter((t, i) => i === 0 || t - out[i - 1] > 0.05);
}

// The subdivision that best explains the onsets: each onset's distance from its
// nearest grid point is scored against a typical human timing spread, and every
// halving of the grid has to earn its place. So a slightly late eighth note isn't
// read as a sixteenth, but real sixteenths or triplets are found. Pulling a note a
// whole subdivision off (an off-beat eighth onto the beat) changes the rhythm, so
// that costs far more than a finer grid. Triplets need a little more evidence than
// straight sixteenths, which loose dotted rhythms can resemble. `t` in take time.
export function chooseGrid(onsets, tempo) {
  if (!onsets.length) return 2;
  const SIGMA = 0.035, PRICE = 2, CAP = 25, TRIPLET = 0.5;
  let best = 2, bestCost = Infinity;
  for (const div of [1, 2, 3, 4]) {
    const step = tempo.beat / div;
    let cost = 0;
    for (const t of onsets) {
      const pos = (t - tempo.downbeat) / step;
      const err = Math.abs(pos - Math.round(pos)) * step;
      cost += Math.min(CAP, (err / SIGMA) ** 2);
    }
    cost = cost / onsets.length + PRICE * Math.log2(div) + (div === 3 ? TRIPLET : 0);
    if (cost < bestCost) { bestCost = cost; best = div; }
  }
  return best;
}

// Anchors [from, to] (seconds, clip time) moving each onset towards its grid point
// by `amount` (1 = exactly on it). Onsets competing for one grid point: the closer
// one gets it, the other is carried along by the stretch. `offset`: where the clip
// starts on the take's timeline.
export function anchorsFor(onsets, tempo, div, amount, offset = 0, length = Infinity) {
  const step = tempo.beat / div;
  const picks = [];
  for (const t of onsets) {
    const k = Math.round((t + offset - tempo.downbeat) / step);
    const target = tempo.downbeat + k * step - offset;
    const err = Math.abs(target - t);
    const last = picks[picks.length - 1];
    if (last && last.k >= k) {
      if (err < last.err) picks[picks.length - 1] = { t, k, target, err };
      continue;
    }
    picks.push({ t, k, target, err });
  }
  const anchors = [[0, 0]];
  for (const p of picks) {
    const to = p.t + amount * (p.target - p.t);
    const prev = anchors[anchors.length - 1];
    // Keep order, room between anchors, and nothing before the clip's start.
    if (p.t - prev[0] < 0.03 || to - prev[1] < 0.03 || p.t >= length - 0.03) continue;
    anchors.push([p.t, to]);
  }
  return { anchors, moved: anchors.length - 1 };
}

// Time maps for a set of anchors. Just after each anchor the audio is copied as is
// for PROTECT seconds (the attack), then stretched to meet the next anchor. The
// last stretch keeps its shift to the end.
const PROTECT = 0.03;
export function timeMap(anchors, srcLength) {
  const last = anchors[anchors.length - 1];
  const pts = [...anchors, [srcLength, srcLength + (last[1] - last[0])]];
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [s0, d0] = pts[i], [s1, d1] = pts[i + 1];
    const p = i === 0 ? 0 : Math.min(PROTECT, 0.5 * (s1 - s0), 0.5 * (d1 - d0));
    segs.push({ s0, d0, s1, d1, p });
  }
  const find = (v, key) => {
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m][key] <= v) lo = m; else hi = m - 1; }
    return segs[lo];
  };
  const toSrc = (d) => {
    const g = find(d, 'd0');
    if (d - g.d0 < g.p) return g.s0 + (d - g.d0);
    const a = g.d0 + g.p, b = g.s0 + g.p;
    return g.d1 > a ? b + ((d - a) * (g.s1 - b)) / (g.d1 - a) : b;
  };
  const toDst = (s) => {
    const g = find(s, 's0');
    if (s - g.s0 < g.p) return g.d0 + (s - g.s0);
    const a = g.s0 + g.p, b = g.d0 + g.p;
    return g.s1 > a ? b + ((s - a) * (g.d1 - b)) / (g.s1 - a) : b;
  };
  return { toSrc, toDst, length: pts[pts.length - 1][1], segs };
}

// WSOLA: the output is built from overlapping 40 ms grains of the input, each taken
// from where the time map says, nudged by up to 8 ms to where it best continues
// the grain before (so the waveform stays smooth and the pitch unchanged). Inside
// an attack the grain is placed exactly, so the onset lands on its grid point.
export function warp(x, sr, map) {
  const N = 2 * Math.round(0.02 * sr), H = N / 2, tol = Math.round(0.008 * sr);
  const outLen = Math.max(1, Math.round(map.length * sr));
  const y = new Float32Array(outLen + N), wsum = new Float32Array(outLen + N);
  const win = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const inAttack = (d) => map.segs.some((g) => g.p > 0 && d >= g.d0 - 0.02 && d < g.d0 + g.p);
  const corr = (a, b, step) => {
    let s = 0;
    for (let i = 0; i < N; i += step) s += x[a + i] * x[b + i];
    return s;
  };
  let prev = null;
  for (let o = 0; o < outLen; o += H) {
    const centre = (o + H) / sr;
    let at = Math.round(map.toSrc(centre) * sr) - H;
    const natural = prev == null ? null : prev + H;
    if (natural != null && !inAttack(centre)) {
      if (Math.abs(natural - at) <= 1) at = natural; // plain copy, nothing to stretch
      else {
        // Coarse search, then fine.
        let best = at, bv = -Infinity;
        for (let d = -tol; d <= tol; d += 4) {
          const c = at + d;
          if (c < 0 || c + N > x.length || natural + N > x.length) continue;
          const v = corr(natural, c, 4);
          if (v > bv) { bv = v; best = c; }
        }
        const coarse = best;
        for (let d = -3; d <= 3; d++) {
          const c = coarse + d;
          if (c < 0 || c + N > x.length || natural + N > x.length) continue;
          const v = corr(natural, c, 1);
          if (v > bv) { bv = v; best = c; }
        }
        at = best;
      }
    }
    at = Math.max(0, Math.min(x.length - N, at));
    for (let i = 0; i < N; i++) {
      y[o + i] += win[i] * (x[at + i] ?? 0);
      wsum[o + i] += win[i];
    }
    prev = at;
  }
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = wsum[i] > 1e-3 ? y[i] / wsum[i] : 0;
  return out;
}

// A pitch trace (one value per hop from t0) carried through a time map.
export function warpTrace(trace, t0, hop, map) {
  const n = Math.max(0, Math.ceil((map.length - t0) / hop));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const src = (map.toSrc(t0 + i * hop) - t0) / hop;
    const a = Math.floor(src), f = src - a;
    const va = trace[a], vb = trace[a + 1];
    out[i] = a < 0 || a >= trace.length ? NaN
      : Number.isNaN(va) || vb == null || Number.isNaN(vb) ? (f < 0.5 ? va : vb ?? va)
      : va + f * (vb - va);
  }
  return out;
}
