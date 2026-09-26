import { describe, it, expect } from "vitest";
import * as M from "../../public/js/model.js";

const ev = (o) => ({
  id: o.id || o.title,
  date: "2026-11-18",
  kind: "activity",
  time: "",
  title: "t",
  ...o,
});
const data = (events = [], extra = {}) => ({
  title: "T",
  subtitle: "S",
  tz: "-03:00",
  cities: {},
  nights: {},
  costs: [],
  events,
  ...extra,
});

describe("esc", () => {
  it("escapes HTML-significant characters", () => {
    expect(M.esc(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
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
    const errs = M.validateItinerary(data([ev({ title: "x", ...o })]));
    expect(errs.length).toBeGreaterThan(0);
  });
  it("rejects duplicate ids", () => {
    const errs = M.validateItinerary(data([ev({ id: "a" }), ev({ id: "a" })]));
    expect(errs.length).toBe(1);
  });
  it("rejects bad nights", () => {
    const bad = data([], { nights: { "2026-11-18": { sub: "no name" } } });
    expect(M.validateItinerary(bad).length).toBe(1);
  });
  it("rejects non-object top-level sections", () => {
    expect(M.validateItinerary({ ...data(), nights: [] }).length).toBeGreaterThan(0);
    expect(M.validateItinerary({ ...data(), costs: {} }).length).toBeGreaterThan(0);
    expect(M.validateItinerary(null).length).toBeGreaterThan(0);
  });
});

describe("dates", () => {
  const d = data(
    [ev({ date: "2026-11-15" }), ev({ date: "2026-11-20", id: "b" })],
    { nights: { "2026-11-13": { name: "H" }, "2026-11-18": { name: "R" } } },
  );
  it("tripDates merges nights and events, sorted and unique", () => {
    expect(M.tripDates(d)).toEqual([
      "2026-11-13",
      "2026-11-15",
      "2026-11-18",
      "2026-11-20",
    ]);
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
  const day = M.dayEvents(data(evs), "2026-11-18");
  it("orders all-day first then by time, only that date", () => {
    expect(day.map((e) => e.id)).toEqual(["z", "a", "b", "c"]);
  });
  it("marks past and next", () => {
    expect(M.timelineState(day, "09:40")).toEqual({ a: "past", b: "next" });
  });
  it("marks now when inside [time, end)", () => {
    expect(M.timelineState(day, "10:10")).toEqual({
      a: "past",
      b: "now",
      c: "next",
    });
  });
  it("an event without end is past once its time has passed", () => {
    expect(M.timelineState(day, "11:01")).toMatchObject({ c: "past" });
  });
  it("overnight event (end <= time) is now after it starts", () => {
    const o = [ev({ id: "o", time: "22:00", end: "06:00" })];
    expect(M.endsAfterMidnight(o[0])).toBe(true);
    expect(M.timelineState(o, "21:00")).toEqual({ o: "next" });
    expect(M.timelineState(o, "23:30")).toEqual({ o: "now" });
  });
  it("countdown formats", () => {
    expect(M.countdown("09:40", "10:00")).toBe("IN 20 MIN");
    expect(M.countdown("17:30", "20:30")).toBe("IN 3 H");
    expect(M.countdown("08:50", "10:00")).toBe("IN 1 H 10 MIN");
  });
});

describe("changes and conflicts", () => {
  const base = data([ev({ id: "a", title: "A" }), ev({ id: "b", title: "B" })], {
    nights: { "2026-11-18": { name: "R" } },
  });
  const up = (o) => ({ type: "upsert", event: ev(o) });
  it("upsert replaces by id or appends, without mutating", () => {
    const d1 = M.applyChange(base, up({ id: "a", title: "A2" }));
    expect(d1.events.map((e) => e.title)).toEqual(["A2", "B"]);
    const d2 = M.applyChange(base, up({ id: "c", title: "C" }));
    expect(d2.events).toHaveLength(3);
    expect(base.events).toHaveLength(2);
  });
  it("delete removes by id", () => {
    const d1 = M.applyChange(base, { type: "delete", id: "a" });
    expect(d1.events.map((e) => e.id)).toEqual(["b"]);
  });
  it("night sets and clears", () => {
    const set = { type: "night", date: "2026-11-19", night: { name: "H" } };
    expect(M.applyChange(base, set).nights["2026-11-19"]).toEqual({ name: "H" });
    const clear = { type: "night", date: "2026-11-18", night: null };
    expect(M.applyChange(base, clear).nights).toEqual({});
  });
  it("field and replace", () => {
    const f = { type: "field", key: "costs", value: [["a", "b", "c"]] };
    expect(M.applyChange(base, f).costs).toEqual([["a", "b", "c"]]);
    const other = data([]);
    expect(M.applyChange(base, { type: "replace", data: other })).toEqual(other);
  });
  it("unknown change type throws TypeError", () => {
    expect(() => M.applyChange(base, { type: "nope" })).toThrow(TypeError);
  });
  it("re-applies when the other device changed a different event", () => {
    const latest = M.applyChange(base, up({ id: "b", title: "B-remote" }));
    const r = M.resolveConflict(base, latest, up({ id: "a", title: "A-local" }));
    expect(r.conflict).toBe(false);
    expect(r.merged.events.map((e) => e.title)).toEqual(["A-local", "B-remote"]);
  });
  it("reports a conflict when the same event changed remotely", () => {
    const latest = M.applyChange(base, up({ id: "a", title: "A-remote" }));
    const r = M.resolveConflict(base, latest, { type: "delete", id: "a" });
    expect(r).toEqual({ conflict: true, merged: null });
  });
  it("new events never conflict; replace always does", () => {
    const latest = M.applyChange(base, { type: "delete", id: "b" });
    expect(M.resolveConflict(base, latest, up({ id: "n" })).conflict).toBe(false);
    const rep = { type: "replace", data: base };
    expect(M.resolveConflict(base, latest, rep).conflict).toBe(true);
  });
  it("night conflicts are keyed by date", () => {
    const latest = M.applyChange(base, {
      type: "night",
      date: "2026-11-18",
      night: { name: "R2" },
    });
    const same = { type: "night", date: "2026-11-18", night: null };
    const other = { type: "night", date: "2026-11-19", night: { name: "X" } };
    expect(M.resolveConflict(base, latest, same).conflict).toBe(true);
    expect(M.resolveConflict(base, latest, other).conflict).toBe(false);
  });
});

describe("notes", () => {
  const n = (id, min, o) => ({
    id,
    createdAt: `2026-11-18T12:0${min}:00Z`,
    date: "2026-11-18",
    ...o,
  });
  it("folds deletes, sorts by createdAt, keeps queued flag", () => {
    const recs = [
      n("2", 2, { text: "b", queued: true }),
      n("1", 1, { text: "a" }),
      n("3", 3, { text: "c" }),
      { id: "4", createdAt: "2026-11-18T12:04:00Z", del: "3" },
    ];
    expect(M.foldNotes(recs).map((x) => [x.id, !!x.queued])).toEqual([
      ["1", false],
      ["2", true],
    ]);
  });
  it("delete of an unsynced note works when both are queued", () => {
    const recs = [
      n("a", 0, { text: "x", queued: true }),
      { id: "b", createdAt: "2026-11-18T12:01:00Z", del: "a", queued: true },
    ];
    expect(M.foldNotes(recs)).toEqual([]);
  });
});

describe("stats, codes, summary", () => {
  const d = data(
    [
      ev({ id: "1", kind: "flight", conf: "AAA", title: "F", date: "2026-11-14", time: "09:00" }),
      ev({ id: "2", kind: "flight", conf: "AAA", title: "F", date: "2026-11-14", time: "09:00" }),
      ev({ id: "3", kind: "bus", conf: "BBB", title: "B", date: "2026-11-13", time: "" }),
      ev({ id: "4", kind: "food", title: "D" }),
    ],
    { nights: { "2026-11-13": { name: "H" }, "2026-11-14": { name: "H" } } },
  );
  it("tripStats counts nights and kinds", () => {
    expect(M.tripStats(d)).toEqual({
      nights: 2,
      byKind: { flight: 2, bus: 1, food: 1 },
    });
  });
  it("confRows sorted and de-duplicated", () => {
    expect(M.confRows(d).map((e) => e.conf)).toEqual(["BBB", "AAA"]);
  });
  it("summarize", () => expect(M.summarize(d)).toBe("4 events · 2 nights"));
});

describe("ensureIds", () => {
  it("adds missing ids without touching existing ones", () => {
    const out = M.ensureIds(
      data([{ date: "2026-11-18", kind: "note", title: "x" }, ev({ id: "keep" })]),
    );
    expect(out.events[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.events[1].id).toBe("keep");
  });
});
