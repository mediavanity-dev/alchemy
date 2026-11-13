// Native iOS hooks, used only when Alchemy runs inside its Capacitor app shell.
// In a browser `isNative` is false and nothing here loads, so the web version is
// unchanged. (js/vendor/capacitor-core.js exists only in the app build, www/.)

export const isNative = !!window.Capacitor?.isNativePlatform?.();

let plugins = null;
async function native() {
  if (!plugins) {
    const { registerPlugin } = await import('./vendor/capacitor-core.js');
    plugins = { Share: registerPlugin('Share'), Filesystem: registerPlugin('Filesystem'), Alchemy: registerPlugin('Alchemy') };
  }
  return plugins;
}

// Whether the phone's sound is going to headphones (wired, USB or Bluetooth).
// A browser can't tell, so the web version always answers false.
export async function headphonesIn() {
  if (!isNative) return false;
  try {
    const { Alchemy } = await native();
    return !!(await Alchemy.headphones()).headphones;
  } catch {
    return false;
  }
}

const cancelled = (err) => /cancel/i.test(err?.message ?? '');

// Opens the iOS share sheet with text. Returns false if the user cancelled.
export async function shareText(title, text) {
  const { Share } = await native();
  try { await Share.share({ title, text }); return true; } catch (err) { if (cancelled(err)) return false; throw err; }
}

// Audio sent to Alchemy from another app: Voice Memos (Share → Alchemy), Files,
// Mail and so on, whether it launched the app or arrived while it was running.
// The native side copies each file in and hands over its first maxSeconds as WAV.
// Calls onFile(arrayBuffer, name, truncated) for each, or onError() if one can't
// be read.
export async function onOpenedFile(onFile, onError, maxSeconds = 90) {
  const { Alchemy } = await native();
  const report = (err) => { console.error('Opening a shared file failed', err); onError?.(); };
  let busy = Promise.resolve();
  const take = () => (busy = busy.then(async () => {
    const { files } = await Alchemy.takeOpenedFiles({ maxSeconds });
    for (const f of files ?? []) {
      if (f.error || !f.wav) { report(new Error(`${f.name}: ${f.error}`)); continue; }
      const bin = atob(f.wav);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await onFile(bytes.buffer, f.name || 'Imported audio', !!f.truncated);
    }
  }).catch(report));
  await Alchemy.addListener('fileOpened', take);
  await take();
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
