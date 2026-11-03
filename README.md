# Alchemy

Hum or sing a melody; Alchemy finds the key it sits in and the chord progression underneath it.
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
| `js/synth.js` | Web Audio pad, lead and voice playback with a small reverb. |
| `js/db.js` | IndexedDB library (metadata and audio in separate stores). |
| `js/app.js` | UI: capture, harmony view, chord alternatives sheet, save/share, library. |
| `sw.js` | Network-first service worker so the app opens offline. |
