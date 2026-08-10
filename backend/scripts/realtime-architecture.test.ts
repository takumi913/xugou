import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseAgentRoomSubscription } from "../src/api/ws";

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(backendRoot, "..");

assert.equal(parseAgentRoomSubscription("42"), 42);
for (const invalid of [undefined, "", "all", "1,2", "0", "-1", "1.5", "x"]) {
  assert.equal(
    parseAgentRoomSubscription(invalid),
    null,
    `${String(invalid)} must not select an Agent room`
  );
}

const publisher = readFileSync(
  join(
    backendRoot,
    "src/modules/agents/realtime/MetricsBroadcastPublisher.ts"
  ),
  "utf8"
);
assert.match(publisher, /AGENT_ROOM/);
assert.match(publisher, /getByName\(String\(agentId\)\)/);
assert.doesNotMatch(publisher, /METRICS_BROADCASTER|idFromName\("global"\)/);

for (const relativePath of [
  "frontend/src/pages/Dashboard.tsx",
  "frontend/src/pages/status/StatusPage.tsx",
]) {
  const source = readFileSync(join(repositoryRoot, relativePath), "utf8");
  assert.doesNotMatch(
    source,
    /createLiveSocket|\/api\/ws/,
    `${relativePath} must read a projection instead of joining realtime rooms`
  );
}

const wrangler = readFileSync(join(repositoryRoot, "wrangler.toml"), "utf8");
assert.match(wrangler, /name = "AGENT_ROOM"\s+class_name = "AgentRoom"/);
assert.match(wrangler, /tag = "v2"\s+new_sqlite_classes = \["AgentRoom"\]/);
assert.match(
  wrangler,
  /tag = "v3"\s+deleted_classes = \["MetricsBroadcaster"\]/
);
assert.doesNotMatch(wrangler, /name = "METRICS_BROADCASTER"/);

for (const relativePath of ["backend/src/index.ts", "backend/src/worker.ts"]) {
  const source = readFileSync(join(repositoryRoot, relativePath), "utf8");
  assert.doesNotMatch(source, /MetricsBroadcaster/);
}
