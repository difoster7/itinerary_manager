import { createHash } from "node:crypto";
import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";

// Hash of the test token: 32 bytes of 0x01.
const TOKEN_HASH = createHash("sha256")
  .update(Buffer.alloc(32, 1))
  .digest("hex");

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TOKEN_HASH, TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ["test/worker/**/*.test.js"],
      setupFiles: ["./test/worker/apply-migrations.js"],
    },
  };
});
