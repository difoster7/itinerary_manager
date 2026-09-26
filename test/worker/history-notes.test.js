import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, it, expect } from "vitest";

const TOKEN = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const blob = (n) =>
  JSON.stringify({ v: 1, iv: "aXZpdml2aXZpdml2", ct: `Y3Q${n}` });
const call = (method, path, body, ifMatch) =>
  exports.default.fetch(`http://x${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(ifMatch !== undefined ? { "if-match": String(ifMatch) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const note = (i, b = blob(`n${i}`)) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  blob: b,
  createdAt: `2026-11-18T10:00:0${i}.000Z`,
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM versions; DELETE FROM notes;");
});

describe("history", () => {
  it("lists versions newest first and fetches one", async () => {
    await call("PUT", "/api/itinerary", { blob: blob(1) }, 0);
    await call("PUT", "/api/itinerary", { blob: blob(2) }, 1);
    const list = await (await call("GET", "/api/history")).json();
    expect(list.map((r) => r.version)).toEqual([2, 1]);
    const one = await (await call("GET", "/api/history/1")).json();
    expect(one.blob).toBe(blob(1));
  });
  it("404 for unknown or invalid version", async () => {
    expect((await call("GET", "/api/history/9")).status).toBe(404);
    expect((await call("GET", "/api/history/abc")).status).toBe(404);
  });
});

describe("notes", () => {
  it("POST then GET returns notes; re-POST is idempotent", async () => {
    const batch = [note(1), note(2)];
    expect((await call("POST", "/api/notes", batch)).status).toBe(200);
    expect((await call("POST", "/api/notes", batch)).status).toBe(200);
    const got = await (await call("GET", "/api/notes")).json();
    expect(got.map((n) => n.id)).toEqual(batch.map((n) => n.id));
  });
  it("re-POST with a different blob does not overwrite", async () => {
    await call("POST", "/api/notes", [note(1)]);
    await call("POST", "/api/notes", [note(1, blob("other"))]);
    const [got] = await (await call("GET", "/api/notes")).json();
    expect(got.blob).toBe(blob("n1"));
  });
  it.each([
    ["not an array", { id: "x" }],
    ["empty array", []],
    ["bad id", [{ ...note(1), id: "nope" }]],
    ["bad blob", [{ ...note(1), blob: "plain text" }]],
    ["bad createdAt", [{ ...note(1), createdAt: 5 }]],
    ["too many", Array.from({ length: 201 }, (_, i) => note(i))],
  ])("400 for %s", async (_, body) => {
    expect((await call("POST", "/api/notes", body)).status).toBe(400);
  });
});

it("/sw.js is served with the version placeholder replaced", async () => {
  const res = await exports.default.fetch("http://x/sw.js");
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain("APP_VERSION");
  expect(text).not.toContain("__APP_VERSION__");
  expect(res.headers.get("content-type")).toMatch(/javascript/);
});
