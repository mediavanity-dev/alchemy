// IndexedDB storage for saved takes. Metadata and audio live in separate stores
// so the library list stays fast.

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

export const list = () => run([META], 'readonly', (tx) => tx.objectStore(META).getAll());

export const save = (meta, samples) =>
  run([META, AUDIO], 'readwrite', (tx) => {
    tx.objectStore(META).put(meta);
    tx.objectStore(AUDIO).put(samples, meta.id);
  });

export async function load(id) {
  const out = {};
  await run([META, AUDIO], 'readonly', (tx) => {
    tx.objectStore(META).get(id).onsuccess = (e) => (out.meta = e.target.result);
    tx.objectStore(AUDIO).get(id).onsuccess = (e) => (out.samples = e.target.result);
  });
  return out;
}

export const remove = (id) =>
  run([META, AUDIO], 'readwrite', (tx) => {
    tx.objectStore(META).delete(id);
    tx.objectStore(AUDIO).delete(id);
  });
