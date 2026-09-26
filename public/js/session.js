// App state and data operations (no DOM). UI modules subscribe via onChange.
import { ApiError, createApi } from "./api.js";
import { SALT } from "./config.js";
import { decryptJson, deriveKeys, encryptJson } from "./crypto.js";
import { ensureIds, foldNotes, validateItinerary } from "./model.js";
import * as store from "./store.js";
import {
  createConnectivity,
  flushOutbox,
  pullItinerary,
  pullNotes,
} from "./sync.js";

export const state = {
  keys: null,
  api: null,
  data: null,
  version: 0,
  syncedAt: null,
  noteRecs: new Map(), // id -> decrypted record (+ queued flag)
};
export const conn = createConnectivity(globalThis);

const subs = new Set();
export const onChange = (fn) => subs.add(fn);
const changed = () => subs.forEach((f) => f());

export const notes = () => foldNotes([...state.noteRecs.values()]);

function setKeys(keys) {
  state.keys = keys;
  state.api = createApi(keys.token);
}

// Wraps an API call: network errors flip connectivity, success restores it.
async function net(fn) {
  try {
    const r = await fn();
    conn.markSuccess();
    return r;
  } catch (e) {
    if (e instanceof TypeError) conn.markFailure();
    throw e;
  }
}

export async function loadKeys() {
  const keys = await store.get("kv", "keys");
  if (keys) setKeys(keys);
  return !!keys;
}

export async function loadLocal() {
  const rec = await store.get("kv", "itinerary");
  if (rec && rec.version !== state.version) {
    state.data = await decryptJson(state.keys.encKey, rec.blob);
    state.version = rec.version;
  }
  state.syncedAt = (await store.get("kv", "syncedAt")) || null;
  const queued = new Set((await store.all("outbox")).map((o) => o.id));
  for (const n of await store.all("notes")) {
    let r = state.noteRecs.get(n.id);
    if (!r) {
      r = { ...(await decryptJson(state.keys.encKey, n.blob)), id: n.id };
      state.noteRecs.set(n.id, r);
    }
    r.queued = queued.has(n.id);
  }
}

// Returns "ok" | "empty" | "offline" | "unauthorized" | "error".
export async function refresh() {
  if (!state.api) return "error";
  const before = state.version;
  try {
    await net(() => flushOutbox({ api: state.api, store }));
    await net(() => pullNotes({ api: state.api, store }));
    const { record } = await net(() => pullItinerary({ api: state.api, store }));
    await loadLocal();
    changed();
    if (!record) return "empty";
    return before && before !== state.version ? "updated" : "ok";
  } catch (e) {
    await loadLocal().catch(() => {});
    changed();
    if (e instanceof ApiError && e.status === 401) return "unauthorized";
    if (e instanceof TypeError) return "offline";
    console.error("Sync failed:", e.name);
    return "error";
  }
}

// Returns "ok" | "empty" | "wrong" | "offline".
export async function unlock(passphrase) {
  const keys = await deriveKeys(passphrase, SALT);
  const api = createApi(keys.token);
  let rec;
  try {
    rec = await net(() => api.getItinerary());
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return "wrong";
    if (e instanceof TypeError) return "offline";
    throw e;
  }
  // Local data may be encrypted under an older passphrase: start clean.
  await store.clearAll();
  state.data = null;
  state.version = 0;
  state.noteRecs.clear();
  await store.put("kv", keys, "keys");
  setKeys(keys);
  navigator.storage?.persist?.().catch(() => {});
  if (!rec) return "empty";
  await refresh();
  return "ok";
}

// Accepts a seed file or a "Download JSON" export (which also carries notes).
export const withIds = (d) => (Array.isArray(d?.events) ? ensureIds(d) : d);

// Returns a list of problems, empty on success.
export async function importData(parsed) {
  const { notes: imported = [], ...rest } = parsed ?? {};
  const data = withIds(rest);
  const errs = validateItinerary(data);
  if (errs.length) return errs;
  const blob = await encryptJson(state.keys.encKey, data);
  try {
    const res = await net(() => state.api.putItinerary(blob, 0));
    await store.put("kv", { version: res.version, blob, updatedAt: res.updatedAt }, "itinerary");
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      await refresh();
      return [];
    }
    if (e instanceof TypeError) return ["No connection. Try again online."];
    throw e;
  }
  for (const n of imported) {
    if (n?.date && n?.text) {
      await addNoteRecord({ date: n.date, text: n.text }, n.createdAt, false);
    }
  }
  await loadLocal();
  changed();
  return [];
}

// Saves `next` as the version after `state.version`. Throws ApiError (409,
// 401, ...) or TypeError (offline); state is unchanged on failure.
export async function commit(next, ifMatch = state.version) {
  const errs = validateItinerary(next);
  if (errs.length) throw new ValidationError(errs);
  const blob = await encryptJson(state.keys.encKey, next);
  const res = await net(() => state.api.putItinerary(blob, ifMatch));
  await store.put("kv", { version: res.version, blob, updatedAt: res.updatedAt }, "itinerary");
  await store.put("kv", new Date().toISOString(), "syncedAt");
  state.data = next;
  state.version = res.version;
  state.syncedAt = await store.get("kv", "syncedAt");
  changed();
}

export class ValidationError extends Error {
  constructor(errors) {
    super(errors.join("; "));
    this.errors = errors;
  }
}

// Fetches and decrypts the server's current itinerary (after a 409).
export async function fetchLatest() {
  await net(() => pullItinerary({ api: state.api, store }));
  await loadLocal();
  changed();
  return { data: state.data, version: state.version };
}

export async function history() {
  return net(() => state.api.history());
}

export async function historyVersion(v) {
  const rec = await net(() => state.api.historyVersion(v));
  return decryptJson(state.keys.encKey, rec.blob);
}

// Notes work offline: encrypt, store locally + outbox, then try to upload.
export async function addNoteRecord(
  plain,
  createdAt = new Date().toISOString(),
  sync = true,
) {
  const id = crypto.randomUUID();
  const rec = { ...plain, createdAt };
  const blob = await encryptJson(state.keys.encKey, rec);
  const row = { id, blob, createdAt };
  await store.put("notes", row);
  await store.put("outbox", row);
  state.noteRecs.set(id, { ...rec, id, queued: true });
  if (!sync) return id;
  changed();
  navigator.serviceWorker?.ready
    .then((r) => r.sync?.register("outbox"))
    .catch(() => {});
  if (conn.online) refresh();
  return id;
}

// Unregistering matters: with the worker still registered, deleting its cache
// would leave nothing to re-cache the app shell and offline launch would fail.
export async function forget({
  sw = globalThis.navigator?.serviceWorker,
  cacheStorage = globalThis.caches,
} = {}) {
  await store.clearAll();
  for (const r of (await sw?.getRegistrations()) || []) await r.unregister();
  for (const k of await cacheStorage.keys()) await cacheStorage.delete(k);
}
