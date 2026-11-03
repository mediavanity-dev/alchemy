# Alchemy

Sing, hum or play a melody on any instrument; Alchemy finds the key it sits in and the chord progression underneath it. Add more parts on top (voices, instruments, beats) as layers.
A mobile-first, installable web app (PWA) with no build step and no dependencies.

## Run it

The microphone only works on `https://` or `localhost`, and the app uses ES modules, so serve the folder:

```sh
python -m http.server 8000
# open http://localhost:8000
```

To try it on a phone, host the folder anywhere with HTTPS (GitHub Pages, Netlify, Cloudflare Pages),
or tunnel your local server (e.g. `npx localtunnel --port 8000`). Then use "Add to Home Screen"
to install it as an app.

Append `#demo` to the URL to load a built-in demo melody without a microphone.

## How it works

| File | Role |
| --- | --- |
| `js/pitch.js` | Downsamples to ~12 kHz, tracks pitch with the McLeod Pitch Method, detects the singer's tuning offset, and segments the pitch curve into notes (splitting repeated notes on loudness dips). |
| `js/theory.js` | Ranks all 24 keys (Krumhansl–Kessler profiles plus first/last-note hints), slices the melody into chord windows scaled to the singer's note spacing, then runs a Viterbi search for chords that fit the notes *and* move like a real progression. |
| `js/sound.js` | Classifies a recording as melody, chords or rhythm; chroma (pitch-class energy) for chord layers; hit detection with kick/snare/hi-hat labels for rhythm layers. |
| `js/tune.js` | Optional pitch correction (TD-PSOLA) toward the nearest note or the key. |
| `js/synth.js` | Web Audio pad, lead, clicks, drum kit and recorded-audio playback, mixed per track, with a small reverb. |
| `js/db.js` | IndexedDB library (metadata and audio in separate stores). |
| `js/app.js` | UI: capture, harmony view, tracks and layers, chord alternatives sheet, save/share, library. |
| `sw.js` | Network-first service worker so the app opens offline. |
