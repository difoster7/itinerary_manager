const HISTORY_KEEP = 50;
const MAX_BLOB = 1_000_000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const fromHex = (h) =>
  /^[0-9a-f]{64}$/i.test(h)
    ? Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16))
    : null;

async function authorized(request, env) {
  const m = /^Bearer ([A-Za-z0-9+/]{43}=)$/.exec(
    request.headers.get("authorization") || "",
  );
  const want = fromHex(env.TOKEN_HASH || "");
  if (!m || !want) return false;
  const got = new Uint8Array(
    await crypto.subtle.digest("SHA-256", fromB64(m[1])),
  );
  return crypto.subtle.timingSafeEqual(got, want);
}

function isBlob(s) {
  if (typeof s !== "string" || s.length > MAX_BLOB) return false;
  try {
    const b = JSON.parse(s);
    return b.v === 1 && typeof b.iv === "string" && typeof b.ct === "string";
  } catch {
    return false;
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

async function currentVersion(db) {
  const row = await db
    .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM versions")
    .first();
  return row.v;
}

async function getItinerary(env) {
  const row = await env.DB.prepare(
    "SELECT version, blob, updated_at FROM versions ORDER BY version DESC LIMIT 1",
  ).first();
  if (!row) return json({ error: "empty" }, 404);
  return json({
    version: row.version,
    blob: row.blob,
    updatedAt: row.updated_at,
  });
}

async function putItinerary(request, env) {
  const raw = (request.headers.get("if-match") || "").replace(/"/g, "");
  if (!/^\d+$/.test(raw)) return json({ error: "if-match" }, 400);
  const expected = Number(raw);
  const body = await readJson(request);
  if (!body || !isBlob(body.blob)) return json({ error: "blob" }, 400);
  const next = expected + 1;
  const now = new Date().toISOString();
  let changes = 0;
  try {
    // Compare-and-swap: insert only if the caller saw the current version.
    const res = await env.DB.prepare(
      `INSERT INTO versions (version, blob, updated_at)
       SELECT ?1, ?2, ?3
       WHERE (SELECT COALESCE(MAX(version), 0) FROM versions) = ?4`,
    )
      .bind(next, body.blob, now, expected)
      .run();
    changes = res.meta.changes;
  } catch (err) {
    if (!/UNIQUE|constraint/i.test(String(err))) throw err;
  }
  if (changes !== 1) {
    return json({ version: await currentVersion(env.DB) }, 409);
  }
  await env.DB.prepare("DELETE FROM versions WHERE version <= ?")
    .bind(next - HISTORY_KEEP)
    .run();
  return json({ version: next, updatedAt: now });
}

async function api(request, env, path) {
  const m = request.method;
  if (path === "/api/itinerary") {
    if (m === "GET") return getItinerary(env);
    if (m === "PUT") return putItinerary(request, env);
    return json({ error: "method" }, 405);
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
      if (!(await authorized(request, env))) {
        return json({ error: "unauthorized" }, 401);
      }
      return api(request, env, path);
    }
    return env.ASSETS.fetch(request);
  },
};
