import { describe, it, expect, vi } from "vitest";

vi.mock("../../public/js/store.js", () => ({
  clearAll: vi.fn(async () => {}),
  get: vi.fn(),
  put: vi.fn(),
  all: vi.fn(async () => []),
  del: vi.fn(),
}));

const S = await import("../../public/js/session.js");
const store = await import("../../public/js/store.js");

describe("forget", () => {
  it("clears data and unregisters the service worker so the shell reinstalls", async () => {
    const unregister = vi.fn(async () => true);
    const sw = { getRegistrations: async () => [{ unregister }, { unregister }] };
    const deleted = [];
    const cacheStorage = {
      keys: async () => ["shell-abc"],
      delete: async (k) => deleted.push(k),
    };
    await S.forget({ sw, cacheStorage });
    expect(store.clearAll).toHaveBeenCalled();
    expect(unregister).toHaveBeenCalledTimes(2);
    expect(deleted).toEqual(["shell-abc"]);
  });
});
