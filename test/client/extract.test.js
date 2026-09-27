import { describe, it, expect } from "vitest";
import * as X from "../../public/js/extract.js";

const d = {
  cities: { "2026-11-13": "Los Angeles → Santiago", "2026-11-14": "Santiago" },
  nights: { "2026-11-13": { name: "F" }, "2026-11-14": { name: "H" } },
  events: [{ id: "a", date: "2026-11-15", kind: "note", title: "x" }],
};
const ok = { events: [], nights: [], costs: [], warnings: ["w"] };
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });
const message = (text, stop = "end_turn") => ({
  stop_reason: stop,
  content: [{ type: "text", text }],
});
const stub = (res) => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (res instanceof Error) throw res;
    return res;
  };
  return { fetch, calls };
};

describe("tripContext", () => {
  it("lists trip dates, today and cities", () => {
    expect(X.tripContext(d, "2026-09-26")).toBe(
      [
        "TRIP CONTEXT",
        "Trip dates: 2026-11-13 to 2026-11-15",
        "Today: 2026-09-26",
        "Cities by date:",
        "2026-11-13 Los Angeles → Santiago",
        "2026-11-14 Santiago",
      ].join("\n"),
    );
  });
  it("handles an empty trip", () => {
    const empty = { cities: {}, nights: {}, events: [] };
    expect(X.tripContext(empty, "2026-09-26")).toBe(
      "TRIP CONTEXT\nTrip dates: none yet\nToday: 2026-09-26",
    );
  });
});

describe("toBase64", () => {
  it("encodes bytes without newlines", () => {
    const big = new Uint8Array(100_000).fill(250);
    const b = X.toBase64(big);
    expect(b).not.toMatch(/\s/);
    expect(atob(b).length).toBe(100_000);
    expect(X.toBase64(new Uint8Array([104, 105]))).toBe("aGk=");
  });
});

describe("buildRequest", () => {
  it("sends text only with the model, effort, schema and prompt", () => {
    const b = X.buildRequest({ text: "Your booking" }, "CTX");
    expect(b.model).toBe("claude-sonnet-5");
    expect(b.output_config).toEqual({
      effort: "low",
      format: { type: "json_schema", schema: X.SCHEMA },
    });
    expect(b.system).toBe(X.PROMPT);
    expect(b.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "CTX\n\nYour booking" }] },
    ]);
  });
  it("puts a PDF first as a document block", () => {
    const b = X.buildRequest(
      { file: { mediaType: "application/pdf", data: "QQ==" } },
      "CTX",
    );
    expect(b.messages[0].content).toEqual([
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "QQ==" },
      },
      { type: "text", text: "CTX\n\nThe confirmation is attached." },
    ]);
  });
  it("sends an image block plus text when both are given", () => {
    const b = X.buildRequest(
      { text: "extra", file: { mediaType: "image/png", data: "QQ==" } },
      "CTX",
    );
    expect(b.messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "QQ==" },
    });
    expect(b.messages[0].content[1].text).toBe("CTX\n\nextra");
  });
});

describe("schema", () => {
  it("offers every kind except note", () => {
    const kinds = X.SCHEMA.properties.events.items.properties.kind.enum;
    expect(kinds).toContain("other");
    expect(kinds).not.toContain("note");
  });
  it("closes every object and requires every property", () => {
    const walk = (s) => {
      if (s.type === "object") {
        expect(s.additionalProperties).toBe(false);
        expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort());
        Object.values(s.properties).forEach(walk);
      }
      if (s.type === "array") walk(s.items);
    };
    walk(X.SCHEMA);
  });
});

describe("extract", () => {
  const run = (fetch) =>
    X.extract({ text: "t" }, { apiKey: "sk-1", context: "CTX", fetch });

  it("posts to the Messages API with browser-access headers", async () => {
    const s = stub(reply(message(JSON.stringify(ok))));
    expect(await run(s.fetch)).toEqual(ok);
    const { url, init } = s.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "x-api-key": "sk-1",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    });
    expect(JSON.parse(init.body).system).toBe(X.PROMPT);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["refusal", message("{}", "refusal"), "Claude declined to read this."],
    ["max_tokens", message("{", "max_tokens"), "The reply was cut off. Try a shorter source."],
    ["unparseable", message("nope"), "Claude's reply wasn't valid JSON."],
  ])("rejects a %s reply", async (_, body, msg) => {
    await expect(run(stub(reply(body)).fetch)).rejects.toThrow(msg);
  });

  it.each([
    [401, "API key rejected. Update it in More → Claude."],
    [403, "API key rejected. Update it in More → Claude."],
    [429, "Claude is busy. Try again in a minute."],
    [529, "Claude is busy. Try again in a minute."],
    [400, "Couldn't read that: bad pdf"],
    [500, "Import failed (500)."],
  ])("maps HTTP %i", async (status, msg) => {
    const body = { error: { type: "x", message: "bad pdf" } };
    const err = await run(stub(reply(body, status)).fetch).catch((e) => e);
    expect(err).toBeInstanceOf(X.ExtractError);
    expect(err.message).toBe(msg);
  });

  it.each([
    ["network", new TypeError("Failed to fetch")],
    ["timeout", new DOMException("t", "TimeoutError")],
  ])("maps a %s failure", async (_, e) => {
    await expect(run(stub(e).fetch)).rejects.toThrow("Offline or timed out.");
  });
});

describe("readFile", () => {
  it("accepts PDFs and images", async () => {
    const f = new File([new Uint8Array([104, 105])], "a.pdf", {
      type: "application/pdf",
    });
    expect(await X.readFile(f)).toEqual({ mediaType: "application/pdf", data: "aGk=" });
  });
  it("rejects other types and oversize files", async () => {
    const txt = new File(["x"], "a.txt", { type: "text/plain" });
    await expect(X.readFile(txt)).rejects.toThrow("Use a PDF, PNG, JPEG or WebP file.");
    const big = { type: "image/png", size: X.MAX_BYTES + 1 };
    await expect(X.readFile(big)).rejects.toThrow("File is over 20 MB.");
  });
});
