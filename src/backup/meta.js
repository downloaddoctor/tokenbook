// Own IDB for persisting the backup folder handle.
// DB: tokenbook-backup-meta, store kv. FileSystemDirectoryHandle is
// structured-cloneable, so it survives reloads.
//
// Class shape: state (the open-promise cache) lives on the instance. External
// code uses the default instance (`import meta from './meta.js'; meta.get(k)`).

const META_DB = 'tokenbook-backup-meta';
const META_STORE = 'kv';

class Meta {
  constructor() {
    this._metaPromise = null;
  }

  openMeta() {
    if (this._metaPromise) return this._metaPromise;
    this._metaPromise = new Promise((resolve, reject) => {
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
    return this._metaPromise;
  }

  async get(key) {
    const db = await this.openMeta();
    return new Promise((resolve, reject) => {
      const t = db.transaction(META_STORE, 'readonly');
      const r = t.objectStore(META_STORE).get(key);
      r.onsuccess = () => resolve(r.result ? r.result.value : null);
      r.onerror = () => reject(r.error);
    });
  }

  async set(key, value) {
    const db = await this.openMeta();
    return new Promise((resolve, reject) => {
      const t = db.transaction(META_STORE, 'readwrite');
      t.objectStore(META_STORE).put({ key, value });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  async del(key) {
    const db = await this.openMeta();
    return new Promise((resolve, reject) => {
      const t = db.transaction(META_STORE, 'readwrite');
      t.objectStore(META_STORE).delete(key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
}

const metaInstance = new Meta();

export default metaInstance;
export { Meta };
