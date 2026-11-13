// Network-first service worker: always fresh when online, still opens offline.
const CACHE = 'alchemy-v34';
const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/pitch.js',
  'js/theory.js',
  'js/synth.js',
  'js/tune.js', 'js/sound.js', 'js/midi.js', 'js/timing.js',
  'js/db.js', 'js/native.js', 'js/instruments.js',
  'js/recorder-worklet.js',
  'js/track-worker.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

// GitHub Pages lets browsers reuse files for 10 minutes, which right after a release
// can mix old and new files. Every fetch here checks with the server instead (a
// cheap "not modified" when nothing changed).
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
