import assert from "node:assert/strict";
import {
  adminProfileUpdateSchema,
  authCredentialsSchema,
  adminPasswordChangeSchema,
} from "../src/modules/auth/http/schemas";
import {
  agentV2UpdateSchema,
  agentV4ReportSchema,
} from "../src/modules/agents/http/schemas";
import { monitorV2MutationSchema } from "../src/modules/monitors/http/schemas";
import { statusConfigV2Schema } from "../src/modules/status/http/schemas";
import {
  channelCreateSchema,
  notificationSettingV2Schema,
} from "../src/modules/notifications/http/schemas";
import { validateNotificationChannelConfig } from "../src/modules/notifications/http/channel-config";
import {
  compareSemver,
  normalizeAgentIntervals,
  shouldTriggerAgentUpdate,
} from "../src/utils/agentConfig";
import { computeTraffic, sumNetworkTotals } from "../src/utils/traffic";
import { agentReportSourceFromCf, normalizeAgentGeo } from "../src/utils/geo";
import {
  parsePublicStatusSnapshot,
  projectPublicRealtimeMetric,
  toPublicAgent,
  toPublicMonitor,
} from "../src/modules/status/domain/public-contract";

const valid = (name: string, result: { success: boolean }) =>
  assert.equal(result.success, true, `${name} should be valid`);
const invalid = (name: string, result: { success: boolean }) =>
  assert.equal(result.success, false, `${name} should be invalid`);

valid(
  "session login",
  authCredentialsSchema.safeParse({ username: "admin", password: "admin123" })
);
invalid("session login without password", authCredentialsSchema.safeParse({ username: "admin" }));
valid("profile email update", adminProfileUpdateSchema.safeParse({ email: "admin@example.com" }));
valid("profile email clear", adminProfileUpdateSchema.safeParse({ email: null }));
invalid(
  "profile rejects username updates",
  adminProfileUpdateSchema.safeParse({ username: "renamed-admin", email: null })
);
valid(
  "password change",
  adminPasswordChangeSchema.safeParse({
    currentPassword: "admin123",
    newPassword: "new-password",
  })
);

valid(
  "monitor v2 mutation",
  monitorV2MutationSchema.safeParse({
    name: "API",
    url: "https://example.com/health",
    method: "GET",
    interval_seconds: 300,
    timeout_ms: 5000,
    expected_status: 200,
    headers: {},
    active: true,
  })
);
invalid(
  "monitor v2 rejects non-http URL",
  monitorV2MutationSchema.safeParse({
    name: "API",
    url: "ftp://example.com/health",
    method: "GET",
    interval_seconds: 300,
    timeout_ms: 5000,
    expected_status: 200,
    headers: {},
  })
);

valid(
  "agent v2 update",
  agentV2UpdateSchema.safeParse({
    collect_interval_seconds: 30,
    report_interval_seconds: 60,
    auto_update: true,
    tags: ["prod", "web"],
  })
);
invalid("agent v2 rejects empty update", agentV2UpdateSchema.safeParse({}));
valid(
  "agent v4 report",
  agentV4ReportSchema.safeParse({
    protocol_version: 4,
    agent_version: "1.2.4",
    report_id: "018f47f2-60e5-7b47-a8ca-58c57e1be5d4",
    hostname: "edge-1",
    keepalive_seconds: 60,
    report_interval_seconds: 60,
    samples: [
      {
        collected_at: "2026-08-11T00:00:00.000Z",
        cpu: { usage: 12, cores: 4 },
        memory: { usage_rate: 50 },
        network: [{ interface: "eth0", bytes_recv: 100, bytes_sent: 50 }],
      },
    ],
  })
);

valid(
  "status config",
  statusConfigV2Schema.safeParse({
    title: "Status",
    description: "Service status",
    logoUrl: "",
    customCss: "",
    theme: "mono",
    monitors: [1],
    agents: [1],
  })
);
invalid(
  "status config rejects duplicate agents",
  statusConfigV2Schema.safeParse({
    title: "Status",
    description: "",
    agents: [1, 1],
  })
);

valid(
  "notification channel",
  channelCreateSchema.safeParse({
    name: "Bot",
    type: "telegram",
    config: { botToken: "fixture", chatId: "1" },
    enabled: true,
  })
);
valid(
  "notification setting",
  notificationSettingV2Schema.safeParse({
    target_type: "agent",
    target_id: 1,
    enabled: true,
    channels: [1],
    cooldown_minutes: 30,
  })
);
invalid(
  "notification webhook rejects malformed URL",
  validateNotificationChannelConfig("gotify", {
    server_url: "not-a-url",
    token: "fixture",
  })
);

assert.deepEqual(
  normalizeAgentIntervals({ collect_interval: 600, report_interval: 60 }),
  { collect_interval: 600, report_interval: 600 }
);
assert.equal(compareSemver("1.2.3", "1.2.4"), -1);
assert.equal(compareSemver("v1.2.4", "1.2.4"), 0);
assert.equal(shouldTriggerAgentUpdate(true, "1.2.4", "1.2.3"), true);
assert.equal(shouldTriggerAgentUpdate(false, "1.2.4", "1.2.3"), false);

assert.deepEqual(
  sumNetworkTotals([
    { interface: "eth0", bytes_recv: 100, bytes_sent: 40 },
    { interface: "lo", bytes_recv: 9999, bytes_sent: 9999 },
    { interface: "eth1", bytes_recv: 20, bytes_sent: 10 },
  ]),
  { rx: 120, tx: 50 }
);
const baseline = computeTraffic(
  null,
  [{ ts: 1_000_000, totals: { rx: 1000, tx: 500 } }],
  "2026-08-01"
);
const current = computeTraffic(
  baseline.state,
  [{ ts: 1_010_000, totals: { rx: 11000, tx: 3000 } }],
  "2026-08-01"
);
assert.deepEqual(current.speeds, [{ rx: 1000, tx: 250 }]);

assert.deepEqual(
  normalizeAgentGeo({
    latitude: "35.68950",
    longitude: "139.69171",
    city: " Tokyo ",
    regionName: "Tokyo",
  }),
  {
    latitude: 35.6895,
    longitude: 139.6917,
    city: "Tokyo",
    region_name: "Tokyo",
  }
);
assert.deepEqual(
  agentReportSourceFromCf({
    country: "jp",
    latitude: "35.6895",
    longitude: "139.6917",
    city: "Tokyo",
    region: "Tokyo",
  }),
  {
    country: "JP",
    latitude: "35.6895",
    longitude: "139.6917",
    city: "Tokyo",
    regionName: "Tokyo",
  }
);

const publicAgent = toPublicAgent({
  id: 1,
  name: "edge-1",
  token: "secret",
  status: "active",
  created_at: "2026-08-11T00:00:00.000Z",
  updated_at: "2026-08-11T00:00:00.000Z",
  hostname: "edge-1",
  os: "linux",
  version: "1.2.4",
  ip_addresses: '["192.0.2.1"]',
  region: "JP",
  geo_latitude: 35.6895,
  geo_longitude: 139.6917,
  geo_city: "Tokyo",
  geo_region_name: "Tokyo",
  city: "Tokyo",
  region_name: "Tokyo",
  map_latitude: 35.6895,
  map_longitude: 139.6917,
} as Parameters<typeof toPublicAgent>[0] & Record<string, unknown>);
assert.equal("token" in publicAgent, false);
assert.equal("ip_addresses" in publicAgent, false);
assert.deepEqual(
  [publicAgent.city, publicAgent.map_latitude, publicAgent.map_longitude],
  ["Tokyo", 35.69, 139.69]
);

const publicMonitor = toPublicMonitor({
  id: 1,
  name: "API",
  url: "https://private.example/health",
  method: "GET",
  headers: { Authorization: "Bearer secret" },
  status: "up",
  response_time: 42,
  last_checked: "2026-08-11T00:00:00.000Z",
  created_at: "2026-08-11T00:00:00.000Z",
  updated_at: "2026-08-11T00:00:00.000Z",
} as Parameters<typeof toPublicMonitor>[0] & Record<string, unknown>);
assert.equal("url" in publicMonitor, false);
assert.equal("headers" in publicMonitor, false);
assert.ok(parsePublicStatusSnapshot('{"monitors":[],"agents":[]}'));
assert.equal(
  parsePublicStatusSnapshot(
    '{"monitors":[],"agents":[{"id":1,"metrics":{"token":"secret"}}]}'
  ),
  null
);
const realtime = projectPublicRealtimeMetric({
  timestamp: "2026-08-11T00:00:00.000Z",
  network_rx_speed: 1024,
  network_tx_speed: 512,
  ip_addresses: ["192.0.2.1"],
});
assert.equal(realtime.network_rx_speed, 1024);
assert.equal("ip_addresses" in realtime, false);
