// Builds www/, the copy of the web app that Capacitor bundles into the iOS app.
// The web version (GitHub Pages) keeps serving from the repo root, unchanged.
//  - Google Analytics is stripped: the app collects nothing, which keeps the
//    App Store privacy label at "Data Not Collected" and needs no tracking prompt.
//  - The service worker is left out: the app's files are already on the device.
//  - @capacitor/core is vendored so js/native.js can reach native plugins
//    without a bundler.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const dir of ['css', 'js', 'icons']) cpSync(join(root, dir), join(out, dir), { recursive: true });
copyFileSync(join(root, 'manifest.webmanifest'), join(out, 'manifest.webmanifest'));

let html = readFileSync(join(root, 'index.html'), 'utf8');
const stripped = html.replace(/[ \t]*<!-- analytics:start[\s\S]*?<!-- analytics:end -->\r?\n/, '');
if (stripped === html) throw new Error('index.html: analytics markers not found; refusing to ship analytics in the app');
writeFileSync(join(out, 'index.html'), stripped);

mkdirSync(join(out, 'js', 'vendor'), { recursive: true });
copyFileSync(join(root, 'node_modules', '@capacitor', 'core', 'dist', 'index.js'), join(out, 'js', 'vendor', 'capacitor-core.js'));

console.log('Built www/');
