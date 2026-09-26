import { describe, it, expect, vi } from "vitest";
import { createApi, ApiError } from "../../public/js/api.js";

const res = (status, body) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

describe("api", () => {
  it("sends the bearer token and If-Match", async () => {
    const f = vi.fn(async () => res(200, { version: 2, updatedAt: "t" }));
    await createApi("TOK", f).putItinerary("B", 1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/itinerary");
    expect(init.method).toBe("PUT");
    expect(init.headers.authorization).toBe("Bearer TOK");
    expect(init.headers["if-match"]).toBe("1");
    expect(JSON.parse(init.body)).toEqual({ blob: "B" });
  });
  it("getItinerary returns null on 404", async () => {
    const api = createApi("T", async () => res(404, {}));
    expect(await api.getItinerary()).toBe(null);
  });
  it("throws ApiError with status on 409 and 401", async () => {
    const e = await createApi("T", async () => res(409, { version: 5 }))
      .putItinerary("B", 1)
      .catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(409);
    expect(e.body.version).toBe(5);
    const e2 = await createApi("T", async () => res(401, {}))
      .getNotes()
      .catch((x) => x);
    expect(e2.status).toBe(401);
  });
  it("times out a stalled request as a network error", async () => {
    // Never settles unless aborted, like fetch on a stalled connection.
    const stall = (_url, init) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal.reason));
      });
    const err = await createApi("T", stall, 20).getNotes().catch((x) => x);
    expect(err).toBeInstanceOf(TypeError);
  }, 1000);
  it("propagates network errors as-is", async () => {
    const err = new TypeError("Failed to fetch");
    const api = createApi("T", async () => {
      throw err;
    });
    await expect(api.getNotes()).rejects.toBe(err);
  });
});
