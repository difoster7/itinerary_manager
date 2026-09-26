import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { extractSeed } from "../../tools/extract-seed.mjs";

const html = readFileSync(
  new URL("../fixtures/sample-itinerary.html", import.meta.url),
  "utf8",
);

describe("extractSeed", () => {
  const d = extractSeed(html);
  it("reads title, subtitle, tz", () => {
    expect(d.title).toBe("Sample & Trip");
    expect(d.subtitle).toBe("Solo · test");
    expect(d.tz).toBe("-03:00");
  });
  it("reads nights, cities, costs verbatim", () => {
    expect(d.nights["2026-11-14"].name).toBe('Hotel "Dos"');
    expect(d.cities["2026-11-14"]).toBe("Puerto Natales");
    expect(d.costs).toEqual([["Hotel", "$100", "paid"]]);
  });
  it("adds ids, drops todo and empty fields, ignores OPEN_ITEMS", () => {
    expect(d.events).toHaveLength(2);
    expect(d.events[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(d.events[0]).not.toHaveProperty("todo");
    expect(d.events[0]).not.toHaveProperty("end");
    expect(d.events[0].notes).toEqual(["a, b", "it's"]);
    expect(d.events[1].time).toBe("");
    expect(Object.keys(d).sort()).toEqual(
      ["costs", "cities", "events", "nights", "subtitle", "title", "tz"].sort(),
    );
  });
  it("throws with details on invalid data", () => {
    const bad = html.replace('kind:"note"', 'kind:"boat"');
    expect(() => extractSeed(bad)).toThrow(/unknown kind/);
  });
  it("throws when a block is missing", () => {
    const bad = html.replace("const COSTS", "const NOPE");
    expect(() => extractSeed(bad)).toThrow(/COSTS/);
  });
});
