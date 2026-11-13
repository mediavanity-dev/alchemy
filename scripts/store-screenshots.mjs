// Generates the App Store screenshots: runs the web app in headless Chromium at
// iPhone 6.9" resolution (440×956 points at 3×), drives it through its main
// screens (a synthesized sung melody stands in for the microphone), then frames
// each screen with a caption. Output: fastlane/screenshots/en-US/*.png
//
//   npx playwright install chromium   (once)
//   npm run store:screenshots
import { chromium } from 'playwright';
import sharp from 'sharp';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'fastlane', 'screenshots', 'en-US');
const work = join(tmpdir(), 'alchemy-store-shots');
mkdirSync(work, { recursive: true });

// Each screenshot: the raw capture it uses, and its caption. The first three
// show in search results, so they carry the main idea.
const FRAMES = [
  ['harmony', 'Hum a melody.<br><em>Get the chords.</em>', 'Alchemy finds the key and a progression that fits.'],
  ['capture', 'Sing, hum<br>or <em>play anything</em>', 'Your pitch draws live as you record.'],
  ['alternatives', 'Tap a chord.<br><em>Hear what else fits.</em>', 'Ranked alternatives for every bar.'],
  ['tracks', 'Build it up<br><em>layer by layer</em>', 'Add voices, instruments and beats over a count-in.'],
  ['share', 'Take it to<br><em>your DAW</em>', 'Export melody, chords and bass as a MIDI file.'],
  ['library', 'Never lose<br><em>an idea</em>', 'Every take stays on your iPhone. No account needed.'],
];

/* ---------- a static server for the app ---------- */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  if (!path || path.endsWith('/') || path.endsWith('\\')) path += 'index.html';
  const file = join(root, path);
  if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

/* ---------- a sung-style melody for the fake microphone ---------- */
function voiceWav(path) {
  const sr = 48000;
  const mel = [64, 67, 69, 71, 69, 67, 64, 62, 64, 67, 72, 71, 69];
  const durs = [0.45, 0.45, 0.9, 0.45, 0.45, 0.9, 0.45, 0.45, 0.9, 0.45, 0.9, 0.45, 1.4];
  const x = new Float32Array(Math.floor((durs.reduce((a, b) => a + b, 0) + 1.2) * sr));
  let t0 = 0.6, ph = 0;
  mel.forEach((m, k) => {
    const a = Math.floor(t0 * sr), n = Math.floor(durs[k] * sr * 0.94);
    for (let i = 0; i < n; i++) {
      const t = i / sr, env = Math.min(1, t / 0.05, (n - i) / sr / 0.06);
      const f = 440 * 2 ** ((m - 69) / 12) * (1 + 0.01 * Math.sin(2 * Math.PI * 5.4 * t) * Math.min(1, t / 0.3));
      ph += (2 * Math.PI * f) / sr;
      x[a + i] = 0.25 * env * (Math.sin(ph) + 0.45 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph) + 0.1 * Math.sin(4 * ph));
    }
    t0 += durs[k];
  });
  const buf = Buffer.alloc(44 + x.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + x.length * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(x.length * 2, 40);
  x.forEach((v, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  writeFileSync(path, buf);
}
const wav = join(work, 'voice.wav');
voiceWav(wav);

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'],
});
const device = { viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, colorScheme: 'dark' };

/* ---------- raw app screens ---------- */
{
  const ctx = await browser.newContext({ ...device, isMobile: true, hasTouch: true, permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.warn('page error:', e.message));
  // Inter stands in for the iPhone's San Francisco, which only exists on Apple devices.
  const font = async () => {
    await page.addStyleTag({ url: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=block' });
    await page.addStyleTag({ content: ':root{--font: Inter, system-ui, sans-serif !important} .toast{visibility:hidden !important}' });
    await page.evaluate(() => document.fonts.ready);
  };
  const shot = async (name) => { await page.waitForTimeout(700); await page.screenshot({ path: join(work, `${name}.png`) }); console.log('captured', name); };
  const closeSheet = async () => { await page.click('#sheetBackdrop', { position: { x: 20, y: 20 } }); await page.waitForTimeout(500); };

  await page.goto(url);
  await font();
  await page.click('#recBtn');
  await page.waitForTimeout(6500);
  await shot('capture');
  await page.click('#recBtn');
  await page.waitForSelector('#view-harmony.active', { timeout: 30000 });

  await page.goto(url + '#demo');
  await page.reload();
  await font();
  await page.waitForSelector('#view-harmony.active', { timeout: 30000 });
  await page.click('#saveBtn');
  await page.fill('#saveName', 'Late night chorus');
  await page.click('#saveConfirm');
  await page.waitForTimeout(2600); // let the "Saved" toast go
  await page.click('[data-setting="palette"] [data-value="extended"]');
  await shot('harmony');
  // Tapped in place: a normal click would scroll the cards into view, hiding the melody.
  await page.evaluate(() => document.querySelectorAll('.chord-card')[2].click());
  await shot('alternatives');
  await closeSheet();
  await page.click('#layersBtn');
  await shot('tracks');
  await closeSheet();
  await page.click('#shareBtn');
  await shot('share');
  await closeSheet();

  // A few more takes for the library (sample content, list view only)
  await page.evaluate(async () => {
    const db = await import('/js/db.js');
    const day = 86400000, now = Date.now();
    const takes = [
      ['Shower melody', 'D major', ['D', 'Bm', 'G', 'A', 'D', 'G', 'A'], 17, 0],
      ['Bridge idea', 'E Dorian', ['Em', 'A', 'Em', 'D', 'C', 'A'], 31, 1],
      ['Guitar riff', 'G Mixolydian', ['G', 'F', 'C', 'G', 'F', 'C', 'D'], 12, 3],
      ['Lullaby', 'F major', ['F', 'Dm', 'B♭', 'C', 'F', 'B♭', 'C', 'F', 'Dm'], 42, 0],
    ];
    for (const [i, [name, key, chords, len, layers]] of takes.entries()) {
      await db.save({ id: `sample${i}`, name, created: now - (i + 1) * day * 1.7, duration: len, layers: Array(layers).fill({}), summary: { key, chords, length: len } },
        { base: new Float32Array(1), layers: {}, passes: {} });
    }
  });
  await page.click('.tab[data-view="library"]');
  await shot('library');
  await ctx.close();
}

/* ---------- captioned frames ---------- */
{
  const ctx = await browser.newContext(device);
  const page = await ctx.newPage();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [i, [name, title, sub]] of FRAMES.entries()) {
    const img = readFileSync(join(work, `${name}.png`)).toString('base64');
    await page.setContent(`<!doctype html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,500;1,500&family=Inter:wght@400;500&display=block" rel="stylesheet">
<style>
  html, body { margin: 0; width: 440px; height: 956px; overflow: hidden; }
  body { background: radial-gradient(120% 60% at 50% 0%, #2c2147 0%, #18132a 45%, #120f1a 100%); color: #f3eee4; text-align: center; }
  h1 { margin: 52px 24px 0; text-wrap: balance; font: 500 44px/1.04 'Crimson Pro', serif; letter-spacing: -0.01em; }
  h1 em { font-style: italic; color: #e5bc63; }
  p { margin: 12px 44px 0; text-wrap: balance; font: 400 16.5px/1.35 Inter, sans-serif; color: #b9b2c9; }
  .phone { position: absolute; left: 50%; top: 226px; transform: translateX(-50%); width: 318px; padding: 9px; border-radius: 58px;
    background: #050408; box-shadow: 0 0 0 1.5px #3a3150, 0 30px 80px rgba(0,0,0,.6), 0 0 120px rgba(169,155,255,.12); }
  .phone img { display: block; width: 100%; border-radius: 47px; }
</style></head><body><h1>${title}</h1><p>${sub}</p><div class="phone"><img src="data:image/png;base64,${img}"></div></body></html>`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const file = join(outDir, `${String(i + 1).padStart(2, '0')}_${name}.png`);
    // Opaque RGB: App Store Connect turns away screenshots with an alpha channel.
    await sharp(await page.screenshot()).removeAlpha().png().toFile(file);
    console.log('framed', file);
  }
  await ctx.close();
}

await browser.close();
server.close();
