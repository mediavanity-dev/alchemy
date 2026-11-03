import { extractTrack, segmentNotes, livePitch } from './pitch.js';
import { detectKeys, harmonize, keyName, spell, pc, noteLabel, scalePcs, voicing } from './theory.js';
import { Synth } from './synth.js';
import * as store from './db.js';

const $ = (sel) => document.querySelector(sel);
const MAX_SECONDS = 45;
const MAX_IMPORT_SECONDS = 90;

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
};

/* ---------- helpers ---------- */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const haptic = (ms = 10) => { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } };
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

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

/* ---------- navigation ---------- */

function showView(name) {
  if (name !== 'harmony') stopPlayback();
  state.view = name;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  if (name === 'harmony') renderHarmony();
  if (name === 'library') renderLibrary();
  if (name === 'capture') drawLive();
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { if (!rec) showView(t.dataset.view); }));
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.goto)));

/* ---------- capture ---------- */

let rec = null;
let starting = false;
let workletReady = false;
let lastTrace = [];
let liveCenter = 57;
let liveRaf = 0;

async function startRecording() {
  if (starting || rec) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Recording needs a secure (https) connection.');
    return;
  }
  starting = true;
  stopPlayback();
  const ctx = synth.ensure();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
  } catch {
    starting = false;
    toast('Alchemy needs microphone access to hear you.');
    return;
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
    node.port.onmessage = (e) => onChunk(e.data);
  } else {
    node = ctx.createScriptProcessor(1024, 1, 1);
    node.onaudioprocess = (e) => onChunk(e.inputBuffer.getChannelData(0).slice());
  }
  source.connect(node);
  node.connect(sink).connect(ctx.destination);

  rec = { stream, source, node, sink, chunks: [], length: 0, sr: ctx.sampleRate, recent: new Float32Array(2048), trace: [] };
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
  const cv = $('#liveCanvas');
  if (!cv.offsetParent && state.view !== 'capture') return;
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
    const natural = [0, 2, 4, 5, 7, 9, 11].includes(pc(m));
    g.fillStyle = natural ? token('--lane') : 'transparent';
    g.fillRect(left, y(m) - 0.5, w - left, 1);
    if (natural) {
      g.fillStyle = token('--faint');
      g.fillText(noteLabel(m), 8, y(m));
    }
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
  if (r.node.port) r.node.port.onmessage = null;
  else r.node.onaudioprocess = null;
  r.source.disconnect();
  r.node.disconnect();
  r.sink.disconnect();
  r.stream.getTracks().forEach((t) => t.stop());
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
  const samples = new Float32Array(r.length);
  let o = 0;
  for (const c of r.chunks) { samples.set(c, o); o += c.length; }
  await processAudio(samples, r.sr, defaultName());
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

function setProcessing(on, progress = 0) {
  $('#processing').classList.toggle('show', on);
  $('#processFill').style.height = `${Math.round(progress * 100)}%`;
}

async function processAudio(samples, sampleRate, name) {
  setProcessing(true, 0.05);
  await nextFrame();

  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak > 0.001) {
    const k = 0.9 / peak;
    for (let i = 0; i < samples.length; i++) samples[i] *= k;
  }

  const track = await extractTrack(samples, sampleRate, (p) => setProcessing(true, 0.05 + p * 0.85));
  const { notes, offset, trace, traceT0, hop } = segmentNotes(track);
  setProcessing(true, 1);
  await new Promise((r) => setTimeout(r, 250));
  setProcessing(false);

  if (notes.length < 3) {
    toast("I couldn't hear a clear melody. Try humming a little louder, one note at a time.");
    return;
  }

  loadTake({
    id: null,
    name,
    created: Date.now(),
    sampleRate,
    samples,
    duration: samples.length / sampleRate,
    notes, offset, trace, traceT0, hop,
  });
  haptic([8, 40, 8]);
  showView('harmony');
}

function loadTake(take, saved = {}) {
  stopPlayback();
  state.take = take;
  state.keys = detectKeys(take.notes);
  state.keyIdx = saved.keyIdx ?? 0;
  state.rhythm = saved.rhythm ?? state.rhythm;
  state.palette = saved.palette ?? state.palette;
  reharmonize();
  state.overrides = saved.overrides ?? {};
  take.dirty = false;
}

function reharmonize() {
  if (!state.take) return;
  state.overrides = {};
  state.harmony = harmonize(state.take.notes, state.keys[state.keyIdx], { rhythm: state.rhythm, palette: state.palette });
  if (state.take.id) state.take.dirty = true;
}

function resolvedSegments() {
  const { segments, vocab } = state.harmony;
  return segments.map((s, i) => ({ ...s, chord: state.overrides[i] != null ? vocab[state.overrides[i]] : s.chord }));
}

function takeRange() {
  const n = state.take.notes;
  return { start: Math.max(0, n[0].start - 0.15), end: Math.min(state.take.duration, n[n.length - 1].end + 0.3) };
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

  $('#takeName').textContent = take.name;
  $('#keyTitle').textContent = keyName(key);
  const { start, end } = takeRange();
  $('#keyMeta').textContent = `${Math.round(key.p * 100)}% likely · ${take.notes.length} notes · ${fmtTime(end - start)}`;

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
  $('#tuningHint').textContent = Math.abs(off) < 8 ? 'You sang right in tune' : `You sang ${Math.abs(off)}¢ ${off > 0 ? 'sharp' : 'flat'} of A440`;

  $('#saveBtn').classList.toggle('saved', !!take.id && !take.dirty);
  drawRoll();
}

function drawRoll(playT = null) {
  if (!state.take || state.view !== 'harmony') return;
  const cv = $('#rollCanvas');
  const { g, w, h } = fitCanvas(cv);
  const take = state.take;
  const key = state.keys[state.keyIdx];
  const segs = resolvedSegments();
  const { start, end } = takeRange();

  let lo = Infinity, hi = -Infinity;
  for (const n of take.notes) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
  lo -= 2; hi += 2;
  while (hi - lo < 12) { lo--; if (hi - lo < 12) hi++; }

  const left = 30, right = 8, top = 8, band = 34;
  const rollH = h - top - band - 10;
  const laneH = rollH / (hi - lo + 1);
  const x = (t) => left + ((t - start) / (end - start)) * (w - left - right);
  const laneY = (m) => top + (hi - m) * laneH;
  const scale = scalePcs(key);

  const cLane = token('--lane'), cTonic = token('--lane-tonic'), cFaint = token('--faint');
  const cGold = token('--gold'), cViolet = token('--violet'), cSurface2 = token('--surface-2');
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

  // Chord boundaries
  g.fillStyle = cLane;
  for (const s of segs.slice(1)) g.fillRect(Math.round(x(s.start)), top, 1, rollH);

  // Raw pitch trace
  g.strokeStyle = cViolet;
  g.globalAlpha = 0.55;
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

  // Quantized notes
  for (const n of take.notes) {
    const active = playT != null && playT >= n.start && playT < n.end;
    g.fillStyle = cGold;
    g.globalAlpha = playT == null || active ? 1 : 0.55;
    roundRect(g, x(n.start), laneY(n.midi) + 1, Math.max(3, x(n.end) - x(n.start) - 1.5), Math.max(3, laneH - 2), 3);
    g.fill();
  }
  g.globalAlpha = 1;

  // Chord band
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

/* ---------- playback ---------- */

function voiceBuffer() {
  const take = state.take;
  if (!take.buffer) {
    take.buffer = synth.ensure().createBuffer(1, take.samples.length, take.sampleRate);
    take.buffer.getChannelData(0).set(take.samples);
  }
  return take.buffer;
}

function startPlayback() {
  if (!state.take) return;
  stopPlayback();
  const ctx = synth.begin();
  const { start, end } = takeRange();
  const t0 = ctx.currentTime + 0.08;
  const level = state.mode === 'chords' ? 1 : 0.7;
  for (const s of resolvedSegments()) synth.chord(voicing(s.chord), t0 + s.start - start, s.end - s.start, level);
  if (state.mode === 'voice') synth.voice(voiceBuffer(), t0, start, end - start);
  if (state.mode === 'melody') for (const n of state.take.notes) synth.lead(n.midi, t0 + n.start - start, n.end - n.start);
  state.playing = { t0, start, end, raf: 0, seg: -1 };
  $('#playBtn').classList.add('playing');
  $('#playBtn').setAttribute('aria-label', 'Stop');
  tick();
}

function tick() {
  const p = state.playing;
  if (!p) return;
  const t = p.start + (synth.ctx.currentTime - p.t0);
  if (t >= p.end + 0.6) { stopPlayback(); return; }
  drawRoll(Math.max(p.start, Math.min(t, p.end)));
  const segs = resolvedSegments();
  const idx = segs.findIndex((s) => t >= s.start && t < s.end);
  if (idx !== p.seg) {
    p.seg = idx;
    document.querySelectorAll('.chord-card').forEach((c, i) => c.classList.toggle('now', i === idx));
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

$('#playBtn').addEventListener('click', () => (state.playing ? stopPlayback() : startPlayback()));

/* ---------- sheets ---------- */

function openSheet(html) {
  $('#sheetBody').innerHTML = html;
  $('#sheet').classList.add('show');
  $('#sheet').setAttribute('aria-hidden', 'false');
  $('#sheetBackdrop').classList.add('show');
}

function closeSheet() {
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
    if (state.take.id) state.take.dirty = true;
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
  take.id ??= crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const key = state.keys[state.keyIdx];
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
    keyIdx: state.keyIdx,
    rhythm: state.rhythm,
    palette: state.palette,
    overrides: state.overrides,
    summary: { key: keyName(key), chords: resolvedSegments().map((s) => s.chord.symbol), length: takeRange().end - takeRange().start },
  };
  try {
    await store.save(meta, take.samples);
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
  const trash = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  $('#libList').innerHTML = items
    .map((it) => `
      <li class="lib-item">
        <button class="lib-open" data-id="${esc(it.id)}">
          <span class="lib-title">${esc(it.name)}</span>
          <span class="lib-meta"><b>${esc(it.summary.key)}</b> · ${fmtTime(it.summary.length ?? it.duration)} · ${new Date(it.created).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
          <span class="lib-chords">${it.summary.chords.slice(0, 8).map((c) => `<span>${esc(c)}</span>`).join('')}${it.summary.chords.length > 8 ? '<span>…</span>' : ''}</span>
        </button>
        <button class="lib-del" data-del="${esc(it.id)}" aria-label="Delete ${esc(it.name)}">${trash}</button>
      </li>`)
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
    const { meta, samples } = await store.load(open.dataset.id);
    loadTake({ ...meta, samples, dirty: false }, meta);
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
  if (document.hidden) {
    stopPlayback();
    if (rec) stopRecording();
  }
});

resetLive();
drawLive();
if (location.hash === '#demo') $('#demoBtn').click();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
