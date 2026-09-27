import { exports } from "cloudflare:workers";
import { it, expect } from "vitest";

it("unknown API path without a token returns 401 JSON", async () => {
  const res = await exports.default.fetch("http://x/api/nope");
  expect(res.status).toBe(401);
  expect(res.headers.get("content-type")).toMatch(/json/);
});

it("a share POST that bypassed the service worker redirects into the app", async () => {
  const res = await exports.default.fetch("http://x/share", {
    method: "POST",
    body: new FormData(),
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("http://x/?shared=lost");
});
