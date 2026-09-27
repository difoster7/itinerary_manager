// Module service worker. The Worker replaces __APP_VERSION__ with the
// deployment id, so every deploy changes this file and triggers an update.
import { createApi } from "./js/api.js";
import { all, del, get, put } from "./js/store.js";
import { flushOutbox } from "./js/sync.js";

const APP_VERSION = "__APP_VERSION__";
const CACHE = `shell-${APP_VERSION}`;
const SHELL = [
  "/",
  "/styles.css",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/js/api.js",
  "/js/app.js",
  "/js/config.js",
  "/js/crypto.js",
  "/js/edit.js",
  "/js/export.js",
  "/js/extract.js",
  "/js/ics.js",
  "/js/importer.js",
  "/js/model.js",
  "/js/render.js",
  "/js/session.js",
  "/js/store.js",
  "/js/sync.js",
  "/js/ui.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))),
      ),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) {
        if (k !== CACHE) await caches.delete(k);
      }
      // Only matters on first install; updates wait for all tabs to close.
      await self.clients.claim();
    })(),
  );
});

// Cache-first app shell. API calls are never cached here: the app keeps the
// encrypted itinerary in IndexedDB instead.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.pathname === "/share") {
    e.respondWith(stashShare(e.request));
    return;
  }
  if (
    e.request.method !== "GET" ||
    url.origin !== location.origin ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }
  // Workers assets redirect /index.html to /, so "/" is the cached page.
  const key = e.request.mode === "navigate" ? "/" : url.pathname;
  e.respondWith(
    caches
      .match(key, { cacheName: CACHE })
      .then((hit) => hit || fetch(e.request)),
  );
});

// Android share target: keep the shared text/file for the app to import.
async function stashShare(request) {
  const form = await request.formData();
  const file = form.get("file");
  await put(
    "kv",
    {
      title: form.get("title") || "",
      text: form.get("text") || "",
      file: file instanceof File && file.size ? file : null,
      at: new Date().toISOString(),
    },
    "share",
  );
  return Response.redirect("/?shared=1", 303);
}

// Background Sync: upload queued notes when connectivity returns, even with
// the app closed. The outbox is ciphertext, so only the token is needed.
self.addEventListener("sync", (e) => {
  if (e.tag !== "outbox") return;
  e.waitUntil(
    (async () => {
      const keys = await get("kv", "keys");
      if (keys) {
        await flushOutbox({ api: createApi(keys.token), store: { all, del } });
      }
    })(),
  );
});

self.addEventListener("message", (e) => {
  if (e.data?.type === "version") {
    e.ports[0]?.postMessage({ type: "version", version: APP_VERSION });
  }
});
