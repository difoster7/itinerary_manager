// Usage: node tools/extract-seed.mjs <Itinerary.html> [out=seed/itinerary.json]
// Output is plaintext: keep it out of git (seed/ is ignored).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { ensureIds, validateItinerary } from "../public/js/model.js";

const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const decode = (s) =>
  s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENT[m]).trim();

// Returns the source text of the literal in `const NAME = <literal>`. The
// blocks are JS object literals (unquoted keys), so JSON.parse can't read them.
function literal(src, name) {
  const start = src.search(new RegExp(`const\\s+${name}\\s*=`));
  if (start < 0) throw new Error(`Block ${name} not found`);
  let i = src.indexOf("=", start) + 1;
  while (/\s/.test(src[i])) i++;
  const from = i;
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) {
        if (src[i] === "\\") i++;
      }
    } else if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
    } else if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i) + 1;
    } else if (c === "{" || c === "[") {
      depth++;
    } else if (c === "}" || c === "]") {
      if (--depth === 0) return src.slice(from, i + 1);
    }
    if (i < 0) break;
  }
  throw new Error(`Block ${name} is unterminated`);
}

const evalLiteral = (text) =>
  vm.runInNewContext(`(${text})`, Object.create(null), { timeout: 1000 });

export function extractSeed(html, { tz = "-03:00" } = {}) {
  const get = (re, what) => {
    const m = re.exec(html);
    if (!m) throw new Error(`${what} not found`);
    return decode(m[1]);
  };
  const [nights, cities, events, costs] = [
    "NIGHTS",
    "CITIES",
    "EVENTS",
    "COSTS",
  ].map((n) => evalLiteral(literal(html, n)));
  const clean = events.map(({ todo, ...e }) => ({
    time: "",
    ...Object.fromEntries(
      Object.entries(e).filter(([k, v]) => k === "time" || v !== ""),
    ),
  }));
  const data = ensureIds({
    title: get(/<h1[^>]*>([\s\S]*?)<\/h1>/, "Title <h1>"),
    subtitle: get(/<p class="sub">([\s\S]*?)<\/p>/, 'Subtitle <p class="sub">'),
    tz,
    cities,
    nights,
    costs,
    events: clean,
  });
  const errs = validateItinerary(data);
  if (errs.length) throw new Error(`Seed is invalid:\n- ${errs.join("\n- ")}`);
  return data;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const [src, out = "seed/itinerary.json"] = process.argv.slice(2);
  if (!src) {
    console.error("Usage: node tools/extract-seed.mjs <Itinerary.html> [out]");
    process.exit(2);
  }
  const data = extractSeed(readFileSync(src, "utf8"));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(data, null, 2));
  const nights = Object.keys(data.nights).length;
  console.log(`Wrote ${out}: ${data.events.length} events, ${nights} nights`);
}
