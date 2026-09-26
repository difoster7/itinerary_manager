import { describe, it, expect, vi } from "vitest";
import {
  flushOutbox,
  pullNotes,
  pullItinerary,
  createConnectivity,
} from "../../public/js/sync.js";

function fakeStore() {
  const s = { kv: new Map(), notes: new Map(), outbox: new Map() };
  return {
    s,
    get: async (st, k) => s[st].get(k),
    put: async (st, v, k) => void s[st].set(k ?? v.id, v),
    all: async (st) => [...s[st].values()],
    del: async (st, k) => void s[st].delete(k),
  };
}
const n = (i) => ({
  id: `id${i}`,
  blob: `b${i}`,
  createdAt: `2026-11-18T10:00:0${i}Z`,
});

describe("flushOutbox", () => {
  it("posts queued notes and clears them", async () => {
    const store = fakeStore();
    await store.put("outbox", n(1));
    await store.put("outbox", n(2));
    const api = { postNotes: vi.fn(async () => {}) };
    expect(await flushOutbox({ api, store })).toBe(2);
    expect(api.postNotes).toHaveBeenCalledWith([n(1), n(2)]);
    expect(store.s.outbox.size).toBe(0);
  });
  it("keeps the outbox when the post fails", async () => {
    const store = fakeStore();
    await store.put("outbox", n(1));
    const api = {
      postNotes: async () => {
        throw new TypeError("offline");
      },
    };
    await expect(flushOutbox({ api, store })).rejects.toThrow("offline");
    expect(store.s.outbox.size).toBe(1);
  });
  it("does nothing when empty", async () => {
    const api = { postNotes: vi.fn() };
    expect(await flushOutbox({ api, store: fakeStore() })).toBe(0);
    expect(api.postNotes).not.toHaveBeenCalled();
  });
  it("chunks at 200", async () => {
    const store = fakeStore();
    for (let i = 0; i < 450; i++) {
      await store.put("outbox", { ...n(0), id: `x${i}` });
    }
    const api = { postNotes: vi.fn(async () => {}) };
    await flushOutbox({ api, store });
    const sizes = api.postNotes.mock.calls.map((c) => c[0].length);
    expect(sizes).toEqual([200, 200, 50]);
  });
});

describe("pulls", () => {
  it("pullNotes stores server notes and reports new ones", async () => {
    const store = fakeStore();
    await store.put("notes", n(1));
    const api = { getNotes: async () => [n(1), n(2)] };
    expect(await pullNotes({ api, store })).toBe(true);
    expect(store.s.notes.size).toBe(2);
    expect(await pullNotes({ api, store })).toBe(false);
  });
  it("pullItinerary detects version changes", async () => {
    const store = fakeStore();
    const rec = { version: 3, blob: "b", updatedAt: "t" };
    const api = { getItinerary: async () => rec };
    expect(await pullItinerary({ api, store })).toEqual({
      changed: true,
      record: rec,
    });
    expect(await pullItinerary({ api, store })).toEqual({
      changed: false,
      record: rec,
    });
    expect(store.s.kv.get("itinerary")).toEqual(rec);
    expect(typeof store.s.kv.get("syncedAt")).toBe("string");
  });
  it("pullItinerary handles an empty server", async () => {
    const api = { getItinerary: async () => null };
    expect(await pullItinerary({ api, store: fakeStore() })).toEqual({
      changed: false,
      record: null,
    });
  });
});

describe("connectivity", () => {
  it("combines navigator.onLine with request failures", () => {
    const listeners = {};
    const win = {
      navigator: { onLine: true },
      addEventListener: (t, f) => (listeners[t] = f),
    };
    const c = createConnectivity(win);
    const seen = [];
    c.subscribe((on) => seen.push(on));
    expect(c.online).toBe(true);
    c.markFailure();
    expect(c.online).toBe(false);
    c.markSuccess();
    expect(c.online).toBe(true);
    win.navigator.onLine = false;
    listeners.offline();
    expect(c.online).toBe(false);
    expect(seen).toEqual([false, true, false]);
  });
});
