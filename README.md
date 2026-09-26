# Trip Itinerary PWA

An installable, offline-first trip itinerary for one person. The browser encrypts everything with a key derived from your passphrase. The server (a Cloudflare Worker with a D1 database) stores only ciphertext and a hash of an access token, so it cannot read your data.

Design: `docs/superpowers/specs/2026-09-26-itinerary-pwa-design.md`.

## How it fits together

- `public/`: the app. Plain ES modules with no build step; the browser loads them directly.
- `src/worker.js`: a small JSON API under `/api/*`, backed by D1. Everything else is served as static files.
- `public/sw.js`: the service worker, which caches the app so it opens offline. The Worker stamps each deployment's id into it, so every deploy triggers an app update. The update applies the next time the app is fully closed and reopened.
- `tools/`: local helpers (token hash, seed extraction, icon generation).

Your data never enters git. `Itinerary.html`, `seed/` and `.dev.vars` are gitignored.

## Prerequisites

- Node 20+ (24 was used here) and npm.
- A Cloudflare account. The free plan is enough.

## One-time setup

```sh
npm install
npx wrangler login                       # opens a browser to authorize Wrangler
npx wrangler d1 create itinerary         # prints a database_id
```

1. Paste the `database_id` into `wrangler.jsonc` (replacing the zeros).
2. Create the tables:
   ```sh
   npx wrangler d1 migrations apply itinerary --remote
   ```
3. (Optional) Generate your own salt and paste it into `public/js/config.js`. The committed salt is random and fine to keep; a salt is public by design.
   ```sh
   node tools/write-token-hash.mjs --new-salt
   ```
4. Choose a passphrase (a 6+ word diceware phrase), then compute the server-side token hash. The prompt echoes your input, so clear the terminal afterwards.
   ```sh
   node tools/write-token-hash.mjs
   npx wrangler secret put TOKEN_HASH       # paste the printed hash
   ```
5. Deploy:
   ```sh
   npm run deploy
   ```
   The app is served at `https://itinerary.<your-subdomain>.workers.dev`.

## Seeding your data

1. Extract the data blocks from the old single-file itinerary. The output is plaintext and stays in the gitignored `seed/` folder.
   ```sh
   node tools/extract-seed.mjs "<path>/Itinerary.html"   # writes seed/itinerary.json
   ```
2. Open the app and unlock it with your passphrase. An empty database shows the Import screen.
3. Choose `seed/itinerary.json`. It's encrypted in the browser and saved as version 1.
4. Delete `seed/` if you like.

**Test with fake data first.** `node tools/extract-seed.mjs test/fixtures/sample-itinerary.html seed/sample.json` produces a small fake seed. To reset afterwards:

```sh
npx wrangler d1 execute itinerary --remote --command "DELETE FROM versions; DELETE FROM notes;"
```

Then use More → Forget this device on each device and import the real seed.

## Installing on Android

1. Open the app URL in Chrome.
2. Choose ⋮ → **Install app** (not "Add to Home screen").
3. Open the app from the home screen and unlock it once while online.
4. Check that More → the line at the bottom says **Storage: protected**. If it says "may be cleared", open the installed app a few more times; Chrome grants persistence to installed apps it sees used.

## Local development

```sh
node tools/write-token-hash.mjs          # use a throwaway passphrase
echo "TOKEN_HASH=<hash>" > .dev.vars     # gitignored
npx wrangler d1 migrations apply itinerary --local
npm run dev                              # http://localhost:8787
```

`localhost` counts as a secure origin, so Web Crypto and the service worker work without HTTPS.

## Changing the passphrase

1. In the app, download the plaintext itinerary and notes as JSON (More → Raw JSON → Download JSON).
2. Run `node tools/write-token-hash.mjs --new-salt` and paste the result into `public/js/config.js`. Then run `node tools/write-token-hash.mjs` with the new passphrase.
3. Run `npx wrangler secret put TOKEN_HASH` with the new hash, then empty both D1 tables (command above), then `npm run deploy`.
4. On each device: More → Forget this device → unlock with the new passphrase → Import the downloaded JSON.

Version history is lost; that's accepted.

## Tests

```sh
npm test             # both suites
npm run test:client  # pure client modules, in Node
npm run test:worker  # API tests inside the Workers runtime with a local D1
```

## Acceptance checklist (real Android phone)

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

Tip: before the trip, add a throwaway event for today to see the TODAY/NEXT highlight, then delete it.
