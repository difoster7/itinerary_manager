# Confirmation Import: Design Spec

Date: 2026-09-26. Extends `2026-09-26-itinerary-pwa-design.md`.

## 1. Goal

Turn a booking confirmation (email text, PDF, or screenshot) into itinerary entries with one action and no manual retyping.

- **Every layout:** an **Import** button opens a sheet to paste text or choose/drop a file.
- **Android (installed app):** additionally a **share target**. Select text or open a PDF/screenshot, Share → Itinerary.
- Claude (`claude-sonnet-5`) extracts the entries. They are saved immediately as **one new version**, then a result sheet offers **Undo** and **Edit**.

### Decisions

- Sending confirmation content to the Anthropic API is acceptable.
- The browser calls the API directly with the user's key. The Worker never sees plaintext.
- The key lives inside the encrypted itinerary at `data.settings.anthropicKey`, so it syncs to every device. Old versions in history keep old keys (encrypted); that is accepted.
- Plain `fetch` to `/v1/messages`, not the SDK. The app has no build step and no browser dependencies, and `api.js` already works this way.
- Save first, review after (Undo), rather than a review screen. The user's only deliberate action is the share or paste.
- New event kind **`other`**, so a booking that fits no kind is never dropped.

### Non-goals

- iOS share (unsupported by Safari), and a forwarding email address.
- Offline extraction or queueing. Import needs a connection, like other itinerary edits.
- Applying cancellation or change notices to existing events. These produce a warning only.
- Planning items around a booking ("Head to LAX", "Land at…", unbooked transfers). The user writes those.
- Updating `cities`.

## 2. Flow

```
paste / file / share ──► source {text?, file?}
                          │
                          ▼
            extract.js: buildRequest → fetch Claude → parse
                          │  {events, nights, costs, warnings}
                          ▼
            model.js: mergeImport(data, result) → {next, added}
                          │
                          ▼
            session.commit(next, version)   (one version)
                          │
                          ▼
            result sheet: added items, warnings · Undo · Edit · Done
```

### 2.1 Entry points

- **Import button:** an `⇪ Import` pill in `.fabs` above `✎ Note`, and next to `+ Event` in the desktop right-pane header. It is disabled while offline. With no key set, tapping it explains where to set one.
- **Import sheet:**
  - A textarea, plus a file input accepting `application/pdf,image/png,image/jpeg,image/webp`.
  - On desktop, files can also be dropped on the sheet, and an image pasted from the clipboard (Ctrl+V) is taken as the file.
  - If both text and a file are given, both are sent.
  - Files over 20 MB are rejected with a message.
- **Share target:**
  - `manifest.webmanifest` gets:
    ```json
    "share_target": {
      "action": "/share", "method": "POST", "enctype": "multipart/form-data",
      "params": { "title": "title", "text": "text",
        "files": [{ "name": "file",
          "accept": ["application/pdf", "image/png", "image/jpeg", "image/webp"] }] }
    }
    ```
  - `sw.js` handles `POST /share`: it reads the form data, stores `{title, text, file, at}` in IndexedDB `kv` under `"share"`, and responds `303 → /?shared=1`.
  - On launch, once unlocked and online, `app.js` checks for `kv/"share"`, deletes it, and runs the pipeline with a "Reading confirmation…" sheet.
  - If the app is offline, the share is kept and the sheet says "Needs a connection. It will run next time you open the app online."
  - The stored share is plaintext on the device until processed. That is acceptable: it is the same device the email came from.

### 2.2 Result sheet

- Lists what was added, e.g. "2 events · 2 nights · 1 cost" plus one line per event (date, time, title), followed by any warnings.
- **Undo** commits the pre-import data on top of the import version (`commit(before, importVersion)`). On a 409 it says so and leaves the data unchanged.
- **Edit** opens the first added event's sheet. **Done** closes.
- If nothing was extracted, the sheet shows the warnings, or "No bookings found". It offers **Retry**, and **Add manually**, which opens a blank event sheet.

### 2.3 Settings

- More gets a new **Claude** section: a password-type input "Anthropic API key", with Save and Remove.
- Saving commits `settings.anthropicKey` as a normal itinerary change, which creates a version.
- The key is never rendered in the snapshot, print, or ICS. The raw JSON editor and "Download JSON" do include it, which is intended: that is the rotation path.

## 3. Modules

| File | Change |
|---|---|
| `public/js/extract.js` (new, no DOM) | `PROMPT`, `SCHEMA`, `buildRequest(source, ctx)`, `extract(source, ctx, {apiKey, fetch})` → result or throws `ExtractError(kind, message)` |
| `public/js/import.js` (new, UI) | import sheet, file/drop/paste handling, pending-share pickup, pipeline runner, result sheet, undo |
| `public/js/model.js` | `KINDS` + `"other"`, `KIND_LABEL.other = "Other"`, `mergeImport`, validate optional `settings` |
| `public/js/render.js` | `PLURAL.other = ["other item", "other items"]` |
| `public/styles.css` | `.k-other { --c: var(--note); }` |
| `public/js/app.js` | Claude settings section, share pickup on launch, install `import.js` handlers |
| `public/index.html` | Import pill and desktop header button |
| `public/sw.js` | `POST /share` handler; add `extract.js` and `import.js` to `SHELL` |
| `public/manifest.webmanifest` | `share_target` |
| `tools/try-extract.mjs` (new) | dev harness: `node tools/try-extract.mjs <file-or-.txt>` prints the parsed result using `ANTHROPIC_API_KEY`, for prompt iteration |

## 4. API call

```
POST https://api.anthropic.com/v1/messages
x-api-key: <settings.anthropicKey>
anthropic-version: 2023-06-01
anthropic-dangerous-direct-browser-access: true
content-type: application/json

{
  "model": "claude-sonnet-5",
  "max_tokens": 16000,
  "output_config": { "effort": "low",
                     "format": { "type": "json_schema", "schema": SCHEMA } },
  "system": PROMPT,
  "messages": [{ "role": "user", "content": [
    <file block, if any>,
    { "type": "text", "text": "<TRIP CONTEXT>\n\n<CONFIRMATION TEXT or 'See attached.'>" }
  ]}]
}
```

- **File block:**
  - PDF: `{type:"document", source:{type:"base64", media_type:"application/pdf", data}}`
  - Images: `{type:"image", source:{type:"base64", media_type, data}}`
  - The base64 must not contain newlines.
- **Trip context** is built in code:
  ```
  TRIP CONTEXT
  Trip dates: 2026-11-13 to 2026-11-29
  Today: 2026-09-26
  Cities by date:
  2026-11-13 <city label>
  …
  ```
- **Timeout:** 90 s via `AbortSignal.timeout`.
- **Response:**
  - `stop_reason` must be `end_turn`. `refusal` or `max_tokens` → `ExtractError("model")`.
  - Parse the first `text` block as JSON.
- **Error mapping:**

  | Condition | Message |
  |---|---|
  | `TypeError` or abort | "Offline or timed out." |
  | 401 / 403 | "API key rejected. Update it in More → Claude." |
  | 429 / 529 | "Claude is busy. Try again in a minute." |
  | 400 | "Couldn't read that file." Show the API message. |
  | other | "Import failed: <status>." |

- **Verify at implementation time:**
  - The `output_config.format` wire shape, and that `claude-sonnet-5` accepts it with `effort: "low"`.
  - The browser-access header name.
  - Whether `claude-sonnet-5` needs `thinking` set at all. Omit it unless required.

### 4.1 Output schema

The API requires `additionalProperties: false` on every object and every field listed in `required`. It does not accept `pattern`, `minLength` or similar, so formats are checked in code by `validateItinerary`.

```js
const str = { type: "string" };
SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["events", "nights", "costs", "warnings"],
  properties: {
    events: { type: "array", items: {
      type: "object", additionalProperties: false,
      required: ["date","time","end","kind","title","sub","where","conf","notes"],
      properties: { date: str, time: str, end: str,
        kind: { type: "string", enum: KINDS.filter(k => k !== "note") },
        title: str, sub: str, where: str, conf: str,
        notes: { type: "array", items: str } } } },
    nights: { type: "array", items: {
      type: "object", additionalProperties: false,
      required: ["date","name","sub","kind"],
      properties: { date: str, name: str, sub: str,
        kind: { type: "string", enum: ["", "flight"] } } } },
    costs: { type: "array", items: {
      type: "object", additionalProperties: false,
      required: ["item","amount","status"],
      properties: { item: str, amount: str, status: str } } },
    warnings: { type: "array", items: str },
  },
};
```

## 5. Prompt

This is the verbatim `PROMPT` constant. The conventions were derived from the user's existing events, in two independent passes over `seed/itinerary.json`. The example values in the prompt are made up, so no trip data enters git.

````
You turn one travel booking confirmation (email text, PDF, or screenshot)
into entries for a personal trip itinerary. You are transcribing, not
planning: every value must come from the source. When a value is not
stated, return "" for text and [] for lists. Ignore marketing, upsells,
loyalty promotions and legal text.

The user message starts with TRIP CONTEXT (trip dates, today's date, cities
by date), followed by the confirmation.

## What to produce

events: one per booked segment.
- Each flight leg is its own event. Connections and round trips produce one
  event per leg; all legs of one booking share the same conf.
- Each bus, train, ferry or transfer leg is its own event.
- Lodging produces ONE event, the check-in. Never create a check-out event.
- Tours, treks, tickets, restaurant reservations: one event each. A
  multi-day tour gets one event per day only if the source gives a per-day
  schedule; otherwise one event on the first day.
- Never add anything that is not booked in the source: no "head to the
  airport", no "land at", no airport-to-town transfer, no reminders.
- Cancellation or change notices: produce no events; describe the change in
  warnings.
- If a booking fits no kind, use kind "other". Never drop a booking.

nights:
- Lodging: one entry per night, from the check-in date through the night
  before check-out. name = property name; sub = "Street Number, City";
  kind = "".
- A flight or bus that departs on one date and arrives on a later date: one
  entry for the departure date. name = "In flight — <origin city> →
  <destination city>" (use "On the bus — …" for a bus); sub = "";
  kind = "flight" for flights, "" otherwise.

costs: one row per booking that states a total price.
- item = the event title without "Check in — " (for lodging, the property
  name).
- amount = the total, formatted per Style below.
- status = "paid" if the source says paid, charged or prepaid; "pay at
  property" or "pay on arrival" if it says so; otherwise "".

warnings: short sentences for anything the traveller must check:
conflicting values in the source, a date outside the trip dates, a page you
could not read, a currency you could not determine.

## Fields

date: YYYY-MM-DD, the local date where the event starts. If the source
omits the year, use the year that puts the date inside the trip dates; if
none does, the first such date after today.

time: 24-hour HH:MM, local time where the event starts, exactly as printed.
Never convert time zones. "" when no time is stated.
- Lodging: the check-in time if stated (the start of a check-in window);
  otherwise "".

end: 24-hour HH:MM, local time where the event ends, exactly as printed.
Flights: arrival time at the destination. Buses and transfers: arrival time
if printed. Otherwise "".
- If the arrival is on a later date than the departure, still put the
  arrival time in end and add the note "Arrives HH:MM Ddd D Mon", for
  example "Arrives 06:10 Sun 8 Mar".
- If the departure time is between 00:00 and 03:59, add the note "Departs
  just after midnight — this is the night of <weekday> the <day of month>",
  naming the previous date, for example "Departs just after midnight — this
  is the night of Saturday the 7th".

kind: exactly one of
  flight    scheduled airline flight
  bus       long-distance coach
  transfer  shuttle, taxi, private driver, train, ferry, catamaran, car
            rental pickup
  stay      hotel, hostel, refugio, campsite, apartment, any lodging
  trek      guided or multi-day hike, trek package
  activity  tour, excursion, attraction ticket, class, gear rental
  food      restaurant or food-tour reservation
  show      concert, performance, sports match, festival
  other     a booking that fits none of the above

title, sub and where depend on kind. Include only the parts the source
states, keeping the order shown and dropping empty parts with their
separator.

  flight
    title  "<airline code><flight number>  <origin IATA> → <destination
           IATA>", with TWO spaces after the flight number. Example:
           "LA800  SCL → PUQ".
    sub    "<marketing airline>, operated by <operating airline> ·
           <aircraft> · <duration as Xh Ym> · Seat <seat>". Omit
           ", operated by …" when the same airline operates. On the second
           and later legs of a connection, add "<Xh Ym> layover in <city>"
           computed from the previous leg's arrival and this leg's
           departure at the connecting airport. Example:
           "Delta, operated by LATAM · 787-9 · 9h 55m · Seat 22C".
    where  "<origin airport> Terminal <x> → <destination airport> Terminal
           <y>" when terminals are stated; otherwise "".

  bus
    title  "<operator> → <destination city>". Example:
           "Bus Sur → El Calafate".
    sub    "Seat <n>, <class> · <price> · <route detail>". Example:
           "Seat 12, semi-cama · CLP 30,000 · direct via Cerro Castillo".
    where  departure terminal name and city.

  transfer
    title  "<from> → <to>".
    sub    "<operator> · <vehicle or service type> · <price>".
    where  pickup point.

  stay
    title  "Check in — <property name>".
    sub    "<room type> · <N> nights · <total price> · <payment and refund
           terms>". Example: "Double room · 2 nights · US$300.00 ·
           non-refundable, pay at property".
    where  "<street address>, <city>  ·  <phone>", with TWO spaces on each
           side of the ·; drop the phone part if none.

  trek, activity, food, show, other
    title  the product or venue name as the provider gives it, in sentence
           case.
    sub    "<duration> · <what is included, in a few words> · <price>".
    where  meeting point or venue address.

conf: exactly one code, the one the traveller shows at check-in. Prefer the
airline record locator (PNR) over an agency or order number; the property's
reservation number over a booking site's; the operator's booking code for
buses and tours. "" if none.

notes: at most 4 items, one fact each, under 100 characters, in this
priority order:
  1. Other reference numbers as "<Label> <value>": "eTicket 0000000000000",
     "Order 1234567", "Ticket 12345 · pickup code 123", "PIN 1234".
  2. The "Arrives …" and "Departs just after midnight …" notes above.
  3. Facts needed on the day: "Seat still unassigned", "Check-in window
     12:00–24:00", amount due on arrival, free-cancellation deadline,
     baggage allowance.
  4. Meeting instructions or required documents stated by the provider.
No advice, opinions, or anything the source does not state.

## Style

- English, even when the source is in Spanish or Portuguese. Keep proper
  names as printed.
- Sentence case.
- Use these characters exactly: → for routes; a spaced — inside titles; –
  for ranges ("8–10 hrs", "12:00–24:00"); a spaced · between facts; ~ for
  approximate values.
- Money: US dollars as "US$1,234.56"; other currencies as ISO code, space,
  amount: "CLP 32,000", "ARS 45,000", "EUR 120". A bare "$" means the
  currency the source states elsewhere; if it states none, keep "$" and add
  a warning.
- Durations: flights "Xh Ym"; everything else "N hrs" or "N min".
````

## 6. Merge rules (`mergeImport(data, result)`)

A pure function. It returns `{ next, added: { events, nights, costs }, warnings }`.

- **Events:**
  - Drop the empty `end`, `sub`, `where` and `conf` fields, and empty `notes`. Keep `time: ""`, which means all day.
  - Assign `crypto.randomUUID()` ids.
  - Skip duplicates: an event with a non-empty `conf` whose `conf`, `date` and `kind` all match an existing event, or with no `conf` whose `date`, `time` and `title` match. Each skip adds a warning ("Already in the itinerary: …"), so importing the same email twice is a no-op.
- **Nights:**
  - Set only dates that are absent from `data.nights`. A date that already has a different name adds a warning; an identical name is skipped silently.
  - Drop `kind: ""` and `sub: ""`.
- **Costs:** append `[item, amount, status]`, skipping a row identical to an existing one.
- **Validation:**
  - `next` goes through `validateItinerary`. On failure nothing is saved, and the errors are shown with **Retry** and **Add manually**.
  - `validateItinerary` also checks that `settings`, if present, is an object whose `anthropicKey` is text.
- If nothing was added, no commit is made.

## 7. Testing

- **Unit tests (Vitest, no network):**
  - `extract.test.js`:
    - request headers and body (model, effort, schema, system)
    - the content blocks for text only, PDF, image, and text plus file
    - base64 without newlines
    - the trip-context string
    - response parsing
    - `stop_reason` handling
    - each error mapping (using a stub `fetch`)
  - `model.test.js`:
    - `mergeImport`: stripping empty fields, ids, each dedupe rule, nights set only when empty (plus the conflict warning), cost dedupe, validation failure, nothing-added
    - `other` passes validation
    - `settings` validation
  - `render.test.js`: an `other` event renders with the "Other" label, and Overview counts it.
- **Prompt quality (manual, with the network, outside the test suite):** run `tools/try-extract.mjs` against the original confirmation behind each existing booking in the seed (5 flight legs, 4 lodging bookings, 1 bus). Compare each result with the hand-written event in `seed/itinerary.json`. Iterate the prompt until titles, conf, times and nights match, with differences only in advisory notes. Also run one screenshot and one Spanish-language source. These inputs are private and stay out of git.
- **Acceptance (on the phone):**
  1. Share a PDF from Gmail and see the event added.
  2. Share selected email text and see the event added.
  3. Share while offline: the share is kept and processed on the next online launch.
  4. Undo removes everything that was added.
  5. Import the same email twice: the second import adds nothing.
  6. On desktop, paste text, then drop a PDF, then paste a screenshot.
