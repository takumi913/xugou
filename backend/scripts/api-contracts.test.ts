import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  agentImportSchema,
  agentRegisterSchema,
  agentStatusSchema,
  agentUpdateSchema,
  monitorImportSchema,
  monitorSchema,
  notificationHistoryQuerySchema,
  notificationSettingsSchema,
  orderUpdateSchema,
  securityAuditQuerySchema,
  statusPageConfigSchema,
} from "../src/api/schemas";
import {
  adminPasswordChangeSchema as changePasswordSchema,
  authCredentialsSchema,
} from "../src/modules/auth/http/schemas";
import { validateNotificationChannelConfig } from "../src/modules/notifications/http/channel-config";
import {
  MAX_REPORT_SAMPLES,
  compareSemver,
  describeAgentConfig,
  md5Hex,
  normalizeAgentConfigSchema,
  normalizeAgentIntervals,
  serializeAgentConfig,
  shouldTriggerAgentUpdate,
} from "../src/utils/agentConfig";
import {
  dedupeResourceIds,
  getMissingResourceIds,
} from "../src/utils/access";
import {
  HISTORY_PARTITION_MULTIPLIER,
  buildHistoryId,
  formatHistoryTimeKey,
  getHistoryIdRange,
  normalizeAgentMetricsHours,
  normalizeHistoryPartitionId,
} from "../src/utils/historyId";
import {
  computeTraffic,
  getTrafficPeriodStart,
  normalizeTrafficResetDay,
  sumNetworkTotals,
} from "../src/utils/traffic";
import {
  agentReportSourceFromCf,
  normalizeAgentCountry,
  normalizeAgentGeo,
} from "../src/utils/geo";
import {
  projectPublicRealtimeMetric,
  toPublicAgent,
  toPublicMonitor,
  parsePublicStatusSnapshot,
  type PublicAgentSource,
  type PublicMonitorSource,
} from "../src/modules/status/domain/public-contract";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_OFFSET,
  MAX_PAGE_SIZE,
  normalizePageOffset,
  normalizePageSize,
} from "../src/utils/pagination";
import { toAgentExportRecord } from "../src/modules/agents/persistence/D1LegacyAgentFacade";
import { getEnvNumber } from "../src/utils/env";

const expectValid = (name: string, result: { success: boolean }) => {
  assert.equal(result.success, true, `${name} should be valid`);
};

const expectInvalid = (name: string, result: { success: boolean }) => {
  assert.equal(result.success, false, `${name} should be invalid`);
};

assert.equal(getEnvNumber(undefined, "MISSING", 30, { min: 1 }), 30);
assert.equal(getEnvNumber({}, "MISSING", 30, { min: 1 }), 30);
assert.equal(getEnvNumber({ VALUE: "" }, "VALUE", 30, { min: 1 }), 30);
assert.equal(getEnvNumber({ VALUE: "5" }, "VALUE", 30, { min: 1 }), 5);

expectValid(
  "login payload",
  authCredentialsSchema.safeParse({
    username: "admin",
    password: "admin123",
  })
);
expectInvalid("login payload without password", authCredentialsSchema.safeParse({ username: "admin" }));

expectValid(
  "security audit query",
  securityAuditQuerySchema.safeParse({
    eventType: "auth.login",
    outcome: "failure",
    page: "2",
    pageSize: "50",
  })
);
expectInvalid(
  "security audit query with unknown key",
  securityAuditQuerySchema.safeParse({ page: 1, includeSecrets: true })
);
expectInvalid(
  "security audit query with oversized page",
  securityAuditQuerySchema.safeParse({ pageSize: MAX_PAGE_SIZE + 1 })
);

const legacyAgentWithSensitiveFields = {
  id: 1,
  name: "fixture-agent",
  token: "fixture-plaintext-token",
  status: "active",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  hostname: "fixture",
  keepalive: null,
  ip_addresses: null,
  os: "linux",
  version: "1.0.0",
  last_seen_at: null,
  last_state_changed_at: null,
  next_offline_at: null,
};
const agentExportRecord = toAgentExportRecord(legacyAgentWithSensitiveFields);
assert.equal("token" in agentExportRecord, false, "Agent export must omit Token");

expectValid(
  "change password payload",
  changePasswordSchema.safeParse({
    currentPassword: "admin123",
    newPassword: "new-password",
  })
);
expectInvalid(
  "change password payload without current password",
  changePasswordSchema.safeParse({ newPassword: "new-password" })
);

expectValid(
  "monitor payload",
  monitorSchema.safeParse({
    name: "API",
    url: "https://example.com/health",
    method: "GET",
    interval: 60,
    timeout: 5000,
    expected_status: 200,
    headers: "{}",
    active: true,
  })
);
expectInvalid(
  "monitor payload with invalid status",
  monitorSchema.safeParse({
    name: "API",
    url: "https://example.com/health",
    method: "GET",
    interval: 60,
    timeout: 5000,
    expected_status: 99,
    headers: "{}",
  })
);

expectValid(
  "agent register payload",
  agentRegisterSchema.safeParse({
    token: "agent-token",
    name: "server-1",
    hostname: "server-1",
    ip_addresses: ["127.0.0.1"],
    os: "linux",
    version: "1.0.0",
  })
);
expectInvalid("agent register payload without token", agentRegisterSchema.safeParse({ name: "server-1" }));

expectValid(
  "agent status payload",
  agentStatusSchema.safeParse({
    token: "agent-token",
    hostname: "server-1",
    ip_addresses: ["127.0.0.1"],
    cpu: { usage: 12, cores: 4, model_name: "Apple M" },
    memory: { total: 100, used: 50, free: 50, usage_rate: 50 },
    load: { load1: 1, load5: 1, load15: 1 },
    disks: [{ device: "/dev/disk1", usage_rate: 40 }],
    network: [{ interface: "en0", bytes_sent: 1, bytes_recv: 2 }],
  })
);
expectInvalid("agent status payload without token", agentStatusSchema.safeParse({ cpu: { usage: 12 } }));

// ---- 新协议：samples 批量上报 ----

expectValid(
  "agent status payload with samples",
  agentStatusSchema.safeParse({
    token: "agent-token",
    timestamp: "2026-07-26T00:05:00.000Z",
    cpu: { usage: 12 },
    memory: { usage_rate: 50 },
    samples: [
      {
        ts: 1753488000000,
        cpu: { usage: 10 },
        memory: { usage_rate: 48 },
        load: { load1: 0.5 },
      },
      {
        ts: 1753488060000,
        cpu: { usage: 12 },
        memory: { usage_rate: 50 },
        swap: { total: 1024, used: 10 },
        ping: { ct: { target: "www.189.cn:443", latency_ms: 12.5, loss: false } },
      },
    ],
  })
);
expectValid(
  "agent status payload without samples stays compatible",
  agentStatusSchema.safeParse({
    token: "agent-token",
    cpu: { usage: 12 },
  })
);
expectInvalid(
  "agent status payload with over MAX_REPORT_SAMPLES samples",
  agentStatusSchema.safeParse({
    token: "agent-token",
    samples: Array.from({ length: MAX_REPORT_SAMPLES + 1 }, (_, i) => ({
      ts: i + 1,
    })),
  })
);

// ---- PUT /api/agents/:id 间隔配置 ----

expectValid(
  "agent update payload with intervals",
  agentUpdateSchema.safeParse({ collect_interval: 30, report_interval: 120 })
);
expectInvalid(
  "agent update payload with collect_interval out of range",
  agentUpdateSchema.safeParse({ collect_interval: 0 })
);
expectInvalid(
  "agent update payload with report_interval out of range",
  agentUpdateSchema.safeParse({ report_interval: 3601 })
);

// ---- B4a：新指标上报字段（旧 agent 不带这些字段仍需兼容） ----

expectValid(
  "agent status payload with B4a metric fields",
  agentStatusSchema.safeParse({
    token: "agent-token",
    boot_time: 1750000000,
    process_count: 123,
    tcp_connections: 45,
    udp_connections: 6,
    ipv4_reachable: true,
    ipv6_reachable: false,
    swap: { total: 2048, used: 1024, usage_rate: 50 },
    ping: {
      ct: { target: "www.189.cn:443", latency_ms: 12.5, loss: false },
      bd: { target: "www.baidu.com:443", latency_ms: -1, loss: true },
    },
    cpu: { usage: 12 },
  })
);
expectInvalid(
  "agent status payload with malformed ping entry",
  agentStatusSchema.safeParse({
    token: "agent-token",
    ping: { ct: { latency_ms: "fast" } },
  })
);

// ---- B4a：PUT /api/agents/:id 账单与隐藏字段 ----

expectValid(
  "agent update payload with billing fields",
  agentUpdateSchema.safeParse({
    price: 9.99,
    currency: "USD",
    billing_cycle: "monthly",
    expire_date: "2026-08-01",
    auto_renewal: 1,
    is_hidden: true,
  })
);
expectValid(
  "agent update payload clearing billing fields",
  agentUpdateSchema.safeParse({
    price: null,
    billing_cycle: null,
    expire_date: null,
  })
);
expectInvalid(
  "agent update payload with invalid billing cycle",
  agentUpdateSchema.safeParse({ billing_cycle: "weekly" })
);
expectInvalid(
  "agent update payload with invalid expire date",
  agentUpdateSchema.safeParse({ expire_date: "08/01/2026" })
);
expectInvalid(
  "agent update payload with negative price",
  agentUpdateSchema.safeParse({ price: -3 })
);

// ---- C1：PUT /api/agents/:id 流量管理字段 ----

expectValid(
  "agent update payload with traffic fields",
  agentUpdateSchema.safeParse({
    traffic_limit_gb: 500,
    traffic_reset_day: 15,
    traffic_calc_type: "rx",
  })
);
expectValid(
  "agent update payload clearing traffic limit",
  agentUpdateSchema.safeParse({ traffic_limit_gb: null })
);
expectInvalid(
  "agent update payload with zero traffic limit",
  agentUpdateSchema.safeParse({ traffic_limit_gb: 0 })
);
expectInvalid(
  "agent update payload with reset day below range",
  agentUpdateSchema.safeParse({ traffic_reset_day: 0 })
);
expectInvalid(
  "agent update payload with reset day above 28",
  agentUpdateSchema.safeParse({ traffic_reset_day: 29 })
);
expectInvalid(
  "agent update payload with invalid traffic calc type",
  agentUpdateSchema.safeParse({ traffic_calc_type: "max" })
);

// ---- C1：流量纯函数（速率 / 月流量 delta 累计 / 周期起点） ----

assert.equal(
  getTrafficPeriodStart(new Date(Date.UTC(2026, 6, 26)), 15),
  "2026-07-15",
  "period start uses this month's reset day when passed"
);
for (const key of ["token", "api_key", "access_token", "secret"]) {
  assert.equal(
    parsePublicStatusSnapshot(
      JSON.stringify({
        monitors: [],
        agents: [{ id: 1, metrics: { disk_metrics: JSON.stringify([{ [key]: "value" }]) } }],
      })
    ),
    null,
    `public status validation must inspect stringified JSON for ${key}`
  );
}
assert.equal(
  getTrafficPeriodStart(new Date(Date.UTC(2026, 6, 10)), 15),
  "2026-06-15",
  "period start falls back to previous month before reset day"
);
assert.equal(
  getTrafficPeriodStart(new Date(Date.UTC(2026, 0, 1)), 28),
  "2025-12-28",
  "period start crosses year boundary"
);
assert.equal(
  normalizeTrafficResetDay(31),
  1,
  "reset day above 28 falls back to default 1"
);

assert.deepEqual(
  sumNetworkTotals([
    { interface: "eth0", bytes_recv: 100, bytes_sent: 40 },
    { interface: "lo", bytes_recv: 999999, bytes_sent: 999999 },
    { interface: "eth1", bytes_recv: 20, bytes_sent: 10 },
  ]),
  { rx: 120, tx: 50 },
  "network totals sum interfaces excluding loopback"
);
assert.equal(
  sumNetworkTotals([{ interface: "lo0", bytes_recv: 5, bytes_sent: 5 }]),
  null,
  "loopback-only network data yields no totals"
);
assert.equal(sumNetworkTotals([]), null, "empty network data yields no totals");

// 首次上报：只建立基准，不出速率、不累计
const trafficFirst = computeTraffic(
  null,
  [{ ts: 1_000_000, totals: { rx: 1000, tx: 500 } }],
  "2026-07-01"
);
assert.deepEqual(
  trafficFirst.speeds,
  [{ rx: null, tx: null }],
  "first-ever sample has no speed baseline"
);
assert.equal(trafficFirst.state.month_rx, 0, "first-ever sample adds no rx");
assert.equal(trafficFirst.state.last_total_rx, 1000, "baseline rx recorded");

// 正常递增：速率 = delta/dt，月流量按 delta 累计
const trafficGrow = computeTraffic(
  trafficFirst.state,
  [
    { ts: 1_010_000, totals: { rx: 11000, tx: 3000 } },
    { ts: 1_020_000, totals: { rx: 31000, tx: 8000 } },
  ],
  "2026-07-01"
);
assert.deepEqual(
  trafficGrow.speeds,
  [
    { rx: 1000, tx: 250 },
    { rx: 2000, tx: 500 },
  ],
  "speeds equal counter delta divided by sample interval"
);
assert.equal(trafficGrow.state.month_rx, 30000, "monthly rx accumulates deltas");
assert.equal(trafficGrow.state.month_tx, 7500, "monthly tx accumulates deltas");

// 计数器回绕（重启）：速率记 null 不出负值，月流量按 current_total 累计
const trafficReset = computeTraffic(
  trafficGrow.state,
  [{ ts: 1_030_000, totals: { rx: 400, tx: 100 } }],
  "2026-07-01"
);
assert.deepEqual(
  trafficReset.speeds,
  [{ rx: null, tx: null }],
  "counter wrap yields null speed instead of negative"
);
assert.equal(
  trafficReset.state.month_rx,
  30400,
  "counter wrap adds current total to monthly rx"
);
assert.equal(
  trafficReset.state.month_tx,
  7600,
  "counter wrap adds current total to monthly tx"
);
assert.equal(
  trafficReset.state.month_rx >= 0 && trafficReset.state.month_tx >= 0,
  true,
  "monthly counters never go negative"
);

// 跨重置日：先清零 month 再累计，基准计数器保留保证衔接
const trafficNewPeriod = computeTraffic(
  trafficReset.state,
  [{ ts: 1_040_000, totals: { rx: 900, tx: 300 } }],
  "2026-08-01"
);
assert.equal(
  trafficNewPeriod.state.month_rx,
  500,
  "period rollover clears monthly rx then accumulates delta"
);
assert.equal(trafficNewPeriod.state.month_reset_at, "2026-08-01");

// 重放样本（ts 不大于基准时间）整体跳过，不重复累计
const trafficReplay = computeTraffic(
  trafficNewPeriod.state,
  [{ ts: 1_040_000, totals: { rx: 1500, tx: 700 } }],
  "2026-08-01"
);
assert.equal(
  trafficReplay.state.month_rx,
  trafficNewPeriod.state.month_rx,
  "replayed sample does not double count monthly traffic"
);

// ---- 地图：上报来源地理位置规范化（Cloudflare cf.latitude/longitude 为字符串） ----

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
  },
  "geo strings parse, round to 4 decimals and trim city"
);
assert.deepEqual(
  normalizeAgentGeo({ latitude: "91", longitude: "139.69" }),
  { latitude: null, longitude: null, city: null, region_name: null },
  "latitude out of [-90,90] nulls the coordinate pair"
);
assert.deepEqual(
  normalizeAgentGeo({ latitude: "35.68", longitude: "-181" }),
  { latitude: null, longitude: null, city: null, region_name: null },
  "longitude out of [-180,180] nulls the coordinate pair"
);
assert.deepEqual(
  normalizeAgentGeo({ latitude: "abc", longitude: "10", city: "  " }),
  { latitude: null, longitude: null, city: null, region_name: null },
  "non-numeric latitude and blank city normalize to null"
);
assert.deepEqual(
  normalizeAgentGeo(null),
  { latitude: null, longitude: null, city: null, region_name: null },
  "missing cf geo normalizes to all-null"
);
assert.equal(
  normalizeAgentGeo({ latitude: "35.689500001", longitude: "139.6917" })
    .latitude,
  normalizeAgentGeo({ latitude: "35.68950", longitude: "139.6917" }).latitude,
  "coordinate rounding is stable so repeated reports compare equal"
);
assert.equal(normalizeAgentCountry(" jp "), "JP");
assert.equal(normalizeAgentCountry("Japan"), null);
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

// ---- 地图：公开状态页 agent 投影绝不含 geo_*（隐私分级负向断言） ----

const publicAgentSource: PublicAgentSource & Record<string, unknown> = {
  id: 1,
  name: "server-1",
  token: "secret-token",
  status: "active",
  created_at: "2026-07-26T00:00:00.000Z",
  updated_at: "2026-07-26T00:00:00.000Z",
  hostname: "server-1",
  keepalive: "60",
  ip_addresses: '["10.0.0.2"]',
  os: "linux",
  version: "1.0.0",
  last_seen_at: null,
  last_state_changed_at: null,
  next_offline_at: null,
  region: "JP",
  geo_latitude: 35.6895,
  geo_longitude: 139.6917,
  geo_city: "Tokyo",
  geo_region_name: "Tokyo",
  city: "Tokyo",
  region_name: "Tokyo",
  map_latitude: 35.6895,
  map_longitude: 139.6917,
};
const publicAgentProjection = toPublicAgent(publicAgentSource);
assert.equal(
  Object.keys(publicAgentProjection).some((key) => key.startsWith("geo_")),
  false,
  "public agent projection must not expose any geo_* field"
);
assert.equal(
  "token" in publicAgentProjection,
  false,
  "public agent projection must not expose token"
);
assert.equal(
  "ip_addresses" in publicAgentProjection,
  false,
  "public agent projection must not expose ip_addresses"
);
assert.equal(
  publicAgentProjection.region,
  "JP",
  "public agent projection keeps coarse country-level region"
);
assert.deepEqual(
  {
    city: publicAgentProjection.city,
    region_name: publicAgentProjection.region_name,
    map_latitude: publicAgentProjection.map_latitude,
    map_longitude: publicAgentProjection.map_longitude,
  },
  {
    city: "Tokyo",
    region_name: "Tokyo",
    map_latitude: 35.69,
    map_longitude: 139.69,
  },
  "public agent projection exposes a rounded city-level map point"
);

const publicRealtimeMetric = projectPublicRealtimeMetric({
  timestamp: "2026-08-11T01:00:00.000Z",
  cpu_usage: 12,
  network_rx_speed: 1024,
  network_tx_speed: 512,
  network_metrics: JSON.stringify([
    { interface: "eth0", bytes_recv: 100, bytes_sent: 50 },
  ]),
  threshold_state: { cpu: true },
  ip_addresses: ["192.0.2.1"],
});
assert.equal(publicRealtimeMetric.cpu_usage, 12);
assert.equal(publicRealtimeMetric.network_rx_speed, 1024);
assert.equal("threshold_state" in publicRealtimeMetric, false);
assert.equal("ip_addresses" in publicRealtimeMetric, false);

const publicMonitorSource: PublicMonitorSource & Record<string, unknown> = {
  id: 7,
  name: "private-api",
  url: "https://internal.example.com/health",
  method: "POST",
  interval: 60,
  timeout: 5000,
  expected_status: 204,
  headers: { Authorization: "Bearer SECRET" },
  body: '{"secret":"value"}',
  active: true,
  status: "up",
  response_time: 42,
  last_checked: "2026-07-26T00:00:00.000Z",
  created_at: "2026-07-25T00:00:00.000Z",
  updated_at: "2026-07-26T00:00:00.000Z",
};
const publicMonitorProjection = toPublicMonitor(publicMonitorSource);
assert.deepEqual(
  Object.keys(publicMonitorProjection).sort(),
  [
    "created_at",
    "id",
    "last_checked",
    "name",
    "response_time",
    "status",
    "updated_at",
  ],
  "public monitor projection must only expose the documented whitelist"
);
for (const privateField of [
  "url",
  "method",
  "headers",
  "body",
  "timeout",
  "interval",
  "expected_status",
  "active",
]) {
  assert.equal(
    privateField in publicMonitorProjection,
    false,
    `public monitor projection must not expose ${privateField}`
  );
}
assert.ok(
  parsePublicStatusSnapshot('{"monitors":[],"agents":[]}'),
  "safe public status snapshot must pass validation"
);
assert.equal(
  parsePublicStatusSnapshot(
    '{"monitors":[],"agents":[{"id":1,"metrics":{"nested":{"token":"secret"}}}]}'
  ),
  null,
  "public status validation must reject private keys at any nesting depth"
);

// ---- 探针配置下发协议 ----

assert.equal(
  md5Hex(""),
  "d41d8cd98f00b204e9800998ecf8427e",
  "md5 of empty string should match RFC 1321 vector"
);
assert.equal(
  md5Hex("abc"),
  "900150983cd24fb0d6963f7d28e17f72",
  "md5 of 'abc' should match RFC 1321 vector"
);
assert.equal(
  md5Hex("The quick brown fox jumps over the lazy dog"),
  "9e107d9d372bb6826bd81d3542a419d6",
  "md5 long vector should match"
);

assert.equal(
  serializeAgentConfig({ collect_interval: 60, report_interval: 300 }),
  "collect_interval=60&report_interval=300&schema_version=2",
  "agent config canonical string must keep fixed key order"
);
assert.deepEqual(
  normalizeAgentIntervals({ collect_interval: null, report_interval: null }),
  { collect_interval: 60, report_interval: 60 },
  "missing intervals fall back to defaults"
);
assert.deepEqual(
  normalizeAgentIntervals({ collect_interval: 5000, report_interval: 5 }),
  { collect_interval: 60, report_interval: 60 },
  "out-of-range intervals fall back to defaults"
);
assert.deepEqual(
  normalizeAgentIntervals({ collect_interval: 600, report_interval: 60 }),
  { collect_interval: 600, report_interval: 600 },
  "report interval is raised to collect interval when smaller"
);

const descriptor = describeAgentConfig({
  collect_interval: 60,
  report_interval: 300,
});
assert.equal(
  descriptor.serialized,
  "collect_interval=60&report_interval=300&schema_version=2",
  "descriptor serialization matches canonical form"
);
assert.equal(
  descriptor.md5,
  md5Hex(descriptor.serialized),
  "descriptor md5 derives from canonical string"
);

// ---- C3：配置协议 v3（schema 回填 + update 指令 + 语义化版本比较） ----

assert.equal(
  serializeAgentConfig({ collect_interval: 60, report_interval: 300 }, 3),
  "collect_interval=60&report_interval=300&schema_version=3",
  "v3 canonical string echoes client-declared schema version"
);
assert.equal(
  describeAgentConfig({ collect_interval: 60, report_interval: 300 }, 3).md5,
  md5Hex("collect_interval=60&report_interval=300&schema_version=3"),
  "v3 descriptor md5 covers canonical three keys only (update excluded)"
);
assert.equal(normalizeAgentConfigSchema("2"), 2, "schema header 2 accepted");
assert.equal(normalizeAgentConfigSchema("3"), 3, "schema header 3 accepted");
assert.equal(normalizeAgentConfigSchema("1"), null, "schema header 1 rejected");
assert.equal(normalizeAgentConfigSchema("4"), null, "schema header 4 rejected");
assert.equal(
  normalizeAgentConfigSchema(undefined),
  null,
  "missing schema header rejected"
);

assert.equal(compareSemver("1.0.0", "1.2.0"), -1, "semver compare lower");
assert.equal(compareSemver("v1.2.0", "1.2.0"), 0, "semver compare v prefix");
assert.equal(compareSemver("1.10.0", "1.9.9"), 1, "semver compare numeric segments");
assert.equal(
  compareSemver("1.0.0-rc1", "1.0.0"),
  -1,
  "prerelease sorts before release"
);
assert.equal(compareSemver("abc", "1.0.0"), null, "unparsable semver yields null");

assert.equal(
  shouldTriggerAgentUpdate(true, "1.2.0", "1.0.0"),
  true,
  "update triggers when auto_update on and agent version lower"
);
assert.equal(
  shouldTriggerAgentUpdate(false, "1.2.0", "1.0.0"),
  false,
  "update requires auto_update on"
);
assert.equal(
  shouldTriggerAgentUpdate(true, "", "1.0.0"),
  false,
  "update requires non-empty LATEST_AGENT_VERSION"
);
assert.equal(
  shouldTriggerAgentUpdate(true, "1.2.0", "1.2.0"),
  false,
  "equal versions do not trigger update"
);
assert.equal(
  shouldTriggerAgentUpdate(true, "1.2.0", undefined),
  false,
  "missing agent version header does not trigger update"
);

// ---- C3：PUT /api/agents/:id 自动升级 / 分组 / 标签 ----

expectValid(
  "agent update payload with auto update and grouping",
  agentUpdateSchema.safeParse({
    auto_update: 1,
    group_name: "香港节点",
    tags: "web,prod,hk",
  })
);
expectValid(
  "agent update payload clearing group and tags",
  agentUpdateSchema.safeParse({ group_name: null, tags: null })
);
expectInvalid(
  "agent update payload with invalid auto_update",
  agentUpdateSchema.safeParse({ auto_update: 2 })
);

// ---- C3：手动排序 ----

expectValid("order payload", orderUpdateSchema.safeParse({ ids: [3, 1, 2] }));
expectInvalid(
  "order payload with empty ids",
  orderUpdateSchema.safeParse({ ids: [] })
);
expectInvalid(
  "order payload with non-positive id",
  orderUpdateSchema.safeParse({ ids: [1, 0] })
);

// ---- C3：导入导出 ----

expectValid(
  "agent import payload",
  agentImportSchema.safeParse([
    {
      name: "server-1",
      token: "agent-token",
      collect_interval: 30,
      report_interval: 120,
      group_name: "hk",
      tags: "web,prod",
      auto_update: 1,
      sort_order: 2,
    },
    { name: "server-2" },
  ])
);
expectInvalid(
  "agent import payload without name",
  agentImportSchema.safeParse([{ token: "agent-token" }])
);
expectInvalid(
  "agent import payload not an array",
  agentImportSchema.safeParse({ name: "server-1" })
);

expectValid(
  "monitor import payload",
  monitorImportSchema.safeParse([
    {
      name: "API",
      url: "https://example.com/health",
      method: "GET",
      interval: 60,
      timeout: 5000,
      expected_status: 200,
      headers: {},
      active: true,
      sort_order: 1,
    },
  ])
);
expectInvalid(
  "monitor import payload with invalid url",
  monitorImportSchema.safeParse([
    {
      name: "API",
      url: "not-a-url",
      method: "GET",
      interval: 60,
      timeout: 5000,
      expected_status: 200,
    },
  ])
);
expectInvalid(
  "monitor payload with oversized body",
  monitorSchema.safeParse({
    name: "API",
    url: "https://example.com/health",
    method: "GET",
    interval: 60,
    timeout: 5000,
    expected_status: 200,
    body: "x".repeat(1024 * 1024 + 1),
  })
);
expectInvalid(
  "legacy agent payload with oversized ping map",
  agentStatusSchema.safeParse({
    token: "agent-token",
    ping: Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`target_${index}`, { latency_ms: 1 }])
    ),
  })
);

expectValid(
  "status page payload",
  statusPageConfigSchema.safeParse({
    title: "Status",
    description: "Service status",
    logoUrl: "",
    customCss: "",
    monitors: [1],
    agents: [1],
  })
);
expectInvalid(
  "status page payload with invalid monitor id",
  statusPageConfigSchema.safeParse({
    title: "Status",
    description: "Service status",
    monitors: [0],
    agents: [],
  })
);
expectInvalid(
  "status page payload with duplicate monitor id",
  statusPageConfigSchema.safeParse({
    title: "Status",
    description: "Service status",
    monitors: [1, 1],
    agents: [],
  })
);

expectValid(
  "notification settings payload",
  notificationSettingsSchema.safeParse({
    target_type: "global-agent",
    enabled: true,
    channels: [1],
    cooldown_minutes: 30,
  })
);
expectInvalid(
  "notification settings payload with invalid cooldown",
  notificationSettingsSchema.safeParse({
    target_type: "global-agent",
    enabled: true,
    channels: [1],
    cooldown_minutes: 1441,
  })
);

const defaultHistoryQuery = notificationHistoryQuerySchema.parse({});
assert.deepEqual(
  defaultHistoryQuery,
  { limit: DEFAULT_PAGE_SIZE, page: 1 },
  "notification history query should have bounded defaults"
);
expectValid(
  "notification history query at maximum page size",
  notificationHistoryQuerySchema.safeParse({
    type: "monitor",
    target_id: "1",
    status: "success",
    limit: String(MAX_PAGE_SIZE),
    page: "100000",
  })
);
expectInvalid(
  "notification history query above maximum page size",
  notificationHistoryQuerySchema.safeParse({
    limit: String(MAX_PAGE_SIZE + 1),
  })
);
expectInvalid(
  "notification history query with zero page",
  notificationHistoryQuerySchema.safeParse({ page: "0" })
);
assert.equal(
  normalizePageSize(Number.MAX_SAFE_INTEGER),
  MAX_PAGE_SIZE,
  "repository page-size guard should clamp oversized direct calls"
);
assert.equal(
  normalizePageOffset(Number.MAX_SAFE_INTEGER),
  MAX_PAGE_OFFSET,
  "repository offset guard should clamp oversized direct calls"
);

const bootstrapMigrationSource = readFileSync(
  new URL("../drizzle/0023_runtime_bootstrap_defaults.sql", import.meta.url),
  "utf8"
);
assert.equal(
  bootstrapMigrationSource.includes("botToken"),
  false,
  "bootstrap data migration must not contain third-party credential fields"
);

// ---- B4b：新增通知渠道 config 校验 ----

expectValid(
  "dingtalk channel config with secret",
  validateNotificationChannelConfig("dingtalk", {
    webhook_url: "https://oapi.dingtalk.com/robot/send?access_token=abc",
    secret: "SEC0123456789",
  })
);
expectInvalid(
  "dingtalk channel config without webhook_url",
  validateNotificationChannelConfig("dingtalk", { secret: "SEC0123456789" })
);

expectValid(
  "bark channel config with defaults",
  validateNotificationChannelConfig("bark", {
    server_url: "",
    device_key: "abcDEF123",
    sound: "alarm",
    group: "xugou",
  })
);
expectInvalid(
  "bark channel config without device_key",
  validateNotificationChannelConfig("bark", {
    server_url: "https://api.day.app",
    device_key: "",
  })
);

expectValid(
  "serverchan channel config",
  validateNotificationChannelConfig("serverchan", { send_key: "SCT123abc" })
);
expectInvalid(
  "serverchan channel config without send_key",
  validateNotificationChannelConfig("serverchan", { send_key: "" })
);

expectValid(
  "wxpusher channel config with uids",
  validateNotificationChannelConfig("wxpusher", {
    app_token: "AT_abc123",
    uids: "UID_a,UID_b",
  })
);
expectInvalid(
  "wxpusher channel config without uids or topic_ids",
  validateNotificationChannelConfig("wxpusher", { app_token: "AT_abc123" })
);

expectValid(
  "gotify channel config with priority",
  validateNotificationChannelConfig("gotify", {
    server_url: "https://gotify.example.com",
    app_token: "Axxx",
    priority: 8,
  })
);
expectInvalid(
  "gotify channel config with invalid server_url",
  validateNotificationChannelConfig("gotify", {
    server_url: "not-a-url",
    app_token: "Axxx",
  })
);

// ---- C3：OneBot（QQ）渠道 config 校验 ----

expectValid(
  "onebot channel config for private message",
  validateNotificationChannelConfig("onebot", {
    api_url: "http://127.0.0.1:3000",
    access_token: "secret-token",
    message_type: "private",
    target_id: "10001",
  })
);
expectValid(
  "onebot channel config for group message without token",
  validateNotificationChannelConfig("onebot", {
    api_url: "https://onebot.example.com",
    access_token: "",
    message_type: "group",
    target_id: "987654321",
  })
);
expectInvalid(
  "onebot channel config with invalid api_url",
  validateNotificationChannelConfig("onebot", {
    api_url: "not-a-url",
    message_type: "private",
    target_id: "10001",
  })
);
expectInvalid(
  "onebot channel config with non-numeric target_id",
  validateNotificationChannelConfig("onebot", {
    api_url: "http://127.0.0.1:3000",
    message_type: "private",
    target_id: "abc",
  })
);
expectInvalid(
  "onebot channel config with invalid message_type",
  validateNotificationChannelConfig("onebot", {
    api_url: "http://127.0.0.1:3000",
    message_type: "channel",
    target_id: "10001",
  })
);

assert.deepEqual(
  dedupeResourceIds([1, 1, 2, 0, -1, 3.5, 2]),
  [1, 2],
  "status page resource IDs should be unique positive integers"
);
assert.deepEqual(
  getMissingResourceIds([1, 2, 3], [1, 3]),
  [2],
  "status page validation should identify inaccessible resources"
);

// ---- 历史指标分区主键工具 ----

assert.equal(
  formatHistoryTimeKey(Date.UTC(2026, 6, 26, 12, 34, 56)),
  260726123456,
  "history time key should be YYMMDDHHmmss in UTC"
);
assert.equal(
  buildHistoryId(3, Date.UTC(2026, 0, 2, 3, 4, 5)),
  3 * HISTORY_PARTITION_MULTIPLIER + 260102030405,
  "history id should be partitionId * 10^13 + time key"
);
assert.deepEqual(
  getHistoryIdRange(2, Date.UTC(2026, 6, 25), Date.UTC(2026, 6, 26)),
  {
    startId: 2 * HISTORY_PARTITION_MULTIPLIER + 260725000000,
    endId: 2 * HISTORY_PARTITION_MULTIPLIER + 260726000000,
  },
  "history id range should map time window onto partition prefix"
);
assert.equal(
  normalizeHistoryPartitionId(0),
  null,
  "partition id 0 should be invalid"
);
assert.equal(
  normalizeHistoryPartitionId(901),
  null,
  "partition id above 900 should be invalid"
);
assert.equal(
  normalizeHistoryPartitionId("5"),
  5,
  "numeric string partition id should normalize"
);

// ---- hours 白名单 ----

assert.equal(normalizeAgentMetricsHours(undefined), 24, "hours defaults to 24");
assert.equal(normalizeAgentMetricsHours("168"), 168, "hours 168 is allowed");
assert.equal(normalizeAgentMetricsHours("2"), null, "hours 2 is rejected");
assert.equal(normalizeAgentMetricsHours("abc"), null, "non-numeric hours rejected");
