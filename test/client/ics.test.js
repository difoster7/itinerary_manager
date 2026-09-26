import { describe, it, expect } from "vitest";
import { eventToIcs, icsFilename } from "../../public/js/ics.js";

const NOW = new Date("2026-10-01T12:00:00Z");
const base = {
  id: "e1",
  date: "2026-11-18",
  kind: "bus",
  title: "Bus to Laguna Amarga",
};
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
    const e = { ...base, time: "22:00", end: "06:00" };
    const l = lines(eventToIcs(e, "-03:00", NOW));
    expect(l).toContain("DTSTART:20261119T010000Z");
    expect(l).toContain("DTEND:20261119T090000Z");
  });
  it("all-day uses VALUE=DATE and next-day end", () => {
    const e = { ...base, time: "", date: "2026-11-30" };
    const l = lines(eventToIcs(e, "-03:00", NOW));
    expect(l).toContain("DTSTART;VALUE=DATE:20261130");
    expect(l).toContain("DTEND;VALUE=DATE:20261201");
  });
  it("never includes the confirmation code; escapes text", () => {
    const s = eventToIcs(
      {
        ...base,
        time: "07:30",
        conf: "SECRET99",
        where: "Av. X, 123; gate 3",
        sub: "Seat 4A",
        notes: ["Line one", "Line, two"],
      },
      "-03:00",
      NOW,
    );
    expect(s).not.toContain("SECRET99");
    const l = lines(s);
    expect(l).toContain("LOCATION:Av. X\\, 123\\; gate 3");
    expect(l).toContain("DESCRIPTION:Seat 4A\\nLine one\\nLine\\, two");
  });
  it("uses CRLF and folds long lines to <= 75 octets", () => {
    const e = { ...base, time: "07:30", sub: "ñ".repeat(200) };
    const s = eventToIcs(e, "-03:00", NOW);
    expect(s.endsWith("\r\n")).toBe(true);
    for (const line of s.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(lines(s)).toContain(`DESCRIPTION:${"ñ".repeat(200)}`);
  });
});

it("icsFilename slugifies", () => {
  const e = { date: "2026-11-18", title: "Bus → Laguna Amarga!" };
  expect(icsFilename(e)).toBe("2026-11-18-bus-laguna-amarga.ics");
});
