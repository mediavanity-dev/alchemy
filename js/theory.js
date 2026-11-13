// Music theory: key detection and melody harmonization.

const SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1]);
const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]);

// Key profiles: how often each degree of the scale turns up. Sung notes are scored
// against Temperley's profiles from the Essen folksong collection (Music and
// Probability, 2007), which describe single melodic lines; played chords against
// his Kostka–Payne profiles, which come from harmony.
const PROFILES = {
  melody: {
    major: [0.184, 0.001, 0.155, 0.003, 0.191, 0.109, 0.005, 0.214, 0.001, 0.078, 0.004, 0.055],
    minor: [0.192, 0.005, 0.149, 0.179, 0.002, 0.144, 0.002, 0.201, 0.038, 0.012, 0.053, 0.022],
  },
  chords: {
    major: [0.748, 0.06, 0.488, 0.082, 0.67, 0.46, 0.096, 0.715, 0.104, 0.366, 0.057, 0.4],
    minor: [0.712, 0.084, 0.474, 0.618, 0.049, 0.46, 0.105, 0.747, 0.404, 0.067, 0.133, 0.33],
  },
};
// Dorian is minor with a natural 6th and a flat 7th; Mixolydian is major with a flat
// 7th. The note that gives each mode its colour gets the weight of an ordinary
// scale note (the major 6th's, the minor 7th's), and the note it replaces becomes rare.
for (const set of Object.values(PROFILES)) {
  const dor = [...set.minor], mix = [...set.major];
  dor[9] = Math.max(set.major[9], set.minor[8]); dor[8] = Math.min(set.minor[8], set.minor[9]);
  dor[10] = Math.max(set.minor[10], set.minor[11]); dor[11] = Math.min(set.minor[10], set.minor[11]);
  mix[10] = Math.max(set.minor[10], set.major[11]); mix[11] = Math.min(set.major[10], set.major[11]);
  Object.assign(set, { dorian: dor, mixolydian: mix });
}
// As log probabilities, mixed with a little of the uniform distribution so a blue
// note or a chromatic passing note costs something but never rules a key out.
const LOGP = Object.fromEntries(Object.entries(PROFILES).map(([name, set]) => [name,
  Object.fromEntries(Object.entries(set).map(([mode, prof]) => {
    const sum = prof.reduce((a, b) => a + b, 0);
    return [mode, prof.map((v) => Math.log(0.9 * (v / sum) + 0.1 / 12))];
  }))]));
export const MODES = ['major', 'minor', 'dorian', 'mixolydian'];
// Starting odds (in log units): the modes have to be asked for by the notes, a few
// sung natural 6ths or flat 7ths, before they win over plain major or minor.
const MODE_PRIOR = { major: 0, minor: -0.2, dorian: -0.8, mixolydian: -0.8 };
// Where each mode's key signature comes from (its major scale), in semitones up from the tonic.
const PARENT = { major: 0, minor: 3, dorian: 10, mixolydian: 5 };

const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

const QUALITIES = {
  maj: { iv: [0, 4, 7], suf: '' },
  min: { iv: [0, 3, 7], suf: 'm' },
  dim: { iv: [0, 3, 6], suf: '°' },
  dom7: { iv: [0, 4, 7, 10], suf: '7' },
  maj7: { iv: [0, 4, 7, 11], suf: 'maj7' },
  m7: { iv: [0, 3, 7, 10], suf: 'm7' },
  m7b5: { iv: [0, 3, 6, 10], suf: 'ø7' },
  sus4: { iv: [0, 5, 7], suf: 'sus4' },
  add9: { iv: [0, 4, 7, 2], suf: 'add9' },
  madd9: { iv: [0, 3, 7, 2], suf: 'm(add9)' },
  maj6: { iv: [0, 4, 7, 9], suf: '6' },
};

// Chord sets, each including the ones before it.
export const PALETTES = ['triads', 'extended', 'chromatic'];
const TIER = { triads: 0, extended: 1, chromatic: 2, simple: 0, rich: 2 }; // simple/rich: older saves

// [degree, quality, roman, function (Tonic/Subdominant/Dominant), prior, tier]
// Saved takes refer to chords by position, so new entries only ever go at the end.
const VOCAB = {
  major: [
    [0, 'maj', 'I', 'T', 1.0], [2, 'min', 'ii', 'S', 0.7], [4, 'min', 'iii', 'T', 0.45],
    [5, 'maj', 'IV', 'S', 0.95], [7, 'maj', 'V', 'D', 0.95], [9, 'min', 'vi', 'T', 0.8],
    [11, 'dim', 'vii°', 'D', 0.15],
    [0, 'maj7', 'Imaj7', 'T', 0.6, 1], [2, 'm7', 'ii7', 'S', 0.6, 1], [4, 'm7', 'iii7', 'T', 0.3, 1],
    [5, 'maj7', 'IVmaj7', 'S', 0.55, 1], [7, 'dom7', 'V7', 'D', 0.75, 1], [9, 'm7', 'vi7', 'T', 0.5, 1],
    [5, 'min', 'iv', 'S', 0.4, 2], [8, 'maj', '♭VI', 'S', 0.3, 2], [10, 'maj', '♭VII', 'S', 0.4, 2],
    [2, 'dom7', 'V7/V', 'D', 0.35, 2], [4, 'dom7', 'V7/vi', 'D', 0.3, 2], [0, 'dom7', 'V7/IV', 'D', 0.25, 2],
    [0, 'sus4', 'Isus4', 'T', 0.3, 1], [7, 'sus4', 'Vsus4', 'D', 0.35, 1], [0, 'add9', 'Iadd9', 'T', 0.4, 1],
    [5, 'add9', 'IVadd9', 'S', 0.35, 1], [0, 'maj6', 'I6', 'T', 0.3, 1],
  ],
  minor: [
    [0, 'min', 'i', 'T', 1.0], [2, 'dim', 'ii°', 'S', 0.3], [3, 'maj', 'III', 'T', 0.6],
    [5, 'min', 'iv', 'S', 0.85], [7, 'min', 'v', 'D', 0.4], [7, 'maj', 'V', 'D', 0.85],
    [8, 'maj', 'VI', 'S', 0.8], [10, 'maj', 'VII', 'D', 0.7],
    [0, 'm7', 'i7', 'T', 0.55, 1], [2, 'm7b5', 'iiø7', 'S', 0.35, 1], [3, 'maj7', 'IIImaj7', 'T', 0.4, 1],
    [5, 'm7', 'iv7', 'S', 0.5, 1], [7, 'dom7', 'V7', 'D', 0.75, 1], [8, 'maj7', 'VImaj7', 'S', 0.5, 1],
    [5, 'maj', 'IV', 'S', 0.35, 2], [1, 'maj', '♭II', 'S', 0.2, 2],
    [7, 'sus4', 'Vsus4', 'D', 0.35, 1], [0, 'madd9', 'i(add9)', 'T', 0.35, 1], [8, 'add9', 'VIadd9', 'S', 0.3, 1],
  ],
  // The major IV is what makes Dorian sound Dorian (i – IV, as in so much funk and folk).
  dorian: [
    [0, 'min', 'i', 'T', 1.0], [2, 'min', 'ii', 'S', 0.45], [3, 'maj', '♭III', 'T', 0.55],
    [5, 'maj', 'IV', 'S', 0.95], [7, 'min', 'v', 'D', 0.6], [9, 'dim', 'vi°', 'S', 0.1],
    [10, 'maj', '♭VII', 'D', 0.8],
    [0, 'm7', 'i7', 'T', 0.65, 1], [5, 'dom7', 'IV7', 'S', 0.55, 1], [2, 'm7', 'ii7', 'S', 0.4, 1],
    [3, 'maj7', '♭IIImaj7', 'T', 0.4, 1], [7, 'm7', 'v7', 'D', 0.4, 1], [0, 'madd9', 'i(add9)', 'T', 0.35, 1],
    [7, 'maj', 'V', 'D', 0.35, 2], [8, 'maj', '♭VI', 'S', 0.25, 2], [5, 'min', 'iv', 'S', 0.25, 2],
  ],
  // The flat VII is Mixolydian's signature (I – ♭VII – IV).
  mixolydian: [
    [0, 'maj', 'I', 'T', 1.0], [2, 'min', 'ii', 'S', 0.5], [4, 'dim', 'iii°', 'T', 0.1],
    [5, 'maj', 'IV', 'S', 0.9], [7, 'min', 'v', 'D', 0.6], [9, 'min', 'vi', 'T', 0.5],
    [10, 'maj', '♭VII', 'S', 0.9],
    [0, 'dom7', 'I7', 'T', 0.6, 1], [7, 'm7', 'v7', 'D', 0.4, 1], [2, 'm7', 'ii7', 'S', 0.4, 1],
    [5, 'maj7', 'IVmaj7', 'S', 0.4, 1], [10, 'maj7', '♭VIImaj7', 'S', 0.35, 1], [0, 'sus4', 'Isus4', 'T', 0.3, 1],
    [0, 'add9', 'Iadd9', 'T', 0.35, 1],
    [7, 'maj', 'V', 'D', 0.4, 2], [3, 'maj', '♭III', 'S', 0.25, 2], [5, 'min', 'iv', 'S', 0.3, 2],
  ],
};

// How often the chord can change ("harmonic rhythm"): every 2 bars, every bar,
// every half bar or every beat. Older saves used slow / medium / fast.
export const RATES = ['2bar', 'bar', 'half', 'beat'];
const LEGACY_RATE = { slow: '2bar', medium: 'bar', fast: 'half' };
export const rateOf = (r) => LEGACY_RATE[r] ?? (RATES.includes(r) ? r : 'bar');
// Half bars for each bar length (odd meters split long-short)
const HALF_GROUPS = { 2: [1, 1], 3: [2, 1], 4: [2, 2], 5: [3, 2], 6: [3, 3], 7: [4, 3] };
// Without any beat grid: chord length in multiples of the typical note spacing.
const NOTES_PER_CHORD = { '2bar': 8, bar: 4, half: 2, beat: 1 };
// A change inside the bar has to be asked for a little by the notes: more on a
// minor beat than at the half bar. Bar lines are free.
const HOLD = { half: 0.12, beat: 0.25 };
const COLOR_UNSUNG = 0.15;
const PLAYED_WEIGHT = 1.5; // played chords outweigh what the melody alone suggests
const PASS_WEIGHT = 0.35;

export const pc = (m) => ((Math.round(m) % 12) + 12) % 12;

export function spell(p, key, preferFlat = false) {
  const flats = preferFlat || (key && (
    key.mode === 'major' ? FLAT_MAJOR.has(key.tonic)
      : key.mode === 'minor' ? FLAT_MINOR.has(key.tonic)
      : FLAT_MAJOR.has((key.tonic + PARENT[key.mode]) % 12)));
  return (flats ? FLAT : SHARP)[((p % 12) + 12) % 12];
}

export const keyName = (key) => `${spell(key.tonic, key)} ${key.mode}`;
export const noteLabel = (m, key) => spell(pc(m), key) + (Math.floor(Math.round(m) / 12) - 1);
export const scalePcs = (key) => new Set(SCALES[key.mode].map((d) => (key.tonic + d) % 12));

// All keys (12 tonics in each mode) ranked, each with a probability `p`.
// Scored as how likely the notes are under each key's profile (each note counting
// about once, long ones up to twice), plus the pull of ending (and starting) on the
// home note. `played`: chroma from instrument layers (see sound.js), scored
// against the harmony profiles.
export function detectKeys(notes, played = []) {
  const mel = new Array(12).fill(0), harm = new Array(12).fill(0);
  const durs = notes.map((n) => n.end - n.start).sort((a, b) => a - b);
  const med = durs[durs.length >> 1] || 0.3;
  for (const n of notes) mel[pc(n.midi)] += Math.min(2, Math.max(0.5, (n.end - n.start) / med));
  for (const src of played) {
    for (const f of src.frames) {
      let sum = 0;
      for (let k = 0; k < 12; k++) sum += f[k];
      // A sounding chord counts as about one note every half second, shared among its notes.
      if (sum > 0) for (let k = 0; k < 12; k++) harm[k] += (f[k] / sum) * (src.hop / 0.5);
    }
  }
  const first = notes.length ? pc(notes[0].midi) : -1;
  const last = notes.length ? pc(notes[notes.length - 1].midi) : -1;

  const keys = [];
  for (let t = 0; t < 12; t++) {
    for (const mode of MODES) {
      const lm = LOGP.melody[mode], lh = LOGP.chords[mode];
      let r = 0;
      for (let k = 0; k < 12; k++) {
        const d = (k - t + 12) % 12;
        r += mel[k] * lm[d] + harm[k] * lh[d];
      }
      if (last === t) r += 1;
      if (first === t) r += 0.4;
      keys.push({ tonic: t, mode, r });
    }
  }
  // Notes in a tune aren't independent, so the evidence is tempered before it
  // becomes a probability; otherwise every long take would claim certainty. The
  // modes' starting odds apply after that, so they hold however long the take.
  const weight = mel.reduce((a, b) => a + b, 0) + harm.reduce((a, b) => a + b, 0);
  const temp = Math.max(1, 0.5 * Math.sqrt(weight));
  for (const k of keys) k.r = k.r / temp + MODE_PRIOR[k.mode];
  keys.sort((a, b) => b.r - a.r);
  const top = keys[0].r;
  let sum = 0;
  for (const k of keys) { k.p = Math.exp(k.r - top); sum += k.p; }
  for (const k of keys) k.p /= sum;
  return keys;
}

// Every chord the key offers, indexed by id; `choices` picks the palette's subset.
function buildVocab(key) {
  const scale = scalePcs(key);
  return VOCAB[key.mode].map(([deg, quality, roman, func, prior, tier = 0], id) => {
    const root = (key.tonic + deg) % 12;
    const iv = QUALITIES[quality].iv;
    const tones = iv.map((x) => (root + x) % 12);
    return {
      id, deg, root, quality, roman, func, prior, tier, tones,
      color: iv.length > 3 ? tones[3] : null, // the 7th, 6th or 9th on top of the triad
      chromatic: tones.some((t) => !scale.has(t)),
      symbol: spell(root, key, roman.includes('♭')) + QUALITIES[quality].suf,
    };
  });
}

const choicesFor = (vocab, palette) => vocab.filter((c) => c.tier <= (TIER[palette] ?? 0));

// How much each note counts towards choosing a chord, and whether it can be heard
// as a passing or neighbour note (short, stepped into and out of) rather than
// something the chord has to contain. With a beat grid, notes on strong beats count
// more and passing notes can't fall on the downbeat.
function annotate(notes, tempo) {
  const durs = notes.map((n) => n.end - n.start).sort((a, b) => a - b);
  const medDur = durs[durs.length >> 1] || 0.3;
  const per = tempo ? barBeats(tempo.meter) : 0;
  return notes.map((n, i) => {
    const prev = notes[i - 1], next = notes[i + 1];
    const dur = n.end - n.start;
    const step = (a) => a && Math.abs(a.midi - n.midi) >= 0.5 && Math.abs(a.midi - n.midi) <= 2.5;
    let accent = 1, downbeat = false;
    if (tempo) {
      const pos = (n.start - tempo.downbeat) / tempo.beat;
      const k = Math.round(pos);
      const idx = ((k % per) + per) % per;
      if (Math.abs(pos - k) > 0.2) accent = 0.75;
      else if (idx === 0) { accent = 1.4; downbeat = true; }
      else if (per % 2 === 0 && idx === per / 2) accent = 1.15;
    }
    const pass = !downbeat && dur <= medDur * 1.2 && step(prev) && step(next) &&
      n.start - prev.end < 0.25 && next.start - n.end < 0.25;
    return { pc: pc(n.midi), start: n.start, end: n.end, accent, pass, long: dur >= medDur * 1.8 };
  });
}

// Split the melody into chord-length windows. Window size scales with the
// singer's typical note spacing, and boundaries snap to where a played instrument
// changes chord, or else to nearby note onsets.
function makeWindows(notes, rhythm, [t0, t1], changes = []) {
  const onsets = notes.map((n) => n.start);
  const iois = [];
  for (let i = 1; i < onsets.length; i++) {
    const d = onsets[i] - onsets[i - 1];
    if (d > 0.06) iois.push(d);
  }
  iois.sort((a, b) => a - b);
  const med = iois.length ? iois[iois.length >> 1] : 0.5;

  const span = t1 - t0;
  let W = Math.min(6, Math.max(0.3, med * NOTES_PER_CHORD[rhythm]));
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
    let cd = W * 0.5;
    for (const c of changes) {
      const d = Math.abs(c - target);
      if (d < cd) { cd = d; best = c; }
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

// On a beat grid the chord can change every two bars, every bar, every half bar or
// every beat. Each window knows where it starts: on a bar line (0), at the half bar
// (1) or on another beat (2). A pickup before the first full chord, or a sliver
// after the last, joins its neighbour.
function makeGridWindows(notes, rhythm, tempo, [t0, t1]) {
  const per = barBeats(tempo.meter);
  const groups = rhythm === '2bar' ? [per * 2] : rhythm === 'half' ? HALF_GROUPS[per] ?? [per]
    : rhythm === 'beat' ? Array(per).fill(1) : [per];
  const half = (HALF_GROUPS[per] ?? [per])[0];
  const cycle = groups.reduce((a, b) => a + b, 0) * tempo.beat;
  const minLen = Math.min(...groups) * tempo.beat * 0.5;

  const bounds = [t0], level = new Map();
  let c = tempo.downbeat + Math.floor((t0 - tempo.downbeat) / cycle) * cycle;
  for (; c < t1; c += cycle) {
    let at = 0; // beats into the cycle
    for (const g of groups) {
      const t = c + at * tempo.beat;
      if (t > t0 + minLen && t < t1 - minLen) {
        bounds.push(t);
        const inBar = at % per;
        level.set(t, inBar === 0 ? 0 : inBar === half ? 1 : 2);
      }
      at += g;
    }
  }
  bounds.push(t1);

  const wins = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    wins.push({ ...windowOver(notes, bounds[i], bounds[i + 1]), level: level.get(bounds[i]) ?? 0 });
  }
  return wins;
}

// The pitch classes sounding in [s, e], weighted by how long they sound and how
// strong a beat they start on.
function windowOver(notes, s, e) {
  const items = [];
  for (const n of notes) {
    const ov = Math.min(e, n.end) - Math.max(s, n.start);
    if (ov > 0) items.push({ ...n, w: ov * (n.accent ?? 1) * (n.pass ? PASS_WEIGHT : 1) });
  }
  // The note sounding as the chord arrives matters most, unless it's only passing through.
  if (items.length) {
    const lead = items.reduce((a, x) => (Math.abs(x.start - s) < Math.abs(a.start - s) ? x : a));
    if (!lead.pass) lead.w *= 1.5;
  }
  const total = items.reduce((a, x) => a + x.w, 0);
  return { start: s, end: e, items, total };
}

// Best-fitting chords for an arbitrary stretch, e.g. after the user moves a chord.
export function rankChords(notes, key, vocab, start, end, { palette = 'triads', tempo = null, played = [] } = {}) {
  const scale = scalePcs(key);
  const win = { ...windowOver(annotate(notes, tempo), start, end), played: playedOver(played, start, end) };
  const ranked = choicesFor(vocab, palette)
    .map((c) => ({ chord: c, score: emission(c, win, scale) }))
    .sort((a, b) => b.score - a.score);
  return { ranked, pcs: [...new Set(win.items.map((it) => it.pc))] };
}

// Average chroma of the instrument layers over [s, e], and how much of that stretch
// actually had something playing.
function playedOver(played, s, e) {
  const vec = new Float32Array(12);
  let on = 0, all = 0;
  for (const src of played) {
    const a = Math.max(0, Math.ceil((s - src.t0) / src.hop)), b = Math.min(src.frames.length - 1, Math.floor((e - src.t0) / src.hop));
    for (let i = a; i <= b; i++) {
      const f = src.frames[i];
      all++;
      if (f.some((v) => v > 0)) on++;
      for (let k = 0; k < 12; k++) vec[k] += f[k];
    }
  }
  if (!on) return null;
  const mx = Math.max(...vec);
  for (let k = 0; k < 12; k++) vec[k] /= mx;
  return { vec, cover: on / Math.max(all, 1) };
}

// Where the played chroma shifts to a different set of notes: chord changes.
function changePoints(played) {
  const out = [];
  const mean = (frames, a, b) => {
    const v = new Float32Array(12);
    for (let i = Math.max(0, a); i < Math.min(frames.length, b); i++) for (let k = 0; k < 12; k++) v[k] += frames[i][k];
    return v;
  };
  const cos = (a, b) => {
    let d = 0, na = 0, nb = 0;
    for (let k = 0; k < 12; k++) { d += a[k] * b[k]; na += a[k] * a[k]; nb += b[k] * b[k]; }
    return na && nb ? d / Math.sqrt(na * nb) : 1;
  };
  for (const src of played) {
    const nov = src.frames.map((_, i) => 1 - cos(mean(src.frames, i - 3, i), mean(src.frames, i, i + 3)));
    nov.forEach((v, i) => {
      if (v > 0.2 && v >= (nov[i - 1] ?? 0) && v > (nov[i + 1] ?? 0)) out.push(src.t0 + (i - 0.5) * src.hop);
    });
  }
  return out.sort((a, b) => a - b);
}

// How well a chord matches what was played: cosine similarity between the chroma
// and the chord's notes, centred so a typical wrong chord scores below zero.
function playedFit(c, vec) {
  let dot = 0, norm = 0;
  for (let k = 0; k < 12; k++) norm += vec[k] * vec[k];
  for (const t of c.tones) dot += vec[t];
  return (dot / Math.sqrt(norm * c.tones.length) - 0.62) * 3;
}

function emission(c, win, scale) {
  const fit = win.played ? PLAYED_WEIGHT * win.played.cover * playedFit(c, win.played.vec) : 0;
  if (win.total <= 1e-6) return 0.25 * c.prior + fit - (c.tones.length > 3 ? 0.08 : 0) - (c.chromatic ? 0.05 : 0);
  let s = 0, colorW = 0;
  // A 7th, 6th or 9th (or a sus 4th) should be there because the melody sings it.
  const special = c.color ?? (c.quality === 'sus4' ? c.tones[1] : null);
  for (const it of win.items) {
    let v;
    if (it.pc === special) colorW += it.w;
    if (it.pc === c.root) v = 1.1;
    else if (c.tones.includes(it.pc)) v = it.pc === c.color ? 0.85 : 1;
    else if (it.pass) v = scale.has(it.pc) ? -0.05 : -0.25;
    else if (scale.has(it.pc)) {
      // A long note a semitone off a chord tone rubs; other non-chord notes are milder.
      const rub = c.tones.some((t) => (it.pc - t + 12) % 12 === 1 || (t - it.pc + 12) % 12 === 1);
      v = it.long && rub ? -0.55 : -0.3;
    } else v = -0.7;
    s += v * it.w;
  }
  // Played chords can justify the extra note on their own.
  const unsung = special != null && colorW < 0.15 * win.total && !(win.played && win.played.vec[special] > 0.5) ? COLOR_UNSUNG : 0;
  return s / win.total + 0.25 * c.prior + fit - (c.tones.length > 3 ? 0.08 : 0) - unsung - (c.chromatic ? 0.05 : 0);
}

// Function-to-function moves (Tonic, Subdominant, Dominant). Pop and rock use V – IV
// freely (de Clercq & Temperley's rock corpus), so it is only a whisker below neutral.
const FUNC_MOVES = { TS: 0.12, SD: 0.18, DT: 0.25, ST: 0.06, TD: 0.06, DS: -0.03, TT: -0.02, DD: 0.02, SS: 0 };

function transition(a, b) {
  if (a === b) return 0.05;
  let s = 0;
  const iv = (b.root - a.root + 12) % 12;
  // Roots moving by fourths and fifths are the most common changes of all, then steps.
  if (iv === 5) s += 0.22;
  else if (iv === 7) s += 0.12;
  else if (iv === 2 || iv === 10) s += 0.06;
  if (a.root === b.root) s -= 0.05;
  return s + (FUNC_MOVES[a.func + b.func] || 0);
}

// Three-chord moves heard so often they're worth a nudge, by scale degree and
// chord type ('m' minor, 'd' diminished; 7ths and colours count as their triad).
const IDIOMS = {
  major: ['0 5 7', '5 7 0', '2m 7 0', '0 7 9m', '7 9m 5', '9m 5 0', '0 9m 5', '9m 5 7', '5 0 7', '0 9m 2m',
    '9m 2m 7', '0 10 5', '10 5 0', '5 5m 0', '4m 9m 2m', '0 4m 5', '7 5 0', '0 5 0', '0 7 0', '2 7 0'],
  minor: ['0m 5m 7', '5m 7 0m', '0m 8 10', '8 10 0m', '0m 10 8', '10 8 7', '0m 8 3', '8 3 10', '3 10 0m',
    '2d 7 0m', '0m 5m 0m', '0m 7 0m', '0m 3 10', '5m 10 3', '8 7 0m', '0m 10 0m'],
  dorian: ['0m 5 0m', '0m 10 5', '10 5 0m', '0m 3 5', '0m 5 10', '5 10 0m', '0m 2m 0m', '0m 7m 0m', '3 10 0m'],
  mixolydian: ['0 10 5', '10 5 0', '0 10 0', '0 5 10', '5 10 0', '0 7m 5', '0 10 7m'],
};
const IDIOM_SETS = Object.fromEntries(Object.entries(IDIOMS).map(([m, l]) => [m, new Set(l)]));
const IDIOM_BONUS = 0.15;
const triadId = (c) => `${c.deg}${{ min: 'm', m7: 'm', madd9: 'm', dim: 'd', m7b5: 'd' }[c.quality] ?? ''}`;

// Viterbi search over the chord vocabulary: each window's chord should fit the
// notes sung over it, and the sequence should move like a real progression. The
// search remembers the chord before the current one, so familiar three-chord moves
// can be favoured.
// A tempo from a count-in or set by hand is trusted as is; a detected one is too
// for the beat, but which beat starts the bar is tried every way.
// `played`: chroma from instrument layers whose chords should guide the choice.
// Returns the best progression, plus up to `ideas` - 1 different ones in
// `alternatives` (the best one first).
export function harmonize(notes, key, { rhythm: rate = 'bar', palette = 'triads', tempo = null, played = [], ideas = 4, span = null } = {}) {
  const rhythm = rateOf(rate);
  const all = buildVocab(key);
  const vocab = choicesFor(all, palette);
  const scale = scalePcs(key);
  // The harmony covers the melody and any stretch where an instrument plays on its own.
  let t0 = notes.length ? notes[0].start : Infinity, t1 = notes.length ? notes[notes.length - 1].end : -Infinity;
  for (const src of played) {
    const on = src.frames.map((f, i) => (f.some((v) => v > 0) ? src.t0 + i * src.hop : null)).filter((t) => t != null);
    if (on.length) { t0 = Math.min(t0, on[0]); t1 = Math.max(t1, on[on.length - 1] + src.hop); }
  }
  // A beat with no tune yet (beatbox): progressions in the key across its length.
  if (span) { t0 = Math.min(t0, span[0]); t1 = Math.max(t1, span[1]); }
  if (!(t1 > t0)) return { vocab: all, segments: [], alternatives: [], downbeat: null };
  if (!notes.length && !played.length) return loopHarmony(all, vocab, key, rhythm, tempo, [t0, t1]);
  const changes = changePoints(played);
  const idioms = IDIOM_SETS[key.mode];

  const attempt = (tp) => {
    const ann = annotate(notes, tp);
    const wins = (tp ? makeGridWindows(ann, rhythm, tp, [t0, t1]) : makeWindows(ann, rhythm, [t0, t1], changes))
      .map((w) => ({ ...w, played: playedOver(played, w.start, w.end) }));
    const E = wins.map((w) => vocab.map((c) => emission(c, w, scale)));
    const ties = tieRepeats(E, wins, ann);
    const best = decode(E, wins, vocab, idioms);
    best.path = repeatChords(best.path, ties);
    return { tp, wins, E, ties, best };
  };
  const trusted = tempo && (tempo.source === 'countin' || tempo.manual);
  const run = attempt(tempo && !trusted ? { ...tempo, downbeat: findDownbeat(notes, tempo) } : tempo);
  const { wins, E, ties } = run;

  // Other ideas: search again with the chords already suggested for each window
  // made a little less attractive, keeping results that differ for at least a
  // quarter of the time from every idea so far, and use a different set of chords
  // (the same chords in another order read as the same progression).
  const chordSet = (path) => [...new Set(path.map((j) => vocab[j].symbol))].sort().join(' ');
  const paths = [run.best.path];
  const used = wins.map(() => new Float32Array(vocab.length));
  let last = run.best.path;
  for (let tries = 0; paths.length < ideas && tries < ideas * 3; tries++) {
    last.forEach((j, t) => (used[t][j] += 1));
    const E2 = E.map((row, t) => row.map((v, j) => v - 0.45 * used[t][j]));
    last = repeatChords(decode(E2, wins, vocab, idioms).path, ties);
    const span = (p, q) => p.reduce((a, j, t) => a + (j === q[t] ? 0 : wins[t].end - wins[t].start), 0);
    if (paths.every((p) => span(p, last) >= 0.25 * (t1 - t0) && chordSet(p) !== chordSet(last))) paths.push(last);
  }

  const toSegments = (path) => {
    const segments = [];
    path.forEach((j, t) => {
      const prev = segments[segments.length - 1];
      if (prev && prev.chord === vocab[j]) {
        prev.end = wins[t].end;
        prev.wins.push(t);
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
    return segments;
  };
  const alternatives = paths.map(toSegments);
  return { vocab: all, segments: alternatives[0], alternatives, downbeat: run.tp?.downbeat ?? null };
}

// Four-chord loops for a beat with no tune to follow: [scale degree, triad, richer chord].
const LOOPS = {
  major: [
    [[0, 'maj', 'maj7'], [7, 'maj', 'dom7'], [9, 'min', 'm7'], [5, 'maj', 'maj7']], // I V vi IV
    [[9, 'min', 'm7'], [5, 'maj', 'maj7'], [0, 'maj', 'maj7'], [7, 'maj', 'dom7']], // vi IV I V
    [[0, 'maj', 'maj7'], [9, 'min', 'm7'], [5, 'maj', 'maj7'], [7, 'maj', 'dom7']], // I vi IV V
    [[0, 'maj', 'maj7'], [5, 'maj', 'maj7'], [9, 'min', 'm7'], [7, 'maj', 'dom7']], // I IV vi V
  ],
  minor: [
    [[0, 'min', 'm7'], [8, 'maj', 'maj7'], [3, 'maj', 'maj7'], [10, 'maj', 'maj']], // i VI III VII
    [[0, 'min', 'm7'], [10, 'maj', 'maj'], [8, 'maj', 'maj7'], [10, 'maj', 'maj']], // i VII VI VII
    [[0, 'min', 'm7'], [5, 'min', 'm7'], [0, 'min', 'm7'], [7, 'maj', 'dom7']], // i iv i V
    [[0, 'min', 'm7'], [5, 'min', 'm7'], [10, 'maj', 'maj'], [3, 'maj', 'maj7']], // i iv VII III
  ],
  dorian: [
    [[0, 'min', 'm7'], [5, 'maj', 'dom7'], [0, 'min', 'm7'], [5, 'maj', 'dom7']], // i IV i IV
    [[0, 'min', 'm7'], [10, 'maj', 'maj'], [5, 'maj', 'dom7'], [0, 'min', 'm7']], // i VII IV i
    [[0, 'min', 'm7'], [3, 'maj', 'maj7'], [5, 'maj', 'dom7'], [0, 'min', 'm7']], // i III IV i
    [[0, 'min', 'm7'], [2, 'min', 'm7'], [5, 'maj', 'dom7'], [0, 'min', 'm7']], // i ii IV i
  ],
  mixolydian: [
    [[0, 'maj', 'dom7'], [10, 'maj', 'maj'], [5, 'maj', 'maj7'], [0, 'maj', 'dom7']], // I VII IV I
    [[0, 'maj', 'dom7'], [10, 'maj', 'maj'], [0, 'maj', 'dom7'], [10, 'maj', 'maj']], // I VII I VII
    [[0, 'maj', 'dom7'], [7, 'min', 'm7'], [5, 'maj', 'maj7'], [0, 'maj', 'dom7']], // I v IV I
    [[0, 'maj', 'dom7'], [5, 'maj', 'maj7'], [10, 'maj', 'maj'], [5, 'maj', 'maj7']], // I IV VII IV
  ],
};

// Chords for a beat on its own (beatbox, say): familiar loops in the key, one chord
// per window of the chosen rate. Each loop is one of the progressions on offer.
function loopHarmony(all, vocab, key, rhythm, tempo, [t0, t1]) {
  const rich = vocab.some((c) => c.color != null);
  const find = (deg, q) => vocab.find((c) => c.deg === deg && c.quality === q && !c.chromatic)
    ?? all.find((c) => c.deg === deg && c.quality === q && !c.chromatic);
  const minorish = ['minor', 'dorian', 'phrygian', 'aeolian'].includes(key.mode) || vocab.find((c) => c.deg === 0)?.quality === 'min';
  // Without a beat grid: even windows of about two seconds.
  const n = Math.max(1, Math.round((t1 - t0) / 2));
  const wins = tempo
    ? makeGridWindows([], rhythm, tempo, [t0, t1])
    : Array.from({ length: n }, (_, i) => ({ start: t0 + ((t1 - t0) * i) / n, end: t0 + ((t1 - t0) * (i + 1)) / n }));
  const byPrior = [...vocab].sort((a, b) => b.prior - a.prior);
  const alternatives = [];
  for (const loop of LOOPS[key.mode] ?? LOOPS[minorish ? 'minor' : 'major']) {
    const chords = loop.map(([deg, tri, ext]) => (rich && find(deg, ext)) || find(deg, tri));
    if (chords.some((c) => !c)) continue;
    const segments = wins.map((w, i) => {
      const chord = chords[i % chords.length];
      const alts = byPrior.filter((c) => c !== chord).slice(0, 5).map((c) => ({ chord: c, score: 0 }));
      return { chord, start: w.start, end: w.end, wins: [i], alts: [{ chord, score: 0 }, ...alts], pcs: [] };
    });
    alternatives.push(segments);
  }
  if (!alternatives.length) return { vocab: all, segments: [], alternatives: [], downbeat: null };
  return { vocab: all, segments: alternatives[0], alternatives, downbeat: tempo?.downbeat ?? null };
}

// Which beat of a detected beat grid starts the bar. Long notes, and above all the
// last note of a phrase, tend to land on strong beats (the evidence Temperley's
// meter model rests on), so each choice is scored by how much note length lands on
// downbeats and half bars. Moving the bar line is a strong claim (a tune whose long
// notes fall on beat 3 reads almost as well a half bar later), so the first guess,
// the beat the singing starts on, stands unless another is clearly better: a
// pickup into the first bar, typically.
function findDownbeat(notes, tempo) {
  const per = barBeats(tempo.meter);
  let best = tempo.downbeat, bestScore = -Infinity, first = 0;
  for (let s = 0; s < per; s++) {
    const db = tempo.downbeat + s * tempo.beat;
    let score = 0;
    notes.forEach((n, i) => {
      const pos = (n.start - db) / tempo.beat, k = Math.round(pos);
      if (Math.abs(pos - k) > 0.2) return;
      const idx = ((k % per) + per) % per;
      const strength = idx === 0 ? 1 : per % 2 === 0 && idx === per / 2 ? 0.5 : per % 3 === 0 && idx % 3 === 0 ? 0.5 : 0.15;
      const w = Math.min(4, (n.end - n.start) / tempo.beat) * (i === notes.length - 1 ? 2 : 1);
      score += w * strength;
    });
    if (s === 0) first = score;
    if (score > bestScore) { bestScore = score; best = db; }
  }
  return bestScore > first * 1.3 ? best : tempo.downbeat;
}

// Second-order Viterbi. A state is (the chord before, the current chord); holding a
// chord keeps the state, changing moves it on, and a change that completes a
// familiar three-chord move earns IDIOM_BONUS.
function decode(E, wins, vocab, idioms) {
  const N = vocab.length, T = wins.length, P = N + 1; // previous chord N = none yet
  const S = P * N, TW = 0.4;
  const isTonic = (c) => c.deg === 0 && c.func === 'T';
  const ids = vocab.map(triadId);
  const trans = vocab.map((a) => vocab.map((b) => TW * transition(a, b)));
  const tri = (p, c, n) => (p < N && idioms?.has(`${ids[p]} ${ids[c]} ${ids[n]}`) ? TW * IDIOM_BONUS : 0);

  let prev = new Float64Array(S).fill(-Infinity), cur = new Float64Array(S);
  for (let c = 0; c < N; c++) prev[N * N + c] = E[0][c] + (isTonic(vocab[c]) ? 0.3 : 0);
  const back = new Int32Array(T * S).fill(-1);
  for (let t = 1; t < T; t++) {
    cur.fill(-Infinity);
    const empty = wins[t].total <= 1e-6 && !wins[t].played;
    // Changes inside the bar need the notes to ask for them a little.
    const hold = (empty ? 0.6 : 0) + (wins[t].level ? (wins[t].level === 1 ? HOLD.half : HOLD.beat) : 0);
    for (let s = 0; s < S; s++) {
      const v = prev[s];
      if (v === -Infinity) continue;
      const p = Math.floor(s / N), c = s % N;
      const stay = v + trans[c][c] + hold + E[t][c];
      if (stay > cur[s]) { cur[s] = stay; back[t * S + s] = s; }
      for (let n = 0; n < N; n++) {
        if (n === c) continue;
        const to = c * N + n;
        const w = v + trans[c][n] + tri(p, c, n) + E[t][n];
        if (w > cur[to]) { cur[to] = w; back[t * S + to] = s; }
      }
    }
    [prev, cur] = [cur, prev];
  }

  let end = 0, score = -Infinity;
  for (let s = 0; s < S; s++) {
    if (prev[s] === -Infinity) continue;
    const c = vocab[s % N];
    const v = prev[s] + (isTonic(c) ? 0.35 : c.deg === 7 && c.func === 'D' ? 0.1 : 0);
    if (v > score) { score = v; end = s; }
  }
  const path = new Array(T);
  for (let t = T - 1, s = end; t >= 0; t--) {
    path[t] = s % N;
    s = back[t * S + s];
  }
  return { path, score };
}

// A phrase sung again usually wants the same chords again. Where the melody
// repeats (the same notes in the same rhythm, six or more of them, over a couple
// of seconds), the windows that line up are given the same, pooled evidence.
// Returns the groups of windows that line up, earliest first.
function tieRepeats(E, wins, notes) {
  const N = notes.length;
  if (N < 12 || wins.length < 4) return [];
  const ioi = (i) => (i + 1 < N ? notes[i + 1].start - notes[i].start : null);
  const same = (i, j) => {
    if (notes[i].pc !== notes[j].pc) return false;
    const a = ioi(i), b = ioi(j);
    return a == null || b == null || Math.abs(Math.log(a / b)) < 0.35;
  };
  const parent = wins.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const winAt = (t) => wins.findIndex((w) => t >= w.start && t < w.end);
  let tied = false;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      if (!same(i, j) || (i > 0 && same(i - 1, j - 1))) continue; // only from where a match begins
      let L = 0;
      while (j + L < N && i + L < j && same(i + L, j + L)) L++;
      if (L < 6 || notes[j + L - 1].end - notes[j].start < 2) continue;
      const shift = notes[j].start - notes[i].start, from = notes[j].start, to = notes[j + L - 1].end;
      wins.forEach((w, b) => {
        const mid = (w.start + w.end) / 2;
        if (mid < from || mid > to) return;
        const a = winAt(mid - shift);
        const len = w.end - w.start;
        if (a < 0 || a === b || Math.abs(wins[a].end - wins[a].start - len) > 0.3 * len) return;
        parent[find(a)] = find(b);
        tied = true;
      });
    }
  }
  if (!tied) return [];
  const groups = new Map();
  wins.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const avg = E[g[0]].map((_, j) => g.reduce((a, t) => a + E[t][j], 0) / g.length);
    for (const t of g) E[t] = avg.slice();
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort((a, b) => a - b));
}

// Windows that line up across a repeat take the chord chosen the first time
// through. The very last window stays free, so the end can still come home.
function repeatChords(path, ties) {
  if (!ties.length) return path;
  const out = path.slice();
  for (const g of ties) for (const t of g.slice(1)) if (t !== out.length - 1) out[t] = out[g[0]];
  return out;
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

// Time signatures on offer. The tempo counts the pulse (quarters, or eighths in x/8),
// so a bar is simply the top number of beats.
export const METERS = ['2/4', '3/4', '4/4', '5/4', '6/8', '7/8'];
export const barBeats = (meter) => parseInt(meter ?? '4/4', 10) || 4;

export function beatsBetween(tempo, start, end) {
  const out = [];
  const n = barBeats(tempo.meter);
  for (let k = Math.ceil((start - tempo.downbeat) / tempo.beat - 1e-6); ; k++) {
    const t = tempo.downbeat + k * tempo.beat;
    if (t > end) break;
    out.push({ t, accent: ((k % n) + n) % n === 0 });
  }
  return out;
}

export function voicing(chord) {
  const bass = 36 + chord.root;
  const upper = chord.tones.map((p) => 55 + ((p - 7 + 12) % 12)).sort((a, b) => a - b);
  return [bass, ...upper];
}

// Bass notes for a progression: the root, except where the chord's third makes a
// stepwise line between the chords either side (C – G/B – Am), the commonest
// reason for an inversion. Returns a pitch class per chord.
export function bassLine(chords) {
  const step = (a, b) => {
    const d = ((b - a + 18) % 12) - 6;
    return Math.abs(d) >= 1 && Math.abs(d) <= 2 ? Math.sign(d) : 0;
  };
  const out = [];
  chords.forEach((c, i) => {
    const p = out[i - 1], n = chords[i + 1]?.root;
    let bass = c.root;
    const third = c.quality === 'sus4' ? null : c.tones[1];
    if (p != null && n != null && third != null && chords[i - 1] !== c && chords[i + 1] !== c) {
      const a = step(p, third), b = step(third, n);
      if (a && a === b && !(step(p, c.root) && step(c.root, n))) bass = third;
    }
    out.push(bass);
  });
  return out;
}

// Voicings for a whole progression: the bass (from bassLine) low, and the upper
// notes moving as little as possible from one chord to the next, the way a
// keyboard player would play them.
export function voiceLead(chords, basses = chords.map((c) => c.root)) {
  let prev = null, lastBass = null;
  return chords.map((c, i) => {
    // The bass takes the octave nearest the last bass note, within the low register.
    let bass = 36 + basses[i];
    if (lastBass != null) {
      const options = [bass - 12, bass, bass + 12].filter((m) => m >= 31 && m <= 50);
      bass = options.reduce((a, m) => (Math.abs(m - lastBass) < Math.abs(a - lastBass) ? m : a));
    }
    lastBass = bass;
    const options = c.tones.map((_, r) => {
      const order = [...c.tones.slice(r), ...c.tones.slice(0, r)];
      const v = [];
      for (const t of order) {
        let m = 52 + ((t - 52 + 120) % 12);
        while (v.length && m <= v[v.length - 1]) m += 12;
        v.push(m);
      }
      return v;
    });
    const cost = (v) => prev
      ? v.reduce((a, m) => a + Math.min(...prev.map((q) => Math.abs(q - m))), 0) + 0.3 * Math.abs(v[0] - prev[0])
      : Math.abs(v.reduce((a, b) => a + b, 0) / v.length - 62);
    prev = options.reduce((best, v) => (cost(v) < cost(best) ? v : best));
    return [bass, ...prev];
  });
}
