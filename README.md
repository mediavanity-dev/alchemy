# Alchemy

Sing, hum or play a melody on any instrument; Alchemy finds the key it sits in and the chord progression underneath it. Add more parts on top (voices, instruments, beats) as layers.
A mobile-first, installable web app (PWA) with no build step and no dependencies.

**Try it live:** https://mediavanity-dev.github.io/alchemy/ ([demo melody](https://mediavanity-dev.github.io/alchemy/#demo))

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
| `js/pitch.js` | Downsamples to ~12 kHz and tracks pitch with the McLeod Pitch Method, keeping octave alternatives. Follows the singer's tuning as it drifts (with vibrato averaged out), then finds the notes with an HMM/Viterbi note tracker in the spirit of pYIN, so vibrato, scoops and octave slips stay inside their note. Repeated notes split on loudness dips. |
| `js/theory.js` | Ranks 48 keys (major, minor, Dorian, Mixolydian) by how likely the notes are under Temperley's melody profiles (and his harmony profiles for played chords), plus first/last-note hints. Places bar lines from where long notes fall, slices the melody into chord windows, and runs a second-order Viterbi search for chords that fit the notes, move like a real progression and favour familiar three-chord moves. Repeated phrases keep their chords. Offers several distinct progressions, and picks inversions and voice leading. |
| `js/sound.js` | Classifies a recording as melody, chords or rhythm; tuning-corrected chroma (pitch-class energy) for chord layers; hit detection with kick/snare/hi-hat labels for rhythm layers. |
| `js/track-worker.js` | Runs pitch tracking in a Web Worker so the page stays smooth. |
| `js/midi.js` | Writes the melody, chords and bass as a standard MIDI file. |
| `js/timing.js` | Lock to the beat: finds note and hit starts, picks the subdivision that best explains them, moves each onto the grid and time-stretches the audio between (WSOLA, pitch unchanged, attacks untouched). |
| `js/tune.js` | Optional pitch correction (TD-PSOLA) toward the nearest note or the key. |
| `js/synth.js` | Web Audio pad, lead, clicks, drum kit and recorded-audio playback, mixed per track, with a small reverb. |
| `js/db.js` | IndexedDB library (metadata and audio in separate stores). |
| `js/app.js` | UI: capture, harmony view, tracks and layers, chord alternatives sheet, save/share, library. |
| `sw.js` | Network-first service worker so the app opens offline. |

## iPhone app

The same code ships as an iOS app via Capacitor (`ios/`). Run `npm install`, then `npm run ios:sync` after web changes.
See [APP_STORE.md](APP_STORE.md) for building on GitHub Actions and publishing to the App Store.
