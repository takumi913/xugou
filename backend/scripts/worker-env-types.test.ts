import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(backendRoot, "..");
const wrangler = readFileSync(join(repositoryRoot, "wrangler.toml"), "utf8");
const generated = readFileSync(
  join(backendRoot, "src/worker-env.d.ts"),
  "utf8"
);

for (const binding of [
  "DB",
  "ASSETS",
  "RAW_SAMPLE_ARCHIVE",
  "AGENT_ROOM",
  "XUGOU_JOBS",
  "CF_VERSION_METADATA",
]) {
  assert.match(generated, new RegExp(`\\b${binding}:`));
}

assert.doesNotMatch(
  generated,
  /\bMETRICS_BROADCASTER:|\bMetricsBroadcaster\b/,
  "retired global realtime Durable Object must not remain in Worker Env"
);

const varsBlock = wrangler.match(/\[vars\]([\s\S]*?)(?=\n\[|\n#?\s*\[|$)/)?.[1] ?? "";
for (const match of varsBlock.matchAll(/^([A-Z][A-Z0-9_]*)\s*=/gm)) {
  assert.match(
    generated,
    new RegExp(`\\b${match[1]}:`),
    `${match[1]} must be present in generated Worker Env`
  );
}

assert.match(
  readFileSync(join(backendRoot, "src/models/db.ts"), "utf8"),
  /Cloudflare\.Env/,
  "Bindings must extend Wrangler-generated Cloudflare.Env"
);
