// Scores Alchemy's analysis against labelled takes from the Lab page (lab/).
//
//   node tools/eval.mjs                     score everything in testdata/
//   node tools/eval.mjs -v                  also list every take
//   node tools/eval.mjs --save base.json    keep the scores to compare against later
//   node tools/eval.mjs --compare base.json show what changed since then
//   node tools/eval.mjs --only sing-back    one category (comma-separated for several)
//
// testdata/ can hold the zips exported by the Lab (as many sessions as you like)
// and/or unzipped folders with a labels.json. Each take runs through the same
// steps the app uses, and gets scored on:
//   kind   - melody / chords / rhythm as the app decides; talking and room noise
//            count as right when the app refuses them as a tune
//   notes  - sung-back and played phrases: how closely the detected notes match
//            the phrase (edit distance on pitch classes, allowing a transposition)
//   key    - MIREX-style: 1 exact, 0.5 a fifth away, 0.3 relative, 0.2 parallel
//   chords - strummed / piano progressions: the detected chord sequence against
//            the one asked for (root and major/minor/diminished)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { normalizeLoudness, extractTrack, segmentNotes } from '../js/pitch.js';
import { classify, analyze } from '../js/sound.js';
import { detectKeys, harmonize, detectTempo } from '../js/theory.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const verbose = flag('-v') || flag('--verbose');
const only = opt('--only')?.split(',');
const dataDir = path.resolve(root, opt('--dir') ?? 'testdata');

/* ---------- reading takes ---------- */

function readZip(file) {
  const b = fs.readFileSync(file);
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error(`${file}: not a zip`);
  const count = b.readUInt16LE(e + 10);
  let p = b.readUInt32LE(e + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20);
    const nlen = b.readUInt16LE(p + 28), xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nlen);
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const raw = b.subarray(start, start + csize);
    out.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw);
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

function readWav(buf) {
  let p = 12, fmt = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4), size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(p + 8), channels: buf.readUInt16LE(p + 10), sr: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    } else if (id === 'data') {
      const d = buf.subarray(p + 8, p + 8 + size), ch = fmt.channels, bytes = fmt.bits / 8;
      const n = Math.floor(d.length / (bytes * ch)), x = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const o = i * bytes * ch;
        x[i] = fmt.format === 3 ? d.readFloatLE(o)
          : fmt.bits === 16 ? d.readInt16LE(o) / 32768
          : fmt.bits === 24 ? d.readIntLE(o, 3) / 8388608
          : d.readInt32LE(o) / 2147483648;
      }
      return { x, sr: fmt.sr };
    }
    p += 8 + size + (size & 1);
  }
  throw new Error('no audio in wav');
}

function loadTakes() {
  if (!fs.existsSync(dataDir)) return [];
  const takes = [], seen = new Set();
  const add = (labels, get, from) => {
    for (const c of labels.clips) {
      if (seen.has(c.id)) continue; // the same take exported twice
      seen.add(c.id);
      takes.push({ ...c, from, load: () => readWav(get(c.file)) });
    }
  };
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) walk(full);
      else if (f.name.endsWith('.zip')) {
        const z = readZip(full);
        if (z.has('labels.json')) add(JSON.parse(z.get('labels.json').toString('utf8')), (n) => z.get(n), f.name);
      } else if (f.name === 'labels.json') {
        add(JSON.parse(fs.readFileSync(full, 'utf8')), (n) => fs.readFileSync(path.join(dir, n)), path.relative(dataDir, dir));
      }
    }
  };
  walk(dataDir);
  return takes.sort((a, b) => a.created - b.created);
}

/* ---------- music helpers ---------- */

const NAMES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const pcOf = (m) => ((Math.round(m) % 12) + 12) % 12;

function parseKey(s) {
  const m = /^([A-G])([#♯b♭]?)\s+(major|minor)$/.exec(s.trim());
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0;
  return { tonic: (NAMES[m[1]] + acc + 12) % 12, mode: m[3] };
}

function parseChord(s) {
  const m = /^([A-G])([#♯b♭]?)(.*)$/.exec(s.trim());
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0;
  const rest = m[3];
  const quality = /^(dim|°|ø|m7b5)/.test(rest) ? 'dim' : /^m(?!aj)/.test(rest) ? 'min' : 'maj';
  return { root: (NAMES[m[1]] + acc + 12) % 12, quality };
}

const LOOSE = { min: 'min', m7: 'min', madd9: 'min', dim: 'dim', m7b5: 'dim' };
const chordClass = (c) => ({ root: c.root, quality: LOOSE[c.quality] ?? 'maj' });
const NOTE = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const chordStr = (c) => NOTE[c.root] + (c.quality === 'min' ? 'm' : c.quality === 'dim' ? 'dim' : '');
const keyStr = (k) => `${NOTE[k.tonic]} ${k.mode}`;

function keyScore(got, want) {
  if (got.tonic === want.tonic && got.mode === want.mode) return 1;
  const d = (got.tonic - want.tonic + 12) % 12;
  if (got.mode === want.mode && (d === 7 || d === 5)) return 0.5;
  if (want.mode === 'major' && got.mode === 'minor' && d === 9) return 0.3;
  if (want.mode === 'minor' && got.mode === 'major' && d === 3) return 0.3;
  if (got.tonic === want.tonic) return 0.2;
  return 0;
}

function editDistance(a, b, eq = (x, y) => x === y) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (eq(a[i - 1], b[j - 1]) ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

const collapse = (xs, eq) => xs.filter((x, i) => i === 0 || !eq(x, xs[i - 1]));

/* ---------- running one take the way the app does ---------- */

async function run(take) {
  const { x, sr } = take.load();
  const raw = x.slice();
  const samples = x.slice();
  normalizeLoudness(samples, sr);
  const track = await extractTrack(samples, sr);
  const { notes, offset } = segmentNotes(track);
  const { kind, features } = classify(raw, sr, track);
  const r = { id: take.id, category: take.category, file: take.file, want: take.kind, kind, features, notes: notes.length, tuning: offset };

  // Kind: the app refuses a main take that's rhythm or has fewer than 3 notes.
  r.got = take.kind === 'none' ? (kind === 'rhythm' || notes.length < 3 ? 'none' : kind) : kind;
  r.kindOk = r.got === take.kind;

  const p = take.prompt;
  if (p?.type === 'melody' && notes.length) {
    const truth = p.notes.map(([m]) => pcOf(m));
    const sung = notes.map((n) => pcOf(n.midi));
    let best = { dist: Infinity, shift: 0 };
    for (let s = 0; s < 12; s++) {
      const dist = editDistance(sung, truth.map((v) => (v + s) % 12));
      if (dist < best.dist || (dist === best.dist && s === 0)) best = { dist, shift: s };
    }
    r.notesAcc = Math.max(0, 1 - best.dist / truth.length);
    r.shift = best.shift;
    r.noteCount = `${notes.length}/${truth.length}`;
    const want = parseKey(p.key);
    want.tonic = (want.tonic + best.shift) % 12;
    const tempo = detectTempo(notes);
    const key = detectKeys(notes)[0];
    r.key = keyStr(key); r.wantKey = keyStr(want);
    r.keyScore = keyScore(key, want);
    r.tempo = tempo ? Math.round(tempo.bpm) : null;
  } else if (p?.type === 'melody') {
    r.notesAcc = 0; r.keyScore = 0; r.noteCount = `0/${p.notes.length}`;
  }

  if (p?.type === 'chords') {
    const sound = analyze(raw, sr, track);
    const played = [{ t0: sound.chroma.t0, hop: sound.chroma.hop, frames: sound.chroma.frames }];
    const key = detectKeys([], played)[0];
    const want = parseKey(p.key);
    r.key = keyStr(key); r.wantKey = keyStr(want);
    r.keyScore = keyScore(key, want);
    const same = (a, b) => a.root === b.root && a.quality === b.quality;
    const got = collapse(harmonize([], key, { rhythm: 'bar', played }).segments.map((s) => chordClass(s.chord)), same);
    const truth = p.chords.map(parseChord);
    // Players often go round the progression more than once.
    let best = Infinity;
    for (let reps = 1; reps <= 4; reps++) {
      const t = collapse(Array.from({ length: reps }, () => truth).flat(), same);
      best = Math.min(best, editDistance(got, t, same) / t.length);
    }
    r.chordsAcc = Math.max(0, 1 - best);
    r.chords = got.map(chordStr).join(' ');
    r.wantChords = p.chords.join(' ');
  }
  return r;
}

/* ---------- report ---------- */

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (v) => (v == null ? '   -' : `${Math.round(v * 100)}%`.padStart(4));

function summarize(results) {
  const byCat = {};
  for (const r of results) (byCat[r.category] ??= []).push(r);
  const rows = {};
  for (const [c, rs] of Object.entries(byCat)) {
    rows[c] = {
      n: rs.length,
      kind: mean(rs.map((r) => +r.kindOk)),
      notes: mean(rs.filter((r) => r.notesAcc != null).map((r) => r.notesAcc)),
      key: mean(rs.filter((r) => r.keyScore != null).map((r) => r.keyScore)),
      chords: mean(rs.filter((r) => r.chordsAcc != null).map((r) => r.chordsAcc)),
    };
  }
  const all = (k) => mean(results.filter((r) => r[k] != null).map((r) => +r[k]));
  rows.ALL = { n: results.length, kind: all('kindOk'), notes: all('notesAcc'), key: all('keyScore'), chords: all('chordsAcc') };
  return rows;
}

function printTable(rows, base) {
  const delta = (c, k) => {
    const b = base?.[c]?.[k], v = rows[c][k];
    if (b == null || v == null) return '      ';
    const d = Math.round((v - b) * 100);
    return d === 0 ? '      ' : ` (${d > 0 ? '+' : ''}${d})`.padEnd(6);
  };
  console.log(`\n${'category'.padEnd(14)} ${'n'.padStart(3)}  kind        notes       key         chords`);
  for (const c of Object.keys(rows)) {
    const r = rows[c];
    if (c === 'ALL') console.log('-'.repeat(68));
    console.log(`${c.padEnd(14)} ${String(r.n).padStart(3)}  ${pct(r.kind)}${delta(c, 'kind')}  ${pct(r.notes)}${delta(c, 'notes')}  ${pct(r.key)}${delta(c, 'key')}  ${pct(r.chords)}${delta(c, 'chords')}`);
  }
}

function printConfusion(results) {
  const kinds = ['melody', 'chords', 'rhythm', 'none'];
  console.log('\nkind: wanted (rows) vs got (columns)');
  console.log(`${''.padEnd(8)}${kinds.map((k) => k.padStart(8)).join('')}`);
  for (const w of kinds) {
    const rs = results.filter((r) => r.want === w);
    if (!rs.length) continue;
    console.log(`${w.padEnd(8)}${kinds.map((g) => String(rs.filter((r) => r.got === g).length || '.').padStart(8)).join('')}`);
  }
}

const takes = loadTakes().filter((t) => !only || only.includes(t.category));
if (!takes.length) {
  console.log(`No takes found in ${path.relative(root, dataDir) || '.'}/. Export a zip from the Lab page (lab/) and put it there.`);
  process.exit(0);
}

const results = [];
for (const t of takes) {
  try {
    const r = await run(t);
    results.push(r);
    if (verbose) {
      const bits = [r.kindOk ? 'ok ' : 'BAD', `${r.category.padEnd(13)}`, `kind ${r.got}${r.kindOk ? '' : ` (want ${r.want})`}`];
      if (r.noteCount) bits.push(`notes ${r.noteCount} ${pct(r.notesAcc)}${r.shift ? ` shift ${r.shift}` : ''}`);
      if (r.key) bits.push(`key ${r.key}${r.keyScore < 1 ? ` (want ${r.wantKey})` : ''}`);
      if (r.chords != null) bits.push(`chords ${r.chords || '-'} (want ${r.wantChords})`);
      console.log(`${bits.join('  ')}  ${JSON.stringify(r.features)}  ${path.basename(t.file)}`);
    }
  } catch (err) {
    console.log(`FAILED ${t.file}: ${err.stack}`);
  }
}

const rows = summarize(results);
const comparePath = opt('--compare');
const base = comparePath ? JSON.parse(fs.readFileSync(path.resolve(dataDir, comparePath), 'utf8')).summary : null;
printTable(rows, base);
printConfusion(results);

const savePath = opt('--save');
if (savePath) {
  const out = path.resolve(dataDir, savePath);
  fs.writeFileSync(out, JSON.stringify({ saved: new Date().toISOString(), summary: rows, results }, null, 1));
  console.log(`\nSaved to ${path.relative(root, out)}`);
}
