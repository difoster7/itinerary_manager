import { endsAfterMidnight } from "./model.js";

const te = new TextEncoder();
const escText = (s) =>
  String(s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
const utc = (d) =>
  d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const ymd = (iso) => iso.replace(/-/g, "");
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// RFC 5545: lines are at most 75 octets; continuations start with a space.
function fold(line) {
  const out = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = te.encode(ch).length;
    if (bytes + n > 75) {
      out.push(cur);
      cur = " ";
      bytes = 1;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

export function eventToIcs(e, tz, now = new Date()) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//itinerary//EN",
    "BEGIN:VEVENT",
    `UID:${e.id}@itinerary`,
    `DTSTAMP:${utc(now)}`,
  ];
  if (e.time) {
    const start = new Date(`${e.date}T${e.time}:00${tz}`);
    const endDate = endsAfterMidnight(e) ? addDays(e.date, 1) : e.date;
    const end = e.end
      ? new Date(`${endDate}T${e.end}:00${tz}`)
      : new Date(start.getTime() + 3600_000);
    lines.push(`DTSTART:${utc(start)}`, `DTEND:${utc(end)}`);
  } else {
    lines.push(
      `DTSTART;VALUE=DATE:${ymd(e.date)}`,
      `DTEND;VALUE=DATE:${ymd(addDays(e.date, 1))}`,
    );
  }
  lines.push(`SUMMARY:${escText(e.title)}`);
  if (e.where) lines.push(`LOCATION:${escText(e.where)}`);
  // The confirmation code is deliberately left out: it ends up at Google.
  const desc = [e.sub, ...(e.notes || [])].filter(Boolean).join("\n");
  if (desc) lines.push(`DESCRIPTION:${escText(desc)}`);
  lines.push(
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Reminder",
    "TRIGGER:-PT60M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  );
  return lines.map(fold).join("\r\n") + "\r\n";
}

export const icsFilename = (e) => {
  const slug = e.title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${e.date}-${slug}.ics`;
};
