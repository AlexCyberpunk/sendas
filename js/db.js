const DB_NAME = 'sendas';
const DB_VERSION = 3;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const ensure = (name, opts) => (db.objectStoreNames.contains(name) ? req.transaction.objectStore(name) : db.createObjectStore(name, opts));
        ensure('walks', { keyPath: 'id' });
        ensure('zones', { keyPath: 'id' });
        ensure('state');
        const photos = ensure('photos', { keyPath: 'id' });
        if (!photos.indexNames.contains('walkId')) photos.createIndex('walkId', 'walkId');
        ensure('peaks');
        const voice = ensure('voice', { keyPath: 'id' });
        if (!voice.indexNames.contains('walkId')) voice.createIndex('walkId', 'walkId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const db = {
  all: (store) => run(store, 'readonly', (s) => s.getAll()),
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  put: (store, value, key) => run(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))),
  delete: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  byIndex: (store, index, value) => run(store, 'readonly', (s) => s.index(index).getAll(value)),
  deleteByIndex: (store, index, value) => run(store, 'readwrite', (s) => {
    const req = s.index(index).openKeyCursor(IDBKeyRange.only(value));
    req.onsuccess = () => {
      const c = req.result;
      if (c) { s.delete(c.primaryKey); c.continue(); }
    };
  }),
};
