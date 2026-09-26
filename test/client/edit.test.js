import { describe, it, expect, vi } from "vitest";

vi.mock("../../public/js/session.js", () => {
  class ValidationError extends Error {}
  return {
    state: { data: null, version: 0 },
    conn: { online: true },
    commit: vi.fn(async () => {}),
    ValidationError,
  };
});

const S = await import("../../public/js/session.js");
const { saveChange } = await import("../../public/js/edit.js");

const doc = (title) => ({
  title: "T",
  cities: {},
  nights: {},
  costs: [],
  events: [{ id: "a", date: "2026-11-18", time: "", kind: "note", title }],
});

describe("saveChange", () => {
  it("uses the version the form was opened on, not one a refresh loaded since", async () => {
    const base = { data: doc("v1"), version: 1 };
    // A background refresh replaced state with the other device's edit.
    S.state.data = doc("edited on PC");
    S.state.version = 2;
    const change = {
      type: "upsert",
      event: { id: "a", date: "2026-11-18", time: "", kind: "note", title: "phone" },
    };
    await saveChange(change, () => {}, base);
    const [next, ifMatch] = S.commit.mock.calls.at(-1);
    expect(ifMatch).toBe(1);
    expect(next.events[0].title).toBe("phone");
  });
});
