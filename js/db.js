// Storage for saved takes: list(), save(meta, audio), load(id), remove(id).
//
// In a browser it's IndexedDB. In the iPhone app it's files in the app's own
// Application Support folder (see AlchemyPlugin in SceneDelegate.swift): iOS may
// clear a web view's storage when the phone runs low on space, but never an
// app's files, which are also included in the phone's backups. Takes saved in
// IndexedDB by earlier versions of the app move across the first time the
// library is opened.

import { isNative, nativePlugin } from './native.js';

/* ---------- IndexedDB (browser; and the old store in the app) ---------- */

const DB_NAME = 'alchemy';
const META = 'takes';
const AUDIO = 'audio';

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(META, { keyPath: 'id' });
        req.result.createObjectStore(AUDIO);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const result = fn(tx);
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const idb = {
  list: () => run([META], 'readonly', (tx) => tx.objectStore(META).getAll()),
  save: (meta, audio) =>
    run([META, AUDIO], 'readwrite', (tx) => {
      tx.objectStore(META).put(meta);
      tx.objectStore(AUDIO).put(audio, meta.id);
    }),
  async load(id) {
    const out = {};
    await run([META, AUDIO], 'readonly', (tx) => {
      tx.objectStore(META).get(id).onsuccess = (e) => (out.meta = e.target.result);
      tx.objectStore(AUDIO).get(id).onsuccess = (e) => (out.samples = e.target.result);
    });
    return out;
  },
  remove: (id) =>
    run([META, AUDIO], 'readwrite', (tx) => {
      tx.objectStore(META).delete(id);
      tx.objectStore(AUDIO).delete(id);
    }),
};

/* ---------- packing: any value with typed arrays, to and from bytes ---------- */

// Layout: "ALC1", JSON length (uint32), the JSON, padding to 4 bytes, then each
// typed array's bytes in turn (each padded to 4). In the JSON a typed array is
// { $a: index, $t: type }, and numbers JSON can't hold are { $n: "NaN" } etc.
const TYPES = { Float32Array, Float64Array, Int16Array, Int32Array, Uint8Array, Uint16Array, Uint32Array };
const pad4 = (n) => (n + 3) & ~3;

export function pack(value) {
  const arrays = [];
  const json = JSON.stringify(value, (k, v) => {
    if (ArrayBuffer.isView(v) && TYPES[v.constructor.name]) return { $a: arrays.push(v) - 1, $t: v.constructor.name, $len: v.length };
    if (typeof v === 'number' && !Number.isFinite(v)) return { $n: String(v) };
    return v;
  });
  const head = new TextEncoder().encode(json);
  let size = 8 + pad4(head.length);
  for (const a of arrays) size += pad4(a.byteLength);
  const out = new Uint8Array(size);
  out.set([65, 76, 67, 49]); // ALC1
  new DataView(out.buffer).setUint32(4, head.length, true);
  out.set(head, 8);
  let at = 8 + pad4(head.length);
  for (const a of arrays) {
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), at);
    at += pad4(a.byteLength);
  }
  return out;
}

export function unpack(bytes) {
  if (bytes[0] !== 65 || bytes[1] !== 76 || bytes[2] !== 67 || bytes[3] !== 49) throw new Error('Not an Alchemy file');
  const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);
  const json = new TextDecoder().decode(bytes.subarray(8, 8 + len));
  // Offsets of each array, in order, from the lengths recorded in the JSON
  const specs = [];
  JSON.parse(json, (k, v) => { if (v && typeof v === 'object' && '$a' in v) specs[v.$a] = v; return v; });
  const starts = [];
  let at = 8 + pad4(len);
  for (const s of specs) {
    starts.push(at);
    at += pad4(s.$len * TYPES[s.$t].BYTES_PER_ELEMENT);
  }
  return JSON.parse(json, (k, v) => {
    if (v && typeof v === 'object') {
      if ('$a' in v) {
        const T = TYPES[v.$t];
        // Copied out, so each array is aligned and independent of the file buffer.
        return new T(bytes.slice(starts[v.$a], starts[v.$a] + v.$len * T.BYTES_PER_ELEMENT).buffer);
      }
      if ('$n' in v && Object.keys(v).length === 1) return Number(v.$n);
    }
    return v;
  });
}

/* ---------- files (the iPhone app) ---------- */

const CHUNK = 3 * 1024 * 1024; // bytes per bridge call

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function writeFile(name, bytes) {
  const A = await nativePlugin();
  // Written beside the old file and swapped in at the end, so a save that's cut
  // short never leaves a half-written take.
  const part = `${name}.part`;
  for (let at = 0; at < bytes.length || at === 0; at += CHUNK) {
    await A.libWrite({ name: part, data: toBase64(bytes.subarray(at, at + CHUNK)), append: at > 0 });
    if (!bytes.length) break;
  }
  await A.libMove({ from: part, to: name });
}

async function readFile(name) {
  const A = await nativePlugin();
  const first = await A.libRead({ name, offset: 0, length: CHUNK });
  const out = new Uint8Array(first.size);
  out.set(fromBase64(first.data), 0);
  for (let at = CHUNK; at < first.size; at += CHUNK) {
    out.set(fromBase64((await A.libRead({ name, offset: at, length: CHUNK })).data), at);
  }
  return out;
}

const safeId = (id) => String(id).replace(/[^\w-]/g, '_');

const files = {
  async list() {
    const A = await nativePlugin();
    const { names } = await A.libList();
    const metas = [];
    for (const name of names.filter((n) => n.endsWith('.meta'))) {
      try { metas.push(unpack(await readFile(name))); } catch (err) { console.error('Unreadable take', name, err); }
    }
    return metas;
  },
  async save(meta, audio) {
    // Audio first: a take is listed only once its meta exists.
    await writeFile(`${safeId(meta.id)}.audio`, pack(audio));
    await writeFile(`${safeId(meta.id)}.meta`, pack(meta));
  },
  async load(id) {
    const meta = unpack(await readFile(`${safeId(id)}.meta`));
    const samples = unpack(await readFile(`${safeId(id)}.audio`));
    return { meta, samples };
  },
  async remove(id) {
    const A = await nativePlugin();
    await A.libDelete({ name: `${safeId(id)}.meta` });
    await A.libDelete({ name: `${safeId(id)}.audio` });
  },
};

// Moves takes saved in IndexedDB (app versions before build 15) into files, once.
// Each is deleted from IndexedDB only after its files are written and read back.
let moved = null;
function moveOldTakes() {
  moved ??= (async () => {
    let old = [];
    try { old = await idb.list(); } catch { return; }
    for (const meta of old) {
      try {
        const { samples } = await idb.load(meta.id);
        if (samples == null) continue;
        await files.save(meta, samples);
        const back = await files.load(meta.id);
        if (back.meta?.id !== meta.id) throw new Error('Read-back mismatch');
        await idb.remove(meta.id);
      } catch (err) {
        console.error('Moving a saved take failed; it stays where it was', meta.id, err);
      }
    }
  })();
  return moved;
}

/* ---------- the store in use ---------- */

export async function list() {
  if (!isNative) return idb.list();
  await moveOldTakes();
  return files.list();
}

export async function save(meta, audio) {
  return isNative ? files.save(meta, audio) : idb.save(meta, audio);
}

export async function load(id) {
  if (!isNative) return idb.load(id);
  await moveOldTakes();
  return files.load(id);
}

export async function remove(id) {
  return isNative ? files.remove(id) : idb.remove(id);
}
