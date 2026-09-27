export const KINDS = [
  "flight",
  "bus",
  "transfer",
  "stay",
  "trek",
  "activity",
  "food",
  "show",
  "other",
  "note",
];
export const KIND_LABEL = {
  flight: "Flight",
  bus: "Bus",
  transfer: "Transfer",
  stay: "Lodging",
  trek: "Trek",
  activity: "Activity",
  food: "Food",
  show: "Event",
  other: "Other",
  note: "",
};

const ESC = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);

export function validateItinerary(d) {
  if (!isObj(d)) return ["Itinerary must be an object"];
  const errs = [];
  for (const k of ["cities", "nights"]) {
    if (!isObj(d[k])) errs.push(`${k} must be an object`);
  }
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
    if (typeof e.title !== "string" || !e.title.trim()) {
      errs.push(`${at}: title required`);
    }
    const notesOk =
      e.notes === undefined ||
      (Array.isArray(e.notes) && e.notes.every((n) => typeof n === "string"));
    if (!notesOk) errs.push(`${at}: notes must be a list of text`);
  });
  if (isObj(d.nights)) {
    for (const [k, n] of Object.entries(d.nights)) {
      if (!DATE.test(k) || !isObj(n) || !n.name) {
        errs.push(`Night ${k}: needs a date key and a name`);
      }
    }
  }
  // Renderers destructure these, so malformed values would break every tab.
  if (isObj(d.cities)) {
    for (const [k, c] of Object.entries(d.cities)) {
      if (typeof c !== "string") errs.push(`City ${k}: must be text`);
    }
  }
  if (Array.isArray(d.costs)) {
    d.costs.forEach((row, i) => {
      const cellOk = (c) => ["string", "number"].includes(typeof c);
      if (!Array.isArray(row) || !row.every(cellOk)) {
        errs.push(`Cost row ${i + 1}: must be a list of text or numbers`);
      }
    });
  }
  if (
    d.settings !== undefined &&
    (!isObj(d.settings) ||
      !["undefined", "string"].includes(typeof d.settings.anthropicKey))
  ) {
    errs.push("settings must be an object with a text anthropicKey");
  }
  if (d.tz !== undefined && !/^[+-]\d{2}:\d{2}$/.test(d.tz)) {
    errs.push('tz must look like "-03:00"');
  }
  return errs;
}

export const ensureIds = (d) => ({
  ...d,
  events: d.events.map((e) => (e.id ? e : { ...e, id: crypto.randomUUID() })),
});

export const tripDates = (d) =>
  [
    ...new Set([...Object.keys(d.nights), ...d.events.map((e) => e.date)]),
  ].sort();

export function openingDate(dates, today) {
  if (!dates.length) return null;
  if (today <= dates[0]) return dates[0];
  return dates.find((x) => x >= today) || dates[dates.length - 1];
}

// A resumed app should follow the calendar: once the date changes, jump to
// the day the app would open on; otherwise keep the day being viewed.
export const resumeDate = (dates, current, lastToday, today) =>
  today === lastToday ? current : openingDate(dates, today);

export const dayEvents = (d, iso) =>
  d.events
    .filter((e) => e.date === iso)
    .sort(
      (a, b) =>
        (a.time || "").localeCompare(b.time || "") ||
        a.title.localeCompare(b.title),
    );

export const endsAfterMidnight = (e) => !!(e.end && e.time && e.end <= e.time);

export function timelineState(events, now) {
  const st = {};
  let next = false;
  for (const e of events) {
    if (!e.time) continue;
    const running = endsAfterMidnight(e) || (e.end && now < e.end);
    if (e.time <= now && running) st[e.id] = "now";
    else if (e.time <= now) st[e.id] = "past";
    else if (!next) {
      st[e.id] = "next";
      next = true;
    }
  }
  return st;
}

const mins = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export function countdown(from, to) {
  const d = mins(to) - mins(from);
  const h = Math.floor(d / 60);
  const m = d % 60;
  if (!h) return `IN ${m} MIN`;
  return m ? `IN ${h} H ${m} MIN` : `IN ${h} H`;
}

export function applyChange(d, c) {
  switch (c.type) {
    case "upsert": {
      const i = d.events.findIndex((e) => e.id === c.event.id);
      const events = [...d.events];
      if (i < 0) events.push(c.event);
      else events[i] = c.event;
      return { ...d, events };
    }
    case "delete":
      return { ...d, events: d.events.filter((e) => e.id !== c.id) };
    case "night": {
      const nights = { ...d.nights };
      if (c.night) nights[c.date] = c.night;
      else delete nights[c.date];
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
  if (c.type === "upsert") {
    return d.events.find((e) => e.id === c.event.id) ?? null;
  }
  if (c.type === "delete") return d.events.find((e) => e.id === c.id) ?? null;
  if (c.type === "night") return d.nights[c.date] ?? null;
  if (c.type === "field") return d[c.key];
  return d;
}

// After a 409: re-apply the change to the latest data unless the thing it
// touches was also changed on the other device.
export function resolveConflict(base, latest, c) {
  if (c.type === "replace") return { conflict: true, merged: null };
  const same =
    JSON.stringify(changeTarget(base, c)) ===
    JSON.stringify(changeTarget(latest, c));
  return same
    ? { conflict: false, merged: applyChange(latest, c) }
    : { conflict: true, merged: null };
}

export function foldNotes(recs) {
  const gone = new Set(recs.filter((r) => r.del).map((r) => r.del));
  return recs
    .filter((r) => r.text !== undefined && !gone.has(r.id))
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
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
    .sort((a, b) =>
      (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")),
    )
    .filter((e) => {
      const k = `${e.conf}\u0000${e.title}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

export const summarize = (d) =>
  `${d.events.length} events · ${Object.keys(d.nights).length} nights`;

const eventKey = (e) =>
  e.conf
    ? `${e.conf}\u0000${e.date}\u0000${e.kind}`
    : `\u0000${e.date}\u0000${e.time || ""}\u0000${e.title}`;

// Merges extracted bookings into `d`: new events get ids, duplicates and
// already-set nights are skipped with a warning. `next` is `d` itself when
// nothing was added.
export function mergeImport(d, result) {
  const warnings = [...result.warnings];
  const seen = new Set(d.events.map(eventKey));
  const events = [];
  for (const x of result.events) {
    const e = {
      id: crypto.randomUUID(),
      date: x.date,
      time: x.time,
      kind: x.kind,
      title: x.title.trim(),
    };
    for (const k of ["end", "sub", "where", "conf"]) {
      if (x[k].trim()) e[k] = x[k].trim();
    }
    if (x.notes.length) e.notes = x.notes;
    if (seen.has(eventKey(e))) {
      warnings.push(`Already in the itinerary: ${e.title} (${e.date})`);
      continue;
    }
    seen.add(eventKey(e));
    events.push(e);
  }
  const nights = { ...d.nights };
  const addedNights = [];
  for (const { date, name, sub, kind } of result.nights) {
    if (nights[date]) {
      if (nights[date].name !== name) {
        warnings.push(
          `Night of ${date} is already "${nights[date].name}"; kept it.`,
        );
      }
      continue;
    }
    nights[date] = { name, ...(sub && { sub }), ...(kind && { kind }) };
    addedNights.push(date);
  }
  const rows = new Set(d.costs.map((r) => JSON.stringify(r)));
  const costs = [];
  for (const { item, amount, status } of result.costs) {
    const row = [item, amount, status];
    if (rows.has(JSON.stringify(row))) continue;
    rows.add(JSON.stringify(row));
    costs.push(row);
  }
  const added = { events, nights: addedNights, costs: costs.length };
  const next =
    events.length || addedNights.length || costs.length
      ? {
          ...d,
          events: [...d.events, ...events],
          nights,
          costs: [...d.costs, ...costs],
        }
      : d;
  return { next, added, warnings };
}
