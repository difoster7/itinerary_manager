import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, it, expect } from "vitest";

const TOKEN = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const BAD = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const blob = (n) =>
  JSON.stringify({ v: 1, iv: "aXZpdml2aXZpdml2", ct: `Y3Q${n}` });

const call = (method, path, { token = TOKEN, ifMatch, body } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (ifMatch !== undefined) headers["if-match"] = String(ifMatch);
  if (body !== undefined) headers["content-type"] = "application/json";
  return exports.default.fetch(`http://x${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
};

beforeEach(async () => {
  await env.DB.exec("DELETE FROM versions; DELETE FROM notes;");
});

describe("auth", () => {
  it("rejects missing token", async () => {
    const res = await call("GET", "/api/itinerary", { token: null });
    expect(res.status).toBe(401);
  });
  it("rejects wrong token", async () => {
    const res = await call("GET", "/api/itinerary", { token: BAD });
    expect(res.status).toBe(401);
  });
  it("rejects malformed token", async () => {
    const res = await call("GET", "/api/itinerary", { token: "!!!" });
    expect(res.status).toBe(401);
  });
  it("wrong-token PUT leaves D1 unchanged", async () => {
    const res = await call("PUT", "/api/itinerary", {
      token: BAD,
      ifMatch: 0,
      body: { blob: blob(1) },
    });
    expect(res.status).toBe(401);
    const { n } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM versions",
    ).first();
    expect(n).toBe(0);
  });
});

describe("itinerary", () => {
  it("404 when empty", async () => {
    expect((await call("GET", "/api/itinerary")).status).toBe(404);
  });

  it("first PUT with If-Match 0 creates version 1", async () => {
    const put = await call("PUT", "/api/itinerary", {
      ifMatch: 0,
      body: { blob: blob(1) },
    });
    expect(put.status).toBe(200);
    expect((await put.json()).version).toBe(1);
    const got = await (await call("GET", "/api/itinerary")).json();
    expect(got.version).toBe(1);
    expect(got.blob).toBe(blob(1));
    expect(typeof got.updatedAt).toBe("string");
  });

  it("stale If-Match returns 409 with current version", async () => {
    await call("PUT", "/api/itinerary", { ifMatch: 0, body: { blob: blob(1) } });
    await call("PUT", "/api/itinerary", { ifMatch: 1, body: { blob: blob(2) } });
    const res = await call("PUT", "/api/itinerary", {
      ifMatch: 1,
      body: { blob: blob(3) },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).version).toBe(2);
    const got = await (await call("GET", "/api/itinerary")).json();
    expect(got.blob).toBe(blob(2));
  });

  it("concurrent saves with the same If-Match: one 200, one 409", async () => {
    const [a, b] = await Promise.all([
      call("PUT", "/api/itinerary", { ifMatch: 0, body: { blob: blob("a") } }),
      call("PUT", "/api/itinerary", { ifMatch: 0, body: { blob: blob("b") } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it("prunes history to the newest 50", async () => {
    for (let v = 0; v < 55; v++) {
      const r = await call("PUT", "/api/itinerary", {
        ifMatch: v,
        body: { blob: blob(v) },
      });
      expect(r.status).toBe(200);
    }
    const { n, lo } = await env.DB.prepare(
      "SELECT COUNT(*) AS n, MIN(version) AS lo FROM versions",
    ).first();
    expect(n).toBe(50);
    expect(lo).toBe(6);
  });

  it.each([
    ["missing If-Match", undefined, { blob: blob(1) }],
    ["non-integer If-Match", "abc", { blob: blob(1) }],
    ["negative If-Match", -1, { blob: blob(1) }],
    ["blob not a string", 0, { blob: 5 }],
    ["blob not encrypted JSON", 0, { blob: "hello" }],
    ["blob wrong shape", 0, { blob: JSON.stringify({ v: 2, iv: "a", ct: "b" }) }],
  ])("400 for %s", async (_, ifMatch, body) => {
    const res = await call("PUT", "/api/itinerary", { ifMatch, body });
    expect(res.status).toBe(400);
  });

  it("400 for non-JSON body", async () => {
    const res = await exports.default.fetch("http://x/api/itinerary", {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "if-match": "0" },
      body: "{nope",
    });
    expect(res.status).toBe(400);
  });

  it("405 for other methods", async () => {
    expect((await call("DELETE", "/api/itinerary")).status).toBe(405);
  });
});
