// Alchemy Lab: records labelled test takes for measuring the analysis code.
// Takes are kept in IndexedDB on this device and exported as one zip
// (WAV files plus labels.json) for tools/eval.mjs.

/* ---------- what to record ---------- */

// Short original phrases with known notes and key. [midi, beats]
const MELODIES = [
  { id: 'm1', title: 'Up and back', key: 'C major', bpm: 92, meter: '4/4',
    notes: [[60, 1], [64, 1], [67, 1], [64, 1], [65, 1], [69, 1], [67, 2], [65, 1], [64, 1], [62, 1], [60, 3]] },
  { id: 'm2', title: 'Repeated notes', key: 'G major', bpm: 100, meter: '4/4',
    notes: [[55, 1], [55, 1], [57, 1], [59, 1], [59, 1], [57, 1], [55, 2], [54, 1], [52, 1], [54, 1], [55, 3]] },
  { id: 'm3', title: 'Minor turn', key: 'A minor', bpm: 88, meter: '4/4',
    notes: [[57, 1], [60, 1], [64, 2], [62, 1], [60, 1], [59, 2], [60, 1], [59, 1], [56, 1], [59, 1], [57, 4]] },
  { id: 'm4', title: 'Waltz', key: 'F major', bpm: 120, meter: '3/4',
    notes: [[53, 2], [57, 1], [60, 2], [58, 1], [57, 2], [55, 1], [53, 3], [55, 2], [57, 1], [58, 2], [55, 1], [53, 3]] },
  { id: 'm5', title: 'Quick steps', key: 'D major', bpm: 84, meter: '4/4',
    notes: [[62, 0.5], [64, 0.5], [66, 0.5], [67, 0.5], [69, 1], [66, 1], [67, 0.5], [66, 0.5], [64, 0.5], [62, 0.5], [61, 1], [62, 2]] },
  { id: 'm6', title: 'Long notes', key: 'E minor', bpm: 72, meter: '4/4',
    notes: [[52, 2], [55, 2], [59, 3], [57, 1], [55, 2], [54, 2], [52, 4]] },
];

const PROGRESSIONS = [
  { id: 'c1', key: 'C major', chords: ['C', 'G', 'Am', 'F'] },
  { id: 'c2', key: 'G major', chords: ['G', 'Em', 'C', 'D'] },
  { id: 'c3', key: 'A minor', chords: ['Am', 'F', 'G', 'Am'] },
  { id: 'c4', key: 'D major', chords: ['D', 'Bm', 'G', 'A7'] },
  { id: 'c5', key: 'E minor', chords: ['Em', 'C', 'D', 'B7'] },
  { id: 'c6', key: 'C major', chords: ['C', 'Am', 'Dm', 'G7'] },
];

// kind: what the app should classify it as ('none' = should find nothing to use).
const CATS = [
  { id: 'sing-back', name: 'Sing it back', kind: 'melody', prompt: 'melody',
    hint: 'Tap Listen, then record yourself singing it back on "la" or "da". Any octave is fine; try to keep the same notes.' },
  { id: 'hum-back', name: 'Hum it back', kind: 'melody', prompt: 'melody',
    hint: 'Tap Listen, then hum it back with your mouth closed.' },
  { id: 'whistle-back', name: 'Whistle it back', kind: 'melody', prompt: 'melody',
    hint: 'Tap Listen, then whistle it back.' },
  { id: 'play-tune', name: 'Play a tune', kind: 'melody', prompt: 'melody',
    hint: 'Play this tune on any instrument, one note at a time. Put the instrument in the note box.' },
  { id: 'sing-free', name: 'Sing anything', kind: 'melody', target: 4,
    hint: 'Sing part of a song you know, with words. Put its name (and key, if you know it) in the note box.' },
  { id: 'strum', name: 'Strum chords', kind: 'chords', prompt: 'chords',
    hint: 'Strum these chords on guitar or ukulele, about one bar each. Going round twice is fine.' },
  { id: 'keys', name: 'Piano chords', kind: 'chords', prompt: 'chords',
    hint: 'Play these chords on a piano or keyboard, about one bar each. Going round twice is fine.' },
  { id: 'beatbox', name: 'Beatbox', kind: 'rhythm', target: 4,
    hint: 'Beatbox a steady beat for 8 to 10 seconds (kick, snare, hi-hat).' },
  { id: 'tap', name: 'Tap or drum', kind: 'rhythm', target: 4,
    hint: 'Tap a beat on a table, your knees or a drum.' },
  { id: 'clap', name: 'Clap', kind: 'rhythm', target: 4,
    hint: 'Clap a rhythm, with or without a steady beat.' },
  { id: 'speech', name: 'Talking', kind: 'none', target: 3,
    hint: 'Just talk normally for 8 to 10 seconds. The app should not take it for a tune.' },
  { id: 'room', name: 'Room noise', kind: 'none', target: 3,
    hint: 'Record 8 to 10 seconds of the room with nobody performing (fan, traffic, TV in another room are all fine).' },
];
for (const c of CATS) c.target ??= c.prompt === 'melody' ? MELODIES.length : c.prompt === 'chords' ? PROGRESSIONS.length : 4;

const MAX_SECONDS = 60;

/* ---------- storage ---------- */

let db;
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('alchemy-lab', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('clips', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const tx = (mode, fn) => new Promise((res, rej) => {
  const t = db.transaction('clips', mode);
  const out = fn(t.objectStore('clips'));
  t.oncomplete = () => res(out?.result);
  t.onerror = () => rej(t.error);
});
const putClip = (c) => tx('readwrite', (s) => s.put(c));
const delClip = (id) => tx('readwrite', (s) => s.delete(id));
const allClips = () => tx('readonly', (s) => s.getAll());
const clearClips = () => tx('readwrite', (s) => s.clear());

const pref = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('lab.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('lab.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

/* ---------- state ---------- */

const $ = (s) => document.querySelector(s);
let clips = [];
let cat = CATS.find((c) => c.id === pref.get('cat')) ?? CATS[0];
let promptIdx = pref.get('promptIdx', {});
let rec = null;

const currentPrompt = () => {
  if (!cat.prompt) return null;
  const list = cat.prompt === 'melody' ? MELODIES : PROGRESSIONS;
  return list[(promptIdx[cat.id] ?? 0) % list.length];
};

/* ---------- audio ---------- */

function setSession(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch { /* not supported */ }
}

let playCtx = null, playing = [];
function getPlayCtx() {
  if (!playCtx || playCtx.state === 'closed') playCtx = new AudioContext();
  playCtx.resume();
  return playCtx;
}
function stopSound() {
  playing.forEach((n) => { try { n.stop(); } catch { /* already stopped */ } });
  playing = [];
}

function playMelody(m, onlyFirst = false) {
  stopSound();
  setSession('playback');
  const ctx = getPlayCtx();
  const beat = 60 / m.bpm;
  let t = ctx.currentTime + 0.1;
  for (const [midi, beats] of onlyFirst ? m.notes.slice(0, 1) : m.notes) {
    const dur = onlyFirst ? 1.2 : beats * beat;
    const f = 440 * 2 ** ((midi - 69) / 12);
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o.frequency.value = f;
    o2.type = 'sine'; o2.frequency.value = f * 2;
    const g2 = ctx.createGain(); g2.gain.value = 0.25;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.02);
    g.gain.setTargetAtTime(0.22, t + 0.05, 0.1);
    g.gain.setTargetAtTime(0, t + dur - 0.06, 0.02);
    o.connect(g); o2.connect(g2).connect(g); g.connect(ctx.destination);
    o.start(t); o2.start(t); o.stop(t + dur + 0.1); o2.stop(t + dur + 0.1);
    playing.push(o, o2);
    t += dur;
  }
}

function playClip(c) {
  stopSound();
  setSession('playback');
  const ctx = getPlayCtx();
  const x = new Float32Array(c.pcm);
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const buf = ctx.createBuffer(1, x.length, c.sampleRate);
  buf.copyToChannel(x, 0);
  const src = ctx.createBufferSource(), g = ctx.createGain();
  g.gain.value = peak > 0 ? Math.min(0.8 / peak, 300) : 1; // raw takes can be very quiet
  src.buffer = buf;
  src.connect(g).connect(ctx.destination);
  src.start();
  playing.push(src);
}

async function startRecording() {
  stopSound();
  if (playCtx) { playCtx.close(); playCtx = null; }
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Recording needs https or localhost.');
  setSession('play-and-record');
  const ctx = new AudioContext(); // made inside the tap so the browser lets it run
  let stream;
  try {
    // The same settings as the app: no voice processing at all.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch {
    ctx.close(); setSession('playback');
    throw new Error('Microphone access was refused.');
  }
  await ctx.resume();
  const chunks = [];
  let level = 0;
  const onData = (d) => {
    chunks.push(d);
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    level = Math.max(level * 0.85, Math.sqrt(s / d.length));
  };
  const source = ctx.createMediaStreamSource(stream);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  let node;
  if (ctx.audioWorklet) {
    await ctx.audioWorklet.addModule('../js/recorder-worklet.js');
    node = new AudioWorkletNode(ctx, 'recorder');
    node.port.onmessage = (e) => onData(e.data.data);
  } else {
    node = ctx.createScriptProcessor(1024, 1, 1);
    node.onaudioprocess = (e) => onData(e.inputBuffer.getChannelData(0).slice());
  }
  source.connect(node);
  node.connect(sink).connect(ctx.destination);
  const settings = stream.getAudioTracks()[0]?.getSettings?.() ?? {};
  return {
    sr: ctx.sampleRate,
    settings,
    started: performance.now(),
    get level() { return level; },
    stop() {
      if (node.port) node.port.onmessage = null; else node.onaudioprocess = null;
      source.disconnect(); node.disconnect(); sink.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
      setSession('playback');
      const n = chunks.reduce((a, c) => a + c.length, 0);
      const pcm = new Float32Array(n);
      let o = 0;
      for (const c of chunks) { pcm.set(c, o); o += c.length; }
      return pcm;
    },
  };
}

/* ---------- export: WAV files and a zip ---------- */

// 32-bit float WAV, so quiet takes keep their full detail.
function wav(pcm, sr) {
  const buf = new ArrayBuffer(44 + pcm.length * 4), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 4, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 32, true);
  str(36, 'data'); v.setUint32(40, pcm.length * 4, true);
  new Float32Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(d) {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Uncompressed zip (audio barely compresses anyway).
function zip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true);
    h.setUint16(26, name.length, true);
    parts.push(h.buffer, name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(c.buffer, name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((a, p) => a + p.byteLength, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, e.buffer], { type: 'application/zip' });
}

async function exportAll() {
  if (!clips.length) { status('Nothing to export yet.'); return; }
  status('Building the zip…');
  await new Promise((r) => setTimeout(r, 30));
  const seq = {};
  const files = [], labels = [];
  for (const c of [...clips].sort((a, b) => a.created - b.created)) {
    seq[c.category] = (seq[c.category] ?? 0) + 1;
    const file = `clips/${c.category}-${String(seq[c.category]).padStart(2, '0')}-${c.id}.wav`;
    files.push({ name: file, data: wav(new Float32Array(c.pcm), c.sampleRate) });
    const { pcm, ...meta } = c;
    labels.push({ file, ...meta });
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  files.unshift({
    name: 'labels.json',
    data: new TextEncoder().encode(JSON.stringify({ version: 1, exported: new Date().toISOString(), clips: labels }, null, 1)),
  });
  const name = `alchemy-testdata-${stamp}.zip`;
  const blob = zip(files);
  const file = new File([blob], name, { type: 'application/zip' });
  // On phones, the share sheet is the easy way to get it to a computer (AirDrop, Drive, Files…).
  if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ files: [file], title: name });
      status(`Shared ${clips.length} takes.`);
      return;
    } catch (err) {
      if (err.name === 'AbortError') { status('Export cancelled.'); return; }
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  status(`Downloaded ${name}.`);
}

/* ---------- UI ---------- */

const status = (s) => { $('#status').textContent = s; };
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function renderCats() {
  $('#cats').innerHTML = CATS.map((c) => {
    const n = clips.filter((x) => x.category === c.id).length;
    const dots = Array.from({ length: Math.max(c.target, n) }, (_, i) => `<i class="dot${i < n ? ' on' : ''}"></i>`).join('');
    return `<button class="cat${c === cat ? ' active' : ''}" data-id="${c.id}">
      <span class="kind">${c.kind === 'none' ? 'not music' : c.kind}</span>
      <span class="name">${esc(c.name)}</span><span class="dots">${dots}</span></button>`;
  }).join('');
  const bytes = clips.reduce((a, c) => a + c.pcm.byteLength, 0);
  $('#total').textContent = `${clips.length} take${clips.length === 1 ? '' : 's'}`;
  $('#size').textContent = clips.length ? `About ${Math.max(1, Math.round(bytes / 1e6))} MB to export` : '';
}

function renderPrompt() {
  const el = $('#prompt'), p = currentPrompt();
  el.hidden = !p;
  if (!p) return;
  const list = cat.prompt === 'melody' ? MELODIES : PROGRESSIONS;
  const pos = `${list.indexOf(p) + 1} of ${list.length}`;
  if (cat.prompt === 'melody') {
    el.innerHTML = `<div class="row"><span class="title">${esc(p.title)}</span><span class="meta">${p.key} · ${pos}</span></div>
      <div class="actions"><button class="btn primary" data-act="listen">Listen</button>
      <button class="btn" data-act="first">First note</button><button class="btn" data-act="next">Next phrase</button></div>`;
  } else {
    el.innerHTML = `<div class="row"><span class="title">Play these chords</span><span class="meta">${p.key} · ${pos}</span></div>
      <div class="chords">${p.chords.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
      <div class="actions"><button class="btn" data-act="next">Next progression</button></div>`;
  }
}

function renderClips() {
  const mine = clips.filter((c) => c.category === cat.id).sort((a, b) => b.created - a.created);
  $('#clips').innerHTML = mine.length ? mine.map((c) => {
    const what = c.prompt ? (c.prompt.title ?? c.prompt.chords.join(' ')) : '';
    const note = c.note ? ` <em>${esc(c.note)}</em>` : '';
    return `<div class="clip"><span class="what">${fmt(c.duration)} ${esc(what)}${note}</span>
      <button data-play="${c.id}">Play</button><button data-del="${c.id}">Delete</button></div>`;
  }).join('') : '<p class="empty">No takes yet.</p>';
}

function render() {
  $('#catName').textContent = cat.name;
  $('#catHint').textContent = cat.hint;
  renderCats();
  renderPrompt();
  renderClips();
}

$('#cats').addEventListener('click', (e) => {
  const b = e.target.closest('.cat');
  if (!b || rec) return;
  cat = CATS.find((c) => c.id === b.dataset.id);
  pref.set('cat', cat.id);
  $('#note').value = '';
  status('Tap to record, tap again to stop.');
  render();
});

$('#prompt').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  const p = currentPrompt();
  if (!act || !p || rec) return;
  if (act === 'listen') playMelody(p);
  if (act === 'first') playMelody(p, true);
  if (act === 'next') {
    promptIdx[cat.id] = (promptIdx[cat.id] ?? 0) + 1;
    pref.set('promptIdx', promptIdx);
    stopSound();
    renderPrompt();
  }
});

$('#clips').addEventListener('click', async (e) => {
  const play = e.target.dataset.play, del = e.target.dataset.del;
  if (play) playClip(clips.find((c) => c.id === play));
  if (del) {
    await delClip(del);
    clips = clips.filter((c) => c.id !== del);
    renderCats(); renderClips();
  }
});

let tick = 0;
async function toggleRecording() {
  const btn = $('#recBtn');
  if (!rec) {
    btn.disabled = true;
    try {
      rec = await startRecording();
    } catch (err) {
      status(err.message);
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
    btn.classList.add('on');
    btn.setAttribute('aria-label', 'Stop');
    status('Recording…');
    const loop = () => {
      if (!rec) return;
      const s = (performance.now() - rec.started) / 1000;
      $('#timer').textContent = fmt(s);
      // Log scale so quiet singing still moves the meter (the mic runs without auto gain).
      const db = 20 * Math.log10(rec.level + 1e-9);
      $('#meter').style.width = `${Math.max(0, Math.min(100, ((db + 70) / 60) * 100))}%`;
      if (s >= MAX_SECONDS) { toggleRecording(); return; }
      tick = requestAnimationFrame(loop);
    };
    loop();
    return;
  }
  cancelAnimationFrame(tick);
  const r = rec;
  rec = null;
  btn.classList.remove('on');
  btn.setAttribute('aria-label', 'Record');
  $('#meter').style.width = '0%';
  const pcm = r.stop();
  const duration = pcm.length / r.sr;
  if (duration < 1) { status('Too short, not saved.'); return; }
  const p = currentPrompt();
  const clip = {
    id: Math.random().toString(36).slice(2, 10),
    created: Date.now(),
    category: cat.id,
    kind: cat.kind,
    prompt: p ? { type: cat.prompt, ...p } : null,
    note: $('#note').value.trim(),
    sampleRate: r.sr,
    duration,
    device: { userAgent: navigator.userAgent, settings: r.settings },
    pcm: pcm.buffer,
  };
  await putClip(clip);
  clips.push(clip);
  const n = clips.filter((c) => c.category === cat.id).length;
  if (p) {
    promptIdx[cat.id] = (promptIdx[cat.id] ?? 0) + 1;
    pref.set('promptIdx', promptIdx);
  }
  status(n >= cat.target ? `Saved. That's ${n}, enough of this type; pick the next one when you're ready.` : `Saved take ${n} of ${cat.target}.`);
  render();
}

$('#recBtn').addEventListener('click', toggleRecording);
$('#exportBtn').addEventListener('click', () => { if (!rec) exportAll().catch((err) => status(`Export failed: ${err.message}`)); });
$('#clearBtn').addEventListener('click', async () => {
  if (rec || !clips.length) return;
  if (!confirm(`Delete all ${clips.length} takes from this device? Export first if you want to keep them.`)) return;
  await clearClips();
  clips = [];
  render();
});

(async () => {
  try {
    db = await openDb();
    clips = await allClips();
    navigator.storage?.persist?.();
  } catch {
    status('This browser cannot store takes (private mode?).');
  }
  render();
})();
