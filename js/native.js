// Native iOS hooks, used only when Alchemy runs inside its Capacitor app shell.
// In a browser `isNative` is false and nothing here loads, so the web version is
// unchanged. (js/vendor/capacitor-core.js exists only in the app build, www/.)

export const isNative = !!window.Capacitor?.isNativePlatform?.();

let plugins = null;
async function native() {
  if (!plugins) {
    const { registerPlugin } = await import('./vendor/capacitor-core.js');
    plugins = { Share: registerPlugin('Share'), Filesystem: registerPlugin('Filesystem'), App: registerPlugin('App') };
  }
  return plugins;
}

const cancelled = (err) => /cancel/i.test(err?.message ?? '');

// Opens the iOS share sheet with text. Returns false if the user cancelled.
export async function shareText(title, text) {
  const { Share } = await native();
  try { await Share.share({ title, text }); return true; } catch (err) { if (cancelled(err)) return false; throw err; }
}

// Audio sent to Alchemy from another app: Voice Memos (Share → Alchemy), Files,
// Mail and so on. iOS copies the file into the app and opens Alchemy with its
// file:// URL, either launching it or while it's running. Calls
// onFile(arrayBuffer, name) for each one, or onError() if it can't be read.
export async function onOpenedFile(onFile, onError) {
  const { App } = await native();
  const handle = async (url) => {
    if (!url?.startsWith('file:')) return;
    const res = await fetch(window.Capacitor.convertFileSrc(url));
    if (!res.ok) throw new Error(`Couldn't read ${url}`);
    const name = decodeURIComponent(url.split('/').pop() || 'Imported audio');
    onFile(await res.arrayBuffer(), name);
  };
  const report = (err) => { console.error('Opening a shared file failed', err); onError?.(); };
  App.addListener('appUrlOpen', ({ url }) => handle(url).catch(report));
  const launch = await App.getLaunchUrl();
  if (launch?.url) handle(launch.url).catch(report);
}

// Writes a file to the app's cache and opens the iOS share sheet for it
// (Save to Files, AirDrop, a DAW, Mail…). Returns false if the user cancelled.
export async function shareFile(name, blob) {
  const { Share, Filesystem } = await native();
  const data = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  const { uri } = await Filesystem.writeFile({ path: name, data, directory: 'CACHE' });
  try { await Share.share({ title: name, files: [uri] }); return true; } catch (err) { if (cancelled(err)) return false; throw err; }
}
