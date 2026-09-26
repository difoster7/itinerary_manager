export class ApiError extends Error {
  constructor(status, body) {
    super(`API ${status}`);
    this.status = status;
    this.body = body;
  }
}

// Network failures reject with fetch's TypeError; HTTP errors with ApiError.
export function createApi(token, fetchFn = (...a) => fetch(...a)) {
  async function call(method, path, { body, ifMatch } = {}) {
    const headers = { authorization: `Bearer ${token}` };
    if (ifMatch !== undefined) headers["if-match"] = String(ifMatch);
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetchFn(path, {
      method,
      headers,
      cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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
