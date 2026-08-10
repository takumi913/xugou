import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "drizzle"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: path.join(import.meta.dirname, "../wrangler.toml") },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SESSION_HMAC_SECRET: "test-session-hmac-secret-with-more-than-32-bytes",
            ADMIN_INITIAL_PASSWORD: "test-initial-password",
            AGENT_TOKEN_PEPPER: "test-agent-token-pepper-with-more-than-32-bytes",
            NOTIFICATION_KEK: "dGVzdC1ub3RpZmljYXRpb24ta2VrLTMyLWJ5dGVzISE=",
          },
          // Tests invoke the production queue handler with createMessageBatch.
          // Disable Miniflare auto-delivery so producer sends do not race suite teardown.
          queueConsumers: [],
        },
      }),
    ],
    test: {
      setupFiles: ["./test-runtime/apply-migrations.ts"],
      include: ["test-runtime/**/*.test.ts"],
      testTimeout: 30_000,
    },
  };
});
