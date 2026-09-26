import { exports } from "cloudflare:workers";
import { it, expect } from "vitest";

it("unknown API path without a token returns 401 JSON", async () => {
  const res = await exports.default.fetch("http://x/api/nope");
  expect(res.status).toBe(401);
  expect(res.headers.get("content-type")).toMatch(/json/);
});
