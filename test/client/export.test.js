import { describe, it, expect } from "vitest";
import { buildSnapshot, snapshotFilename } from "../../public/js/export.js";

const d = {
  title: "Trip <x>",
  subtitle: "S",
  tz: "-03:00",
  cities: {},
  nights: {},
  costs: [],
  events: [
    { id: "a", date: "2026-11-18", time: "07:30", kind: "bus", title: "Bus", conf: "C1" },
  ],
};
const notes = [{ id: "n", date: "2026-11-18", text: "room 412", createdAt: "x" }];

describe("snapshot", () => {
  const html = buildSnapshot(d, notes, "body{color:red}", "2026-10-01 12:00");
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
  it("filename uses the local date", () => {
    expect(snapshotFilename(new Date(2026, 9, 1))).toBe(
      "Itinerary-snapshot-2026-10-01.html",
    );
  });
});
