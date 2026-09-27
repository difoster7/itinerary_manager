// Runs the import prompt on one confirmation and prints the parsed result,
// for iterating on the prompt. Makes a real API call.
//
//   ANTHROPIC_API_KEY=... node tools/try-extract.mjs <file> [seed.json]
//
// <file> is .txt/.eml (sent as text) or .pdf/.png/.jpg/.webp. The optional
// seed supplies the trip context (dates, cities); default seed/itinerary.json.
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { extract, toBase64, tripContext } from "../public/js/extract.js";

const TYPES = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const [file, seedPath = "seed/itinerary.json"] = process.argv.slice(2);
if (!file || !process.env.ANTHROPIC_API_KEY) {
  console.error("Usage: ANTHROPIC_API_KEY=... node tools/try-extract.mjs <file> [seed.json]");
  process.exit(1);
}
const trip = existsSync(seedPath)
  ? JSON.parse(readFileSync(seedPath, "utf8"))
  : { cities: {}, nights: {}, events: [] };
const type = TYPES[extname(file).toLowerCase()];
const source = type
  ? { file: { mediaType: type, data: toBase64(readFileSync(file)) } }
  : { text: readFileSync(file, "utf8") };

try {
  const result = await extract(source, {
    apiKey: process.env.ANTHROPIC_API_KEY,
    context: tripContext(trip, new Date().toLocaleDateString("en-CA")),
  });
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
