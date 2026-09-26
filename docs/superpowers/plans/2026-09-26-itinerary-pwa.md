# Trip Itinerary PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An installable, offline-first, end-to-end-encrypted itinerary PWA on Cloudflare Workers + D1, replacing the single-file `Itinerary.html`.

**Architecture:** One Worker serves static assets from `public/` and a small authenticated JSON API backed by D1. All itinerary data and notes are encrypted in the browser (Web Crypto). The server stores only ciphertext and a hash of the access token. The client is vanilla ES modules with no build step. Pure logic lives in small modules that are unit-tested in Node; DOM wiring is thin and verified manually in Chrome.

**Tech Stack:** Cloudflare Workers (static assets, D1, version metadata), Wrangler 4.141.0, Vitest ~4.1.11, @cloudflare/vitest-pool-workers 0.22.0, Node 24, vanilla JS, Web Crypto, IndexedDB, Service Worker, Background Sync.

**Spec:** `docs/superpowers/specs/2026-09-26-itinerary-pwa-design.md`

## Global Constraints

- Only ciphertext leaves the device. Never log request/response bodies or decrypted content (Worker or client `console`).
- Plaintext seed data is never committed. `.gitignore` already covers `Itinerary.html`, `itinerary-app-brief.md`, `seed/`, `.wrangler/`, `.dev.vars`, `node_modules/`, `.superpowers/`.
- Every `/api/*` endpoint requires `Authorization: Bearer <token>` and returns 401 otherwise.
- KDF: PBKDF2-SHA256, 600,000 iterations, 16-byte salt from `public/js/config.js`. HKDF-SHA256 info labels `enc-v1` (AES-GCM-256, non-extractable) and `auth-v1` (32-byte token).
- Blob format: `{"v":1,"iv":"<b64 12 bytes>","ct":"<b64>"}`. The IV is fresh and random for every encryption.
- History is kept to the newest 50 versions.
- Event kinds: `flight | bus | transfer | stay | trek | activity | food | show | note`. Required event fields: `id, date, kind, title`. There is no `todo` field and no `OPEN_ITEMS`.
- All user text is rendered via `esc()`; no user-controlled HTML.
- No frontend build step, no frameworks, no runtime dependencies. Dev dependencies only: wrangler, vitest, @cloudflare/vitest-pool-workers.
- Layout: no horizontal scroll at 390 px; light/dark via `prefers-color-scheme`; system fonts; no external resources.
- No `alert`/`confirm`/`prompt`; use `<dialog>` elements.

## Review Focus

1. **Trailing space or different Unicode form in the passphrase** (phone keyboards add a trailing space after autocomplete): the expected behavior is that it still unlocks. `deriveKeys` must trim and NFKC-normalize. Test in Task 3.
2. **An overnight event whose `end` is earlier than `time`** (e.g. bus 22:00 → 06:00): it must not appear as ended, and the `.ics` end must fall on the next day. Tests in Tasks 4 and 5.
3. **Two saves racing with the same `If-Match`**: exactly one wins and the other gets 409, never a 500. Test in Task 1.
4. **Deleting a note that has not yet synced** (both the note and its delete are in the outbox): it disappears locally and both upload fine. Test in Task 6.
5. **Opening the app on a date inside the trip range that has no events or nights**: it opens on the nearest following trip day, not a blank screen. Test in Task 4.

---

## File map

| File | Responsibility |
|---|---|
| `package.json`, `wrangler.jsonc`, `vitest.config.mjs`, `vitest.worker.config.mjs` | tooling |
| `migrations/0001_init.sql` | D1 schema |
| `src/worker.js` | API routes, auth, `/sw.js` version stamping |
| `public/js/config.js` | `SALT`, `PBKDF2_ITERATIONS` |
| `public/js/crypto.js` | key derivation, encrypt/decrypt, token hash, base64 |
| `public/js/model.js` | pure data logic: validation, ordering, timeline state, changes/conflicts, notes folding, stats, `esc` |
| `public/js/ics.js` | single-event `.ics` |
| `public/js/api.js` | fetch wrapper around the API |
| `public/js/store.js` | IndexedDB key-value + notes + outbox |
| `public/js/sync.js` | pull/push orchestration, connectivity state |
| `public/js/render.js` | HTML-string renderers (day, codes, notes tab, day list, overview, snapshot body) |
| `public/js/export.js` | standalone snapshot document, print |
| `public/js/edit.js` | sheets: event, night, note, raw JSON; save + 409 flow |
| `public/js/app.js` | boot, lock/import screens, tabs, swipe, keyboard, toasts, banner |
| `public/index.html`, `public/styles.css`, `public/sw.js`, `public/manifest.webmanifest`, `public/icons/*` | shell |
| `tools/write-token-hash.mjs`, `tools/extract-seed.mjs`, `tools/make-icons.mjs` | local tools |
| `test/worker/*.test.js` | Worker integration tests (Workers runtime) |
| `test/client/*.test.js`, `test/fixtures/sample-itinerary.html` | Node unit tests |
| `README.md` | setup, deploy, seed, install, rotation, tests, acceptance checklist |

Deviation from the spec's file list: `model.js`, `ics.js` and `sync.js` were added so that the pure logic is testable without a DOM. `notes.js` is folded into `model.js` (folding) and `sync.js` (outbox).

---

### Task 0: Scaffold, tooling and smoke test

**Files:**
- Create: `package.json`, `wrangler.jsonc`, `vitest.config.mjs`, `vitest.worker.config.mjs`, `migrations/0001_init.sql`, `src/worker.js`, `public/index.html`, `test/worker/apply-migrations.js`, `test/worker/smoke.test.js`

**Interfaces:**
- Produces: the Worker default export `{ fetch(request, env) }`; the bindings `env.DB` (D1), `env.ASSETS`, `env.TOKEN_HASH` (hex string), `env.CF_VERSION_METADATA` (`{id}`); the test token `TEST_TOKEN = base64(32 bytes of 0x01)`, whose hash is injected as `TOKEN_HASH` in the worker test config.

- [ ] **Step 1: package.json**

```json
{
  "name": "itinerary-manager",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "npm run test:client && npm run test:worker",
    "test:client": "vitest run -c vitest.config.mjs",
    "test:worker": "vitest run -c vitest.worker.config.mjs"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "0.22.0",
    "vitest": "~4.1.11",
    "wrangler": "4.141.0"
  }
}
```

Run: `npm install`

- [ ] **Step 2: wrangler.jsonc**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "itinerary",
  "main": "src/worker.js",
  "compatibility_date": "2026-08-15",
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "run_worker_first": ["/api/*", "/sw.js"]
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "itinerary",
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "migrations"
    }
  ],
  "version_metadata": { "binding": "CF_VERSION_METADATA" }
}
```

(The README tells the user to replace `database_id` with the output of `wrangler d1 create itinerary`.)

- [ ] **Step 3: migration**

`migrations/0001_init.sql`:
```sql
CREATE TABLE versions (
  version    INTEGER PRIMARY KEY,
  blob       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE notes (
  id         TEXT PRIMARY KEY,
  blob       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

- [ ] **Step 4: Vitest configs**

`vitest.config.mjs`:
```js
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["test/client/**/*.test.js"], environment: "node" },
});
```

`vitest.worker.config.mjs`:
```js
import { createHash } from "node:crypto";
import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";

const TOKEN_HASH = createHash("sha256")
  .update(Buffer.alloc(32, 1))
  .digest("hex");

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TOKEN_HASH, TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ["test/worker/**/*.test.js"],
      setupFiles: ["./test/worker/apply-migrations.js"],
    },
  };
});
```

`test/worker/apply-migrations.js`:
```js
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

- [ ] **Step 5: failing smoke test**

`test/worker/smoke.test.js`:
```js
import { exports } from "cloudflare:workers";
import { it, expect } from "vitest";

it("unknown API path without a token returns 401 JSON", async () => {
  const res = await exports.default.fetch("http://x/api/nope");
  expect(res.status).toBe(401);
  expect(res.headers.get("content-type")).toMatch(/json/);
});
```

Run: `npm run test:worker`. Expected: FAIL (`src/worker.js` missing).

- [ ] **Step 6: minimal worker + index.html**

`src/worker.js`:
```js
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

export default {
  async fetch(request, env) {
    return json({ error: "unauthorized" }, 401);
  },
};
```

`public/index.html`: a minimal `<!doctype html>` page titled "Itinerary". It is replaced in Task 8.

- [ ] **Step 7: run and verify it passes.** Run: `npm run test:worker`. Expected: PASS. If the pool rejects `exports` from `cloudflare:workers`, fall back to `SELF` from `cloudflare:test` (deprecated but present) and note it.

- [ ] **Step 8: commit.** `git add -A && git commit -m "Scaffold Worker, D1 migration and test tooling"`

---

### Task 1: Auth + itinerary GET/PUT with compare-and-swap

**Files:**
- Modify: `src/worker.js`
- Test: `test/worker/itinerary.test.js`

**Interfaces:**
- Produces: `GET /api/itinerary` → 200 `{version, blob, updatedAt}` | 404; `PUT /api/itinerary` (header `If-Match: <int>`, body `{blob}`) → 200 `{version, updatedAt}` | 400 | 409 `{version}`.

- [ ] **Step 1: failing tests**

`test/worker/itinerary.test.js`:
```js
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, it, expect } from "vitest";

const TOKEN = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const BAD = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const blob = (n) => JSON.stringify({ v: 1, iv: "aXZpdml2aXZpdml2", ct: `Y3Q${n}` });

const call = (method, path, { token = TOKEN, ifMatch, body } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (ifMatch !== undefined) headers["if-match"] = String(ifMatch);
  if (body !== undefined) headers["content-type"] = "application/json";
  return exports.default.fetch(`http://x${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
};

beforeEach(async () => {
  await env.DB.exec("DELETE FROM versions; DELETE FROM notes;");
});

describe("auth", () => {
  it("rejects missing token", async () => {
    expect((await call("GET", "/api/itinerary", { token: null })).status).toBe(401);
  });
  it("rejects wrong token", async () => {
    expect((await call("GET", "/api/itinerary", { token: BAD })).status).toBe(401);
  });
  it("rejects malformed token", async () => {
    expect((await call("GET", "/api/itinerary", { token: "!!!" })).status).toBe(401);
  });
  it("wrong-token PUT leaves D1 unchanged", async () => {
    const res = await call("PUT", "/api/itinerary", { token: BAD, ifMatch: 0, body: { blob: blob(1) } });
    expect(res.status).toBe(401);
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM versions").first();
    expect(n).toBe(0);
  });
});

describe("itinerary", () => {
  it("404 when empty", async () => {
    expect((await call("GET", "/api/itinerary")).status).toBe(404);
  });

  it("first PUT with If-Match 0 creates version 1 and GET returns it", async () => {
    const put = await call("PUT", "/api/itinerary", { ifMatch: 0, body: { blob: blob(1) } });
    expect(put.status).toBe(200);
    expect((await put.json()).version).toBe(1);
    const got = await (await call("GET", "/api/itinerary")).json();
    expect(got.version).toBe(1);
    expect(got.blob).toBe(blob(1));
    expect(typeof got.updatedAt).toBe("string");
  });

  it("stale If-Match returns 409 with current version, D1 unchanged", async () => {
    await call("PUT", "/api/itinerary", { ifMatch: 0, body: { blob: blob(1) } });
    await call("PUT", "/api/itinerary", { ifMatch: 1, body: { blob: blob(2) } });
    const res = await call("PUT", "/api/itinerary", { ifMatch: 1, body: { blob: blob(3) } });
    expect(res.status).toBe(409);
    expect((await res.json()).version).toBe(2);
    const got = await (await call("GET", "/api/itinerary")).json();
    expect(got.blob).toBe(blob(2));
  });

  it("concurrent saves with the same If-Match: one 200, one 409", async () => {
    const [a, b] = await Promise.all([
      call("PUT", "/api/itinerary", { ifMatch: 0, body: { blob: blob("a") } }),
      call("PUT", "/api/itinerary", { ifMatch: 0, body: { blob: blob("b") } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it("prunes history to the newest 50", async () => {
    for (let v = 0; v < 55; v++) {
      const r = await call("PUT", "/api/itinerary", { ifMatch: v, body: { blob: blob(v) } });
      expect(r.status).toBe(200);
    }
    const { n, lo } = await env.DB
      .prepare("SELECT COUNT(*) AS n, MIN(version) AS lo FROM versions").first();
    expect(n).toBe(50);
    expect(lo).toBe(6);
  });

  it.each([
    ["missing If-Match", undefined, { blob: blob(1) }],
    ["non-integer If-Match", "abc", { blob: blob(1) }],
    ["negative If-Match", -1, { blob: blob(1) }],
    ["blob not a string", 0, { blob: 5 }],
    ["blob not encrypted JSON", 0, { blob: "hello" }],
    ["blob wrong shape", 0, { blob: JSON.stringify({ v: 2, iv: "a", ct: "b" }) }],
  ])("400 for %s", async (_, ifMatch, body) => {
    expect((await call("PUT", "/api/itinerary", { ifMatch, body })).status).toBe(400);
  });

  it("400 for non-JSON body", async () => {
    const res = await exports.default.fetch("http://x/api/itinerary", {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "if-match": "0" },
      body: "{nope",
    });
    expect(res.status).toBe(400);
  });

  it("405 for other methods", async () => {
    expect((await call("DELETE", "/api/itinerary")).status).toBe(405);
  });
});
```

- [ ] **Step 2: run.** `npm run test:worker`. Expected: FAIL.

- [ ] **Step 3: implement**

`src/worker.js`, replacing the whole file:
```js
const HISTORY_KEEP = 50;
const MAX_BLOB = 1_000_000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const fromHex = (h) =>
  /^[0-9a-f]{64}$/i.test(h)
    ? Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16))
    : null;

async function authorized(request, env) {
  const m = /^Bearer ([A-Za-z0-9+/]{43}=)$/.exec(
    request.headers.get("authorization") || "",
  );
  const want = fromHex(env.TOKEN_HASH || "");
  if (!m || !want) return false;
  const got = new Uint8Array(
    await crypto.subtle.digest("SHA-256", fromB64(m[1])),
  );
  return crypto.subtle.timingSafeEqual(got, want);
}

function isBlob(s) {
  if (typeof s !== "string" || s.length > MAX_BLOB) return false;
  try {
    const b = JSON.parse(s);
    return b.v === 1 && typeof b.iv === "string" && typeof b.ct === "string";
  } catch {
    return false;
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

async function currentVersion(db) {
  const row = await db
    .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM versions")
    .first();
  return row.v;
}

async function getItinerary(env) {
  const row = await env.DB.prepare(
    "SELECT version, blob, updated_at FROM versions ORDER BY version DESC LIMIT 1",
  ).first();
  if (!row) return json({ error: "empty" }, 404);
  return json({ version: row.version, blob: row.blob, updatedAt: row.updated_at });
}

async function putItinerary(request, env) {
  const raw = (request.headers.get("if-match") || "").replace(/"/g, "");
  if (!/^\d+$/.test(raw)) return json({ error: "if-match" }, 400);
  const expected = Number(raw);
  const body = await readJson(request);
  if (!body || !isBlob(body.blob)) return json({ error: "blob" }, 400);
  const next = expected + 1;
  const now = new Date().toISOString();
  let changes = 0;
  try {
    const res = await env.DB.prepare(
      `INSERT INTO versions (version, blob, updated_at)
       SELECT ?1, ?2, ?3
       WHERE (SELECT COALESCE(MAX(version), 0) FROM versions) = ?4`,
    )
      .bind(next, body.blob, now, expected)
      .run();
    changes = res.meta.changes;
  } catch (err) {
    if (!/UNIQUE|constraint/i.test(String(err))) throw err;
  }
  if (changes !== 1) {
    return json({ version: await currentVersion(env.DB) }, 409);
  }
  await env.DB.prepare("DELETE FROM versions WHERE version <= ?")
    .bind(next - HISTORY_KEEP)
    .run();
  return json({ version: next, updatedAt: now });
}

async function api(request, env, path) {
  const m = request.method;
  if (path === "/api/itinerary") {
    if (m === "GET") return getItinerary(env);
    if (m === "PUT") return putItinerary(request, env);
    return json({ error: "method" }, 405);
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
      if (!(await authorized(request, env))) {
        return json({ error: "unauthorized" }, 401);
      }
      return api(request, env, path);
    }
    return env.ASSETS.fetch(request);
  },
};
```

The smoke test from Task 0 still passes (401 before routing).

- [ ] **Step 4: run.** `npm run test:worker`. Expected: all PASS.

- [ ] **Step 5: commit.** `git commit -am "Worker: token auth and itinerary compare-and-swap"` (add the new test file first).

---

### Task 2: History, notes endpoints, `/sw.js` stamping

**Files:**
- Modify: `src/worker.js`
- Test: `test/worker/history-notes.test.js`

**Interfaces:**
- Produces: `GET /api/history` → `[{version, updatedAt}]` newest first; `GET /api/history/:v` → `{version, blob, updatedAt}` | 404; `GET /api/notes` → `[{id, blob, createdAt}]` ordered by `created_at, id`; `POST /api/notes` body `[{id, blob, createdAt}]` (1–200 items) → `{ok:true}` | 400; `GET /sw.js` → the asset text with `__APP_VERSION__` replaced by `env.CF_VERSION_METADATA?.id || "dev"`.

- [ ] **Step 1: failing tests**

`test/worker/history-notes.test.js`:
```js
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, it, expect } from "vitest";

const TOKEN = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const blob = (n) => JSON.stringify({ v: 1, iv: "aXZpdml2aXZpdml2", ct: `Y3Q${n}` });
const call = (method, path, body, ifMatch) =>
  exports.default.fetch(`http://x${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(ifMatch !== undefined ? { "if-match": String(ifMatch) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const note = (i, b = blob(`n${i}`)) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  blob: b,
  createdAt: `2026-11-18T10:00:0${i}.000Z`,
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM versions; DELETE FROM notes;");
});

describe("history", () => {
  it("lists versions newest first and fetches one", async () => {
    await call("PUT", "/api/itinerary", { blob: blob(1) }, 0);
    await call("PUT", "/api/itinerary", { blob: blob(2) }, 1);
    const list = await (await call("GET", "/api/history")).json();
    expect(list.map((r) => r.version)).toEqual([2, 1]);
    const one = await (await call("GET", "/api/history/1")).json();
    expect(one.blob).toBe(blob(1));
  });
  it("404 for unknown or invalid version", async () => {
    expect((await call("GET", "/api/history/9")).status).toBe(404);
    expect((await call("GET", "/api/history/abc")).status).toBe(404);
  });
});

describe("notes", () => {
  it("POST then GET returns notes; re-POST is idempotent", async () => {
    const batch = [note(1), note(2)];
    expect((await call("POST", "/api/notes", batch)).status).toBe(200);
    expect((await call("POST", "/api/notes", batch)).status).toBe(200);
    const got = await (await call("GET", "/api/notes")).json();
    expect(got.map((n) => n.id)).toEqual(batch.map((n) => n.id));
  });
  it("re-POST with a different blob does not overwrite", async () => {
    await call("POST", "/api/notes", [note(1)]);
    await call("POST", "/api/notes", [note(1, blob("other"))]);
    const [got] = await (await call("GET", "/api/notes")).json();
    expect(got.blob).toBe(blob("n1"));
  });
  it.each([
    ["not an array", { id: "x" }],
    ["empty array", []],
    ["bad id", [{ ...note(1), id: "nope" }]],
    ["bad blob", [{ ...note(1), blob: "plain text" }]],
    ["bad createdAt", [{ ...note(1), createdAt: 5 }]],
    ["too many", Array.from({ length: 201 }, (_, i) => note(i))],
  ])("400 for %s", async (_, body) => {
    expect((await call("POST", "/api/notes", body)).status).toBe(400);
  });
});

it("/sw.js is served with the version placeholder replaced", async () => {
  const res = await exports.default.fetch("http://x/sw.js");
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain("__APP_VERSION__");
  expect(res.headers.get("content-type")).toMatch(/javascript/);
});
```

A stub `public/sw.js` containing `const APP_VERSION = "__APP_VERSION__";` is created in this task. Task 11 fills it in.

- [ ] **Step 2: run.** Expected: FAIL.

- [ ] **Step 3: implement.** Add to `src/worker.js`:

```js
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTES_BATCH = 200;

async function history(env) {
  const { results } = await env.DB.prepare(
    "SELECT version, updated_at FROM versions ORDER BY version DESC",
  ).all();
  return json(results.map((r) => ({ version: r.version, updatedAt: r.updated_at })));
}

async function historyVersion(env, v) {
  if (!/^\d+$/.test(v)) return json({ error: "not found" }, 404);
  const row = await env.DB.prepare(
    "SELECT version, blob, updated_at FROM versions WHERE version = ?",
  ).bind(Number(v)).first();
  if (!row) return json({ error: "not found" }, 404);
  return json({ version: row.version, blob: row.blob, updatedAt: row.updated_at });
}

async function getNotes(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, blob, created_at FROM notes ORDER BY created_at, id",
  ).all();
  return json(results.map((r) => ({ id: r.id, blob: r.blob, createdAt: r.created_at })));
}

async function postNotes(request, env) {
  const body = await readJson(request);
  const ok =
    Array.isArray(body) &&
    body.length > 0 &&
    body.length <= MAX_NOTES_BATCH &&
    body.every(
      (n) => n && UUID.test(n.id) && isBlob(n.blob) &&
        typeof n.createdAt === "string" && n.createdAt.length <= 40,
    );
  if (!ok) return json({ error: "notes" }, 400);
  const stmt = env.DB.prepare(
    "INSERT OR IGNORE INTO notes (id, blob, created_at) VALUES (?, ?, ?)",
  );
  await env.DB.batch(body.map((n) => stmt.bind(n.id, n.blob, n.createdAt)));
  return json({ ok: true });
}

async function serviceWorker(request, env) {
  const res = await env.ASSETS.fetch(request);
  const text = (await res.text()).replace(
    "__APP_VERSION__",
    env.CF_VERSION_METADATA?.id || "dev",
  );
  return new Response(text, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}
```

Routing additions in `api()`:
```js
  if (path === "/api/history" && m === "GET") return history(env);
  const hv = /^\/api\/history\/([^/]+)$/.exec(path);
  if (hv && m === "GET") return historyVersion(env, hv[1]);
  if (path === "/api/notes") {
    if (m === "GET") return getNotes(env);
    if (m === "POST") return postNotes(request, env);
    return json({ error: "method" }, 405);
  }
```

In `fetch`, before the `/api/` check: `if (path === "/sw.js") return serviceWorker(request, env);`

- [ ] **Step 4: run.** Expected: PASS. If `env.ASSETS` is unavailable in the test pool, change the `/sw.js` test to assert that the handler replaces the placeholder via a stubbed `ASSETS` in `miniflare.serviceBindings`, and record the limitation.

- [ ] **Step 5: commit.**

---

### Task 3: crypto.js, config.js, write-token-hash tool

**Files:**
- Create: `public/js/config.js`, `public/js/crypto.js`, `tools/write-token-hash.mjs`
- Test: `test/client/crypto.test.js`

**Interfaces:**
- Produces:
  - `config.js`: `export const SALT: string (b64, 16 bytes)`, `export const PBKDF2_ITERATIONS = 600000`.
  - `crypto.js`:
    - `toB64(bytes: Uint8Array): string`, `fromB64(s: string): Uint8Array`
    - `deriveKeys(passphrase: string, saltB64: string, iterations = PBKDF2_ITERATIONS): Promise<{encKey: CryptoKey, token: string}>`
    - `encryptJson(key: CryptoKey, value: any): Promise<string>`, which returns the blob string
    - `decryptJson(key: CryptoKey, blob: string): Promise<any>`, which throws on a wrong key or tampering
    - `tokenHash(token: string): Promise<string>`, which returns hex SHA-256 of the decoded token bytes

- [ ] **Step 1: failing tests**

`test/client/crypto.test.js`:
```js
import { describe, it, expect } from "vitest";
import {
  deriveKeys, encryptJson, decryptJson, tokenHash, toB64, fromB64,
} from "../../public/js/crypto.js";
import { SALT, PBKDF2_ITERATIONS } from "../../public/js/config.js";

const salt = toB64(new Uint8Array(16).fill(7));
const FAST = 1000; // iterations for speed in tests

describe("crypto", () => {
  it("config has a 16-byte salt and 600k iterations", () => {
    expect(fromB64(SALT)).toHaveLength(16);
    expect(PBKDF2_ITERATIONS).toBe(600000);
  });

  it("base64 round-trips arbitrary bytes, including large arrays", () => {
    const bytes = new Uint8Array(300000).map((_, i) => i % 256);
    expect(fromB64(toB64(bytes))).toEqual(bytes);
  });

  it("token derivation is deterministic and 32 bytes", async () => {
    const a = await deriveKeys("correct horse battery staple", salt, FAST);
    const b = await deriveKeys("correct horse battery staple", salt, FAST);
    expect(a.token).toBe(b.token);
    expect(fromB64(a.token)).toHaveLength(32);
  });

  it("trims and NFKC-normalizes the passphrase", async () => {
    const a = await deriveKeys("café tango", salt, FAST);
    const b = await deriveKeys(" cafe\u0301 tango ", salt, FAST);
    expect(b.token).toBe(a.token);
  });

  it("different passphrase or salt gives a different token", async () => {
    const a = await deriveKeys("one two three", salt, FAST);
    const b = await deriveKeys("one two four", salt, FAST);
    const c = await deriveKeys("one two three", toB64(new Uint8Array(16)), FAST);
    expect(new Set([a.token, b.token, c.token]).size).toBe(3);
  });

  it("encKey is not extractable", async () => {
    const { encKey } = await deriveKeys("x y z", salt, FAST);
    expect(encKey.extractable).toBe(false);
  });

  it("encrypt/decrypt round trip with fresh IVs", async () => {
    const { encKey } = await deriveKeys("x y z", salt, FAST);
    const value = { a: 1, s: "ñandú" };
    const b1 = await encryptJson(encKey, value);
    const b2 = await encryptJson(encKey, value);
    const p1 = JSON.parse(b1);
    expect(p1.v).toBe(1);
    expect(fromB64(p1.iv)).toHaveLength(12);
    expect(p1.iv).not.toBe(JSON.parse(b2).iv);
    expect(b1).not.toContain("ñandú");
    expect(await decryptJson(encKey, b1)).toEqual(value);
  });

  it("decrypt with the wrong key throws", async () => {
    const { encKey } = await deriveKeys("x y z", salt, FAST);
    const { encKey: other } = await deriveKeys("x y q", salt, FAST);
    const blob = await encryptJson(encKey, { a: 1 });
    await expect(decryptJson(other, blob)).rejects.toThrow();
  });

  it("tokenHash matches SHA-256 of the raw token bytes", async () => {
    const token = toB64(new Uint8Array(32).fill(1));
    expect(await tokenHash(token)).toBe(
      "72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793",
    );
  });
});
```

(Verified: this is `sha256(32 × 0x01)`.)

- [ ] **Step 2: run.** `npm run test:client`. Expected: FAIL.

- [ ] **Step 3: implement**

`public/js/config.js` (generate the salt with `node -e "console.log(require('crypto').randomBytes(16).toString('base64'))"`):
```js
// Public by design: the device needs it before it can authenticate.
export const SALT = "<generated>";
export const PBKDF2_ITERATIONS = 600000;
```

`public/js/crypto.js`:
```js
import { PBKDF2_ITERATIONS } from "./config.js";

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = globalThis.crypto.subtle;

export function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const hkdf = (info) => ({
  name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode(info),
});

export async function deriveKeys(passphrase, saltB64, iterations = PBKDF2_ITERATIONS) {
  const pw = te.encode(passphrase.normalize("NFKC").trim());
  const base = await subtle.importKey("raw", pw, "PBKDF2", false, ["deriveBits"]);
  const master = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromB64(saltB64), iterations },
    base, 256,
  );
  const hk = await subtle.importKey("raw", master, "HKDF", false, ["deriveKey", "deriveBits"]);
  const encKey = await subtle.deriveKey(
    hkdf("enc-v1"), hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
  const token = toB64(new Uint8Array(await subtle.deriveBits(hkdf("auth-v1"), hk, 256)));
  return { encKey, token };
}

export async function encryptJson(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(value)));
  return JSON.stringify({ v: 1, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) });
}

export async function decryptJson(key, blob) {
  const { v, iv, ct } = JSON.parse(blob);
  if (v !== 1) throw new Error(`Unsupported blob version ${v}`);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, key, fromB64(ct));
  return JSON.parse(td.decode(pt));
}

export async function tokenHash(token) {
  const d = new Uint8Array(await subtle.digest("SHA-256", fromB64(token)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

`tools/write-token-hash.mjs`:
```js
// Usage: node tools/write-token-hash.mjs          -> prompts, prints TOKEN_HASH
//        node tools/write-token-hash.mjs --new-salt -> prints a fresh salt
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { deriveKeys, tokenHash } from "../public/js/crypto.js";
import { SALT } from "../public/js/config.js";

if (process.argv.includes("--new-salt")) {
  console.log(randomBytes(16).toString("base64"));
  process.exit(0);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const pass = await rl.question("Passphrase (visible; clear your terminal after): ");
rl.close();
const { token } = await deriveKeys(pass, SALT);
console.log("\nTOKEN_HASH =", await tokenHash(token));
console.log("Run: npx wrangler secret put TOKEN_HASH   (paste the value)");
```

- [ ] **Step 4: run.** `npm run test:client`. Expected: PASS.
- [ ] **Step 5: commit.**

---

### Task 4: model.js (pure data logic)

**Files:**
- Create: `public/js/model.js`
- Test: `test/client/model.test.js`

**Interfaces:**
- Produces:
  - `KINDS: string[]`; `KIND_LABEL: Record<kind,string>` (`note` → `""`, `stay` → `"Lodging"`, `show` → `"Event"`)
  - `esc(s): string`, which escapes `& < > " '`
  - `validateItinerary(data): string[]`, which returns error messages (empty means valid)
  - `ensureIds(data): data`, which is a copy with every event given an `id` if it lacks one
  - `tripDates(data): string[]`, sorted and unique, from `nights` keys and event dates
  - `openingDate(dates, todayISO): string|null`: today if listed; the first date if before the trip; the last if after; otherwise the nearest following date
  - `dayEvents(data, iso): Event[]`: all-day items first (by title), then by `time`
  - `endsAfterMidnight(ev): boolean`, true when `end && time && end <= time`
  - `timelineState(events, nowHHMM): Record<id, "past"|"now"|"next">` (for today only)
  - `countdown(fromHHMM, toHHMM): string`, e.g. `"IN 20 MIN"`, `"IN 3 H"`, `"IN 1 H 10 MIN"`
  - `applyChange(data, change): data`, where `change` is one of:
    - `{type:"upsert", event}`
    - `{type:"delete", id}`
    - `{type:"night", date, night: {name, sub}|null}`
    - `{type:"field", key: "cities"|"costs", value}`
    - `{type:"replace", data}`
  - `changeTarget(data, change): any`, the current value the change touches
  - `resolveConflict(base, latest, change): {conflict: boolean, merged: data|null}`. A `replace` always conflicts. Otherwise it's a conflict when `JSON.stringify(changeTarget(base))` differs from `JSON.stringify(changeTarget(latest))`; if there's no conflict, `merged = applyChange(latest, change)`.
  - `foldNotes(records): Note[]`. The input `records` is `{id, createdAt, queued?, date?, text?, del?}[]`. It returns the non-deleted notes (those with `text`), sorted by `createdAt` then `id`.
  - `tripStats(data): {nights: number, byKind: Record<kind, number>}`
  - `confRows(data): Event[]`, events with `conf`, sorted by date+time, de-duplicated by `conf+title`
  - `summarize(data): string`, e.g. `"38 events · 16 nights"`

- [ ] **Step 1: failing tests**

`test/client/model.test.js`:
```js
import { describe, it, expect } from "vitest";
import * as M from "../../public/js/model.js";

const ev = (o) => ({ id: o.id || o.title, date: "2026-11-18", kind: "activity", time: "", title: "t", ...o });
const data = (events = [], extra = {}) => ({
  title: "T", subtitle: "S", tz: "-03:00", cities: {}, nights: {}, costs: [], events, ...extra,
});

describe("esc", () => {
  it("escapes HTML-significant characters", () => {
    expect(M.esc(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
  it("stringifies non-strings", () => expect(M.esc(5)).toBe("5"));
});

describe("validateItinerary", () => {
  it("accepts a minimal valid document", () => {
    expect(M.validateItinerary(data([ev({ title: "x" })]))).toEqual([]);
  });
  it.each([
    ["missing id", { id: "" }],
    ["bad date", { date: "2026-11-3" }],
    ["bad time", { time: "7:30" }],
    ["bad end", { end: "25:00" }],
    ["bad kind", { kind: "boat" }],
    ["empty title", { title: " " }],
    ["notes not array", { notes: "x" }],
    ["notes not strings", { notes: [1] }],
  ])("rejects %s", (_, o) => {
    expect(M.validateItinerary(data([ev({ title: "x", ...o })])).length).toBeGreaterThan(0);
  });
  it("rejects duplicate ids", () => {
    expect(M.validateItinerary(data([ev({ id: "a" }), ev({ id: "a" })])).length).toBe(1);
  });
  it("rejects non-object top-level sections", () => {
    expect(M.validateItinerary({ ...data(), nights: [] }).length).toBeGreaterThan(0);
    expect(M.validateItinerary({ ...data(), costs: {} }).length).toBeGreaterThan(0);
    expect(M.validateItinerary(null).length).toBeGreaterThan(0);
  });
});

describe("dates", () => {
  const d = data([ev({ date: "2026-11-15" }), ev({ date: "2026-11-20", id: "b" })],
    { nights: { "2026-11-13": { name: "H" }, "2026-11-18": { name: "R" } } });
  it("tripDates merges nights and events, sorted and unique", () => {
    expect(M.tripDates(d)).toEqual(["2026-11-13", "2026-11-15", "2026-11-18", "2026-11-20"]);
  });
  it("openingDate: today, before, after, and a gap day", () => {
    const ds = M.tripDates(d);
    expect(M.openingDate(ds, "2026-11-15")).toBe("2026-11-15");
    expect(M.openingDate(ds, "2026-10-01")).toBe("2026-11-13");
    expect(M.openingDate(ds, "2026-12-01")).toBe("2026-11-20");
    expect(M.openingDate(ds, "2026-11-16")).toBe("2026-11-18");
    expect(M.openingDate([], "2026-11-16")).toBe(null);
  });
});

describe("dayEvents and timelineState", () => {
  const evs = [
    ev({ id: "c", time: "11:00", title: "trek" }),
    ev({ id: "a", time: "07:30", end: "09:00", title: "bus" }),
    ev({ id: "z", time: "", title: "all day" }),
    ev({ id: "b", time: "10:00", end: "10:45", title: "shuttle" }),
    ev({ id: "x", date: "2026-11-19", time: "08:00" }),
  ];
  it("orders all-day first then by time, only that date", () => {
    expect(M.dayEvents(data(evs), "2026-11-18").map((e) => e.id)).toEqual(["z", "a", "b", "c"]);
  });
  it("marks past, next", () => {
    const day = M.dayEvents(data(evs), "2026-11-18");
    expect(M.timelineState(day, "09:40")).toEqual({ a: "past", b: "next" });
  });
  it("marks now when inside [time, end)", () => {
    const day = M.dayEvents(data(evs), "2026-11-18");
    expect(M.timelineState(day, "10:10")).toEqual({ a: "past", b: "now", c: "next" });
  });
  it("an event without end is past once its time has passed", () => {
    const day = M.dayEvents(data(evs), "2026-11-18");
    expect(M.timelineState(day, "11:01")).toMatchObject({ c: "past" });
  });
  it("overnight event (end <= time) is 'now' after it starts, never past today", () => {
    const day = [ev({ id: "o", time: "22:00", end: "06:00" })];
    expect(M.endsAfterMidnight(day[0])).toBe(true);
    expect(M.timelineState(day, "21:00")).toEqual({ o: "next" });
    expect(M.timelineState(day, "23:30")).toEqual({ o: "now" });
  });
  it("countdown formats", () => {
    expect(M.countdown("09:40", "10:00")).toBe("IN 20 MIN");
    expect(M.countdown("17:30", "20:30")).toBe("IN 3 H");
    expect(M.countdown("08:50", "10:00")).toBe("IN 1 H 10 MIN");
  });
});

describe("changes and conflicts", () => {
  const base = data([ev({ id: "a", title: "A" }), ev({ id: "b", title: "B" })],
    { nights: { "2026-11-18": { name: "R" } } });
  it("upsert replaces by id or appends", () => {
    const d1 = M.applyChange(base, { type: "upsert", event: ev({ id: "a", title: "A2" }) });
    expect(d1.events.map((e) => e.title)).toEqual(["A2", "B"]);
    const d2 = M.applyChange(base, { type: "upsert", event: ev({ id: "c", title: "C" }) });
    expect(d2.events).toHaveLength(3);
    expect(base.events).toHaveLength(2); // not mutated
  });
  it("delete removes by id", () => {
    expect(M.applyChange(base, { type: "delete", id: "a" }).events.map((e) => e.id)).toEqual(["b"]);
  });
  it("night sets and clears", () => {
    expect(M.applyChange(base, { type: "night", date: "2026-11-19", night: { name: "H" } }).nights["2026-11-19"]).toEqual({ name: "H" });
    expect(M.applyChange(base, { type: "night", date: "2026-11-18", night: null }).nights).toEqual({});
  });
  it("field and replace", () => {
    expect(M.applyChange(base, { type: "field", key: "costs", value: [["a", "b", "c"]] }).costs).toEqual([["a", "b", "c"]]);
    const other = data([]);
    expect(M.applyChange(base, { type: "replace", data: other })).toEqual(other);
  });
  it("re-applies when the other device changed a different event", () => {
    const latest = M.applyChange(base, { type: "upsert", event: ev({ id: "b", title: "B-remote" }) });
    const change = { type: "upsert", event: ev({ id: "a", title: "A-local" }) };
    const r = M.resolveConflict(base, latest, change);
    expect(r.conflict).toBe(false);
    expect(r.merged.events.map((e) => e.title)).toEqual(["A-local", "B-remote"]);
  });
  it("reports a conflict when the same event changed remotely", () => {
    const latest = M.applyChange(base, { type: "upsert", event: ev({ id: "a", title: "A-remote" }) });
    const r = M.resolveConflict(base, latest, { type: "delete", id: "a" });
    expect(r).toEqual({ conflict: true, merged: null });
  });
  it("new events never conflict; replace always does", () => {
    const latest = M.applyChange(base, { type: "delete", id: "b" });
    expect(M.resolveConflict(base, latest, { type: "upsert", event: ev({ id: "n" }) }).conflict).toBe(false);
    expect(M.resolveConflict(base, latest, { type: "replace", data: base }).conflict).toBe(true);
  });
  it("night conflicts are keyed by date", () => {
    const latest = M.applyChange(base, { type: "night", date: "2026-11-18", night: { name: "R2" } });
    expect(M.resolveConflict(base, latest, { type: "night", date: "2026-11-18", night: null }).conflict).toBe(true);
    expect(M.resolveConflict(base, latest, { type: "night", date: "2026-11-19", night: { name: "X" } }).conflict).toBe(false);
  });
});

describe("notes", () => {
  it("folds deletes, sorts by createdAt, keeps queued flag", () => {
    const recs = [
      { id: "2", createdAt: "2026-11-18T12:00:00Z", date: "2026-11-18", text: "b", queued: true },
      { id: "1", createdAt: "2026-11-18T11:00:00Z", date: "2026-11-18", text: "a" },
      { id: "3", createdAt: "2026-11-18T13:00:00Z", date: "2026-11-18", text: "c" },
      { id: "4", createdAt: "2026-11-18T14:00:00Z", del: "3" },
    ];
    expect(M.foldNotes(recs).map((n) => [n.id, !!n.queued])).toEqual([["1", false], ["2", true]]);
  });
  it("delete of an unsynced note works when both are queued", () => {
    const recs = [
      { id: "a", createdAt: "2026-11-18T12:00:00Z", date: "2026-11-18", text: "x", queued: true },
      { id: "b", createdAt: "2026-11-18T12:01:00Z", del: "a", queued: true },
    ];
    expect(M.foldNotes(recs)).toEqual([]);
  });
});

describe("stats, codes, summary", () => {
  const d = data([
    ev({ id: "1", kind: "flight", conf: "AAA", title: "F", date: "2026-11-14", time: "09:00" }),
    ev({ id: "2", kind: "flight", conf: "AAA", title: "F", date: "2026-11-14", time: "09:00" }),
    ev({ id: "3", kind: "bus", conf: "BBB", title: "B", date: "2026-11-13", time: "" }),
    ev({ id: "4", kind: "food", title: "D" }),
  ], { nights: { "2026-11-13": { name: "H" }, "2026-11-14": { name: "H" } } });
  it("tripStats counts nights and kinds", () => {
    expect(M.tripStats(d)).toEqual({ nights: 2, byKind: { flight: 2, bus: 1, food: 1 } });
  });
  it("confRows sorted and de-duplicated", () => {
    expect(M.confRows(d).map((e) => e.conf)).toEqual(["BBB", "AAA"]);
  });
  it("summarize", () => expect(M.summarize(d)).toBe("4 events · 2 nights"));
});

describe("ensureIds", () => {
  it("adds missing ids without touching existing ones", () => {
    const out = M.ensureIds(data([{ date: "2026-11-18", kind: "note", title: "x" }, ev({ id: "keep" })]));
    expect(out.events[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.events[1].id).toBe("keep");
  });
});
```

- [ ] **Step 2: run.** Expected: FAIL.

- [ ] **Step 3: implement** `public/js/model.js`:

```js
export const KINDS = ["flight", "bus", "transfer", "stay", "trek", "activity", "food", "show", "note"];
export const KIND_LABEL = {
  flight: "Flight", bus: "Bus", transfer: "Transfer", stay: "Lodging", trek: "Trek",
  activity: "Activity", food: "Food", show: "Event", note: "",
};

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);

export function validateItinerary(d) {
  if (!isObj(d)) return ["Itinerary must be an object"];
  const errs = [];
  for (const k of ["cities", "nights"]) if (!isObj(d[k])) errs.push(`${k} must be an object`);
  if (!Array.isArray(d.costs)) errs.push("costs must be an array");
  if (!Array.isArray(d.events)) return [...errs, "events must be an array"];
  const seen = new Set();
  d.events.forEach((e, i) => {
    const at = `Event ${i + 1}${e && e.title ? ` (${e.title})` : ""}`;
    if (!isObj(e)) return errs.push(`${at}: not an object`);
    if (!e.id) errs.push(`${at}: missing id`);
    else if (seen.has(e.id)) errs.push(`${at}: duplicate id`);
    seen.add(e.id);
    if (!DATE.test(e.date || "")) errs.push(`${at}: date must be YYYY-MM-DD`);
    if (e.time && !TIME.test(e.time)) errs.push(`${at}: time must be HH:MM`);
    if (e.end && !TIME.test(e.end)) errs.push(`${at}: end must be HH:MM`);
    if (!KINDS.includes(e.kind)) errs.push(`${at}: unknown kind`);
    if (!String(e.title || "").trim()) errs.push(`${at}: title required`);
    if (e.notes !== undefined && !(Array.isArray(e.notes) && e.notes.every((n) => typeof n === "string"))) {
      errs.push(`${at}: notes must be a list of text`);
    }
  });
  if (isObj(d.nights)) {
    for (const [k, n] of Object.entries(d.nights)) {
      if (!DATE.test(k) || !isObj(n) || !n.name) errs.push(`Night ${k}: needs a date key and a name`);
    }
  }
  return errs;
}

export const ensureIds = (d) => ({
  ...d,
  events: d.events.map((e) => (e.id ? e : { ...e, id: crypto.randomUUID() })),
});

export const tripDates = (d) =>
  [...new Set([...Object.keys(d.nights), ...d.events.map((e) => e.date)])].sort();

export function openingDate(dates, today) {
  if (!dates.length) return null;
  if (today <= dates[0]) return dates[0];
  return dates.find((x) => x >= today) || dates[dates.length - 1];
}

export const dayEvents = (d, iso) =>
  d.events
    .filter((e) => e.date === iso)
    .sort((a, b) =>
      (a.time || "").localeCompare(b.time || "") || a.title.localeCompare(b.title));

export const endsAfterMidnight = (e) => !!(e.end && e.time && e.end <= e.time);

export function timelineState(events, now) {
  const st = {};
  let next = false;
  for (const e of events) {
    if (!e.time) continue;
    const overnight = endsAfterMidnight(e);
    if (e.time <= now && (overnight || (e.end && now < e.end))) st[e.id] = "now";
    else if (e.time <= now) st[e.id] = "past";
    else if (!next) { st[e.id] = "next"; next = true; }
  }
  return st;
}

const mins = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

export function countdown(from, to) {
  const d = mins(to) - mins(from);
  const h = Math.floor(d / 60), m = d % 60;
  if (!h) return `IN ${m} MIN`;
  return m ? `IN ${h} H ${m} MIN` : `IN ${h} H`;
}

export function applyChange(d, c) {
  switch (c.type) {
    case "upsert": {
      const i = d.events.findIndex((e) => e.id === c.event.id);
      const events = [...d.events];
      if (i < 0) events.push(c.event); else events[i] = c.event;
      return { ...d, events };
    }
    case "delete":
      return { ...d, events: d.events.filter((e) => e.id !== c.id) };
    case "night": {
      const nights = { ...d.nights };
      if (c.night) nights[c.date] = c.night; else delete nights[c.date];
      return { ...d, nights };
    }
    case "field":
      return { ...d, [c.key]: c.value };
    case "replace":
      return c.data;
    default:
      throw new TypeError(`Unknown change type ${c.type}`);
  }
}

export function changeTarget(d, c) {
  if (c.type === "upsert") return d.events.find((e) => e.id === c.event.id) ?? null;
  if (c.type === "delete") return d.events.find((e) => e.id === c.id) ?? null;
  if (c.type === "night") return d.nights[c.date] ?? null;
  if (c.type === "field") return d[c.key];
  return d;
}

export function resolveConflict(base, latest, c) {
  if (c.type === "replace") return { conflict: true, merged: null };
  const same = JSON.stringify(changeTarget(base, c)) === JSON.stringify(changeTarget(latest, c));
  return same ? { conflict: false, merged: applyChange(latest, c) } : { conflict: true, merged: null };
}

export function foldNotes(recs) {
  const gone = new Set(recs.filter((r) => r.del).map((r) => r.del));
  return recs
    .filter((r) => r.text !== undefined && !gone.has(r.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function tripStats(d) {
  const byKind = {};
  for (const e of d.events) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  return { nights: Object.keys(d.nights).length, byKind };
}

export function confRows(d) {
  const seen = new Set();
  return d.events
    .filter((e) => e.conf)
    .sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")))
    .filter((e) => { const k = e.conf + "\u0000" + e.title; return !seen.has(k) && seen.add(k); });
}

export const summarize = (d) =>
  `${d.events.length} events · ${Object.keys(d.nights).length} nights`;
```

- [ ] **Step 4: run.** Expected: PASS.
- [ ] **Step 5: commit.**

---

### Task 5: ics.js

**Files:**
- Create: `public/js/ics.js`
- Test: `test/client/ics.test.js`

**Interfaces:**
- Consumes: `endsAfterMidnight` from `model.js`.
- Produces: `eventToIcs(event, tz: string, now = new Date()): string` (CRLF lines, folded at ≤75 octets); `icsFilename(event): string` (`"<date>-<slug>.ics"`).

- [ ] **Step 1: failing tests**

`test/client/ics.test.js`:
```js
import { describe, it, expect } from "vitest";
import { eventToIcs, icsFilename } from "../../public/js/ics.js";

const NOW = new Date("2026-10-01T12:00:00Z");
const base = { id: "e1", date: "2026-11-18", kind: "bus", title: "Bus to Laguna Amarga" };
const lines = (s) => s.replace(/\r\n /g, "").split("\r\n");

describe("eventToIcs", () => {
  it("converts local time to UTC with the trip offset; default 1h", () => {
    const l = lines(eventToIcs({ ...base, time: "07:30" }, "-03:00", NOW));
    expect(l).toContain("DTSTART:20261118T103000Z");
    expect(l).toContain("DTEND:20261118T113000Z");
    expect(l).toContain("UID:e1@itinerary");
    expect(l).toContain("DTSTAMP:20261001T120000Z");
    expect(l).toContain("TRIGGER:-PT60M");
  });
  it("uses end when given, next day when end <= time", () => {
    const l = lines(eventToIcs({ ...base, time: "22:00", end: "06:00" }, "-03:00", NOW));
    expect(l).toContain("DTSTART:20261119T010000Z");
    expect(l).toContain("DTEND:20261119T090000Z");
  });
  it("all-day uses VALUE=DATE and next-day end", () => {
    const l = lines(eventToIcs({ ...base, time: "", date: "2026-11-30" }, "-03:00", NOW));
    expect(l).toContain("DTSTART;VALUE=DATE:20261130");
    expect(l).toContain("DTEND;VALUE=DATE:20261201");
  });
  it("never includes the confirmation code; escapes text", () => {
    const s = eventToIcs({ ...base, time: "07:30", conf: "SECRET99", where: "Av. X, 123; gate 3",
      sub: "Seat 4A", notes: ["Line one", "Line, two"] }, "-03:00", NOW);
    expect(s).not.toContain("SECRET99");
    const l = lines(s);
    expect(l).toContain("LOCATION:Av. X\\, 123\\; gate 3");
    expect(l).toContain("DESCRIPTION:Seat 4A\\nLine one\\nLine\\, two");
  });
  it("uses CRLF and folds long lines to <= 75 octets", () => {
    const s = eventToIcs({ ...base, time: "07:30", sub: "ñ".repeat(200) }, "-03:00", NOW);
    expect(s.endsWith("\r\n")).toBe(true);
    for (const line of s.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(lines(s)).toContain(`DESCRIPTION:${"ñ".repeat(200)}`);
  });
});

it("icsFilename slugifies", () => {
  expect(icsFilename({ date: "2026-11-18", title: "Bus → Laguna Amarga!" })).toBe("2026-11-18-bus-laguna-amarga.ics");
});
```

- [ ] **Step 2: run.** Expected: FAIL.

- [ ] **Step 3: implement** `public/js/ics.js`:

```js
import { endsAfterMidnight } from "./model.js";

const te = new TextEncoder();
const escText = (s) =>
  String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const utc = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const ymd = (iso) => iso.replace(/-/g, "");
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function fold(line) {
  const out = [];
  let cur = "", bytes = 0, limit = 75;
  for (const ch of line) {
    const n = te.encode(ch).length;
    if (bytes + n > limit) { out.push(cur); cur = " "; bytes = 1; limit = 75; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

export function eventToIcs(e, tz, now = new Date()) {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//itinerary//EN", "BEGIN:VEVENT",
    `UID:${e.id}@itinerary`, `DTSTAMP:${utc(now)}`,
  ];
  if (e.time) {
    const start = new Date(`${e.date}T${e.time}:00${tz}`);
    const end = e.end
      ? new Date(`${endsAfterMidnight(e) ? addDays(e.date, 1) : e.date}T${e.end}:00${tz}`)
      : new Date(start.getTime() + 3600_000);
    lines.push(`DTSTART:${utc(start)}`, `DTEND:${utc(end)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${ymd(e.date)}`, `DTEND;VALUE=DATE:${ymd(addDays(e.date, 1))}`);
  }
  lines.push(`SUMMARY:${escText(e.title)}`);
  if (e.where) lines.push(`LOCATION:${escText(e.where)}`);
  const desc = [e.sub, ...(e.notes || [])].filter(Boolean).join("\n");
  if (desc) lines.push(`DESCRIPTION:${escText(desc)}`);
  lines.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "TRIGGER:-PT60M",
    "END:VALARM", "END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

export const icsFilename = (e) =>
  `${e.date}-${e.title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.ics`;
```

- [ ] **Step 4: run.** Expected: PASS.
- [ ] **Step 5: commit.**

---

### Task 6: api.js, store.js, sync.js

**Files:**
- Create: `public/js/api.js`, `public/js/store.js`, `public/js/sync.js`
- Test: `test/client/api.test.js`, `test/client/sync.test.js`

**Interfaces:**
- Produces:
  - `api.js`:
    - `class ApiError extends Error { status: number; body: any }`
    - `createApi(token: string, fetchFn = fetch)` returns `{ getItinerary(): Promise<{version, blob, updatedAt}|null>, putItinerary(blob, ifMatch): Promise<{version, updatedAt}>, history(): Promise<{version, updatedAt}[]>, historyVersion(v): Promise<{version, blob, updatedAt}>, getNotes(): Promise<{id, blob, createdAt}[]>, postNotes(list): Promise<void> }`
    - A network failure rejects with the underlying `TypeError`. A non-2xx response rejects with `ApiError`, except that `getItinerary` returns `null` on 404.
  - `store.js` (IndexedDB database `itinerary`, version 1; stores `kv` (out-of-line keys), `notes` and `outbox` (keyPath `id`)):
    - `get(store, key)`, `put(store, value, key?)`, `all(store)`, `del(store, key)`, `clearAll()`, `openDb()`
    - kv keys: `"keys"` → `{encKey, token}`; `"itinerary"` → `{version, blob, updatedAt}`; `"syncedAt"` → ISO string
  - `sync.js`:
    - `flushOutbox({api, store}): Promise<number>`: posts all outbox items (in chunks of ≤200), removes each sent item, and returns the count
    - `pullNotes({api, store}): Promise<boolean>`: puts server notes into `notes` and returns whether any id was new
    - `pullItinerary({api, store}): Promise<{changed: boolean, record}>`: returns `{changed:false, record:null}` on 404; `changed` is true when `version` differs from the stored record
    - `createConnectivity(win = globalThis)` returns `{ get online(): boolean, markFailure(), markSuccess(), subscribe(fn): () => void }`. `online` is false when `navigator.onLine === false` or after `markFailure()`, until `markSuccess()`. Subscribers are called on every change.

- [ ] **Step 1: failing tests**

`test/client/api.test.js`:
```js
import { describe, it, expect, vi } from "vitest";
import { createApi, ApiError } from "../../public/js/api.js";

const res = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });

describe("api", () => {
  it("sends the bearer token and If-Match", async () => {
    const f = vi.fn(async () => res(200, { version: 2, updatedAt: "t" }));
    await createApi("TOK", f).putItinerary("B", 1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/itinerary");
    expect(init.method).toBe("PUT");
    expect(init.headers.authorization).toBe("Bearer TOK");
    expect(init.headers["if-match"]).toBe("1");
    expect(JSON.parse(init.body)).toEqual({ blob: "B" });
  });
  it("getItinerary returns null on 404", async () => {
    expect(await createApi("T", async () => res(404, {})).getItinerary()).toBe(null);
  });
  it("throws ApiError with status on 409 and 401", async () => {
    const e = await createApi("T", async () => res(409, { version: 5 })).putItinerary("B", 1).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(409);
    expect(e.body.version).toBe(5);
    const e2 = await createApi("T", async () => res(401, {})).getNotes().catch((x) => x);
    expect(e2.status).toBe(401);
  });
  it("propagates network errors as-is", async () => {
    const err = new TypeError("Failed to fetch");
    await expect(createApi("T", async () => { throw err; }).getNotes()).rejects.toBe(err);
  });
});
```

`test/client/sync.test.js`:
```js
import { describe, it, expect, vi } from "vitest";
import { flushOutbox, pullNotes, pullItinerary, createConnectivity } from "../../public/js/sync.js";

function fakeStore() {
  const s = { kv: new Map(), notes: new Map(), outbox: new Map() };
  const keyOf = (store, v, k) => k ?? v.id;
  return {
    s,
    get: async (st, k) => s[st].get(k),
    put: async (st, v, k) => void s[st].set(keyOf(st, v, k), v),
    all: async (st) => [...s[st].values()],
    del: async (st, k) => void s[st].delete(k),
  };
}
const n = (i) => ({ id: `id${i}`, blob: `b${i}`, createdAt: `2026-11-18T10:00:0${i}Z` });

describe("flushOutbox", () => {
  it("posts queued notes and clears them", async () => {
    const store = fakeStore();
    await store.put("outbox", n(1)); await store.put("outbox", n(2));
    const api = { postNotes: vi.fn(async () => {}) };
    expect(await flushOutbox({ api, store })).toBe(2);
    expect(api.postNotes).toHaveBeenCalledWith([n(1), n(2)]);
    expect(store.s.outbox.size).toBe(0);
  });
  it("keeps the outbox when the post fails", async () => {
    const store = fakeStore();
    await store.put("outbox", n(1));
    const api = { postNotes: async () => { throw new TypeError("offline"); } };
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
    for (let i = 0; i < 450; i++) await store.put("outbox", { ...n(0), id: `x${i}` });
    const api = { postNotes: vi.fn(async () => {}) };
    await flushOutbox({ api, store });
    expect(api.postNotes.mock.calls.map((c) => c[0].length)).toEqual([200, 200, 50]);
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
    expect(await pullItinerary({ api, store })).toEqual({ changed: true, record: rec });
    expect(await pullItinerary({ api, store })).toEqual({ changed: false, record: rec });
    expect(store.s.kv.get("itinerary")).toEqual(rec);
    expect(typeof store.s.kv.get("syncedAt")).toBe("string");
  });
  it("pullItinerary handles an empty server", async () => {
    const api = { getItinerary: async () => null };
    expect(await pullItinerary({ api, store: fakeStore() })).toEqual({ changed: false, record: null });
  });
});

describe("connectivity", () => {
  it("combines navigator.onLine with request failures", () => {
    const listeners = {};
    const win = { navigator: { onLine: true }, addEventListener: (t, f) => (listeners[t] = f) };
    const c = createConnectivity(win);
    const seen = [];
    c.subscribe((on) => seen.push(on));
    expect(c.online).toBe(true);
    c.markFailure();
    expect(c.online).toBe(false);
    c.markSuccess();
    expect(c.online).toBe(true);
    win.navigator.onLine = false; listeners.offline();
    expect(c.online).toBe(false);
    expect(seen).toEqual([false, true, false]);
  });
});
```

- [ ] **Step 2: run.** Expected: FAIL.

- [ ] **Step 3: implement**

`public/js/api.js`:
```js
export class ApiError extends Error {
  constructor(status, body) {
    super(`API ${status}`);
    this.status = status;
    this.body = body;
  }
}

export function createApi(token, fetchFn = (...a) => fetch(...a)) {
  async function call(method, path, { body, ifMatch } = {}) {
    const headers = { authorization: `Bearer ${token}` };
    if (ifMatch !== undefined) headers["if-match"] = String(ifMatch);
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetchFn(path, {
      method, headers, cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }
  return {
    async getItinerary() {
      try { return await call("GET", "/api/itinerary"); }
      catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
    },
    putItinerary: (blob, ifMatch) => call("PUT", "/api/itinerary", { body: { blob }, ifMatch }),
    history: () => call("GET", "/api/history"),
    historyVersion: (v) => call("GET", `/api/history/${v}`),
    getNotes: () => call("GET", "/api/notes"),
    postNotes: async (list) => { await call("POST", "/api/notes", { body: list }); },
  };
}
```

`public/js/store.js`:
```js
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
export const put = (s, v, k) => run(s, "readwrite", (o) => (k === undefined ? o.put(v) : o.put(v, k)));
export const all = (s) => run(s, "readonly", (o) => o.getAll());
export const del = (s, k) => run(s, "readwrite", (o) => o.delete(k));
export async function clearAll() {
  for (const s of STORES) await run(s, "readwrite", (o) => o.clear());
}
```

`public/js/sync.js`:
```js
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
    if (!have.has(n.id)) { await store.put("notes", n); added = true; }
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

export function createConnectivity(win = globalThis) {
  let failed = false;
  const subs = new Set();
  const state = () => win.navigator.onLine !== false && !failed;
  let last = state();
  const emit = () => { const s = state(); if (s !== last) { last = s; subs.forEach((f) => f(s)); } };
  win.addEventListener?.("online", emit);
  win.addEventListener?.("offline", emit);
  return {
    get online() { return state(); },
    markFailure() { failed = true; emit(); },
    markSuccess() { failed = false; emit(); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}
```

- [ ] **Step 4: run.** Expected: PASS.
- [ ] **Step 5: commit.**

---

### Task 7: extract-seed tool

**Files:**
- Create: `tools/extract-seed.mjs`, `test/fixtures/sample-itinerary.html`
- Test: `test/client/extract-seed.test.js`

**Interfaces:**
- Consumes: `validateItinerary` and `ensureIds` from `model.js`.
- Produces: `extractSeed(html: string, {tz = "-03:00"} = {}): data`, which throws `Error` listing validation problems. CLI: `node tools/extract-seed.mjs <Itinerary.html> [out=seed/itinerary.json]`.

- [ ] **Step 1: fixture + failing test**

`test/fixtures/sample-itinerary.html` is fake data with the same shape as the real file. It includes a `<header>` with `<h1>Sample &amp; Trip</h1>` and `<p class="sub">Solo · test</p>`, plus a script containing:
```js
const OPEN_ITEMS = [ "<b>Buy</b> gas canister" ];
const NIGHTS = { "2026-11-13": { name:"Hotel Uno", sub:"Santiago" }, "2026-11-14": { name:"Hotel \"Dos\"" } };
const CITIES = { "2026-11-13": "Santiago", "2026-11-14": "Puerto Natales" };
const EVENTS = [
  // comment with a } brace
  { date:"2026-11-13", time:"09:00", end:"", kind:"flight", title:"Flight [A]", conf:"FAKE01", notes:["a, b", 'it\'s'], todo:true },
  { date:"2026-11-14", time:"", kind:"note", title:"Rest day" },
];
const COSTS = [ ["Hotel", "$100", "paid"] ];
const KINDLABEL = {};
document.getElementById("x");
```

`test/client/extract-seed.test.js`:
```js
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { extractSeed } from "../../tools/extract-seed.mjs";

const html = readFileSync(new URL("../fixtures/sample-itinerary.html", import.meta.url), "utf8");

describe("extractSeed", () => {
  const d = extractSeed(html);
  it("reads title, subtitle, tz", () => {
    expect(d.title).toBe("Sample & Trip");
    expect(d.subtitle).toBe("Solo · test");
    expect(d.tz).toBe("-03:00");
  });
  it("reads nights, cities, costs verbatim", () => {
    expect(d.nights["2026-11-14"].name).toBe('Hotel "Dos"');
    expect(d.cities["2026-11-14"]).toBe("Puerto Natales");
    expect(d.costs).toEqual([["Hotel", "$100", "paid"]]);
  });
  it("adds ids, drops todo and empty fields, ignores OPEN_ITEMS", () => {
    expect(d.events).toHaveLength(2);
    expect(d.events[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(d.events[0]).not.toHaveProperty("todo");
    expect(d.events[0]).not.toHaveProperty("end");
    expect(d.events[0].notes).toEqual(["a, b", "it's"]);
    expect(d).not.toHaveProperty("OPEN_ITEMS");
    expect(d).not.toHaveProperty("openItems");
  });
  it("throws with details on invalid data", () => {
    expect(() => extractSeed(html.replace('kind:"note"', 'kind:"boat"'))).toThrow(/unknown kind/);
  });
  it("throws when a block is missing", () => {
    expect(() => extractSeed(html.replace("const COSTS", "const NOPE"))).toThrow(/COSTS/);
  });
});
```

- [ ] **Step 2: run.** Expected: FAIL.

- [ ] **Step 3: implement** `tools/extract-seed.mjs`:

```js
// Usage: node tools/extract-seed.mjs <Itinerary.html> [out=seed/itinerary.json]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { ensureIds, validateItinerary } from "../public/js/model.js";

const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENT[m]).trim();

// Returns the source text of the literal assigned in `const NAME = <literal>`.
function literal(src, name) {
  const start = src.search(new RegExp(`const\\s+${name}\\s*=`));
  if (start < 0) throw new Error(`Block ${name} not found`);
  let i = src.indexOf("=", start) + 1;
  while (/\s/.test(src[i])) i++;
  const from = i;
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; src[i] !== c; i++) if (src[i] === "\\") i++;
    } else if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
    } else if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i) + 1;
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (--depth === 0) return src.slice(from, i + 1);
    }
  }
  throw new Error(`Block ${name} is unterminated`);
}

const evalLiteral = (text) => vm.runInNewContext(`(${text})`, Object.create(null), { timeout: 1000 });

export function extractSeed(html, { tz = "-03:00" } = {}) {
  const get = (re, what) => {
    const m = re.exec(html);
    if (!m) throw new Error(`${what} not found`);
    return decode(m[1]);
  };
  const [nights, cities, events, costs] =
    ["NIGHTS", "CITIES", "EVENTS", "COSTS"].map((n) => evalLiteral(literal(html, n)));
  const clean = events.map(({ todo, ...e }) =>
    Object.fromEntries(Object.entries(e).filter(([k, v]) => k === "time" || v !== "")));
  const data = ensureIds({
    title: get(/<h1[^>]*>([\s\S]*?)<\/h1>/, "Title <h1>"),
    subtitle: get(/<p class="sub">([\s\S]*?)<\/p>/, 'Subtitle <p class="sub">'),
    tz, cities, nights, costs,
    events: clean.map((e) => ({ time: "", ...e })),
  });
  const errs = validateItinerary(data);
  if (errs.length) throw new Error(`Seed is invalid:\n- ${errs.join("\n- ")}`);
  return data;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const [src, out = "seed/itinerary.json"] = process.argv.slice(2);
  if (!src) { console.error("Usage: node tools/extract-seed.mjs <Itinerary.html> [out]"); process.exit(2); }
  const data = extractSeed(readFileSync(src, "utf8"));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(data, null, 2));
  console.log(`Wrote ${out}: ${data.events.length} events, ${Object.keys(data.nights).length} nights`);
}
```

- [ ] **Step 4: run.** Expected: PASS.
- [ ] **Step 5: run on the real file** (local only; the output is gitignored): `node tools/extract-seed.mjs Itinerary.html`. Expected: it prints counts. Do not print or commit the JSON.
- [ ] **Step 6: commit** (the tool, test and fixture only).

---

### Task 8: render.js (HTML-string renderers)

**Files:**
- Create: `public/js/render.js`
- Test: `test/client/render.test.js`

**Interfaces:**
- Consumes: `model.js` (`esc, KIND_LABEL, dayEvents, timelineState, countdown, confRows, tripStats, tripDates`).
- Produces (each returns a string):
  - `renderDay(data, iso, {notes, dates, todayISO, nowHHMM, syncLabel})`: the header (`.big` date, "Day N of M", city), the `.strip` progress bar with `data-date` segments, the `.tl` timeline, the `.nightB` night row (`data-night="<iso>"`), and the `.notes` list. Event cards carry `data-id` and `.conf` chips with `data-copy`. Classes `past|now|next` apply only when `iso === todayISO`. Notes have `data-note-id`, `data-copy`, and a queued tag. With no events it shows "Nothing scheduled".
  - `renderDayList(data, dates, selected)`: desktop left pane rows with `data-date`, city, and a one-line preview (titles joined by " · ", truncated by CSS).
  - `renderCodes(data)`: the table, where each code cell has `data-copy`.
  - `renderNotesTab(data, notes)`: grouped by date with a date heading; an empty state otherwise.
  - `renderOverview(data)`: status chips from `tripStats` (e.g. "16 nights", "5 flights · 1 bus") plus the costs table.
  - `renderSnapshotBody(data, notes, todayISO)`: every date stacked in the original day-card layout, each with its night row and notes, then a `section.codes` (page break before in print) and the costs table. It has no interactive attributes except `data-copy`.
  - `dayLabel(iso): {mon, day, dow, short}` helper, exported.

- [ ] **Step 1: failing tests** `test/client/render.test.js`:

```js
import { describe, it, expect } from "vitest";
import * as R from "../../public/js/render.js";

const d = {
  title: "T", subtitle: "S", tz: "-03:00",
  cities: { "2026-11-18": "W Trek · Day 1" },
  nights: { "2026-11-18": { name: "Refugio <b>", sub: "bunk" } },
  costs: [["Hotel", "$1", "n"]],
  events: [
    { id: "a", date: "2026-11-18", time: "07:30", kind: "bus", title: "Bus <script>", conf: "C1" },
    { id: "b", date: "2026-11-18", time: "10:00", kind: "transfer", title: "Shuttle" },
    { id: "c", date: "2026-11-19", time: "", kind: "trek", title: "Hike" },
  ],
};
const dates = ["2026-11-18", "2026-11-19"];
const notes = [{ id: "n1", date: "2026-11-18", text: "wifi <pw>", createdAt: "2026-11-18T12:00:00Z", queued: true }];

describe("renderDay", () => {
  const html = R.renderDay(d, "2026-11-18", { notes, dates, todayISO: "2026-11-18", nowHHMM: "09:40", syncLabel: "Synced now" });
  it("escapes all user text", () => {
    expect(html).not.toContain("<script>");
    expect(html).toContain("Bus &lt;script&gt;");
    expect(html).toContain("Refugio &lt;b&gt;");
    expect(html).toContain("wifi &lt;pw&gt;");
  });
  it("shows day N of M, city, next countdown and past state", () => {
    expect(html).toContain("Day 1 of 2");
    expect(html).toContain("W Trek · Day 1");
    expect(html).toMatch(/data-id="a"[^>]*class="[^"]*past|class="[^"]*past[^"]*"[^>]*data-id="a"/);
    expect(html).toContain("NEXT · IN 20 MIN");
  });
  it("renders copyable conf, night row and queued note", () => {
    expect(html).toContain('data-copy="C1"');
    expect(html).toContain('data-night="2026-11-18"');
    expect(html).toContain('data-note-id="n1"');
    expect(html).toContain("queued");
  });
  it("no today states on other days; empty day message", () => {
    const other = R.renderDay(d, "2026-11-18", { notes: [], dates, todayISO: "2026-11-20", nowHHMM: "09:40", syncLabel: "" });
    expect(other).not.toContain("NEXT ·");
    const empty = R.renderDay({ ...d, events: [] }, "2026-11-18", { notes: [], dates, todayISO: "x", nowHHMM: "00:00", syncLabel: "" });
    expect(empty).toContain("Nothing scheduled");
  });
});

describe("other views", () => {
  it("codes table is copyable and escaped", () => {
    const h = R.renderCodes(d);
    expect(h).toContain('data-copy="C1"');
    expect(h).toContain("Bus &lt;script&gt;");
  });
  it("notes tab groups by day, has empty state", () => {
    expect(R.renderNotesTab(d, notes)).toContain("wifi &lt;pw&gt;");
    expect(R.renderNotesTab(d, [])).toContain("No notes yet");
  });
  it("overview shows computed stats and costs", () => {
    const h = R.renderOverview(d);
    expect(h).toContain("1 night");
    expect(h).toContain("$1");
  });
  it("day list marks the selected day", () => {
    expect(R.renderDayList(d, dates, "2026-11-19")).toMatch(/data-date="2026-11-19"[^>]*class="[^"]*on|class="[^"]*on[^"]*"[^>]*data-date="2026-11-19"/);
  });
  it("snapshot body contains every day, notes and codes section", () => {
    const h = R.renderSnapshotBody(d, notes, "2026-11-18");
    expect(h).toContain('id="d2026-11-18"');
    expect(h).toContain('id="d2026-11-19"');
    expect(h).toContain("wifi &lt;pw&gt;");
    expect(h).toContain('class="codes');
  });
});
```

- [ ] **Step 2: run.** Expected: FAIL.
- [ ] **Step 3: implement** `render.js`. Use template literals, `esc()` on every interpolated user value (including attribute values), and CSS class names shared with `styles.css` (Task 9). The countdown label appears only on the `next` card. The night label is `Night` (plus `n/m` when consecutive nights share a name, computed by counting the run of equal `nights[*].name` values). `dayLabel` uses `Date.UTC` so it doesn't depend on the local time zone.
- [ ] **Step 4: run.** Expected: PASS.
- [ ] **Step 5: commit.**

---

### Task 9: Shell: index.html, styles.css, app.js (lock, import, tabs, day navigation)

**Files:**
- Create/replace: `public/index.html`, `public/styles.css`, `public/js/app.js`

**Interfaces:**
- Consumes: everything above.
- Produces: global app `state = {keys, api, data, version, notesRecs, dates, current, tab}`; `refresh()`, `rerender()` and `toast(msg)`, exported for `edit.js`.

This task is DOM wiring; its logic is already covered by the unit tests. Verify manually (Step 3).

- [ ] **Step 1: styles.css.** Port the original's tokens (light and dark) and add the "direction B" components from the approved mockup:
  - `.hd .big`, `.strip`, `.tl .row .t .dot .c`, `.row.past/.now/.next`, `.nextlab`, `.pass`
  - `.nightB`, `.notes`, `.fabs .fab .fab.n`, `.tabs`
  - `.banner.offline`, `.toast`, `dialog.sheet` (bottom sheet on phone; centered at ≥900 px)
  - desktop `.layout` grid (`250px 1fr`) at ≥900 px, with the tab bar hidden and the day list shown
  - print CSS: hide the app chrome and show `#print-root` only; `section.codes { break-before: page }`
  - the snapshot day-card classes from the original (`.day`, `.card`, `.ev`, `.night`, `table`)

  `touch-action: pan-y` on `#day`. No fixed widths wider than the viewport; `min-width: 0` on flex children.

- [ ] **Step 2: index.html + app.js.**
  - `index.html`: meta viewport and `color-scheme`, `<link rel="manifest">`, `theme-color` metas for light and dark, `styles.css`, and `<script type="module" src="/js/app.js">`. It contains these sections: `#lock` (passphrase form and error line), `#import` (file input and error list), `#app` (`.layout` with `#daylist`, `#day`, `#notes-tab`, `#codes-tab`, `#more-tab`, the `.fabs` and `nav.tabs`), `#banner`, `#toast`, the `<dialog>` sheets (filled by `edit.js`), and `#print-root`.
  - **Boot:** read `kv/keys`.
    - If there are none, show `#lock`.
    - Otherwise build the api, render from `kv/itinerary` if present (decrypt the itinerary and all notes plus the outbox), then call `refresh()`.
    - If there are keys but no cached itinerary and we're offline, show "No saved copy yet. Connect once to download."
  - **Unlock:**
    1. Derive the keys, with a spinner and the button disabled.
    2. Call `api.getItinerary()`: a 401 shows "Wrong passphrase"; a network error shows "First unlock needs a connection".
    3. Otherwise store the keys and call `navigator.storage.persist()`. On `null` (404), show `#import`; otherwise save the record and show the app.
  - **Import:**
    1. Read the file, `JSON.parse`, then `ensureIds` and `validateItinerary`, and list any errors.
    2. `encryptJson`, then `putItinerary(blob, 0)`, then store the record and show the app.
  - **refresh():** call `flushOutbox`, `pullNotes` and `pullItinerary` inside try/catch. On success call `conn.markSuccess()` and write `syncedAt`. A `TypeError` calls `conn.markFailure()`. An `ApiError` 401 shows `#lock` with "Passphrase changed? Unlock again." If the version changed, re-render and `toast("Updated")`. Triggers: after boot, `visibilitychange` → visible, and `online`.
  - **Rendering:** the Trip tab calls `renderDay` for `state.current`. On desktop, `#daylist` uses `renderDayList`. The notes, codes and more tabs render on demand. A timer re-renders the day once a minute when it is today.
  - **Navigation:**
    - Swipe: pointerdown/pointerup on `#day`, where `|dx| > 60 && |dx| > 1.5·|dy|` changes day by ±1.
    - Taps on `.strip [data-date]` and `#daylist [data-date]` jump to that day.
    - ← → keys change day (ignored when focus is in an input, textarea or select).
    - Tab buttons switch `state.tab`.
  - **Copy:** a delegated click on `[data-copy]` calls `navigator.clipboard.writeText` and shows `toast("Copied")`, then stops propagation.
  - **Offline banner and sync label:** subscribe to `conn`. The banner reads "Offline. Viewing saved copy. Notes still save." The `+` button and all itinerary Save buttons get `disabled`.
  - **More tab:**
    - `renderOverview`
    - buttons: History, Edit cities (JSON), Edit costs (JSON), Raw JSON, Download snapshot, Print, Forget this device
    - a storage line from `navigator.storage.persisted()`
    - the app version, obtained by messaging the service worker (`{type:"version"}` → reply)
  - **Forget this device:** a confirm dialog, then `clearAll()`, delete all caches, and `location.reload()`.

- [ ] **Step 3: manual verification.** Run `npx wrangler d1 migrations apply itinerary --local`. Create `.dev.vars` containing a `TOKEN_HASH` for a test passphrase (from the tool). Run `npm run dev`, open http://localhost:8787 in Chrome, unlock, and import `test/fixtures/sample.json`. That's a fake seed produced by running `extract-seed` on the fixture into `seed/` (gitignored).

  Check:
  - Swipe via touch emulation in DevTools, arrow keys, the strip and the day list.
  - Tap-to-copy.
  - The next highlight, using a fixture day equal to today (edit the local seed).
  - The offline banner, via the DevTools Network "Offline" setting.
  - A 390 px viewport shows no horizontal scroll.
  - Dark mode, via DevTools rendering emulation.
- [ ] **Step 4: commit.**

---

### Task 10: edit.js (sheets and save flow, including 409)

**Files:**
- Create: `public/js/edit.js`
- Modify: `public/js/app.js` (wire the handlers)

**Interfaces:**
- Consumes: `applyChange`, `resolveConflict`, `validateItinerary`, `foldNotes`; `encryptJson`/`decryptJson`; `api`; `store`; `eventToIcs`/`icsFilename`; `state`, `rerender` and `toast` from `app.js`.
- Produces: `openEventSheet(eventOrNull, date)`, `openNightSheet(date)`, `openNoteSheet(date)`, `confirmDeleteNote(id)`, `openJsonEditor(kind: "cities"|"costs"|"all")`, and `saveChange(change): Promise<boolean>`.

- [ ] **Step 1: saveChange(change)**
  1. Set `base = state.data` and `next = applyChange(base, change)`.
  2. `validateItinerary(next)`: on errors, show them in the sheet and return false.
  3. `putItinerary(await encryptJson(key, next), state.version)`. On success, set `state.data/version`, write `kv/itinerary` and `syncedAt`, re-render, and return true.
  4. A `TypeError` calls `markFailure` and shows "Offline. Your edit is still in the form"; the sheet stays open.
  5. On an `ApiError` 409:
     - Fetch `pullItinerary`, decrypt it into `latest`, and call `resolveConflict(base, latest, change)`.
     - **No conflict:** a dialog says "Changed on another device. Your change was re-applied." with [Save] [Discard mine]. Save puts `merged` with `If-Match: latest.version`; if that returns 409 again, repeat the process. Discard adopts `latest`.
     - **Conflict:** a dialog shows "Theirs" and "Yours" side by side, as rendered event cards or pretty JSON, with [Keep theirs] [Use mine]. "Use mine" applies the change to `latest` and saves.
     - **replace:** "Changed on another device. Reload?"; the editor text is kept.
  6. A 401 goes to the lock screen.
- [ ] **Step 2: sheets**
  - **Event sheet:** date, time, end, kind `<select>` (`KINDS` with `KIND_LABEL`, "Note" for `note`), title, sub, where, conf, notes (an add/remove list of inputs), plus Save, Delete (with a confirm dialog) and Add to calendar. Add to calendar builds a `Blob` of `text/calendar` and downloads it via `<a download>`; it works offline. Save and Delete are disabled when `!conn.online`. Empty optional fields are omitted from the saved event.
  - **Night sheet:** name and sub, plus Save and Clear.
  - **Note sheet:** a textarea and Save; it always works. Saving:
    1. `id = crypto.randomUUID()`, `createdAt = new Date().toISOString()`.
    2. `blob = encryptJson(key, {date, text, createdAt})`.
    3. Put `{id, blob, createdAt}` into `notes` and `outbox`.
    4. Add the plaintext record to memory with `queued: true` and re-render.
    5. If online, `flushOutbox` (clearing `queued` on success).
    6. `navigator.serviceWorker.ready.then(r => r.sync?.register("outbox"))` inside try/catch.
  - **Delete a note:** a long-press of 550 ms on `[data-note-id]` opens a confirm dialog. It then writes a `{del: id, createdAt}` record in the same way.
  - **JSON editors:** a textarea with pretty JSON. Save parses it (showing parse errors inline), then calls `saveChange({type:"field", key, value})`, or `{type:"replace", data: ensureIds(parsed)}` for "all". The "all" editor also has a "Download JSON" button (plaintext export, for rotation).
- [ ] **Step 3: manual verification** with two browser profiles, or a normal and an incognito window, against `wrangler dev`:
  - Edits on different events re-apply cleanly.
  - Edits to the same event show the pick dialog.
  - The offline save keeps the form.
  - A note added offline is queued, then uploads when back online.
  - A note deleted before sync disappears.
  - `.ics` downloads without the conf code.
- [ ] **Step 4: commit.**

---

### Task 11: History, snapshot, print, service worker, manifest, icons

**Files:**
- Create: `public/js/export.js`, `public/sw.js` (replacing the stub), `public/manifest.webmanifest`, `tools/make-icons.mjs`, `public/icons/icon-192.png`, `public/icons/icon-512.png`, `public/icons/maskable-512.png`
- Test: `test/client/export.test.js`

**Interfaces:**
- Produces: `buildSnapshot(data, notes, css, generatedAt: string): string`, a complete HTML document; `snapshotFilename(date: Date): string` (`Itinerary-snapshot-YYYY-MM-DD.html`).

- [ ] **Step 1: failing test** `test/client/export.test.js`:

```js
import { describe, it, expect } from "vitest";
import { buildSnapshot, snapshotFilename } from "../../public/js/export.js";

const d = { title: "Trip <x>", subtitle: "S", tz: "-03:00", cities: {}, nights: {}, costs: [],
  events: [{ id: "a", date: "2026-11-18", time: "07:30", kind: "bus", title: "Bus", conf: "C1" }] };

describe("snapshot", () => {
  const html = buildSnapshot(d, [{ id: "n", date: "2026-11-18", text: "room 412", createdAt: "x" }], "body{color:red}", "2026-10-01 12:00");
  it("is a standalone document with inline CSS and no external resources", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("body{color:red}");
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
  });
  it("contains data, notes, escaped title and generation time", () => {
    expect(html).toContain("C1");
    expect(html).toContain("room 412");
    expect(html).toContain("Trip &lt;x&gt;");
    expect(html).toContain("2026-10-01 12:00");
  });
  it("filename", () => {
    expect(snapshotFilename(new Date(2026, 9, 1))).toBe("Itinerary-snapshot-2026-10-01.html");
  });
});
```

- [ ] **Step 2: run.** Expected: FAIL.
- [ ] **Step 3: implement `export.js`.**
  - `buildSnapshot` wraps `renderSnapshotBody`, adding the title, subtitle and "Snapshot generated …" line, the CSS, and a tiny inline script for tap-to-copy and scroll-to-today on `[data-copy]`.
  - **Print:** put `renderSnapshotBody` into `#print-root`, add `body.printing`, call `window.print()`, and remove the class on `afterprint`.
  - **Download:** get the CSS text from `fetch("/styles.css")` (served by the service worker cache when offline), then create a Blob and trigger an `<a download>`.
- [ ] **Step 4: History view** (in `edit.js`, or in `export.js` if that's cleaner):
  - `api.history()` lists the versions. Each row is fetched and decrypted lazily with `historyVersion(v)` to show `summarize()`.
  - Tapping a row opens a dialog with `renderSnapshotBody` (read-only) and a **Restore** button.
  - Restore calls `saveChange({type:"replace", data: old})`. Its 409 path is "Changed on another device. Reload?"; a re-try after reload is fine.
  - The whole view needs a connection; offline, show "History needs a connection".
- [ ] **Step 5: sw.js** (a module service worker, registered with `navigator.serviceWorker.register("/sw.js", {type: "module"})` in `app.js`):

```js
import { all, get, del } from "./js/store.js";
import { createApi } from "./js/api.js";
import { flushOutbox } from "./js/sync.js";

const APP_VERSION = "__APP_VERSION__";
const CACHE = `shell-${APP_VERSION}`;
const SHELL = [
  "/", "/index.html", "/styles.css", "/manifest.webmanifest",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png",
  "/js/app.js", "/js/api.js", "/js/config.js", "/js/crypto.js", "/js/edit.js",
  "/js/export.js", "/js/ics.js", "/js/model.js", "/js/render.js", "/js/store.js", "/js/sync.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) =>
    c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  const key = e.request.mode === "navigate" ? "/index.html" : url.pathname;
  e.respondWith(caches.match(key, { cacheName: CACHE }).then((hit) => hit || fetch(e.request)));
});

self.addEventListener("sync", (e) => {
  if (e.tag !== "outbox") return;
  e.waitUntil((async () => {
    const keys = await get("kv", "keys");
    if (keys) await flushOutbox({ api: createApi(keys.token), store: { all, del } });
  })());
});

self.addEventListener("message", (e) => {
  if (e.data?.type === "version") e.source.postMessage({ type: "version", version: APP_VERSION });
});
```

  `clients.claim()` only affects the very first install, where there is no old worker. On updates the new worker still waits for all tabs to close (no `skipWaiting`), which matches the spec.

- [ ] **Step 6: manifest + icons.**
  - `manifest.webmanifest`:
    ```json
    {"id":"/","name":"Patagonia & Buenos Aires","short_name":"Itinerary","start_url":"/","scope":"/","display":"standalone","background_color":"#f4f2ee","theme_color":"#1f6f5c","icons":[{"src":"/icons/icon-192.png","sizes":"192x192","type":"image/png"},{"src":"/icons/icon-512.png","sizes":"512x512","type":"image/png"},{"src":"/icons/maskable-512.png","sizes":"512x512","type":"image/png","purpose":"maskable"}]}
    ```
  - `tools/make-icons.mjs` writes the PNGs with `node:zlib` only (a manual PNG encoder: signature, IHDR, IDAT and IEND chunks, with CRC32). The icon is an accent `#1f6f5c` background with three white granite peaks (a Torres silhouette) drawn by polygon fill with 4× supersampling. The maskable variant keeps the glyph inside the central 80% safe zone. Run it once and commit the PNGs.
- [ ] **Step 7: manual verification** against `wrangler dev`:
  - The app shell loads offline after a reload with DevTools offline enabled.
  - Snapshot download opens standalone.
  - The print preview shows the codes table on its own page.
  - History preview and restore work.
  - The Lighthouse or DevTools Application → Manifest pane shows no installability errors.
- [ ] **Step 8: run all tests** (`npm test`), then commit.

---

### Task 12: README and final review

**Files:**
- Create: `README.md`

- [ ] **Step 1: README.** Sections:
  1. What it is (three lines).
  2. Prerequisites (Node 20+, a Cloudflare account).
  3. One-time setup:
     1. `npm install`, then `npx wrangler login`.
     2. `npx wrangler d1 create itinerary` and paste the `database_id` into `wrangler.jsonc`.
     3. `npx wrangler d1 migrations apply itinerary --remote`.
     4. Optionally `node tools/write-token-hash.mjs --new-salt`, pasted into `public/js/config.js`.
     5. `node tools/write-token-hash.mjs`, then `npx wrangler secret put TOKEN_HASH`.
     6. `npm run deploy`.
  4. Local development: `.dev.vars` containing `TOKEN_HASH=…`, `npx wrangler d1 migrations apply itinerary --local`, `npm run dev`.
  5. Seeding: `node tools/extract-seed.mjs "<path>/Itinerary.html"`, then open the app, unlock, and import `seed/itinerary.json`. Then delete `seed/` if you like.
  6. Installing on Android: open the URL in Chrome, choose ⋮ → Install app, unlock once, then check More → Storage shows protected.
  7. Changing the passphrase (spec §3.1 steps, verbatim).
  8. Tests: `npm test`.
  9. The acceptance checklist (spec §10.2, copied verbatim).
- [ ] **Step 2: run the full test suite.** `npm test`. Expected: all pass.
- [ ] **Step 3: whole-branch review** with a fresh reviewer (superpowers:requesting-code-review), then fix the findings.
- [ ] **Step 4: commit.**
