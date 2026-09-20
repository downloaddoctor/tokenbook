// Own IDB for persisting the backup folder handle.
// DB: apt-list-backup-meta, store kv. FileSystemDirectoryHandle is
// structured-cloneable, so it survives reloads.

const META_DB = 'apt-list-backup-meta';
const META_STORE = 'kv';

let _metaPromise = null;
function openMeta() {
  if (_metaPromise) return _metaPromise;
  _metaPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(META_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _metaPromise;
}

export async function metaGet(key) {
  const db = await openMeta();
  return new Promise((resolve, reject) => {
    const t = db.transaction(META_STORE, 'readonly');
    const r = t.objectStore(META_STORE).get(key);
    r.onsuccess = () => resolve(r.result ? r.result.value : null);
    r.onerror = () => reject(r.error);
  });
}

export async function metaSet(key, value) {
  const db = await openMeta();
  return new Promise((resolve, reject) => {
    const t = db.transaction(META_STORE, 'readwrite');
    t.objectStore(META_STORE).put({ key, value });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function metaDel(key) {
  const db = await openMeta();
  return new Promise((resolve, reject) => {
    const t = db.transaction(META_STORE, 'readwrite');
    t.objectStore(META_STORE).delete(key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
