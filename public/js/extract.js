// Turns a booking confirmation (text, PDF or image) into itinerary entries
// with one Claude call. No DOM; the browser calls the API directly with the
// user's key, so the Worker never sees plaintext.
import { KINDS, tripDates } from "./model.js";

export const MODEL = "claude-sonnet-5";
export const MAX_BYTES = 20 * 1024 * 1024;
export const ACCEPT = ["application/pdf", "image/png", "image/jpeg", "image/webp"];

// Conventions derived from the user's hand-written events; example values
// are made up.
export const PROMPT = `You turn one travel booking confirmation (email text, PDF, or screenshot)
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
- Durations: flights "Xh Ym"; everything else "N hrs" or "N min".`;

const str = { type: "string" };
const obj = (properties) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const list = (items) => ({ type: "array", items });

export const SCHEMA = obj({
  events: list(
    obj({
      date: str,
      time: str,
      end: str,
      kind: { type: "string", enum: KINDS.filter((k) => k !== "note") },
      title: str,
      sub: str,
      where: str,
      conf: str,
      notes: list(str),
    }),
  ),
  nights: list(
    obj({ date: str, name: str, sub: str, kind: { type: "string", enum: ["", "flight"] } }),
  ),
  costs: list(obj({ item: str, amount: str, status: str })),
  warnings: list(str),
});

export class ExtractError extends Error {}

export function tripContext(d, today) {
  const dates = tripDates(d);
  const lines = [
    "TRIP CONTEXT",
    `Trip dates: ${dates.length ? `${dates[0]} to ${dates.at(-1)}` : "none yet"}`,
    `Today: ${today}`,
  ];
  const cities = Object.entries(d.cities).sort(([a], [b]) => a.localeCompare(b));
  if (cities.length) {
    lines.push("Cities by date:", ...cities.map(([k, v]) => `${k} ${v}`));
  }
  return lines.join("\n");
}

export function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// File (or Blob with a type) -> { mediaType, data }.
export async function readFile(file) {
  if (!ACCEPT.includes(file.type)) {
    throw new ExtractError("Use a PDF, PNG, JPEG or WebP file.");
  }
  if (file.size > MAX_BYTES) throw new ExtractError("File is over 20 MB.");
  return {
    mediaType: file.type,
    data: toBase64(new Uint8Array(await file.arrayBuffer())),
  };
}

// source: { text?, file?: { mediaType, data } }
export function buildRequest({ text, file }, context) {
  const content = [];
  if (file) {
    const type = file.mediaType === "application/pdf" ? "document" : "image";
    content.push({
      type,
      source: { type: "base64", media_type: file.mediaType, data: file.data },
    });
  }
  const body = text?.trim() || "The confirmation is attached.";
  content.push({ type: "text", text: `${context}\n\n${body}` });
  return {
    model: MODEL,
    max_tokens: 16000,
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: SCHEMA },
    },
    system: PROMPT,
    messages: [{ role: "user", content }],
  };
}

const httpError = (status, message) => {
  if (status === 401 || status === 403) {
    return "API key rejected. Update it in More → Claude.";
  }
  if (status === 429 || status === 529) {
    return "Claude is busy. Try again in a minute.";
  }
  if (status === 400) return `Couldn't read that: ${message}`;
  return `Import failed (${status}).`;
};

// Returns { events, nights, costs, warnings }; throws ExtractError with a
// message fit for the user.
export async function extract(
  source,
  { apiKey, context, fetch = globalThis.fetch, timeoutMs = 90000 },
) {
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify(buildRequest(source, context)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ExtractError("Offline or timed out.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ExtractError(httpError(res.status, body.error?.message || ""));
  }
  if (body.stop_reason === "refusal") {
    throw new ExtractError("Claude declined to read this.");
  }
  if (body.stop_reason === "max_tokens") {
    throw new ExtractError("The reply was cut off. Try a shorter source.");
  }
  const text = body.content?.find((b) => b.type === "text")?.text;
  try {
    return JSON.parse(text);
  } catch {
    throw new ExtractError("Claude's reply wasn't valid JSON.");
  }
}
