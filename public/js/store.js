// IndexedDB: "kv" (keys, itinerary, syncedAt), "notes" and "outbox" (by id).
// Everything stored here except the CryptoKey is ciphertext or metadata.
const STORES = ["kv", "notes", "outbox"];
let dbp;

export function openDb() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("itinerary", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("kv");
      db.createObjectStore("notes", { keyPath: "id" });
      db.createObjectStore("outbox", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function run(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const get = (s, k) => run(s, "readonly", (o) => o.get(k));
export const put = (s, v, k) =>
  run(s, "readwrite", (o) => (k === undefined ? o.put(v) : o.put(v, k)));
export const all = (s) => run(s, "readonly", (o) => o.getAll());
export const del = (s, k) => run(s, "readwrite", (o) => o.delete(k));

export async function clearAll() {
  for (const s of STORES) await run(s, "readwrite", (o) => o.clear());
}
