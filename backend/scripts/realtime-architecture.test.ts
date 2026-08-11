import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseAgentRoomSubscription,
  parseAgentRoomSubscriptions,
} from "../src/api/ws";
import {
  AGENT_REALTIME_SHARD_COUNT,
  realtimeRoomName,
} from "../src/modules/agents/realtime/RealtimeSharding";

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(backendRoot, "..");

assert.equal(parseAgentRoomSubscription("42"), 42);
assert.deepEqual(parseAgentRoomSubscriptions("1,9,17,9"), [1, 9, 17]);
assert.equal(realtimeRoomName(1), "agent-shard:0");
assert.equal(realtimeRoomName(AGENT_REALTIME_SHARD_COUNT), "agent-shard:7");
for (const invalid of [undefined, "", "all", "1,2", "0", "-1", "1.5", "x"]) {
  assert.equal(
    parseAgentRoomSubscriptions(invalid),
    null,
    `${String(invalid)} must not select a realtime shard`
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
assert.match(publisher, /getByName\(realtimeRoomName\(update\.agentId\)\)/);
assert.doesNotMatch(publisher, /METRICS_BROADCASTER|idFromName\("global"\)/);

const agentRoutes = readFileSync(
  join(backendRoot, "src/modules/agents/http/routes.ts"),
  "utf8"
);
assert.match(agentRoutes, /agentsV2\.get\("\/live"/);
assert.match(agentRoutes, /authenticateAgentToken/);
assert.match(agentRoutes, /\/agent-ws/);

const agentRoom = readFileSync(
  join(backendRoot, "src/durable/AgentRoom.ts"),
  "utf8"
);
assert.match(agentRoom, /agentLiveMetricFrameSchema/);
assert.match(agentRoom, /liveFrameToBroadcastUpdate/);
assert.match(agentRoom, /kind:\s*"agent"/);

const dashboard = readFileSync(
  join(repositoryRoot, "frontend/src/pages/Dashboard.tsx"),
  "utf8"
);
assert.match(dashboard, /createLiveSocket/);
assert.match(dashboard, /liveMetrics/);

const statusPage = readFileSync(
  join(repositoryRoot, "frontend/src/pages/status/StatusPage.tsx"),
  "utf8"
);
assert.match(statusPage, /createLiveSocket/);
assert.match(statusPage, /\/api\/v2\/status\/public\/ws/);
assert.doesNotMatch(statusPage, /path:\s*["']\/api\/ws["']/);

const liveSocket = readFileSync(
  join(repositoryRoot, "frontend/src/utils/liveSocket.ts"),
  "utf8"
);
assert.match(liveSocket, /groupRealtimeSubscriptions/);
assert.match(
  liveSocket,
  new RegExp(`AGENT_REALTIME_SHARD_COUNT = ${AGENT_REALTIME_SHARD_COUNT}`)
);

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
