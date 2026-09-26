const CHUNK = 200;

export async function flushOutbox({ api, store }) {
  const items = await store.all("outbox");
  for (let i = 0; i < items.length; i += CHUNK) {
    const batch = items.slice(i, i + CHUNK);
    await api.postNotes(batch);
    for (const it of batch) await store.del("outbox", it.id);
  }
  return items.length;
}

export async function pullNotes({ api, store }) {
  const remote = await api.getNotes();
  const have = new Set((await store.all("notes")).map((n) => n.id));
  let added = false;
  for (const n of remote) {
    if (!have.has(n.id)) {
      await store.put("notes", n);
      added = true;
    }
  }
  return added;
}

export async function pullItinerary({ api, store }) {
  const record = await api.getItinerary();
  await store.put("kv", new Date().toISOString(), "syncedAt");
  if (!record) return { changed: false, record: null };
  const prev = await store.get("kv", "itinerary");
  await store.put("kv", record, "itinerary");
  return { changed: prev?.version !== record.version, record };
}

// navigator.onLine lies on captive portals, so a failed request also counts
// as offline until the next request succeeds.
export function createConnectivity(win = globalThis) {
  let failed = false;
  const subs = new Set();
  const state = () => win.navigator.onLine !== false && !failed;
  let last = state();
  const emit = () => {
    const s = state();
    if (s === last) return;
    last = s;
    subs.forEach((f) => f(s));
  };
  win.addEventListener?.("online", emit);
  win.addEventListener?.("offline", emit);
  return {
    get online() {
      return state();
    },
    markFailure() {
      failed = true;
      emit();
    },
    markSuccess() {
      failed = false;
      emit();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
