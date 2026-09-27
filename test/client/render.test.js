import { describe, it, expect } from "vitest";
import * as R from "../../public/js/render.js";

const d = {
  title: "T",
  subtitle: "S",
  tz: "-03:00",
  cities: { "2026-11-18": "W Trek · Day 1" },
  nights: {
    "2026-11-17": { name: "Refugio <b>" },
    "2026-11-18": { name: "Refugio <b>", sub: "bunk" },
  },
  costs: [["Hotel", "$1", "n"]],
  events: [
    { id: "a", date: "2026-11-18", time: "07:30", kind: "bus", title: "Bus <script>", conf: "C1" },
    { id: "b", date: "2026-11-18", time: "10:00", kind: "transfer", title: "Shuttle" },
    { id: "c", date: "2026-11-19", time: "", kind: "trek", title: "Hike" },
  ],
};
const dates = ["2026-11-17", "2026-11-18", "2026-11-19"];
const notes = [
  {
    id: "n1",
    date: "2026-11-18",
    text: "wifi <pw>",
    createdAt: "2026-11-18T12:00:00Z",
    queued: true,
  },
];
const opts = (o) => ({
  notes,
  dates,
  todayISO: "2026-11-18",
  nowHHMM: "09:40",
  syncLabel: "Synced now",
  ...o,
});

describe("renderDay", () => {
  const html = R.renderDay(d, "2026-11-18", opts());
  it("escapes all user text", () => {
    expect(html).not.toContain("<script>");
    expect(html).toContain("Bus &lt;script&gt;");
    expect(html).toContain("Refugio &lt;b&gt;");
    expect(html).toContain("wifi &lt;pw&gt;");
  });
  it("shows day N of M, city, next countdown and past state", () => {
    expect(html).toContain("Day 2 of 3");
    expect(html).toContain("W Trek · Day 1");
    expect(html).toMatch(/class="[^"]*past[^"]*"[^>]*data-id="a"/);
    expect(html).toContain("NEXT · IN 20 MIN");
  });
  it("renders copyable conf, night row with run count, queued note", () => {
    expect(html).toContain('data-copy="C1"');
    expect(html).toContain('data-night="2026-11-18"');
    expect(html).toContain("Night 2/2");
    expect(html).toContain('data-note-id="n1"');
    expect(html).toContain("queued");
  });
  it("no today states on other days; empty day message", () => {
    const other = R.renderDay(d, "2026-11-18", opts({ todayISO: "2026-11-20" }));
    expect(other).not.toContain("NEXT ·");
    expect(other).not.toMatch(/class="[^"]*past/);
    const empty = R.renderDay({ ...d, events: [] }, "2026-11-18", opts());
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
    expect(h).toContain("2 nights");
    expect(h).toContain("1 bus");
    expect(h).toContain("$1");
  });
  it("renders and counts the other kind", () => {
    const o = { ...d, events: [{ id: "o", date: "2026-11-18", time: "", kind: "other", title: "Locker" }] };
    expect(R.renderDay(o, "2026-11-18", opts())).toContain("Other");
    expect(R.renderOverview(o)).toContain("1 other item");
  });
  it("day list marks the selected day", () => {
    const h = R.renderDayList(d, dates, "2026-11-19");
    expect(h).toMatch(/class="[^"]*\bon\b[^"]*"[^>]*data-date="2026-11-19"/);
    expect(h).not.toMatch(/class="[^"]*\bon\b[^"]*"[^>]*data-date="2026-11-18"/);
  });
  it("snapshot body contains every day, notes and codes section", () => {
    const h = R.renderSnapshotBody(d, notes, "2026-11-18");
    expect(h).toContain('id="d2026-11-18"');
    expect(h).toContain('id="d2026-11-19"');
    expect(h).toContain("wifi &lt;pw&gt;");
    expect(h).toContain('class="codes');
    expect(h).not.toContain("<script>");
  });
  it("dayLabel is timezone-independent", () => {
    expect(R.dayLabel("2026-11-18")).toEqual({
      mon: "Nov",
      day: 18,
      dow: "Wednesday",
      short: "Wed",
    });
  });
});
