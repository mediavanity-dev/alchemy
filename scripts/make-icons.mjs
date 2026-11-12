// Renders the iOS app icon and launch-screen image from icons/icon.svg.
// App Store icons must be square and fully opaque; iOS rounds the corners itself.
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'ios', 'App', 'App', 'Assets.xcassets');
const BG = '#120f1a';

const svg = readFileSync(join(root, 'icons', 'icon.svg'), 'utf8');
const square = svg.replace(/ rx="\d+"/, ''); // full-bleed background
const glyph = svg.replace(/<rect[^>]*\/>/, ''); // just the mark, for the launch screen

await sharp(Buffer.from(square), { density: 1024 })
  .resize(1024, 1024).flatten({ background: BG }).removeAlpha()
  .png().toFile(join(assets, 'AppIcon.appiconset', 'AppIcon-512@2x.png'));

const mark = await sharp(Buffer.from(glyph), { density: 600 }).resize(420, 420).png().toBuffer();
const splash = await sharp({ create: { width: 2732, height: 2732, channels: 3, background: BG } })
  .composite([{ input: mark, gravity: 'center' }]).png().toBuffer();
for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  await sharp(splash).toFile(join(assets, 'Splash.imageset', f));
}
console.log('Wrote app icon and launch images');
