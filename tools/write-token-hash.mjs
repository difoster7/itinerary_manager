// Usage: node tools/write-token-hash.mjs           -> prompts, prints TOKEN_HASH
//        node tools/write-token-hash.mjs --new-salt -> prints a fresh salt
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { deriveKeys, tokenHash } from "../public/js/crypto.js";
import { SALT } from "../public/js/config.js";

if (process.argv.includes("--new-salt")) {
  console.log(randomBytes(16).toString("base64"));
  process.exit(0);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const pass = await rl.question(
  "Passphrase (visible; clear your terminal after): ",
);
rl.close();
const { token } = await deriveKeys(pass, SALT);
console.log("\nTOKEN_HASH =", await tokenHash(token));
console.log("Run: npx wrangler secret put TOKEN_HASH   (paste the value)");
