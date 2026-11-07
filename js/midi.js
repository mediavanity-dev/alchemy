// Standard MIDI file (type 1) writer: one track per part, plus tempo, time and key
// signature, so the melody and chords open in any DAW or notation app.

const PPQ = 480;

const vlq = (n) => {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
};
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const text = (s) => [...new TextEncoder().encode(s)];

// events: [tick, bytes[]]; sorted, then written with delta times.
function chunk(events) {
  events.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  const data = [];
  let last = 0;
  for (const [tick, bytes] of events) {
    data.push(...vlq(Math.max(0, tick - last)), ...bytes);
    last = Math.max(last, tick);
  }
  data.push(0, 0xff, 0x2f, 0); // end of track
  return [...text('MTrk'), ...u32(data.length), ...data];
}

// Sharps (+) or flats (-) in the key signature of a major key.
const fifths = (tonic) => { const n = (tonic * 7) % 12; return n > 6 ? n - 12 : n; };
const PARENT = { major: 0, minor: 3, dorian: 10, mixolydian: 5 };

// bpm: pulses per minute (quarters, or eighths in x/8). key: { tonic, mode }.
// tracks: [{ name, channel, program, notes: [{ midi, t, dur, vel }] }] with times in pulses.
export function midiFile({ bpm, meter = '4/4', key, tracks }) {
  const [num, den] = meter.split('/').map(Number);
  const pulse = den === 8 ? PPQ / 2 : PPQ;
  const usPerQuarter = Math.round((60e6 / bpm) * (PPQ / pulse));
  const sf = key ? fifths((key.tonic + PARENT[key.mode]) % 12) : 0;
  const conductor = [
    [0, [0xff, 0x51, 3, (usPerQuarter >> 16) & 255, (usPerQuarter >> 8) & 255, usPerQuarter & 255], 0],
    [0, [0xff, 0x58, 4, num, Math.log2(den), 24, 8], 0],
    [0, [0xff, 0x59, 2, sf & 255, key?.mode === 'minor' ? 1 : 0], 0],
  ];
  const chunks = [chunk(conductor)];
  for (const tr of tracks) {
    const ch = tr.channel & 15;
    const ev = [[0, [0xff, 0x03, ...vlq(text(tr.name).length), ...text(tr.name)], 0]];
    if (tr.program != null) ev.push([0, [0xc0 | ch, tr.program & 127], 0]);
    for (const n of tr.notes) {
      const on = Math.max(0, Math.round(n.t * pulse)), off = Math.max(on + 1, Math.round((n.t + n.dur) * pulse));
      const m = Math.max(0, Math.min(127, Math.round(n.midi)));
      ev.push([on, [0x90 | ch, m, Math.max(1, Math.min(127, n.vel ?? 90))], 1]);
      ev.push([off, [0x80 | ch, m, 0], 0]); // note-offs first at the same tick, so repeats retrigger
    }
    chunks.push(chunk(ev));
  }
  const header = [...text('MThd'), ...u32(6), 0, 1, 0, chunks.length, (PPQ >> 8) & 255, PPQ & 255];
  return new Blob([new Uint8Array([...header, ...chunks.flat()])], { type: 'audio/midi' });
}
