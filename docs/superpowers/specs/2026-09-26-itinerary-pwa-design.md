# Trip Itinerary PWA: Design Spec

Date: 2026-09-26. Supersedes the open parts of `itinerary-app-brief.md` (gitignored, local only).

## 1. Goal and constraints

- One-tap home-screen app (installable PWA) for a solo trip, **Nov 13–29, 2026**.
- Primary device: Android phone, Chrome. Secondary: Windows PC, Chrome (used for planning, so it must be fully usable, not just a fallback).
- **Reading must work fully offline**, including a 5-day no-signal stretch (Nov 18–22).
- Itinerary edits need a connection. **Day notes work fully offline** (append-only outbox).
- Only ciphertext leaves the device. The repo holds code only; plaintext data is never committed.
- Target: running on the phone with fake data by **~Oct 20, 2026**.

### Non-goals

- Offline itinerary edits, sync/merge of the itinerary.
- Multiple users, sharing, accounts.
- Frontend frameworks or a build step (vanilla JS modules).
- Push notifications (a web app can't raise alarms offline; per-event calendar export replaces them).
- Open-items checklist and the event `todo` flag (both dropped).
- Custom domain.

## 2. Architecture

A single Cloudflare **Worker with static assets** plus **D1**. Chosen over Pages Functions because it is Cloudflare's current recommended path for new projects, has one config file, and binds D1 the same way. D1 was chosen over KV because KV is eventually consistent (~60 s), which breaks the compare-and-swap needed for 409 conflict detection.

```
wrangler.jsonc              Worker + assets (public/) + D1 binding "DB"
src/worker.js              API routes
migrations/0001_init.sql   D1 schema
public/
  index.html  styles.css  sw.js  manifest.webmanifest  icons/
  js/ config.js  crypto.js  api.js  store.js  render.js  edit.js  notes.js  export.js  app.js
tools/
  write-token-hash.mjs     prints salt (on first run) and TOKEN_HASH
  extract-seed.mjs         Itinerary.html -> seed/itinerary.json (local only)
test/                      Vitest
```

Node is needed only for Wrangler, the tools, and tests. `.gitignore` covers `Itinerary.html`, `itinerary-app-brief.md`, `seed/`, `.wrangler/`, `.dev.vars`, `node_modules/` and `.superpowers/`.

### 2.1 D1 schema

```sql
CREATE TABLE versions (
  version    INTEGER PRIMARY KEY,
  blob       TEXT NOT NULL,          -- JSON {v, iv, ct}, base64
  updated_at TEXT NOT NULL           -- ISO 8601 UTC
);
CREATE TABLE notes (
  id         TEXT PRIMARY KEY,       -- UUID generated on device
  blob       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

- Current itinerary = row with the highest `version`. The other rows are the history.
- **Save:** a single statement inserts `version = N+1` only if `MAX(version) = N`
  (`INSERT INTO versions SELECT ?,?,? WHERE (SELECT COALESCE(MAX(version),0) FROM versions) = ?`).
  If zero rows changed, return 409. After a successful save, delete rows older than the newest 50.
- **Notes:** `INSERT OR IGNORE`, so re-uploading is idempotent. Deletes are separate encrypted records (see 4.2); the server can't tell notes from deletes.

### 2.2 API

Every endpoint requires `Authorization: Bearer <token>`; otherwise it returns 401. Request and response bodies are never logged.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/itinerary` | 200 `{version, blob, updatedAt}`, or 404 if empty |
| PUT | `/api/itinerary` | Header `If-Match: <N>` (0 for first save); body `{blob}`. 200 `{version, updatedAt}`, or 409 `{version}` on mismatch, or 400 on malformed input |
| GET | `/api/history` | 200 `[{version, updatedAt}]`, newest first |
| GET | `/api/history/:v` | 200 `{version, blob, updatedAt}`, or 404 |
| GET | `/api/notes` | 200 `[{id, blob, createdAt}]` (all; volume is tiny) |
| POST | `/api/notes` | body `[{id, blob, createdAt}]`; insert or ignore; 200 `{ok:true}` |

Input validation: blob is a string ≤ 1 MB; note ids are UUIDs; batch ≤ 200 notes.

## 3. Encryption and access

Web Crypto only; no dependencies.

```
passphrase -PBKDF2-SHA256, 600,000 iterations, SALT-> 256-bit master
master -HKDF-SHA256(info "enc-v1")-> AES-GCM-256 encKey (non-extractable)
master -HKDF-SHA256(info "auth-v1")-> 32-byte token
```

- `SALT` (16 random bytes, base64) lives in `public/js/config.js` and is committed. It is public by design. The device needs it *before* it can authenticate, so it can't live inside encrypted data. `tools/write-token-hash.mjs` generates it.
- **Blob format:** `{v:1, iv, ct}`, base64, with a fresh random 96-bit IV on every encryption. The itinerary and each note use the same format.
- **Server auth:** the Worker holds the secret `TOKEN_HASH = SHA-256(token)` (hex). It hashes the presented token and compares with `crypto.subtle.timingSafeEqual`. The server cannot derive `encKey`.
- Requiring the token on reads means nobody can download the ciphertext to brute-force the passphrase offline.
- **Device storage (IndexedDB):** `encKey` (non-extractable CryptoKey) and the token. The passphrase is typed once per device.
- **First unlock:** requires a connection. The device derives the keys and GETs `/api/itinerary`. A 401 means "Wrong passphrase". A 404 opens the Import screen.
- **Forget this device** (More tab): clears IndexedDB and Cache Storage, then shows the lock screen.
- `tools/write-token-hash.mjs` imports `public/js/crypto.js`, so its derivation can't drift from the app's.

### 3.1 Passphrase change (manual, documented in README)

1. In the app, download the plaintext itinerary and notes as JSON (raw editor → Download).
2. Run the tool with the new passphrase to get a new salt and hash.
3. Update `config.js`, run `wrangler secret put TOKEN_HASH`, empty both D1 tables, and deploy.
4. On each device: Forget this device → unlock with the new passphrase → Import.

History is lost; accepted.

## 4. Offline and sync

### 4.1 Service worker and cached data

- `sw.js` precaches the app shell (HTML, JS, CSS, manifest, icons) under a versioned cache name (`shell-<APP_VERSION>`), served cache-first. A new worker installs in the background and takes over on the next cold launch; there is no `skipWaiting` mid-session.
- API responses are **not** cached by the service worker. The app stores the latest itinerary blob and all note blobs (still encrypted) in IndexedDB, and decrypts only in memory.
- **Launch:** render from IndexedDB immediately, then fetch. If `version` changed, re-render and show an "Updated" toast. The app also refreshes on `visibilitychange` → visible and on the `online` event. There is no polling.
- After the first unlock, call `navigator.storage.persist()`. The More tab shows "Storage: protected" or "Storage: may be cleared by Chrome".

### 4.2 Connectivity state

- **Offline** means `navigator.onLine === false` **or** the most recent request failed with a network error. It stays offline until a request succeeds.
- The header shows "Synced <relative time>" or "Offline · synced <relative time>".
- While offline, itinerary Save is disabled and a banner is shown. If a save fails mid-request, the form keeps the edit.

### 4.3 Notes (offline-capable, append-only)

- Plaintext note record: `{date, text, createdAt}`. A delete record is `{del: <noteId>, createdAt}`.
- **Create:** encrypt immediately, then write to the local `notes` store and the `outbox` store. The note renders at once with a "● queued" tag.
- **Outbox flush:** POST the outbox on launch, on visible, on `online`, and right after a new note is created. On 200, remove the sent items. The app also registers a Background Sync `sync` event, so the service worker can flush with the app closed. The outbox holds ciphertext, so the service worker needs only the token.
- **Fetch:** GET all notes and union them into the local store by `id`.
- **Render:** decrypt, drop records whose id appears in any `del` record, show the rest oldest first.
- No editing; delete and re-add. Notes belong to a single date.

### 4.4 Conflicts (409)

- Events carry a stable `id` (UUID assigned at import or creation).
- Each event-sheet save is one change: `upsert(event)` or `delete(id)`. On 409: fetch the latest, re-apply that change by `id`, and show "Changed on another device. Your change was re-applied. [Save] [Discard mine]".
  - If the same event id changed on both sides (the event's value in the latest version differs from its value in the version the edit started from), show both versions and let the user pick one before saving.
- The night editor works the same way, keyed by date.
- The raw JSON editor on 409 shows "Changed on another device. Reload?"; the text stays in the editor.
- A save never overwrites silently.

## 5. Data format

Plaintext (encrypted before leaving the device):

```js
{
  title: "Patagonia & Buenos Aires",
  subtitle: "Solo trip · …",
  tz: "-03:00",                           // trip-wide UTC offset, used for .ics
  cities: { "2026-11-18": "W Trek · Day 1", … },
  nights: { "2026-11-18": { name, sub }, … },
  events: [ { id, date, time, end, kind, title, sub, where, conf, notes: [] } ],
  costs:  [ [item, amount, note], … ]
}
// kind: flight | bus | transfer | stay | trek | activity | food | show | note
// time "" = all-day. Required: id, date, kind, title.
```

Validation before any save: required fields present, `date` is `YYYY-MM-DD`, times are `HH:MM` or empty, `kind` is in the list, `notes` is an array of strings.

## 6. UI

Direction "B, revised" (see mockups in `.superpowers/brainstorm/`). The original palette carries over as CSS custom properties with light/dark via `prefers-color-scheme`; system fonts; no external resources; no horizontal scroll at 390 px.

### 6.1 Structure

Bottom tabs on the phone: **Trip · Notes · Codes · More**.

- **Trip:** one day per screen.
  - **Header:** date, "Day N of M", city, sync status.
  - **Progress bar:** one segment per day; tap one to jump to that day.
  - **Timeline:** all-day items first ("All day"), then items by time.
  - **Today's screen only:**
    - Past items (their `end`, else `time`, is before now) fade.
    - The next upcoming item gets an accent ring and a "NEXT · IN 20 MIN" label, updated each minute.
    - An item in progress (`time` ≤ now < `end`) is labeled "NOW" instead.
  - Below the timeline: the night row, then the day's **notes list** (always expanded).
  - **Changing day:** horizontal swipe (pointer events with a threshold; vertical scroll is not hijacked); ← → keys on desktop.
  - **Opening day:** today during the trip; day 1 before it; the last day after it.
- **Notes:** all notes grouped by day.
- **Codes:** every event with a `conf`, sorted by date and time, de-duplicated by conf + title; tap to copy.
- **More:**
  - **Overview:** status chips computed from data (nights covered, counts by kind) and the costs table.
  - **History.**
  - **Advanced:** cities and costs raw-JSON editors, and the full raw JSON editor.
  - **Tools:** Download snapshot, Print, storage status, Forget this device, app version.

### 6.2 Buttons and sheets

- **+** (primary floating button) opens a blank event sheet dated to the viewed day. It is disabled while offline.
- **✎ Note** (a separate pill above it) opens the note sheet for the viewed day. It works offline.
- **Tap an event:** opens the event sheet with fields date, time, end, kind (select), title, sub, where, conf, and notes (repeatable). Actions: **Save · Delete · Add to calendar**. Offline, the sheet is read-only with Save and Delete disabled; Add to calendar still works.
- **Tap the conf chip:** copies the code and does not open the sheet.
- **Tap the night row:** opens the night sheet (name, sub, or clear).
- **Tap a note:** copies its text. **Long-press a note:** delete, after confirmation.

### 6.3 Desktop (≥ 900 px)

- Two panes. The left pane lists every day (date, city, one-line event preview) and highlights the selected day. The right pane shows the selected day's timeline, night row and notes.
- The "✎ Note" and "+ Event" buttons sit in the right pane header. Sheets render as centered dialogs.

### 6.4 Other screens

- **Lock:** passphrase field and Unlock; a spinner during key derivation.
- **Import** (shown only when the database is empty): pick `seed/itinerary.json`, validate, encrypt, save as version 1.
- **History:**
  - A list of versions (number, time, summary such as "38 events · 16 nights"). Each version is fetched and decrypted when the list opens.
  - Tap one for a read-only preview (the snapshot renderer).
  - **Restore** saves it as a new version through the normal save path.

### 6.5 Rendering safety

All user text goes through `esc()`. There is no user-controlled HTML anywhere.

## 7. Export

- **Download snapshot:**
  - `Itinerary-snapshot-YYYY-MM-DD.html`, plaintext by design.
  - Every day stacked (the original single-page layout), each followed by its notes, then the codes table and costs table.
  - Inline CSS plus a small inline script (tap-to-copy, TODAY highlight). No external resources.
- **Print:** the same renderer in-app plus `window.print()`. Print CSS starts the codes table on a new page (the condensed confirmations page).
- **Add to calendar:** a single-event `.ics` download.
  - `DTSTART`/`DTEND` converted to UTC from `tz`; no `end` means +1 h; an all-day event uses `VALUE=DATE`.
  - `SUMMARY` = title, `LOCATION` = where, `DESCRIPTION` = sub + notes. **`conf` is never included.**
  - `UID` = `<event id>@itinerary`. One `VALARM` 60 min before.

## 8. Seed and import

1. `node tools/extract-seed.mjs "<path>/Itinerary.html"` reads the file and evaluates the `NIGHTS`, `CITIES`, `EVENTS` and `COSTS` declarations with `node:vm` in an empty context.
2. It adds an `id` to every event, removes `todo`, ignores `OPEN_ITEMS`, sets `title`, `subtitle` and `tz`, validates the result, and writes `seed/itinerary.json` (gitignored).
3. The app's Import screen encrypts the file and saves it as version 1.

Plaintext never reaches the server or git.

## 9. PWA

- `manifest.webmanifest`: name and short_name, `display: standalone`, `start_url: "/"`, and theme and background colors from the palette.
- Icons: 192 and 512 PNG, plus a 512 maskable.
- Must meet Chrome's install criteria on Android so the browser offers "Install app".

## 10. Testing

### 10.1 Automated (Vitest, dev dependencies only)

- **Worker** (`@cloudflare/vitest-pool-workers`, local D1):
  - 401 for a missing or wrong token.
  - 404 when the database is empty.
  - A first PUT with `If-Match: 0` creates version 1.
  - A stale `If-Match` returns 409 and leaves D1 unchanged.
  - History is pruned to 50 versions.
  - Posting the same notes twice has no effect.
  - Malformed input returns 400.
- **Client modules in Node** (pure functions; render returns HTML strings):
  - Encryption round trip; a wrong key fails; token derivation is deterministic.
  - Re-applying a change after a 409, including the case where both sides edited the same event.
  - Note delete filtering.
  - Next and NOW selection.
  - Day ordering and the opening-day choice.
  - `.ics` output (UTC conversion, all-day events, conf excluded).
  - `esc()`.
  - Data validation.
  - Seed extraction against a fake fixture file.

### 10.2 Manual acceptance (real Android phone)

- [ ] Install from Chrome: the icon is on the home screen and opens standalone.
- [ ] A wrong passphrase shows a clear error; after a correct unlock, relaunching doesn't prompt.
- [ ] More tab shows "Storage: protected".
- [ ] **Airplane mode, cold launch:** the full itinerary renders, tap-to-copy works, and the TODAY/NEXT highlight works.
- [ ] Airplane mode: event Save is disabled and the banner shows; Add to calendar still works.
- [ ] Airplane mode: add a note; it shows "queued". Reconnect; it syncs and appears on the PC.
- [ ] Add a note offline, close the app, reconnect: Background Sync uploads it without the app open.
- [ ] Online: add a dinner on the phone; it appears on the PC after a refresh, and the reverse.
- [ ] A stale edit (the other device saved first) is handled cleanly, with no silent overwrite.
- [ ] A request without a token or with a wrong one returns 401, and D1 is unchanged.
- [ ] The D1 dashboard shows only ciphertext.
- [ ] A downloaded snapshot opens offline on the PC and matches the live data, notes included.
- [ ] Restoring a previous version works.
- [ ] An `.ics` file opens in the Calendar app with the correct local time and no conf code. Check whether the 60-min reminder survives.
- [ ] Swiping between days doesn't interfere with vertical scroll.
- [ ] The desktop two-pane layout is usable for planning edits.
- [ ] Light and dark modes both look right; no horizontal scroll at 390 px.

Phone testing uses the real `*.workers.dev` deployment with **fake data** first. Then empty D1 and import the real seed.

## 11. Deliverables

1. The repo as laid out in §2.
2. `README.md`:
   - Cloudflare account and `wrangler login`.
   - `wrangler d1 create` and running the migration.
   - Running the setup tool, `wrangler secret put TOKEN_HASH`, and `wrangler deploy`.
   - Seeding and import.
   - Installing on Android.
   - The passphrase-change procedure.
   - Running the tests.
3. `tools/write-token-hash.mjs` and `tools/extract-seed.mjs`.
4. The acceptance checklist in §10.2.
