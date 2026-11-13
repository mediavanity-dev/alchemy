import { extractTrack, segmentNotes, livePitch, normalizeLoudness, acRms, highpass, liveLowCut, loudness, soundStart, LOUDNESS_TARGET } from './pitch.js';
import { detectKeys, harmonize, keyName, spell, pc, noteLabel, scalePcs, voicing, voiceLead, bassLine, detectTempo, beatsBetween, rankChords, METERS, barBeats, rateOf, RATES, PALETTES } from './theory.js';
import { midiFile } from './midi.js';
import { findOnsets, chooseGrid, anchorsFor, timeMap, warp, warpTrace } from './timing.js';
import { Synth } from './synth.js';
import { tuneClip, targetFn } from './tune.js';
import { analyze, classify, chromaOf, hitsOf, normalizePeak } from './sound.js';
import * as store from './db.js';
import { SOUNDS, STYLES, soundOf, styleOf, chordEvents, playNote } from './instruments.js';
import { isNative, shareText, shareFile, onOpenedFile, headphonesIn, pro as proStore } from './native.js';

const $ = (sel) => document.querySelector(sel);
const MAX_SECONDS = 45;
const MAX_IMPORT_SECONDS = 90;
// Level of the count-in and recording click in headphones, where full level is harsh.
const HEADPHONE_CLICK = 0.45;
const MAX_LAYERS = 6;
const MAX_LAYER_SECONDS = 90;
const MIN_TRIM = 1;

const synth = new Synth();
const state = {
  view: 'capture',
  take: null,
  keys: [],
  keyIdx: 0,
  ideaIdx: 0, // which of the suggested progressions is showing
  rhythm: 'bar',
  palette: 'triads',
  harmony: null,
  overrides: {},
  playing: null,
  trimming: null,
  toneOctave: null,
  editing: null,
  countIn: { on: false, bpm: 100, meter: '4/4' },
  loop: false,
  metronome: false,
  pro: !isNative, // see Alchemy Pro below
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
  w = Math.max(0, w);
  h = Math.max(0, h);
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

// Opens the mic and streams raw blocks to onChunk(data, audioClockTime). Resolves
// once audio is actually flowing, so anything scheduled next is heard.
async function openMic(onChunk) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Recording needs a secure (https) connection.');
  synth.ensure(); // inside the tap, so the browser lets audio start
  setAudioSession('play-and-record');
  let stream;
  try {
    // No voice processing at all: any of it (auto gain especially) puts phones into
    // "call" audio, which turns everything the app plays down to call volume.
    // Levels are evened out after recording instead.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch {
    setAudioSession('playback');
    throw new Error('Alchemy needs microphone access to hear you.');
  }
  // The phone has now switched audio route; build the audio graph on a context made for it.
  const before = synth.ctx;
  const ctx = await synth.renew();
  if (ctx !== before) workletReady = false;
  let live;
  const flowing = new Promise((r) => (live = r));
  const deliver = (data, time) => { live(); onChunk(data, time); };
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
    node.port.onmessage = (e) => deliver(e.data.data, e.data.time);
  } else {
    node = ctx.createScriptProcessor(1024, 1, 1);
    node.onaudioprocess = (e) => deliver(e.inputBuffer.getChannelData(0).slice(), e.playbackTime - 1024 / ctx.sampleRate);
  }
  source.connect(node);
  node.connect(sink).connect(ctx.destination);
  const settings = stream.getAudioTracks()[0]?.getSettings?.() ?? {};
  // Wait for the first mic audio (a phone's first ever start can be slow), then a
  // moment more for the output route to settle (Bluetooth headsets take a while).
  await Promise.race([flowing, new Promise((r) => setTimeout(r, 5000))]);
  await new Promise((r) => setTimeout(r, 250));
  const headphones = await headphonesIn();
  return {
    sr: ctx.sampleRate,
    headphones,
    latency: typeof settings.latency === 'number' ? settings.latency : 0.01,
    close() {
      if (node.port) node.port.onmessage = null;
      else node.onaudioprocess = null;
      source.disconnect();
      node.disconnect();
      sink.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      setAudioSession('playback');
      // Back on the normal route: the next sound gets a fresh context at full volume.
      synth.retire();
    },
  };
}

/* ---------- navigation ---------- */

function showView(name) {
  if (name !== 'harmony') {
    stopPlayback();
    state.trimming = null;
    state.editing = null;
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
// Delay this device adds beyond what the browser reports (seconds), measured from
// the last count-in the mic heard. Used for the next count-in and for layers.
let latencyFix = 0;
let lastTrace = [];
let liveCenter = 57;
let liveRaf = 0;

async function startRecording() {
  if (starting || rec) return;
  starting = true;
  stopPlayback();
  synth.stopTone();
  $('#capturePrompt').textContent = 'Get ready…';
  let mic;
  // Audio that arrives while the mic is still settling is kept: without a count-in
  // it becomes the start of the take, so singing straight after the tap isn't lost.
  const early = [];
  try {
    mic = await openMic((data, time) => (rec ? onChunk(data, time) : early.push([data, time])));
  } catch (e) {
    starting = false;
    $('#capturePrompt').textContent = 'Tap record, then sing or play a melody';
    toast(e.message);
    return;
  }
  rec = { mic, chunks: [], length: 0, sr: mic.sr, recent: new Float32Array(2048), trace: [], startAt: -Infinity };
  starting = false;

  document.body.classList.add('recording');
  $('#recBtn').setAttribute('aria-label', 'Stop recording');
  $('#recWord').textContent = 'stop';
  $('#recTime').textContent = '0:00';
  haptic(15);
  rec.timer = setInterval(() => {
    const s = rec.length / rec.sr;
    $('#recTime').textContent = `${fmtTime(s)} / ${fmtTime(MAX_SECONDS)}`;
    if (s >= MAX_SECONDS) stopRecording();
  }, 200);

  if (state.countIn.on) startCountIn();
  else {
    $('#capturePrompt').textContent = 'Listening…';
    // Skip the first few blocks, where a mic can click as it opens.
    let skip = Math.round(mic.sr * 0.05);
    for (const [data, time] of early) {
      if (skip >= data.length) { skip -= data.length; continue; }
      onChunk(skip ? data.subarray(skip) : data, time == null ? time : time + skip / mic.sr);
      skip = 0;
    }
  }
}

// One bar of clicks counted down (4-3-2-1 in 4/4); the take starts on the beat after
// "1". Everything the mic hears before then (including the clicks) is discarded.
function startCountIn() {
  const ctx = synth.ctx;
  const { bpm, meter } = state.countIn;
  const beat = 60 / bpm;
  const n = barBeats(meter);
  const t0 = ctx.currentTime + 0.3;
  // In headphones the clicks are gentler, and keep time through the whole take
  // (nothing leaks into the mic). On the speaker they stop on the 1.
  const keepTime = rec.mic.headphones;
  synth.countIn(t0, beat, n, countLevel(keepTime));
  // Align the take with when the singer actually hears the beat, plus the mic's own
  // delay: as reported, plus what the last count-in showed the report misses. The
  // count-in itself is measured when the take stops (see measureRoundTrip).
  const outLatency = ctx.outputLatency || ctx.baseLatency || 0;
  const assumed = outLatency + rec.mic.latency;
  const used = Math.max(0, assumed + latencyFix);
  Object.assign(rec, { counting: true, countT0: t0, beat, bpm, meter, bar: n, assumed, used, pre: [], startAt: t0 + n * beat + used });
  if (keepTime) {
    let next = n;
    const r = rec;
    const ahead = () => {
      if (rec !== r) return;
      for (; t0 + next * beat < ctx.currentTime + 1; next++) synth.countClick(t0 + next * beat, next % n === 0);
      setTimeout(ahead, 250);
    };
    ahead();
  }
  $('#capturePrompt').textContent = 'Get ready…';
  const noteEl = $('#liveNote');
  noteEl.classList.add('count');
  noteEl.classList.remove('idle');
  noteEl.textContent = '';
  const r = rec;
  const step = () => {
    if (rec !== r || !r.counting) return;
    const k = Math.floor((ctx.currentTime - r.countT0) / r.beat);
    if (k >= r.bar) {
      r.counting = false;
      noteEl.classList.remove('count');
      resetLive();
      $('#capturePrompt').textContent = 'Listening…';
      haptic(15);
      return;
    }
    if (k >= 0 && noteEl.textContent !== String(r.bar - k)) {
      noteEl.textContent = r.bar - k;
      haptic(8);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  startBeatGuide(r, t0 + outLatency);
}

// Silent visual pulse in tempo: one bar of dots (beat 1 accented) and a ring flash,
// timed to when each click reaches the singer's ears. Runs from the count-in
// through the whole take.
function startBeatGuide(r, gridT0) {
  const ctx = synth.ctx;
  const wrap = $('#beatDots');
  wrap.innerHTML = '<i></i>'.repeat(r.bar);
  const dots = [...wrap.children];
  const ring = $('#recRing');
  wrap.hidden = false;
  const frame = () => {
    if (rec !== r) {
      wrap.hidden = true;
      dots.forEach((d) => d.classList.remove('on'));
      ring.classList.remove('beat');
      return;
    }
    const pos = (ctx.currentTime - gridT0) / r.beat;
    const k = Math.floor(pos), frac = pos - k;
    const idx = pos < 0 ? -1 : k % r.bar;
    dots.forEach((d, i) => d.classList.toggle('on', i === idx && frac < 0.55));
    ring.classList.toggle('beat', pos >= 0 && frac < 0.18);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// The room's background level, followed while the mic is open (the count-in too):
// it drops quickly to anything quieter and creeps up 1 dB a second, so it settles
// on the quiet between notes. The live note readout and the record ring
// are judged against it rather than a fixed level, so soft singing still shows.
function trackFloor(chunk) {
  const lvl = Math.max(1e-6, acRms(chunk));
  rec.floor = rec.floor == null ? lvl : lvl < rec.floor ? rec.floor + (lvl - rec.floor) * 0.5 : rec.floor * 10 ** ((1 / 20) * (chunk.length / rec.sr));
}

// Never stricter than the old fixed gate, so sustained singing can't gate itself out.
const liveGate = () => Math.max(2e-5, Math.min(0.003, rec.floor * 2.5));

function onChunk(chunk, time) {
  if (!rec) return;
  // The live readout works on a copy with low rumble taken out; the take keeps
  // the raw audio.
  rec.lowCut ??= liveLowCut(rec.sr);
  let heard = rec.lowCut(chunk);
  trackFloor(heard);
  // Audio from before the take starts (the count-in) is set aside: it's used to
  // measure the device's delay, and never becomes part of the take.
  if (time != null && time < rec.startAt) {
    const skip = Math.round((rec.startAt - time) * rec.sr);
    if (rec.pre && time >= rec.countT0 - 0.25) rec.pre.push({ time, data: chunk.subarray(0, Math.min(skip, chunk.length)) });
    if (skip >= chunk.length) return;
    chunk = chunk.subarray(skip);
    heard = heard.subarray(skip);
  }
  rec.chunks.push(chunk);
  rec.length += chunk.length;
  const r = rec.recent;
  r.copyWithin(0, heard.length);
  r.set(heard, r.length - heard.length);
  const p = livePitch(r, rec.sr, liveGate());
  const t = rec.length / rec.sr;
  const midi = steadyPitch(p.midi, t);
  rec.trace.push({ t, midi });
  updateLive({ ...p, midi }, liveGate() / 2.5);
}

// Quiet input lets the odd stray reading through (noise, or a jump to the wrong
// octave), which drew as a spike. A reading that starts a line, or leaps more than
// a couple of semitones from it, is shown only once the next reading agrees.
// That costs one block (about 20 ms) at the start of a real new note.
function steadyPitch(midi, t) {
  if (midi == null) { rec.cand = null; return null; }
  const onLine = rec.lastMidi != null && t - rec.lastT < 0.15 && Math.abs(midi - rec.lastMidi) < 2.5;
  const confirmed = rec.cand != null && Math.abs(midi - rec.cand) < 1;
  if (!onLine && !confirmed) { rec.cand = midi; return null; }
  rec.cand = null;
  rec.lastMidi = midi;
  rec.lastT = t;
  return midi;
}

function updateLive(p, floor = 1e-4) {
  // In decibels above the room, so a quiet voice moves the ring as visibly as a loud one.
  const level = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(p.rms, 1e-7) / floor) - 6) / 34));
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
  // Labels thin out when the graph is short, so they never overlap.
  let lastLabel = Infinity;
  for (let m = Math.ceil(lo); m <= Math.floor(hi); m++) {
    if (![0, 2, 4, 5, 7, 9, 11].includes(pc(m))) continue;
    g.fillStyle = token('--lane');
    g.fillRect(left, y(m) - 0.5, w - left, 1);
    if (lastLabel - y(m) < 12 || y(m) < 6 || y(m) > h - 6) continue;
    lastLabel = y(m);
    g.fillStyle = token('--faint');
    g.fillText(noteLabel(m), 8, y(m));
  }

  // With a count-in, beat lines scroll with the trace (bar lines stronger), so you
  // can see your notes land on the beat. The take starts on beat 1 at t = 0.
  if (rec?.bpm && now > 0) {
    g.fillStyle = token('--gold');
    for (let k = Math.max(0, Math.ceil((now - span) / rec.beat)); k * rec.beat <= now; k++) {
      const bx = w - 6 - ((now - k * rec.beat) / span) * (w - left - 6);
      const bar = k % rec.bar === 0;
      g.globalAlpha = bar ? 0.5 : 0.2;
      g.fillRect(Math.round(bx), 0, bar ? 2 : 1, h);
    }
    g.globalAlpha = 1;
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
  synth.stopCountIn();
  lastTrace = r.trace;

  document.body.classList.remove('recording');
  $('#recBtn').setAttribute('aria-label', 'Start recording');
  $('#recWord').textContent = 'record';
  $('#capturePrompt').textContent = 'Tap record, then sing or play a melody';
  $('#recTime').textContent = 'Tap to record';
  $('#liveNote').classList.remove('count');
  resetLive();
  haptic(10);

  if (r.counting) return; // cancelled during the count-in
  if (r.length < r.sr * 0.8) {
    toast('That was a bit short. Sing or hum for a second or more.');
    return;
  }
  // With a count-in, the beat grid is known exactly: the take starts on a downbeat.
  const tempo = r.bpm ? { bpm: r.bpm, beat: 60 / r.bpm, downbeat: 0, steady: true, manual: true, source: 'countin', meter: r.meter } : null;
  // The last moment holds the tap on Stop, which levelling would make loud.
  const samples = r.bpm ? alignToCountIn(r) : concat(r.chunks, r.length);
  const tap = Math.round(r.sr * 0.15);
  await processAudio(samples.length > tap * 4 ? samples.subarray(0, samples.length - tap) : samples, r.sr, defaultName(), tempo);
}

// The take, starting exactly where the singer heard the first beat after the
// count-in. When the mic heard the count-in clicks, the delay is measured and the
// start corrected: trimmed if the take began early, or the missing moment taken
// back from the count-in audio if it began late.
function alignToCountIn(r) {
  let samples = concat(r.chunks, r.length);
  const measured = measureRoundTrip(r);
  if (measured == null) return samples;
  latencyFix = measured - r.assumed;
  const shift = Math.round((measured - r.used) * r.sr);
  if (shift > 0) return samples.slice(Math.min(shift, samples.length - 1));
  if (shift < 0) {
    const preLen = r.pre.reduce((a, p) => a + p.data.length, 0);
    const pre = concat(r.pre.map((p) => p.data), preLen);
    const take = Math.min(-shift, pre.length);
    const out = new Float32Array(take + samples.length);
    out.set(pre.subarray(pre.length - take));
    out.set(samples, take);
    samples = out;
  }
  return samples;
}

// The count-in clicks come back through the mic when they play from the speaker
// (or leak from headphones), and where they land shows the real delay from
// scheduling a sound to recording it: output and input together, which browsers
// often under-report (Bluetooth especially). Clicks are found above 1 kHz, where
// they are strong and voices are weak; at least three must agree to within 15 ms.
// Returns null when they can't be heard clearly, and the reported delay stands.
function measureRoundTrip(r) {
  if (!r.pre?.length) return null;
  const sr = r.sr, t0 = r.pre[0].time;
  const x = concat(r.pre.map((p) => p.data), r.pre.reduce((a, p) => a + p.data.length, 0));
  highpass(x, sr, 1000);
  const blk = Math.max(1, Math.round(sr * 0.001)), nb = Math.floor(x.length / blk);
  if (nb < 50) return null;
  const e = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    let s = 0;
    for (let i = b * blk; i < (b + 1) * blk; i++) s += x[i] * x[i];
    e[b] = Math.sqrt(s / blk);
  }
  const floor = Float32Array.from(e).sort()[Math.floor(nb * 0.2)] || 1e-9;
  const found = [];
  for (let k = 0; k < r.bar; k++) {
    const s = r.countT0 + k * r.beat;
    const a = Math.round((s - t0) / 0.001), b = Math.min(nb, a + Math.round(Math.min(0.4, r.beat - 0.03) / 0.001));
    if (a < 0 || b <= a) continue;
    let peak = 0;
    for (let i = a; i < b; i++) peak = Math.max(peak, e[i]);
    if (peak < floor * 10) continue;
    let i = a;
    while (i < b && e[i] < peak * 0.3) i++;
    found.push(t0 + i * 0.001 - s);
  }
  if (found.length < Math.min(3, r.bar)) return null;
  found.sort((a, b) => a - b);
  if (found[found.length - 1] - found[0] > 0.015) return null;
  const median = found[found.length >> 1];
  return median > 0.002 && median < 0.5 ? median : null;
}

/* ---------- count-in ---------- */

function loadCountIn() {
  const fallback = { on: false, bpm: 100, meter: '4/4', vol: 1 };
  try {
    const saved = { ...fallback, ...JSON.parse(localStorage.getItem('alchemy.countIn') ?? '{}') };
    return METERS.includes(saved.meter) ? saved : { ...saved, meter: '4/4' };
  } catch { return fallback; }
}

// The count-in's level (and the click through a take in headphones): the volume
// set in the Count-in sheet, gentler again in headphones.
const countLevel = (headphones) => (state.countIn.vol ?? 1) * (headphones ? HEADPHONE_CLICK : 1);

async function previewCountIn(beats) {
  const ctx = synth.ensure();
  const level = countLevel(await headphonesIn());
  synth.countIn(ctx.currentTime + 0.05, 60 / state.countIn.bpm, beats ?? barBeats(state.countIn.meter), level);
}

function saveCountIn() {
  try { localStorage.setItem('alchemy.countIn', JSON.stringify(state.countIn)); } catch { /* storage unavailable */ }
  renderCountIn();
}

function renderCountIn() {
  const { on, bpm, meter } = state.countIn;
  $('#countBtn').setAttribute('aria-pressed', String(on));
  $('#countText').textContent = on ? `Count-in · ${bpm} bpm · ${meter}` : 'Count-in off';
}

// A row of time signatures for a sheet; buttons carry data-meter.
const meterSeg = (current) => `<div class="seg meter-seg" role="group" aria-label="Time signature">
  ${METERS.map((m) => `<button data-meter="${m}" class="${m === current ? 'active' : ''}">${m}</button>`).join('')}
</div>`;

$('#countBtn').addEventListener('click', openCountInSheet);

function openCountInSheet() {
  const { on, bpm, meter } = state.countIn;
  openSheet(`<div class="count-sheet">
    <h3>Count-in</h3>
    <p class="sub">One bar of clicks (4, 3, 2, 1 in 4/4) before recording starts, so you come in on time. On the speaker the clicks stop on the 1 and aren't recorded. With headphones in, a softer click keeps time through the whole take.</p>
    <div class="seg" role="group" aria-label="Count-in">
      <button data-on="0" class="${on ? '' : 'active'}">Off</button>
      <button data-on="1" class="${on ? 'active' : ''}">On</button>
    </div>
    <div class="tempo-row" style="margin-top:18px">
      <button class="icon-btn" data-step="-1" aria-label="Slower">−</button>
      <div class="tempo-value">${bpm}<small>BPM</small></div>
      <button class="icon-btn" data-step="1" aria-label="Faster">+</button>
    </div>
    <div class="tempo-tools" style="grid-template-columns:1fr 1fr">
      <button class="btn" id="countTap">Tap tempo</button>
      <button class="btn" id="countPreview">Preview</button>
    </div>
    ${meterSeg(meter)}
    <label class="vol-row">Click volume<input type="range" id="countVol" min="0.05" max="1" step="0.05" value="${state.countIn.vol ?? 1}"></label>
  </div>`);

  const body = $('#sheetBody .count-sheet');
  $('#countVol').addEventListener('input', (e) => { state.countIn = { ...state.countIn, vol: +e.target.value }; saveCountIn(); });
  $('#countVol').addEventListener('change', () => previewCountIn(1));
  const setBpm = (v) => {
    state.countIn = { ...state.countIn, on: true, bpm: Math.max(40, Math.min(240, Math.round(v))) };
    saveCountIn();
    openCountInSheet();
  };
  body.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.on) {
      state.countIn = { ...state.countIn, on: b.dataset.on === '1' };
      saveCountIn();
      openCountInSheet();
    } else if (b.dataset.step) setBpm(state.countIn.bpm + +b.dataset.step);
    else if (b.dataset.meter) {
      state.countIn = { ...state.countIn, on: true, meter: b.dataset.meter };
      saveCountIn();
      openCountInSheet();
    } else if (b.id === 'countPreview') {
      previewCountIn();
    } else return;
    haptic();
  });
  const taps = [];
  $('#countTap').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(now);
    haptic(5);
    if (taps.length >= 4) {
      const bpm = Math.round(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)));
      body.querySelector('.tempo-value').firstChild.textContent = bpm;
      clearTimeout(openCountInSheet.tapTimer);
      openCountInSheet.tapTimer = setTimeout(() => { if (body.isConnected) setBpm(bpm); }, 1200);
    } else {
      e.currentTarget.textContent = `Tap ${4 - taps.length} more`;
    }
  });
}

function defaultName() {
  return 'Take · ' + new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

$('#recBtn').addEventListener('click', () => (rec ? stopRecording() : startRecording()));

// In the iPhone app, Import offers Files and explains Voice Memos: iOS gives apps
// no way into the Voice Memos library, so a memo comes in through its Share button
// (see onOpenedFile below). In a browser it goes straight to the file picker.
$('#importBtn').addEventListener('click', () => {
  if (!isNative) { $('#fileInput').click(); return; }
  openSheet(`<div class="import-sheet">
    <h3>Import audio</h3>
    <p class="sub">Bring in a recording of your tune. Alchemy uses up to the first ${MAX_IMPORT_SECONDS} seconds.</p>
    <button class="btn primary block" id="importFiles">Choose from Files</button>
    <h4>From Voice Memos</h4>
    <ol class="howto">
      <li>Open <b>Voice Memos</b> and tap your recording.</li>
      <li>Tap <b>•••</b>, then <b>Share</b>.</li>
      <li>Tap <b>Alchemy</b>. If it isn't in the row of apps, swipe to the end and tap <b>More</b>.</li>
    </ol>
    <p class="sub">Alchemy opens with the memo, ready to harmonize. You can also tap <b>Save to Files</b> there, then use Choose from Files.</p>
  </div>`);
  $('#importFiles').addEventListener('click', () => { closeSheet(); $('#fileInput').click(); });
});

$('#fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  await importAudio(await file.arrayBuffer(), file.name);
});

async function importAudio(data, fileName) {
  const ctx = synth.ensure();
  let buf;
  try {
    buf = await ctx.decodeAudioData(data);
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
  await processAudio(mono, buf.sampleRate, fileName.replace(/\.[^.]+$/, ''));
}

// In the iPhone app, audio shared to Alchemy (Voice Memos → Share → Alchemy) opens
// the same way as Import audio.
if (isNative) {
  onOpenedFile(async (data, name, truncated) => {
    if (rec || layerRec || starting) { toast('Finish recording first, then share the file again.'); return; }
    stopPlayback();
    closeSheet();
    showView('capture');
    await importAudio(data, name);
    if (truncated) toast(`Using the first ${MAX_IMPORT_SECONDS} seconds.`);
  }, () => toast("Couldn't open that recording. Try Save to Files in Voice Memos, then Import audio."), MAX_IMPORT_SECONDS).catch(() => {});
}

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

// Pitch tracking runs in a worker so the page stays smooth during a long take. If
// the worker can't start (an older browser), it runs here as before.
let trackWorker = null, jobSeq = 0;
const trackJobs = new Map();
function trackOf(samples, sr, onProgress) {
  if (trackWorker === null) {
    try {
      trackWorker = new Worker(new URL('./track-worker.js', import.meta.url), { type: 'module' });
      trackWorker.onmessage = ({ data }) => {
        const job = trackJobs.get(data.id);
        if (!job) return;
        if ('progress' in data) { job.onProgress?.(data.progress); return; }
        trackJobs.delete(data.id);
        if (data.error) job.fallback(); else job.done(data.track);
      };
      trackWorker.onerror = (e) => {
        e.preventDefault?.();
        trackWorker = false;
        for (const job of trackJobs.values()) job.fallback();
        trackJobs.clear();
      };
    } catch {
      trackWorker = false;
    }
  }
  if (!trackWorker) return extractTrack(samples, sr, onProgress);
  return new Promise((resolve) => {
    const id = ++jobSeq;
    trackJobs.set(id, {
      onProgress,
      done: resolve,
      fallback: () => resolve(extractTrack(samples, sr, onProgress)),
    });
    // Copied, not transferred: the caller keeps using the samples.
    trackWorker.postMessage({ id, samples, sr });
  });
}

async function processAudio(samples, sampleRate, name, tempo = null) {
  setProcessing(true, 0.05);
  await nextFrame();
  const raw = samples.slice();
  normalizeLoudness(samples, sampleRate);

  const track = await trackOf(samples, sampleRate, (p) => setProcessing(true, 0.05 + p * 0.85));
  let { notes, offset, trace, traceT0, hop } = segmentNotes(track);
  // Whatever notes the take has are harmonized as its tune, however rhythmic or
  // chordal it sounded (the classifier leans towards melody).
  const { kind, features } = classify(raw, sampleRate, track);
  // Plucked and struck sounds (short, decaying notes) are levelled by their peaks,
  // so their attacks aren't rounded off the way loudness levelling (made for
  // singing) would.
  if (features.decay < 0.6) samples = normalizePeak(raw, sampleRate);
  setProcessing(true, 1);
  await new Promise((r) => setTimeout(r, 250));
  setProcessing(false);

  // A beat (beatbox, tapping) loads as a beat, with its tempo and chords in a key
  // across it; a tune can go on top as a layer and lead the chords from there.
  // Stray "notes" in a beat (a kick's thump) aren't a tune to follow. Anything
  // else with even one clear note is a tune, however short.
  let hits = null;
  if (notes.length === 0 || kind === 'rhythm') {
    hits = hitsOf(raw, sampleRate);
    if (hits.length >= 4) notes = [];
    else if (!notes.length) {
      toast("I couldn't hear a note. Try singing or playing a little louder.", 5000);
      return;
    } else hits = null;
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
    tempo,
    hits,
  });
  haptic([8, 40, 8]);
  showView('harmony');
}

function loadTake(take, saved = {}) {
  stopPlayback();
  state.trimming = null;
  state.editing = null;
  take.layers ??= [];
  take.trim ??= { start: 0, end: take.duration };
  take.tune ??= { amount: 0, mode: 'chromatic' };
  take.tempo ??= detectTempo(withHits(take.notes, take.hits));
  take.mix = { ...defaultMix(), ...take.mix };
  take.layers.forEach(prepareLayer);
  state.take = take;
  state.keys = findKeys();
  // The saved key itself, not its place in the ranking (which can change as the
  // analysis improves); older saves only have the key's name.
  const savedKey = state.keys.findIndex((k) => saved.key
    ? k.tonic === saved.key.tonic && k.mode === saved.key.mode
    : saved.summary?.key && keyName(k) === saved.summary.key);
  state.keyIdx = savedKey >= 0 ? savedKey : Math.min(saved.keyIdx ?? 0, state.keys.length - 1);
  state.rhythm = rateOf(saved.rhythm ?? state.rhythm);
  state.palette = { simple: 'triads', rich: 'chromatic' }[saved.palette] ?? saved.palette ?? state.palette;
  if (locked('palette', state.palette)) state.palette = 'triads';
  reharmonize(saved.idea > 0 ? saved.idea : 0);
  state.overrides = saved.overrides ?? {};
  // Chord timing the user edited by hand
  if (saved.segments?.length) {
    const { vocab } = state.harmony;
    state.harmony.segments = saved.segments.map((s) => ({ start: s.start, end: s.end, chord: vocab[s.chordId] ?? vocab[0], edited: s.edited }));
    state.harmony.segments.forEach(refitSegment);
    state.overrides = {};
  }
  take.dirty = false;
}

// Refreshes a chord's suggestions (and the notes under it) after its timing or notes changed.
function refitSegment(seg) {
  const { ranked, pcs } = rankChords(analysisNotes(), state.keys[state.keyIdx], state.harmony.vocab, seg.start, seg.end, harmonyOptions());
  seg.alts = ranked.slice(0, 6);
  // Keep the current chord on the list, even one from outside the chosen chord set.
  if (!seg.alts.some((a) => a.chord === seg.chord)) seg.alts[seg.alts.length - 1] = ranked.find((a) => a.chord === seg.chord) ?? { chord: seg.chord, score: 0 };
  seg.pcs = pcs;
}

// The notes the harmony is built from: the (trimmed) take plus any melody layers the
// user opted in. Layers may run past the end of the take, so only the trim start bounds them.
function analysisNotes() {
  const { notes, layers, trim } = state.take;
  const extra = layers
    .filter((l) => l.included && kindOf(l) === 'melody')
    .flatMap((l) => l.notes.filter((n) => n.start >= trim.start - 0.05));
  return [...notes, ...extra].sort((a, b) => a.start - b.start);
}

function markDirty() {
  if (state.take?.id) state.take.dirty = true;
}

// Chord changes always follow bar lines ("chord every bar" and so on): the count-in's
// tempo, one set by hand, or failing those the detected one, which the user can
// correct from the tempo button.
function harmonyOptions() {
  return { rhythm: state.rhythm, palette: state.palette, tempo: state.take?.tempo ?? null, played: playedSources(), span: beatSpan() };
}

// The likely keys. A beat on its own has no notes to go by, so it's offered the
// common keys, a minor one first, and it plays a familiar loop in whichever is picked.
const BEAT_KEYS = ['A minor', 'C major', 'E minor', 'G major', 'D minor', 'F major'];
function findKeys() {
  const notes = analysisNotes(), played = playedSources();
  const keys = detectKeys(notes, played);
  if (notes.length || played.length) return keys;
  const common = BEAT_KEYS.map((name) => keys.find((k) => keyName(k) === name)).filter(Boolean);
  return [...common, ...keys.filter((k) => !common.includes(k))];
}

// A beat-only take (no tune of its own): where its hits start and end within the trim.
function beatSpan() {
  const take = state.take;
  if (!take?.hits?.length || take.notes.length) return null;
  const { start, end } = take.trim;
  const ts = take.hits.map((h) => h.t).filter((t) => t >= start - 0.05 && t <= end);
  return ts.length >= 2 ? [ts[0], Math.min(end, ts[ts.length - 1] + 0.3)] : null;
}

// Notes plus a beat's hits as short events, for finding the tempo.
const withHits = (notes, hits) => (hits?.length
  ? [...notes, ...hits.map((h) => ({ start: h.t, end: h.t + 0.1 }))].sort((a, b) => a.start - b.start)
  : notes);

// A beat grid the user has confirmed: their count-in, or a tempo they set.
function trustedTempo() {
  const t = state.take?.tempo;
  return t && (t.source === 'countin' || t.manual) ? t : null;
}

// Re-fits the chords. `idea` is the progression to show (the nearest one there
// is): changing "Chord every" or "Chords" keeps the progression you were on.
function reharmonize(idea = 0) {
  if (!state.take) return;
  state.overrides = {};
  state.harmony = harmonize(analysisNotes(), state.keys[state.keyIdx], harmonyOptions());
  state.ideaIdx = ideaAt(state.harmony, locked('idea', idea) ? 0 : idea);
  if (state.ideaIdx > 0) state.harmony.segments = state.harmony.alternatives[state.ideaIdx];
  state.noChoice = settingsWithoutChoice();
  // A detected beat grid takes the bar lines the harmony settled on (a pickup moves them).
  const t = state.take.tempo;
  if (t && state.harmony.downbeat != null && t.source !== 'countin' && !t.manual) t.downbeat = state.harmony.downbeat;
  markDirty();
}

// The three rows work top down: Progressions, then "Chord every", then "Chords".
// "Chord every" and "Chords" only offer options that change the chord chart
// you're looking at: the progression picked above, as each option would give it.
// A short, simple tune, say, gets the same one chord at every rate but the beat,
// so only "Bar" and "Beat" are offered; if no option would change anything, a
// note says so instead. Of options that give the same chart, the first is offered
// (the current one always stays). Changing a lower row never moves an upper one:
// the progression number stays, and every row is re-checked against the result.
// Returns { rhythm, palette }: the set of hidden values for each.
const SETTING_VALUES = { rhythm: RATES, palette: PALETTES };
// The chords and where each one changes. A chord repeated across bars counts once,
// so "Am for two bars" and "Am, Am" are the same progression.
const progressionSig = (h) => h.segments
  .filter((s, i, all) => i === 0 || all[i - 1].chord.id !== s.chord.id)
  .map((s) => `${s.start.toFixed(2)}:${s.chord.id}`).join('|');
// The progression a harmony shows for a given Progressions choice: that one, or
// its last if it offers fewer.
const ideaAt = (h, i) => Math.max(0, Math.min(i, (h.alternatives?.length ?? 1) - 1));
const chartOf = (h, i) => progressionSig({ segments: h.alternatives?.length ? h.alternatives[ideaAt(h, i)] : h.segments });

function settingsWithoutChoice() {
  const notes = analysisNotes(), key = state.keys[state.keyIdx], base = harmonyOptions();
  const out = {};
  for (const [setting, values] of Object.entries(SETTING_VALUES)) {
    const open = values.filter((v) => v === state[setting] || !locked(setting, v));
    const sigs = new Map(open.map((v) => [v, v === state[setting]
      ? progressionSig(state.harmony)
      : chartOf(harmonize(notes, key, { ...base, [setting]: v }), state.ideaIdx)]));
    const offered = new Set([sigs.get(state[setting])]);
    out[setting] = new Set(values.filter((v) => !open.includes(v)));
    for (const v of open) {
      if (v === state[setting]) continue;
      if (offered.has(sigs.get(v))) out[setting].add(v);
      else offered.add(sigs.get(v));
    }
  }
  return out;
}

// Shows one of the suggested progressions: different chords for the same melody,
// in the same key.
function setIdea(i) {
  const ideas = state.harmony?.alternatives ?? [];
  if (!ideas[i] || i === state.ideaIdx || locked('idea', i)) return;
  stopPlayback();
  state.ideaIdx = i;
  state.harmony.segments = ideas[i];
  state.overrides = {};
  state.noChoice = settingsWithoutChoice();
  markDirty();
  renderHarmony();
  haptic();
}

// After the beat grid changed: re-fit chords to the new bar lines, unless the user
// has already picked or shaped chords by hand.
function regrid() {
  if (Object.keys(state.overrides).length || hasEdits()) return;
  reharmonize(state.ideaIdx);
}

// Full re-analysis after the material changed (trim, layer opted in or out).
function reanalyze() {
  stopPlayback();
  retempo();
  state.keys = findKeys();
  state.keyIdx = 0;
  reharmonize();
  renderHarmony();
}

// Re-fit the beat grid to the current notes, keeping a tempo the user set by hand.
function retempo() {
  const take = state.take;
  // A count-in tempo is ground truth for the take; never re-detect it. Nor a grid
  // the trim was snapped to.
  if (take.tempo?.source === 'countin' || take.trim?.snap) return;
  const manual = take.tempo?.manual ? take.tempo.bpm : null;
  const meter = take.tempo?.meter;
  // Drum hits are good evidence for where the beat is.
  const hits = take.layers
    .filter((l) => kindOf(l) === 'rhythm')
    .flatMap((l) => l.hits.map((h) => ({ start: l.offset + h.t, end: l.offset + h.t + 0.1 })));
  take.tempo = detectTempo(withHits([...take.notes, ...hits].sort((a, b) => a.start - b.start), take.hits), manual);
  if (take.tempo && manual) take.tempo.manual = true;
  if (take.tempo && meter) take.tempo.meter = meter;
}

// The progression as it stands (with the user's picks), each chord with its bass
// note: usually the root, sometimes an inversion that makes a smoother bass line.
function resolvedSegments() {
  const { segments, vocab } = state.harmony;
  const segs = segments.map((s, i) => ({ ...s, chord: state.overrides[i] != null ? vocab[state.overrides[i]] : s.chord }));
  const bass = bassLine(segs.map((s) => s.chord));
  return segs.map((s, i) => ({ ...s, bass: bass[i] }));
}

// When the take's sound first rises above the room, worked out once per recording.
function firstSound() {
  const take = state.take;
  if (take.soundStartFor !== take.samples) {
    take.soundStart = soundStart(take.samples, take.sampleRate);
    take.soundStartFor = take.samples;
  }
  return take.soundStart;
}

// "G/B" when the bass isn't the root.
function chordLabel(s, key = state.keys[state.keyIdx]) {
  if (s.bass == null || s.bass === s.chord.root) return s.chord.symbol;
  return `${s.chord.symbol}/${spell(s.bass, key, s.chord.symbol.includes('♭'))}`;
}

// The timeline: the trimmed take, stretched to cover any layer that runs longer.
function takeRange() {
  const n = analysisNotes();
  const { trim, notes, layers } = state.take;
  if (trim.snap) return { start: trim.start, end: trim.end };
  const lastBase = notes.reduce((m, x) => Math.max(m, x.end), 0);
  let end = Math.min(trim.end, lastBase + 0.3);
  for (const x of n) end = Math.max(end, x.end + 0.3);
  for (const l of layers) end = Math.max(end, l.offset + l.duration);
  const beat = beatSpan();
  if (beat) end = Math.max(end, beat[1]);
  // From the first sound, even if the first notes were too soft to be picked out
  const heard = firstSound() >= trim.start ? firstSound() : Infinity;
  const first = Math.min(n[0]?.start ?? Infinity, beat?.[0] ?? Infinity, heard);
  return { start: Number.isFinite(first) ? Math.max(trim.start, first - 0.15) : trim.start, end };
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
  const editing = !!state.editing;

  $('#harmonyContent').classList.toggle('trimming', trimming);
  $('#harmonyContent').classList.toggle('editing', editing);
  $('#rollCanvas').classList.toggle('trim', trimming);
  $('#rollCanvas').classList.toggle('editing', editing);
  $('#rollBar').hidden = trimming || editing;
  $('#trimBar').hidden = !trimming;
  $('#editBar').hidden = !editing;
  $('#editReset').hidden = !hasEdits();

  $('#takeName').textContent = take.name;
  $('#keyTitle').textContent = keyName(key);
  const { start, end } = takeRange();
  const included = take.layers.filter((l) => l.included).length;
  $('#keyMeta').textContent =
    (beatSpan() ? `Beat${take.tempo ? ` · ${Math.round(take.tempo.bpm)} bpm` : ''} · ${fmtTime(end - start)}` : `${Math.round(key.p * 100)}% likely · ${take.notes.length} notes · ${fmtTime(end - start)}`) +
    (included ? ` · +${included} layer${included > 1 ? 's' : ''}` : '');

  const trimmed = take.trim.start > 0.05 || take.trim.end < take.duration - 0.05;
  $('#rollInfo').textContent = trimmed ? `${fmtTime(take.trim.start)}–${fmtTime(take.trim.end)}` : fmtTime(take.duration);
  $('#rollInfo').title = trimmed ? 'Trimmed section' : 'Recording length';
  // The progressions on offer for this key, numbered; a note when there's only one
  const ideaCount = state.harmony.alternatives?.length ?? 0;
  $('#ideaLabel').textContent = `Progressions in ${keyName(key)}`;
  $('#ideaSeg').innerHTML = Array.from({ length: ideaCount }, (_, i) =>
    `<button data-i="${i}" class="${i === state.ideaIdx ? 'active' : ''}" aria-label="Progression ${i + 1} of ${ideaCount}">${i + 1}</button>`).join('');
  $('#ideaSeg').style.display = ideaCount < 2 ? 'none' : '';
  $('#ideaControl .no-choice').hidden = ideaCount >= 2;
  // The free version has "Chord every"; Progressions and Chords come with Pro.
  $('#ideaControl').style.display = state.pro ? '' : 'none';
  $('#paletteControl').style.display = state.pro ? '' : 'none';
  $('#rhythmControl').classList.toggle('wide', !state.pro);
  const tempoBtn = $('#tempoBtn');
  tempoBtn.hidden = !take.tempo;
  if (take.tempo) {
    const bpm = Math.round(take.tempo.bpm);
    const meter = take.tempo.meter ?? '4/4';
    $('#tempoText').textContent = meter === '4/4' ? bpm : `${bpm} · ${meter}`;
    tempoBtn.setAttribute('aria-pressed', String(state.metronome));
    tempoBtn.setAttribute('aria-label', take.tempo.source === 'countin'
      ? `Metronome ${state.metronome ? 'on' : 'off'}, ${bpm} beats per minute from your count-in.`
      : `Metronome ${state.metronome ? 'on' : 'off'}, ${bpm} beats per minute. Press and hold to adjust.`);
  }
  $('#layerCount').textContent = take.layers.length || '';

  const guessed = !analysisNotes().length && !playedSources().length;
  $('#keyChips').innerHTML = state.keys
    .slice(0, 6)
    .map((k, i) => `<button class="chip ${i === state.keyIdx ? 'active' : ''}" data-i="${i}" role="option" aria-selected="${i === state.keyIdx}">${keyName(k)}${guessed ? '' : `<small>${Math.max(1, Math.round(k.p * 100))}%</small>`}</button>`)
    .join('');

  document.querySelectorAll('.seg[data-setting]').forEach((seg) => {
    const val = state[seg.dataset.setting];
    const hidden = state.noChoice?.[seg.dataset.setting] ?? new Set();
    seg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.value === val);
      b.hidden = hidden.has(b.dataset.value);
    });
    // Nothing to choose between: a short note instead of options that all sound the same
    const none = hidden.size === SETTING_VALUES[seg.dataset.setting].length - 1;
    seg.style.display = none ? 'none' : '';
    const msg = seg.parentElement.querySelector('.no-choice');
    if (msg) msg.hidden = !none;
  });

  $('#chordList').innerHTML = segs
    .map((s, i) => `<button class="chord-card ${s.edited || state.overrides[i] != null ? 'edited' : ''}" data-i="${i}"><span class="sym">${chordLabel(s, key)}</span><span class="rn">${s.chord.roman}</span></button>`)
    .join('');

  const scale = scalePcs(key);
  $('#melodyLine').innerHTML = take.notes
    .map((n) => {
      const p = pc(n.midi);
      const cls = (p === key.tonic ? 'tonic' : scale.has(p) ? '' : 'out') + (n.edited ? ' edited' : '');
      return `<span class="${cls}">${spell(p, key)}</span>`;
    })
    .join('');
  const off = take.offset;
  $('#tuningHint').textContent = Math.abs(off) < 8 ? 'In tune with A440' : `${Math.abs(off)}¢ ${off > 0 ? 'sharp' : 'flat'} of A440`;
  const tuneLevel = TUNE_LEVELS.find((l) => l.amount === take.tune.amount);
  $('#tuneLabel').textContent = take.tune.amount ? `Tuned · ${tuneLevel?.label ?? ''}` : 'Tune';
  $('#tuneBtn').classList.toggle('strong', !!take.tune.amount);
  const lockedTo = take.timing?.applied;
  $('#timingLabel').textContent = lockedTo ? `Locked · ${lockedTo === 'auto' ? 'auto' : gridName(lockedTo, take.tempo?.meter)}` : 'Timing';
  $('#timingBtn').classList.toggle('strong', !!lockedTo);
  // Pro tools aren't shown until Pro is unlocked.
  $('#tuneBtn').hidden = !state.pro;
  $('#timingBtn').hidden = !state.pro;

  updateTransportStatus();
  $('#saveBtn').classList.toggle('saved', !!take.id && !take.dirty);
  drawRoll();
}

function updateTransportStatus(text) {
  const el = $('#transportStatus');
  const msg = text ?? (state.trimming ? 'Play previews your selection' : state.editing ? 'Tap the chord bar to split a chord' : '');
  el.hidden = !msg;
  $('#transportStatusText').textContent = msg;
}

let rollGeom = null;

function drawRoll(playT = null) {
  if (!state.take || state.view !== 'harmony') return;
  const cv = $('#rollCanvas');
  const { g, w, h } = fitCanvas(cv);
  const take = state.take;
  const key = state.keys[state.keyIdx];
  const trimming = state.trimming;
  const editing = state.editing;
  const drag = editing?.drag;
  const play = state.playing;
  const { start, end } = trimming
    ? { start: Math.min(0, trimming.start), end: Math.max(take.duration, trimming.end) }
    : layerRec && play ? { start: play.viewStart, end: play.viewEnd } : takeRange();
  const inView = (n) => n.end > start && n.start < end;

  const groups = [
    { notes: take.notes, style: 'base' },
    ...take.layers.filter((l) => kindOf(l) === 'melody').map((l) => ({ notes: l.notes, style: l.included ? 'layer' : 'ghost' })),
  ];
  let lo = Infinity, hi = -Infinity;
  for (const grp of groups) for (const n of grp.notes) if (inView(n)) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
  if (!Number.isFinite(lo)) { lo = 55; hi = 67; }
  lo -= 2; hi += 2;
  while (hi - lo < 12) { lo--; if (hi - lo < 12) hi++; }
  // Hold the pitch range still while a note is being dragged.
  if (drag?.range) ({ lo, hi } = drag.range);

  const left = 30, right = 8, top = 8, band = trimming ? 18 : editing ? 40 : 34;
  const rollH = h - top - band - 10;
  const laneH = rollH / (hi - lo + 1);
  const x = (t) => left + ((t - start) / (end - start)) * (w - left - right);
  const laneY = (m) => top + (hi - m) * laneH;
  const scale = scalePcs(key);
  const by = h - band - 4;
  rollGeom = { x0: left, x1: w - right, start, end, top, laneH, lo, hi, by, x, laneY };

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

  // The grid the trim edges snap to, bar lines stronger
  if (trimming && snapUnit(trimSnap())) {
    const unit = snapUnit(trimSnap()), g0 = take.tempo.downbeat;
    const barLen = barBeats(take.tempo.meter) * take.tempo.beat;
    g.fillStyle = cFaint;
    for (let k = Math.ceil((start - g0) / unit); g0 + k * unit <= end; k++) {
      const pos = (k * unit) / barLen;
      g.globalAlpha = Math.abs(pos - Math.round(pos)) < 1e-3 ? 0.55 : 0.22;
      g.fillRect(Math.round(x(g0 + k * unit)), top, 1, rollH);
    }
    g.globalAlpha = 1;
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

  // Chords layers: the notes being played, as soft shading across their lanes
  for (const l of take.layers) {
    if (kindOf(l) !== 'chords' || !l.chroma) continue;
    g.fillStyle = l.included ? cViolet : cFaint;
    for (const b of chromaBlocks(l)) {
      const bx0 = x(l.offset + b.t0), bx1 = x(l.offset + b.t1);
      if (bx1 < left || bx0 > w - right) continue;
      for (const [p, v] of b.pcs) {
        g.globalAlpha = (l.included ? 0.14 : 0.08) + (v - 0.5) * 0.4;
        for (let m = lo; m <= hi; m++) if (pc(m) === p) g.fillRect(bx0, laneY(m) + 1, bx1 - bx0 + 0.5, laneH - 2);
      }
    }
  }
  g.globalAlpha = 1;

  // Rhythm layers (and a beat-only take): a tick per hit along the bottom, tallest for kicks
  const hitGroups = take.layers.filter((l) => kindOf(l) === 'rhythm' && l.hits);
  if (beatSpan()) hitGroups.unshift({ hits: take.hits, offset: 0, muted: !take.mix.take.on, base: true });
  for (const l of hitGroups) {
    g.fillStyle = l.muted ? cFaint : cViolet;
    for (const hit of l.hits) {
      const tx = x(l.offset + hit.t);
      if (tx < left || tx > w - right) continue;
      const th = hit.d === 'k' ? 11 : hit.d === 's' ? 7 : 4;
      g.globalAlpha = 0.4 + 0.6 * hit.s;
      g.fillRect(Math.round(tx), top + rollH - th, 2, th);
    }
  }
  g.globalAlpha = 1;

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
      // Notes the user moved get a ring
      if (n.edited || drag?.note === n) {
        g.strokeStyle = cText;
        g.lineWidth = 1.5;
        g.stroke();
      }
      if (drag?.note === n) {
        g.font = '600 11px ' + token('--font');
        g.fillStyle = cText;
        g.textBaseline = 'bottom';
        g.fillText(noteLabel(n.midi, key), nx, laneY(n.midi) - 3);
        g.textBaseline = 'middle';
      }
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
    g.font = '600 12px ' + token('--font');
    g.textAlign = 'center';
    for (const s of segs) {
      const active = playT != null && playT >= s.start && playT < s.end;
      const sx = x(s.start) + 1, sw = x(s.end) - x(s.start) - 2;
      g.fillStyle = active ? cGold : cSurface2;
      roundRect(g, sx, by, sw, band, 8);
      g.fill();
      const full = chordLabel(s);
      const label = g.measureText(full).width < sw - 6 ? full : g.measureText(s.chord.symbol).width < sw - 6 ? s.chord.symbol : sw > 14 ? s.chord.symbol[0] : '';
      g.fillStyle = active ? cInk : cText;
      g.fillText(label, sx + sw / 2, by + band / 2);
    }
    g.textAlign = 'left';

    if (editing) {
      // Snap points (note starts, and beats when the metronome is on) above the chord bar
      g.fillStyle = cFaint;
      for (const f of focalPoints()) g.fillRect(Math.round(x(f)) - 1, by - 5, 2, 3);
      // Draggable edges between chords
      segs.slice(1).forEach((s, k) => {
        const active = drag?.type === 'edge' && drag.i === k + 1;
        g.fillStyle = active ? cText : cGold;
        roundRect(g, x(s.start) - 2.5, by + 6, 5, band - 12, 2.5);
        g.fill();
      });
    }
  }

  if (playT != null) {
    g.fillStyle = cText;
    g.fillRect(Math.round(x(playT)), top, 1.5, h - top - 4);
  }

  if (play?.countLabel) {
    g.font = '500 72px ' + token('--serif');
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = cGold;
    g.fillText(String(play.countLabel), w / 2, top + rollH / 2);
    g.textAlign = 'left';
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

$('#ideaSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setIdea(+b.dataset.i);
});

document.querySelectorAll('.seg[data-setting]').forEach((seg) =>
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const setting = seg.dataset.setting;
    if (state[setting] === b.dataset.value) return;
    if (locked(setting, b.dataset.value)) { openProSheet(setting); return; }
    state[setting] = b.dataset.value;
    if (setting === 'mode') {
      const wasPlaying = !!state.playing;
      renderHarmony();
      if (wasPlaying) startPlayback();
    } else {
      stopPlayback();
      reharmonize(state.ideaIdx);
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

// Trim edges can snap to the take's beat grid (its count-in tempo, one set by
// hand, or the one detected from the singing): to a bar, a beat or a fraction of
// one. A snapped trim is played (and looped) exactly as set, so a loop goes round
// in step and layers recorded over it line up.
const SNAPS = { quarter: 0.25, half: 0.5, beat: 1 };
const trimSnap = () => (state.take?.tempo ? pref('alchemy.trimSnap', 'beat') : 'off');

function snapUnit(mode) {
  const g = state.take.tempo;
  if (!g || mode === 'off') return 0;
  return mode === 'bar' ? barBeats(g.meter) * g.beat : g.beat * (SNAPS[mode] ?? 1);
}

// The grid line nearest t. An edge dragged to the start of the sound (or the end
// of the recording) rounds outwards instead, so nothing sung is cut off: the
// start may fall a little before the recording, the end a little after it.
function snapTime(t, side, mode = trimSnap()) {
  const unit = snapUnit(mode);
  if (!unit) return t;
  const take = state.take, g = take.tempo;
  const k = (t - g.downbeat) / unit;
  if (side === 'start') {
    const first = firstSound();
    if (t <= first + 0.02) return g.downbeat + Math.floor((first - g.downbeat) / unit + 1e-6) * unit;
  } else if (t >= take.duration - 0.05) {
    return g.downbeat + Math.ceil(k - 1e-6) * unit;
  }
  return g.downbeat + Math.round(k) * unit;
}

function snapTrimEdges() {
  const tr = state.trimming, unit = snapUnit(trimSnap());
  if (!unit) return;
  tr.start = snapTime(tr.start, 'start');
  tr.end = snapTime(tr.end, 'end');
  if (tr.end - tr.start < unit - 1e-6) tr.end = tr.start + unit;
}

function renderTrimSnap() {
  const has = !!state.take?.tempo;
  $('#trimSnap').hidden = !has;
  $('#trimHint').hidden = has;
  const mode = trimSnap();
  $('#trimSnap').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.snap === mode);
    b.setAttribute('aria-pressed', String(b.dataset.snap === mode));
  });
}

$('#trimSnap').addEventListener('click', (e) => {
  const b = e.target.closest('[data-snap]');
  if (!b || !state.trimming) return;
  try { localStorage.setItem('alchemy.trimSnap', b.dataset.snap); } catch { /* storage unavailable */ }
  stopPlayback();
  if (b.dataset.snap === 'off') Object.assign(state.trimming, { start: Math.max(0, state.trimming.start), end: Math.min(state.take.duration, state.trimming.end) });
  else snapTrimEdges();
  renderTrimSnap();
  drawRoll();
  haptic();
});

$('#trimBtn').addEventListener('click', () => {
  stopPlayback();
  state.trimming = { start: state.take.trim.start, end: state.take.trim.end, drag: null };
  snapTrimEdges();
  renderTrimSnap();
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
    take.track = await trackOf(take.samples, take.sampleRate, (p) => setProcessing(true, 0.1 + p * 0.85));
    setProcessing(false);
  }
  const frames = take.track.frames.filter((f) => f.t >= start && f.t <= end);
  const r = segmentNotes({ frames, hop: take.track.hop });
  if (!r.notes.length && !take.hits?.length) {
    toast('Not enough melody in that selection. Try a wider trim.');
    return;
  }
  // A beat keeps no notes of its own (see processAudio).
  take.notes = take.hits?.length ? [] : r.notes;
  take.offset = r.offset;
  const snap = trimSnap();
  take.trim = snap === 'off' ? { start, end } : { start, end, snap };
  // The grid the edges were snapped to stays put from now on.
  if (snap !== 'off' && take.tempo.source !== 'countin') take.tempo = { ...take.tempo, manual: true };
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
  if (state.editing && rollGeom) return editPointerDown(e);
  const tr = state.trimming;
  if (!tr || !rollGeom) return;
  const t = trimTimeAt(e.clientX);
  tr.drag = Math.abs(t - tr.start) <= Math.abs(t - tr.end) ? 'start' : 'end';
  roll.setPointerCapture(e.pointerId);
  moveTrimHandle(t);
});
roll.addEventListener('pointermove', (e) => {
  if (state.editing?.drag) editPointerMove(e);
  else if (state.trimming?.drag) moveTrimHandle(trimTimeAt(e.clientX));
});
roll.addEventListener('pointerup', () => {
  if (state.editing) editPointerUp();
  if (state.trimming) state.trimming.drag = null;
});
roll.addEventListener('pointercancel', () => {
  if (state.editing?.drag?.type === 'note') state.editing.drag.note.midi = state.editing.drag.from;
  if (state.editing) { state.editing.drag = null; drawRoll(); }
  if (state.trimming) state.trimming.drag = null;
});

function moveTrimHandle(t) {
  const tr = state.trimming;
  const unit = snapUnit(trimSnap());
  if (unit) {
    const min = Math.max(unit, Math.ceil(MIN_TRIM / unit - 1e-6) * unit);
    const prev = tr.drag === 'start' ? tr.start : tr.end;
    if (tr.drag === 'start') tr.start = Math.min(snapTime(t, 'start'), tr.end - min);
    else tr.end = Math.max(snapTime(t, 'end'), tr.start + min);
    if ((tr.drag === 'start' ? tr.start : tr.end) !== prev) haptic(4);
  } else {
    if (tr.drag === 'start') tr.start = Math.min(t, tr.end - MIN_TRIM);
    else tr.end = Math.max(t, tr.start + MIN_TRIM);
    tr.start = Math.max(0, tr.start);
    tr.end = Math.min(state.take.duration, tr.end);
  }
  drawRoll();
}

/* ---------- edit mode: chord timing and note pitches ---------- */

$('#editBtn').addEventListener('click', () => {
  stopPlayback();
  // Fold any chord picks into the segments so they can be moved around freely.
  state.harmony.segments = resolvedSegments().map((s, i) => ({ ...s, edited: s.edited || state.overrides[i] != null }));
  state.overrides = {};
  state.editing = { drag: null };
  renderHarmony();
  haptic();
});

$('#editDone').addEventListener('click', () => {
  state.editing = null;
  renderHarmony();
});

$('#editReset').addEventListener('click', () => {
  const take = state.take;
  for (const n of [...take.notes, ...take.layers.flatMap((l) => l.notes)]) {
    if (n.origMidi != null) n.midi = n.origMidi;
    delete n.origMidi;
    delete n.edited;
  }
  take.noteRev = (take.noteRev ?? 0) + 1;
  stopPlayback();
  reharmonize();
  renderHarmony();
  toast('Edits reset');
});

function hasEdits() {
  const take = state.take;
  return state.harmony.segments.some((s) => s.edited) ||
    [...take.notes, ...take.layers.flatMap((l) => l.notes)].some((n) => n.edited);
}

// Where chord changes can snap: note starts, plus beats when the metronome is on.
function focalPoints() {
  const { start, end } = takeRange();
  const pts = analysisNotes().map((n) => n.start);
  if (state.metronome && state.take.tempo) pts.push(...beatsBetween(state.take.tempo, start, end).map((b) => b.t));
  return [...new Set(pts.filter((t) => t > start && t < end).map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b);
}

const nearest = (pts, t) => pts.reduce((a, p) => (Math.abs(p - t) < Math.abs(a - t) ? p : a));

function rollPoint(e) {
  const r = roll.getBoundingClientRect();
  const G = rollGeom;
  const px = e.clientX - r.left, py = e.clientY - r.top;
  return { px, py, t: G.start + ((px - G.x0) / (G.x1 - G.x0)) * (G.end - G.start) };
}

// Editable notes: the take's, plus layers that feed the harmony.
function noteAt(px, py) {
  const take = state.take;
  const G = rollGeom;
  const notes = [...take.notes, ...take.layers.filter((l) => l.included && kindOf(l) === 'melody').flatMap((l) => l.notes)];
  let best = null, bestD = Infinity;
  for (const n of notes) {
    const x0 = G.x(n.start) - 4, x1 = G.x(n.end) + 4;
    if (px < x0 || px > x1) continue;
    const d = Math.abs(py - (G.laneY(n.midi) + G.laneH / 2));
    if (d <= Math.max(G.laneH / 2 + 4, 14) && d < bestD) { best = n; bestD = d; }
  }
  return best;
}

function editPointerDown(e) {
  const { px, py, t } = rollPoint(e);
  const G = rollGeom;
  const segs = state.harmony.segments;
  if (py >= G.by - 8) {
    let edge = -1, ed = 18;
    segs.forEach((s, i) => {
      const d = Math.abs(G.x(s.start) - px);
      if (i > 0 && d < ed) { ed = d; edge = i; }
    });
    state.editing.drag = edge > 0 ? { type: 'edge', i: edge } : { type: 'tap', t };
    if (edge > 0) { roll.setPointerCapture(e.pointerId); haptic(5); }
    drawRoll();
    return;
  }
  const note = noteAt(px, py);
  if (!note) return;
  state.editing.drag = { type: 'note', note, from: note.midi, range: { lo: G.lo, hi: G.hi } };
  roll.setPointerCapture(e.pointerId);
  haptic(5);
  drawRoll();
}

function editPointerMove(e) {
  const d = state.editing.drag;
  const { py, t } = rollPoint(e);
  const G = rollGeom;
  if (d.type === 'edge') {
    const segs = state.harmony.segments;
    const lo = segs[d.i - 1].start, hi = segs[d.i].end;
    const snapped = nearest([lo, hi, ...focalPoints().filter((p) => p > lo && p < hi)], t);
    if (snapped !== segs[d.i].start) haptic(3);
    segs[d.i - 1].end = segs[d.i].start = snapped;
    drawRoll();
  } else if (d.type === 'note') {
    const m = Math.round(G.hi - (py - G.top - G.laneH / 2) / G.laneH);
    const clamped = Math.max(d.range.lo, Math.min(d.range.hi, m));
    if (clamped !== d.note.midi) { d.note.midi = clamped; haptic(3); drawRoll(); }
  }
}

function editPointerUp() {
  const d = state.editing.drag;
  if (!d) return;
  state.editing.drag = null;
  const take = state.take;
  if (d.type === 'edge') {
    // An edge dragged onto its neighbour merges the two chords.
    const segs = state.harmony.segments;
    segs[d.i - 1].edited = segs[d.i].edited = true;
    const kept = segs.filter((s) => s.end - s.start > 0.08);
    kept.forEach((s, k) => { if (k) s.start = kept[k - 1].end; });
    kept.forEach(refitSegment);
    if (kept.length < segs.length) toast('Chords merged');
    state.harmony.segments = kept;
  } else if (d.type === 'tap') {
    splitAt(d.t);
    return;
  } else if (d.type === 'note') {
    if (d.note.midi === d.from) { drawRoll(); return; }
    d.note.origMidi ??= d.from;
    d.note.edited = d.note.midi !== d.note.origMidi;
    if (!d.note.edited) delete d.note.origMidi;
    take.noteRev = (take.noteRev ?? 0) + 1;
    afterNoteEdit();
  }
  markDirty();
  renderHarmony();
}

function splitAt(t) {
  const segs = state.harmony.segments;
  const i = segs.findIndex((s) => t >= s.start && t < s.end);
  if (i < 0) return drawRoll();
  const seg = segs[i];
  const pts = focalPoints().filter((p) => p > seg.start + 0.12 && p < seg.end - 0.12);
  if (!pts.length) {
    toast('No note starts inside that chord to split at.');
    return drawRoll();
  }
  const at = nearest(pts, t);
  const right = { start: at, end: seg.end, edited: true };
  right.chord = rankChords(analysisNotes(), state.keys[state.keyIdx], state.harmony.vocab, at, seg.end, harmonyOptions()).ranked[0].chord;
  seg.end = at;
  seg.edited = true;
  segs.splice(i + 1, 0, right);
  refitSegment(seg);
  refitSegment(right);
  markDirty();
  renderHarmony();
  haptic(10);
  if (!splitAt.hinted) {
    splitAt.hinted = true;
    toast('Split. Drag an edge onto its neighbour to merge.');
  }
}

// After a pitch fix: re-fit the chords, unless the user has already shaped them by hand.
function afterNoteEdit() {
  const shaped = state.harmony.segments.some((s) => s.edited);
  if (shaped) {
    state.harmony.segments.forEach(refitSegment);
    toast('Note changed. Your chords are kept; tap one to see fresh suggestions.');
  } else {
    reharmonize();
    toast(state.take.tune.amount ? 'Note changed and chords re-fitted.' : 'Note changed and chords re-fitted. Turn on Tune to hear your voice at the new pitch.', 4200);
  }
}

/* ---------- playback ---------- */

function bufferFor(clip) {
  // Rebuilt when the audio context has been replaced.
  if (!clip.buffer || clip.bufferCtx !== synth.ensure()) {
    clip.bufferCtx = synth.ctx;
    clip.buffer = synth.ctx.createBuffer(1, clip.samples.length, clip.sampleRate);
    clip.buffer.getChannelData(0).set(clip.samples);
  }
  return clip.buffer;
}

// Plays the part of a clip (placed at clipStart on the take timeline) that falls in [start, end].
function scheduleClip(clip, clipStart, t0, start, end, dest) {
  const buf = bufferFor(clip);
  const a = Math.max(start, clipStart);
  const b = Math.min(end, clipStart + buf.duration);
  if (b > a) synth.voice(buf, t0 + (a - start), a - clipStart, b - a, dest);
}

// Schedules everything in [a, b] of the take's timeline to start at audio time t0,
// into the given track buses. Clicks start at `clickFrom` (later than `a` when a
// count-in already covers the first bar).
function schedulePass(t0, a, b, buses, clickFrom = a) {
  const take = state.take;
  // The chords, in the chosen playing style, queued and voiced a moment ahead
  // (see flushChords): a long take on the beat or in eighths is a lot of notes.
  for (const ev of backingEvents()) {
    let { t, dur } = ev;
    if (t >= b || t + dur <= a + 0.05) continue;
    if (t < a) { dur -= a - t; t = a; } // already sounding where this pass starts
    chordQueue.push({ when: t0 + (t - a), ev: { ...ev, t, dur: Math.min(dur, b - t + 0.02) }, dest: buses.backing });
  }
  chordQueue.sort((x, y) => x.when - y.when);
  scheduleClip(voiceClip(take), 0, t0, a, b, buses.take);
  for (const l of take.layers) {
    if (kindOf(l) === 'rhythm' && l.sound === 'kit') {
      for (const h of l.hits) {
        const at = l.offset + h.t;
        if (at >= a && at < b) synth.drum(h.d, t0 + at - a, h.s, buses[l.id]);
      }
    } else scheduleClip(voiceClip(l), l.offset, t0, a, b, buses[l.id]);
  }
  for (const n of analysisNotes()) if (n.start >= a && n.start < b) synth.lead(n.midi, t0 + n.start - a, n.end - n.start, buses.guide);
  if (take.tempo) {
    // While recording a layer (not looping) the click keeps going past the end of the take.
    const runOn = layerRec && !layerRec.loop;
    const clickEnd = runOn ? a + MAX_LAYER_SECONDS : b;
    for (const beat of beatsBetween(take.tempo, clickFrom, clickEnd)) {
      if (beat.t < b || runOn) synth.click(t0 + beat.t - a, beat.accent, buses.click);
    }
  }
}

// One bar of clicks before a layer recording. With a beat grid it lands the singer
// on a bar line of the take; without one it's a plain lead-in at the count-in tempo.
function countInBar(start) {
  const g = state.take.tempo ?? { beat: 60 / state.countIn.bpm, downbeat: start, meter: state.countIn.meter };
  const per = barBeats(g.meter), bar = per * g.beat;
  const land = g.downbeat + Math.ceil((start - g.downbeat) / bar - 0.05) * bar;
  return { from: land - bar, land, beat: g.beat, per };
}

function startPlayback({ countIn = false } = {}) {
  if (!state.take) return;
  stopPlayback();
  chordQueue = [];
  const take = state.take;
  const ctx = synth.begin();
  const range = state.trimming ?? takeRange();
  let { start, end } = range;
  const t0 = ctx.currentTime + 0.1;
  const buses = {};
  let count = null;
  let loopStart = start;

  if (state.trimming) {
    scheduleClip(take, 0, t0, start, end);
  } else {
    // A loop over a trusted beat grid is rounded out to whole bars, so the groove
    // carries straight on across the seam.
    // With a beat grid to follow (a count-in recording, or the metronome on),
    // playback starts on the beat before the first note, so that beat's click is
    // heard (the "one", when the singer came in a little after it). Only a beat,
    // never a whole bar: the playhead waits at the first note until then.
    const grid = trustedTempo();
    const beatGrid = grid ?? (state.metronome ? take.tempo : null);
    if (take.trim.snap) {
      // Snapped to the grid already: played and looped exactly as trimmed.
    } else if (state.loop && (!layerRec || layerRec.loop) && grid) {
      const bar = barBeats(grid.meter) * grid.beat;
      start = grid.downbeat + Math.floor((start - grid.downbeat) / bar + 0.02) * bar;
      end = start + Math.max(1, Math.ceil((end - start) / bar - 0.05)) * bar;
    } else if (beatGrid) {
      start = beatGrid.downbeat + Math.floor((start - beatGrid.downbeat) / beatGrid.beat + 0.02) * beatGrid.beat;
    }
    // Every track gets its own gain stage, muted ones at zero, so the mix can change
    // while it plays.
    for (const id of ['backing', 'take', 'guide', 'click', ...take.layers.map((l) => l.id)]) {
      const t = track(id);
      buses[id] = synth.bus(busLevel(id, t));
    }
    loopStart = start;
    let clickFrom = start;
    if (countIn) {
      count = countInBar(start);
      const lead = synth.bus(countLevel(layerRec?.mic.headphones));
      for (let k = 0; k < count.per; k++) synth.click(t0 + k * count.beat, k === 0, lead);
      clickFrom = count.land;
      start = count.from;
    }
    schedulePass(t0, start, end, buses, clickFrom);
    flushChords();
  }
  state.playing = {
    t0, start, end, viewStart: range.start, viewEnd: end, raf: 0, seg: -1, buses, count, queued: false,
    // The looped span and when its first pass begins (after any count-in), in audio time
    loopStart, loopWall0: t0 + (loopStart - start), pass: 1, startedAt: t0,
  };
  $('#playBtn').classList.add('playing');
  $('#playBtn').setAttribute('aria-label', 'Stop');
  nowPlaying(true);
  tick();
}

// What the lock screen and Control Center show while a take plays. Without it the
// phone falls back to the app's internal address ("localhost").
function nowPlaying(playing) {
  const ms = navigator.mediaSession;
  if (!ms || typeof MediaMetadata === 'undefined' || !state.take) return;
  const key = state.keys[state.keyIdx];
  try {
    ms.metadata = new MediaMetadata({
      title: state.take.name || 'Alchemy',
      artist: key ? `Alchemy · ${keyName(key)}` : 'Alchemy',
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
    ms.playbackState = playing ? 'playing' : 'paused';
  } catch { /* unsupported */ }
}

const playFromLockScreen = () => { if (!rec && !layerRec && !starting) startPlayback(); };
for (const [action, run] of [['play', playFromLockScreen], ['pause', () => stopPlayback()], ['stop', () => stopPlayback()]]) {
  try { navigator.mediaSession?.setActionHandler(action, run); } catch { /* unsupported */ }
}

function tick() {
  const p = state.playing;
  if (!p) return;
  flushChords();
  let t = p.start + (synth.ctx.currentTime - p.t0);
  // Count-in: a big number counting down to the bar line where the layer starts
  const counting = p.count && t < p.count.land;
  p.countLabel = counting ? Math.min(p.count.per, Math.ceil((p.count.land - t) / p.count.beat - 1e-3)) : null;
  if (counting && p.countLabel !== p.lastCount) {
    p.lastCount = p.countLabel;
    haptic(8);
  }
  // Looping: queue the next pass just before this one ends, then move the clock on.
  // The count-in (before loopStart) only ever plays once.
  const looping = !state.trimming && (layerRec ? layerRec.loop : state.loop);
  const len = p.end - p.loopStart;
  if (looping && !p.queued && t >= p.end - 0.4) {
    schedulePass(p.t0 + (p.end - p.start), p.loopStart, p.end, p.buses);
    p.queued = true;
  }
  if (p.queued && t >= p.end) {
    p.t0 += len;
    p.queued = false;
    p.pass++;
    t -= len;
  }
  if (layerRec) {
    if (synth.ctx.currentTime - p.startedAt >= MAX_LAYER_SECONDS) { stopLayer(); return; }
    if (layerRec.loop) {
      drawRoll(Math.max(p.viewStart, t));
      updateTransportStatus(counting ? `${layerRec.name} starts in ${p.countLabel}` : `Recording ${layerRec.name} · pass ${p.pass}`);
    } else {
      // A layer keeps recording past the end of the take until the user stops it;
      // the view widens to make room.
      p.viewEnd = Math.max(p.end, t + 1);
      drawRoll(Math.max(p.viewStart, t));
      const from = p.count ? p.count.land : p.start;
      updateTransportStatus(counting
        ? `${layerRec.name} starts in ${p.countLabel}`
        : `Recording ${layerRec.name} · ${fmtTime(Math.max(0, t - from))}${t > p.end ? ' · tap ■ to finish' : ''}`);
    }
  } else {
    if (t >= p.end + 0.6) { stopPlayback(); return; }
    drawRoll(Math.max(p.viewStart, Math.min(t, p.end)));
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
  chordQueue = [];
  synth.stop();
  nowPlaying(false);
  $('#playBtn').classList.remove('playing');
  $('#playBtn').setAttribute('aria-label', 'Play');
  document.querySelectorAll('.chord-card.now').forEach((c) => c.classList.remove('now'));
  drawRoll();
}

function audition(chord) {
  stopPlayback();
  const ctx = synth.begin();
  const evs = chordEvents([{ start: 0, end: 1.3 }], [voicing(chord)], { beat: 0.5, downbeat: 0, meter: '4/4' }, 'held');
  for (const e of evs) playNote(synth, chordSound(), e, ctx.currentTime + 0.02 + e.t, synth.out, 0.9);
}

/* ---------- chord sound and playing style ---------- */

const pref = (k, fallback) => { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } };
// Takes saved before there was a choice keep the original pad, held.
const chordSound = () => {
  const s = state.take?.mix.backing.sound ?? 'pad';
  return locked('sound', s) ? 'pad' : s;
};
const chordStyle = () => {
  const s = state.take?.mix.backing.style ?? 'held';
  return locked('style', s) ? 'held' : s;
};

/* ---------- Alchemy Pro ---------- */

// The iPhone app is free, with extras in Alchemy Pro, a one-time purchase. The
// free app does the whole job (record, key, a progression in triads with "Chord
// every", playback, trim, loop, a layer, an unlimited library); Pro adds more
// progressions, chord sets (extended, chromatic), sounds, styles, more layers,
// lock-to-beat and tune, and MIDI export. The web version has it all.
const FREE_SOUNDS = ['pad', 'epiano'];
const FREE_STYLES = ['held', 'beats'];
const FREE_LAYERS = 1;
let proPrice = null;

function locked(kind, value) {
  if (state.pro) return false;
  if (kind === 'sound') return !FREE_SOUNDS.includes(value);
  if (kind === 'style') return !FREE_STYLES.includes(value);
  if (kind === 'palette') return value !== 'triads';
  if (kind === 'idea') return value > 0;
  // Everything else (chord rate, progressions, mode…) is free.
  return false;
}

function setPro(on) {
  const was = state.pro;
  state.pro = on;
  try { localStorage.setItem('alchemy.pro', on ? '1' : '0'); } catch { /* storage unavailable */ }
  // Upgrade in the top bar until Pro is bought, then a PRO tag by the name.
  $('#proBtn').hidden = !isNative || on;
  $('#proTag').hidden = !isNative || !on;
  if (was !== on && state.take) {
    if (!on) { state.palette = 'triads'; reharmonize(0); }
    else state.noChoice = settingsWithoutChoice();
    renderHarmony();
  }
}

// Runs `then` with Pro, or explains Pro and offers it.
function withPro(reason, then) {
  if (state.pro) return then();
  openProSheet(reason);
}

const PRO_REASONS = {
  sound: 'That sound comes with Alchemy Pro.',
  style: 'That playing style comes with Alchemy Pro.',
  palette: 'Chord sets come with Alchemy Pro.',
  idea: 'More progressions come with Alchemy Pro.',
  layers: 'The free app keeps one layer. Alchemy Pro adds as many as you like.',
  timing: 'Lock to beat comes with Alchemy Pro.',
  tune: 'Tune comes with Alchemy Pro.',
  midi: 'MIDI export comes with Alchemy Pro.',
};

function openProSheet(reason = null) {
  const owned = state.pro;
  openSheet(`<div class="pro-sheet">
    <h3>Alchemy Pro</h3>
    <p class="sub">${owned ? 'Pro is unlocked. Thank you for supporting Alchemy!' : `${PRO_REASONS[reason] ? `${PRO_REASONS[reason]} ` : ''}One purchase, yours to keep, and shared with your family through Family Sharing.`}</p>
    <ul class="pro-list">
      <li><b>Four more chord sounds:</b> guitar, organ, strings and marimba</li>
      <li><b>Three more playing styles:</b> strum, arpeggio, and bass &amp; chord</li>
      <li><b>More progressions:</b> switch between several that fit, in each key</li>
      <li><b>Chord sets:</b> extended chords (7ths, sus, add9) and chromatic, with borrowed chords</li>
      <li><b>Unlimited layers,</b> with every pass of a loop recording kept</li>
      <li><b>Lock to beat and Tune</b> for your melody</li>
      <li><b>MIDI export</b> of melody, chords and bass to GarageBand, Logic or any DAW</li>
    </ul>
    ${owned ? '' : `<button class="btn primary block" id="proBuy">${proPrice ? `Unlock Pro · ${esc(proPrice)}` : 'Unlock Pro'}</button>`}
    <button class="text-btn pro-restore" id="proRestore">Restore purchases</button>
    ${owned ? '' : '<p class="pro-fine">Everything else in Alchemy stays free, including your whole library.</p>'}
  </div>`);
  if (!owned && !proPrice) {
    proStore.status().then((r) => {
      proPrice = r.price ?? null;
      const b = $('#proBuy');
      if (b && proPrice && !b.disabled) b.textContent = `Unlock Pro · ${proPrice}`;
    }).catch(() => {});
  }
  $('#proBuy')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = 'Connecting to the App Store…';
    let r = {};
    try { r = await proStore.buy(); } catch { r = { error: 'failed' }; }
    if (r.pro) {
      setPro(true);
      closeSheet();
      toast('Alchemy Pro unlocked. Thank you!');
      haptic([8, 40, 8]);
      return;
    }
    b.disabled = false;
    b.textContent = proPrice ? `Unlock Pro · ${proPrice}` : 'Unlock Pro';
    if (r.cancelled) return;
    if (r.pending) toast('Waiting for approval. Pro unlocks as soon as the purchase goes through.', 5000);
    else if (r.error === 'unavailable') toast("Pro isn't available right now. Please try again later.", 4200);
    else toast("The purchase didn't go through. Please try again.", 4200);
  });
  $('#proRestore').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = 'Checking…';
    let r = {};
    try { r = await proStore.restore(); } catch { r = { error: 'failed' }; }
    b.disabled = false;
    b.textContent = 'Restore purchases';
    if (r.pro) {
      const had = state.pro;
      setPro(true);
      if (!had) { closeSheet(); toast('Alchemy Pro restored.'); }
      else toast('Pro is already unlocked.');
    } else {
      toast(r.error ? "Couldn't reach the App Store. Please try again." : 'No Pro purchase found for this Apple Account.', 4200);
    }
  });
}

$('#proBtn').addEventListener('click', () => openProSheet());
$('#proTag').addEventListener('click', () => openProSheet());

// The beat the styles follow: the take's grid, or a steady 120 bpm from the first chord.
function beatGrid(segs) {
  const t = state.take.tempo;
  return t ? { beat: t.beat, downbeat: t.downbeat, meter: t.meter } : { beat: 0.5, downbeat: segs[0]?.start ?? 0, meter: '4/4' };
}

// Every note of the backing chords, on the take's timeline. Voiced as a whole, so
// each chord's notes move as little as possible from the last.
function backingEvents() {
  const segs = resolvedSegments();
  const voices = voiceLead(segs.map((s) => s.chord), segs.map((s) => s.bass));
  return chordEvents(segs, voices, beatGrid(segs), chordStyle());
}

let chordQueue = [];
// Voices the queued chord notes due in the next moment.
function flushChords() {
  if (!synth.ctx || !chordQueue.length) return;
  const now = synth.ctx.currentTime, sound = chordSound();
  while (chordQueue.length && chordQueue[0].when < now + 0.6) {
    const { when, ev, dest } = chordQueue.shift();
    if (when + ev.dur > now) playNote(synth, sound, ev, Math.max(when, now), dest);
  }
}

// After picking a sound or style: hear it. Restarts playback if it's running,
// otherwise plays the first couple of seconds of the progression.
function previewBacking() {
  if (layerRec) return;
  if (state.playing) { startPlayback(); return; }
  const evs = backingEvents();
  if (!evs.length) return;
  const ctx = synth.begin();
  const bus = synth.bus(busLevel('backing', { ...track('backing'), on: true }));
  const from = evs[0].t, until = from + 2.8, sound = chordSound();
  for (const e of evs) {
    if (e.t >= until) break;
    playNote(synth, sound, { ...e, dur: Math.min(e.dur, until - e.t) }, ctx.currentTime + 0.05 + (e.t - from), bus);
  }
}

function setLoop(on) {
  state.loop = on;
  try { localStorage.setItem('alchemy.loop', on ? '1' : '0'); } catch { /* storage unavailable */ }
  $('#loopBtn').classList.toggle('on', on);
  $('#loopBtn').setAttribute('aria-pressed', String(on));
}

$('#loopBtn').addEventListener('click', () => {
  setLoop(!state.loop);
  haptic();
  // With a beat grid the loop is rounded to whole bars, so restart on that span.
  if (state.loop && state.playing && !layerRec && !state.trimming && trustedTempo()) startPlayback();
  toast(state.loop ? 'Loop on' : 'Loop off', 1200);
});

$('#playBtn').addEventListener('click', () => {
  if (layerRec) stopLayer();
  else if (state.playing) stopPlayback();
  else startPlayback();
});

/* ---------- layers ---------- */

let layerRec = null;

async function startLayer() {
  const take = state.take;
  if (!state.pro && take.layers.length >= FREE_LAYERS) { openProSheet('layers'); return; }
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
  layerRec = { mic, name, chunks: [], length: 0, firstTime: null, loop: state.loop };
  document.body.classList.add('layering');
  startPlayback({ countIn: layerCountIn() });
  layerRec.play = state.playing;
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
  const raw = concat(r.chunks, r.length);
  const sr = r.mic.sr;
  // The round trip from speaker to ear to mic: what was sung at a given moment was
  // heard this much earlier.
  const lat = Math.max(0, outLatency + r.mic.latency + latencyFix);
  // Where the first recorded sample sits on the take's timeline
  const offset = r.play.start + (r.firstTime - r.play.t0) - lat;

  // A loop recording is cut into one piece per time round; only complete passes
  // are kept (or the one partial pass if that's all there is).
  let pieces = [{ raw, offset }];
  if (r.loop) {
    const { loopWall0, loopStart, end } = r.play;
    const len = end - loopStart;
    const cut = [];
    for (let k = 0; ; k++) {
      let i0 = Math.round((loopWall0 + k * len + lat - r.firstTime) * sr);
      if (i0 >= raw.length) break;
      let at = loopStart;
      if (i0 < 0) { at -= i0 / sr; i0 = 0; }
      const i1 = Math.min(raw.length, Math.round((loopWall0 + (k + 1) * len + lat - r.firstTime) * sr));
      if (i1 - i0 > sr * 0.5) cut.push({ raw: raw.slice(i0, i1), offset: at, full: i1 - i0 >= len * sr * 0.9 });
    }
    const full = cut.filter((c) => c.full);
    if (full.length) pieces = full;
    else if (cut.length) pieces = cut.slice(0, 1);
  }

  setProcessing(true, 0.05);
  await nextFrame();
  const passes = [];
  for (const [k, piece] of pieces.entries()) {
    const span = 0.9 / pieces.length;
    passes.push(await analyzeRecording(piece.raw, sr, piece.offset, (f) => setProcessing(true, 0.05 + span * (k + f))));
  }
  setProcessing(false);

  // Keep the last pass; the others stay a tap away in Tracks (with Pro).
  if (!state.pro && passes.length > 1) passes.splice(0, passes.length - 1);
  const pick = passes.length - 1;
  const kind = passes[pick].kindAuto;
  const layer = {
    id: uid(),
    name: r.name,
    sampleRate: sr,
    passes,
    kind,
    sound: 'original',
    volume: 1,
    muted: false,
    included: false,
  };
  usePass(layer, pick);
  const take = state.take;
  take.layers.push(layer);
  if (kind === 'rhythm' && take.tempo?.source !== 'countin' && !take.tempo?.manual) { retempo(); regrid(); }
  markDirty();
  // Over a beat-only take, the first tune sung on top leads the chords straight away.
  if (beatSpan() && kind === 'melody' && layer.notes.length && !take.layers.some((l) => l.included)) {
    layer.included = true;
    reanalyze();
  } else renderHarmony();
  toast(passes.length > 1
    ? `${r.name}: ${passes.length} passes recorded, keeping the last one. Pick another in Tracks.`
    : `${r.name} added`, passes.length > 1 ? 4600 : 1800);
  haptic([8, 40, 8]);
}

// Everything one recorded pass needs: its notes and pitch trace, what kind of sound
// it is, chroma and hits, and its audio levelled to suit that kind.
async function analyzeRecording(raw, sr, offset, onProgress) {
  const forPitch = normalizeLoudness(raw.slice(), sr);
  const track = await trackOf(forPitch, sr, (f) => onProgress(f * 0.85));
  const seg = segmentNotes(track);
  await nextFrame();
  const sound = analyze(raw, sr, track);
  onProgress(1);
  return {
    // Singing is levelled by loudness; struck and strummed sounds by their peaks,
    // so their attacks stay intact.
    samples: sound.kind === 'melody' ? forPitch : normalizePeak(raw, sr),
    duration: raw.length / sr,
    offset,
    notes: seg.notes.map((n) => ({ ...n, start: n.start + offset, end: n.end + offset })),
    // Pitch contour in the pass's own time, for tuning it later
    trace: seg.trace,
    traceT0: seg.traceT0,
    hop: seg.hop,
    traceOffset: seg.offset,
    kindAuto: sound.kind,
    chroma: sound.chroma,
    hits: sound.hits,
  };
}

// What differs between a layer's passes; the layer carries the chosen one's.
const PASS_FIELDS = ['samples', 'duration', 'offset', 'notes', 'trace', 'traceT0', 'hop', 'traceOffset', 'kindAuto', 'chroma', 'hits'];

function usePass(l, k) {
  l.pass = k;
  for (const f of PASS_FIELDS) l[f] = l.passes[k][f];
  l.buffer = l.bufferCtx = l.tuned = l.blocks = null;
  prepareLayer(l);
  // Keep anything prepareLayer worked out, so switching back is instant.
  l.passes[k].chroma = l.chroma;
  l.passes[k].hits = l.hits;
}

/* ---------- sound kinds and the mix ---------- */

const ICON = {
  take: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  melody: '<path d="M12 18V4l6 2.5"/><circle cx="9" cy="18" r="3"/>',
  chords: '<path d="M16 3.5v13"/><ellipse cx="12.5" cy="17" rx="3.5" ry="2.4"/><ellipse cx="12.5" cy="12" rx="3.5" ry="2.4"/><ellipse cx="12.5" cy="7" rx="3.5" ry="2.4"/>',
  rhythm: '<ellipse cx="12" cy="10" rx="8" ry="3"/><path d="M4 10v5.5c0 1.7 3.6 3 8 3s8-1.3 8-3V10M8.5 3.5l3 5M15.5 3.5l-3 5"/>',
  backing: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7.5 5v8.5M12 5v8.5M16.5 5v8.5"/>',
  guide: '<path d="M3 12c2-6 4-6 6 0s4 6 6 0 4-6 6 0"/>',
  click: '<path d="M9 3h6l3.5 18h-13zM12 15l5-9M7 16h10"/>',
  on: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  off: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9.5l5 5M22 9.5l-5 5"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;

const KINDS = { melody: 'Melody', chords: 'Chords', rhythm: 'Rhythm' };
const KIND_ORDER = ['melody', 'chords', 'rhythm'];
const kindOf = (l) => l.kind ?? 'melody';

// Fills in what a layer's kind needs: for older saves, or after its kind changes.
function prepareLayer(l) {
  l.kind ??= 'melody';
  l.volume ??= 1;
  l.sound ??= 'original';
  if (l.kind === 'rhythm') l.included = false;
  if (l.kind === 'chords' && !l.chroma) l.chroma = chromaOf(l.samples, l.sampleRate);
  if (l.kind === 'rhythm' && !l.hits) l.hits = hitsOf(l.samples, l.sampleRate);
}

// Chroma of the chord layers the user opted into the harmony, on the take's timeline.
function playedSources() {
  const { layers, trim } = state.take;
  return layers
    .filter((l) => l.included && kindOf(l) === 'chords' && l.chroma)
    .map((l) => {
      const t0 = l.offset + l.chroma.t0, hop = l.chroma.hop;
      const empty = new Float32Array(12);
      return { t0, hop, frames: l.chroma.frames.map((f, i) => (t0 + i * hop < trim.start - 0.05 ? empty : f)) };
    });
}

// A chord layer's chroma averaged into quarter-second blocks, for drawing.
function chromaBlocks(l) {
  if (l.blocks) return l.blocks;
  const { t0, hop, frames } = l.chroma;
  const per = Math.max(1, Math.round(0.25 / hop));
  l.blocks = [];
  for (let i = 0; i < frames.length; i += per) {
    const v = new Float32Array(12);
    let n = 0;
    for (let j = i; j < Math.min(frames.length, i + per); j++) {
      if (!frames[j].some((x) => x > 0)) continue;
      n++;
      for (let k = 0; k < 12; k++) v[k] += frames[j][k];
    }
    if (!n) continue;
    const mx = Math.max(...v);
    l.blocks.push({ t0: t0 + (i - 0.5) * hop, t1: t0 + (i + per - 0.5) * hop, pcs: [...v].map((x, k) => [k, x / mx]).filter(([, x]) => x > 0.5) });
  }
  return l.blocks;
}

const defaultMix = () => ({ take: { on: true, vol: 1 }, backing: { on: true, vol: 0.55, sound: pref('alchemy.chordSound', 'pad'), style: pref('alchemy.chordStyle', 'held') }, guide: { on: false, vol: 0.7 }, click: { vol: 0.4 } });

// A track of the mix: 'take', 'backing', 'guide', 'click' or a layer id.
// A quiet take can only be lifted so far before the room's hiss gets loud, so it
// may play back well under the usual level. The chords and guide melody follow
// it down (never more than 12 dB), so they sit under the voice the same way
// whatever the take's level. The mixer's sliders work on top of this.
function busLevel(id, t) {
  if (!t.on) return 0;
  if (id !== 'backing' && id !== 'guide') return t.vol;
  const take = state.take;
  take.level ??= loudness(take.samples, take.sampleRate).active;
  return t.vol * Math.max(0.25, Math.min(1, take.level / LOUDNESS_TARGET));
}

function track(id) {
  const take = state.take;
  if (id === 'click') return { on: state.metronome, vol: take.mix.click.vol };
  const l = take.layers.find((x) => x.id === id);
  return l ? { on: !l.muted, vol: l.volume } : take.mix[id];
}

function setTrack(id, patch) {
  const take = state.take;
  if (!take) return;
  const l = take.layers.find((x) => x.id === id);
  if (id === 'click') {
    if ('on' in patch) state.metronome = patch.on;
    if ('vol' in patch) take.mix.click.vol = patch.vol;
  } else if (l) {
    if ('on' in patch) l.muted = !patch.on;
    if ('vol' in patch) l.volume = patch.vol;
  } else Object.assign(take.mix[id], patch);
  // Live, without restarting playback
  const b = state.playing?.buses?.[id];
  if (b) {
    const t = track(id);
    b.gain.setTargetAtTime(busLevel(id, t), synth.ctx.currentTime, 0.03);
  }
  if (id !== 'click') markDirty();
}

$('#layersBtn').addEventListener('click', openTracksSheet);

// One bar of clicks before each layer, unless switched off.
function layerCountIn() {
  try { return localStorage.getItem('alchemy.layerCountIn') !== '0'; } catch { return true; }
}

const backingLabel = () => `${soundOf(chordSound()).name} · ${styleOf(chordStyle()).name}`;
const optRow = (act, label, items, current) => `
  <div class="opt-label">${label}</div>
  <div class="opt-row" role="radiogroup" aria-label="Chord ${label.toLowerCase()}">${items.map((it) =>
    `<button class="chip-sm ${it.id === current ? 'on' : ''}" data-act="${act}" data-v="${it.id}" role="radio" aria-checked="${it.id === current}">${it.name}</button>`).join('')}</div>`;

function openTracksSheet() {
  const take = state.take;
  const check = '<span class="chk"></span>';
  const row = (id, ic, name, sub, opts = '') => {
    const t = track(id);
    return `<div class="track ${t.on ? '' : 'off'}" data-track="${id}">
      <div class="track-main">
        <span class="track-icon">${icon(ic)}</span>
        <div class="track-name"><b>${esc(name)}</b><span>${sub}</span></div>
        <input class="track-vol" type="range" min="0" max="1" step="0.01" value="${t.vol}" aria-label="${esc(name)} volume">
        <button class="track-mute ${t.on ? 'on' : ''}" data-act="mute" aria-pressed="${t.on}" aria-label="${esc(name)}: ${t.on ? 'playing' : 'muted'}">${icon(t.on ? 'on' : 'off')}</button>
      </div>${opts}
    </div>`;
  };
  const layerRow = (l) => {
    const kind = kindOf(l);
    const sub = kind === 'melody' ? `${l.notes.length} notes · ${fmtTime(l.duration)}`
      : kind === 'rhythm' ? `${l.hits.length} hits · ${fmtTime(l.duration)}`
      : fmtTime(l.duration);
    const extra = kind === 'rhythm'
      ? `<button class="pill ${l.sound === 'kit' ? 'on' : ''}" data-act="kit" aria-pressed="${l.sound === 'kit'}">${check}Drum kit</button>`
      : `<button class="pill ${l.included ? 'on' : ''}" data-act="include" aria-pressed="${l.included}">${check}Harmony</button>`;
    const picker = l.passes?.length > 1
      ? `<div class="pass-pick" role="group" aria-label="Pass">
          <button data-act="pass" data-step="-1" aria-label="Previous pass">‹</button>
          <span>Pass ${l.pass + 1}/${l.passes.length}</span>
          <button data-act="pass" data-step="1" aria-label="Next pass">›</button>
        </div>`
      : '';
    return row(l.id, kind, l.name, sub, `
      <div class="track-opts">
        ${picker}
        <button class="kind-chip" data-act="kind" aria-label="${KINDS[kind]}. Tap to change what kind of sound this is.">${icon(kind)}${KINDS[kind]}</button>
        ${extra}
        <button class="icon-sm" data-act="delete" aria-label="Delete ${esc(l.name)}">${trashIcon}</button>
      </div>`);
  };
  const full = take.layers.length >= MAX_LAYERS;
  // Without Pro, one layer: then the record row gives way to a line about Pro.
  const moreWithPro = !state.pro && take.layers.length >= FREE_LAYERS;

  openSheet(`<div class="tracks-sheet">
    <h3>Tracks</h3>
    <p class="sub">Record more parts over your take: sing, play an instrument, or tap out a beat. Alchemy works out which it is; tap the label to change it. Headphones keep the playback out of the mic.</p>
    <div class="track-list">
      ${row('take', 'take', 'Your take', `Melody · ${fmtTime(take.duration)}`)}
      ${take.layers.map(layerRow).join('')}
      <div class="track-group">Backing</div>
      ${row('backing', 'backing', 'Chords', backingLabel(), `
      <div class="track-opts sound-opts">
        ${optRow('sound', 'Sound', SOUNDS.filter((s) => !locked('sound', s.id)), chordSound())}
        ${optRow('style', 'Style', STYLES.filter((s) => !locked('style', s.id)), chordStyle())}
      </div>`)}
      ${row('guide', 'guide', 'Guide melody', 'Your notes, played clean')}
      ${take.tempo ? row('click', 'click', 'Click', `${Math.round(take.tempo.bpm)} bpm`) : ''}
    </div>
    <div class="record-row">
      <button class="pill ${layerCountIn() ? 'on' : ''}" id="layerCountIn" aria-pressed="${layerCountIn()}">${check}Count-in</button>
      <button class="btn primary" id="layerRecord" ${full ? 'disabled' : ''}><span class="dot"></span>${full ? 'Layer limit reached' : state.loop ? 'Record passes' : 'Record a layer'}</button>
    </div>
    ${state.loop && !full && !moreWithPro ? `<p class="record-note">${state.pro ? 'Loop is on: each time round is kept as a pass, and you pick the best.' : 'Loop is on: the last time round is kept.'}</p>` : ''}
  </div>`);

  const body = $('#sheetBody .tracks-sheet');
  if (moreWithPro) {
    body.querySelector('.record-row').outerHTML = '<button class="layer-more" id="layerMore">More layers come with <b>Alchemy Pro</b></button>';
    $('#layerMore').addEventListener('click', () => openProSheet('layers'));
  } else $('#layerRecord').addEventListener('click', startLayer);
  // (Not there when the record row has given way to the line about Pro.)
  $('#layerCountIn')?.addEventListener('click', () => {
    const on = !layerCountIn();
    try { localStorage.setItem('alchemy.layerCountIn', on ? '1' : '0'); } catch { /* storage unavailable */ }
    haptic();
    openTracksSheet();
    toast(on ? 'Layers start after one bar of clicks.' : 'Layers start straight away.');
  });
  body.addEventListener('input', (e) => {
    if (!e.target.classList.contains('track-vol')) return;
    setTrack(e.target.closest('.track').dataset.track, { vol: +e.target.value });
  });
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.closest('.track').dataset.track;
    const layer = take.layers.find((l) => l.id === id);
    const act = b.dataset.act;
    if (act === 'sound' || act === 'style') {
      if (locked(act, b.dataset.v)) { openProSheet(act); return; }
      take.mix.backing = { ...take.mix.backing, [act]: b.dataset.v };
      try { localStorage.setItem(act === 'sound' ? 'alchemy.chordSound' : 'alchemy.chordStyle', b.dataset.v); } catch { /* storage unavailable */ }
      markDirty();
      b.parentElement.querySelectorAll('.chip-sm').forEach((c) => {
        c.classList.toggle('on', c === b);
        c.setAttribute('aria-checked', String(c === b));
      });
      b.closest('.track').querySelector('.track-name span').textContent = backingLabel();
      previewBacking();
      haptic();
      return;
    }
    if (act === 'mute') {
      const on = !track(id).on;
      if (id === 'click') setMetronome(on);
      else setTrack(id, { on });
    } else if (act === 'include') {
      const kind = kindOf(layer);
      const usable = kind === 'chords' ? layer.chroma.frames.some((f) => f.some((v) => v > 0)) : layer.notes.length > 0;
      if (!layer.included && !usable) {
        toast(kind === 'chords' ? `Couldn't hear clear chords in ${layer.name}.` : `No clear notes in ${layer.name} to harmonize.`);
        return;
      }
      layer.included = !layer.included;
      reanalyze();
      toast(`Harmony updated ${layer.included ? 'with' : 'without'} ${layer.name}`);
    } else if (act === 'kind') {
      const prev = kindOf(layer);
      const next = KIND_ORDER[(KIND_ORDER.indexOf(prev) + 1) % KIND_ORDER.length];
      const wasIncluded = layer.included;
      layer.kind = next;
      prepareLayer(layer);
      stopPlayback();
      markDirty();
      if (prev === 'rhythm' || next === 'rhythm') { retempo(); regrid(); }
      if (wasIncluded) reanalyze();
      else renderHarmony();
      toast(`${layer.name} treated as ${KINDS[next].toLowerCase()}${next === layer.kindAuto ? ', as first detected' : ''}.`);
    } else if (act === 'pass') {
      const n = layer.passes.length;
      usePass(layer, (layer.pass + +b.dataset.step + n) % n);
      markDirty();
      if (layer.included) reanalyze();
      else renderHarmony();
      // Let them hear the pass they picked
      if (state.playing && !layerRec) startPlayback();
    } else if (act === 'kit') {
      layer.sound = layer.sound === 'kit' ? 'original' : 'kit';
      markDirty();
      if (state.playing && !layerRec) startPlayback();
      toast(layer.sound === 'kit' ? `${layer.name} plays as a drum kit.` : `${layer.name} plays as recorded.`);
    } else if (act === 'delete') {
      if (!b.classList.contains('confirm')) {
        b.classList.add('confirm');
        b.textContent = 'Delete';
        return;
      }
      take.layers = take.layers.filter((l) => l !== layer);
      stopPlayback();
      markDirty();
      if (layer.included) reanalyze();
      else renderHarmony();
    } else return;
    haptic();
    openTracksSheet();
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
  if (!amount || !clip.trace || tuning == null || (!isBase && kindOf(clip) !== 'melody')) return clip;

  const key = state.keys[state.keyIdx];
  const notes = isBase ? take.notes : clip.notes.map((n) => ({ ...n, start: n.start - clip.offset, end: n.end - clip.offset }));
  const sig = [amount, mode, mode === 'key' ? `${key.tonic}${key.mode}` : '', take.noteRev ?? 0, notes.length, notes[0]?.start, notes[notes.length - 1]?.end].join('|');
  if (clip.tuned?.sig !== sig) {
    const samples = tuneClip(
      { samples: clip.samples, sampleRate: clip.sampleRate, trace: clip.trace, traceT0: clip.traceT0, hop: clip.hop, tuning: tuning / 100, notes },
      { amount, targetOf: targetFn(mode, scalePcs(key)) }
    );
    clip.tuned = { sig, samples, sampleRate: clip.sampleRate };
  }
  return clip.tuned;
}

$('#tuneBtn').addEventListener('click', () => withPro('tune', openTuneSheet));

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
      if (!track('take').on) setTrack('take', { on: true });
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

/* ---------- timing: lock to the beat ---------- */

// The grid in note values, for the take's time signature (the tempo counts
// quarters, or eighths in x/8).
function gridName(div, meter = '4/4') {
  if (div === 3) return 'triplets';
  const base = (+meter.split('/')[1] || 4) === 8 ? 8 : 4;
  return `1/${base * div}`;
}

const TIMING_FIELDS = ['samples', 'duration', 'notes', 'trace', 'hits', 'trim'];

// Where a clip's audio and analysis live: the take, a layer, or a layer's chosen pass.
const timingHome = (l) => (l.passes ? l.passes[l.pass ?? 0] : l);

// After the timing changed: keys and chords from the moved notes, on the same beat
// grid (the audio was just fitted to it), keeping the key the user had chosen.
function refitAfterTiming() {
  const was = state.keys[state.keyIdx];
  state.keys = findKeys();
  const i = state.keys.findIndex((k) => k.tonic === was.tonic && k.mode === was.mode);
  state.keyIdx = Math.max(0, i);
  reharmonize();
  renderHarmony();
}

// Puts the original timing back (every clip that was locked).
function restoreTiming() {
  const take = state.take;
  const put = (obj, orig) => { for (const f of TIMING_FIELDS) if (f in orig) obj[f] = orig[f]; };
  if (take.timingOriginal) {
    put(take, take.timingOriginal);
    take.timingOriginal = null;
    take.track = null;
    take.buffer = take.bufferCtx = take.tuned = null;
  }
  for (const l of take.layers) {
    const home = timingHome(l);
    if (!home.timingOriginal) continue;
    put(home, home.timingOriginal);
    home.timingOriginal = null;
    home.chroma = home.blocks = null;
    if (l.passes) usePass(l, l.pass ?? 0);
    else { l.chroma = l.blocks = l.buffer = l.bufferCtx = l.tuned = null; prepareLayer(l); }
  }
  take.timing = { ...take.timing, applied: null };
}

// Moves every note and hit start in the take (and, if asked, its layers) onto the
// beat grid, by `amount` (1 = exactly), always starting from the original timing.
// Returns how many starts moved and the grid used for the take.
async function applyTiming({ grid, amount, layers }) {
  const take = state.take, tempo = take.tempo;
  restoreTiming();
  // The audio now follows this grid, so it stays put from here on.
  if (tempo.source !== 'countin') tempo.manual = true;
  const clips = [{ obj: take, offset: 0, notes: take.notes, kind: take.hits?.length ? 'rhythm' : 'melody' }];
  if (layers) {
    for (const l of take.layers) {
      clips.push({ obj: l, offset: l.offset, kind: kindOf(l), notes: l.notes.map((n) => ({ ...n, start: n.start - l.offset, end: n.end - l.offset })) });
    }
  }
  let moved = 0, used = null;
  for (const [k, c] of clips.entries()) {
    setProcessing(true, 0.05 + (0.9 * k) / clips.length);
    await nextFrame();
    const o = c.obj, sr = o.sampleRate, duration = o.samples.length / sr;
    const onsets = findOnsets(o.samples, sr, c.kind === 'rhythm' ? [] : c.notes, o.hits ? o.hits : undefined);
    if (!onsets.length) continue;
    const div = grid === 'auto' ? chooseGrid(onsets.map((t) => t + c.offset), tempo) : grid;
    const { anchors, moved: n } = anchorsFor(onsets, tempo, div, amount, c.offset, duration);
    if (!n) continue;
    if (o === take) used = div;
    moved += n;
    const map = timeMap(anchors, duration);
    const home = o === take ? take : timingHome(o);
    const orig = {};
    for (const f of TIMING_FIELDS) if (home[f] !== undefined) orig[f] = home[f];
    const next = {
      samples: warp(o.samples, sr, map),
      duration: map.length,
      notes: o.notes.map((nt) => ({ ...nt, start: map.toDst(nt.start - c.offset) + c.offset, end: map.toDst(nt.end - c.offset) + c.offset })),
    };
    if (o.trace) next.trace = warpTrace(o.trace, o.traceT0, o.hop, map);
    if (o.hits) next.hits = o.hits.map((h) => ({ ...h, t: +map.toDst(h.t).toFixed(4) }));
    if (o === take) {
      next.trim = { start: map.toDst(take.trim.start), end: take.trim.end >= duration - 0.05 ? map.length : map.toDst(take.trim.end) };
      Object.assign(take, next, { timingOriginal: orig, track: null, buffer: null, bufferCtx: null, tuned: null });
    } else {
      Object.assign(home, next, { timingOriginal: orig, chroma: null, blocks: null });
      if (o.passes) usePass(o, o.pass ?? 0);
      else { Object.assign(o, { chroma: null, blocks: null, buffer: null, bufferCtx: null, tuned: null }); prepareLayer(o); }
    }
  }
  take.timing = { grid, amount, layers, applied: used ?? (moved ? grid : null) };
  setProcessing(false);
  return { moved, used };
}

$('#timingBtn').addEventListener('click', () => withPro('timing', () => openTimingSheet()));

function openTimingSheet(draft = null) {
  const take = state.take, tempo = take.tempo;
  const cur = take.timing ?? {};
  const d = draft ?? { grid: cur.grid ?? 'auto', amount: cur.amount ?? 1, layers: cur.layers ?? true };
  const meter = tempo?.meter ?? '4/4';
  const grids = ['auto', 1, 2, 4, 3];
  const detected = tempo && tempo.source !== 'countin' && !tempo.manual;
  openSheet(`<div class="tune-sheet">
    <h3>Lock to the beat</h3>
    <p class="sub">Finds where each note and hit starts and moves it onto the beat grid, stretching the sound in between so the pitch doesn't change. Your original timing is kept, so you can put it back any time.</p>
    ${!tempo ? '<p class="sub"><b>This needs a beat grid.</b> Record with a count-in, or set a tempo with the metronome button.</p>' : `
    ${detected ? `<p class="sub">The beat grid (${Math.round(tempo.bpm)} bpm) was worked out from your singing. Check it with the metronome first, or record with a count-in, for the tightest result.</p>` : ''}
    <span class="label">Grid</span>
    <div class="seg" role="group" aria-label="Grid">
      ${grids.map((g) => `<button data-grid="${g}" class="${String(g) === String(d.grid) ? 'active' : ''}">${g === 'auto' ? 'Auto' : g === 3 ? 'Triplets' : gridName(g, meter)}</button>`).join('')}
    </div>
    <span class="label">Strength</span>
    <div class="seg" role="group" aria-label="Strength">
      <button data-amount="0.5" class="${d.amount === 0.5 ? 'active' : ''}">Tighten</button>
      <button data-amount="1" class="${d.amount === 1 ? 'active' : ''}">Lock</button>
    </div>
    ${take.layers.length ? `<span class="label">Apply to</span>
    <div class="seg" role="group" aria-label="Apply to">
      <button data-layers="0" class="${d.layers ? '' : 'active'}">Take only</button>
      <button data-layers="1" class="${d.layers ? 'active' : ''}">Take and layers</button>
    </div>` : ''}
    <button class="btn primary block tune-listen" id="timingApply">${cur.applied ? 'Lock again and listen' : 'Lock and listen'}</button>
    ${cur.applied ? '<button class="btn block" id="timingUndo" style="margin-top:8px">Put back my original timing</button>' : ''}`}
    </div>`);
  const sheet = $('#sheetBody .tune-sheet');
  sheet.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.grid) return openTimingSheet({ ...d, grid: b.dataset.grid === 'auto' ? 'auto' : +b.dataset.grid });
    if (b.dataset.amount) return openTimingSheet({ ...d, amount: +b.dataset.amount });
    if (b.dataset.layers) return openTimingSheet({ ...d, layers: b.dataset.layers === '1' });
    if (b.id === 'timingUndo') {
      closeSheet();
      stopPlayback();
      restoreTiming();
      markDirty();
      refitAfterTiming();
      toast('Original timing restored');
      return;
    }
    if (b.id === 'timingApply') {
      closeSheet();
      stopPlayback();
      const { moved, used } = await applyTiming(d);
      markDirty();
      refitAfterTiming();
      if (!moved) { toast("Couldn't find any note starts to move."); return; }
      toast(`Moved ${moved} start${moved === 1 ? '' : 's'} onto ${used ? gridName(used, tempo.meter) : 'the'} grid${d.amount < 1 ? ', halfway' : ''}.`, 3200);
      if (!track('take').on) setTrack('take', { on: true });
      startPlayback();
      haptic();
    }
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
    if (state.take?.tempo?.source === 'countin') {
      if (state.metronome) toast(`Metronome on at your count-in tempo, ${Math.round(state.take.tempo.bpm)} bpm.`);
    } else if (state.metronome && !setMetronome.hinted) {
      setMetronome.hinted = true;
      toast('Metronome on. Press and hold the tempo to adjust it.');
    }
  });
})();

function setMetronome(on) {
  setTrack('click', { on });
  renderHarmony();
  haptic();
}

function setTempo(bpm, manual = true) {
  const take = state.take;
  bpm = Math.max(40, Math.min(240, Math.round(bpm * 2) / 2));
  const meter = take.tempo?.meter;
  const found = detectTempo(withHits(take.notes, take.hits), manual ? bpm : null);
  // Too little to fit a grid to (a note or two): the beat runs from where it was.
  take.tempo = found ?? (manual ? { bpm, beat: 60 / bpm, downbeat: take.tempo?.downbeat ?? firstSound(), meter: meter ?? '4/4' } : null);
  if (manual && take.tempo) take.tempo.manual = true;
  if (meter && take.tempo) take.tempo.meter = meter;
  resnapTrim();
  markDirty();
  stopPlayback();
  regrid();
  renderHarmony();
}

// A trim snapped to the grid follows it when the tempo or bar length changes.
function resnapTrim() {
  const take = state.take, tr = take.trim;
  if (!tr.snap) return;
  if (!take.tempo) { take.trim = { start: Math.max(0, tr.start), end: Math.min(take.duration, tr.end) }; return; }
  const start = snapTime(tr.start, 'start', tr.snap);
  let end = snapTime(tr.end, 'end', tr.snap);
  if (end <= start) end = start + snapUnit(tr.snap);
  take.trim = { ...tr, start, end };
}

// Changes only where the bar lines and accents fall; the beat grid stays put.
function setMeter(meter) {
  const take = state.take;
  take.tempo = { ...take.tempo, meter };
  resnapTrim();
  markDirty();
  const wasPlaying = !!state.playing && !layerRec;
  stopPlayback();
  regrid();
  renderHarmony();
  if (wasPlaying && state.metronome) startPlayback();
}

// The metronome's volume, the same one as the Click track in Tracks: for playback
// and for the click while recording a layer. Changes are heard straight away.
const clickVolRow = () => `<label class="vol-row">Click volume<input type="range" id="clickVol" min="0.05" max="1" step="0.05" value="${state.take.mix.click.vol}"></label>`;
function bindClickVol() {
  $('#clickVol').addEventListener('input', (e) => setTrack('click', { vol: +e.target.value }));
  $('#clickVol').addEventListener('change', () => {
    if (state.playing && state.metronome) return;
    const ctx = synth.ensure();
    synth.countIn(ctx.currentTime + 0.05, 0.4, 1, state.take.mix.click.vol);
  });
}

function openTempoSheet() {
  const take = state.take;
  if (!take?.tempo) return;
  const t = take.tempo;
  if (t.source === 'countin') {
    // The tempo you recorded to is fixed; only the click can be switched.
    openSheet(`<div class="tempo-sheet">
      <h3>Metronome</h3>
      <p class="sub">Tempo set by your count-in, so it's locked to your take's timing. The time signature only moves the accents. It clicks only during playback and layer recording.</p>
      <div class="tempo-row"><div class="tempo-value">${Math.round(t.bpm)}<small>BPM</small></div></div>
      ${meterSeg(t.meter ?? '4/4')}
      <div class="seg" role="group" aria-label="Click">
        <button data-click="off" class="${state.metronome ? '' : 'active'}">Click off</button>
        <button data-click="on" class="${state.metronome ? 'active' : ''}">Click on</button>
      </div>
      ${clickVolRow()}
    </div>`);
    bindClickVol();
    $('#sheetBody .tempo-sheet').addEventListener('click', (e) => {
      const b = e.target.closest('[data-click], [data-meter]');
      if (!b) return;
      if (b.dataset.meter) { setMeter(b.dataset.meter); haptic(); }
      else setMetronome(b.dataset.click === 'on');
      openTempoSheet();
    });
    return;
  }
  openSheet(`<div class="tempo-sheet">
    <h3>Metronome</h3>
    <p class="sub">${t.manual ? 'Tempo set by you.' : `Estimated from your take${t.steady ? '' : ', which drifts a little, so it may need a nudge'}.`} Chord changes follow its bars, and it clicks only during playback and layer recording.</p>
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
    ${meterSeg(t.meter ?? '4/4')}
    <div class="seg" role="group" aria-label="Click">
      <button data-click="off" class="${state.metronome ? '' : 'active'}">Click off</button>
      <button data-click="on" class="${state.metronome ? 'active' : ''}">Click on</button>
    </div>
    ${clickVolRow()}
    ${t.manual ? '<button class="text-btn tempo-reset" id="tempoReset">Back to detected tempo</button>' : ''}
    </div>`);

  const body = $('#sheetBody .tempo-sheet');
  bindClickVol();
  body.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.id === 'tapTempo') return;
    if (b.dataset.step) setTempo(Math.round(take.tempo.bpm) + +b.dataset.step);
    else if (b.dataset.mul) setTempo(take.tempo.bpm * +b.dataset.mul);
    else if (b.dataset.click) setMetronome(b.dataset.click === 'on');
    else if (b.dataset.meter) { setMeter(b.dataset.meter); haptic(); }
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

const withoutSamples = (o) => (o ? (({ samples, ...rest }) => rest)(o) : undefined);

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
    hits: take.hits,
    tempo: take.tempo,
    tune: take.tune,
    timing: take.timing,
    timingOriginal: withoutSamples(take.timingOriginal),
    traceOffset: take.traceOffset,
    // Chroma and drawing caches are rebuilt from the audio when the take is opened.
    layers: take.layers.map(({ samples, buffer, bufferCtx, tuned, chroma, blocks, passes, timingOriginal, ...rest }) => ({
      ...rest,
      timingOriginal: withoutSamples(timingOriginal),
      passes: passes?.map(({ samples: _, chroma: __, timingOriginal: to, ...pass }) => ({ ...pass, timingOriginal: withoutSamples(to) })),
    })),
    mix: take.mix,
    keyIdx: state.keyIdx,
    key: { tonic: key.tonic, mode: key.mode },
    idea: state.ideaIdx,
    rhythm: state.rhythm,
    palette: state.palette,
    overrides: state.overrides,
    segments: state.harmony.segments.some((s) => s.edited)
      ? resolvedSegments().map((s) => ({ start: s.start, end: s.end, chordId: s.chord.id, edited: !!s.edited }))
      : null,
    noteRev: take.noteRev,
    summary: { key: keyName(key), chords: resolvedSegments().map((s) => chordLabel(s, key)), length: range.end - range.start },
  };
  // A layer with passes stores each pass's audio (the chosen one among them).
  const audio = {
    base: take.samples,
    layers: Object.fromEntries(take.layers.filter((l) => !l.passes).map((l) => [l.id, l.samples])),
    passes: Object.fromEntries(take.layers.filter((l) => l.passes).map((l) => [l.id, l.passes.map((x) => x.samples)])),
    // Original timing, kept while a take is locked to the beat
    originals: {
      base: take.timingOriginal?.samples,
      layers: Object.fromEntries(take.layers.filter((l) => !l.passes && l.timingOriginal).map((l) => [l.id, l.timingOriginal.samples])),
      passes: Object.fromEntries(take.layers.filter((l) => l.passes).map((l) => [l.id, l.passes.map((x) => x.timingOriginal?.samples ?? null)])),
    },
  };
  try {
    await store.save(meta, audio);
    take.dirty = false;
    closeSheet();
    renderHarmony();
    toast('Saved to your library');
    haptic(12);
  } catch {
    toast(isNative ? "Couldn't save. Your iPhone may be out of storage." : "Couldn't save. Your browser may be out of storage.");
  }
}

$('#shareBtn').addEventListener('click', () => {
  if (!state.take) return;
  openSheet(`
    <h3>Share</h3>
    <button class="btn block" id="shareChart">Chord chart (text)</button>
    ${state.pro ? '<button class="btn primary block" id="shareMidi">MIDI file: melody, chords and bass</button>' : ''}`);
  $('#shareChart').addEventListener('click', () => { closeSheet(); shareChart(); });
  $('#shareMidi')?.addEventListener('click', () => withPro('midi', () => { closeSheet(); shareMidi(); }));
});

async function shareChart() {
  const key = state.keys[state.keyIdx];
  const segs = resolvedSegments();
  const text = [
    state.take.name,
    `Key: ${keyName(key)}`,
    `| ${segs.map((s) => chordLabel(s, key)).join(' | ')} |`,
    segs.map((s) => s.chord.roman).join(' – '),
    '',
    `Melody: ${state.take.notes.map((n) => spell(pc(n.midi), key)).join(' ')}`,
  ].join('\n');
  if (isNative) {
    try { await shareText('Alchemy', text); } catch { toast("Couldn't share the chord chart."); }
    return;
  }
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
}

// The melody (with any melody layers in the harmony), the chords and the bass line
// as a MIDI file, laid on the take's beat grid so bars line up in a DAW.
async function shareMidi() {
  const take = state.take, key = state.keys[state.keyIdx];
  const tempo = take.tempo ?? { bpm: 120, ...beatGrid(resolvedSegments()) };
  const { start, end } = takeRange();
  const bar = tempo.beat * barBeats(tempo.meter);
  // Start the file on the bar line at or before the first sound.
  const origin = tempo.downbeat + Math.floor((start - tempo.downbeat) / bar + 1e-6) * bar;
  const pulses = (t) => (t - origin) / tempo.beat;
  const melody = analysisNotes()
    .filter((n) => n.end > start && n.start < end)
    .map((n) => ({ midi: n.midi, t: pulses(n.start), dur: (n.end - n.start) / tempo.beat, vel: 100 }));
  // The chords as they play back: the same style and voicing
  const chords = [], bass = [];
  for (const e of backingEvents()) {
    const note = { midi: e.midi, t: pulses(e.t), dur: e.dur / tempo.beat, vel: Math.max(1, Math.round((e.role === 'bass' ? 85 : 70) * e.vel)) };
    (e.role === 'bass' ? bass : chords).push(note);
  }
  const blob = midiFile({
    bpm: tempo.bpm, meter: tempo.meter ?? '4/4', key,
    tracks: [
      { name: 'Melody', channel: 0, program: 0, notes: melody },
      { name: 'Chords', channel: 1, program: soundOf(chordSound()).gm, notes: chords },
      { name: 'Bass', channel: 2, program: 33, notes: bass },
    ],
  });
  const name = `${(take.name || 'Alchemy').replace(/[\\/:*?"<>|]+/g, '').trim() || 'Alchemy'}.mid`;
  if (isNative) {
    try { await shareFile(name, blob); } catch { toast("Couldn't share the MIDI file."); }
    return;
  }
  const file = new File([blob], name, { type: 'audio/midi' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  toast('MIDI file saved');
}

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
    const orig = audio.originals ?? {};
    // A locked clip's original timing comes back only with its original audio.
    const withOriginal = (to, samples) => (to && samples ? { ...to, samples } : null);
    const layers = (meta.layers ?? [])
      .map((l) => {
        const clips = audio.passes?.[l.id];
        if (!l.passes || !clips) {
          return { ...l, passes: undefined, samples: audio.layers?.[l.id], timingOriginal: withOriginal(l.timingOriginal, orig.layers?.[l.id]) };
        }
        const passes = l.passes.map((x, k) => ({ ...x, samples: clips[k], timingOriginal: withOriginal(x.timingOriginal, orig.passes?.[l.id]?.[k]) }));
        return { ...l, passes, samples: passes[l.pass ?? 0]?.samples };
      })
      .filter((l) => l.samples);
    loadTake({ ...meta, samples: audio.base, layers, timingOriginal: withOriginal(meta.timingOriginal, orig.base) }, meta);
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
  synth.sleep();
});

setAudioSession('playback');
// The app's screens don't zoom (a browser keeps pinch-zoom, for accessibility).
if (isNative) $('meta[name="viewport"]').setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
// Pro: everything on the web; in the app, the last known answer straight away,
// then the App Store's (which works offline too).
if (!isNative) setPro(true);
else {
  let known = false;
  try { known = localStorage.getItem('alchemy.pro') === '1'; } catch { /* storage unavailable */ }
  setPro(known);
  proStore.status().then((r) => { proPrice = r.price ?? null; setPro(!!r.pro); }).catch(() => {});
  proStore.onChange((on) => setPro(on)).catch(() => {});
}
state.countIn = loadCountIn();
try { setLoop(localStorage.getItem('alchemy.loop') === '1'); } catch { /* storage unavailable */ }
renderCountIn();
resetLive();
drawLive();
if (location.hash === '#demo') $('#demoBtn').click();

// Updates: check whenever the app comes back to the foreground (a home-screen app
// can stay open for days), and switch to a new version as soon as that can't lose
// anything: not mid-recording, and no unsaved take in hand.
// The iOS app ships its files inside the app and updates through the App Store.
if (!isNative && 'serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  const hadController = !!navigator.serviceWorker.controller;
  let updateReady = false;
  const safeToReload = () => !rec && !layerRec && !starting && (!state.take || (state.take.id && !state.take.dirty));
  const reloadIfSafe = () => { if (updateReady && safeToReload()) location.reload(); };
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
      else reloadIfSafe();
    });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // first install, already current
    updateReady = true;
    reloadIfSafe(); // otherwise next time the app goes to the background
  });
}
