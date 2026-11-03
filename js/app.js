import { extractTrack, segmentNotes, livePitch, normalizeLoudness } from './pitch.js';
import { detectKeys, harmonize, keyName, spell, pc, noteLabel, scalePcs, voicing, detectTempo, beatsBetween } from './theory.js';
import { Synth } from './synth.js';
import { tuneClip, targetFn } from './tune.js';
import * as store from './db.js';

const $ = (sel) => document.querySelector(sel);
const MAX_SECONDS = 45;
const MAX_IMPORT_SECONDS = 90;
const MAX_LAYERS = 6;
const MAX_LAYER_SECONDS = 90;
const MIN_TRIM = 1;

const synth = new Synth();
const state = {
  view: 'capture',
  take: null,
  keys: [],
  keyIdx: 0,
  rhythm: 'medium',
  palette: 'simple',
  mode: 'voice',
  harmony: null,
  overrides: {},
  playing: null,
  trimming: null,
  toneOctave: null,
  metronome: false,
};

/* ---------- helpers ---------- */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtPrecise = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const haptic = (ms = 10) => { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } };
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const uid = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const trashIcon = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function toast(msg, ms = 3400) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), ms);
}

function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  return { g, w: r.width, h: r.height };
}

function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function concat(chunks, length) {
  const out = new Float32Array(length);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// iOS routes web audio at quiet "call" volume while a mic is open, and mutes it
// with the ringer switch unless told this is media playback.
function setAudioSession(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch { /* unsupported */ }
}

function setProcessing(on, progress = 0) {
  $('#processing').classList.toggle('show', on);
  $('#processFill').style.height = `${Math.round(progress * 100)}%`;
}

/* ---------- microphone ---------- */

let workletReady = false;

// Opens the mic and streams raw blocks to onChunk(data, audioClockTime).
async function openMic(onChunk) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Recording needs a secure (https) connection.');
  const ctx = synth.ensure();
  setAudioSession('play-and-record');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
  } catch {
    setAudioSession('playback');
    throw new Error('Alchemy needs microphone access to hear you.');
  }
  const source = ctx.createMediaStreamSource(stream);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  let node;
  if (ctx.audioWorklet) {
    if (!workletReady) {
      await ctx.audioWorklet.addModule('js/recorder-worklet.js');
      workletReady = true;
    }
    node = new AudioWorkletNode(ctx, 'recorder');
    node.port.onmessage = (e) => onChunk(e.data.data, e.data.time);
  } else {
    node = ctx.createScriptProcessor(1024, 1, 1);
    node.onaudioprocess = (e) => onChunk(e.inputBuffer.getChannelData(0).slice(), e.playbackTime - 1024 / ctx.sampleRate);
  }
  source.connect(node);
  node.connect(sink).connect(ctx.destination);
  const settings = stream.getAudioTracks()[0]?.getSettings?.() ?? {};
  return {
    sr: ctx.sampleRate,
    latency: typeof settings.latency === 'number' ? settings.latency : 0.01,
    close() {
      if (node.port) node.port.onmessage = null;
      else node.onaudioprocess = null;
      source.disconnect();
      node.disconnect();
      sink.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      setAudioSession('playback');
    },
  };
}

/* ---------- navigation ---------- */

function showView(name) {
  if (name !== 'harmony') {
    stopPlayback();
    state.trimming = null;
  }
  state.view = name;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  if (name === 'harmony') renderHarmony();
  if (name === 'library') renderLibrary();
  if (name === 'capture') drawLive();
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { if (!rec && !layerRec) showView(t.dataset.view); }));
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.goto)));

/* ---------- capture ---------- */

let rec = null;
let starting = false;
let lastTrace = [];
let liveCenter = 57;
let liveRaf = 0;

async function startRecording() {
  if (starting || rec) return;
  starting = true;
  stopPlayback();
  synth.stopTone();
  let mic;
  try {
    mic = await openMic(onChunk);
  } catch (e) {
    starting = false;
    toast(e.message);
    return;
  }
  rec = { mic, chunks: [], length: 0, sr: mic.sr, recent: new Float32Array(2048), trace: [] };
  starting = false;

  document.body.classList.add('recording');
  $('#recBtn').setAttribute('aria-label', 'Stop recording');
  $('#capturePrompt').textContent = 'Listening…';
  $('#recTime').textContent = '0:00';
  haptic(15);
  rec.timer = setInterval(() => {
    const s = rec.length / rec.sr;
    $('#recTime').textContent = `${fmtTime(s)} / ${fmtTime(MAX_SECONDS)}`;
    if (s >= MAX_SECONDS) stopRecording();
  }, 200);
}

function onChunk(chunk) {
  if (!rec) return;
  rec.chunks.push(chunk);
  rec.length += chunk.length;
  const r = rec.recent;
  r.copyWithin(0, chunk.length);
  r.set(chunk, r.length - chunk.length);
  const p = livePitch(r, rec.sr);
  rec.trace.push({ t: rec.length / rec.sr, midi: p.midi });
  updateLive(p);
}

function updateLive(p) {
  const level = Math.min(1, p.rms * 10);
  $('#recRing').style.setProperty('--lvl', (0.86 + level * 0.3).toFixed(3));
  const noteEl = $('#liveNote'), needle = $('#centsNeedle');
  if (p.midi != null) {
    noteEl.textContent = noteLabel(p.midi);
    noteEl.classList.remove('idle');
    const cents = (p.midi - Math.round(p.midi)) * 100;
    needle.style.left = `${50 + cents}%`;
    needle.classList.add('on');
    needle.classList.toggle('tune', Math.abs(cents) < 15);
  } else {
    noteEl.classList.add('idle');
    needle.classList.remove('on');
  }
  if (!liveRaf) liveRaf = requestAnimationFrame(() => { liveRaf = 0; drawLive(); });
}

function resetLive() {
  $('#liveNote').textContent = '–';
  $('#liveNote').classList.add('idle');
  $('#centsNeedle').classList.remove('on');
  $('#recRing').style.removeProperty('--lvl');
}

function drawLive() {
  if (state.view !== 'capture') return;
  const cv = $('#liveCanvas');
  const { g, w, h } = fitCanvas(cv);
  const trace = rec ? rec.trace : lastTrace;
  const now = trace.length ? trace[trace.length - 1].t : 0;
  const span = 6;

  const recent = trace.filter((p) => p.midi != null && p.t > now - 2.5).map((p) => p.midi).sort((a, b) => a - b);
  if (recent.length) liveCenter += (recent[recent.length >> 1] - liveCenter) * 0.2;
  const lo = liveCenter - 9, hi = liveCenter + 9;
  const y = (m) => h - ((m - lo) / (hi - lo)) * h;
  const left = 34;

  g.font = '10px ' + token('--font');
  g.textBaseline = 'middle';
  for (let m = Math.ceil(lo); m <= Math.floor(hi); m++) {
    if (![0, 2, 4, 5, 7, 9, 11].includes(pc(m))) continue;
    g.fillStyle = token('--lane');
    g.fillRect(left, y(m) - 0.5, w - left, 1);
    g.fillStyle = token('--faint');
    g.fillText(noteLabel(m), 8, y(m));
  }

  g.strokeStyle = token('--gold');
  g.lineWidth = 3;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  let pen = false;
  for (const p of trace) {
    if (p.t < now - span) continue;
    if (p.midi == null) { pen = false; continue; }
    const x = w - 6 - ((now - p.t) / span) * (w - left - 6);
    if (pen) g.lineTo(x, y(p.midi));
    else { g.moveTo(x, y(p.midi)); pen = true; }
  }
  g.stroke();

  if (!trace.length) {
    g.fillStyle = token('--faint');
    g.textAlign = 'center';
    g.font = '13px ' + token('--font');
    g.fillText('Your pitch will draw here', w / 2, h / 2);
    g.textAlign = 'left';
  }
}

async function stopRecording() {
  if (!rec) return;
  const r = rec;
  rec = null;
  clearInterval(r.timer);
  r.mic.close();
  lastTrace = r.trace;

  document.body.classList.remove('recording');
  $('#recBtn').setAttribute('aria-label', 'Start recording');
  $('#capturePrompt').textContent = 'Hum or sing a melody';
  $('#recTime').textContent = 'Tap to record';
  resetLive();
  haptic(10);

  if (r.length < r.sr * 0.8) {
    toast('That was a bit short. Hum a phrase of a few notes.');
    return;
  }
  await processAudio(concat(r.chunks, r.length), r.sr, defaultName());
}

function defaultName() {
  return 'Take · ' + new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

$('#recBtn').addEventListener('click', () => (rec ? stopRecording() : startRecording()));

$('#fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const ctx = synth.ensure();
  let buf;
  try {
    buf = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    toast("Couldn't read that audio file.");
    return;
  }
  const len = Math.min(buf.length, Math.floor(buf.sampleRate * MAX_IMPORT_SECONDS));
  const mono = new Float32Array(len);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) mono[i] += d[i] / buf.numberOfChannels;
  }
  if (buf.length > len) toast(`Using the first ${MAX_IMPORT_SECONDS} seconds.`);
  await processAudio(mono, buf.sampleRate, file.name.replace(/\.[^.]+$/, ''));
});

// A short sung-style phrase in A minor, rendered with vibrato and a slightly flat tuning.
function demoSamples(sr) {
  const mel = [69, 72, 76, 74, 72, 71, 69, 76, 77, 76, 74, 72, 71, 68, 69];
  const durs = [0.4, 0.4, 0.8, 0.4, 0.4, 0.4, 0.8, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 1.2];
  const x = new Float32Array(Math.floor((durs.reduce((a, b) => a + b, 0) + 0.8) * sr));
  let t = 0.3, ph = 0;
  mel.forEach((m, k) => {
    const n0 = Math.floor(t * sr), n1 = Math.floor((t + durs[k] - 0.04) * sr);
    for (let i = n0; i < n1; i++) {
      const tt = (i - n0) / sr;
      const pitch = m - 0.15 + 0.18 * Math.sin(2 * Math.PI * 5.2 * tt) * Math.min(1, tt / 0.3);
      ph += (2 * Math.PI * 440 * 2 ** ((pitch - 69) / 12)) / sr;
      const env = Math.min(1, tt / 0.03, (n1 - i) / sr / 0.05);
      x[i] = env * 0.3 * (Math.sin(ph) + 0.45 * Math.sin(2 * ph) + 0.2 * Math.sin(3 * ph) + 0.08 * Math.sin(4 * ph));
    }
    t += durs[k];
  });
  return x;
}

$('#demoBtn').addEventListener('click', () => {
  const sr = synth.ensure().sampleRate;
  processAudio(demoSamples(sr), sr, 'Demo · A minor phrase');
});

/* ---------- analysis ---------- */

async function processAudio(samples, sampleRate, name) {
  setProcessing(true, 0.05);
  await nextFrame();
  normalizeLoudness(samples, sampleRate);

  const track = await extractTrack(samples, sampleRate, (p) => setProcessing(true, 0.05 + p * 0.85));
  const { notes, offset, trace, traceT0, hop } = segmentNotes(track);
  setProcessing(true, 1);
  await new Promise((r) => setTimeout(r, 250));
  setProcessing(false);

  if (notes.length < 3) {
    toast("I couldn't hear a clear melody. Try humming a little louder, one note at a time.");
    return;
  }

  const duration = samples.length / sampleRate;
  loadTake({
    id: null,
    name,
    created: Date.now(),
    sampleRate,
    samples,
    duration,
    notes, offset, trace, traceT0, hop,
    traceOffset: offset,
    track,
    trim: { start: 0, end: duration },
    layers: [],
  });
  haptic([8, 40, 8]);
  showView('harmony');
}

function loadTake(take, saved = {}) {
  stopPlayback();
  state.trimming = null;
  take.layers ??= [];
  take.trim ??= { start: 0, end: take.duration };
  take.tune ??= { amount: 0, mode: 'chromatic' };
  take.tempo ??= detectTempo(take.notes);
  state.take = take;
  state.keys = detectKeys(analysisNotes());
  state.keyIdx = Math.min(saved.keyIdx ?? 0, state.keys.length - 1);
  state.rhythm = saved.rhythm ?? state.rhythm;
  state.palette = saved.palette ?? state.palette;
  reharmonize();
  state.overrides = saved.overrides ?? {};
  take.dirty = false;
}

// The notes the harmony is built from: the (trimmed) take plus any layers the user opted in.
// Layers may run past the end of the take, so only the trim start bounds them.
function analysisNotes() {
  const { notes, layers, trim } = state.take;
  const extra = layers
    .filter((l) => l.included)
    .flatMap((l) => l.notes.filter((n) => n.start >= trim.start - 0.05));
  return [...notes, ...extra].sort((a, b) => a.start - b.start);
}

function markDirty() {
  if (state.take?.id) state.take.dirty = true;
}

function reharmonize() {
  if (!state.take) return;
  state.overrides = {};
  state.harmony = harmonize(analysisNotes(), state.keys[state.keyIdx], { rhythm: state.rhythm, palette: state.palette });
  markDirty();
}

// Full re-analysis after the material changed (trim, layer opted in or out).
function reanalyze() {
  stopPlayback();
  retempo();
  state.keys = detectKeys(analysisNotes());
  state.keyIdx = 0;
  reharmonize();
  renderHarmony();
}

// Re-fit the beat grid to the current notes, keeping a tempo the user set by hand.
function retempo() {
  const take = state.take;
  const manual = take.tempo?.manual ? take.tempo.bpm : null;
  take.tempo = detectTempo(take.notes, manual);
  if (take.tempo && manual) take.tempo.manual = true;
}

function resolvedSegments() {
  const { segments, vocab } = state.harmony;
  return segments.map((s, i) => ({ ...s, chord: state.overrides[i] != null ? vocab[state.overrides[i]] : s.chord }));
}

// The timeline: the trimmed take, stretched to cover any layer that runs longer.
function takeRange() {
  const n = analysisNotes();
  const { trim, notes, layers } = state.take;
  const lastBase = notes.reduce((m, x) => Math.max(m, x.end), 0);
  let end = Math.min(trim.end, lastBase + 0.3);
  for (const x of n) end = Math.max(end, x.end + 0.3);
  for (const l of layers) end = Math.max(end, l.offset + l.duration);
  return { start: Math.max(trim.start, n[0].start - 0.15), end };
}

/* ---------- harmony view ---------- */

function renderHarmony() {
  const has = !!state.take;
  $('#harmonyEmpty').hidden = has;
  $('#harmonyContent').hidden = !has;
  if (!has) return;

  const take = state.take;
  const key = state.keys[state.keyIdx];
  const segs = resolvedSegments();
  const trimming = !!state.trimming;

  $('#harmonyContent').classList.toggle('trimming', trimming);
  $('#rollCanvas').classList.toggle('trim', trimming);
  $('#rollBar').hidden = trimming;
  $('#trimBar').hidden = !trimming;

  $('#takeName').textContent = take.name;
  $('#keyTitle').textContent = keyName(key);
  const { start, end } = takeRange();
  const included = take.layers.filter((l) => l.included).length;
  $('#keyMeta').textContent =
    `${Math.round(key.p * 100)}% likely · ${take.notes.length} notes · ${fmtTime(end - start)}` +
    (included ? ` · +${included} layer${included > 1 ? 's' : ''}` : '');

  const trimmed = take.trim.start > 0.05 || take.trim.end < take.duration - 0.05;
  $('#rollInfo').textContent = trimmed ? `${fmtTime(take.trim.start)}–${fmtTime(take.trim.end)}` : fmtTime(take.duration);
  $('#rollInfo').title = trimmed ? 'Trimmed section' : 'Recording length';
  const tempoBtn = $('#tempoBtn');
  tempoBtn.hidden = !take.tempo;
  if (take.tempo) {
    const bpm = Math.round(take.tempo.bpm);
    $('#tempoText').textContent = bpm;
    tempoBtn.setAttribute('aria-pressed', String(state.metronome));
    tempoBtn.setAttribute('aria-label', `Metronome ${state.metronome ? 'on' : 'off'}, ${bpm} beats per minute. Press and hold to adjust.`);
  }
  $('#layerCount').textContent = take.layers.length || '';

  $('#keyChips').innerHTML = state.keys
    .slice(0, 6)
    .map((k, i) => `<button class="chip ${i === state.keyIdx ? 'active' : ''}" data-i="${i}" role="option" aria-selected="${i === state.keyIdx}">${keyName(k)}<small>${Math.max(1, Math.round(k.p * 100))}%</small></button>`)
    .join('');

  document.querySelectorAll('.seg[data-setting]').forEach((seg) => {
    const val = state[seg.dataset.setting];
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.value === val));
  });

  $('#chordList').innerHTML = segs
    .map((s, i) => `<button class="chord-card ${state.overrides[i] != null ? 'edited' : ''}" data-i="${i}"><span class="sym">${s.chord.symbol}</span><span class="rn">${s.chord.roman}</span></button>`)
    .join('');

  const scale = scalePcs(key);
  $('#melodyLine').innerHTML = take.notes
    .map((n) => {
      const p = pc(n.midi);
      const cls = p === key.tonic ? 'tonic' : scale.has(p) ? '' : 'out';
      return `<span class="${cls}">${spell(p, key)}</span>`;
    })
    .join('');
  const off = take.offset;
  $('#tuningHint').textContent = Math.abs(off) < 8 ? 'In tune with A440' : `${Math.abs(off)}¢ ${off > 0 ? 'sharp' : 'flat'} of A440`;
  const tuneLevel = TUNE_LEVELS.find((l) => l.amount === take.tune.amount);
  $('#tuneLabel').textContent = take.tune.amount ? `Tuned · ${tuneLevel?.label ?? ''}` : 'Tune';
  $('#tuneBtn').classList.toggle('strong', !!take.tune.amount);

  updateTransportStatus();
  $('#saveBtn').classList.toggle('saved', !!take.id && !take.dirty);
  drawRoll();
}

function updateTransportStatus(text) {
  const el = $('#transportStatus');
  const msg = text ?? (state.trimming ? 'Play previews your selection' : '');
  el.hidden = !msg;
  $('#transportStatusText').textContent = msg;
  document.querySelector('.mode-seg').hidden = !!msg;
}

let rollGeom = null;

function drawRoll(playT = null) {
  if (!state.take || state.view !== 'harmony') return;
  const cv = $('#rollCanvas');
  const { g, w, h } = fitCanvas(cv);
  const take = state.take;
  const key = state.keys[state.keyIdx];
  const trimming = state.trimming;
  const play = state.playing;
  const { start, end } = trimming
    ? { start: 0, end: take.duration }
    : layerRec && play ? { start: play.start, end: play.viewEnd } : takeRange();
  const inView = (n) => n.end > start && n.start < end;

  const groups = [
    { notes: take.notes, style: 'base' },
    ...take.layers.map((l) => ({ notes: l.notes, style: l.included ? 'layer' : 'ghost' })),
  ];
  let lo = Infinity, hi = -Infinity;
  for (const grp of groups) for (const n of grp.notes) if (inView(n)) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
  if (!Number.isFinite(lo)) { lo = 55; hi = 67; }
  lo -= 2; hi += 2;
  while (hi - lo < 12) { lo--; if (hi - lo < 12) hi++; }

  const left = 30, right = 8, top = 8, band = trimming ? 18 : 34;
  const rollH = h - top - band - 10;
  const laneH = rollH / (hi - lo + 1);
  const x = (t) => left + ((t - start) / (end - start)) * (w - left - right);
  const laneY = (m) => top + (hi - m) * laneH;
  const scale = scalePcs(key);
  rollGeom = { x0: left, x1: w - right, start, end };

  const cLane = token('--lane'), cTonic = token('--lane-tonic'), cFaint = token('--faint');
  const cGold = token('--gold'), cViolet = token('--violet'), cSurface = token('--surface'), cSurface2 = token('--surface-2');
  const cText = token('--text'), cInk = token('--gold-ink');

  g.font = '10px ' + token('--font');
  g.textBaseline = 'middle';
  for (let m = lo; m <= hi; m++) {
    const p = pc(m);
    if (p === key.tonic) { g.fillStyle = cTonic; g.fillRect(left, laneY(m), w - left - right, laneH); }
    else if (scale.has(p)) { g.fillStyle = cLane; g.fillRect(left, laneY(m), w - left - right, laneH); }
    if (scale.has(p) && (laneH >= 11 || p === key.tonic)) {
      g.fillStyle = p === key.tonic ? cGold : cFaint;
      g.fillText(spell(p, key), 6, laneY(m) + laneH / 2);
    }
  }

  const segs = resolvedSegments();
  if (!trimming) {
    g.fillStyle = cLane;
    for (const s of segs.slice(1)) g.fillRect(Math.round(x(s.start)), top, 1, rollH);
  }

  // Beat marks along the top edge while the metronome is on
  if (!trimming && state.metronome && take.tempo) {
    g.fillStyle = cFaint;
    for (const b of beatsBetween(take.tempo, start, end)) {
      g.globalAlpha = b.accent ? 0.9 : 0.45;
      g.fillRect(Math.round(x(b.t)), 1, b.accent ? 2 : 1, b.accent ? 7 : 4);
    }
    g.globalAlpha = 1;
  }

  g.save();
  g.beginPath();
  g.rect(left, 0, w - left - right, h);
  g.clip();

  // Raw pitch trace of the original take
  g.strokeStyle = cViolet;
  g.globalAlpha = trimming ? 0.8 : 0.55;
  g.lineWidth = 1.5;
  g.beginPath();
  let pen = false;
  for (let i = 0; i < take.trace.length; i++) {
    const v = take.trace[i];
    const t = take.traceT0 + i * take.hop;
    if (Number.isNaN(v) || v < lo - 0.5 || v > hi + 0.5 || t < start || t > end) { pen = false; continue; }
    const px = x(t), py = top + (hi - v) * laneH + laneH / 2;
    if (pen) g.lineTo(px, py);
    else { g.moveTo(px, py); pen = true; }
  }
  g.stroke();
  g.globalAlpha = 1;

  // Notes: original in gold, layers in the harmony in violet, other layers as outlines
  for (const grp of [...groups].reverse()) {
    for (const n of grp.notes) {
      if (!inView(n)) continue;
      const active = playT != null && playT >= n.start && playT < n.end;
      const nx = x(n.start), nw = Math.max(3, x(n.end) - x(n.start) - 1.5);
      roundRect(g, nx, laneY(n.midi) + 1, nw, Math.max(3, laneH - 2), 3);
      if (grp.style === 'ghost') {
        g.strokeStyle = cFaint;
        g.lineWidth = 1;
        g.stroke();
        continue;
      }
      g.fillStyle = grp.style === 'base' ? cGold : cViolet;
      g.globalAlpha = playT == null || active ? 1 : 0.55;
      g.fill();
      g.globalAlpha = 1;
    }
  }
  g.restore();

  if (trimming) {
    const a = x(trimming.start), b = x(trimming.end);
    g.fillStyle = cSurface;
    g.globalAlpha = 0.72;
    g.fillRect(left, top, a - left, h - top);
    g.fillRect(b, top, w - right - b, h - top);
    g.globalAlpha = 1;
    g.fillStyle = cGold;
    for (const hx of [a, b]) {
      g.fillRect(hx - 1.5, top, 3, rollH);
      roundRect(g, hx - 5, top + rollH / 2 - 16, 10, 32, 5);
      g.fill();
    }
    g.font = '600 11px ' + token('--font');
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillText(fmtPrecise(trimming.start), Math.min(a + 4, w - right - 90), h - band / 2 - 2);
    g.textAlign = 'right';
    g.fillText(fmtPrecise(trimming.end), Math.max(b - 4, left + 90), h - band / 2 - 2);
    g.textAlign = 'left';
  } else {
    const by = h - band - 4;
    g.font = '600 12px ' + token('--font');
    g.textAlign = 'center';
    for (const s of segs) {
      const active = playT != null && playT >= s.start && playT < s.end;
      const sx = x(s.start) + 1, sw = x(s.end) - x(s.start) - 2;
      g.fillStyle = active ? cGold : cSurface2;
      roundRect(g, sx, by, sw, band, 8);
      g.fill();
      const label = g.measureText(s.chord.symbol).width < sw - 6 ? s.chord.symbol : sw > 14 ? s.chord.symbol[0] : '';
      g.fillStyle = active ? cInk : cText;
      g.fillText(label, sx + sw / 2, by + band / 2);
    }
    g.textAlign = 'left';
  }

  if (playT != null) {
    g.fillStyle = cText;
    g.fillRect(Math.round(x(playT)), top, 1.5, h - top - 4);
  }
}

$('#keyChips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  const i = +b.dataset.i;
  if (i === state.keyIdx) return;
  stopPlayback();
  state.keyIdx = i;
  reharmonize();
  renderHarmony();
  haptic();
});

document.querySelectorAll('.seg[data-setting]').forEach((seg) =>
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const setting = seg.dataset.setting;
    if (state[setting] === b.dataset.value) return;
    state[setting] = b.dataset.value;
    if (setting === 'mode') {
      const wasPlaying = !!state.playing;
      renderHarmony();
      if (wasPlaying) startPlayback();
    } else {
      stopPlayback();
      reharmonize();
      renderHarmony();
    }
    haptic();
  })
);

$('#chordList').addEventListener('click', (e) => {
  const b = e.target.closest('.chord-card');
  if (b) openChordSheet(+b.dataset.i);
});

/* ---------- trim ---------- */

$('#trimBtn').addEventListener('click', () => {
  stopPlayback();
  state.trimming = { ...state.take.trim, drag: null };
  renderHarmony();
  haptic();
});

$('#trimCancel').addEventListener('click', () => {
  stopPlayback();
  state.trimming = null;
  renderHarmony();
});

$('#trimApply').addEventListener('click', async () => {
  const take = state.take;
  const { start, end } = state.trimming;
  stopPlayback();
  if (!take.track) {
    setProcessing(true, 0.1);
    await nextFrame();
    take.track = await extractTrack(take.samples, take.sampleRate, (p) => setProcessing(true, 0.1 + p * 0.85));
    setProcessing(false);
  }
  const frames = take.track.frames.filter((f) => f.t >= start && f.t <= end);
  const r = segmentNotes({ frames, hop: take.track.hop });
  if (r.notes.length < 3) {
    toast('Not enough melody in that selection. Try a wider trim.');
    return;
  }
  take.notes = r.notes;
  take.offset = r.offset;
  take.trim = { start, end };
  state.trimming = null;
  reanalyze();
  toast('Trimmed and re-harmonized');
  haptic(12);
});

function trimTimeAt(clientX) {
  const r = $('#rollCanvas').getBoundingClientRect();
  const { x0, x1, start, end } = rollGeom;
  const t = start + ((clientX - r.left - x0) / (x1 - x0)) * (end - start);
  return Math.max(0, Math.min(state.take.duration, t));
}

const roll = $('#rollCanvas');
roll.addEventListener('pointerdown', (e) => {
  const tr = state.trimming;
  if (!tr || !rollGeom) return;
  const t = trimTimeAt(e.clientX);
  tr.drag = Math.abs(t - tr.start) <= Math.abs(t - tr.end) ? 'start' : 'end';
  roll.setPointerCapture(e.pointerId);
  moveTrimHandle(t);
});
roll.addEventListener('pointermove', (e) => {
  if (state.trimming?.drag) moveTrimHandle(trimTimeAt(e.clientX));
});
['pointerup', 'pointercancel'].forEach((ev) => roll.addEventListener(ev, () => { if (state.trimming) state.trimming.drag = null; }));

function moveTrimHandle(t) {
  const tr = state.trimming;
  if (tr.drag === 'start') tr.start = Math.min(t, tr.end - MIN_TRIM);
  else tr.end = Math.max(t, tr.start + MIN_TRIM);
  tr.start = Math.max(0, tr.start);
  tr.end = Math.min(state.take.duration, tr.end);
  drawRoll();
}

/* ---------- playback ---------- */

function bufferFor(clip) {
  if (!clip.buffer) {
    clip.buffer = synth.ensure().createBuffer(1, clip.samples.length, clip.sampleRate);
    clip.buffer.getChannelData(0).set(clip.samples);
  }
  return clip.buffer;
}

// Plays the part of a clip (placed at clipStart on the take timeline) that falls in [start, end].
function scheduleClip(clip, clipStart, t0, start, end) {
  const buf = bufferFor(clip);
  const a = Math.max(start, clipStart);
  const b = Math.min(end, clipStart + buf.duration);
  if (b > a) synth.voice(buf, t0 + (a - start), a - clipStart, b - a);
}

function startPlayback() {
  if (!state.take) return;
  stopPlayback();
  const take = state.take;
  const ctx = synth.begin();
  const { start, end } = state.trimming ?? takeRange();
  const t0 = ctx.currentTime + 0.1;

  if (state.trimming) {
    scheduleClip(take, 0, t0, start, end);
  } else {
    const level = { chords: 1, melody: 0.7, voice: 0.55 }[state.mode];
    for (const s of resolvedSegments()) synth.chord(voicing(s.chord), t0 + s.start - start, s.end - s.start, level);
    if (state.mode === 'voice') {
      scheduleClip(voiceClip(take), 0, t0, start, end);
      for (const l of take.layers) if (!l.muted) scheduleClip(voiceClip(l), l.offset, t0, start, end);
    }
    if (state.mode === 'melody') {
      for (const n of analysisNotes()) if (n.start >= start && n.start < end) synth.lead(n.midi, t0 + n.start - start, n.end - n.start);
    }
    if (state.metronome && take.tempo) {
      // While recording a layer the click keeps going past the end of the take.
      const clickEnd = layerRec ? start + MAX_LAYER_SECONDS : end;
      for (const b of beatsBetween(take.tempo, start, clickEnd)) synth.click(t0 + b.t - start, b.accent);
    }
  }
  state.playing = { t0, start, end, viewEnd: end, raf: 0, seg: -1 };
  $('#playBtn').classList.add('playing');
  $('#playBtn').setAttribute('aria-label', 'Stop');
  tick();
}

function tick() {
  const p = state.playing;
  if (!p) return;
  const t = p.start + (synth.ctx.currentTime - p.t0);
  if (layerRec) {
    // A layer keeps recording past the end of the take until the user stops it;
    // the view widens to make room.
    if (t - p.start >= MAX_LAYER_SECONDS) { stopLayer(); return; }
    p.viewEnd = Math.max(p.end, t + 1);
    drawRoll(Math.max(p.start, t));
    updateTransportStatus(`Recording ${layerRec.name} · ${fmtTime(Math.max(0, t - p.start))}${t > p.end ? ' · tap ■ to finish' : ''}`);
  } else {
    if (t >= p.end + 0.6) { stopPlayback(); return; }
    drawRoll(Math.max(p.start, Math.min(t, p.end)));
  }
  if (!state.trimming) {
    const idx = resolvedSegments().findIndex((s) => t >= s.start && t < s.end);
    if (idx !== p.seg) {
      p.seg = idx;
      document.querySelectorAll('.chord-card').forEach((c, i) => c.classList.toggle('now', i === idx));
    }
  }
  p.raf = requestAnimationFrame(tick);
}

function stopPlayback() {
  if (!state.playing) return;
  cancelAnimationFrame(state.playing.raf);
  state.playing = null;
  synth.stop();
  $('#playBtn').classList.remove('playing');
  $('#playBtn').setAttribute('aria-label', 'Play');
  document.querySelectorAll('.chord-card.now').forEach((c) => c.classList.remove('now'));
  drawRoll();
}

function audition(chord) {
  stopPlayback();
  const ctx = synth.begin();
  synth.chord(voicing(chord), ctx.currentTime + 0.02, 1.3, 0.9);
}

$('#playBtn').addEventListener('click', () => {
  if (layerRec) stopLayer();
  else if (state.playing) stopPlayback();
  else startPlayback();
});

/* ---------- layers ---------- */

let layerRec = null;

async function startLayer() {
  const take = state.take;
  closeSheet();
  stopPlayback();
  synth.stopTone();
  const used = take.layers.map((l) => +(l.name.match(/\d+/) || [0])[0]);
  const name = `Layer ${Math.max(0, ...used) + 1}`;
  let mic;
  try {
    mic = await openMic((data, time) => {
      if (!layerRec) return;
      layerRec.firstTime ??= time;
      layerRec.chunks.push(data);
      layerRec.length += data.length;
    });
  } catch (e) {
    toast(e.message);
    return;
  }
  layerRec = { mic, name, chunks: [], length: 0, firstTime: null };
  document.body.classList.add('layering');
  startPlayback();
  layerRec.play = state.playing;
  updateTransportStatus(`Recording ${name}`);
  haptic(15);
}

async function stopLayer() {
  const r = layerRec;
  if (!r) return;
  layerRec = null;
  r.mic.close();
  document.body.classList.remove('layering');
  const ctx = synth.ctx;
  const outLatency = ctx.outputLatency || ctx.baseLatency || 0;
  stopPlayback();
  updateTransportStatus();

  if (r.length < r.mic.sr * 0.5 || r.firstTime == null) {
    toast('That layer was too short to keep.');
    return;
  }
  const samples = normalizeLoudness(concat(r.chunks, r.length), r.mic.sr);
  // Where the first recorded sample sits on the take's timeline, minus the
  // round trip from speaker to ear to mic.
  const offset = r.play.start + (r.firstTime - r.play.t0) - outLatency - r.mic.latency;

  setProcessing(true, 0.1);
  await nextFrame();
  const track = await extractTrack(samples, r.mic.sr, (p) => setProcessing(true, 0.1 + p * 0.85));
  const seg = segmentNotes(track);
  setProcessing(false);

  state.take.layers.push({
    id: uid(),
    name: r.name,
    samples,
    sampleRate: r.mic.sr,
    duration: samples.length / r.mic.sr,
    offset,
    notes: seg.notes.map((n) => ({ ...n, start: n.start + offset, end: n.end + offset })),
    // Pitch contour in the layer's own time, for tuning it later
    trace: seg.trace,
    traceT0: seg.traceT0,
    hop: seg.hop,
    traceOffset: seg.offset,
    muted: false,
    included: false,
  });
  markDirty();
  renderHarmony();
  toast(`${r.name} added. Turn on Harmony in Layers to include it.`, 4200);
  haptic([8, 40, 8]);
}

$('#layersBtn').addEventListener('click', openLayersSheet);

function openLayersSheet() {
  const take = state.take;
  const check = '<span class="chk"></span>';
  const rows = take.layers
    .map((l) => `
      <div class="layer-row" data-id="${l.id}">
        <div class="layer-top">
          <div class="layer-name"><b>${esc(l.name)}</b><span>${l.notes.length} notes · ${fmtTime(l.duration)}</span></div>
          <button class="icon-sm" data-act="delete" aria-label="Delete ${esc(l.name)}">${trashIcon}</button>
        </div>
        <div class="layer-toggles">
          <button class="pill ${l.muted ? '' : 'on'}" data-act="mute" aria-pressed="${!l.muted}">${check}Play</button>
          <button class="pill ${l.included ? 'on' : ''}" data-act="include" aria-pressed="${l.included}">${check}Harmony</button>
        </div>
      </div>`)
    .join('');
  const full = take.layers.length >= MAX_LAYERS;

  openSheet(`
    <h3>Layers</h3>
    <p class="sub">Sing more parts over your take, ideally with headphones so the playback stays out of the mic. Keep going past the end if you like; recording runs until you tap stop. A new layer only changes the key and chords once you turn on <b>Harmony</b>.</p>
    <div class="layer-list">${rows || '<div class="layer-empty">No layers yet</div>'}</div>
    <button class="btn primary block" id="layerRecord" ${full ? 'disabled' : ''}><span class="dot"></span>${full ? 'Layer limit reached' : 'Record a layer'}</button>`);

  $('#layerRecord').addEventListener('click', startLayer);
  $('#sheetBody .layer-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.closest('.layer-row').dataset.id;
    const layer = take.layers.find((l) => l.id === id);
    if (b.dataset.act === 'mute') {
      layer.muted = !layer.muted;
      markDirty();
    } else if (b.dataset.act === 'include') {
      if (!layer.included && !layer.notes.length) {
        toast(`No clear notes in ${layer.name} to harmonize.`);
        return;
      }
      layer.included = !layer.included;
      reanalyze();
      toast(`Harmony updated ${layer.included ? 'with' : 'without'} ${layer.name}`);
    } else if (b.dataset.act === 'delete') {
      if (!b.classList.contains('confirm')) {
        b.classList.add('confirm');
        b.textContent = 'Delete';
        return;
      }
      take.layers = take.layers.filter((l) => l !== layer);
      markDirty();
      if (layer.included) reanalyze();
      else renderHarmony();
    }
    haptic();
    openLayersSheet();
  });
}

/* ---------- voice tuning ---------- */

const TUNE_LEVELS = [
  { amount: 0, label: 'Off' },
  { amount: 0.3, label: 'Light' },
  { amount: 0.55, label: 'Medium' },
  { amount: 0.8, label: 'Strong' },
  { amount: 1, label: 'Hard' },
];

// The audio to play for a voice clip (the take or a layer): the original, or a
// pitch-corrected copy built on demand and kept until the settings change.
function voiceClip(clip) {
  const take = state.take;
  const { amount, mode } = take.tune;
  const isBase = clip === take;
  const tuning = isBase ? take.traceOffset ?? take.offset : clip.traceOffset;
  if (!amount || !clip.trace || tuning == null) return clip;

  const key = state.keys[state.keyIdx];
  const notes = isBase ? take.notes : clip.notes.map((n) => ({ ...n, start: n.start - clip.offset, end: n.end - clip.offset }));
  const sig = [amount, mode, mode === 'key' ? `${key.tonic}${key.mode}` : '', notes.length, notes[0]?.start, notes[notes.length - 1]?.end].join('|');
  if (clip.tuned?.sig !== sig) {
    const samples = tuneClip(
      { samples: clip.samples, sampleRate: clip.sampleRate, trace: clip.trace, traceT0: clip.traceT0, hop: clip.hop, tuning: tuning / 100, notes },
      { amount, targetOf: targetFn(mode, scalePcs(key)) }
    );
    clip.tuned = { sig, samples, sampleRate: clip.sampleRate };
  }
  return clip.tuned;
}

$('#tuneBtn').addEventListener('click', openTuneSheet);

function openTuneSheet() {
  const take = state.take;
  const key = state.keys[state.keyIdx];
  const { amount, mode } = take.tune;
  openSheet(`<div class="tune-sheet">
    <h3>Tune voice</h3>
    <p class="sub">Pulls your singing toward the nearest note. Lighter settings keep your slides and vibrato; Hard gives the classic flat, robotic sound. Your original recording is kept, so you can change this any time.</p>
    <span class="label">Amount</span>
    <div class="seg" role="group" aria-label="Amount">
      ${TUNE_LEVELS.map((l) => `<button data-amount="${l.amount}" class="${l.amount === amount ? 'active' : ''}">${l.label}</button>`).join('')}
    </div>
    <span class="label">Snap to</span>
    <div class="seg" role="group" aria-label="Snap to">
      <button data-mode="chromatic" class="${mode === 'chromatic' ? 'active' : ''}">Nearest note</button>
      <button data-mode="key" class="${mode === 'key' ? 'active' : ''}">Notes in ${keyName(key)}</button>
    </div>
    <button class="btn primary block tune-listen" id="tuneListen">Listen</button>
    </div>`);

  $('#sheetBody .tune-sheet').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'tuneListen') {
      closeSheet();
      state.mode = 'voice';
      renderHarmony();
      startPlayback();
      return;
    }
    if (b.dataset.amount != null) take.tune = { ...take.tune, amount: +b.dataset.amount };
    else if (b.dataset.mode) take.tune = { ...take.tune, mode: b.dataset.mode };
    else return;
    markDirty();
    const wasPlaying = !!state.playing && !layerRec;
    stopPlayback();
    renderHarmony();
    openTuneSheet();
    if (wasPlaying) startPlayback();
    haptic();
  });
}

/* ---------- metronome ---------- */

// Tap toggles the click; press and hold opens tempo adjustments.
(() => {
  const btn = $('#tempoBtn');
  let hold = null, held = false;
  const cancel = () => { clearTimeout(hold); hold = null; };
  btn.addEventListener('pointerdown', () => {
    held = false;
    hold = setTimeout(() => { held = true; haptic(15); openTempoSheet(); }, 500);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, cancel));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    if (held) { held = false; return; }
    setMetronome(!state.metronome);
    if (state.metronome && !setMetronome.hinted) {
      setMetronome.hinted = true;
      toast('Metronome on. Press and hold the tempo to adjust it.');
    }
  });
})();

function setMetronome(on) {
  state.metronome = on;
  const wasPlaying = !!state.playing && !layerRec;
  renderHarmony();
  if (wasPlaying) startPlayback();
  haptic();
}

function setTempo(bpm, manual = true) {
  const take = state.take;
  bpm = Math.max(40, Math.min(240, Math.round(bpm * 2) / 2));
  take.tempo = detectTempo(take.notes, manual ? bpm : null);
  if (manual) take.tempo.manual = true;
  markDirty();
  stopPlayback();
  renderHarmony();
}

function openTempoSheet() {
  const take = state.take;
  if (!take?.tempo) return;
  const t = take.tempo;
  openSheet(`<div class="tempo-sheet">
    <h3>Metronome</h3>
    <p class="sub">${t.manual ? 'Tempo set by you.' : `Estimated from your take${t.steady ? '' : ', which drifts a little, so it may need a nudge'}.`} It clicks only during playback and layer recording.</p>
    <div class="tempo-row">
      <button class="icon-btn" data-step="-1" aria-label="Slower">−</button>
      <div class="tempo-value">${Math.round(t.bpm)}<small>BPM</small></div>
      <button class="icon-btn" data-step="1" aria-label="Faster">+</button>
    </div>
    <div class="tempo-tools">
      <button class="btn" data-mul="0.5">½×</button>
      <button class="btn" id="tapTempo">Tap tempo</button>
      <button class="btn" data-mul="2">2×</button>
    </div>
    <div class="seg" role="group" aria-label="Click">
      <button data-click="off" class="${state.metronome ? '' : 'active'}">Click off</button>
      <button data-click="on" class="${state.metronome ? 'active' : ''}">Click on</button>
    </div>
    ${t.manual ? '<button class="text-btn tempo-reset" id="tempoReset">Back to detected tempo</button>' : ''}
    </div>`);

  const body = $('#sheetBody .tempo-sheet');
  body.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.id === 'tapTempo') return;
    if (b.dataset.step) setTempo(Math.round(take.tempo.bpm) + +b.dataset.step);
    else if (b.dataset.mul) setTempo(take.tempo.bpm * +b.dataset.mul);
    else if (b.dataset.click) setMetronome(b.dataset.click === 'on');
    else if (b.id === 'tempoReset') setTempo(0, false);
    else return;
    openTempoSheet();
  });

  const taps = [];
  $('#tapTempo').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(now);
    const tap = e.currentTarget;
    tap.classList.add('tapping');
    setTimeout(() => tap.classList.remove('tapping'), 90);
    haptic(5);
    if (taps.length >= 4) {
      const span = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      const bpm = Math.round(60000 / span);
      body.querySelector('.tempo-value').firstChild.textContent = bpm;
      clearTimeout(openTempoSheet.tapTimer);
      openTempoSheet.tapTimer = setTimeout(() => {
        setTempo(bpm);
        if (body.isConnected && $('#sheet').classList.contains('show')) openTempoSheet();
      }, 1200);
    } else {
      tap.textContent = `Tap ${4 - taps.length} more`;
    }
  });
}

/* ---------- reference tone ---------- */

$('#toneBtn').addEventListener('click', openToneSheet);

function openToneSheet() {
  const key = state.take ? state.keys[state.keyIdx] : null;
  if (state.toneOctave == null) {
    const notes = state.take?.notes ?? [];
    const mid = notes.length ? notes.map((n) => n.midi).sort((a, b) => a - b)[notes.length >> 1] : 60;
    state.toneOctave = Math.max(3, Math.min(5, Math.floor(mid / 12) - 1));
  }
  const black = [1, 3, 6, 8, 10];
  const keys = Array.from({ length: 12 }, (_, p) =>
    `<button class="tone-key ${black.includes(p) ? 'sharp' : ''} ${key && p === key.tonic ? 'tonic' : ''}" data-pc="${p}">${spell(p, key)}</button>`
  ).join('');

  openSheet(`
    <h3>Reference tone</h3>
    <p class="sub">Tap a note to hear it, then hum to match.</p>
    <div class="tone-grid" role="group" aria-label="Notes">${keys}</div>
    <div class="seg tone-oct" role="group" aria-label="Octave">
      ${[3, 4, 5].map((o) => `<button data-oct="${o}" class="${o === state.toneOctave ? 'active' : ''}">${['Low', 'Middle', 'High'][o - 3]}</button>`).join('')}
    </div>
    ${key ? `<p class="tone-legend">The dot marks ${spell(key.tonic, key)}, the home note of ${keyName(key)}.</p>` : ''}`);

  const body = $('#sheetBody');
  const play = (b) => {
    synth.tone((state.toneOctave + 1) * 12 + +b.dataset.pc, 3, () => b.classList.remove('playing'));
    b.classList.add('playing');
  };
  body.querySelector('.tone-grid').addEventListener('click', (e) => {
    const b = e.target.closest('.tone-key');
    if (!b) return;
    if (b.classList.contains('playing')) synth.stopTone();
    else play(b);
    haptic();
  });
  body.querySelector('.tone-oct').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.toneOctave = +b.dataset.oct;
    body.querySelectorAll('.tone-oct button').forEach((x) => x.classList.toggle('active', x === b));
    const playing = body.querySelector('.tone-key.playing');
    if (playing) play(playing);
  });
}

/* ---------- sheets ---------- */

function openSheet(html) {
  $('#sheetBody').innerHTML = html;
  document.body.classList.add('sheet-open');
  $('#sheet').classList.add('show');
  $('#sheet').setAttribute('aria-hidden', 'false');
  $('#sheetBackdrop').classList.add('show');
}

function closeSheet() {
  document.body.classList.remove('sheet-open');
  $('#sheet').classList.remove('show');
  $('#sheet').setAttribute('aria-hidden', 'true');
  $('#sheetBackdrop').classList.remove('show');
}

$('#sheetBackdrop').addEventListener('click', closeSheet);

function openChordSheet(i) {
  const key = state.keys[state.keyIdx];
  const seg = state.harmony.segments[i];
  const current = resolvedSegments()[i].chord;
  const scores = seg.alts.map((a) => a.score);
  const hi = Math.max(...scores), lo = Math.min(...scores, hi - 0.5);
  const notes = seg.pcs.map((p) => spell(p, key)).join(' · ');

  openSheet(`
    <h3>Chord ${i + 1} of ${state.harmony.segments.length}</h3>
    <p class="sub">Under the notes ${notes || '(rest)'}. Tap to hear and choose.</p>
    <div class="alt-list">
      ${seg.alts
        .map((a) => `
        <button class="alt ${a.chord.id === current.id ? 'active' : ''}" data-id="${a.chord.id}">
          <span class="sym">${a.chord.symbol}</span>
          <span class="fit" aria-label="fit"><i style="width:${Math.round(12 + 88 * ((a.score - lo) / (hi - lo || 1)))}%"></i></span>
          <span class="rn">${a.chord.roman}</span>
        </button>`)
        .join('')}
    </div>`);

  $('#sheetBody .alt-list').addEventListener('click', (e) => {
    const b = e.target.closest('.alt');
    if (!b) return;
    const id = +b.dataset.id;
    if (id === seg.chord.id) delete state.overrides[i];
    else state.overrides[i] = id;
    markDirty();
    document.querySelectorAll('#sheetBody .alt').forEach((x) => x.classList.toggle('active', x === b));
    audition(state.harmony.vocab[id]);
    renderHarmony();
    haptic();
  });
}

/* ---------- save / share ---------- */

$('#saveBtn').addEventListener('click', () => {
  if (!state.take) return;
  openSheet(`
    <h3>${state.take.id ? 'Update in library' : 'Save to library'}</h3>
    <input class="field" id="saveName" maxlength="60" value="${esc(state.take.name)}" aria-label="Name" enterkeyhint="done">
    <button class="btn primary block" id="saveConfirm">Save</button>`);
  const input = $('#saveName');
  const go = () => saveTake(input.value.trim());
  $('#saveConfirm').addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
});

async function saveTake(name) {
  const take = state.take;
  take.name = name || take.name;
  take.id ??= uid();
  const key = state.keys[state.keyIdx];
  const range = takeRange();
  const meta = {
    id: take.id,
    name: take.name,
    created: take.created,
    duration: take.duration,
    sampleRate: take.sampleRate,
    notes: take.notes,
    offset: take.offset,
    trace: take.trace,
    traceT0: take.traceT0,
    hop: take.hop,
    trim: take.trim,
    tempo: take.tempo,
    tune: take.tune,
    traceOffset: take.traceOffset,
    layers: take.layers.map(({ samples, buffer, tuned, ...rest }) => rest),
    keyIdx: state.keyIdx,
    rhythm: state.rhythm,
    palette: state.palette,
    overrides: state.overrides,
    summary: { key: keyName(key), chords: resolvedSegments().map((s) => s.chord.symbol), length: range.end - range.start },
  };
  const audio = { base: take.samples, layers: Object.fromEntries(take.layers.map((l) => [l.id, l.samples])) };
  try {
    await store.save(meta, audio);
    take.dirty = false;
    closeSheet();
    renderHarmony();
    toast('Saved to your library');
    haptic(12);
  } catch {
    toast("Couldn't save. Your browser may be out of storage.");
  }
}

$('#shareBtn').addEventListener('click', async () => {
  if (!state.take) return;
  const key = state.keys[state.keyIdx];
  const segs = resolvedSegments();
  const text = [
    state.take.name,
    `Key: ${keyName(key)}`,
    `| ${segs.map((s) => s.chord.symbol).join(' | ')} |`,
    segs.map((s) => s.chord.roman).join(' – '),
    '',
    `Melody: ${state.take.notes.map((n) => spell(pc(n.midi), key)).join(' ')}`,
  ].join('\n');
  if (navigator.share) {
    try { await navigator.share({ title: 'Alchemy', text }); } catch { /* cancelled */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Chord chart copied');
  } catch {
    toast("Couldn't copy the chord chart.");
  }
});

/* ---------- library ---------- */

async function renderLibrary() {
  let items = [];
  try { items = await store.list(); } catch { /* storage unavailable */ }
  items.sort((a, b) => b.created - a.created);
  $('#libEmpty').hidden = items.length > 0;
  $('#libList').innerHTML = items
    .map((it) => {
      const layers = it.layers?.length ?? 0;
      return `
      <li class="lib-item">
        <button class="lib-open" data-id="${esc(it.id)}">
          <span class="lib-title">${esc(it.name)}</span>
          <span class="lib-meta"><b>${esc(it.summary.key)}</b> · ${fmtTime(it.summary.length ?? it.duration)}${layers ? ` · ${layers} layer${layers > 1 ? 's' : ''}` : ''} · ${new Date(it.created).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
          <span class="lib-chords">${it.summary.chords.slice(0, 8).map((c) => `<span>${esc(c)}</span>`).join('')}${it.summary.chords.length > 8 ? '<span>…</span>' : ''}</span>
        </button>
        <button class="lib-del" data-del="${esc(it.id)}" aria-label="Delete ${esc(it.name)}">${trashIcon}</button>
      </li>`;
    })
    .join('');
}

$('#libList').addEventListener('click', async (e) => {
  const del = e.target.closest('.lib-del');
  if (del) {
    if (!del.classList.contains('confirm')) {
      del.classList.add('confirm');
      del.textContent = 'Delete';
      setTimeout(() => { if (del.isConnected) renderLibrary(); }, 3000);
      return;
    }
    await store.remove(del.dataset.del);
    if (state.take?.id === del.dataset.del) state.take.id = null;
    renderLibrary();
    return;
  }
  const open = e.target.closest('.lib-open');
  if (!open) return;
  try {
    const { meta, samples: raw } = await store.load(open.dataset.id);
    // Early saves stored the take's samples directly; newer ones store base + layers.
    const audio = raw instanceof Float32Array ? { base: raw, layers: {} } : raw;
    const layers = (meta.layers ?? []).map((l) => ({ ...l, samples: audio.layers?.[l.id] })).filter((l) => l.samples);
    loadTake({ ...meta, samples: audio.base, layers }, meta);
    showView('harmony');
  } catch {
    toast("Couldn't open that take.");
  }
});

/* ---------- boot ---------- */

window.addEventListener('resize', () => {
  if (state.view === 'harmony') drawRoll();
  if (state.view === 'capture') drawLive();
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  drawLive();
  drawRoll();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  synth.stopTone();
  if (layerRec) stopLayer();
  else stopPlayback();
  if (rec) stopRecording();
});

setAudioSession('playback');
resetLive();
drawLive();
if (location.hash === '#demo') $('#demoBtn').click();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
