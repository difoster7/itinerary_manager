export class ApiError extends Error {
  constructor(status, body) {
    super(`API ${status}`);
    this.status = status;
    this.body = body;
  }
}

// Network failures (including timeouts on a stalled connection) reject with
// TypeError, which callers treat as offline; HTTP errors reject with ApiError.
export function createApi(
  token,
  fetchFn = (...a) => fetch(...a),
  timeoutMs = 15000,
) {
  async function call(method, path, { body, ifMatch } = {}) {
    const headers = { authorization: `Bearer ${token}` };
    if (ifMatch !== undefined) headers["if-match"] = String(ifMatch);
    if (body !== undefined) headers["content-type"] = "application/json";
    let res;
    try {
      res = await fetchFn(path, {
        method,
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new TypeError(`Request timed out: ${path}`);
      }
      throw e;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }
  return {
    async getItinerary() {
      try {
        return await call("GET", "/api/itinerary");
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    putItinerary: (blob, ifMatch) =>
      call("PUT", "/api/itinerary", { body: { blob }, ifMatch }),
    history: () => call("GET", "/api/history"),
    historyVersion: (v) => call("GET", `/api/history/${v}`),
    getNotes: () => call("GET", "/api/notes"),
    postNotes: async (list) => {
      await call("POST", "/api/notes", { body: list });
    },
  };
}
