// Music theory: key detection and melody harmonization.

const SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1]);
const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]);

// Krumhansl–Kessler key profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10, 11],
};

const QUALITIES = {
  maj: { iv: [0, 4, 7], suf: '' },
  min: { iv: [0, 3, 7], suf: 'm' },
  dim: { iv: [0, 3, 6], suf: '°' },
  dom7: { iv: [0, 4, 7, 10], suf: '7' },
  maj7: { iv: [0, 4, 7, 11], suf: 'maj7' },
  m7: { iv: [0, 3, 7, 10], suf: 'm7' },
  m7b5: { iv: [0, 3, 6, 10], suf: 'ø7' },
};

// [degree, quality, roman, function (Tonic/Subdominant/Dominant), prior, richOnly]
const VOCAB = {
  major: [
    [0, 'maj', 'I', 'T', 1.0], [2, 'min', 'ii', 'S', 0.7], [4, 'min', 'iii', 'T', 0.45],
    [5, 'maj', 'IV', 'S', 0.95], [7, 'maj', 'V', 'D', 0.95], [9, 'min', 'vi', 'T', 0.8],
    [11, 'dim', 'vii°', 'D', 0.15],
    [0, 'maj7', 'Imaj7', 'T', 0.6, 1], [2, 'm7', 'ii7', 'S', 0.6, 1], [4, 'm7', 'iii7', 'T', 0.3, 1],
    [5, 'maj7', 'IVmaj7', 'S', 0.55, 1], [7, 'dom7', 'V7', 'D', 0.75, 1], [9, 'm7', 'vi7', 'T', 0.5, 1],
    [5, 'min', 'iv', 'S', 0.4, 1], [8, 'maj', '♭VI', 'S', 0.3, 1], [10, 'maj', '♭VII', 'S', 0.4, 1],
    [2, 'dom7', 'V7/V', 'D', 0.35, 1], [4, 'dom7', 'V7/vi', 'D', 0.3, 1], [0, 'dom7', 'V7/IV', 'D', 0.25, 1],
  ],
  minor: [
    [0, 'min', 'i', 'T', 1.0], [2, 'dim', 'ii°', 'S', 0.3], [3, 'maj', 'III', 'T', 0.6],
    [5, 'min', 'iv', 'S', 0.85], [7, 'min', 'v', 'D', 0.4], [7, 'maj', 'V', 'D', 0.85],
    [8, 'maj', 'VI', 'S', 0.8], [10, 'maj', 'VII', 'D', 0.7],
    [0, 'm7', 'i7', 'T', 0.55, 1], [2, 'm7b5', 'iiø7', 'S', 0.35, 1], [3, 'maj7', 'IIImaj7', 'T', 0.4, 1],
    [5, 'm7', 'iv7', 'S', 0.5, 1], [7, 'dom7', 'V7', 'D', 0.75, 1], [8, 'maj7', 'VImaj7', 'S', 0.5, 1],
    [5, 'maj', 'IV', 'S', 0.35, 1], [1, 'maj', '♭II', 'S', 0.2, 1],
  ],
};

// Chord length, in multiples of the singer's typical note spacing.
const RHYTHM = { slow: 6, medium: 4, fast: 2 };

export const pc = (m) => ((Math.round(m) % 12) + 12) % 12;

export function spell(p, key, preferFlat = false) {
  const flats = preferFlat || (key && (key.mode === 'major' ? FLAT_MAJOR : FLAT_MINOR).has(key.tonic));
  return (flats ? FLAT : SHARP)[((p % 12) + 12) % 12];
}

export const keyName = (key) => `${spell(key.tonic, key)} ${key.mode}`;
export const noteLabel = (m, key) => spell(pc(m), key) + (Math.floor(Math.round(m) / 12) - 1);
export const scalePcs = (key) => new Set(SCALES[key.mode].map((d) => (key.tonic + d) % 12));

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

// Returns all 24 keys ranked, each with a probability `p`.
export function detectKeys(notes) {
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[pc(n.midi)] += Math.min(n.end - n.start, 1.5);
  const first = pc(notes[0].midi);
  const last = pc(notes[notes.length - 1].midi);

  const keys = [];
  for (let t = 0; t < 12; t++) {
    for (const mode of ['major', 'minor']) {
      const prof = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE;
      const rot = hist.map((_, i) => prof[(i - t + 12) % 12]);
      let r = pearson(hist, rot);
      if (last === t) r += 0.06;
      if (first === t) r += 0.03;
      keys.push({ tonic: t, mode, r });
    }
  }
  keys.sort((a, b) => b.r - a.r);
  const top = keys[0].r;
  let sum = 0;
  for (const k of keys) { k.p = Math.exp((k.r - top) / 0.12); sum += k.p; }
  for (const k of keys) k.p /= sum;
  return keys;
}

function buildVocab(key, palette) {
  const scale = scalePcs(key);
  return VOCAB[key.mode]
    .filter((e) => !e[5] || palette === 'rich')
    .map(([deg, quality, roman, func, prior], id) => {
      const root = (key.tonic + deg) % 12;
      const iv = QUALITIES[quality].iv;
      const tones = iv.map((x) => (root + x) % 12);
      return {
        id, deg, root, quality, roman, func, prior, tones,
        seventh: iv.length > 3 ? tones[3] : null,
        chromatic: tones.some((t) => !scale.has(t)),
        symbol: spell(root, key, roman.includes('♭')) + QUALITIES[quality].suf,
      };
    });
}

// Split the melody into chord-length windows. Window size scales with the
// singer's typical note spacing, and boundaries snap to nearby note onsets.
function makeWindows(notes, rhythm) {
  const onsets = notes.map((n) => n.start);
  const iois = [];
  for (let i = 1; i < onsets.length; i++) {
    const d = onsets[i] - onsets[i - 1];
    if (d > 0.06) iois.push(d);
  }
  iois.sort((a, b) => a - b);
  const med = iois.length ? iois[iois.length >> 1] : 0.5;

  const t0 = notes[0].start;
  const t1 = notes[notes.length - 1].end;
  const span = t1 - t0;
  let W = Math.min(4.5, Math.max(0.35, med * RHYTHM[rhythm]));
  const count = Math.max(1, Math.round(span / W));
  W = span / count;

  const bounds = [t0];
  for (let i = 1; i < count; i++) {
    const target = t0 + i * W;
    let best = target, bd = W * 0.35;
    for (const o of onsets) {
      const d = Math.abs(o - target);
      if (d < bd) { bd = d; best = o; }
    }
    const prev = bounds[bounds.length - 1];
    if (best <= prev + W * 0.3) best = target;
    if (best <= prev + 0.05 || best >= t1 - 0.05) continue;
    bounds.push(best);
  }
  bounds.push(t1);

  const wins = [];
  for (let i = 0; i < bounds.length - 1; i++) wins.push(windowOver(notes, bounds[i], bounds[i + 1]));
  return wins;
}

// The pitch classes sounding in [s, e], weighted by how long they sound.
function windowOver(notes, s, e) {
  const items = [];
  for (const n of notes) {
    const ov = Math.min(e, n.end) - Math.max(s, n.start);
    if (ov > 0) items.push({ pc: pc(n.midi), w: ov, start: n.start });
  }
  // The note sounding as the chord arrives matters most.
  if (items.length) {
    const lead = items.reduce((a, x) => (Math.abs(x.start - s) < Math.abs(a.start - s) ? x : a));
    lead.w *= 1.5;
  }
  const total = items.reduce((a, x) => a + x.w, 0);
  return { start: s, end: e, items, total };
}

// Best-fitting chords for an arbitrary stretch, e.g. after the user moves a chord.
export function rankChords(notes, key, vocab, start, end) {
  const scale = scalePcs(key);
  const win = windowOver(notes, start, end);
  const ranked = vocab.map((c) => ({ chord: c, score: emission(c, win, scale) })).sort((a, b) => b.score - a.score);
  return { ranked, pcs: [...new Set(win.items.map((it) => it.pc))] };
}

function emission(c, win, scale) {
  if (win.total <= 1e-6) return 0.25 * c.prior;
  let s = 0;
  for (const it of win.items) {
    let v;
    if (it.pc === c.root) v = 1.1;
    else if (c.tones.includes(it.pc)) v = it.pc === c.seventh ? 0.85 : 1;
    else if (scale.has(it.pc)) v = -0.3;
    else v = -0.7;
    s += v * it.w;
  }
  return s / win.total + 0.25 * c.prior - (c.tones.length > 3 ? 0.08 : 0) - (c.chromatic ? 0.05 : 0);
}

const FUNC_MOVES = { TS: 0.12, SD: 0.18, DT: 0.25, ST: 0.04, TD: 0.06, DS: -0.15, TT: -0.02, DD: 0.02, SS: 0 };

function transition(a, b) {
  if (a === b) return 0.05;
  let s = 0;
  const iv = (b.root - a.root + 12) % 12;
  if (iv === 5) s += 0.22;
  else if (iv === 2 || iv === 10) s += 0.06;
  else if (iv === 7) s += 0.04;
  if (a.root === b.root) s -= 0.05;
  return s + (FUNC_MOVES[a.func + b.func] || 0);
}

// Viterbi search over the chord vocabulary: each window's chord should fit the
// notes sung over it, and the sequence should move like a real progression.
export function harmonize(notes, key, { rhythm = 'medium', palette = 'simple' } = {}) {
  const vocab = buildVocab(key, palette);
  const scale = scalePcs(key);
  const wins = makeWindows(notes, rhythm);
  const E = wins.map((w) => vocab.map((c) => emission(c, w, scale)));
  const N = vocab.length, T = wins.length, TW = 0.7;
  const isTonic = (c) => c.deg === 0 && c.func === 'T';

  let prev = vocab.map((c, j) => E[0][j] + (isTonic(c) ? 0.3 : 0));
  const back = [];
  for (let t = 1; t < T; t++) {
    const cur = new Array(N), bp = new Array(N);
    const empty = wins[t].total <= 1e-6;
    for (let j = 0; j < N; j++) {
      let best = -Infinity, bi = 0;
      for (let i = 0; i < N; i++) {
        let v = prev[i] + TW * transition(vocab[i], vocab[j]);
        if (empty && i === j) v += 0.6;
        if (v > best) { best = v; bi = i; }
      }
      cur[j] = best + E[t][j];
      bp[j] = bi;
    }
    back.push(bp);
    prev = cur;
  }

  let end = 0, bestEnd = -Infinity;
  vocab.forEach((c, j) => {
    const v = prev[j] + (isTonic(c) ? 0.35 : c.deg === 7 && c.func === 'D' ? 0.1 : 0);
    if (v > bestEnd) { bestEnd = v; end = j; }
  });
  const path = new Array(T);
  path[T - 1] = end;
  for (let t = T - 1; t > 0; t--) path[t - 1] = back[t - 1][path[t]];

  const segments = [];
  path.forEach((j, t) => {
    const last = segments[segments.length - 1];
    if (last && last.chord.id === j) {
      last.end = wins[t].end;
      last.wins.push(t);
    } else {
      segments.push({ chord: vocab[j], start: wins[t].start, end: wins[t].end, wins: [t] });
    }
  });

  for (const seg of segments) {
    const ranked = vocab
      .map((c, j) => ({ chord: c, score: seg.wins.reduce((a, t) => a + E[t][j], 0) / seg.wins.length }))
      .sort((a, b) => b.score - a.score);
    const alts = ranked.slice(0, 6);
    if (!alts.some((a) => a.chord === seg.chord)) alts[alts.length - 1] = ranked.find((a) => a.chord === seg.chord);
    seg.alts = alts;
    const pcs = new Set();
    seg.wins.forEach((t) => wins[t].items.forEach((it) => pcs.add(it.pc)));
    seg.pcs = [...pcs];
  }

  return { vocab, segments };
}

// Estimates a beat grid from note onsets: for each candidate tempo, measure how
// tightly the onsets line up on that grid (circular mean of their phase), allowing
// for eighth-note subdivisions and favouring everyday tempos. Pass `bpm` to keep a
// tempo fixed and only find where its beats fall.
export function detectTempo(notes, bpm = null) {
  if (notes.length < 4) return null;
  const onsets = notes.map((n) => ({ t: n.start, w: Math.min(1, 0.4 + (n.end - n.start)) }));
  const align = (P) => {
    let sx = 0, sy = 0, sw = 0;
    for (const o of onsets) {
      const a = (2 * Math.PI * o.t) / P;
      sx += o.w * Math.cos(a);
      sy += o.w * Math.sin(a);
      sw += o.w;
    }
    return { r: Math.hypot(sx, sy) / sw, phase: (((Math.atan2(sy, sx) / (2 * Math.PI)) * P) % P + P) % P };
  };

  let best = null;
  for (let b = bpm ?? 50; b <= (bpm ?? 200); b += 0.5) {
    const P = 60 / b;
    const on = align(P);
    const prior = bpm ? 1 : Math.exp(-0.5 * (Math.log2(b / 105) / 0.6) ** 2);
    const score = (0.7 * on.r + 0.3 * align(P / 2).r) * prior;
    if (!best || score > best.score) best = { bpm: b, beat: P, phase: on.phase, r: on.r, score };
  }
  // Treat the beat nearest the first note as the first downbeat.
  const k = Math.round((notes[0].start - best.phase) / best.beat);
  return { bpm: best.bpm, beat: best.beat, downbeat: best.phase + k * best.beat, steady: best.r > 0.5 };
}

export function beatsBetween(tempo, start, end) {
  const out = [];
  for (let k = Math.ceil((start - tempo.downbeat) / tempo.beat - 1e-6); ; k++) {
    const t = tempo.downbeat + k * tempo.beat;
    if (t > end) break;
    out.push({ t, accent: ((k % 4) + 4) % 4 === 0 });
  }
  return out;
}

export function voicing(chord) {
  const bass = 36 + chord.root;
  const upper = chord.tones.map((p) => 55 + ((p - 7 + 12) % 12)).sort((a, b) => a - b);
  return [bass, ...upper];
}
